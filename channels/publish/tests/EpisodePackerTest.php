<?php
declare(strict_types=1);

final class EpisodePackerTest
{
    /** @return array<string,array<string,mixed>> */
    private function episodes(array $idsAndDurations): array
    {
        $out = [];
        foreach ($idsAndDurations as $id => $duration) {
            $out[$id] = ['id' => $id, 'title' => "Title $id", 'status' => 'approved', 'duration' => $duration];
        }
        return $out;
    }

    private function config(array $overrides = []): array
    {
        return EpisodePacker::normalizeConfig($overrides, 'b');
    }

    private function emptyState(): array
    {
        return ['cursor' => 0, 'deferred' => []];
    }

    public function testSeveralShortEpisodesFillAnHourLeavingARemainder(): void
    {
        $ids = ['e1', 'e2', 'e3', 'e4'];
        $episodes = $this->episodes(['e1' => 1380, 'e2' => 1080, 'e3' => 960, 'e4' => 1860]); // 23,18,16,31 min
        $result = EpisodePacker::packOccurrence(3600, $ids, $episodes, $this->emptyState(), $this->config(), true, 3600, 'b', 'occ1');
        $scheduledIds = array_map(static fn ($s) => $s['episode_id'], $result['scheduled']);
        Assert::same(['e1', 'e2', 'e3'], $scheduledIds, '23+18+16=57min fits; the 31min episode is deferred, not truncated');
        Assert::same(180, 3600 - $result['usedSeconds'], 'about 3 minutes left for continuity');
        Assert::same(3, $result['state']['cursor'], 'cursor is NOT advanced past the unfit episode -- that is what gives it priority next time');
        Assert::count(0, $result['state']['deferred'], '"defer" needs no separate bookkeeping: an unmoved cursor already means "try this one again first"');
    }

    public function testExactFitConsumesTheWholeOccurrenceWithNothingDeferred(): void
    {
        $ids = ['e1', 'e2'];
        $episodes = $this->episodes(['e1' => 1800, 'e2' => 1800]);
        $result = EpisodePacker::packOccurrence(3600, $ids, $episodes, $this->emptyState(), $this->config(), true, 3600, 'b', 'occ1');
        Assert::same(['e1', 'e2'], array_map(static fn ($s) => $s['episode_id'], $result['scheduled']));
        Assert::same(0, 3600 - $result['usedSeconds']);
        Assert::count(0, $result['state']['deferred']);
    }

    public function testEmptyCatalogSchedulesNothing(): void
    {
        $result = EpisodePacker::packOccurrence(3600, [], [], $this->emptyState(), $this->config(), true, 3600, 'b', 'occ1');
        Assert::count(0, $result['scheduled']);
        Assert::same(0, $result['usedSeconds']);
    }

    public function testSingleEpisodeCatalogNeverRepeatsWithinOneOccurrence(): void
    {
        $ids = ['e1'];
        $episodes = $this->episodes(['e1' => 1200]); // 20 min, well under an hour
        $result = EpisodePacker::packOccurrence(3600, $ids, $episodes, $this->emptyState(), $this->config(), true, 3600, 'b', 'occ1');
        Assert::same(['e1'], array_map(static fn ($s) => $s['episode_id'], $result['scheduled']), 'schedules it exactly once, never twice, even though it would technically fit again');
        Assert::same(1, $result['state']['cursor']);
    }

    public function testSingleEpisodeCatalogCanRepeatWhenExplicitlyAllowed(): void
    {
        $ids = ['e1'];
        $episodes = $this->episodes(['e1' => 1200]);
        $config = $this->config(['allow_repeat_within_block' => true]);
        $result = EpisodePacker::packOccurrence(3600, $ids, $episodes, $this->emptyState(), $config, true, 3600, 'b', 'occ1');
        Assert::same(['e1', 'e1', 'e1'], array_map(static fn ($s) => $s['episode_id'], $result['scheduled']));
    }

