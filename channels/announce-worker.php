#!/usr/bin/env php
<?php
declare(strict_types=1);

// channels/announce-worker.php
//
// Drains the file-based announcer job queue (channels/<id>/.announcer/jobs/)
// written by AnnouncerPipeline::enqueueForSchedule() (called from
// publish.php) and channels/announce.php (without --sync). This is the
// ONLY place that actually calls the AI writer and Kokoro over the
// network for the async path -- same "cheap, idempotent, cron-invoked
// CLI script" posture as server/download-cache.php, meant to be run
// repeatedly on a short interval via cron, wrapped in `flock -n` exactly
// like that script already is (see server/README.md for the pattern;
// this tool's own --help documents the equivalent crontab line).
//
// Usage:
//   php channels/announce-worker.php [options]
//
// Options:
//   --channel=ID           Only drain this channel's queue (default: every
//                           channel with an announcer.json)
//   --max-jobs=N            Stop after processing N jobs this run (default: 20)
//   --once                  Process at most one job then exit (handy for testing)
//   --verbose                Print per-job detail
//   --channels-root=PATH     Directory containing channel folders (tests)
//   --series-root=PATH       Directory containing series/<id>/ (tests)
//   --help                   Display this message
//
// A channel whose announcer.json has gone missing or been disabled since
// its jobs were queued is simply skipped (its pending jobs sit untouched,
// harmless, until re-enabled or pruned).

const WORKER_ROOT = __DIR__;

require WORKER_ROOT . '/announcer/src/ContentHash.php';
require WORKER_ROOT . '/announcer/src/AnnouncerConfig.php';
require WORKER_ROOT . '/announcer/src/AnnouncementContextBuilder.php';
require WORKER_ROOT . '/announcer/src/AiWriterInterface.php';
require WORKER_ROOT . '/announcer/src/WriterPromptBuilder.php';
require WORKER_ROOT . '/announcer/src/TemplateAiWriter.php';
require WORKER_ROOT . '/announcer/src/ClaudeCliAiWriter.php';
require WORKER_ROOT . '/announcer/src/MockAiWriter.php';
require WORKER_ROOT . '/announcer/src/TtsProviderInterface.php';
require WORKER_ROOT . '/announcer/src/KokoroHttpTtsProvider.php';
require WORKER_ROOT . '/announcer/src/MockTtsProvider.php';
require WORKER_ROOT . '/announcer/src/AudioProcessor.php';
require WORKER_ROOT . '/announcer/src/ScriptCache.php';
require WORKER_ROOT . '/announcer/src/AudioCache.php';
require WORKER_ROOT . '/announcer/src/JobQueue.php';
require WORKER_ROOT . '/announcer/src/AnnouncementManifestWriter.php';
require WORKER_ROOT . '/announcer/src/AnnouncerPipeline.php';

function worker_usage(): string
{
    return <<<USAGE
    CRVideo announcer job-queue worker -- drains pending AI-write + Kokoro-
    synthesize jobs queued by publish.php / channels/announce.php.

    Usage:
      php announce-worker.php [options]

    Options:
      --channel=ID           Only this channel (default: every channel with
                              an announcer.json)
      --max-jobs=N            Stop after N jobs this run (default: 20)
      --once                  Process at most one job then exit
      --verbose                Print per-job detail
      --channels-root=PATH     Directory containing channel folders (tests)
      --series-root=PATH       Directory containing series/<id>/ (tests)
      --help                   Display this message

    Suggested cron entry (every minute, never overlapping itself):
      * * * * * flock -n /tmp/crvideo-announce-worker.lock php /path/to/channels/announce-worker.php >> /var/log/crvideo-announce-worker.log 2>&1

    USAGE;
}

/** @return array{positional: list<string>, options: array<string,string|bool>} */
function worker_parse_args(array $argv): array
{
    $positional = [];
    $options = [];
    foreach (array_slice($argv, 1) as $arg) {
        if ($arg === '--help' || $arg === '-h') {
            $options['help'] = true;
            continue;
        }
        if (str_starts_with($arg, '--')) {
            $body = substr($arg, 2);
            if (str_contains($body, '=')) {
                [$name, $value] = explode('=', $body, 2);
                $options[$name] = $value;
            } else {
                $options[$body] = true;
            }
            continue;
        }
        $positional[] = $arg;
    }
    return ['positional' => $positional, 'options' => $options];
}

