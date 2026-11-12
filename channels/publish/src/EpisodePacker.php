<?php
declare(strict_types=1);

// channels/publish/src/EpisodePacker.php
//
// Pure, single-occurrence packing decision: given the time available in one
// occurrence and a block's pinned episode list plus its rotation state,
// decide which episode(s) to play, in order, and the rotation state entering
// the NEXT occurrence. This is the only place "does episode X fit in the time
// I have left" is decided. ProgrammingCompiler owns *when* occurrences happen
// and RotationState persists state across publish runs; this class owns
// neither, so it is unit-testable with plain arrays and no filesystem/clock.
//
// An episode is NEVER truncated to fit: in every mode it plays in full or is
// not scheduled this occurrence. packing.mode values:
//
//   - "sequential" (packSequential): play pinned episodes in defined order,
//     fitting as many complete ones as possible. For episodic series where
//     order matters.
//   - "best_fit" (packBestFit): at each pick, choose from every eligible
//     (fitting, not yet used this occurrence) pinned episode the one that
//     minimizes leftover time: a bounded O(pinnedCount^2) greedy search per
//     occurrence, never exhaustive. Tie-break: smallest leftover, then closest
//     (wrapping) to a fairness cursor that rotates past whatever was just used
//     (so one perfectly sized episode can't dominate every occurrence), then
//     lowest pinned index. Order doesn't matter, so `on_unfit` doesn't apply.
//   - "hybrid" (packHybrid): prefer the main sequential cursor whenever it
//     fits (the show stays recognizable); otherwise search a bounded, separate
//     rotation of "alternate" episodes for filler, with its own cursor
//     (`altCursor`) so (a) the main cursor is never disturbed by filler picks
//     and (b) no single alternate is reused every time, which would starve the
//     rest of the catalog.
//
// on_unfit policy (sequential mode only; hybrid has its own simpler "find one
// bounded alternate, else hold" rule and best_fit has no "next" episode),
// applied when the next sequential episode doesn't fit the remaining time:
//   - "defer" (the default): stop packing this occurrence. The cursor is NOT
//     advanced past the unfit episode, which gives it priority at the next
//     occurrence with a full fresh slot; nothing else needs remembering. (If
//     the episode is longer than the block's own duration, no future
//     occurrence will fit it either; a dedicated warning names the fix: a
//     larger duration or a different on_unfit policy.)
//   - "skip_for_block": look ahead, bounded by the pinned list's length, for
//     the next episode that does fit. Every episode skipped to reach it
//     (including the unfit one) joins a small deferred queue, tried first
//     (oldest first) at every future occurrence ahead of the sequential
//     cursor, so nothing is permanently dropped. If nothing fits either, this
//     degrades to "defer" (cursor held, nothing queued).
//   - "allow_overrun": schedule the unfit episode anyway, letting the
//     occurrence run past its nominal slot. Safe because ProgrammingCompiler's
//     overlap check (BoundaryResolver) still refuses a schedule where the
//     overrun collides with the next occurrence.
//
// An episode is never scheduled twice in one occurrence unless
// packing.allow_repeat_within_block is true (default false); with N pinned
// episodes, at most N distinct "new" sequential picks are attempted.

final class EpisodePacker
{
    private const DEFAULT_ON_UNFIT = 'defer';
    private const VALID_ON_UNFIT = ['defer', 'skip_for_block', 'allow_overrun'];
    private const VALID_MODES = ['sequential', 'best_fit', 'hybrid'];

