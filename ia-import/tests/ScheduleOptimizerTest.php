<?php
declare(strict_types=1);

final class ScheduleOptimizerTest
{
    private function flattenVideoIds(array $blocks): array
    {
        $ids = [];
        foreach ($blocks as $b) {
            foreach ($b['items'] as $it) {
                if ($it['type'] === 'video') {
                    $ids[] = $it['id'];
                }
            }
        }
        return $ids;
    }

    public function testSequentialPreservesOrderAndNeverExceedsSlot(): void
    {
        $items = [
            ['id' => 'a', 'duration' => 1000.0, 'original_position' => 1],
            ['id' => 'b', 'duration' => 1000.0, 'original_position' => 2],
            ['id' => 'c', 'duration' => 500.0, 'original_position' => 3],
            ['id' => 'd', 'duration' => 500.0, 'original_position' => 4],
        ];
        $opt = new ScheduleOptimizer(1800, 'sequential');
        $r = $opt->optimize($items);
        Assert::same(['a', 'b', 'c', 'd'], $this->flattenVideoIds($r['blocks']));
        foreach ($r['blocks'] as $b) {
            Assert::true($b['used'] <= $b['duration'] + 1e-9, 'block used time must never exceed its duration');
        }
    }

    public function testSequentialLeavesMateriallyLargerGapThanBestFitAndBalanced(): void
    {
        $items = [
            ['id' => 'a', 'duration' => 1000.0, 'original_position' => 1],
            ['id' => 'b', 'duration' => 1000.0, 'original_position' => 2],
            ['id' => 'c', 'duration' => 500.0, 'original_position' => 3],
            ['id' => 'd', 'duration' => 500.0, 'original_position' => 4],
        ];

        $unusedByStrategy = [];
        foreach (['sequential', 'best-fit', 'balanced'] as $strategy) {
            $opt = new ScheduleOptimizer(1800, $strategy);
            $r = $opt->optimize($items);
            $unused = 0.0;
            foreach ($r['blocks'] as $b) {
                if ($b['type'] === 'normal') {
                    $unused += $b['remaining'];
                }
            }
            $unusedByStrategy[$strategy] = $unused;
        }

        Assert::equalsFloat(2400.0, $unusedByStrategy['sequential']);
        Assert::true(
            $unusedByStrategy['best-fit'] < $unusedByStrategy['sequential'] * 0.5,
            'best-fit should leave a materially smaller gap than sequential'
        );
        Assert::true(
            $unusedByStrategy['balanced'] < $unusedByStrategy['sequential'] * 0.5,
            'balanced should leave a materially smaller gap than sequential'
        );
    }

    public function testNoDroppedOrDuplicatedEntries(): void
    {
        $items = [];
        for ($i = 1; $i <= 25; $i++) {
            $items[] = ['id' => "film-$i", 'duration' => (float) (200 + ($i % 7) * 100), 'original_position' => $i];
        }
        foreach (['sequential', 'best-fit', 'balanced'] as $strategy) {
            $opt = new ScheduleOptimizer(1800, $strategy);
            $r = $opt->optimize($items);
            $ids = $this->flattenVideoIds($r['blocks']);
            Assert::count(25, $ids, "[$strategy] every item must be scheduled exactly once");
            Assert::count(25, array_unique($ids), "[$strategy] no item must be duplicated");
        }
    }

    public function testUnknownDurationItemsAreUnscheduledNotDropped(): void
    {
        $items = [
            ['id' => 'known', 'duration' => 100.0, 'original_position' => 1],
            ['id' => 'unknown', 'duration' => null, 'original_position' => 2],
        ];
        $opt = new ScheduleOptimizer(1800, 'sequential');
        $r = $opt->optimize($items);
        Assert::count(1, $r['unscheduled']);
        Assert::same('unknown', $r['unscheduled'][0]['id']);
        Assert::same('unknown_duration', $r['unscheduled'][0]['reason']);
    }

    public function testFilmExactlyMatchingSlotFillsItCompletely(): void
    {
        $items = [['id' => 'exact', 'duration' => 1800.0, 'original_position' => 1]];
        $opt = new ScheduleOptimizer(1800, 'sequential');
        $r = $opt->optimize($items);
        Assert::count(1, $r['blocks']);
        Assert::equalsFloat(0.0, $r['blocks'][0]['remaining']);
        Assert::equalsFloat(1800.0, $r['blocks'][0]['used']);
    }

