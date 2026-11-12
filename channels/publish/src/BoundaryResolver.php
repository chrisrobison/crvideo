<?php
declare(strict_types=1);

// channels/publish/src/BoundaryResolver.php
//
// A dedicated stage that decides what happens when one occurrence's content
// would run into the next one's nominal start, so overlap logic isn't
// scattered through ProgrammingCompiler. The compiler decides which episodes
// air when, per block, and groups them into "occurrence groups" (one per
// scheduled occurrence; a packing-enabled occurrence's items travel together
// because a boundary decision shifts a whole occurrence, never splits it).
// This class walks every block's groups together in chronological order and
// decides whether an overlap becomes an explicit, bounded delay or fails the
// whole publish.
//
// boundary.mode (per block; absent means "hard"):
//   - "hard" (default): the occurrence's nominal start is an immovable anchor.
//     If the previous occurrence's (possibly delayed) end runs past it,
//     publish refuses to emit anything.
//   - "soft": the occurrence may begin up to boundary.max_delay seconds after
//     its nominal start (required, non-negative: any delay must be explicit
//     and bounded). Every item shifts by the same delay, preserving relative
//     timing; the delay is recorded on each item (`delay_seconds`) and
//     reported in the publish warnings. An overlap bigger than max_delay is
//     refused.
//   - "elastic": deliberately simplified to behave exactly like "soft" (see
//     docs/series-and-channels.md for why pooled flexible windows across
//     consecutive blocks are deferred). It still respects the next hard
//     boundary and never allows unbounded drift, because it resolves the same
//     way "soft" does.
//
// Resolution never moves an occurrence earlier than its nominal start, never
// reorders occurrences, and is a single deterministic left-to-right walk in
// nominal-start order, so the same inputs always produce the same delays. It
// never looks at wall-clock "now": local-time recurrence semantics (DST
// included) are Recurrence's job and are already absolute instants here, and
// shifting an instant later by N seconds is elapsed-time arithmetic, which is
// correct for "the previous program ran N seconds long". Callers feed it one
// compile's own groups only, so previously published occurrences are never
// rewritten.

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
     *        The program* / occurrenceId / durationSeconds keys are optional so
     *        callers (tests included) can pass just blockId/boundary/nominalStart/items.
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
                    // Explicit identity: every occurrence stays associated with its source
                    // block via this reference, never re-derived from adjacency or titles.
                    $it['program_id'] = $occurrenceId;
                }
                $items[] = $it;
            }
            $prevEnd = $items[count($items) - 1]['end'];
            $prevLabel = $items[count($items) - 1]['id'];

            if ($occurrenceId !== null) {
                // The program's EFFECTIVE presentation window: its nominal slot shifted
                // by any delay this occurrence absorbed (0 for a hard boundary). A
                // soft/elastic occurrence may run later than nominal, and this is the
                // boundary the EPG must draw to avoid showing two overlapping cells.
                $durationSeconds = $g['durationSeconds'] ?? ($g['items'][count($g['items']) - 1]['end'] - $g['nominalStart']);
                // The nominal slot's end shifted by this occurrence's delay. But
                // packing.on_unfit=allow_overrun can let an item run past that (it's legal
                // if it didn't collide with the next occurrence above). $prevEnd is this
                // group's last item's real end, already shifted by $delay; use whichever
                // is later so the EPG window covers the content actually airing instead
                // of leaving a phantom gap during the overrun.
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