function worker_main(array $argv): int
{
    $parsed = worker_parse_args($argv);
    $opt = $parsed['options'];

    if (!empty($opt['help'])) {
        echo worker_usage();
        return 0;
    }

    $channelsRoot = isset($opt['channels-root']) ? (string) $opt['channels-root'] : WORKER_ROOT;
    $seriesRoot = isset($opt['series-root']) ? (string) $opt['series-root'] : dirname(WORKER_ROOT) . '/series';
    $announcerRoot = WORKER_ROOT . '/announcer';
    $repoRoot = dirname(WORKER_ROOT);
    $verbose = !empty($opt['verbose']);
    $maxJobs = !empty($opt['once']) ? 1 : (isset($opt['max-jobs']) ? max(1, (int) $opt['max-jobs']) : 20);

    $channelIds = isset($opt['channel'])
        ? [(string) $opt['channel']]
        : array_map('basename', array_map('dirname', glob("$channelsRoot/*/announcer.json") ?: []));
    sort($channelIds);

    if (!$channelIds) {
        echo "No channel has an announcer.json -- nothing to do.\n";
        return 0;
    }

    $pipeline = new AnnouncerPipeline($channelsRoot, $announcerRoot, $seriesRoot, $repoRoot);
    $audioProcessor = new AudioProcessor();

    $processed = 0;
    $succeeded = 0;
    $failed = 0;

    foreach ($channelIds as $channelId) {
        if ($processed >= $maxJobs) {
            break;
        }
        $config = $pipeline->resolveConfig($channelId);
        if (empty($config['enabled'])) {
            continue;
        }

        $queue = new JobQueue("$channelsRoot/$channelId");
        $reclaimed = $queue->reclaimStale((int) ($config['staleJobSeconds'] ?? 900));
        if ($reclaimed > 0 && $verbose) {
            echo "[$channelId] reclaimed $reclaimed stale \"running\" job(s) back to pending.\n";
        }

        $writerConfig = $config['writer'] ?? [];
        $primaryWriter = match ($writerConfig['provider'] ?? 'claude-cli') {
            'claude-cli' => new ClaudeCliAiWriter(
                (string) ($writerConfig['bin'] ?? 'claude'),
                (string) ($writerConfig['model'] ?? 'sonnet'),
                (int) ($writerConfig['timeoutSeconds'] ?? 25),
            ),
            'mock' => new MockAiWriter(),
            default => new TemplateAiWriter(),
        };
        $fallbackWriter = new TemplateAiWriter();
        $tts = match ($config['tts']['provider'] ?? 'kokoro-http') {
            'mock' => new MockTtsProvider(),
            default => KokoroHttpTtsProvider::fromConfig($config['tts'] ?? []),
        };

        while ($processed < $maxJobs) {
            $job = $queue->claimNext();
            if ($job === null) {
                break;
            }
            $processed++;
            $result = $pipeline->runJob($job['id'], $job['payload'], $primaryWriter, $fallbackWriter, $tts, $audioProcessor);
            if ($result['ok']) {
                $queue->complete($job['id'], $result['manifestRecord'] ?? []);
                $succeeded++;
                if ($verbose) {
                    echo "[$channelId] OK    {$job['id']}: " . ($result['manifestRecord']['text'] ?? '') . "\n";
                }
            } else {
                $queue->fail($job['id'], (string) $result['error'], $config['retry'] ?? ['maxAttempts' => 5, 'baseDelaySeconds' => 30]);
                $failed++;
                echo "[$channelId] FAIL  {$job['id']}: {$result['error']}\n";
            }
        }
    }

    echo "Processed $processed job(s): $succeeded ok, $failed failed/retrying.\n";
    return $failed > 0 && $succeeded === 0 && $processed > 0 ? 1 : 0;
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    exit(worker_main($argv));
}
