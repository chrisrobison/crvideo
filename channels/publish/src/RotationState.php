<?php
declare(strict_types=1);

// channels/publish/src/RotationState.php
//
// Persisted rotation-cursor checkpoint for PACKING-ENABLED blocks (see
// ProgrammingCompiler's packing path). This is new state that
// EpisodeSetPin does not cover: EpisodeSetPin snapshots WHICH episodes
// are eligible and in what order ("the pinned list"); this file tracks
// WHERE a block's sequential consumption of that list currently is, now
// that a single occurrence can consume more than one episode -- so
// "advance by one episode per occurrence" (the old, still-used-when-
// packing-is-disabled rule) is no longer enough to know what plays next.
//
// Why a checkpoint, not a full per-occurrence ledger: the schedule's
// composition for a given occurrence is a pure function of (a) the
// pinned episode list and (b) the rotation cursor/deferred-queue state
// *entering* that occurrence. Two separate compiles that start from the
// same entering state and walk the same occurrences forward produce
// identical results, so we never need to remember every occurrence ever
// published -- just one checkpoint: the state entering the most recent
// publish window's own first occurrence. Every later publish re-derives
// (replays) everything from that checkpoint forward to the new window's
// end, then advances the checkpoint to ITS OWN window's first occurrence
// -- never past it, which is what keeps republishing the same (or an
// overlapping) window idempotent: replay starts from the same checkpoint
// and reproduces the same state and the same emitted items every time.
// Replay cost is bounded by how far the window has moved forward since
// the last publish (normally a few days -- see publish.php's "Rollover /
// regeneration workflow"), never by the channel's total lifetime.
//
// Documented limitation (same honesty standard as EpisodeSetPin's "Known
// limitations" and this project's other state files): publishing a
// window whose first occurrence is EARLIER than the current checkpoint
// (an operator deliberately moving --window-start backward past a
// previously advanced checkpoint) is not something this file can replay
// correctly -- there is no history before the checkpoint to re-derive
// from. That case resets rotation state to the beginning (cursor 0, no
// deferred episodes) with a clear warning rather than silently guessing;
// it is the packing-path equivalent of re-publishing from scratch. The
// ordinary forward-rolling workflow this project already documents never
// hits it.
//
// Also resets (with a warning) whenever the pinned episode-set version
// it was last computed against no longer matches the current pin's
// version (see EpisodeSetPin) -- a cursor position/deferred-episode-id
// list computed against one pinned ordering is not meaningful against a
// different one.
//
// State files are intentionally NOT source-controlled (channels/publish/
// .gitignore already covers channels/<id>/.publish/) -- same operational
// posture as EpisodeSetPin.

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
