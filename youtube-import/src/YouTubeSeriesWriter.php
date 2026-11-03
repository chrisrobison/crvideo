<?php
declare(strict_types=1);

// youtube-import/src/YouTubeSeriesWriter.php
//
// Reads an existing series.json (if any) and writes a new one atomically,
// keeping one prior-version backup -- same pattern as
// ia-import/src/MetadataCache.php (temp file + rename) and
// server/publish-playlist.php (a single-generation ".bak" alongside the
// live file).

final class YouTubeSeriesWriter
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

    /**
     * Writes $series to $path: backs up whatever is currently at $path to
     * "$path.bak" (overwriting any previous backup -- one generation, the
     * same convention as playlist.json.bak), then writes the new content
     * to a temp file and renames it into place so a reader never observes
     * a partially written file.
     */
    public static function write(string $path, array $series): void
    {
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException("Failed to create directory: $dir");
        }

        if (is_file($path)) {
            if (!copy($path, $path . '.bak')) {
                throw new RuntimeException("Failed to back up existing file before overwriting: $path.bak");
            }
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
