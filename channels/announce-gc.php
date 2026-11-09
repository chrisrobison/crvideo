#!/usr/bin/env php
<?php
declare(strict_types=1);

// channels/announce-gc.php
//
// Garbage collector for the AI continuity announcer's disk footprint
// (channels/announcer/src/AnnouncerGc.php -- see its docblock for *why*
// this is a mark-and-sweep against the live manifest and NOT a
// date-based "delete anything older than N days" pass: the audio/script
// caches are content-addressed, so a file's age has no bearing on
// whether something scheduled far in the future still needs it).
//
// Meant to be run nightly via cron, right after publish.php's rolling
// schedule recompile and announce-worker.php's catch-up pass -- same
// "cheap, idempotent, cron-invoked CLI script" posture as
// server/download-cache.php, wrapped in `flock -n` exactly like that
// script's own crontab line (see channels/announcer/README.md).
//
// Usage:
//   php channels/announce-gc.php [options]
//
// Options:
//   --channel=ID            Only this channel (default: every channel
//                            with an announcer.json OR leftover
//                            media/announcements/<id>/ or .announcer/
//                            state from before it was disabled)
//   --grace-hours=N          Skip audio/script files newer than this many
//                            hours, so an in-flight write never races a
//                            manifest upsert that hasn't landed yet
//                            (default: 2)
//   --job-retention-days=N  Delete done/error job-queue records older
//                            than this many days (default: 14)
//   --dry-run                Report what would be removed; delete nothing
//   --verbose                List every file removed, not just totals
//   --channels-root=PATH     Directory containing channel folders (tests)
//   --help                   Display this message
//
// Suggested cron entry (nightly, after publish + the announce worker,
// never overlapping itself):
//   30 3 * * * flock -n /tmp/crvideo-announce-gc.lock php /path/to/channels/announce-gc.php >> /path/to/channels/announce-gc.log 2>&1

const GC_ROOT = __DIR__;

require GC_ROOT . '/announcer/src/ContentHash.php';
require GC_ROOT . '/announcer/src/AnnouncerConfig.php';
require GC_ROOT . '/announcer/src/ScriptCache.php';
require GC_ROOT . '/announcer/src/AudioCache.php';
require GC_ROOT . '/announcer/src/AnnouncementManifestWriter.php';
require GC_ROOT . '/announcer/src/AnnouncerGc.php';

function gc_usage(): string
{
    return <<<USAGE
    CRVideo continuity announcer garbage collector -- sweeps audio/script
    cache files no longer referenced by any channel's current
    announcements.json, plus aging out old job-queue history.

    Usage:
      php announce-gc.php [options]

    Options:
      --channel=ID            Only this channel (default: every channel with
                               an announcer.json or leftover announcer state)
      --grace-hours=N          Skip files newer than this many hours (default: 2)
      --job-retention-days=N  Delete done/error job records older than this
                               many days (default: 14)
      --dry-run                Report what would be removed; delete nothing
      --verbose                List every file removed, not just totals
      --channels-root=PATH     Directory containing channel folders (tests)
      --help                   Display this message

    USAGE;
}

/** @return array{positional: list<string>, options: array<string,string|bool>} */
function gc_parse_args(array $argv): array
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

/** Every channel with an announcer.json, UNIONED with every channel that
 *  still has leftover announcer state (media/announcements/<id>/ or
 *  .announcer/) even if its announcer.json was since removed/disabled --
 *  otherwise disabling a channel would orphan its cache forever, exactly
 *  the kind of leak this tool exists to close. */
function gc_discover_channels(string $channelsRoot, string $repoRoot): array
{
    $ids = [];
    foreach (glob("$channelsRoot/*/announcer.json") ?: [] as $path) {
        $ids[basename(dirname($path))] = true;
    }
    foreach (glob("$channelsRoot/*/.announcer") ?: [] as $path) {
        if (is_dir($path)) {
            $ids[basename(dirname($path))] = true;
        }
    }
    foreach (glob("$repoRoot/media/announcements/*") ?: [] as $path) {
        if (is_dir($path)) {
            $ids[basename($path)] = true;
        }
    }
    $list = array_keys($ids);
    sort($list);
    return $list;
}