    /** @return array{mode:string, minimumRemaining:int, safetyMargin:int, onUnfit:string, allowRepeatWithinBlock:bool} */
    public static function normalizeConfig(array $packing, string $blockId): array
    {
        $mode = is_string($packing['mode'] ?? null) ? $packing['mode'] : 'sequential';
        if (!in_array($mode, self::VALID_MODES, true)) {
            throw new RuntimeException(
                "block \"$blockId\": packing.mode \"$mode\" is invalid -- must be one of: " . implode(', ', self::VALID_MODES)
            );
        }
        $onUnfit = is_string($packing['on_unfit'] ?? null) ? $packing['on_unfit'] : self::DEFAULT_ON_UNFIT;
        if (!in_array($onUnfit, self::VALID_ON_UNFIT, true)) {
            throw new RuntimeException(
                "block \"$blockId\": packing.on_unfit \"$onUnfit\" is invalid -- must be one of: " . implode(', ', self::VALID_ON_UNFIT)
            );
        }
        $minimumRemaining = (int) ($packing['minimum_remaining'] ?? 0);
        $safetyMargin = (int) ($packing['safety_margin'] ?? 0);
        if ($minimumRemaining < 0 || $safetyMargin < 0) {
            throw new RuntimeException("block \"$blockId\": packing.minimum_remaining and packing.safety_margin must not be negative.");
        }
        return [
            'mode' => $mode,
            'minimumRemaining' => $minimumRemaining,
            'safetyMargin' => $safetyMargin,
            'onUnfit' => $onUnfit,
            'allowRepeatWithinBlock' => (bool) ($packing['allow_repeat_within_block'] ?? false),
        ];
    }

    /**
     * @param list<string> $pinnedIds pinned (EpisodeSetPin) order -- rotation.loop governs wraparound exactly as the non-packing path does.
     * @param array<string,array<string,mixed>> $episodesById
     * @param array{cursor:int, deferred:list<array{episode_id:string,pinned_index:int}>, altCursor?:int} $state entering this occurrence
     * @param array{mode:string, minimumRemaining:int, safetyMargin:int, onUnfit:string, allowRepeatWithinBlock:bool} $config
     * @param bool $loop rotation.loop -- when false, the cursor never wraps; running past the end simply ends packing for every future occurrence too.
     * @param int $fallbackDuration the block's nominal duration, used when an episode's own duration is unknown (same fallback rule the non-packing path already uses).
     * @return array{
     *   scheduled: list<array{episode_id:string, duration:int}>,
     *   state: array{cursor:int, deferred:list<array{episode_id:string,pinned_index:int}>, altCursor:int},
     *   usedSeconds: int,
     *   warnings: list<string>,
     * }
     */
    public static function packOccurrence(
        int $availableSeconds,
        array $pinnedIds,
        array $episodesById,
        array $state,
        array $config,
        bool $loop,
        int $fallbackDuration,
        string $blockId,
        string $occurrenceLabel,
    ): array {
        return match ($config['mode']) {
            'best_fit' => self::packBestFit($availableSeconds, $pinnedIds, $episodesById, $state, $config, $fallbackDuration, $blockId, $occurrenceLabel),
            'hybrid' => self::packHybrid($availableSeconds, $pinnedIds, $episodesById, $state, $config, $loop, $fallbackDuration, $blockId, $occurrenceLabel),
            default => self::packSequential($availableSeconds, $pinnedIds, $episodesById, $state, $config, $loop, $fallbackDuration, $blockId, $occurrenceLabel),
        };
    }

    /** Duration to use for a pinned episode: its own series.json duration if known and positive, else the block's nominal duration. Null if it's no longer approved/present at all. */
    private static function episodeDuration(array $episodesById, int $fallbackDuration, string $episodeId): ?int
    {
        $ep = $episodesById[$episodeId] ?? null;
        if ($ep === null || ($ep['status'] ?? null) !== 'approved') {
            return null;
        }
        $d = is_numeric($ep['duration'] ?? null) ? (float) $ep['duration'] : null;
        return ($d !== null && $d > 0) ? (int) round($d) : $fallbackDuration;
    }

