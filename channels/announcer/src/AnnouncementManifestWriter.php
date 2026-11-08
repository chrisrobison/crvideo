<?php
declare(strict_types=1);

// channels/announcer/src/AnnouncementManifestWriter.php
//
// Atomically maintains channels/<id>/announcements.json -- the published
// manifest linking each transition to its generated script/audio (spec
// section 7), kept deliberately SEPARATE from schedule.json so a TTS/AI
// failure can never make the base schedule invalid or unplayable (spec
// section 5: "A schedule should remain valid and playable even when
// announcement generation fails" / "publish the base schedule first and
// update the announcement manifest as assets become ready").
//
// Unlike schedule.json (written once per publish.php run), this file is
// updated incrementally by many separate announce-worker.php job
// completions over time, so upsert() takes an exclusive flock() for its
// read-modify-write section -- the one place in this feature that
// actually needs real mutual exclusion, since JobQueue's rename()-based
// claims already make the jobs themselves safe to run concurrently.

final class AnnouncementManifestWriter
{
    private const TYPE_SUFFIX = [
        'coming_up_next' => 'next',
        'now_showing' => 'now',
        'still_ahead' => 'ahead',
        'channel_id' => 'id',
        'lineup_preview' => 'preview',
        'return_from_break' => 'return',
    ];

    public static function idFor(string $channelId, string $transitionId, string $type): string
    {
        $suffix = self::TYPE_SUFFIX[$type] ?? $type;
        return "$channelId-$transitionId-$suffix";
    }

    public static function path(string $channelDir): string
    {
        return "$channelDir/announcements.json";
    }

    /** @param array<string,mixed> $record must include "id" */
    public static function upsert(string $channelDir, array $record): void
    {
        $path = self::path($channelDir);
        $lockPath = $path . '.lock';
        $lockFh = fopen($lockPath, 'c');
        if ($lockFh === false) {
            throw new RuntimeException("Could not open lock file: $lockPath");
        }
        flock($lockFh, LOCK_EX);
        try {
            $manifest = self::read($path);
            $id = (string) $record['id'];
            $found = false;
            foreach ($manifest['announcements'] as &$existing) {
                if (($existing['id'] ?? null) === $id) {
                    $existing = $record;
                    $found = true;
                    break;
                }
            }
            unset($existing);
            if (!$found) {
                $manifest['announcements'][] = $record;
            }
            $manifest['updatedAt'] = gmdate('c');
            self::atomicWriteJson($path, $manifest);
        } finally {
            flock($lockFh, LOCK_UN);
            fclose($lockFh);
        }
    }

    /** Removes manifest entries whose id is not in $validIds -- garbage
     *  collection for announcements whose transition no longer exists in
     *  the current schedule (spec section 6: force-regeneration/GC). */
    public static function pruneExcept(string $channelDir, array $validIds): int
    {
        $path = self::path($channelDir);
        $lockPath = $path . '.lock';
        $lockFh = fopen($lockPath, 'c');
        if ($lockFh === false) {
            throw new RuntimeException("Could not open lock file: $lockPath");
        }
        flock($lockFh, LOCK_EX);
        try {
            $manifest = self::read($path);
            $before = count($manifest['announcements']);
            $manifest['announcements'] = array_values(array_filter(
                $manifest['announcements'],
                static fn (array $r): bool => in_array($r['id'] ?? null, $validIds, true),
            ));
            $removed = $before - count($manifest['announcements']);
            if ($removed > 0) {
                $manifest['updatedAt'] = gmdate('c');
                self::atomicWriteJson($path, $manifest);
            }
            return $removed;
        } finally {
            flock($lockFh, LOCK_UN);
            fclose($lockFh);
        }
    }

    /** @return array{schema_version:int, announcements:list<array<string,mixed>>, updatedAt?:string} */
    public static function read(string $path): array
    {
        if (!is_file($path)) {
            return ['schema_version' => 1, 'announcements' => []];
        }
        $data = json_decode((string) file_get_contents($path), true);
        if (!is_array($data) || !isset($data['announcements']) || !is_array($data['announcements'])) {
            return ['schema_version' => 1, 'announcements' => []];
        }
        return $data;
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
        $tmp = $path . '.' . getmypid() . '.' . mt_rand(1000, 9999) . '.tmp';
        if (file_put_contents($tmp, $json . "\n") === false) {
            throw new RuntimeException("Failed to write temp file: $tmp");
        }
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException("Failed to finalize write for: $path");
        }
    }
}
