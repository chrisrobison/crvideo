<?php
declare(strict_types=1);

// ia-import/src/MetadataCache.php
//
// Local on-disk cache for raw Internet Archive /metadata/{identifier}
// responses, at .cache/internet-archive/{sanitized-identifier}.json by
// default. Writes are atomic (temp file + rename). Identifiers are
// sanitized before being used as filenames so nothing from untrusted
// metadata can escape the cache directory.

final class MetadataCache
{
    private string $dir;
    private int $ttlSeconds;

    public function __construct(string $dir, int $ttlSeconds = 604800)
    {
        $this->dir = rtrim($dir, '/');
        $this->ttlSeconds = $ttlSeconds;
        if (!is_dir($this->dir)) {
            if (!mkdir($this->dir, 0775, true) && !is_dir($this->dir)) {
                throw new RuntimeException("Failed to create cache directory: {$this->dir}");
            }
        }
    }

    public static function sanitizeIdentifier(string $identifier): string
    {
        $clean = preg_replace('/[^A-Za-z0-9_.\-]/', '_', $identifier);
        // Dots are legal in real IA identifiers, so they survive the pass
        // above, but a run of 2+ dots has no legitimate use here and is
        // exactly the shape of a path-traversal attempt -- collapse any
        // such run so "../../etc/passwd" can't even cosmetically resemble
        // one once slashes are gone.
        $clean = preg_replace('/\.{2,}/', '_', (string) $clean);
        return $clean === '' ? '_' : $clean;
    }

    private function path(string $identifier): string
    {
        return $this->dir . '/' . self::sanitizeIdentifier($identifier) . '.json';
    }

    /**
     * @return array{identifier: string, fetched_at: int, raw: array}|null
     */
    public function get(string $identifier, bool $ignoreExpiry = false): ?array
    {
        $path = $this->path($identifier);
        if (!is_file($path)) {
            return null;
        }
        $raw = file_get_contents($path);
        if ($raw === false) {
            return null;
        }
        $wrapper = json_decode($raw, true);
        if (!is_array($wrapper) || !isset($wrapper['raw']) || !is_array($wrapper['raw'])) {
            return null;
        }
        if (!$ignoreExpiry) {
            $fetchedAt = (int) ($wrapper['fetched_at'] ?? 0);
            if ((time() - $fetchedAt) > $this->ttlSeconds) {
                return null;
            }
        }
        return $wrapper;
    }

    public function has(string $identifier): bool
    {
        return is_file($this->path($identifier));
    }

    public function set(string $identifier, array $rawMetadata): void
    {
        $wrapper = [
            'identifier' => $identifier,
            'fetched_at' => time(),
            'raw' => $rawMetadata,
        ];
        $path = $this->path($identifier);
        // No randomness here (keeps the whole pipeline deterministic end to
        // end) -- pid + a monotonic counter is enough to avoid collisions
        // between concurrent writers to the same cache directory.
        static $counter = 0;
        $tmp = $path . '.' . getmypid() . '.' . (++$counter) . '.tmp';
        $json = json_encode($wrapper, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            throw new RuntimeException("Failed to encode cache entry for identifier: $identifier");
        }
        if (file_put_contents($tmp, $json) === false) {
            throw new RuntimeException("Failed to write cache temp file: $tmp");
        }
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException("Failed to finalize cache write for: $path");
        }
    }
}
