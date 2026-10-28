<?php
declare(strict_types=1);

// ia-import/src/FillerSelector.php
//
// Picks short filler clips (station IDs, bumpers, PSAs, shorts) to close
// the gap left at the end of a block after the main schedule is built.
// IA-agnostic, like ScheduleOptimizer: operates on generic filler items
// (id, duration, optional 'title').
//
// Rules enforced here:
//  - never exceeds the gap it's asked to fill (so never exceeds the block)
//  - filler repeats are allowed, but the same clip is avoided back-to-back
//    (and within a configurable recent-window) whenever an alternative fits
//  - any time left over after filling is returned to the caller, which must
//    emit it as an explicit 'gap' event -- filler never synthesizes blank
//    video to cover the remainder.

final class FillerSelector
{
    /**
     * @param list<array{id:string,duration:float,title?:string}> $library
     * @param list<string> $recentlyUsed Most-recently-used filler ids first.
     * @param array{recent_window?: int, max_candidates?: int} $options
     * @return array{chosen: list<array{id:string,duration:float}>, used_seconds: float, remaining: float}
     */
    public static function fillGap(float $gapSeconds, array $library, array $recentlyUsed = [], array $options = []): array
    {
        if (!$library || $gapSeconds <= 0.01) {
            return ['chosen' => [], 'used_seconds' => 0.0, 'remaining' => max(0.0, $gapSeconds)];
        }

        $recentWindow = (int) ($options['recent_window'] ?? 5);
        $recent = array_slice($recentlyUsed, 0, $recentWindow);

        // Deterministic candidate order: sort by id so results never depend
        // on input array order or hash iteration order.
        $sorted = $library;
        usort($sorted, static fn (array $a, array $b): int => strcmp((string) $a['id'], (string) $b['id']));

        $chosen = [];
        $remaining = $gapSeconds;
        $lastChosenId = $recentlyUsed[0] ?? null;

        // Greedy best-fit over clips, repeated until nothing more fits or a
        // small bounded number of picks has been made (closing a 15-60
        // minute gap with 10s bumpers should not take unbounded clips).
        $maxPicks = (int) ($options['max_picks'] ?? 20);
        for ($pick = 0; $pick < $maxPicks && $remaining > 0.01; $pick++) {
            $best = null;
            $bestRemainder = INF;
            foreach ($sorted as $clip) {
                $d = (float) $clip['duration'];
                if ($d <= 0 || $d > $remaining + 1e-9) {
                    continue;
                }
                $isRepeatOfLast = $lastChosenId !== null && $clip['id'] === $lastChosenId;
                $isOverusedRecently = in_array($clip['id'], $recent, true);
                $remainder = $remaining - $d;
                // Prefer the tightest fit; among equally tight fits, prefer
                // a clip that isn't a repeat of the very last one, then one
                // that hasn't been used in the recent window, then lowest id
                // (determinism).
                $penalty = ($isRepeatOfLast ? 1_000_000.0 : 0.0) + ($isOverusedRecently ? 1_000.0 : 0.0);
                $score = $remainder + $penalty;
                if ($score < $bestRemainder) {
                    $bestRemainder = $score;
                    $best = $clip;
                }
            }
            if ($best === null) {
                break;
            }
            // If the only fitting option is a repeat of the last pick AND
            // there is any alternative at all in the library that fits a
            // *smaller* remaining budget, we still take it: avoiding repeats
            // is a soft preference, not at the cost of leaving a fillable
            // gap open.
            $chosen[] = ['id' => $best['id'], 'duration' => (float) $best['duration']];
            $remaining -= (float) $best['duration'];
            $lastChosenId = $best['id'];
            array_unshift($recent, $best['id']);
            $recent = array_slice($recent, 0, max(1, $recentWindow));
        }

        $used = $gapSeconds - $remaining;
        return ['chosen' => $chosen, 'used_seconds' => $used, 'remaining' => max(0.0, $remaining)];
    }

    /**
     * Applies filler to every block in-place-style (returns a new blocks
     * array): appends chosen filler 'type' => 'filler' items after the last
     * video item, then an explicit 'gap' item for whatever (if anything) is
     * still left. Oversized/overflow-type blocks are left untouched.
     *
     * @param list<array<string,mixed>> $blocks
     * @param list<array{id:string,duration:float,title?:string}> $library
     * @return list<array<string,mixed>>
     */
    public static function applyToBlocks(array $blocks, array $library, array $options = []): array
    {
        $recentlyUsed = [];
        foreach ($blocks as &$block) {
            if (($block['type'] ?? 'normal') !== 'normal') {
                continue;
            }
            $remaining = (float) $block['remaining'];
            if ($remaining <= 0.01) {
                continue;
            }
            // fillGap() degrades gracefully to "nothing chosen" when the
            // library is empty, so this method doubles as "add an explicit
            // gap event to every underfilled block" when --filler wasn't
            // passed at all.
            $result = self::fillGap($remaining, $library, $recentlyUsed, $options);
            $start = (float) $block['used'];
            foreach ($result['chosen'] as $clip) {
                $block['items'][] = [
                    'type' => 'filler',
                    'id' => $clip['id'],
                    'start' => $start,
                    'duration' => $clip['duration'],
                ];
                $start += $clip['duration'];
                array_unshift($recentlyUsed, $clip['id']);
            }
            $block['used'] = $start;
            $block['remaining'] = (float) $block['duration'] - $start;
            if ($block['remaining'] > 0.01) {
                $block['items'][] = [
                    'type' => 'gap',
                    'start' => $start,
                    'duration' => $block['remaining'],
                ];
            } else {
                $block['remaining'] = max(0.0, $block['remaining']);
            }
        }
        unset($block);
        return $blocks;
    }
}
