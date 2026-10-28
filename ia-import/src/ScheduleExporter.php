<?php
declare(strict_types=1);

// ia-import/src/ScheduleExporter.php
//
// Builds the two output JSON documents (catalog.json, schedule.json) from
// the catalog items and optimizer/filler output, and writes them to disk.
// Also ships the documented helper for turning a block's relative offsets
// into an absolute UTC start time, for whenever this gets wired into a
// real channel scheduler -- the CLI itself has no flag for this, by design
// (see README), but the data model (block number + slot_duration + item
// start-within-block) is all that's needed to compute it.

final class ScheduleExporter
{
    /**
     * @param list<array<string,mixed>> $catalogItems
     */
    public static function buildCatalog(array $catalogItems, string $listName, string $description): array
    {
        $items = [];
        foreach ($catalogItems as $item) {
            $items[] = [
                'id' => $item['id'],
                'identifier' => $item['identifier'],
                'member_id' => $item['member_id'],
                'original_position' => $item['list_position'],
                'part_index' => $item['part_index'],
                'part_count' => $item['part_count'],
                'title' => $item['title'],
                'duration' => $item['duration'],
                'duration_source' => $item['duration_source'],
                'year' => $item['year'],
                'creator' => $item['creator'],
                'description' => $item['description'],
                'subjects' => $item['subjects'],
                'collections' => $item['collections'],
                'source_url' => $item['source_url'],
                'media_url' => $item['media_url'],
                'thumbnail_url' => $item['thumbnail_url'],
                'selected_file' => $item['selected_file'],
                'format' => $item['format'],
                'license' => $item['license'],
                'status' => $item['status'],
                'warnings' => $item['warnings'],
            ];
        }

        return [
            'schema_version' => 1,
            'source' => 'internet_archive',
            'list_name' => $listName,
            'description' => $description,
            'generated_at' => gmdate('c'),
            'items' => $items,
        ];
    }

    /**
     * @param list<array<string,mixed>> $blocks Optimizer output blocks, optionally post-processed by FillerSelector.
     * @param array<string, array<string,mixed>> $catalogById id => catalog item, for resolving playback URLs.
     */
    public static function buildSchedule(array $blocks, string $channel, int $slotSeconds, string $strategy, array $catalogById): array
    {
        $outBlocks = [];
        foreach ($blocks as $block) {
            $outItems = [];
            foreach ($block['items'] as $item) {
                $entry = [
                    'type' => $item['type'],
                    'start' => round((float) $item['start'], 3),
                    'duration' => round((float) $item['duration'], 3),
                ];
                if ($item['type'] !== 'gap') {
                    $entry = ['type' => $entry['type'], 'id' => $item['id']] + $entry;
                    $cat = $catalogById[$item['id']] ?? null;
                    if ($cat !== null) {
                        $entry['title'] = $cat['title'];
                        $entry['media_url'] = $cat['media_url'];
                        $entry['source_url'] = $cat['source_url'];
                    }
                }
                $outItems[] = $entry;
            }
            $outBlocks[] = [
                'block' => $block['block'],
                'type' => $block['type'],
                'duration' => round((float) $block['duration'], 3),
                'used' => round((float) $block['used'], 3),
                'remaining' => round((float) $block['remaining'], 3),
                // Documented extension point: block N's relative start, in
                // seconds, within an eventual full-day/full-cycle schedule.
                // See ScheduleExporter::absoluteBlockStart() for turning
                // this into a real timestamp once a cycle start time
                // exists; nothing here precludes mixed block lengths later
                // (a future version could store each block's own
                // slot_duration instead of one global value).
                'relative_start' => ($block['block'] - 1) * $slotSeconds,
                'items' => $outItems,
            ];
        }

        return [
            'schema_version' => 1,
            'channel' => $channel,
            'slot_duration' => $slotSeconds,
            'strategy' => $strategy,
            'generated_at' => gmdate('c'),
            'blocks' => $outBlocks,
        ];
    }

    /**
     * Extension-point helper (not wired to any CLI flag): given a cycle's
     * start time, a block number (1-based) and an offset within that block
     * (seconds, as stored in schedule.json), returns the absolute UTC
     * instant that item starts playing. Relies only on fields already in
     * schedule.json, so this can be computed later by any consumer without
     * re-running the optimizer.
     */
    public static function absoluteBlockStart(DateTimeImmutable $cycleStart, int $blockNumber, int $slotSeconds, float $offsetWithinBlock = 0.0): DateTimeImmutable
    {
        $seconds = ($blockNumber - 1) * $slotSeconds + $offsetWithinBlock;
        return $cycleStart->modify(sprintf('+%F seconds', $seconds));
    }

    public static function writeJson(string $path, array $data): void
    {
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json === false) {
            throw new RuntimeException("Failed to encode JSON for: $path");
        }
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException("Failed to create output directory: $dir");
        }
        $tmp = $path . '.tmp';
        if (file_put_contents($tmp, $json) === false) {
            throw new RuntimeException("Failed to write: $tmp");
        }
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException("Failed to finalize write: $path");
        }
    }
}
