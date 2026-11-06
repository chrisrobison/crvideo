<?php
declare(strict_types=1);

// channels/publish/src/ScheduleWriter.php
//
// Compiles ProgrammingCompiler's flat, absolute-timestamped item list into
// the EXISTING schedule.json shape (schema_version/channel/blocks/items,
// gaps filling every uncovered interval -- the same "gap is the only way
// empty time is represented" rule ia-import's own output already follows)
// and writes it, plus updates the channel's meta.json "anchor" to the
// window's start instant. The existing player (broadcast.js) needs no
// changes at all to read this: it is just one "normal" block whose
// duration is the real elapsed seconds of the published window (which
// may differ slightly from `days * 86400` across a DST transition --
// that's correct; it's the real wall-clock-to-wall-clock elapsed time,
// not an approximation) anchored at the window's own start.
//
// Deliberate consequence of this design (documented, not a bug): once
// real time passes the published window's end, buildTimeline's existing
// modulo-based cycle wrapping takes over and the window simply repeats
// from its own start -- the channel does not go dark or crash, it just
// keeps airing the last published window on a loop until publish.php is
// run again to produce a fresh forward window. See channels/publish.php
// --help for the republish/rollover workflow.
//
// Writes are atomic (temp file + rename) with a single-generation ".bak"
// backup, the same convention as youtube-import/src/YouTubeSeriesWriter.php
// and server/publish-playlist.php.

