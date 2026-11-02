<?php
declare(strict_types=1);

// youtube-import/src/YouTubeImportReporter.php
//
// Prints the stdout summary the spec requires: additions, changes,
// unavailable videos, and unchanged items, plus whether this was a dry
// run. Mirrors ia-import/src/ImportReporter.php's plain-text style.

final class YouTubeImportReporter
{
    /**
     * @param array{added:list<string>,updated:list<string>,unavailable:list<string>,unchanged:list<string>,warnings:list<string>} $summary
     */
    public static function printSummary(string $seriesId, string $outputPath, array $summary, bool $dryRun, bool $verbose): void
    {
        echo "Series: $seriesId\n";
        echo 'Output: ' . $outputPath . ($dryRun ? ' (dry run -- nothing written)' : '') . "\n";
        echo 'Added:       ' . count($summary['added']) . "\n";
        echo 'Updated:     ' . count($summary['updated']) . "\n";
        echo 'Unavailable: ' . count($summary['unavailable']) . "\n";
        echo 'Unchanged:   ' . count($summary['unchanged']) . "\n";
        if ($summary['warnings']) {
            echo 'Warnings:    ' . count($summary['warnings']) . "\n";
        }

        if ($verbose) {
            foreach (['added' => 'Added', 'updated' => 'Updated', 'unavailable' => 'Unavailable'] as $key => $label) {
                if ($summary[$key]) {
                    echo "\n$label:\n";
                    foreach ($summary[$key] as $id) {
                        echo "  $id\n";
                    }
                }
            }
            if ($summary['warnings']) {
                echo "\nWarnings:\n";
                foreach ($summary['warnings'] as $w) {
                    echo "  $w\n";
                }
            }
        }
    }
}