    private static function packSequential(
        int $availableSeconds,
        array $pinnedIds,
        array $episodesById,
        array $state,
        array $config,
        bool $loop,
        int $fallbackDuration,
        string $blockId,
        string $occurrenceLabel,
    ): array {
        $pinnedCount = count($pinnedIds);
        $warnings = [];
        $scheduled = [];
        $scheduledIds = [];
        $remaining = $availableSeconds;
        $cursor = $state['cursor'];
        $deferred = $state['deferred'];

        $durationOf = static fn (string $episodeId): ?int => self::episodeDuration($episodesById, $fallbackDuration, $episodeId);
        $trySchedule = function (string $episodeId, int $pinnedIndex) use (
            &$scheduled, &$scheduledIds, &$remaining, $durationOf, $config, &$warnings, $blockId, $occurrenceLabel,
        ): bool {
            if (!$config['allowRepeatWithinBlock'] && isset($scheduledIds[$episodeId])) {
                return false;
            }
            $duration = $durationOf($episodeId);
            if ($duration === null) {
                $warnings[] = "block \"$blockId\" occurrence $occurrenceLabel: pinned episode \"$episodeId\" is no longer approved/present; skipped from this occurrence's packing.";
                return true; // "handled" (dropped) -- caller still advances past it
            }
            if ($duration + $config['safetyMargin'] > $remaining) {
                return false; // doesn't fit at all -- caller decides on_unfit handling
            }
            $leftover = $remaining - $duration;
            if ($leftover > 0 && $leftover < $config['minimumRemaining']) {
                return false; // would technically fit, but would leave too little slack for continuity afterward
            }
            $scheduled[] = ['episode_id' => $episodeId, 'duration' => $duration];
            $scheduledIds[$episodeId] = true;
            $remaining -= $duration;
            return true;
        };

        // 1. Deferred queue first (oldest first) -- gives a previously-unfit episode priority before new ones are considered, so nothing starves forever.
        $stillDeferred = [];
        foreach ($deferred as $d) {
            if (!$trySchedule($d['episode_id'], $d['pinned_index'])) {
                $stillDeferred[] = $d;
            }
        }
        $deferred = $stillDeferred;

        // 2. Sequential cursor, bounded to at most one full pass over the pinned list per occurrence (never an unbounded loop, and -- when
        //    allow_repeat_within_block is false, the default -- this bound is also exactly what prevents the same episode airing twice in one occurrence).
        $maxAttempts = $config['allowRepeatWithinBlock'] ? $pinnedCount * 4 : $pinnedCount;
        for ($attempts = 0; $attempts < $maxAttempts && $remaining > $config['minimumRemaining'] && $pinnedCount > 0; $attempts++) {
            if (!$loop && ($cursor < 0 || $cursor >= $pinnedCount)) {
                break; // non-looping rotation has run out (or hasn't started) -- leave the rest as a gap, exactly like the non-packing path
            }
            $idx = Recurrence::floorMod($cursor, $pinnedCount);
            $episodeId = $pinnedIds[$idx];

            if ($trySchedule($episodeId, $idx)) {
                $cursor++;
                continue;
            }

            // The next sequential episode does not fit -- apply on_unfit.
            if ($config['onUnfit'] === 'allow_overrun') {
                $duration = $durationOf($episodeId) ?? $fallbackDuration;
                $scheduled[] = ['episode_id' => $episodeId, 'duration' => $duration];
                $scheduledIds[$episodeId] = true;
                $remaining -= $duration; // may go negative -- ProgrammingCompiler's overlap check is the real safety net here
                $cursor++;
                $warnings[] = "block \"$blockId\" occurrence $occurrenceLabel: episode \"$episodeId\" ({$duration}s) does not fit in the remaining time; scheduled anyway (packing.on_unfit=allow_overrun).";
                continue;
            }

            if ($config['onUnfit'] === 'skip_for_block') {
                $found = null;
                for ($lookahead = 1; $lookahead <= $pinnedCount; $lookahead++) {
                    $candidateIdx = Recurrence::floorMod($cursor + $lookahead, $pinnedCount);
                    $candidateId = $pinnedIds[$candidateIdx];
                    if (!$config['allowRepeatWithinBlock'] && isset($scheduledIds[$candidateId])) {
                        continue;
                    }
                    $d = $durationOf($candidateId);
                    if ($d !== null) {
                        $candidateLeftover = $remaining - $d;
                        if ($d + $config['safetyMargin'] <= $remaining && !($candidateLeftover > 0 && $candidateLeftover < $config['minimumRemaining'])) {
                            $found = ['idx' => $candidateIdx, 'id' => $candidateId];
                            break;
                        }
                    }
                }
                if ($found !== null) {
                    // Defer every pinned episode strictly between the stuck one and the found
                    // one (inclusive of the stuck one) -- skipped over, never dropped from
                    // rotation; reconsidered with priority at a future occurrence.
                    $scanCursor = $cursor;
                    for ($guard = 0; $guard < $pinnedCount; $guard++) {
                        $scanIdx = Recurrence::floorMod($scanCursor, $pinnedCount);
                        if ($scanIdx === $found['idx']) {
                            break;
                        }
                        $skippedId = $pinnedIds[$scanIdx];
                        if ($config['allowRepeatWithinBlock'] || !isset($scheduledIds[$skippedId])) {
                            $deferred[] = ['episode_id' => $skippedId, 'pinned_index' => $scanIdx];
                        }
                        $scanCursor++;
                    }
                    $trySchedule($found['id'], $found['idx']);
                    $cursor = $found['idx'] + 1;
                    continue;
                }
                // Nothing else fits either -- degrades to exactly what "defer" would do
                // for this one stuck episode (see below): held, cursor not advanced past it.
                $warnings[] = "block \"$blockId\" occurrence $occurrenceLabel: episode \"$episodeId\" does not fit and no alternative pinned episode fits either "
                    . '(packing.on_unfit=skip_for_block); held for a future occurrence, same as on_unfit=defer would do.';
                break;
            }

            // "defer" (default, and skip_for_block's fallback above): stop packing this
            // occurrence. The cursor is deliberately NOT advanced past the unfit episode,
            // which is exactly what gives it priority again at the very next occurrence --
            // no separate bookkeeping needed for this case.
            if ($duration = $durationOf($episodeId)) {
                if ($duration + $config['safetyMargin'] > $fallbackDuration) {
                    $warnings[] = "block \"$blockId\" occurrence $occurrenceLabel: episode \"$episodeId\" ({$duration}s) is longer than this "
                        . "block's own configured duration ({$fallbackDuration}s) -- it can never fit here under packing.on_unfit=defer; it will "
                        . 'hold this block\'s rotation until the configuration changes (raise the block\'s duration, enable packing.on_unfit='
                        . 'skip_for_block, or allow_overrun).';
                } else {
                    $warnings[] = "block \"$blockId\" occurrence $occurrenceLabel: episode \"$episodeId\" does not fit in the remaining time "
                        . 'this occurrence; held for a future occurrence (packing.on_unfit=defer).';
                }
            }
            break;
        }

        // Deferred list is naturally bounded by pinnedCount (can't defer more distinct episodes than exist); de-duplicate defensively.
        $seenDeferred = [];
        $dedupedDeferred = [];
        foreach ($deferred as $d) {
            if (!isset($seenDeferred[$d['episode_id']])) {
                $seenDeferred[$d['episode_id']] = true;
                $dedupedDeferred[] = $d;
            }
        }

        if (!$scheduled && $pinnedCount > 0 && $availableSeconds > 0) {
            $warnings[] = "block \"$blockId\" occurrence $occurrenceLabel: nothing could be packed into this occurrence (every eligible episode is longer than the available time); left entirely as a gap.";
        }

        return [
            'scheduled' => $scheduled,
            'state' => ['cursor' => $cursor, 'deferred' => $dedupedDeferred, 'altCursor' => $state['altCursor'] ?? 0],
            'usedSeconds' => $availableSeconds - $remaining,
            'warnings' => $warnings,
        ];
    }

