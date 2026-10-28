<?php
declare(strict_types=1);

// ia-import/src/ScheduleOptimizer.php
//
// IMPORTANT: this class knows nothing about Internet Archive. It packs
// generic items -- plain arrays with at least 'id' (string), 'duration'
// (float seconds or null) and 'original_position' (number, used only for
// tie-breaking/ordering) -- into fixed-length blocks. This independence is
// intentional (see README) so the same engine can later be reused for
// CRVideo's own channel/playlist scheduling, not just IA imports.
//
// Optional per-item hint fields used only by the "balanced" strategy's
// variety scoring: 'subjects' (list<string>), 'collections' (list<string>),
// 'creator' (string|null).
//
// Guarantees upheld by every strategy:
//  - every input item appears in exactly one of: a normal block, an
//    overflow block, or the unscheduled list -- never zero, never two.
//  - no normal block's used time ever exceeds slot_seconds.
//  - output is fully deterministic for the same input + options (no RNG).

final class ScheduleOptimizer
{
    private const VALID_STRATEGIES = ['sequential', 'best-fit', 'balanced'];
    private const VALID_OVERSIZED_POLICIES = ['overflow', 'exclude', 'split'];

    private int $slotSeconds;
    private string $strategy;
    /** @var array<string,mixed> */
    private array $options;

    public function __construct(int $slotSeconds, string $strategy = 'balanced', array $options = [])
    {
        if ($slotSeconds <= 0) {
            throw new InvalidArgumentException('slotSeconds must be positive.');
        }
        if (!in_array($strategy, self::VALID_STRATEGIES, true)) {
            throw new InvalidArgumentException("Unknown strategy: $strategy");
        }
        $policy = $options['oversized_policy'] ?? 'overflow';
        if (!in_array($policy, self::VALID_OVERSIZED_POLICIES, true)) {
            throw new InvalidArgumentException("Unknown oversized policy: $policy");
        }
        if ($policy === 'split') {
            throw new InvalidArgumentException(
                'Oversized policy "split" is reserved for future use and is not implemented. ' .
                'Use "overflow" (default) or "exclude".'
            );
        }

        $this->slotSeconds = $slotSeconds;
        $this->strategy = $strategy;
        $this->options = $options;
    }

    /**
     * @param list<array<string,mixed>> $items
     * @return array{blocks: list<array<string,mixed>>, unscheduled: list<array<string,mixed>>, oversized_count: int, warnings: list<string>, violations: list<string>}
     */
    public function optimize(array $items): array
    {
        $policy = $this->options['oversized_policy'] ?? 'overflow';

        $normal = [];
        $oversized = [];
        $unscheduled = [];
        $warnings = [];

        foreach ($items as $item) {
            $duration = $item['duration'] ?? null;
            if ($duration === null) {
                $unscheduled[] = $item + ['reason' => 'unknown_duration'];
                continue;
            }
            $duration = (float) $duration;
            if ($duration <= 0) {
                $unscheduled[] = $item + ['reason' => 'invalid_duration'];
                continue;
            }
            if ($duration > $this->slotSeconds + 1e-9) {
                if ($policy === 'exclude') {
                    $unscheduled[] = $item + ['reason' => 'oversized_excluded'];
                } else {
                    $oversized[] = $item;
                }
                continue;
            }
            $normal[] = $item;
        }

        usort($normal, static fn (array $a, array $b): int => $a['original_position'] <=> $b['original_position']);

        $bins = match ($this->strategy) {
            'sequential' => $this->packSequentialRaw($normal),
            'best-fit' => $this->packBestFit($normal),
            'balanced' => $this->packBalanced($normal),
        };

        $blocks = array_map(fn (array $bin): array => $this->finalizeBlock($bin), $bins);
        foreach ($blocks as &$b) {
            $b['type'] = 'normal';
        }
        unset($b);

        $oversizedBlocks = [];
        foreach ($oversized as $item) {
            $duration = (float) $item['duration'];
            $oversizedBlocks[] = [
                'type' => 'overflow',
                'duration' => $duration,
                'used' => $duration,
                'remaining' => 0.0,
                'items' => [[
                    'type' => 'video',
                    'id' => $item['id'],
                    'start' => 0.0,
                    'duration' => $duration,
                    'original_position' => $item['original_position'],
                ]],
            ];
            $warnings[] = "{$item['id']}: duration {$duration}s exceeds the {$this->slotSeconds}s slot; " .
                'placed in a dedicated overflow block (--oversized=exclude to omit instead).';
        }

        $allBlocks = array_merge($blocks, $oversizedBlocks);
        $blockNumber = 0;
        foreach ($allBlocks as &$b) {
            $blockNumber++;
            $b['block'] = $blockNumber;
        }
        unset($b);

        $violations = $this->computeMaxShiftViolations($allBlocks);

        return [
            'blocks' => $allBlocks,
            'unscheduled' => $unscheduled,
            'oversized_count' => count($oversized),
            'warnings' => $warnings,
            'violations' => $violations,
        ];
    }

