<?php
declare(strict_types=1);

// channels/publish/src/EpisodeSetPin.php
//
// "Use a stable, versioned approved episode set for published schedules
// so that imports do not unexpectedly shift episode numbering" (spec
// section 6). The problem this solves: episode rotation picks
// episode_index = occurrence_index mod count(approved episodes). If an
// editor approves one more candidate (or the importer appends new ones)
// between two publish runs, that count would silently change, which
// reshuffles *every* future occurrence's episode mapping the next time
// you publish -- not just the new episode's own slot.
//
// The fix: the ordered list of approved episode ids used for a given
// programming block's rotation is snapshotted ("pinned") to a small state
// file the first time that block is published, and every subsequent
// publish reuses that exact pinned list -- never silently recomputing it
// from whatever series.json currently says -- until an operator explicitly
// asks to update it (publish.php's --refresh-episode-set). That's the
// "versioned" part: each refresh bumps a version number, recorded with
// the snapshot, so it's always visible (in the publish report and in the
// state file itself) which approved-episode-set a published schedule was
// computed against.
//
// State files are intentionally NOT source-controlled (see
// channels/publish/.gitignore) -- same operational posture as
// ia-import's .cache/internet-archive/: they need to persist across
// publish runs on whatever machine actually runs publish.php, same as any
// other local build cache in this repo.

final class EpisodeSetPin
{
    /**
     * @param list<string> $currentApprovedIds the series' currently-approved episode ids, in series.json's
     *                                          authored order (only consulted on the very first publish for
     *                                          this block, or when $refresh is true).
     * @return array{episodeIds: list<string>, version: int, refreshed: bool}
     */
    public static function resolve(string $stateDir, string $channelId, string $blockId, array $currentApprovedIds, bool $refresh): array
    {
        $path = self::path($stateDir, $channelId, $blockId);
        $existing = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
        $existingIds = is_array($existing) && is_array($existing['episode_ids'] ?? null) ? $existing['episode_ids'] : null;

        if (!$refresh && $existingIds !== null) {
            return ['episodeIds' => $existingIds, 'version' => (int) ($existing['version'] ?? 1), 'refreshed' => false];
        }

        $version = (is_array($existing) && isset($existing['version'])) ? ((int) $existing['version']) + 1 : 1;
        self::write($path, [
            'version' => $version,
            'episode_ids' => $currentApprovedIds,
            'pinned_at' => gmdate('c'),
        ]);
        return ['episodeIds' => $currentApprovedIds, 'version' => $version, 'refreshed' => true];
    }

    private static function path(string $stateDir, string $channelId, string $blockId): string
    {
        $safeChannel = preg_replace('/[^a-z0-9-]/i', '_', $channelId) ?? 'channel';
        $safeBlock = preg_replace('/[^a-z0-9_-]/i', '_', $blockId) ?? 'block';
        return rtrim($stateDir, '/') . "/$safeChannel.$safeBlock.json";
    }

    private static function write(string $path, array $data): void
    {
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException("Failed to create publish state directory: $dir");
        }
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            throw new RuntimeException("Failed to encode episode-set pin for: $path");
        }
        static $counter = 0;
        $tmp = $path . '.' . getmypid() . '.' . (++$counter) . '.tmp';
        if (file_put_contents($tmp, $json) === false) {
            throw new RuntimeException("Failed to write temp file: $tmp");
        }
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException("Failed to finalize write for: $path");
        }
    }
}
