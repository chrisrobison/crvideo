#!/usr/bin/env php
<?php
declare(strict_types=1);

umask(0002); // new files 664 / dirs 775 (dirs are setgid www-data): the web server and the CLI user both write these trees

// channels/announce.php
//
// AI continuity announcer CLI (spec section 10). Mirrors channels/
// publish.php's own shape exactly: *_parse_args()/*_main() pair, guarded
// top-level invocation, `--dry-run`/`--verbose`/`--help`.
//
// Usage:
//   php channels/announce.php --channel science [options]
//   php channels/announce.php --all-channels [options]
//
// Options:
//   --channel=ID          One channel (required unless --all-channels)
//   --all-channels        Every channel with an announcer.json present
//   --date=YYYY-MM-DD      Only transitions airing on this UTC date
//   --from=YYYY-MM-DD      Only transitions airing on/after this UTC date
//   --to=YYYY-MM-DD        Only transitions airing on/before this UTC date
//   --voice=NAME           Override the configured voice for this run
//   --transition=ID[,ID2]  Only this/these specific transition id(s)
//   --force                Regenerate script AND audio even if cached
//   --force-script         Regenerate the script only
//   --force-audio          Regenerate the audio only (reuses/((re)writes the script)
//   --scripts-only         Write/cache scripts; never call the TTS provider
//   --audio-only           Synthesize audio for an already-cached script only
//   --sync                 Run writer+TTS synchronously, right here (no job queue)
//   --dry-run              Show what would be generated/reused; write nothing
//   --verbose              Print per-transition detail
//   --channels-root=PATH   Directory containing channel folders (tests)
//   --series-root=PATH     Directory containing series/<id>/series.json (tests)
//   --help                 Display this message
//
// Without --sync, this only enqueues jobs (see AnnouncerPipeline) -- run
// channels/announce-worker.php to actually drain the queue (AI + TTS).
// --sync runs everything in-process, useful for local testing/demoing and
// for the "dry-run"-adjacent one-off "generate now" admin action.

const ANNOUNCE_ROOT = __DIR__;

require ANNOUNCE_ROOT . '/announcer/src/ContentHash.php';
require ANNOUNCE_ROOT . '/announcer/src/AnnouncerConfig.php';
require ANNOUNCE_ROOT . '/announcer/src/AnnouncementContextBuilder.php';
require ANNOUNCE_ROOT . '/announcer/src/AiWriterInterface.php';
require ANNOUNCE_ROOT . '/announcer/src/WriterPromptBuilder.php';
require ANNOUNCE_ROOT . '/announcer/src/TemplateAiWriter.php';
require ANNOUNCE_ROOT . '/announcer/src/ClaudeCliAiWriter.php';
require ANNOUNCE_ROOT . '/announcer/src/MockAiWriter.php';
require ANNOUNCE_ROOT . '/announcer/src/TtsProviderInterface.php';
require ANNOUNCE_ROOT . '/announcer/src/KokoroHttpTtsProvider.php';
require ANNOUNCE_ROOT . '/announcer/src/MockTtsProvider.php';
require ANNOUNCE_ROOT . '/announcer/src/AudioProcessor.php';
require ANNOUNCE_ROOT . '/announcer/src/ScriptCache.php';
require ANNOUNCE_ROOT . '/announcer/src/AudioCache.php';
require ANNOUNCE_ROOT . '/announcer/src/JobQueue.php';
require ANNOUNCE_ROOT . '/announcer/src/AnnouncementManifestWriter.php';
require ANNOUNCE_ROOT . '/announcer/src/AnnouncerPipeline.php';

function announce_usage(): string
{
    return <<<USAGE
    CRVideo continuity announcer -- generates AI-written, Kokoro-synthesized
    "coming up next" (etc.) announcements for compiled channel schedules.

    Usage:
      php announce.php --channel <id> [options]
      php announce.php --all-channels [options]

    Options:
      --channel=ID          One channel (required unless --all-channels)
      --all-channels        Every channel with an announcer.json present
      --date=YYYY-MM-DD      Only transitions airing on this UTC date
      --from=YYYY-MM-DD      Only transitions airing on/after this UTC date
      --to=YYYY-MM-DD        Only transitions airing on/before this UTC date
      --voice=NAME           Override the configured voice for this run
      --transition=ID[,ID2]  Only this/these specific transition id(s)
      --force                Regenerate script AND audio even if cached
      --force-script         Regenerate the script only
      --force-audio          Regenerate the audio only
      --scripts-only         Write/cache scripts; never call the TTS provider
      --audio-only           Synthesize audio for an already-cached script only
      --sync                 Run writer+TTS synchronously, right here (no queue)
      --dry-run              Show what would happen; write nothing
      --verbose              Print per-transition detail
      --channels-root=PATH   Directory containing channel folders (tests)
      --series-root=PATH     Directory containing series/<id>/ (tests)
      --help                 Display this message

    USAGE;
}