    // ---- Strategy A: sequential -------------------------------------------------

    /** @return list<array{items: list<array<string,mixed>>, used: float}> */
    private function packSequentialRaw(array $items): array
    {
        $bins = [];
        $current = ['items' => [], 'used' => 0.0];
        foreach ($items as $item) {
            $duration = (float) $item['duration'];
            if ($current['items'] && $current['used'] + $duration > $this->slotSeconds + 1e-9) {
                $bins[] = $current;
                $current = ['items' => [], 'used' => 0.0];
            }
            $current['items'][] = $item;
            $current['used'] += $duration;
        }
        if ($current['items']) {
            $bins[] = $current;
        }
        return $bins;
    }

    // ---- Strategy B: best-fit-decreasing + bounded local search -----------------

    /** @return list<array{items: list<array<string,mixed>>, used: float}> */
    private function packBestFit(array $items): array
    {
        $sorted = $items;
        usort($sorted, fn (array $a, array $b): int => [(float) $b['duration'], $a['original_position']] <=> [(float) $a['duration'], $b['original_position']]);

        $bins = [];
        foreach ($sorted as $item) {
            $duration = (float) $item['duration'];
            $bestIdx = null;
            $bestRemaining = INF;
            foreach ($bins as $idx => $bin) {
                $remaining = $this->slotSeconds - $bin['used'];
                if ($duration <= $remaining + 1e-9 && $remaining < $bestRemaining) {
                    $bestIdx = $idx;
                    $bestRemaining = $remaining;
                }
            }
            if ($bestIdx === null) {
                $bins[] = ['items' => [$item], 'used' => $duration];
            } else {
                $bins[$bestIdx]['items'][] = $item;
                $bins[$bestIdx]['used'] += $duration;
            }
        }

        $budget = (int) ($this->options['budget'] ?? 4000);
        [$bins, $used] = $this->consolidateBins($bins, $budget);
        $bins = $this->localSearchSwap($bins, max(0, $budget - $used));

        foreach ($bins as &$bin) {
            usort($bin['items'], fn (array $a, array $b): int => $a['original_position'] <=> $b['original_position']);
        }
        return $bins;
    }