function gc_format_bytes(int $bytes): string
{
    if ($bytes < 1024) {
        return "{$bytes}B";
    }
    $units = ['KB', 'MB', 'GB', 'TB'];
    $value = $bytes / 1024;
    foreach ($units as $unit) {
        if ($value < 1024 || $unit === 'TB') {
            return sprintf('%.1f%s', $value, $unit);
        }
        $value /= 1024;
    }
    return "{$bytes}B";
}

function gc_main(array $argv): int
{
    $parsed = gc_parse_args($argv);
    $opt = $parsed['options'];

    if (!empty($opt['help'])) {
        echo gc_usage();
        return 0;
    }

    $channelsRoot = isset($opt['channels-root']) ? (string) $opt['channels-root'] : GC_ROOT;
    $announcerRoot = GC_ROOT . '/announcer';
    $repoRoot = dirname(GC_ROOT);

    $graceHours = isset($opt['grace-hours']) ? max(0, (float) $opt['grace-hours']) : 2.0;
    $jobRetentionDays = isset($opt['job-retention-days']) ? max(0, (float) $opt['job-retention-days']) : 14.0;
    $graceSeconds = (int) round($graceHours * 3600);
    $jobRetentionSeconds = (int) round($jobRetentionDays * 86400);
    $dryRun = !empty($opt['dry-run']);
    $verbose = !empty($opt['verbose']);

    $channelIds = isset($opt['channel'])
        ? [(string) $opt['channel']]
        : gc_discover_channels($channelsRoot, $repoRoot);

    if (!$channelIds) {
        echo "No channel has announcer state -- nothing to do.\n";
        return 0;
    }

    $totalAudioBytes = 0;
    $totalAudioFiles = 0;
    $totalScriptFiles = 0;
    $totalJobFiles = 0;
    $hadErrors = false;

    foreach ($channelIds as $channelId) {
        $channelDir = "$channelsRoot/$channelId";
        if (!is_dir($channelDir)) {
            fwrite(STDERR, "Error: no such channel: $channelDir\n");
            $hadErrors = true;
            continue;
        }

        $config = AnnouncerConfig::resolve($channelId, $channelsRoot, $announcerRoot);
        $audioCache = new AudioCache($repoRoot, (string) ($config['mediaRoot'] ?? 'media/announcements'));
        $mediaDir = $audioCache->absoluteDir($channelId);

        $result = AnnouncerGc::sweepChannel($channelId, $channelDir, $mediaDir, $graceSeconds, $jobRetentionSeconds, $dryRun);

        $audioN = count($result['audioRemoved']);
        $scriptN = count($result['scriptsRemoved']);
        $jobN = count($result['jobsRemoved']);
        $totalAudioBytes += $result['audioBytes'];
        $totalAudioFiles += $audioN;
        $totalScriptFiles += $scriptN;
        $totalJobFiles += $jobN;

        $verb = $dryRun ? 'would remove' : 'removed';
        echo "[$channelId] $verb: $audioN audio (" . gc_format_bytes($result['audioBytes']) . "), $scriptN script(s), $jobN job record(s)\n";
        if ($verbose) {
            foreach ($result['audioRemoved'] as $p) {
                echo "    audio   $p\n";
            }
            foreach ($result['scriptsRemoved'] as $p) {
                echo "    script  $p\n";
            }
            foreach ($result['jobsRemoved'] as $p) {
                echo "    job     $p\n";
            }
        }
        foreach ($result['errors'] as $err) {
            fwrite(STDERR, "[$channelId] ERROR: $err\n");
            $hadErrors = true;
        }
    }

    $verb = $dryRun ? 'Would reclaim' : 'Reclaimed';
    echo "$verb " . gc_format_bytes($totalAudioBytes) . " across $totalAudioFiles audio file(s), "
        . "$totalScriptFiles script cache file(s), $totalJobFiles job record(s).\n";

    return $hadErrors ? 1 : 0;
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    exit(gc_main($argv));
}