    /**
     * "best_fit": no notion of sequence -- every occurrence independently
     * searches every eligible pinned episode and greedily takes whichever
     * minimizes leftover time, repeating until nothing more fits. `state.cursor`
     * here is purely a fairness tie-break anchor (see the file header), not a
     * strict position; it rotates forward past whatever was just used.
     */
    private static function packBestFit(
        int $availableSeconds,
        array $pinnedIds,
        array $episodesById,
        array $state,
        array $config,
        int $fallbackDuration,
        string $blockId,
        string $occurrenceLabel,
    ): array {
        $pinnedCount = count($pinnedIds);
        $scheduled = [];
        $scheduledIds = [];
        $remaining = $availableSeconds;
        $cursor = $state['cursor'];

        $maxAttempts = $config['allowRepeatWithinBlock'] ? $pinnedCount * 4 : $pinnedCount;
        for ($attempts = 0; $attempts < $maxAttempts && $pinnedCount > 0; $attempts++) {
            $best = null;
            for ($i = 0; $i < $pinnedCount; $i++) {
                $id = $pinnedIds[$i];
                if (!$config['allowRepeatWithinBlock'] && isset($scheduledIds[$id])) {
                    continue;
                }
                $duration = self::episodeDuration($episodesById, $fallbackDuration, $id);
                if ($duration === null || $duration + $config['safetyMargin'] > $remaining) {
                    continue;
                }
                $leftover = $remaining - $duration;
                if ($leftover > 0 && $leftover < $config['minimumRemaining']) {
                    continue;
                }
                $distance = Recurrence::floorMod($i - $cursor, $pinnedCount); // deterministic tie-break: closest (wrapping) to the fairness anchor
                if (
                    $best === null
                    || $leftover < $best['leftover']
                    || ($leftover === $best['leftover'] && $distance < $best['distance'])
                    || ($leftover === $best['leftover'] && $distance === $best['distance'] && $i < $best['idx'])
                ) {
                    $best = ['idx' => $i, 'id' => $id, 'duration' => $duration, 'leftover' => $leftover, 'distance' => $distance];
                }
            }
            if ($best === null) {
                break; // nothing eligible fits anymore this occurrence -- stop, leave the rest as a gap
            }
            $scheduled[] = ['episode_id' => $best['id'], 'duration' => $best['duration']];
            $scheduledIds[$best['id']] = true;
            $remaining -= $best['duration'];
            $cursor = $best['idx'] + 1;
        }

        $warnings = [];
        if (!$scheduled && $pinnedCount > 0 && $availableSeconds > 0) {
            $warnings[] = "block \"$blockId\" occurrence $occurrenceLabel: nothing could be packed into this occurrence under packing.mode=best_fit "
                . '(every eligible episode is longer than the available time); left entirely as a gap.';
        }

        return [
            'scheduled' => $scheduled,
            'state' => ['cursor' => $cursor, 'deferred' => [], 'altCursor' => $state['altCursor'] ?? 0],
            'usedSeconds' => $availableSeconds - $remaining,
            'warnings' => $warnings,
        ];
    }

