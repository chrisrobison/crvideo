<?php
declare(strict_types=1);

// ia-import/src/IaSeriesImportReporter.php
//
// Prints the stdout summary -- byte-for-byte the same shape as
// youtube-import/src/YouTubeImportReporter.php, so both importers read the
// same way in a terminal.

final class IaSeriesImportReporter
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
