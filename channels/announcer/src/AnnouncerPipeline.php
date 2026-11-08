<?php
declare(strict_types=1);

// channels/announcer/src/AnnouncerPipeline.php
//
// Orchestrates the whole feature end to end (spec section 5):
//   contexts -> cache check -> enqueue (fast path, called from publish.php)
//   job -> write (AI + fallback) -> synthesize -> encode/validate -> publish manifest (worker path)
//
// enqueueForSchedule() is deliberately cheap: it never calls an AI writer
// or Kokoro. It only builds contexts, computes the SCRIPT hash for each
// (cheap, local), and either confirms everything is already cached
// (nothing to do) or writes a small job file -- so calling it from
// publish.php can never make schedule compilation slow or dependent on
// an external service being up (spec: "Schedule compilation must not
// block on slow TTS or AI requests unless an explicit synchronous
// generation mode is selected").
//
// runJob() is the slow path (AI + TTS), run by channels/announce-worker.php
// (the queue drainer) or directly by channels/announce.php --sync.

final class AnnouncerPipeline
{
    public function __construct(
        private string $channelsRoot,
        private string $announcerRoot,
        private string $seriesRoot,
        private string $repoRoot,
    ) {
    }

    public function resolveConfig(string $channelId): array
    {
        return AnnouncerConfig::resolve($channelId, $this->channelsRoot, $this->announcerRoot);
    }

    /** @return list<array<string,mixed>> */
    public function buildContexts(string $channelId, array $config): array
    {
        $channelDir = "{$this->channelsRoot}/$channelId";
        $schedule = self::readJson("$channelDir/schedule.json");
        $meta = self::readJson("$channelDir/meta.json");
        $programming = self::readJson("$channelDir/programming.json");
        if ($schedule === null || $meta === null) {
            return [];
        }
        $contexts = AnnouncementContextBuilder::buildAll($channelId, $schedule, $meta, $programming ?? [], $config, $this->seriesRoot);
        return $this->filterEligible($contexts, $config);
    }

    /** @return array{enabled:bool, enqueued:int, reused:int, contexts:int, error?:string} */
    public function enqueueForSchedule(string $channelId): array
    {
        $config = $this->resolveConfig($channelId);
        if (empty($config['enabled'])) {
            return ['enabled' => false, 'enqueued' => 0, 'reused' => 0, 'contexts' => 0];
        }

        $channelDir = "{$this->channelsRoot}/$channelId";
        $contexts = $this->buildContexts($channelId, $config);
        if (!$contexts && !is_file("$channelDir/schedule.json")) {
            return ['enabled' => true, 'error' => 'missing schedule.json', 'enqueued' => 0, 'reused' => 0, 'contexts' => 0];
        }

        $result = $this->enqueueContexts($channelId, $contexts, $config);
        return ['enabled' => true, ...$result];
    }

    /**
     * Same enqueue/cache-check logic as enqueueForSchedule(), but given
     * already-built contexts and a resolved config -- the seam
     * channels/announce.php uses so CLI flags like --voice/--date/--force
     * can affect contexts/config before this runs, without duplicating
     * the cache-check logic itself.
     *
     * @return array{enqueued:int, reused:int, contexts:int}
     */
    public function enqueueContexts(string $channelId, array $contexts, array $config): array
    {
        $channelDir = "{$this->channelsRoot}/$channelId";
        $queue = new JobQueue($channelDir);
        $audioCache = new AudioCache($this->repoRoot, $config['mediaRoot'] ?? 'media/announcements');

        $enqueued = 0;
        $reused = 0;
        $validIds = [];

        foreach ($contexts as $context) {
            $scriptHash = ContentHash::scriptHash($this->scriptHashInputs($channelId, $context, $config));
            $announcementId = AnnouncementManifestWriter::idFor($channelId, (string) $context['transitionId'], (string) $context['type']);
            $validIds[] = $announcementId;

            $cachedScript = ScriptCache::get($channelDir, $scriptHash);
            if ($cachedScript !== null && is_string($cachedScript['text'] ?? null)) {
                $audioHash = ContentHash::audioHash($this->audioHashInputs($cachedScript['text'], $config));
                if ($audioCache->exists($channelId, $audioHash)) {
                    AnnouncementManifestWriter::upsert($channelDir, $this->manifestRecord(
                        $channelId, $context, $cachedScript['text'], $config, $audioCache, $audioHash, $scriptHash, $cachedScript['provider'] ?? null, $cachedScript['model'] ?? null,
                    ));
                    $reused++;
                    continue;
                }
            }

            $payload = ['channelId' => $channelId, 'context' => $context, 'config' => $config, 'scriptHash' => $scriptHash];
            if ($queue->enqueue($scriptHash, $payload)) {
                $enqueued++;
            } else {
                $reused++;
            }
        }

        AnnouncementManifestWriter::pruneExcept($channelDir, $validIds);

        return ['enqueued' => $enqueued, 'reused' => $reused, 'contexts' => count($contexts)];
    }

