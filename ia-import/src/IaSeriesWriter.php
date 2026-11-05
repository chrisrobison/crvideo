<?php
declare(strict_types=1);

// ia-import/src/IaSeriesWriter.php
//
// Reads/writes a series.json for the IA series importer -- byte-for-byte
// the same atomic-write convention as youtube-import/src/YouTubeSeriesWriter.php
// (temp file + rename, one-generation ".bak"). Deliberately a separate,
// duplicated class rather than a shared one: these two importers have no
// shared runtime today (see docs/series-and-channels.md's note on
// CatalogResolver.php/catalog-resolver.js needing to be "kept in lockstep
// by hand" for the same reason), and this file is ~20 lines either way.

final class IaSeriesWriter
{
    /** @return ?array<string,mixed> null if the file doesn't exist yet */
    public static function read(string $path): ?array
    {
        if (!is_file($path)) {
            return null;
        }
        $raw = file_get_contents($path);
        if ($raw === false || trim($raw) === '') {
            return null;
        }
        $data = json_decode($raw, true);
        return is_array($data) ? $data : null;
    }

    public static function write(string $path, array $series): void
    {
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException("Failed to create directory: $dir");
        }

        if (is_file($path) && !copy($path, $path . '.bak')) {
            throw new RuntimeException("Failed to back up existing file before overwriting: $path.bak");
        }

        $json = json_encode($series, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json === false) {
            throw new RuntimeException("Failed to encode series.json for: $path");
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
