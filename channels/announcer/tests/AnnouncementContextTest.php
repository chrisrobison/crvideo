<?php
declare(strict_types=1);

require_once __DIR__ . '/TestFixtures.php';

final class AnnouncementContextTest
{
    private string $root;
    private string $announcerRoot;

    public function setUp(): void
    {
        $this->root = TestFixtures::build();
        $this->announcerRoot = dirname(__DIR__); // channels/announcer -- real config.php, no secrets
    }

    public function tearDown(): void
    {
        TestFixtures::destroy($this->root);
    }

    private function buildContexts(): array
    {
        $channelsRoot = "{$this->root}/channels";
        $seriesRoot = "{$this->root}/series";
        $config = AnnouncerConfig::resolve('test-channel', $channelsRoot, $this->announcerRoot);
        $schedule = json_decode((string) file_get_contents("$channelsRoot/test-channel/schedule.json"), true);
        $meta = json_decode((string) file_get_contents("$channelsRoot/test-channel/meta.json"), true);
        $programming = json_decode((string) file_get_contents("$channelsRoot/test-channel/programming.json"), true);
        return AnnouncementContextBuilder::buildAll('test-channel', $schedule, $meta, $programming, $config, $seriesRoot);
    }

    private function findByTransition(array $contexts, string $transitionId): ?array
    {
        foreach ($contexts as $c) {
            if (($c['transitionId'] ?? null) === $transitionId) {
                return $c;
            }
        }
        return null;
    }

    public function testBuildsOneComingUpNextPerContinuityItemPlusOneChannelId(): void
    {
        $contexts = $this->buildContexts();
        // 4 continuity items (cont-1..cont-4) + 1 channel_id context.
        Assert::count(5, $contexts);
    }

    public function testUsesBlockTitleNotRawVideoTitle(): void
    {
        $contexts = $this->buildContexts();
        $cont1 = $this->findByTransition($contexts, 'cont-1');
        Assert::notNull($cont1);
        Assert::same('Show B', $cont1['nextBlock']['title'], 'must announce the BLOCK title');
        Assert::same('Show A', $cont1['currentBlock']['title']);
        // The raw video title must never appear as the announced show name.
        Assert::true(!str_contains(json_encode($cont1['nextBlock']), 'Ep2 raw video title'));
    }

    public function testOccurrenceIdentityNotTitleBased(): void
    {
        $contexts = $this->buildContexts();
        $cont1 = $this->findByTransition($contexts, 'cont-1');
        $cont2 = $this->findByTransition($contexts, 'cont-2');
        // cont-2's incoming program ("Show A" at block-a@220) has the SAME
        // display title as cont-1's outgoing one, but a DIFFERENT occurrence_id --
        // fromProgramId/toProgramId must disambiguate by occurrence, not title.
        Assert::same('block-a@0', $cont1['fromProgramId']);
        Assert::same('block-a@220', $cont2['toProgramId']);
        Assert::true($cont1['fromProgramId'] !== $cont2['toProgramId']);
    }

    public function testDetectsConsecutiveSameSeries(): void
    {
        $contexts = $this->buildContexts();
        $cont3 = $this->findByTransition($contexts, 'cont-3');
        Assert::notNull($cont3);
        Assert::true($cont3['isConsecutiveSameSeries'], 'cont-3 goes from series-a to series-a');

        $cont1 = $this->findByTransition($contexts, 'cont-1');
        Assert::false($cont1['isConsecutiveSameSeries'], 'cont-1 goes from series-a to series-b');
    }

    public function testHandlesNoUpcomingProgramGracefully(): void
    {
        $contexts = $this->buildContexts();
        $cont4 = $this->findByTransition($contexts, 'cont-4');
        Assert::notNull($cont4);
        Assert::true($cont4['noUpcomingProgram']);
        Assert::null($cont4['nextBlock']);
        // Still resolves the outgoing program from the preceding video item.
        Assert::same('block-a@330', $cont4['fromProgramId']);
    }

    public function testEpisodeMetadataIsSuppliedButSeparateFromBlockTitle(): void
    {
        $contexts = $this->buildContexts();
        $cont1 = $this->findByTransition($contexts, 'cont-1');
        Assert::same('ep-2', $cont1['toEpisodeId']);
        Assert::notNull($cont1['episodeInfo']);
        Assert::same('Ep2 raw video title', $cont1['episodeInfo']['title']);
        // Episode title is available as flavor, but nextBlock (the thing the
        // writer is told to announce BY NAME) is still the block title.
        Assert::same('Show B', $cont1['nextBlock']['title']);
    }

    public function testChannelIdContextIsNotTimeBound(): void
    {
        $contexts = $this->buildContexts();
        $channelId = null;
        foreach ($contexts as $c) {
            if ($c['type'] === 'channel_id') {
                $channelId = $c;
            }
        }
        Assert::notNull($channelId);
        Assert::null($channelId['scheduledStartTime']);
        Assert::same('Test Channel', $channelId['channelName']);
    }

    public function testMissingDescriptionsDoNotCrash(): void
    {
        $channelsRoot = "{$this->root}/channels";
        $schedule = json_decode((string) file_get_contents("$channelsRoot/test-channel/schedule.json"), true);
        unset($schedule['programs'][0]['description']);
        $meta = json_decode((string) file_get_contents("$channelsRoot/test-channel/meta.json"), true);
        unset($meta['description']);
        $config = AnnouncerConfig::resolve('test-channel', $channelsRoot, $this->announcerRoot);
        $contexts = AnnouncementContextBuilder::buildAll('test-channel', $schedule, $meta, [], $config, "{$this->root}/series");
        Assert::true(count($contexts) > 0); // did not throw
    }
}