    /**
     * Runs one job to completion: write (AI + template fallback) -> synthesize
     * -> encode/validate -> publish manifest entry. Never throws for an
     * external-provider failure -- returns ok:false so the caller (worker
     * or --sync CLI) can retry/report instead of crashing the whole run.
     *
     * @return array{ok:bool, error:?string, manifestRecord:?array<string,mixed>}
     */
    public function runJob(
        string $jobId,
        array $payload,
        AiWriterInterface $primaryWriter,
        AiWriterInterface $fallbackWriter,
        TtsProviderInterface $tts,
        AudioProcessor $audioProcessor,
        bool $forceScript = false,
        bool $forceAudio = false,
        bool $scriptsOnly = false,
        bool $audioOnly = false,
    ): array {
        $channelId = (string) $payload['channelId'];
        $context = $payload['context'];
        $config = $payload['config'];
        $channelDir = "{$this->channelsRoot}/$channelId";

        $staleReason = $this->checkStale($channelId, $context);
        if ($staleReason !== null) {
            return ['ok' => false, 'error' => "stale transition, discarding: $staleReason", 'manifestRecord' => null];
        }

        $scriptHash = (string) $payload['scriptHash'];
        $cached = $forceScript ? null : ScriptCache::get($channelDir, $scriptHash);

        if ($audioOnly && $cached === null) {
            return ['ok' => false, 'error' => '--audio-only requires an already-cached script for this transition; run without it first.', 'manifestRecord' => null];
        }

        if ($cached !== null && is_string($cached['text'] ?? null)) {
            $text = $cached['text'];
            $provider = $cached['provider'] ?? 'cache';
            $model = $cached['model'] ?? null;
        } else {
            if (!empty($cached['approved']) && !$forceScript) {
                // An approved/edited script is never silently overwritten (spec
                // section 9) -- unreachable in practice since $cached would have
                // matched above, but kept as an explicit guard for --force callers.
                $text = $cached['text'];
                $provider = $cached['provider'] ?? 'cache';
                $model = $cached['model'] ?? null;
            } else {
                $written = $primaryWriter->write($context, $config);
                if ($written['error'] !== null || trim($written['text']) === '') {
                    $written = $fallbackWriter->write($context, $config);
                }
                if ($written['error'] !== null || trim($written['text']) === '') {
                    return ['ok' => false, 'error' => 'both the primary writer and the template fallback failed', 'manifestRecord' => null];
                }
                $text = $written['text'];
                $provider = $written['provider'];
                $model = $written['model'];
                ScriptCache::put($channelDir, $scriptHash, [
                    'text' => $text, 'provider' => $provider, 'model' => $model, 'approved' => false,
                    'type' => $context['type'], 'transitionId' => $context['transitionId'],
                    'fromProgramId' => $context['fromProgramId'] ?? null, 'toProgramId' => $context['toProgramId'] ?? null,
                    'generatedAt' => gmdate('c'),
                ]);
            }
        }

        if ($scriptsOnly) {
            return ['ok' => true, 'error' => null, 'manifestRecord' => null];
        }

        $audioCache = new AudioCache($this->repoRoot, $config['mediaRoot'] ?? 'media/announcements');
        $audioHash = ContentHash::audioHash($this->audioHashInputs($text, $config));

        if (!$forceAudio && $audioCache->exists($channelId, $audioHash)) {
            $record = $this->manifestRecord($channelId, $context, $text, $config, $audioCache, $audioHash, $scriptHash, $provider, $model);
            AnnouncementManifestWriter::upsert($channelDir, $record);
            return ['ok' => true, 'error' => null, 'manifestRecord' => $record];
        }

        $voice = (string) ($config['voice'] ?? 'af_heart');
        $speed = (float) ($config['speed'] ?? 1.0);
        $language = (string) ($config['language'] ?? 'en-us');

        $tmpDir = sys_get_temp_dir() . '/crvideo-announcer';
        if (!is_dir($tmpDir)) {
            mkdir($tmpDir, 0775, true);
        }
        $wavPath = "$tmpDir/$jobId.wav";

        $synth = $tts->synthesize($text, $voice, $speed, $language, $wavPath);
        if ($synth['error'] !== null || $synth['wavPath'] === null) {
            return ['ok' => false, 'error' => "TTS synthesis failed: {$synth['error']}", 'manifestRecord' => null];
        }

        $destPath = $audioCache->absolutePathFor($channelId, $audioHash);
        $encoded = $audioProcessor->convertToMp3($synth['wavPath'], $destPath, $config['audio'] ?? []);
        @unlink($synth['wavPath']);
        if ($encoded['error'] !== null || $encoded['mp3Path'] === null) {
            return ['ok' => false, 'error' => "Audio encode/validation failed: {$encoded['error']}", 'manifestRecord' => null];
        }

        $record = $this->manifestRecord($channelId, $context, $text, $config, $audioCache, $audioHash, $scriptHash, $provider, $model, $encoded['durationSeconds']);
        AnnouncementManifestWriter::upsert($channelDir, $record);

        return ['ok' => true, 'error' => null, 'manifestRecord' => $record];
    }