    public function testOversizedFilmDefaultsToDedicatedOverflowBlock(): void
    {
        $items = [
            ['id' => 'normal', 'duration' => 100.0, 'original_position' => 1],
            ['id' => 'huge', 'duration' => 4000.0, 'original_position' => 2],
        ];
        $opt = new ScheduleOptimizer(1800, 'sequential');
        $r = $opt->optimize($items);
        Assert::same(1, $r['oversized_count']);
        $overflow = array_values(array_filter($r['blocks'], static fn ($b) => $b['type'] === 'overflow'));
        Assert::count(1, $overflow);
        Assert::equalsFloat(4000.0, $overflow[0]['duration'], 0.01, 'overflow block must be sized to the film, not the slot');
        Assert::equalsFloat(0.0, $overflow[0]['remaining']);
        Assert::count(0, $r['unscheduled']);
    }

    public function testOversizedFilmExcludedWhenPolicyIsExclude(): void
    {
        $items = [['id' => 'huge', 'duration' => 4000.0, 'original_position' => 1]];
        $opt = new ScheduleOptimizer(1800, 'sequential', ['oversized_policy' => 'exclude']);
        $r = $opt->optimize($items);
        Assert::same(0, $r['oversized_count']);
        Assert::count(1, $r['unscheduled']);
        Assert::same('oversized_excluded', $r['unscheduled'][0]['reason']);
    }

    public function testSplitPolicyIsRejected(): void
    {
        $threw = false;
        try {
            new ScheduleOptimizer(1800, 'sequential', ['oversized_policy' => 'split']);
        } catch (InvalidArgumentException $e) {
            $threw = true;
        }
        Assert::true($threw, '--oversized=split must be explicitly rejected, not silently accepted');
    }

    public function testUnknownStrategyIsRejected(): void
    {
        $threw = false;
        try {
            new ScheduleOptimizer(1800, 'not-a-real-strategy');
        } catch (InvalidArgumentException $e) {
            $threw = true;
        }
        Assert::true($threw);
    }

    public function testDeterministicOutputForSameInputAndSettings(): void
    {
        $items = [];
        for ($i = 1; $i <= 40; $i++) {
            $items[] = ['id' => "film-$i", 'duration' => (float) (150 + ($i * 37) % 900), 'original_position' => $i];
        }
        foreach (['sequential', 'best-fit', 'balanced'] as $strategy) {
            $opt1 = new ScheduleOptimizer(1800, $strategy);
            $r1 = $opt1->optimize($items);
            $opt2 = new ScheduleOptimizer(1800, $strategy);
            $r2 = $opt2->optimize($items);
            Assert::same(json_encode($r1['blocks']), json_encode($r2['blocks']), "[$strategy] identical input+settings must produce identical output");
        }
    }

    public function testNoBlockExceedsSlotDurationAcrossStrategies(): void
    {
        $items = [];
        for ($i = 1; $i <= 30; $i++) {
            $items[] = ['id' => "film-$i", 'duration' => (float) (100 + ($i % 11) * 150), 'original_position' => $i];
        }
        foreach (['sequential', 'best-fit', 'balanced'] as $strategy) {
            $opt = new ScheduleOptimizer(900, $strategy);
            $r = $opt->optimize($items);
            foreach ($r['blocks'] as $b) {
                if ($b['type'] === 'normal') {
                    Assert::true($b['used'] <= $b['duration'] + 1e-6, "[$strategy] block {$b['block']} exceeded its slot duration");
                }
            }
        }
    }

    public function testFilmsThatCannotPerfectlyFillAnySlotStillScheduleCleanly(): void
    {
        // Durations deliberately chosen so no combination sums exactly to 900.
        $items = [
            ['id' => 'x1', 'duration' => 333.0, 'original_position' => 1],
            ['id' => 'x2', 'duration' => 333.0, 'original_position' => 2],
            ['id' => 'x3', 'duration' => 333.0, 'original_position' => 3],
        ];
        $opt = new ScheduleOptimizer(900, 'balanced');
        $r = $opt->optimize($items);
        $ids = $this->flattenVideoIds($r['blocks']);
        Assert::count(3, $ids);
        foreach ($r['blocks'] as $b) {
            Assert::true($b['remaining'] >= 0, 'remaining must never be negative (no silent truncation)');
        }
    }
}