    /**
     * Note on why this exists: swapping single items between two blocks
     * never changes the *combined* used time of that pair (and so never
     * changes total unused time) unless a block empties out completely --
     * total unused time across a fixed number of blocks is just
     * block_count * slot - total_content, a constant until a block is
     * removed. So the only way local search can actually shrink total
     * unused time is by eliminating a block entirely. This pass does
     * exactly that: repeatedly finds the least-full remaining block and
     * tries to redistribute every one of its items into the other blocks
     * (first-fit, preferring the tightest resulting fit); if the whole
     * block empties out, it's dropped. Bounded by $budget iterations
     * (one per item-placement attempt) so it terminates predictably.
     *
     * @param ?\Closure $moveAllowed function(array $item, int $targetBinIndex): bool: optional extra gate (used by
     *                                 the balanced strategy to keep moves inside --max-shift).
     * @return array{0: list<array{items: list<array<string,mixed>>, used: float}>, 1: int} [bins, iterationsUsed]
     */
    private function consolidateBins(array $bins, int $budget, ?\Closure $moveAllowed = null): array
    {
        $iterations = 0;
        $eliminatedAny = true;
        while ($eliminatedAny && $iterations < $budget) {
            $eliminatedAny = false;
            $order = array_keys($bins);
            usort($order, fn (int $a, int $b): int => $bins[$a]['used'] <=> $bins[$b]['used'] ?: $a <=> $b);

            foreach ($order as $idx) {
                if ($iterations >= $budget || !isset($bins[$idx]) || !$bins[$idx]['items']) {
                    continue;
                }
                $capacity = [];
                foreach ($bins as $oidx => $ob) {
                    if ($oidx !== $idx) {
                        $capacity[$oidx] = $ob['used'];
                    }
                }
                $plan = [];
                $ok = true;
                foreach ($bins[$idx]['items'] as $item) {
                    $iterations++;
                    if ($iterations >= $budget) {
                        $ok = false;
                        break;
                    }
                    $duration = (float) $item['duration'];
                    $bestOidx = null;
                    $bestRemaining = INF;
                    foreach ($capacity as $oidx => $used) {
                        $remaining = $this->slotSeconds - $used;
                        if ($duration > $remaining + 1e-9 || $remaining >= $bestRemaining) {
                            continue;
                        }
                        if ($moveAllowed !== null && !$moveAllowed($item, $oidx)) {
                            continue;
                        }
                        $bestOidx = $oidx;
                        $bestRemaining = $remaining;
                    }
                    if ($bestOidx === null) {
                        $ok = false;
                        break;
                    }
                    $plan[] = ['item' => $item, 'target' => $bestOidx];
                    $capacity[$bestOidx] += $duration;
                }
                if (!$ok) {
                    continue;
                }
                foreach ($plan as $p) {
                    $bins[$p['target']]['items'][] = $p['item'];
                    $bins[$p['target']]['used'] += (float) $p['item']['duration'];
                }
                unset($bins[$idx]);
                $eliminatedAny = true;
                break; // bin indices/capacities are stale now -- restart the scan
            }
        }
        return [array_values($bins), $iterations];
    }

    /**
     * Deterministic bounded local search: scans block pairs and item pairs
     * in a fixed nested order (no randomness) and accepts a swap whenever it
     * strictly reduces total slack across the pair. Terminates either when
     * no improving swap is found or the iteration budget is exhausted,
     * whichever comes first -- this is what keeps it predictable on large
     * lists.
     */
    private function localSearchSwap(array $bins, int $budget): array
    {
        $n = count($bins);
        $iterations = 0;
        $improved = true;
        while ($improved && $iterations < $budget) {
            $improved = false;
            for ($i = 0; $i < $n && $iterations < $budget; $i++) {
                for ($j = $i + 1; $j < $n && $iterations < $budget; $j++) {
                    foreach ($bins[$i]['items'] as $ii => $itemA) {
                        if ($iterations >= $budget) {
                            break;
                        }
                        foreach ($bins[$j]['items'] as $jj => $itemB) {
                            $iterations++;
                            if ($iterations >= $budget) {
                                break;
                            }
                            $durA = (float) $itemA['duration'];
                            $durB = (float) $itemB['duration'];
                            $newUsedA = $bins[$i]['used'] - $durA + $durB;
                            $newUsedB = $bins[$j]['used'] - $durB + $durA;
                            if ($newUsedA > $this->slotSeconds + 1e-9 || $newUsedB > $this->slotSeconds + 1e-9) {
                                continue;
                            }
                            $before = abs($this->slotSeconds - $bins[$i]['used']) + abs($this->slotSeconds - $bins[$j]['used']);
                            $after = abs($this->slotSeconds - $newUsedA) + abs($this->slotSeconds - $newUsedB);
                            if ($after < $before - 1e-9) {
                                $bins[$i]['items'][$ii] = $itemB;
                                $bins[$j]['items'][$jj] = $itemA;
                                $bins[$i]['used'] = $newUsedA;
                                $bins[$j]['used'] = $newUsedB;
                                $improved = true;
                            }
                        }
                    }
                }
            }
        }
        return $bins;
    }

    // ---- Strategy C: balanced (default) -----------------------------------------