    /** Re-reads the CURRENT schedule.json and confirms the transition this
     *  job was built for still exists with the same from/to program identity
     *  -- spec section 11: "A schedule that changes during audio generation."
     *  Returns null if still valid, or a human-readable reason if stale. */
    private function checkStale(string $channelId, array $context): ?string
    {
        $channelDir = "{$this->channelsRoot}/$channelId";
        $schedule = self::readJson("$channelDir/schedule.json");
        if ($schedule === null) {
            return 'schedule.json is missing';
        }
        if (($context['type'] ?? null) === 'channel_id') {
            return null; // not tied to any one transition
        }
        $items = $schedule['blocks'][0]['items'] ?? [];
        foreach ($items as $it) {
            if (is_array($it) && ($it['id'] ?? null) === $context['transitionId']) {
                $currentNext = $it['program_id'] ?? null;
                $expectedNext = $context['toProgramId'] ?? null;
                if ($expectedNext !== null && $currentNext !== null && $currentNext !== $expectedNext) {
                    return "transition {$context['transitionId']} now leads to a different program";
                }
                return null; // found, and either consistent or we have nothing to compare
            }
        }
        return "transition {$context['transitionId']} no longer exists in the current schedule";
    }

    /** @return list<array<string,mixed>> */
    private function filterEligible(array $contexts, array $config): array
    {
        $suppressMode = $config['consecutiveSameSeries'] ?? 'short';
        $lookaheadHours = is_numeric($config['lookaheadHours'] ?? null) ? (float) $config['lookaheadHours'] : 36.0;
        $now = time();
        $cutoff = $now + (int) ($lookaheadHours * 3600);

        $filtered = array_values(array_filter($contexts, static function (array $c) use ($suppressMode, $cutoff): bool {
            if (($c['type'] ?? null) === 'coming_up_next' && !empty($c['isConsecutiveSameSeries']) && $suppressMode === 'suppress') {
                return false;
            }
            $startsAt = $c['scheduledStartTime'] ?? null;
            if ($startsAt !== null && $startsAt > $cutoff) {
                return false; // outside the lookahead window -- generate it on a later run, closer to air
            }
            return true;
        }));

        // Prioritize approaching broadcast times (spec section 4): earlier
        // airtimes sort first, so JobQueue's FIFO (oldest-file-first) claim
        // order processes them before anything further out. channel_id
        // entries (no scheduledStartTime) sort last -- never urgent.
        usort($filtered, static function (array $a, array $b): int {
            $sa = $a['scheduledStartTime'] ?? PHP_INT_MAX;
            $sb = $b['scheduledStartTime'] ?? PHP_INT_MAX;
            return $sa <=> $sb;
        });

        return $filtered;
    }

