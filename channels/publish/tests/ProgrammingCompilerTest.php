<?php
declare(strict_types=1);

final class ProgrammingCompilerTest
{
    private string $stateDir;

    public function setUp(): void
    {
        $this->stateDir = sys_get_temp_dir() . '/publish-compiler-test-' . bin2hex(random_bytes(4));
    }

    public function tearDown(): void
    {
        if (is_dir($this->stateDir)) {
            foreach (glob($this->stateDir . '/*') ?: [] as $f) {
                unlink($f);
            }
            rmdir($this->stateDir);
        }
    }

    private function episode(string $id, string $status, float $duration = 1800.0): array
    {
        return [
            'id' => $id, 'title' => "Title $id", 'status' => $status, 'duration' => $duration,
            'source' => ['provider' => 'youtube', 'video_id' => "vid-$id", 'url' => "https://www.youtube.com/watch?v=vid-$id"],
        ];
    }

    private function utc(string $s): DateTimeImmutable
    {
        return new DateTimeImmutable($s, new DateTimeZone('UTC'));
    }

    private function dailyBlock(string $id, string $seriesId, string $anchorDate, array $overrides = []): array
    {
        return array_replace([
            'id' => $id, 'type' => 'series', 'series_id' => $seriesId,
            'recurrence' => ['frequency' => 'daily', 'time' => '00:00', 'timezone' => 'UTC'],
            'duration' => 1800,
            'rotation' => ['mode' => 'sequential', 'loop' => true, 'anchor_date' => $anchorDate],
        ], $overrides);
    }

    public function testOnlyApprovedEpisodesAreEligibleForRotation(): void
    {
        $series = [[
            'id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
                $this->episode('e1', 'candidate'),
                $this->episode('e2', 'approved'),
                $this->episode('e3', 'rejected'),
                $this->episode('e4', 'disabled'),
                $this->episode('e5', 'approved'),
            ],
        ]];
        $programming = ['blocks' => [$this->dailyBlock('b', 's', '2026-11-02')]];
        $result = ProgrammingCompiler::compile($programming, $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-06T00:00:00Z'));
        $ids = array_map(static fn ($i) => $i['id'], $result['items']);
        Assert::same(['e2', 'e5', 'e2', 'e5'], $ids, 'only e2/e5 (approved) ever air, alternating');
    }

