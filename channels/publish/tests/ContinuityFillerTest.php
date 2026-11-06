<?php
declare(strict_types=1);

final class ContinuityFillerTest
{
    private function asset(string $id, int $duration, string $category = 'station_id', string $status = 'approved'): array
    {
        return ['id' => $id, 'title' => "Title $id", 'category' => $category, 'duration' => $duration, 'status' => $status, 'source' => ['provider' => 'direct', 'url' => "/media/$id.mp4"]];
    }

    private function card(string $id, int $min, int $max): array
    {
        return ['id' => $id, 'template' => $id, 'minDuration' => $min, 'maxDuration' => $max];
    }

    private function continuity(array $assets = [], array $cards = [], ?string $preferredCard = null, int $minimumVideoFiller = 0): array
    {
        return ['assets' => $assets, 'cards' => $cards, 'defaults' => ['preferredCard' => $preferredCard, 'minimumVideoFiller' => $minimumVideoFiller]];
    }

    public function testNoContinuityConfiguredLeavesItemsCompletelyUnchanged(): void
    {
        $items = [['start' => 100, 'end' => 200, 'id' => 'e1', 'title' => 'E1', 'source' => null, 'source_url' => null]];
        $result = ContinuityFiller::fill($items, 0, 1000, $this->continuity());
        Assert::same(json_encode($items), json_encode($result['items']));
    }

    public function testATinyThreeSecondGapGetsExactlyOneDynamicCard(): void
    {
        $result = ContinuityFiller::fill([], 0, 3, $this->continuity([], [$this->card('generic', 0, 300)]));
        Assert::count(1, $result['items']);
        Assert::same('continuity', $result['items'][0]['kind']);
        Assert::same(3, $result['items'][0]['end'] - $result['items'][0]['start']);
    }

    public function testASevenSecondGapGetsExactlyOneDynamicCard(): void
    {
        $result = ContinuityFiller::fill([], 0, 7, $this->continuity([], [$this->card('generic', 0, 300)]));
        Assert::count(1, $result['items']);
        Assert::same(7, $result['items'][0]['end'] - $result['items'][0]['start']);
    }

    public function testATwentySevenSecondGapPicksTheQualifyingCardTemplate(): void
    {
        $result = ContinuityFiller::fill([], 0, 27, $this->continuity([], [
            $this->card('station-id', 3, 20),
            $this->card('up-next', 5, 300),
        ]));
        Assert::count(1, $result['items']);
        Assert::same('up-next', $result['items'][0]['template'], 'the first card whose [min,max] actually covers 27s, in configured order');
    }

    public function testAFiftySecondGapUsesAStationIdThenAnExactDurationCardForTheRemainder(): void
    {
        $result = ContinuityFiller::fill([], 0, 50, $this->continuity(
            [$this->asset('id-30', 30)],
            [$this->card('up-next', 0, 300)],
        ));
        Assert::count(2, $result['items']);
        Assert::same('video', $result['items'][0]['kind']);
        Assert::same('id-30', $result['items'][0]['id']);
        Assert::same(30, $result['items'][0]['end'] - $result['items'][0]['start']);
        Assert::same('continuity', $result['items'][1]['kind']);
        Assert::same(20, $result['items'][1]['end'] - $result['items'][1]['start'], 'the exact remainder, never more, never truncated');
        Assert::same($result['items'][0]['end'], $result['items'][1]['start'], 'back to back, no sub-gap');
    }

    public function testAGapThatIsAnExactMultipleOfOneStationIdNeedsNoCardAtAll(): void
    {
        $result = ContinuityFiller::fill([], 0, 90, $this->continuity([$this->asset('id-30', 30)], [$this->card('up-next', 0, 300)]));
        Assert::count(3, $result['items'], 'three real station ids, bounded by MAX_STATION_IDS_PER_GAP, exactly cover the gap');
        foreach ($result['items'] as $it) {
            Assert::same('video', $it['kind']);
        }
    }

    public function testAGapLongerThanTheMaxSupportedSingleCardStillGetsExactlyOneCardViaTheFallbackTemplate(): void
    {
        // Only a short card is configured (max 60s); a 500s gap with no station ids
        // must still resolve to exactly one continuity occurrence covering it all.
        $result = ContinuityFiller::fill([], 0, 500, $this->continuity([], [$this->card('short', 0, 60)]));
        Assert::count(1, $result['items']);
        Assert::same('continuity', $result['items'][0]['kind']);
        Assert::same(500, $result['items'][0]['end'] - $result['items'][0]['start']);
        Assert::same('generic', $result['items'][0]['template'], 'falls back to the universal template when nothing configured covers this exact duration');
    }

    public function testAMissingOrUnavailableStationIdAssetIsNeverUsedAndFallsBackToACard(): void
    {
        $result = ContinuityFiller::fill([], 0, 30, $this->continuity(
            [$this->asset('disabled-id', 15, 'station_id', 'disabled'), $this->asset('rejected-id', 15, 'station_id', 'rejected')],
            [$this->card('generic', 0, 300)],
        ));
        Assert::count(1, $result['items']);
        Assert::same('continuity', $result['items'][0]['kind'], 'neither unavailable asset is ever eligible');
    }

    public function testContinuityCardFollowedByAYouTubeVideoReportsTheCorrectNextProgram(): void
    {
        $items = [['start' => 100, 'end' => 500, 'id' => 'yt-ep', 'title' => 'YT', 'source' => ['provider' => 'youtube', 'video_id' => 'abc'], 'source_url' => 'https://youtu.be/abc']];
        $result = ContinuityFiller::fill($items, 0, 500, $this->continuity([], [$this->card('generic', 0, 300)]));
        Assert::count(2, $result['items']);
        Assert::same('continuity', $result['items'][0]['kind']);
        Assert::same('yt-ep', $result['items'][0]['next_program_id']);
    }

