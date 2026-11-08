<?php
declare(strict_types=1);

require_once __DIR__ . '/TestFixtures.php';

final class PipelineIntegrationTest
{
    private string $root;
    private string $channelsRoot;
    private string $seriesRoot;
    private string $announcerRoot;
    private AnnouncerPipeline $pipeline;

    public function setUp(): void
    {
        $this->root = TestFixtures::build();
        $this->channelsRoot = "{$this->root}/channels";
        $this->seriesRoot = "{$this->root}/series";
        $this->announcerRoot = dirname(__DIR__);
        $this->pipeline = new AnnouncerPipeline($this->channelsRoot, $this->announcerRoot, $this->seriesRoot, $this->root);
    }

    public function tearDown(): void
    {
        TestFixtures::destroy($this->root);
    }

    /** Drains every pending job for the channel using mock writer/TTS, returns [ok, failed] counts. */
    private function drainQueue(): array
    {
        $queue = new JobQueue("{$this->channelsRoot}/test-channel");
        $writer = new MockAiWriter();
        $fallback = new TemplateAiWriter();
        $tts = new MockTtsProvider();
        $audioProcessor = new AudioProcessor();
        $ok = 0;
        $failed = 0;
        while (($job = $queue->claimNext()) !== null) {
            $result = $this->pipeline->runJob($job['id'], $job['payload'], $writer, $fallback, $tts, $audioProcessor);
            if ($result['ok']) {
                $queue->complete($job['id'], $result['manifestRecord'] ?? []);
                $ok++;
            } else {
                $queue->fail($job['id'], (string) $result['error'], ['maxAttempts' => 1, 'baseDelaySeconds' => 1]);
                $failed++;
            }
        }
        return [$ok, $failed];
    }

    public function testFullCycleProducesReadyManifestEntries(): void
    {
        $enqueueResult = $this->pipeline->enqueueForSchedule('test-channel');
        Assert::true($enqueueResult['enabled']);
        Assert::true($enqueueResult['enqueued'] > 0);

        [$ok, $failed] = $this->drainQueue();
        Assert::same(0, $failed);
        Assert::true($ok > 0);

        $manifest = AnnouncementManifestWriter::read(AnnouncementManifestWriter::path("{$this->channelsRoot}/test-channel"));
        Assert::true(count($manifest['announcements']) > 0);
        foreach ($manifest['announcements'] as $record) {
            Assert::same('ready', $record['status']);
            Assert::notNull($record['audio']);
            Assert::true(is_file("{$this->root}/media/announcements/test-channel/" . basename($record['audio'])));
        }
    }

    public function testSecondRunFullyReusesCacheWithNoNewJobs(): void
    {
        $this->pipeline->enqueueForSchedule('test-channel');
        $this->drainQueue();

        $second = $this->pipeline->enqueueForSchedule('test-channel');
        Assert::same(0, $second['enqueued'], 'everything should already be cached (script + audio)');
        Assert::true($second['reused'] > 0);
    }

    public function testConcurrentEnqueueCallsDoNotCreateDuplicateJobs(): void
    {
        // Simulates two overlapping publish.php runs enqueueing before either
        // worker has drained the queue.
        $first = $this->pipeline->enqueueForSchedule('test-channel');
        $second = $this->pipeline->enqueueForSchedule('test-channel');
        Assert::same(0, $second['enqueued'], 'the second call must see every job already pending and dedupe');
        Assert::true($second['reused'] === $first['enqueued']);
    }

    public function testStaleTransitionIsDiscardedIfScheduleChangesBeforeProcessing(): void
    {
        $this->pipeline->enqueueForSchedule('test-channel');

        // Schedule changes between enqueue and processing: cont-1 now leads to
        // a different program than the job was built for.
        $schedulePath = "{$this->channelsRoot}/test-channel/schedule.json";
        $schedule = json_decode((string) file_get_contents($schedulePath), true);
        foreach ($schedule['blocks'][0]['items'] as &$item) {
            if ($item['id'] === 'cont-1') {
                $item['program_id'] = 'block-a@0'; // was block-b@110
            }
        }
        unset($item);
        file_put_contents($schedulePath, json_encode($schedule));

        [$ok, $failed] = $this->drainQueue();
        Assert::true($failed >= 1, 'at least the cont-1 job must be rejected as stale');
    }

    public function testForceRegenerationBypassesTheCache(): void
    {
        $this->pipeline->enqueueForSchedule('test-channel');
        $this->drainQueue();

        $queue = new JobQueue("{$this->channelsRoot}/test-channel");
        $writer = new MockAiWriter(fixedText: 'A brand new forced script.');
        $fallback = new TemplateAiWriter();
        $tts = new MockTtsProvider();
        $audioProcessor = new AudioProcessor();

        $config = $this->pipeline->resolveConfig('test-channel');
        $contexts = $this->pipeline->buildContexts('test-channel', $config);
        $context = $contexts[0];
        $scriptHash = $this->pipeline->scriptHashFor('test-channel', $context, $config);

        $result = $this->pipeline->runJob(
            $scriptHash, ['channelId' => 'test-channel', 'context' => $context, 'config' => $config, 'scriptHash' => $scriptHash],
            $writer, $fallback, $tts, $audioProcessor, forceScript: true, forceAudio: true,
        );
        Assert::true($result['ok']);
        Assert::same('A brand new forced script.', $result['manifestRecord']['text']);
    }

    public function testRepeatedProgrammingBlockAcrossOccurrencesGetsIndependentCacheEntries(): void
    {
        // cont-2 (-> block-a@220) and cont-3 (-> block-a@330) are both "Show A"
        // but different occurrences -- they must get different script hashes
        // (different fromProgramId/toProgramId) even though the title repeats.
        $config = $this->pipeline->resolveConfig('test-channel');
        $contexts = $this->pipeline->buildContexts('test-channel', $config);
        $byId = [];
        foreach ($contexts as $c) {
            $byId[$c['transitionId']] = $c;
        }
        $h2 = $this->pipeline->scriptHashFor('test-channel', $byId['cont-2'], $config);
        $h3 = $this->pipeline->scriptHashFor('test-channel', $byId['cont-3'], $config);
        Assert::true($h2 !== $h3);
    }
}