    public function testLoopsBackToTheFirstEpisodeAfterTheLast(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved'), $this->episode('e2', 'approved'), $this->episode('e3', 'approved'),
        ]]];
        $programming = ['blocks' => [$this->dailyBlock('b', 's', '2026-11-02')]];
        $result = ProgrammingCompiler::compile($programming, $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-08T00:00:00Z'));
        $ids = array_map(static fn ($i) => $i['id'], $result['items']);
        Assert::same(['e1', 'e2', 'e3', 'e1', 'e2', 'e3'], $ids);
    }

    public function testNonLoopingRotationLeavesAGapOnceItRunsOut(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved'), $this->episode('e2', 'approved'),
        ]]];
        $block = $this->dailyBlock('b', 's', '2026-11-02', ['rotation' => ['mode' => 'sequential', 'loop' => false, 'anchor_date' => '2026-11-02']]);
        $result = ProgrammingCompiler::compile(['blocks' => [$block]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-06T00:00:00Z'));
        $ids = array_map(static fn ($i) => $i['id'], $result['items']);
        Assert::same(['e1', 'e2'], $ids, 'only the first two occurrences get an episode; the rest are left as gaps');
    }

    public function testTheSameSeriesInTwoIndependentBlocksRotatesIndependently(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved'), $this->episode('e2', 'approved'),
        ]]];
        $programming = [
            'blocks' => [
                $this->dailyBlock('morning', 's', '2026-11-02', ['recurrence' => ['frequency' => 'daily', 'time' => '08:00', 'timezone' => 'UTC']]),
                $this->dailyBlock('evening', 's', '2026-11-03', ['recurrence' => ['frequency' => 'daily', 'time' => '20:00', 'timezone' => 'UTC']]), // different anchor date -> different phase
            ],
        ];
        $result = ProgrammingCompiler::compile($programming, $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-05T00:00:00Z'));
        $byTime = [];
        foreach ($result['items'] as $it) {
            $byTime[gmdate('Y-m-d\TH:i', $it['start'])] = $it['id'];
        }
        // morning: anchor 11-02 -> e1,e2,e1 on 11-02,11-03,11-04 at 08:00
        Assert::same('e1', $byTime['2026-11-02T08:00']);
        Assert::same('e2', $byTime['2026-11-03T08:00']);
        Assert::same('e1', $byTime['2026-11-04T08:00']);
        // evening: anchor 11-03 -> e1,e2 on 11-03,11-04 at 20:00 -- note it's
        // OFFSET from morning's rotation (11-03 is e2 in the morning block,
        // but e1 in the evening block), proving the two tracks are independent.
        Assert::same('e1', $byTime['2026-11-03T20:00']);
        Assert::same('e2', $byTime['2026-11-04T20:00']);
    }

    public function testZeroApprovedEpisodesProducesZeroOccurrencesNotAnError(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'candidate'), $this->episode('e2', 'rejected'),
        ]]];
        $result = ProgrammingCompiler::compile(['blocks' => [$this->dailyBlock('b', 's', '2026-11-02')]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-06T00:00:00Z'));
        Assert::count(0, $result['items']);
        Assert::true(count($result['warnings']) >= 1);
    }

    public function testEpisodeDurationIsUsedInFullNeverTruncatedToTheSlot(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved', 1234.0), // shorter than the 1800s nominal slot
        ]]];
        $result = ProgrammingCompiler::compile(['blocks' => [$this->dailyBlock('b', 's', '2026-11-02')]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        Assert::same(1234, $result['items'][0]['end'] - $result['items'][0]['start']);
    }

    public function testUnknownEpisodeDurationFallsBackToTheBlocksNominalSlotDuration(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            ['id' => 'e1', 'title' => 'No duration known', 'status' => 'approved', 'duration' => null, 'source' => null],
        ]]];
        $result = ProgrammingCompiler::compile(['blocks' => [$this->dailyBlock('b', 's', '2026-11-02', ['duration' => 2222])]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        Assert::same(2222, $result['items'][0]['end'] - $result['items'][0]['start']);
    }

    public function testAnOverlongEpisodeOverlappingTheNextOccurrenceIsAHardError(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved', 90000.0), // 25 hours -- overruns the next day's occurrence
        ]]];
        Assert::throws(RuntimeException::class, function () use ($series): void {
            ProgrammingCompiler::compile(['blocks' => [$this->dailyBlock('b', 's', '2026-11-02')]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-06T00:00:00Z'));
        });
    }

    public function testUnknownSeriesIdIsSkippedWithAWarningNotACrash(): void
    {
        $result = ProgrammingCompiler::compile(['blocks' => [$this->dailyBlock('b', 'not-declared', '2026-11-02')]], [], $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        Assert::count(0, $result['items']);
        Assert::true(count($result['warnings']) >= 1);
    }

    public function testNonSequentialRotationModeIsRejectedRatherThanSilentlyTreatedAsSequential(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [$this->episode('e1', 'approved')]]];
        $block = $this->dailyBlock('b', 's', '2026-11-02', ['rotation' => ['mode' => 'random', 'loop' => true, 'anchor_date' => '2026-11-02']]);
        Assert::throws(RuntimeException::class, function () use ($series, $block): void {
            ProgrammingCompiler::compile(['blocks' => [$block]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        });
    }

    public function testCompileIsIdempotentForTheSameInputsAndWindow(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved'), $this->episode('e2', 'approved'),
        ]]];
        $programming = ['blocks' => [$this->dailyBlock('b', 's', '2026-11-02')]];
        $a = ProgrammingCompiler::compile($programming, $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-10T00:00:00Z'));
        $b = ProgrammingCompiler::compile($programming, $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-10T00:00:00Z'));
        Assert::same(json_encode($a['items']), json_encode($b['items']));
    }

    // ---------------- Phase 1: multi-episode packing ----------------

    private function dailyPackedBlock(string $id, string $seriesId, string $anchorDate, array $packingOverrides = [], array $overrides = []): array
    {
        return array_replace_recursive(
            $this->dailyBlock($id, $seriesId, $anchorDate, $overrides),
            ['packing' => array_replace(['mode' => 'sequential', 'enabled' => true], $packingOverrides)],
        );
    }

    public function testPackingDisabledOrAbsentIsByteForByteTheOldOneEpisodePerOccurrenceBehavior(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved', 300.0), $this->episode('e2', 'approved', 300.0),
        ]]];
        $withoutPacking = ProgrammingCompiler::compile(
            ['blocks' => [$this->dailyBlock('b', 's', '2026-11-02')]], $series, $this->stateDir, 'chan', false,
            $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-04T00:00:00Z'),
        );
        $ids = array_map(static fn ($i) => $i['id'], $withoutPacking['items']);
        Assert::same(['e1', 'e2'], $ids, 'exactly one (short) episode per occurrence, the rest of the 1800s slot left as a gap -- unchanged');
    }

    public function testPackingFillsAnHourWithSeveralEpisodesAndDefersTheOneThatDoesNotFit(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved', 1380.0), // 23 min
            $this->episode('e2', 'approved', 1080.0), // 18 min
            $this->episode('e3', 'approved', 960.0),  // 16 min
            $this->episode('e4', 'approved', 1860.0), // 31 min -- doesn't fit alongside the rest
        ]]];
        $block = $this->dailyPackedBlock('b', 's', '2026-11-02', [], ['duration' => 3600]);
        $result = ProgrammingCompiler::compile(['blocks' => [$block]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        $ids = array_map(static fn ($i) => $i['id'], $result['items']);
        Assert::same(['e1', 'e2', 'e3'], $ids, 'e4 is deferred, never truncated');
        Assert::same(1380, $result['items'][1]['start'] - $result['items'][0]['start'], 'items are packed back-to-back within the occurrence');
    }

    public function testPackingRotationIsStableAcrossTwoAdjacentOverlappingPublicationWindows(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved', 1200.0), $this->episode('e2', 'approved', 1200.0), $this->episode('e3', 'approved', 2000.0),
        ]]];
        $block = $this->dailyPackedBlock('b', 's', '2026-11-02', [], ['duration' => 3600]);
        $programming = ['blocks' => [$block]];

        $first = ProgrammingCompiler::compile($programming, $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-05T00:00:00Z'));
        $firstIds = array_map(static fn ($i) => $i['id'], $first['items']);

        // A later, overlapping publish (window rolled forward by a day, as the documented workflow expects).
        $second = ProgrammingCompiler::compile($programming, $series, $this->stateDir, 'chan', false, $this->utc('2026-11-03T00:00:00Z'), $this->utc('2026-11-07T00:00:00Z'));
        $secondIds = array_map(static fn ($i) => $i['id'], $second['items']);

        // Every occurrence present in BOTH windows (11-03 and 11-04) must have identical content --
        // the second publish must not have reshuffled anything the first one already committed.
        $firstByDay = [];
        foreach ($first['items'] as $it) {
            $firstByDay[gmdate('Y-m-d', $it['start'])][] = $it['id'];
        }
        $secondByDay = [];
        foreach ($second['items'] as $it) {
            $secondByDay[gmdate('Y-m-d', $it['start'])][] = $it['id'];
        }
        Assert::same(json_encode($firstByDay['2026-11-03']), json_encode($secondByDay['2026-11-03']), 'already-published 11-03 occurrence must not change');
        Assert::same(json_encode($firstByDay['2026-11-04']), json_encode($secondByDay['2026-11-04']), 'already-published 11-04 occurrence must not change');
    }

    public function testPackingCompileIsIdempotentForTheSameInputsAndWindow(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved', 1200.0), $this->episode('e2', 'approved', 1200.0), $this->episode('e3', 'approved', 1200.0),
        ]]];
        $block = $this->dailyPackedBlock('b', 's', '2026-11-02', [], ['duration' => 3600]);
        $programming = ['blocks' => [$block]];
        $a = ProgrammingCompiler::compile($programming, $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-10T00:00:00Z'));
        $b = ProgrammingCompiler::compile($programming, $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-10T00:00:00Z'));
        Assert::same(json_encode($a['items']), json_encode($b['items']));
    }

    public function testPackingWithZeroApprovedEpisodesProducesZeroOccurrencesNotAnError(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [$this->episode('e1', 'candidate')]]];
        $block = $this->dailyPackedBlock('b', 's', '2026-11-02', [], ['duration' => 3600]);
        $result = ProgrammingCompiler::compile(['blocks' => [$block]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        Assert::count(0, $result['items']);
    }

    public function testPackingWithASingleShortEpisodeLeavesTheRestOfTheOccurrenceAsAGap(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [$this->episode('e1', 'approved', 600.0)]]];
        $block = $this->dailyPackedBlock('b', 's', '2026-11-02', [], ['duration' => 3600]);
        $result = ProgrammingCompiler::compile(['blocks' => [$block]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        Assert::count(1, $result['items']);
        Assert::same(600, $result['items'][0]['end'] - $result['items'][0]['start']);
    }

    public function testPackingWithOnUnfitAllowOverrunStillGoesThroughTheExistingHardOverlapCheck(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved', 90000.0), // 25 hours -- will collide with tomorrow's occurrence
        ]]];
        $block = $this->dailyPackedBlock('b', 's', '2026-11-02', ['on_unfit' => 'allow_overrun'], ['duration' => 3600]);
        Assert::throws(RuntimeException::class, function () use ($block, $series): void {
            ProgrammingCompiler::compile(['blocks' => [$block]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-06T00:00:00Z'));
        });
    }

    // ---------------- Phase 3: hard/soft boundaries ----------------

    public function testDefaultBoundaryIsHardAndOverlapIsStillRefusedExactlyAsBeforePhase3(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [$this->episode('e1', 'approved', 90000.0)]]];
        Assert::throws(RuntimeException::class, function () use ($series): void {
            ProgrammingCompiler::compile(['blocks' => [$this->dailyBlock('b', 's', '2026-11-02')]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-06T00:00:00Z'));
        });
    }

    public function testSoftBoundaryAbsorbsAnOverrunFromAPrecedingBlockAsAnExplicitDelay(): void
    {
        $series = [
            ['id' => 'morning', 'title' => 'M', 'url' => '/x', 'episodes' => [$this->episode('m1', 'approved', 4200.0)]], // 70 min, overruns its 1hr slot by 600s
            ['id' => 'evening', 'title' => 'E', 'url' => '/x', 'episodes' => [$this->episode('e1', 'approved', 600.0)]],
        ];
        $blockA = $this->dailyBlock('a', 'morning', '2026-11-02', ['recurrence' => ['frequency' => 'daily', 'time' => '13:00', 'timezone' => 'UTC'], 'duration' => 3600]);
        $blockB = array_replace($this->dailyBlock('b', 'evening', '2026-11-02', ['recurrence' => ['frequency' => 'daily', 'time' => '14:00', 'timezone' => 'UTC'], 'duration' => 1800]), [
            'boundary' => ['mode' => 'soft', 'max_delay' => 900],
        ]);
        $result = ProgrammingCompiler::compile(['blocks' => [$blockA, $blockB]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        $byId = [];
        foreach ($result['items'] as $it) {
            $byId[$it['id']] = $it;
        }
        Assert::same($byId['m1']['end'], $byId['e1']['start'], 'e1 is pushed to start exactly where the overrunning m1 ends, never overlapping it');
        Assert::same(600, $byId['e1']['delay_seconds']);
    }

    public function testHardBoundaryAfterASoftOverrunThatDoesNotFitIsRejected(): void
    {
        $series = [
            ['id' => 'morning', 'title' => 'M', 'url' => '/x', 'episodes' => [$this->episode('m1', 'approved', 4500.0)]], // 75 min -- overruns by 900s
            ['id' => 'noon', 'title' => 'N', 'url' => '/x', 'episodes' => [$this->episode('n1', 'approved', 600.0)]],
        ];
        $blockA = $this->dailyBlock('a', 'morning', '2026-11-02', ['recurrence' => ['frequency' => 'daily', 'time' => '13:00', 'timezone' => 'UTC'], 'duration' => 3600]);
        $blockB = array_replace($this->dailyBlock('b', 'noon', '2026-11-02', ['recurrence' => ['frequency' => 'daily', 'time' => '14:00', 'timezone' => 'UTC'], 'duration' => 1800]), [
            'boundary' => ['mode' => 'hard'],
        ]);
        Assert::throws(RuntimeException::class, function () use ($blockA, $blockB, $series): void {
            ProgrammingCompiler::compile(['blocks' => [$blockA, $blockB]], $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        });
    }

    public function testPackingResetsRotationStateWhenTheEpisodeSetIsRefreshed(): void
    {
        $series = [['id' => 's', 'title' => 'S', 'url' => '/x', 'episodes' => [
            $this->episode('e1', 'approved', 1200.0), $this->episode('e2', 'approved', 1200.0),
        ]]];
        $block = $this->dailyPackedBlock('b', 's', '2026-11-02', [], ['duration' => 3600]);
        $programming = ['blocks' => [$block]];
        ProgrammingCompiler::compile($programming, $series, $this->stateDir, 'chan', false, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));

        // Approve a third episode and refresh -- the pin version changes, so rotation state resets cleanly rather than misreading stale cursor positions.
        $series[0]['episodes'][] = $this->episode('e3', 'approved', 1200.0);
        $result = ProgrammingCompiler::compile($programming, $series, $this->stateDir, 'chan', true, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        $ids = array_map(static fn ($i) => $i['id'], $result['items']);
        Assert::same(['e1', 'e2', 'e3'], $ids);
    }
}