    /**
     * "hybrid": prefer the main sequential cursor whenever it fits (the
     * scheduled show stays recognizable); when it doesn't, make one bounded
     * attempt to fill the gap from a SEPARATE alternate rotation
     * (`state.altCursor`) instead of giving up immediately. The main cursor
     * is never advanced by an alternate pick -- it always resumes exactly
     * where it left off -- and the alternate rotation advances past whatever
     * it used, so repeated filler needs don't always reach for the same
     * episode.
     */
    private static function packHybrid(
        int $availableSeconds,
        array $pinnedIds,
        array $episodesById,
        array $state,
        array $config,
        bool $loop,
        int $fallbackDuration,
        string $blockId,
        string $occurrenceLabel,
    ): array {
        $pinnedCount = count($pinnedIds);
        $scheduled = [];
        $scheduledIds = [];
        $remaining = $availableSeconds;
        $cursor = $state['cursor'];
        $altCursor = $state['altCursor'] ?? 0;
        $warnings = [];

        $fits = static function (?int $duration, int $remaining, array $config): bool {
            if ($duration === null || $duration + $config['safetyMargin'] > $remaining) {
                return false;
            }
            $leftover = $remaining - $duration;
            return !($leftover > 0 && $leftover < $config['minimumRemaining']);
        };

        $maxAttempts = $pinnedCount * 2; // the main sequence, plus at most one bounded alternate-fill pass per main step
        for ($attempts = 0; $attempts < $maxAttempts && $pinnedCount > 0; $attempts++) {
            if (!$loop && ($cursor < 0 || $cursor >= $pinnedCount)) {
                break; // non-looping main rotation has run out (or hasn't started)
            }
            $idx = Recurrence::floorMod($cursor, $pinnedCount);
            $mainId = $pinnedIds[$idx];
            $mainAlreadyUsed = !$config['allowRepeatWithinBlock'] && isset($scheduledIds[$mainId]);
            if (!$mainAlreadyUsed) {
                $d = self::episodeDuration($episodesById, $fallbackDuration, $mainId);
                if ($fits($d, $remaining, $config)) {
                    $scheduled[] = ['episode_id' => $mainId, 'duration' => $d];
                    $scheduledIds[$mainId] = true;
                    $remaining -= $d;
                    $cursor++;
                    continue; // primary series stays recognizable: keep going in sequence as long as it fits
                }
            }

            // Main sequence is stuck (or already used up this occurrence) -- one bounded
            // search through the separate alternate rotation for filler.
            $found = null;
            for ($lookahead = 0; $lookahead < $pinnedCount; $lookahead++) {
                $candidateIdx = Recurrence::floorMod($altCursor + $lookahead, $pinnedCount);
                $candidateId = $pinnedIds[$candidateIdx];
                if (!$config['allowRepeatWithinBlock'] && isset($scheduledIds[$candidateId])) {
                    continue;
                }
                $d = self::episodeDuration($episodesById, $fallbackDuration, $candidateId);
                if ($fits($d, $remaining, $config)) {
                    $found = ['idx' => $candidateIdx, 'id' => $candidateId, 'duration' => $d];
                    break;
                }
            }
            if ($found === null) {
                if (!$mainAlreadyUsed) {
                    $warnings[] = "block \"$blockId\" occurrence $occurrenceLabel: the next episode in the main sequence (\"$mainId\") does not fit "
                        . 'and no approved alternate fits either (packing.mode=hybrid); the main cursor is held for a future occurrence.';
                }
                break; // main cursor intentionally left exactly where it is
            }
            $scheduled[] = ['episode_id' => $found['id'], 'duration' => $found['duration']];
            $scheduledIds[$found['id']] = true;
            $remaining -= $found['duration'];
            $altCursor = $found['idx'] + 1;
            // main cursor deliberately untouched -- loop again and re-check it against the now-smaller remaining.
        }

        if (!$scheduled && $pinnedCount > 0 && $availableSeconds > 0) {
            $warnings[] = "block \"$blockId\" occurrence $occurrenceLabel: nothing could be packed into this occurrence under packing.mode=hybrid "
                . '(every eligible episode is longer than the available time); left entirely as a gap.';
        }

        return [
            'scheduled' => $scheduled,
            'state' => ['cursor' => $cursor, 'deferred' => [], 'altCursor' => $altCursor],
            'usedSeconds' => $availableSeconds - $remaining,
            'warnings' => $warnings,
        ];
    }
}
