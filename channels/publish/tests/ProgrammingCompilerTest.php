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
}
