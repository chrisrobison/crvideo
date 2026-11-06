<?php
declare(strict_types=1);

// channels/publish/src/BoundaryResolver.php
//
// Phase 3 of docs/series-and-channels.md: a dedicated stage that decides
// what happens when one occurrence's content would run into the next
// one's nominal start time, instead of that overlap logic being
// scattered through ProgrammingCompiler. ProgrammingCompiler's per-block
// loops decide WHICH episodes air WHEN, each independently, exactly as
// before Phase 3 -- grouping them into "occurrence groups" (one group per
// scheduled occurrence; a packing-enabled occurrence's several items
// travel together as one group, since a boundary decision shifts an
// entire occurrence, never splits it). This class is the only place that
// then walks every block's groups together, in chronological order, and
// decides whether an overlap is allowed to become an explicit, bounded
// delay, or must fail the whole publish.
//
// boundary.mode (per block; absent defaults to "hard" -- the exact
// pre-Phase-3 behavior, so every already-published channel is completely
// unaffected unless it opts in):
//   - "hard" (default): this occurrence's own nominal start is an anchor
//     that can never move. If the previous occurrence's (possibly
//     already-delayed) end runs past it, that is an impossible
//     combination -- publish refuses to emit anything, the same hard
//     failure this project always had for any overlap.
//   - "soft": this occurrence may begin up to boundary.max_delay seconds
//     later than its nominal start (required, a non-negative number of
//     seconds -- "any delay must be explicitly represented", never an
//     unbounded allowance). Every item in the occurrence shifts by the
//     same delay, preserving their relative timing within it; the delay
//     is recorded on each item (`delay_seconds`) rather than silently
//     absorbed, and reported in the publish warnings. An overlap bigger
//     than max_delay is, again, an impossible combination -- refused.
//   - "elastic": for this initial version, deliberately simplified to
//     behave exactly like "soft" (same required, explicit max_delay
//     bound) -- see docs/series-and-channels.md for why full elastic
//     semantics (several consecutive blocks sharing one pooled flexible
//     window, rather than one block's own tolerance) is deferred rather
//     than half-built. It still, honestly, "must respect the next hard
//     boundary" and "never allows unbounded drift", because those rules
//     fall straight out of being resolved the same way "soft" is: a
//     later hard-boundaried occurrence still refuses any leftover
//     overlap, and the delay is still capped by an explicit number.
//
// Resolution never moves an occurrence EARLIER than its nominal start
// (only later, and only when its own boundary allows it), never
// reorders occurrences, and is a single deterministic left-to-right walk
// in nominal-start order -- the same inputs always produce the same
// delays. It never looks at wall-clock "now": a channel's local-time
// recurrence semantics (DST included) are entirely Recurrence's job,
// already resolved to absolute instants before this class ever sees
// them; shifting a resolved instant later by N seconds is DST-agnostic
// arithmetic, not calendar arithmetic, which is exactly correct for "the
// previous program ran N seconds long" (an elapsed-time fact, not a
// calendar one). Nothing here is ever re-run against a historical
// window, so previously published occurrences are never rewritten by a
// later compile -- callers only ever feed it one compile's own set of
// occurrence groups.

final class BoundaryResolver
{
    private const VALID_MODES = ['hard', 'soft', 'elastic'];

    /** @return array{mode:string, maxDelaySeconds:int} */
    public static function normalizeBoundary(mixed $boundary, string $blockId): array
    {
        $b = is_array($boundary) ? $boundary : [];
        $mode = is_string($b['mode'] ?? null) ? $b['mode'] : 'hard';
        if (!in_array($mode, self::VALID_MODES, true)) {
            throw new RuntimeException(
                "block \"$blockId\": boundary.mode \"$mode\" is invalid -- must be one of: " . implode(', ', self::VALID_MODES)
            );
        }
        $maxDelaySeconds = 0;
        if ($mode === 'soft' || $mode === 'elastic') {
            $raw = $b['max_delay'] ?? null;
            if ((!is_int($raw) && !is_float($raw)) || $raw < 0) {
                throw new RuntimeException(
                    "block \"$blockId\": boundary.max_delay must be a non-negative number of seconds when boundary.mode is \"$mode\"."
                );
            }
            $maxDelaySeconds = (int) $raw;
        }
        return ['mode' => $mode, 'maxDelaySeconds' => $maxDelaySeconds];
    }