final class ScheduleWriter
{
    /**
     * @param list<array{start:int,end:int,id:string,title:string,source:?array,source_url:?string}> $items
     *        already sorted ascending by start, already validated non-overlapping.
     * @param list<array{block_id:string,series_id:string,version:int,episode_count:int}> $episodeSets
     * @param list<array{occurrence_id:string,block_id:string,title:?string,description:?string,series_id:?string,series_title:?string,boundary_mode:string,nominal_start:int,nominal_end:int,start:int,end:int}> $programs
     *        BoundaryResolver's resolved program-occurrence collection (Phase 3/4 of
     *        docs/guide-update.md). [] (the default) for a channel with no
     *        programming.json-sourced occurrences -- schedule.json then carries no
     *        "programs" key at all, identical to every schedule written before this
     *        feature existed.
     */
    public static function writeSchedule(
        string $path,
        string $channelName,
        array $items,
        DateTimeImmutable $windowStart,
        DateTimeImmutable $windowEnd,
        array $episodeSets,
        array $programs = [],
    ): array {
        $windowStartTs = $windowStart->getTimestamp();
        $windowSeconds = $windowEnd->getTimestamp() - $windowStartTs;
        if ($windowSeconds <= 0) {
            throw new RuntimeException('Publish window end must be after its start.');
        }

        // Phase 3/4/7 of docs/guide-update.md: computed up front (relative seconds,
        // same convention as every item below) so the gap-insertion below can
        // attribute a genuinely unfilled portion of a block (e.g. packing's
        // minimum_remaining left a remainder, and this channel has no
        // continuity.json to cover it -- ContinuityFiller never even sees it, since
        // it only runs when continuity assets/cards exist) to its OWN enclosing
        // program, the same way an actual continuity filler already is. Without
        // this, that leftover time would be written as a second, unattributed
        // "gap" item sitting INSIDE a program occurrence's effective window --
        // which the program's own EPG cell already spans end to end -- and the
        // guide's two timeline entries would overlap. A gap that falls outside
        // every program's window (a genuine inter-program station break) is
        // deliberately left untagged.
        $relPrograms = [];
        foreach ($programs as $p) {
            $relPrograms[] = [
                'occurrence_id' => $p['occurrence_id'],
                'block_id' => $p['block_id'],
                'title' => $p['title'],
                'description' => $p['description'],
                'series_id' => $p['series_id'],
                'series_title' => $p['series_title'],
                'boundary_mode' => $p['boundary_mode'],
                'nominal_start' => $p['nominal_start'] - $windowStartTs,
                'nominal_end' => $p['nominal_end'] - $windowStartTs,
                'start' => $p['start'] - $windowStartTs,
                'end' => $p['end'] - $windowStartTs,
            ];
        }
        $enclosingProgramId = static function (int $relStart, int $relEnd) use ($relPrograms): ?string {
            foreach ($relPrograms as $p) {
                if ($relStart >= $p['start'] && $relEnd <= $p['end']) {
                    return $p['occurrence_id'];
                }
            }
            return null;
        };

        $relItems = [];
        $cursor = 0;
        $used = 0;
        foreach ($items as $it) {
            $relStart = $it['start'] - $windowStartTs;
            $relEnd = $it['end'] - $windowStartTs;
            if ($relStart > $cursor) {
                $gapProgramId = $enclosingProgramId($cursor, $relStart);
                $relItems[] = [
                    'type' => 'gap',
                    'start' => $cursor,
                    'duration' => $relStart - $cursor,
                    ...($gapProgramId !== null ? ['program_id' => $gapProgramId] : []),
                ];
            }

            if (($it['kind'] ?? 'video') === 'continuity') {
                // Phase 4/5: a dynamically-rendered continuity card -- no media asset at
                // all. The compiler already decided its template, exact duration, and
                // which program follows; the player only ever computes a countdown
                // display from this and the broadcast clock (see docs/series-and-
                // channels.md), never anything about WHAT plays or for how long.
                $relItems[] = [
                    'type' => 'continuity',
                    'id' => $it['id'],
                    'start' => $relStart,
                    'duration' => $relEnd - $relStart,
                    'template' => $it['template'],
                    'next_program_id' => $it['next_program_id'] ?? null,
                    // Phase 3/7: present only when this continuity card sits inside a
                    // programming block's own effective window (e.g. covering its
                    // under-filled remainder) -- absent for a genuine inter-program
                    // station break, same distinction Phase 7 requires everywhere else.
                    ...(isset($it['program_id']) ? ['program_id' => $it['program_id']] : []),
                ];
                $used += $relEnd - $relStart;
                $cursor = $relEnd;
                continue;
            }

            $source = $it['source'];
            $provider = is_array($source) && is_string($source['provider'] ?? null) ? $source['provider'] : null;
            // A directly-hosted (non-YouTube) episode's source.url IS a playable
            // media file; YouTube's source.url is a watch-page link, never a
            // media file, so it never populates media_url -- the player's
            // structured provider resolution (not URL sniffing) is what
            // actually picks the YouTube adapter for it regardless.
            $mediaUrl = ($provider !== null && $provider !== 'youtube' && is_string($source['url'] ?? null)) ? $source['url'] : null;

            $relItem = [
                'type' => 'video',
                'id' => $it['id'],
                'start' => $relStart,
                'duration' => $relEnd - $relStart,
                'title' => $it['title'],
                'media_url' => $mediaUrl,
                'source_url' => $it['source_url'],
                'source' => $source,
            ];
            // Phase 3 (boundary.mode soft/elastic): a delay is never silently
            // absorbed -- BoundaryResolver records exactly how many seconds this
            // occurrence was pushed past its nominal start, carried straight
            // through onto the published item so the schedule stays self-
            // documenting (the admin preview and any future continuity/"coming up
            // next" renderer can read it directly, no re-derivation needed).
            if (isset($it['delay_seconds']) && $it['delay_seconds'] > 0) {
                $relItem['delay_seconds'] = $it['delay_seconds'];
            }
            if (isset($it['continuity_category'])) {
                // Marks a ContinuityFiller-sourced station-id/filler occurrence as such
                // (vs. an actual scheduled episode) -- purely informational; playback is
                // identical either way, an ordinary direct-media "video" item.
                $relItem['continuity_category'] = $it['continuity_category'];
            }
            if (isset($it['program_id'])) {
                // Phase 3: the compact reference back into this schedule's top-level
                // "programs" collection (see below) -- the smallest backward-compatible
                // way to preserve this episode's logical programming-block identity.
                // Absent for any item with no known program (legacy schedules, or a
                // genuine station break between programs).
                $relItem['program_id'] = $it['program_id'];
            }
            $relItems[] = $relItem;
            $used += $relEnd - $relStart;
            $cursor = $relEnd;
        }
        if ($cursor < $windowSeconds) {
            $trailingProgramId = $enclosingProgramId($cursor, $windowSeconds);
            $relItems[] = [
                'type' => 'gap',
                'start' => $cursor,
                'duration' => $windowSeconds - $cursor,
                ...($trailingProgramId !== null ? ['program_id' => $trailingProgramId] : []),
            ];
        }

        // Phase 3/4 of docs/guide-update.md: one entry per logical programming
        // occurrence (the $relPrograms computed above), in the same window-
        // relative seconds as every item's own start/duration -- the program-level
        // EPG projection's source of truth. A legacy channel (no programming.json,
        // e.g. Film Day at School) or one not yet opted into block title/
        // description metadata produces [] here, so "programs" is simply omitted
        // from the written file -- identical to every schedule.json written before
        // this feature existed.

        $schedule = [
            '_publish' => [
                'generated_at' => gmdate('c'),
                'window' => ['start' => $windowStart->format('c'), 'end' => $windowEnd->format('c')],
                'episode_sets' => $episodeSets,
            ],
            'schema_version' => 1,
            'channel' => $channelName,
            'blocks' => [[
                'block' => 1,
                'type' => 'normal',
                'duration' => $windowSeconds,
                'used' => $used,
                'remaining' => $windowSeconds - $used,
                'relative_start' => 0,
                'items' => $relItems,
            ]],
            ...($relPrograms ? ['programs' => $relPrograms] : []),
        ];

        self::atomicWriteJson($path, $schedule);
        return $schedule;
    }

    /** Updates only meta.json's "anchor" field (to the window's start, as
     *  an ISO-8601 instant) -- every other field an operator or an
     *  earlier phase wrote (name, description, number, logo, hidden...)
     *  is read back and preserved untouched. */
    public static function updateAnchor(string $metaPath, DateTimeImmutable $windowStart): void
    {
        $meta = is_file($metaPath) ? json_decode((string) file_get_contents($metaPath), true) : null;
        if (!is_array($meta)) {
            throw new RuntimeException("Cannot update anchor: $metaPath is missing or not valid JSON.");
        }
        $meta['anchor'] = $windowStart->format('c');
        self::atomicWriteJson($metaPath, $meta);
    }

    private static function atomicWriteJson(string $path, array $data): void
    {
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException("Failed to create directory: $dir");
        }
        if (is_file($path) && !copy($path, $path . '.bak')) {
            throw new RuntimeException("Failed to back up existing file before overwriting: $path.bak");
        }
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json === false) {
            throw new RuntimeException("Failed to encode JSON for: $path");
        }
        static $counter = 0;
        $tmp = $path . '.' . getmypid() . '.' . (++$counter) . '.tmp';
        if (file_put_contents($tmp, $json . "\n") === false) {
            throw new RuntimeException("Failed to write temp file: $tmp");
        }
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException("Failed to finalize write for: $path");
        }
    }
}