    /**
     * Starts from the sequential (order-preserving) packing and runs a
     * bounded, deterministic local search that accepts a swap only when it
     * improves a weighted score of: slack (unused time), a per-pair
     * "variety" penalty (shared creator/subject/collection, or two very
     * short films sharing a block), and a movement penalty (how far a
     * swapped item has already drifted from the block sequential packing
     * would have put it in). --max-shift is enforced here by simply
     * refusing any swap that would push an item's block-level drift beyond
     * the configured limit; see computeMaxShiftViolations() for the exact
     * (item-level, not block-level) measure reported at the end.
     *
     * Known simplification: the mandatory consolidation pass below (which
     * collapses nearly-empty blocks -- see consolidateBins()) runs
     * *before* --max-shift starts being enforced, i.e. it is not itself
     * constrained by --max-shift. Treating block consolidation as
     * unconstrained keeps the implementation tractable: without it,
     * "retain order" and "don't leave a block almost entirely empty" can
     * be flatly incompatible, and consolidation is what the sequential
     * baseline would have needed anyway to avoid that. --max-shift instead
     * governs the swap-refinement phase that follows, measured against
     * this post-consolidation arrangement as the new baseline.
     */
    private function packBalanced(array $items): array
    {
        $bins = $this->packSequentialRaw($items);
        $budget = (int) ($this->options['budget'] ?? 3000);
        [$bins, $consolidateIterations] = $this->consolidateBins($bins, intdiv($budget, 2));

        /** @var array<string,int> */
        $baselineBlockIndex = [];
        foreach ($bins as $bi => $bin) {
            foreach ($bin['items'] as $it) {
                $baselineBlockIndex[$it['id']] = $bi;
            }
        }
        $currentBlockIndex = $baselineBlockIndex;

        $weights = array_merge(
            ['unused' => 1.0, 'movement' => 2.0, 'variety' => 8.0, 'short_adjacent' => 4.0],
            is_array($this->options['weights'] ?? null) ? $this->options['weights'] : []
        );
        $maxShift = isset($this->options['max_shift']) ? (int) $this->options['max_shift'] : null;
        $budget = max(0, $budget - $consolidateIterations);

        $n = count($bins);
        $iterations = 0;
        $improved = true;
        while ($improved && $iterations < $budget) {
            $improved = false;
            for ($i = 0; $i < $n && $iterations < $budget; $i++) {
                for ($j = $i + 1; $j < $n && $iterations < $budget; $j++) {
                    foreach ($bins[$i]['items'] as $ii => $itemA) {
                        if ($iterations >= $budget) {
                            break;
                        }
                        foreach ($bins[$j]['items'] as $jj => $itemB) {
                            $iterations++;
                            if ($iterations >= $budget) {
                                break;
                            }

                            $durA = (float) $itemA['duration'];
                            $durB = (float) $itemB['duration'];
                            $newUsedA = $bins[$i]['used'] - $durA + $durB;
                            $newUsedB = $bins[$j]['used'] - $durB + $durA;
                            if ($newUsedA > $this->slotSeconds + 1e-9 || $newUsedB > $this->slotSeconds + 1e-9) {
                                continue;
                            }

                            if ($maxShift !== null) {
                                $shiftA = abs($baselineBlockIndex[$itemB['id']] - $i);
                                $shiftB = abs($baselineBlockIndex[$itemA['id']] - $j);
                                if ($shiftA > $maxShift || $shiftB > $maxShift) {
                                    continue;
                                }
                            }

                            $before = $weights['unused'] * (abs($this->slotSeconds - $bins[$i]['used']) + abs($this->slotSeconds - $bins[$j]['used']))
                                + $this->binPenalty($bins[$i]['items'], $weights)
                                + $this->binPenalty($bins[$j]['items'], $weights)
                                + $weights['movement'] * (
                                    abs($currentBlockIndex[$itemA['id']] - $baselineBlockIndex[$itemA['id']])
                                    + abs($currentBlockIndex[$itemB['id']] - $baselineBlockIndex[$itemB['id']])
                                );

                            $trialItemsI = $bins[$i]['items'];
                            $trialItemsJ = $bins[$j]['items'];
                            $trialItemsI[$ii] = $itemB;
                            $trialItemsJ[$jj] = $itemA;

                            $after = $weights['unused'] * (abs($this->slotSeconds - $newUsedA) + abs($this->slotSeconds - $newUsedB))
                                + $this->binPenalty($trialItemsI, $weights)
                                + $this->binPenalty($trialItemsJ, $weights)
                                + $weights['movement'] * (
                                    abs($j - $baselineBlockIndex[$itemA['id']])
                                    + abs($i - $baselineBlockIndex[$itemB['id']])
                                );

                            if ($after < $before - 1e-9) {
                                $bins[$i]['items'] = $trialItemsI;
                                $bins[$j]['items'] = $trialItemsJ;
                                $bins[$i]['used'] = $newUsedA;
                                $bins[$j]['used'] = $newUsedB;
                                $currentBlockIndex[$itemA['id']] = $j;
                                $currentBlockIndex[$itemB['id']] = $i;
                                $improved = true;
                            }
                        }
                    }
                }
            }
        }

        foreach ($bins as &$bin) {
            usort($bin['items'], fn (array $a, array $b): int => $a['original_position'] <=> $b['original_position']);
        }
        return $bins;
    }