    /**
     * @param list<array{
     *   blockId: string,
     *   boundary: array{mode:string, maxDelaySeconds:int},
     *   nominalStart: int,
     *   durationSeconds?: int,
     *   occurrenceId?: string,
     *   programTitle?: string,
     *   programDescription?: ?string,
     *   seriesId?: ?string,
     *   seriesTitle?: ?string,
     *   items: list<array{start:int,end:int,id:string,title:string,source:?array,source_url:?string}>,
     * }> $groups one entry per scheduled occurrence that actually has at least one item, across every block.
     *        The program* / occurrenceId / durationSeconds keys (Phase 2/3 of docs/
     *        guide-update.md) are optional so this class keeps working unchanged for
     *        any caller (tests included) that only ever built the pre-existing
     *        blockId/boundary/nominalStart/items shape.
     * @return array{items: list<array<string,mixed>>, warnings: list<string>, programs: list<array<string,mixed>>}
     */
    public static function resolve(array $groups): array
    {
        usort($groups, static fn (array $a, array $b): int => $a['nominalStart'] <=> $b['nominalStart']);

        $items = [];
        $programs = [];
        $warnings = [];
        $prevEnd = null;
        $prevLabel = null;

        foreach ($groups as $g) {
            if (!$g['items']) {
                continue;
            }
            $boundary = $g['boundary'];
            $groupStart = $g['items'][0]['start'];
            $delay = 0;

            if ($prevEnd !== null && $groupStart < $prevEnd) {
                $overlap = $prevEnd - $groupStart;
                if ($boundary['mode'] === 'hard') {
                    throw new RuntimeException(sprintf(
                        'Occurrence for block "%s" starting %s overlaps the previous occurrence ("%s"), which runs until '
                        . '%s (%d second(s) too long) -- its boundary.mode is "hard" and can never be pushed. Adjust '
                        . 'durations/recurrence timing, shorten the preceding block, or give this block a soft/elastic '
                        . 'boundary with enough max_delay to absorb the overrun. Publish refuses to emit an overlapping schedule.',
                        $g['blockId'], gmdate('c', $groupStart), $prevLabel, gmdate('c', $prevEnd), $overlap,
                    ));
                }
                if ($overlap > $boundary['maxDelaySeconds']) {
                    throw new RuntimeException(sprintf(
                        'Occurrence for block "%s" (boundary.mode=%s, max_delay=%ds) overlaps the previous occurrence '
                        . '("%s", runs until %s) by %d second(s) -- more than its configured max_delay can absorb. Raise '
                        . 'max_delay, shorten the preceding block, or reduce the drift some other way. Publish refuses to '
                        . 'emit an overlapping schedule.',
                        $g['blockId'], $boundary['mode'], $boundary['maxDelaySeconds'], $prevLabel, gmdate('c', $prevEnd), $overlap,
                    ));
                }
                $delay = $overlap;
                $warnings[] = sprintf(
                    'block "%s": occurrence delayed %d second(s) past its nominal start of %s (boundary.mode=%s, max_delay=%ds) '
                    . 'because the previous occurrence ran long.',
                    $g['blockId'], $delay, gmdate('c', $groupStart), $boundary['mode'], $boundary['maxDelaySeconds'],
                );
            }

            $occurrenceId = $g['occurrenceId'] ?? null;
            foreach ($g['items'] as $it) {
                $it['start'] += $delay;
                $it['end'] += $delay;
                if ($delay > 0) {
                    $it['delay_seconds'] = $delay;
                }
                if ($occurrenceId !== null) {
                    // Phase 3: every generated occurrence stays associated with its
                    // source programming block via this reference -- explicit identity,
                    // never re-derived later from adjacency or title matching.
                    $it['program_id'] = $occurrenceId;
                }
                $items[] = $it;
            }
            $prevEnd = $items[count($items) - 1]['end'];
            $prevLabel = $items[count($items) - 1]['id'];

            if ($occurrenceId !== null) {
                // Phase 4: the program's EFFECTIVE presentation window -- its nominal
                // slot, shifted by whatever delay (if any) this occurrence absorbed.
                // Phase 7: a hard-boundaried occurrence has delay 0, so this is simply
                // its intended slot; a soft/elastic one may legitimately run later than
                // nominal, and this is the boundary the EPG must actually draw to avoid
                // ever showing two cells overlapping.
                $durationSeconds = $g['durationSeconds'] ?? ($g['items'][count($g['items']) - 1]['end'] - $g['nominalStart']);
                // The nominal slot's end, shifted by this occurrence's own delay (if
                // any) -- the "intended" end. But packing.on_unfit=allow_overrun can
                // let an item's actual end run past that (EpisodePacker schedules the
                // unfit episode anyway rather than deferring it), and that is legal as
                // long as it didn't collide with the next occurrence above (or this
                // program would never have reached this line). $prevEnd is this
                // group's last item's real end, already shifted by $delay -- use
                // whichever is later so the EPG's presentation window actually covers
                // the content airing within it instead of understating it and leaving
                // a phantom gap while the overrun item is still playing.
                $nominalEndWithDelay = $g['nominalStart'] + $delay + $durationSeconds;
                $actualItemsEnd = $items[count($items) - 1]['end'];
                $effectiveEnd = max($nominalEndWithDelay, $actualItemsEnd);
                $programs[] = [
                    'occurrence_id' => $occurrenceId,
                    'block_id' => $g['blockId'],
                    'title' => $g['programTitle'] ?? null,
                    'description' => $g['programDescription'] ?? null,
                    'series_id' => $g['seriesId'] ?? null,
                    'series_title' => $g['seriesTitle'] ?? null,
                    'boundary_mode' => $boundary['mode'],
                    'nominal_start' => $g['nominalStart'],
                    'nominal_end' => $g['nominalStart'] + $durationSeconds,
                    'start' => $g['nominalStart'] + $delay,
                    'end' => $effectiveEnd,
                ];
            }
        }

        return ['items' => $items, 'warnings' => $warnings, 'programs' => $programs];
    }
}