    public function testContinuityCardFollowedByADirectlyHostedVideoReportsTheCorrectNextProgram(): void
    {
        $items = [['start' => 100, 'end' => 500, 'id' => 'direct-ep', 'title' => 'D', 'source' => ['provider' => 'direct', 'url' => '/x.mp4'], 'source_url' => '/x.mp4']];
        $result = ContinuityFiller::fill($items, 0, 500, $this->continuity([], [$this->card('generic', 0, 300)]));
        Assert::same('direct-ep', $result['items'][0]['next_program_id']);
    }

    public function testTheLastGapInTheWindowHasNoNextProgram(): void
    {
        $result = ContinuityFiller::fill([], 0, 50, $this->continuity([], [$this->card('generic', 0, 300)]));
        Assert::null($result['items'][0]['next_program_id']);
    }

    public function testStationIdChainIsBoundedAndNeverProducesHundredsOfTinyOccurrences(): void
    {
        // A 10s asset into a 1000s gap: the chain is bounded (<=3), the remainder always a single card.
        $result = ContinuityFiller::fill([], 0, 1000, $this->continuity([$this->asset('id-10', 10)], [$this->card('generic', 0, 1000)]));
        Assert::true(count($result['items']) <= 4, 'at most MAX_STATION_IDS_PER_GAP station ids plus one trailing card');
        Assert::same('continuity', end($result['items'])['kind']);
    }

    public function testMinimumVideoFillerSkipsStationIdsForTinyGapsAndGoesStraightToACard(): void
    {
        $result = ContinuityFiller::fill([], 0, 5, $this->continuity([$this->asset('id-3', 3)], [$this->card('generic', 0, 300)], null, 10));
        Assert::count(1, $result['items']);
        Assert::same('continuity', $result['items'][0]['kind'], 'below minimum_video_filler, no station id is even attempted');
    }

    public function testNoNegativeOrOverlappingDurationsEverComeOutOfFilling(): void
    {
        $items = [['start' => 1000, 'end' => 1300, 'id' => 'e1', 'title' => 'E1', 'source' => null, 'source_url' => null]];
        $result = ContinuityFiller::fill($items, 0, 2000, $this->continuity([$this->asset('id-15', 15), $this->asset('id-30', 30)], [$this->card('generic', 0, 1000)]));
        $all = $result['items'];
        for ($i = 0, $n = count($all); $i < $n; $i++) {
            Assert::true($all[$i]['end'] > $all[$i]['start']);
            if ($i > 0) {
                Assert::true($all[$i]['start'] >= $all[$i - 1]['end']);
            }
        }
        Assert::same(0, $all[0]['start']);
        Assert::same(2000, end($all)['end']);
    }

    // ---------------- Phase 7: program-level attribution ----------------

    private function program(string $occurrenceId, int $start, int $end): array
    {
        return ['occurrence_id' => $occurrenceId, 'start' => $start, 'end' => $end];
    }

    public function testAFillerEntirelyInsideAProgramsWindowInheritsItsProgramId(): void
    {
        // A packed occurrence's own under-filled remainder (0..1000 is the
        // program's full nominal slot; the scheduled episode only used 0..700).
        $items = [['start' => 0, 'end' => 700, 'id' => 'e1', 'title' => 'E1', 'source' => null, 'source_url' => null, 'program_id' => 'b@0']];
        $programs = [$this->program('b@0', 0, 1000)];
        $result = ContinuityFiller::fill($items, 0, 1000, $this->continuity([], [$this->card('generic', 0, 300)]), $programs);
        Assert::count(2, $result['items']);
        Assert::same('b@0', $result['items'][0]['program_id'], 'the real scheduled episode keeps its program_id');
        Assert::same('b@0', $result['items'][1]['program_id'], 'the filler covering the under-filled remainder inherits the SAME program_id');
    }

    public function testAFillerInAGenuineInterProgramGapIsNotAttributedToEitherNeighbor(): void
    {
        $items = [
            ['start' => 0, 'end' => 500, 'id' => 'e1', 'title' => 'E1', 'source' => null, 'source_url' => null, 'program_id' => 'a@0'],
            ['start' => 600, 'end' => 1000, 'id' => 'e2', 'title' => 'E2', 'source' => null, 'source_url' => null, 'program_id' => 'b@600'],
        ];
        // A real station break between the two programs' own windows (500..600),
        // not inside either one's [start,end).
        $programs = [$this->program('a@0', 0, 500), $this->program('b@600', 600, 1000)];
        $result = ContinuityFiller::fill($items, 0, 1000, $this->continuity([], [$this->card('generic', 0, 300)]), $programs);
        $filler = array_values(array_filter($result['items'], static fn ($it) => ($it['kind'] ?? 'video') === 'continuity'));
        Assert::count(1, $filler);
        Assert::true(!isset($filler[0]['program_id']), 'a genuine inter-program gap must never be mislabeled as part of either neighbor');
    }

    public function testNoProgramsPassedLeavesEveryFillerWithoutAProgramId(): void
    {
        // Default behavior (no $programs argument) -- every pre-existing test
        // above in this file relies on this staying exactly as it was.
        $result = ContinuityFiller::fill([], 0, 50, $this->continuity([], [$this->card('generic', 0, 300)]));
        Assert::true(!isset($result['items'][0]['program_id']));
    }
}