/** @return array{positional: list<string>, options: array<string,string|bool>} */
function announce_parse_args(array $argv): array
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

function announce_date_bounds(array $opt): array
{
    $from = null;
    $to = null;
    if (isset($opt['date']) && is_string($opt['date'])) {
        $from = $opt['date'];
        $to = $opt['date'];
    }
    if (isset($opt['from']) && is_string($opt['from'])) {
        $from = $opt['from'];
    }
    if (isset($opt['to']) && is_string($opt['to'])) {
        $to = $opt['to'];
    }
    $fromTs = $from !== null ? (strtotime("$from 00:00:00 UTC") ?: null) : null;
    $toTs = $to !== null ? (strtotime("$to 23:59:59 UTC") ?: null) : null;
    return [$fromTs, $toTs];
}

function announce_discover_channels(string $channelsRoot): array
{
    $ids = [];
    foreach (glob("$channelsRoot/*/announcer.json") ?: [] as $path) {
        $ids[] = basename(dirname($path));
    }
    sort($ids);
    return $ids;
}

function announce_main(array $argv): int
{
    $parsed = announce_parse_args($argv);
    $opt = $parsed['options'];

    if (!empty($opt['help'])) {
        echo announce_usage();
        return 0;
    }

    $channelsRoot = isset($opt['channels-root']) ? (string) $opt['channels-root'] : ANNOUNCE_ROOT;
    $seriesRoot = isset($opt['series-root']) ? (string) $opt['series-root'] : dirname(ANNOUNCE_ROOT) . '/series';
    $announcerRoot = ANNOUNCE_ROOT . '/announcer';
    $repoRoot = dirname(ANNOUNCE_ROOT);

    $channelIds = [];
    if (!empty($opt['all-channels'])) {
        $channelIds = announce_discover_channels($channelsRoot);
        if (!$channelIds) {
            fwrite(STDERR, "No channel has an announcer.json -- nothing to do.\n");
            return 0;
        }
    } elseif (isset($opt['channel'])) {
        $channelIds = [(string) $opt['channel']];
    } else {
        echo announce_usage();
        fwrite(STDERR, "Error: --channel=ID or --all-channels is required.\n");
        return 1;
    }

    [$fromTs, $toTs] = announce_date_bounds($opt);
    $dryRun = !empty($opt['dry-run']);
    $verbose = !empty($opt['verbose']);
    $sync = !empty($opt['sync']);
    $forceScript = !empty($opt['force']) || !empty($opt['force-script']);
    $forceAudio = !empty($opt['force']) || !empty($opt['force-audio']);
    $scriptsOnly = !empty($opt['scripts-only']);
    $audioOnly = !empty($opt['audio-only']);
    $voiceOverride = isset($opt['voice']) ? (string) $opt['voice'] : null;

    $exitCode = 0;

    foreach ($channelIds as $channelId) {
        if (!preg_match('/^[a-z0-9][a-z0-9-]*$/', $channelId)) {
            fwrite(STDERR, "Error: invalid channel id \"$channelId\".\n");
            $exitCode = 1;
            continue;
        }
        if (!is_dir("$channelsRoot/$channelId")) {
            fwrite(STDERR, "Error: no such channel: $channelsRoot/$channelId\n");
            $exitCode = 1;
            continue;
        }

        $pipeline = new AnnouncerPipeline($channelsRoot, $announcerRoot, $seriesRoot, $repoRoot);
        $config = $pipeline->resolveConfig($channelId);
        if ($voiceOverride !== null) {
            $config['voice'] = $voiceOverride;
        }

        if (empty($config['enabled'])) {
            echo "[$channelId] announcer disabled (no announcer.json, or \"enabled\": false) -- skipping.\n";
            continue;
        }

        $contexts = $pipeline->buildContexts($channelId, $config);
        if ($fromTs !== null || $toTs !== null) {
            $contexts = array_values(array_filter($contexts, static function (array $c) use ($fromTs, $toTs): bool {
                $t = $c['scheduledStartTime'] ?? null;
                if ($t === null) {
                    return true; // e.g. channel_id -- not date-bound
                }
                return ($fromTs === null || $t >= $fromTs) && ($toTs === null || $t <= $toTs);
            }));
        }
        if (isset($opt['transition'])) {
            $wanted = array_map('trim', explode(',', (string) $opt['transition']));
            $contexts = array_values(array_filter($contexts, static fn (array $c): bool => in_array($c['transitionId'], $wanted, true)));
        }

        echo "[$channelId] " . count($contexts) . " eligible transition(s) (voice={$config['voice']}, types=" . implode(',', $config['types']) . ")\n";

        if ($dryRun) {
            foreach ($contexts as $context) {
                $scriptHash = ContentHash::scriptHash([
                    'type' => $context['type'], 'channelId' => $channelId, 'transitionId' => $context['transitionId'],
                    'fromProgramId' => $context['fromProgramId'] ?? null, 'toProgramId' => $context['toProgramId'] ?? null,
                    'toEpisodeId' => $context['toEpisodeId'] ?? null, 'currentBlock' => $context['currentBlock'] ?? null,
                    'nextBlock' => $context['nextBlock'] ?? null, 'seriesInfo' => $context['seriesInfo'] ?? null,
                    'episodeInfo' => $context['episodeInfo'] ?? null, 'isConsecutiveSameSeries' => $context['isConsecutiveSameSeries'] ?? false,
                    'style' => $config['style'] ?? null, 'tone' => $config['tone'] ?? null, 'targetDuration' => $config['targetDuration'] ?? null,
                    'wordsPerSecond' => $config['wordsPerSecond'] ?? null, 'writerProvider' => $config['writer']['provider'] ?? null,
                    'writerModel' => $config['writer']['model'] ?? null,
                ]);
                $cached = ScriptCache::get("$channelsRoot/$channelId", $scriptHash);
                $willReuse = $cached !== null;
                $label = $context['nextBlock']['title'] ?? ($context['type'] === 'channel_id' ? '(station id)' : '(no upcoming program)');
                printf(
                    "  - %-14s %-28s %-9s script=%s hash=%s\n",
                    $context['type'], $context['transitionId'], "-> $label", $willReuse ? 'REUSE' : 'GENERATE', substr($scriptHash, 0, 10),
                );
                if ($verbose) {
                    echo '    ' . json_encode($context, JSON_UNESCAPED_SLASHES) . "\n";
                }
            }
            continue;
        }

        if (!$sync) {
            $result = $pipeline->enqueueContexts($channelId, $contexts, $config);
            echo "[$channelId] enqueued={$result['enqueued']} reused={$result['reused']} (run announce-worker.php to process the queue)\n";
            continue;
        }

        // --sync: resolve the writer/TTS adapters for real and run every
        // context to completion right here.
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
        $audioProcessor = new AudioProcessor();

        $ok = 0;
        $failed = 0;
        foreach ($contexts as $context) {
            $scriptHash = ContentHash::scriptHash([
                'type' => $context['type'], 'channelId' => $channelId, 'transitionId' => $context['transitionId'],
                'fromProgramId' => $context['fromProgramId'] ?? null, 'toProgramId' => $context['toProgramId'] ?? null,
                'toEpisodeId' => $context['toEpisodeId'] ?? null, 'currentBlock' => $context['currentBlock'] ?? null,
                'nextBlock' => $context['nextBlock'] ?? null, 'seriesInfo' => $context['seriesInfo'] ?? null,
                'episodeInfo' => $context['episodeInfo'] ?? null, 'isConsecutiveSameSeries' => $context['isConsecutiveSameSeries'] ?? false,
                'style' => $config['style'] ?? null, 'tone' => $config['tone'] ?? null, 'targetDuration' => $config['targetDuration'] ?? null,
                'wordsPerSecond' => $config['wordsPerSecond'] ?? null, 'writerProvider' => $config['writer']['provider'] ?? null,
                'writerModel' => $config['writer']['model'] ?? null,
            ]);
            $payload = ['channelId' => $channelId, 'context' => $context, 'config' => $config, 'scriptHash' => $scriptHash];
            $result = $pipeline->runJob(
                $scriptHash, $payload, $primaryWriter, $fallbackWriter, $tts, $audioProcessor,
                $forceScript, $forceAudio, $scriptsOnly, $audioOnly,
            );
            if ($result['ok']) {
                $ok++;
                $text = $result['manifestRecord']['text'] ?? '(script cached, audio skipped)';
                echo "  OK    {$context['type']} {$context['transitionId']}: $text\n";
            } else {
                $failed++;
                echo "  FAIL  {$context['type']} {$context['transitionId']}: {$result['error']}\n";
            }
        }
        echo "[$channelId] sync run complete: ok=$ok failed=$failed\n";
        if ($failed > 0) {
            $exitCode = 1;
        }
    }

    return $exitCode;
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    exit(announce_main($argv));
}
