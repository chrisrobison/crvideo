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
     */
    public static function writeSchedule(
        string $path,
        string $channelName,
        array $items,
        DateTimeImmutable $windowStart,
        DateTimeImmutable $windowEnd,
        array $episodeSets,
    ): array {
        $windowStartTs = $windowStart->getTimestamp();
        $windowSeconds = $windowEnd->getTimestamp() - $windowStartTs;
        if ($windowSeconds <= 0) {
            throw new RuntimeException('Publish window end must be after its start.');
        }

        $relItems = [];
        $cursor = 0;
        $used = 0;
        foreach ($items as $it) {
            $relStart = $it['start'] - $windowStartTs;
            $relEnd = $it['end'] - $windowStartTs;
            if ($relStart > $cursor) {
                $relItems[] = ['type' => 'gap', 'start' => $cursor, 'duration' => $relStart - $cursor];
            }
            $source = $it['source'];
            $provider = is_array($source) && is_string($source['provider'] ?? null) ? $source['provider'] : null;
            // A directly-hosted (non-YouTube) episode's source.url IS a playable
            // media file; YouTube's source.url is a watch-page link, never a
            // media file, so it never populates media_url -- the player's
            // structured provider resolution (not URL sniffing) is what
            // actually picks the YouTube adapter for it regardless.
            $mediaUrl = ($provider !== null && $provider !== 'youtube' && is_string($source['url'] ?? null)) ? $source['url'] : null;

            $relItems[] = [
                'type' => 'video',
                'id' => $it['id'],
                'start' => $relStart,
                'duration' => $relEnd - $relStart,
                'title' => $it['title'],
                'media_url' => $mediaUrl,
                'source_url' => $it['source_url'],
                'source' => $source,
            ];
            $used += $relEnd - $relStart;
            $cursor = $relEnd;
        }
        if ($cursor < $windowSeconds) {
            $relItems[] = ['type' => 'gap', 'start' => $cursor, 'duration' => $windowSeconds - $cursor];
        }

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
