<?php
declare(strict_types=1);

// ia-import/src/ImportReporter.php
//
// Prints the human-readable CLI report (see README for a sample). Pure
// presentation -- all numbers are passed in already computed by
// ia-import.php so this stays easy to unit test independent of formatting.

final class ImportReporter
{
    /** @param array<string,mixed> $s */
    public static function printSummary(array $s): void
    {
        echo "Internet Archive Import\n";
        echo "=======================\n\n";
        echo "List: {$s['list_name']}\n";
        printf("%-24s%d\n", 'Items found:', $s['items_found']);
        printf("%-24s%d\n", 'Metadata fetched:', $s['metadata_fetched']);
        printf("%-24s%d\n", 'Playable videos:', $s['playable']);
        printf("%-24s%d\n", 'Unknown durations:', $s['unknown_duration']);
        printf("%-24s%d\n", 'Unavailable videos:', $s['unavailable']);
        echo "\n";
        echo "Scheduling\n";
        echo "==========\n\n";
        printf("%-24s%d minutes\n", 'Slot size:', $s['slot_minutes']);
        printf("%-24s%s\n", 'Strategy:', $s['strategy']);
        printf("%-24s%s\n", 'Total content:', DurationParser::formatHoursMinutes((float) $s['total_content_seconds']));
        printf("%-24s%d\n", 'Scheduled programs:', $s['scheduled_programs']);
        printf("%-24s%d\n", 'Normal blocks:', $s['normal_blocks']);
        printf("%-24s%d\n", 'Oversized programs:', $s['oversized_programs']);
        printf("%-24s%.1f%%\n", 'Average slot fill:', $s['average_fill_pct']);
        printf("%-24s%s\n", 'Total unused time:', DurationParser::formatHoursMinutes((float) $s['total_unused_seconds']));
        printf("%-24s%s\n", 'Filler time:', DurationParser::formatHoursMinutes((float) $s['filler_seconds']));

        if (!empty($s['unscheduled_count'])) {
            printf("%-24s%d (see warnings below)\n", 'Unscheduled items:', $s['unscheduled_count']);
        }

        echo "\nOutputs:\n";
        if ($s['dry_run']) {
            echo "  (dry run -- no files written)\n";
        } elseif (empty($s['outputs'])) {
            echo "  (none)\n";
        } else {
            foreach ($s['outputs'] as $path) {
                echo "  $path\n";
            }
        }

        $warnings = $s['warnings'] ?? [];
        $violations = $s['violations'] ?? [];
        if ($warnings || $violations) {
            echo "\nWarnings\n";
            echo "========\n";
            foreach ($violations as $v) {
                echo "  [max-shift] $v\n";
            }
            $max = (int) ($s['max_warnings'] ?? 50);
            foreach (array_slice($warnings, 0, $max) as $w) {
                echo "  $w\n";
            }
            if (count($warnings) > $max) {
                $more = count($warnings) - $max;
                echo "  ... and $more more (use --verbose to see everything, or inspect catalog.json)\n";
            }
        }
    }

    /** @param list<array<string,mixed>> $blocks */
    public static function printVerboseBlocks(array $blocks, array $catalogById = []): void
    {
        echo "\nBlock detail\n";
        echo "============\n\n";
        foreach ($blocks as $block) {
            $label = $block['type'] === 'overflow' ? 'OVERFLOW' : 'BLOCK';
            printf("%s %03d [%s]\n", $label, $block['block'], DurationParser::format((float) $block['duration']));
            foreach ($block['items'] as $item) {
                $start = DurationParser::format((float) $item['start']);
                $dur = DurationParser::format((float) $item['duration']);
                if ($item['type'] === 'gap') {
                    printf("  %-6s %-28s%8s\n", $start, 'GAP', $dur);
                } else {
                    $name = $item['title'] ?? ($catalogById[$item['id']]['title'] ?? $item['id']);
                    $tag = $item['type'] === 'filler' ? ' [filler]' : '';
                    printf("  %-6s %-28s%8s\n", $start, self::truncate($name . $tag, 28), $dur);
                }
            }
            $fill = $block['duration'] > 0 ? (100.0 * $block['used'] / $block['duration']) : 0.0;
            printf("\nFill: %.1f%%\n\n", $fill);
        }
    }

    private static function truncate(string $s, int $len): string
    {
        return mb_strlen($s) > $len ? mb_substr($s, 0, $len - 1) . '…' : $s;
    }
}