    public function testEpisodeLongerThanTheBlockIsNeverScheduledAndIsLeftAsAGap(): void
    {
        $ids = ['e1'];
        $episodes = $this->episodes(['e1' => 7200]); // 2 hours, into a 1 hour block
        $result = EpisodePacker::packOccurrence(3600, $ids, $episodes, $this->emptyState(), $this->config(), true, 3600, 'b', 'occ1');
        Assert::count(0, $result['scheduled']);
        Assert::true(count($result['warnings']) >= 1);
        Assert::same(0, $result['state']['cursor'], 'cursor not advanced -- held, not dropped from rotation');
    }

    public function testEpisodeWithMissingDurationFallsBackToTheBlocksNominalDuration(): void
    {
        $ids = ['e1'];
        $episodes = ['e1' => ['id' => 'e1', 'title' => 'T', 'status' => 'approved', 'duration' => null]];
        $result = EpisodePacker::packOccurrence(1800, $ids, $episodes, $this->emptyState(), $this->config(), true, 1800, 'b', 'occ1');
        Assert::same(['e1'], array_map(static fn ($s) => $s['episode_id'], $result['scheduled']));
        Assert::same(1800, $result['scheduled'][0]['duration']);
    }

    public function testAllEpisodesUnavailableLeavesTheWholeOccurrenceAsAGap(): void
    {
        $ids = ['e1', 'e2'];
        $episodes = [
            'e1' => ['id' => 'e1', 'title' => 'T', 'status' => 'disabled', 'duration' => 600],
            'e2' => ['id' => 'e2', 'title' => 'T', 'status' => 'rejected', 'duration' => 600],
        ];
        $result = EpisodePacker::packOccurrence(3600, $ids, $episodes, $this->emptyState(), $this->config(), true, 3600, 'b', 'occ1');
        Assert::count(0, $result['scheduled']);
        Assert::same(0, $result['usedSeconds']);
    }

    public function testSequentialRotationWrapsAcrossOccurrences(): void
    {
        $ids = ['e1', 'e2', 'e3'];
        $episodes = $this->episodes(['e1' => 1200, 'e2' => 1200, 'e3' => 1200]); // exactly 3 per hour
        $state = $this->emptyState();
        $occ1 = EpisodePacker::packOccurrence(3600, $ids, $episodes, $state, $this->config(), true, 3600, 'b', 'o1');
        Assert::same(['e1', 'e2', 'e3'], array_map(static fn ($s) => $s['episode_id'], $occ1['scheduled']));
        $occ2 = EpisodePacker::packOccurrence(3600, $ids, $episodes, $occ1['state'], $this->config(), true, 3600, 'b', 'o2');
        Assert::same(['e1', 'e2', 'e3'], array_map(static fn ($s) => $s['episode_id'], $occ2['scheduled']), 'cursor wraps back to e1 for the next occurrence');
    }

    public function testDeferredEpisodeGetsPriorityAtTheVeryNextOccurrence(): void
    {
        $ids = ['e1', 'e2', 'e3'];
        // e1+e2+e3 (1200+1200+2000=4400s) don't all fit in one 3600s occurrence.
        $episodes = $this->episodes(['e1' => 1200, 'e2' => 1200, 'e3' => 2000]);
        $occ1 = EpisodePacker::packOccurrence(3600, $ids, $episodes, $this->emptyState(), $this->config(), true, 3600, 'b', 'o1');
        Assert::same(['e1', 'e2'], array_map(static fn ($s) => $s['episode_id'], $occ1['scheduled']), 'e3 does not fit after e1+e2 -> held, not dropped');
        Assert::same(2, $occ1['state']['cursor']);

        // e3 was never truncated or lost -- it is the FIRST thing tried, with a full fresh
        // slot, at the very next occurrence (this is "held for a later suitable slot").
        $occ2 = EpisodePacker::packOccurrence(3600, $ids, $episodes, $occ1['state'], $this->config(), true, 3600, 'b', 'o2');
        $scheduled2 = array_map(static fn ($s) => $s['episode_id'], $occ2['scheduled']);
        Assert::same('e3', $scheduled2[0], 'the held episode gets priority over continuing sequentially from e1');
    }