    /** Pairwise "feels repetitive" / "two shorts back to back" penalty for one block's current item set. */
    private function binPenalty(array $items, array $weights): float
    {
        $n = count($items);
        $penalty = 0.0;
        for ($a = 0; $a < $n; $a++) {
            for ($b = $a + 1; $b < $n; $b++) {
                $x = $items[$a];
                $y = $items[$b];
                $overlap = false;
                if (!empty($x['creator']) && !empty($y['creator']) && $x['creator'] === $y['creator']) {
                    $overlap = true;
                }
                if (!$overlap && array_intersect($x['subjects'] ?? [], $y['subjects'] ?? [])) {
                    $overlap = true;
                }
                if (!$overlap && array_intersect($x['collections'] ?? [], $y['collections'] ?? [])) {
                    $overlap = true;
                }
                if ($overlap) {
                    $penalty += $weights['variety'];
                }
                if ((float) $x['duration'] < $this->slotSeconds * 0.15 && (float) $y['duration'] < $this->slotSeconds * 0.15) {
                    $penalty += $weights['short_adjacent'];
                }
            }
        }
        return $penalty;
    }

    // ---- shared block finalization ----------------------------------------------

    private function finalizeBlock(array $bin): array
    {
        $start = 0.0;
        $outItems = [];
        foreach ($bin['items'] as $it) {
            $duration = (float) $it['duration'];
            $outItems[] = [
                'type' => 'video',
                'id' => $it['id'],
                'start' => $start,
                'duration' => $duration,
                'original_position' => $it['original_position'],
            ];
            $start += $duration;
        }
        $used = $start;
        return [
            'duration' => (float) $this->slotSeconds,
            'used' => $used,
            'remaining' => $this->slotSeconds - $used,
            'items' => $outItems,
        ];
    }

    /**
     * Exact (item-level) positional-shift measure, computed once on the
     * final arrangement: for each scheduled normal-block item, how far its
     * emitted order (block order, then start-time order) is from the rank
     * it would have under pure original-list order. Reported, not
     * enforced retroactively -- the search above already tries to respect
     * --max-shift going forward via a cheaper block-level proxy.
     */
    private function computeMaxShiftViolations(array $allBlocks): array
    {
        $maxShift = isset($this->options['max_shift']) ? (int) $this->options['max_shift'] : null;
        if ($maxShift === null) {
            return [];
        }

        $flattened = [];
        foreach ($allBlocks as $block) {
            if (($block['type'] ?? 'normal') !== 'normal') {
                continue;
            }
            foreach ($block['items'] as $it) {
                if ($it['type'] === 'video') {
                    $flattened[] = $it;
                }
            }
        }
        if (!$flattened) {
            return [];
        }

        $byOriginal = $flattened;
        usort($byOriginal, static fn (array $a, array $b): int => $a['original_position'] <=> $b['original_position']);
        $baselineRank = [];
        foreach ($byOriginal as $idx => $it) {
            $baselineRank[$it['id']] = $idx;
        }

        $violations = [];
        foreach ($flattened as $idx => $it) {
            $shift = abs($idx - $baselineRank[$it['id']]);
            if ($shift > $maxShift) {
                $violations[] = "{$it['id']}: shifted $shift position(s) from original order (max-shift is $maxShift)";
            }
        }
        return $violations;
    }
}
