<?php
declare(strict_types=1);

final class FillerSelectorTest
{
    private function library(): array
    {
        return [
            ['id' => 'clip-a', 'duration' => 10.0],
            ['id' => 'clip-b', 'duration' => 15.0],
            ['id' => 'clip-c', 'duration' => 20.0],
            ['id' => 'clip-d', 'duration' => 30.0],
        ];
    }

    public function testFillsGapWithoutExceedingIt(): void
    {
        $result = FillerSelector::fillGap(37.0, $this->library());
        Assert::true($result['used_seconds'] <= 37.0 + 1e-9);
        $sum = array_sum(array_map(static fn ($c) => $c['duration'], $result['chosen']));
        Assert::equalsFloat($result['used_seconds'], $sum);
    }

    public function testLeavesExplicitRemainingGap(): void
    {
        // 37 = 20 + 15 + 2 remaining (no clip is 2s), or similar -- just assert remaining is correct and non-negative.
        $result = FillerSelector::fillGap(37.0, $this->library());
        Assert::true($result['remaining'] >= 0);
        Assert::equalsFloat(37.0, $result['used_seconds'] + $result['remaining']);
    }

    public function testEmptyLibraryLeavesEntireGapAsRemaining(): void
    {
        $result = FillerSelector::fillGap(37.0, []);
        Assert::count(0, $result['chosen']);
        Assert::equalsFloat(37.0, $result['remaining']);
    }

    public function testAvoidsImmediateRepeatWhenAlternativeFits(): void
    {
        // Gap of 20 twice in a row: first call picks clip-c (20s exact fit).
        // Simulate a second gap right after with clip-c as "just used" --
        // an alternative combination (10+10 not available, but a 15+... )
        // Use a gap where both an exact repeat and a non-repeat option fit.
        $library = [
            ['id' => 'clip-a', 'duration' => 20.0],
            ['id' => 'clip-b', 'duration' => 20.0],
        ];
        $recentlyUsed = ['clip-a'];
        $result = FillerSelector::fillGap(20.0, $library, $recentlyUsed);
        Assert::count(1, $result['chosen']);
        Assert::same('clip-b', $result['chosen'][0]['id'], 'should prefer the non-repeat clip when it fits equally well');
    }

    public function testNeverExceedsBlockDurationWhenAppliedToBlocks(): void
    {
        $blocks = [
            [
                'type' => 'normal',
                'block' => 1,
                'duration' => 1800.0,
                'used' => 1770.0,
                'remaining' => 30.0,
                'items' => [['type' => 'video', 'id' => 'f1', 'start' => 0.0, 'duration' => 1770.0]],
            ],
        ];
        $result = FillerSelector::applyToBlocks($blocks, $this->library());
        $total = 0.0;
        foreach ($result[0]['items'] as $it) {
            $total += $it['duration'];
        }
        Assert::true($total <= 1800.0 + 1e-6);
        Assert::equalsFloat(1800.0, $total, 0.01, 'filler + gap should account for the entire block');
    }

    public function testRemainingGapIsExplicitGapEventNotSynthesizedVideo(): void
    {
        $blocks = [
            [
                'type' => 'normal',
                'block' => 1,
                'duration' => 1800.0,
                'used' => 1799.0,
                'remaining' => 1.0, // nothing in the library is this short
                'items' => [['type' => 'video', 'id' => 'f1', 'start' => 0.0, 'duration' => 1799.0]],
            ],
        ];
        $result = FillerSelector::applyToBlocks($blocks, $this->library());
        $last = end($result[0]['items']);
        Assert::same('gap', $last['type']);
        Assert::equalsFloat(1.0, $last['duration']);
    }

    public function testOverflowBlocksAreUntouched(): void
    {
        $blocks = [
            [
                'type' => 'overflow',
                'block' => 1,
                'duration' => 4000.0,
                'used' => 4000.0,
                'remaining' => 0.0,
                'items' => [['type' => 'video', 'id' => 'huge', 'start' => 0.0, 'duration' => 4000.0]],
            ],
        ];
        $result = FillerSelector::applyToBlocks($blocks, $this->library());
        Assert::count(1, $result[0]['items']);
    }
}