    public function testOnUnfitSkipForBlockFindsALaterEpisodeThatFitsWithoutLosingTheSkippedOne(): void
    {
        $ids = ['e1', 'e2', 'e3'];
        $episodes = $this->episodes(['e1' => 7200, 'e2' => 1200, 'e3' => 1200]); // e1 (2hr) doesn't fit a 1hr slot
        $config = $this->config(['on_unfit' => 'skip_for_block']);
        $result = EpisodePacker::packOccurrence(3600, $ids, $episodes, $this->emptyState(), $config, true, 3600, 'b', 'o1');
        $scheduled = array_map(static fn ($s) => $s['episode_id'], $result['scheduled']);
        Assert::same(['e2', 'e3'], $scheduled, 'e1 is skipped over (not truncated, not dropped) so e2/e3 can still air this occurrence');
        Assert::count(1, $result['state']['deferred']);
        Assert::same('e1', $result['state']['deferred'][0]['episode_id'], 'e1 stays queued for a future, larger occurrence rather than vanishing from rotation');
    }

    public function testOnUnfitAllowOverrunSchedulesTheEpisodeAnywayAndReportsIt(): void
    {
        $ids = ['e1'];
        $episodes = $this->episodes(['e1' => 5400]); // 90 min into a 60 min slot
        $config = $this->config(['on_unfit' => 'allow_overrun']);
        $result = EpisodePacker::packOccurrence(3600, $ids, $episodes, $this->emptyState(), $config, true, 3600, 'b', 'o1');
        Assert::same(['e1'], array_map(static fn ($s) => $s['episode_id'], $result['scheduled']));
        Assert::same(5400, $result['scheduled'][0]['duration'], 'played in full, never truncated');
        Assert::true(count($result['warnings']) >= 1);
    }

    public function testMinimumRemainingStopsPackingBeforeCrammingInOneMoreEpisode(): void
    {
        $ids = ['e1', 'e2'];
        $episodes = $this->episodes(['e1' => 3000, 'e2' => 500]); // second would leave only 100s, below minimum_remaining
        $config = $this->config(['minimum_remaining' => 120]);
        $result = EpisodePacker::packOccurrence(3600, $ids, $episodes, $this->emptyState(), $config, true, 3600, 'b', 'o1');
        Assert::same(['e1'], array_map(static fn ($s) => $s['episode_id'], $result['scheduled']));
    }

    public function testSafetyMarginIsReservedBeyondTheEpisodesOwnDuration(): void
    {
        $ids = ['e1'];
        $episodes = $this->episodes(['e1' => 3550]); // fits in 3600 alone, not with a 60s safety margin
        $config = $this->config(['safety_margin' => 60]);
        $result = EpisodePacker::packOccurrence(3600, $ids, $episodes, $this->emptyState(), $config, true, 3600, 'b', 'o1');
        Assert::count(0, $result['scheduled']);
    }

    public function testInvalidPackingModeIsRejected(): void
    {
        Assert::throws(RuntimeException::class, function (): void {
            EpisodePacker::normalizeConfig(['mode' => 'random'], 'b');
        });
    }

    public function testInvalidOnUnfitIsRejected(): void
    {
        Assert::throws(RuntimeException::class, function (): void {
            EpisodePacker::normalizeConfig(['on_unfit' => 'bogus'], 'b');
        });
    }

    public function testNonLoopingRotationStopsPackingOnceItRunsOut(): void
    {
        $ids = ['e1', 'e2'];
        $episodes = $this->episodes(['e1' => 600, 'e2' => 600]);
        $state = ['cursor' => 2, 'deferred' => []]; // already past the end of a 2-episode, non-looping list
        $result = EpisodePacker::packOccurrence(3600, $ids, $episodes, $state, $this->config(), false, 3600, 'b', 'o1');
        Assert::count(0, $result['scheduled']);
    }
}