    /** Public so callers (the CLI, tests) that need to predict/inspect a
     *  cache key -- e.g. for --dry-run's "would reuse vs. would generate"
     *  report -- always compute EXACTLY the same hash this class itself
     *  uses internally. Never duplicate this array literal elsewhere. */
    public function scriptHashFor(string $channelId, array $context, array $config): string
    {
        return ContentHash::scriptHash($this->scriptHashInputs($channelId, $context, $config));
    }

    /** @return array<string,mixed> */
    private function scriptHashInputs(string $channelId, array $context, array $config): array
    {
        return [
            'type' => $context['type'],
            'channelId' => $channelId,
            'transitionId' => $context['transitionId'],
            'fromProgramId' => $context['fromProgramId'] ?? null,
            'toProgramId' => $context['toProgramId'] ?? null,
            'toEpisodeId' => $context['toEpisodeId'] ?? null,
            'currentBlock' => $context['currentBlock'] ?? null,
            'nextBlock' => $context['nextBlock'] ?? null,
            'seriesInfo' => $context['seriesInfo'] ?? null,
            'episodeInfo' => $context['episodeInfo'] ?? null,
            'isConsecutiveSameSeries' => $context['isConsecutiveSameSeries'] ?? false,
            'style' => $config['style'] ?? null,
            'tone' => $config['tone'] ?? null,
            'targetDuration' => $config['targetDuration'] ?? null,
            'wordsPerSecond' => $config['wordsPerSecond'] ?? null,
            'writerProvider' => $config['writer']['provider'] ?? null,
            'writerModel' => $config['writer']['model'] ?? null,
        ];
    }

    /** @return array<string,mixed> */
    private function audioHashInputs(string $text, array $config): array
    {
        return [
            'text' => $text,
            'voice' => $config['voice'] ?? null,
            'speed' => $config['speed'] ?? null,
            'language' => $config['language'] ?? null,
            'ttsProvider' => $config['tts']['provider'] ?? null,
            'modelVersion' => $config['tts']['modelVersion'] ?? null,
            'audio' => $config['audio'] ?? null,
        ];
    }

    /** @return array<string,mixed> */
    private function manifestRecord(
        string $channelId,
        array $context,
        string $text,
        array $config,
        AudioCache $audioCache,
        string $audioHash,
        ?string $scriptHash,
        ?string $provider,
        ?string $model,
        ?float $durationSeconds = null,
    ): array {
        $duration = $durationSeconds;
        if ($duration === null) {
            $audioProcessor = new AudioProcessor();
            $duration = $audioProcessor->probeDuration($audioCache->absolutePathFor($channelId, $audioHash));
        }
        return [
            'id' => AnnouncementManifestWriter::idFor($channelId, (string) $context['transitionId'], (string) $context['type']),
            'channelId' => $channelId,
            'type' => $context['type'],
            'transitionId' => $context['transitionId'],
            'fromProgramId' => $context['fromProgramId'] ?? null,
            'toProgramId' => $context['toProgramId'] ?? null,
            'toEpisodeId' => $context['toEpisodeId'] ?? null,
            'voice' => $config['voice'] ?? null,
            'text' => $text,
            'audio' => $audioCache->publicUrlFor($channelId, $audioHash),
            'duration' => $duration,
            'status' => 'ready',
            'scriptHash' => $scriptHash,
            'audioHash' => $audioHash,
            'provider' => $provider,
            'model' => $model,
            'scheduledStartTime' => $context['scheduledStartTime'] ?? null,
            'generatedAt' => gmdate('c'),
        ];
    }

    private static function readJson(string $path): ?array
    {
        if (!is_file($path)) {
            return null;
        }
        $data = json_decode((string) file_get_contents($path), true);
        return is_array($data) ? $data : null;
    }
}
