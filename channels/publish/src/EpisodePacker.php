<?php
declare(strict_types=1);

// channels/publish/src/EpisodePacker.php
//
// Pure, single-occurrence packing decision: given how much time is
// available in one scheduled occurrence and a block's pinned episode
// list + where its rotation currently is, decide which episode(s) to
// play, in order, and the rotation state entering the NEXT occurrence.
// This is intentionally the only place "does episode X fit in the time
// I have left" is decided -- ProgrammingCompiler owns *when* occurrences
// happen and persisting state across publish runs (see RotationState);
// this class owns none of that, which is what keeps it trivially unit-
// testable with plain arrays and no filesystem/clock involved.
//
// Sequential mode only (packing.mode "best_fit"/"hybrid" are a later
// phase -- see docs/series-and-channels.md). An episode is NEVER
// truncated to fit; it either plays in full or is not scheduled this
// occurrence at all.
//
// on_unfit policy, applied the moment the next sequential episode does
// not fit in whatever time remains in the occurrence:
//   - "defer" (the conservative default): stop packing this occurrence.
//     The rotation cursor is deliberately NOT advanced past the unfit
//     episode -- which is exactly what gives it priority again: the very
//     next occurrence tries it FIRST, with a full fresh slot. Nothing
//     separate needs to be "remembered" for this case. (If the episode
//     is longer than the block's own configured duration, no future
//     occurrence of THIS block will ever fit it either -- see the
//     dedicated warning for that, which names the fix: a larger
//     duration, or a different on_unfit policy.)
//   - "skip_for_block": look ahead, bounded by the pinned list's own
//     length (so this can never loop unboundedly even with a tiny
//     catalog), for the next episode that DOES fit; every pinned episode
//     skipped over to reach it (including the original unfit one) is
//     added to a small deferred queue -- tried first, oldest first, at
//     every future occurrence, ahead of the sequential cursor -- so
//     nothing pinned is ever permanently dropped from rotation just
//     because this occurrence found something else to play instead. When
//     no alternative fits either, this degrades to exactly what "defer"
//     does (cursor held, nothing queued).
//   - "allow_overrun": schedule the unfit episode anyway, letting the
//     occurrence run longer than its nominal slot. This is only ever
//     safe because ProgrammingCompiler's existing overlap check (see its
//     header comment) still refuses to publish a schedule where that
//     overrun collides with the next scheduled occurrence -- exactly
//     the same safety net a single, naturally-overlong episode already
//     relied on before packing existed.
//
// An episode is never scheduled twice within the same occurrence unless
// packing.allow_repeat_within_block is true (default false) -- with a
// catalog of N pinned episodes this is also naturally bounded: no more
// than N distinct "new" sequential picks are ever attempted for one
// occurrence.

final class EpisodePacker
{
    private const DEFAULT_ON_UNFIT = 'defer';
    private const VALID_ON_UNFIT = ['defer', 'skip_for_block', 'allow_overrun'];

    /** @return array{mode:string, minimumRemaining:int, safetyMargin:int, onUnfit:string, allowRepeatWithinBlock:bool} */
    public static function normalizeConfig(array $packing, string $blockId): array
    {
        $mode = is_string($packing['mode'] ?? null) ? $packing['mode'] : 'sequential';
        if ($mode !== 'sequential') {
            throw new RuntimeException(
                "block \"$blockId\": packing.mode \"$mode\" is not implemented yet -- only \"sequential\" is supported so far."
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
     * @param array{cursor:int, deferred:list<array{episode_id:string,pinned_index:int}>} $state entering this occurrence
     * @param array{mode:string, minimumRemaining:int, safetyMargin:int, onUnfit:string, allowRepeatWithinBlock:bool} $config
     * @param bool $loop rotation.loop -- when false, the cursor never wraps; running past the end simply ends packing for every future occurrence too.
     * @param int $fallbackDuration the block's nominal duration, used when an episode's own duration is unknown (same fallback rule the non-packing path already uses).
     * @return array{
     *   scheduled: list<array{episode_id:string, duration:int}>,
     *   state: array{cursor:int, deferred:list<array{episode_id:string,pinned_index:int}>},
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
        $pinnedCount = count($pinnedIds);
        $warnings = [];
        $scheduled = [];
        $scheduledIds = [];
        $remaining = $availableSeconds;
        $cursor = $state['cursor'];
        $deferred = $state['deferred'];

        $durationOf = function (string $episodeId) use ($episodesById, $fallbackDuration): ?int {
            $ep = $episodesById[$episodeId] ?? null;
            if ($ep === null || ($ep['status'] ?? null) !== 'approved') {
                return null; // no longer present/approved -- caller treats this as "drop it"
            }
            $d = is_numeric($ep['duration'] ?? null) ? (float) $ep['duration'] : null;
            return ($d !== null && $d > 0) ? (int) round($d) : $fallbackDuration;
        };
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
            'state' => ['cursor' => $cursor, 'deferred' => $dedupedDeferred],
            'usedSeconds' => $availableSeconds - $remaining,
            'warnings' => $warnings,
        ];
    }
}
