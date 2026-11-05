<?php
declare(strict_types=1);

// channels/publish/src/PublishReporter.php
//
// Plain-text stdout summary, mirroring ia-import's/youtube-import's own
// ImportReporter style.

final class PublishReporter
{
    public static function printSummary(
        string $channelId,
        DateTimeImmutable $windowStart,
        DateTimeImmutable $windowEnd,
        array $items,
        array $warnings,
        bool $dryRun,
        bool $verbose,
    ): void {
        echo "Channel: $channelId\n";
        echo 'Window:  ' . $windowStart->format('c') . ' to ' . $windowEnd->format('c') . "\n";
        echo 'Occurrences published: ' . count($items) . "\n";
        echo 'Warnings: ' . count($warnings) . "\n";
        if ($dryRun) {
            echo "(dry run -- nothing written)\n";
        }
        if ($verbose) {
            if ($items) {
                echo "\nOccurrences:\n";
                foreach ($items as $it) {
                    $label = is_string($it['title'] ?? null) ? $it['title'] : '[continuity: ' . ($it['template'] ?? '?') . ']';
                    echo '  ' . gmdate('c', $it['start']) . ' - ' . $label . " ({$it['id']})\n";
                }
            }
            if ($warnings) {
                echo "\nWarnings:\n";
                foreach ($warnings as $w) {
                    echo "  $w\n";
                }
            }
        }
    }
}
