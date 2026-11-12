<?php
declare(strict_types=1);

// channels/publish/src/RotationState.php
//
// Persisted rotation-cursor checkpoint for PACKING-ENABLED blocks (see
// ProgrammingCompiler's packing path). EpisodeSetPin snapshots WHICH episodes
// are eligible and in what order; this file tracks WHERE a block's sequential
// consumption of that list is. A single occurrence can consume several
// episodes, so the non-packing rule "advance by one episode per occurrence"
// can no longer tell what plays next.
//
// Why a checkpoint, not a per-occurrence ledger: an occurrence's composition
// is a pure function of (a) the pinned list and (b) the cursor/deferred-queue
// state *entering* it. Compiles that start from the same entering state and
// walk the same occurrences forward give identical results, so only one
// checkpoint is kept: the state entering the most recent publish window's
// first occurrence. Each publish replays from that checkpoint to the new
// window's end, then advances the checkpoint to its own window's first
// occurrence, never past it. That makes republishing the same (or an
// overlapping) window idempotent. Replay cost is bounded by how far the
// window moved since the last publish (normally a few days; see publish.php's
// rollover notes), not by the channel's lifetime.
//
// Limitation: publishing a window whose first occurrence is EARLIER than the
// checkpoint (an operator moving --window-start backward) can't be replayed,
// because there is no history before the checkpoint. Rotation state resets
// to the beginning (cursor 0, no deferred episodes) with a warning rather
// than guessing; normal forward rolling never hits it.
//
// State also resets (with a warning) when the pinned episode-set version it
// was computed against no longer matches the current pin's (see
// EpisodeSetPin): a cursor and deferred ids computed against one ordering
// are meaningless against another.
//
// State files are not source-controlled (channels/publish/.gitignore covers
// channels/<id>/.publish/), like EpisodeSetPin's.

final class RotationState
{
    /**
     * @return array{
     *   cursor: int,
     *   deferred: list<array{episode_id:string, pinned_index:int}>,
     *   altCursor: int,
     *   checkpoint_occurrence_index: ?int,
     *   checkpoint_at: ?string,
     *   reset: bool,
     *   resetReason: ?string,
     * }
     */
    public static function load(string $stateDir, string $channelId, string $blockId, int $pinVersion): array
    {
        $path = self::path($stateDir, $channelId, $blockId);
        $raw = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
        if (!is_array($raw)) {
            return self::empty();
        }
        if ((int) ($raw['pin_version'] ?? -1) !== $pinVersion) {
            $r = self::empty();
            $r['reset'] = true;
            $r['resetReason'] = 'the pinned episode set was refreshed (version changed); rotation cursor and deferred queue reset to the start.';
            return $r;
        }
        $deferred = [];
        foreach (is_array($raw['deferred'] ?? null) ? $raw['deferred'] : [] as $d) {
            if (is_array($d) && is_string($d['episode_id'] ?? null) && is_int($d['pinned_index'] ?? null)) {
                $deferred[] = ['episode_id' => $d['episode_id'], 'pinned_index' => $d['pinned_index']];
            }
        }
        return [
            'cursor' => (int) ($raw['cursor'] ?? 0),
            'deferred' => $deferred,
            'altCursor' => (int) ($raw['alt_cursor'] ?? 0), // only meaningful for packing.mode=hybrid -- see EpisodePacker::packHybrid
            'checkpoint_occurrence_index' => isset($raw['checkpoint_occurrence_index']) ? (int) $raw['checkpoint_occurrence_index'] : null,
            'checkpoint_at' => is_string($raw['checkpoint_at'] ?? null) ? $raw['checkpoint_at'] : null,
            'reset' => false,
            'resetReason' => null,
        ];
    }

    /** @return array{cursor:int, deferred:list<array{episode_id:string,pinned_index:int}>, altCursor:int, checkpoint_occurrence_index:?int, checkpoint_at:?string, reset:bool, resetReason:?string} */
    public static function empty(): array
    {
        return [
            'cursor' => 0,
            'deferred' => [],
            'altCursor' => 0,
            'checkpoint_occurrence_index' => null,
            'checkpoint_at' => null,
            'reset' => false,
            'resetReason' => null,
        ];
    }

    /**
     * Persists a new checkpoint -- never moves it to an occurrence index
     * earlier than (or equal to) whatever is already stored, so a replay
     * that starts from an older checkpoint than strictly necessary is
     * always safe (merely does a little extra, still-bounded, redundant
     * work), while a checkpoint can never regress.
     *
     * @param array{episode_id:string,pinned_index:int} $deferred
     */
    public static function save(
        string $stateDir,
        string $channelId,
        string $blockId,
        int $pinVersion,
        int $cursor,
        array $deferred,
        int $altCursor,
        int $checkpointOccurrenceIndex,
        DateTimeImmutable $checkpointAt,
    ): void {
        $path = self::path($stateDir, $channelId, $blockId);
        $existing = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
        $existingIndex = is_array($existing) ? ($existing['checkpoint_occurrence_index'] ?? null) : null;
        if (is_int($existingIndex) && $existingIndex >= $checkpointOccurrenceIndex && (int) ($existing['pin_version'] ?? -1) === $pinVersion) {
            return; // never regress a checkpoint for the same pin version
        }

        self::write($path, [
            'pin_version' => $pinVersion,
            'cursor' => $cursor,
            'deferred' => $deferred,
            'alt_cursor' => $altCursor,
            'checkpoint_occurrence_index' => $checkpointOccurrenceIndex,
            'checkpoint_at' => $checkpointAt->format('c'),
            'saved_at' => gmdate('c'),
        ]);
    }

    private static function path(string $stateDir, string $channelId, string $blockId): string
    {
        $safeChannel = preg_replace('/[^a-z0-9-]/i', '_', $channelId) ?? 'channel';
        $safeBlock = preg_replace('/[^a-z0-9_-]/i', '_', $blockId) ?? 'block';
        return rtrim($stateDir, '/') . "/$safeChannel.$safeBlock.rotation.json";
    }

    private static function write(string $path, array $data): void
    {
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException("Failed to create publish state directory: $dir");
        }
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            throw new RuntimeException("Failed to encode rotation state for: $path");
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
