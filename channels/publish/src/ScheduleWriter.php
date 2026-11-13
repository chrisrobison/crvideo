<?php
declare(strict_types=1);

// channels/publish/src/ScheduleWriter.php
//
// Compiles ProgrammingCompiler's flat, absolute-timestamped item list into
// the existing schedule.json shape (schema_version/channel/blocks/items, with
// a gap item for every uncovered interval, as in ia-import's output) and
// writes it, then updates the channel's meta.json "anchor" to the window's
// start instant. broadcast.js reads it unchanged: it is one ordinary block
// whose duration is the real elapsed seconds of the published window (which
// can differ slightly from `days * 86400` across a DST transition, correctly)
// anchored at the window's start.
//
// Consequence of this design: once real time passes the window's end,
// buildTimeline's modulo cycle wrapping repeats the window from its start,
// so the channel keeps airing the last published window on a loop until
// publish.php is run again. See channels/publish.php --help for the
// republish/rollover workflow.
//
// Writes are atomic (temp file + rename) with a single-generation ".bak"
// backup, like youtube-import/src/YouTubeSeriesWriter.php and
// server/publish-playlist.php.

final class ScheduleWriter
{
    /**
     * @param list<array{start:int,end:int,id:string,title:string,source:?array,source_url:?string}> $items
     *        already sorted ascending by start, already validated non-overlapping.
     * @param list<array{block_id:string,series_id:string,version:int,episode_count:int}> $episodeSets
     * @param list<array{occurrence_id:string,block_id:string,title:?string,description:?string,series_id:?string,series_title:?string,boundary_mode:string,nominal_start:int,nominal_end:int,start:int,end:int}> $programs
     *        BoundaryResolver's resolved program-occurrence collection (see
     *        docs/guide-update.md). [] for a channel with no programming.json-sourced
     *        occurrences; schedule.json then carries no "programs" key at all.
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

        // Computed up front (relative seconds, like every item below) so gap
        // insertion can attribute an unfilled portion of a block (e.g. packing's
        // minimum_remaining left a remainder and the channel has no continuity.json,
        // so ContinuityFiller never sees it) to its own enclosing program, as a
        // continuity filler already is. Otherwise that time would be a second,
        // unattributed "gap" item inside a program's effective window, which the
        // program's EPG cell already spans, and the guide's two timeline entries
        // would overlap. A gap outside every program's window (a genuine
        // inter-program station break) is left untagged.
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
        // Splits [relStart,relEnd) into segments, each fully inside one program's
        // effective window (tagged with its occurrence_id) or fully outside every
        // one (untagged). Usually a gap is entirely one or the other, but this stays
        // correct when a raw gap straddles a program's end and further unscheduled
        // time beyond it (e.g. the last program in a window): the in-program portion
        // is attributed and only the remainder is left as an unattributed station
        // break.
        $splitGapByPrograms = static function (int $relStart, int $relEnd) use ($relPrograms): array {
            $segments = [];
            $cursor = $relStart;
            while ($cursor < $relEnd) {
                $owner = null;
                foreach ($relPrograms as $p) {
                    if ($cursor >= $p['start'] && $cursor < $p['end']) {
                        $owner = $p;
                        break; // programs never overlap -- at most one can ever match
                    }
                }
                if ($owner !== null) {
                    $segEnd = min($relEnd, $owner['end']);
                } else {
                    // Unowned time: stop at the next program's own start. See
                    // ContinuityFiller::splitByProgramBoundaries()'s identical fix:
                    // a program's first real item can start a few seconds after its
                    // effective window does (ProgrammingCompiler's $minimumLeadInSeconds).
                    $nextStart = $relEnd;
                    foreach ($relPrograms as $p) {
                        if ($p['start'] > $cursor && $p['start'] < $nextStart) {
                            $nextStart = $p['start'];
                        }
                    }
                    $segEnd = $nextStart;
                }
                $segments[] = [$cursor, $segEnd, $owner['occurrence_id'] ?? null];
                $cursor = $segEnd;
            }
            return $segments;
        };

        $relItems = [];
        $cursor = 0;
        $used = 0;
        foreach ($items as $it) {
            $relStart = $it['start'] - $windowStartTs;
            $relEnd = $it['end'] - $windowStartTs;
            if ($relStart > $cursor) {
                foreach ($splitGapByPrograms($cursor, $relStart) as [$segStart, $segEnd, $segProgramId]) {
                    $relItems[] = [
                        'type' => 'gap',
                        'start' => $segStart,
                        'duration' => $segEnd - $segStart,
                        ...($segProgramId !== null ? ['program_id' => $segProgramId] : []),
                    ];
                }
            }

            if (($it['kind'] ?? 'video') === 'continuity') {
                // A dynamically rendered continuity card: no media asset. The compiler
                // decided its template, exact duration and the program that follows; the
                // player only computes a countdown from this and the broadcast clock (see
                // docs/series-and-channels.md).
                $relItems[] = [
                    'type' => 'continuity',
                    'id' => $it['id'],
                    'start' => $relStart,
                    'duration' => $relEnd - $relStart,
                    'template' => $it['template'],
                    'next_program_id' => $it['next_program_id'] ?? null,
                    // Present only when this card sits inside a programming block's
                    // effective window (e.g. covering its under-filled remainder); absent
                    // for a genuine inter-program station break.
                    ...(isset($it['program_id']) ? ['program_id' => $it['program_id']] : []),
                ];
                $used += $relEnd - $relStart;
                $cursor = $relEnd;
                continue;
            }

            $source = $it['source'];
            $provider = is_array($source) && is_string($source['provider'] ?? null) ? $source['provider'] : null;
            // A directly-hosted (non-YouTube) episode's source.url is a playable media
            // file. YouTube's is a watch-page link, so it never populates media_url; the
            // player picks the YouTube adapter from the structured provider, not the URL.
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
            // boundary.mode soft/elastic: a delay is never silently absorbed.
            // BoundaryResolver records how many seconds this occurrence was pushed past
            // its nominal start, and it's carried onto the published item so the
            // schedule is self-documenting (no re-derivation needed by readers).
            if (isset($it['delay_seconds']) && $it['delay_seconds'] > 0) {
                $relItem['delay_seconds'] = $it['delay_seconds'];
            }
            if (isset($it['continuity_category'])) {
                // Marks a ContinuityFiller-sourced station-id/filler item (vs. a scheduled
                // episode). Informational only; playback is identical.
                $relItem['continuity_category'] = $it['continuity_category'];
            }
            if (isset($it['program_id'])) {
                // Compact reference into this schedule's top-level "programs" collection
                // (below), preserving the episode's logical programming-block identity.
                // Absent for items with no known program (e.g. a genuine station break).
                $relItem['program_id'] = $it['program_id'];
            }
            $relItems[] = $relItem;
            $used += $relEnd - $relStart;
            $cursor = $relEnd;
        }
        if ($cursor < $windowSeconds) {
            foreach ($splitGapByPrograms($cursor, $windowSeconds) as [$segStart, $segEnd, $segProgramId]) {
                $relItems[] = [
                    'type' => 'gap',
                    'start' => $segStart,
                    'duration' => $segEnd - $segStart,
                    ...($segProgramId !== null ? ['program_id' => $segProgramId] : []),
                ];
            }
        }

        // One entry per logical programming occurrence (the $relPrograms above), in
        // the same window-relative seconds as item starts: the source of truth for the
        // program-level EPG projection. A channel with no programming.json (e.g. Film
        // Day at School) or without block title/description metadata produces [], and
        // "programs" is omitted from the written file.

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

    /** Updates only meta.json's "anchor" field (to the window's start, as an
     *  ISO-8601 instant); every other field (name, description, number, logo,
     *  hidden...) is read back and preserved. */
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
        if (is_file($path)) {
            // Replace (don't overwrite) a stale .bak: it may be owned by the other user (web server vs CLI)
            // and not writable, but removing/creating it only needs the directory's group write bit.
            @unlink($path . '.bak');
            if (!copy($path, $path . '.bak')) {
                throw new RuntimeException("Failed to back up existing file before overwriting: $path.bak");
            }
            @chmod($path . '.bak', 0664);
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
        @chmod($path, 0664); // group-writable: the web server (www-data) and the CLI user share these files
    }
}
