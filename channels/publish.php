#!/usr/bin/env php
<?php
declare(strict_types=1);

// channels/publish.php
//
// Compiles a channel's recurring-series programming (channels/<id>/
// programming.json) into the existing schedule.json the player already
// knows how to read, so no player code needs to know about recurrence
// rules, timezones, or series rotation at all:
//
//   catalog.json (+ series/*/series.json)  --\
//   programming.json                          >--  publish.php  -->  schedule.json (+ meta.json's "anchor")
//   approved-episode-set pin (channels/<id>/.publish/)  --/
//
// Usage:
//   php channels/publish.php <channel-id> [options]
//
// Options:
//   --days=N                 Forward window length in days (default: 14)
//   --window-start=YYYY-MM-DD  Window start date (default: today, in --window-timezone)
//   --window-timezone=TZ      IANA timezone the window boundary and day-count are computed in (default: UTC)
//   --refresh-episode-set     Re-snapshot each block's approved-episode list from series.json right now
//                             (see src/EpisodeSetPin.php -- without this, a previously published block
//                             keeps using the exact episode set it was first published with)
//   --state-dir=PATH          Where approved-episode-set pins are kept (default: channels/<id>/.publish/)
//   --dry-run                 Print the report; write nothing
//   --verbose                 List every occurrence and warning, not just counts
//   --help                    Display this message
//
// A channel with no programming.json is not something this tool touches
// at all -- its schedule.json keeps being whatever ia-import (or a human)
// produced, exactly as before. Only channels that opt in with a
// programming.json are affected, and running this OVERWRITES that
// channel's schedule.json (atomically, keeping schedule.json.bak and
// meta.json.bak) -- for such a channel, schedule.json is a build
// artifact from this point on, the same way ia-import's schedule.json
// output is, not something to hand-edit.
//
// Rollover / regeneration: the published window is fixed-length and does
// not extend itself. Once real time passes the window's end, the
// channel's existing wall-clock-cycle player behavior repeats the last
// published window rather than going dark -- but episode rotation does
// NOT keep advancing while that happens (the window has to actually be
// regenerated for rotation to continue). Re-run this command again
// (manually, or on a schedule you set up outside this tool -- e.g. a
// nightly cron calling it for every channel with a programming.json --
// no daemon/background worker is built or required here) comfortably
// before --days runs out to produce the next window; running it with the
// same (or an overlapping) window is idempotent -- same approved-episode-
// set pin, same recurrence math, same output (aside from the "_publish.
// generated_at" timestamp).

const PUBLISH_ROOT = __DIR__;

require PUBLISH_ROOT . '/publish/src/CatalogResolver.php';
require PUBLISH_ROOT . '/publish/src/Recurrence.php';
require PUBLISH_ROOT . '/publish/src/EpisodeSetPin.php';
require PUBLISH_ROOT . '/publish/src/RotationState.php';
require PUBLISH_ROOT . '/publish/src/EpisodePacker.php';
require PUBLISH_ROOT . '/publish/src/ProgrammingCompiler.php';
require PUBLISH_ROOT . '/publish/src/ScheduleWriter.php';
require PUBLISH_ROOT . '/publish/src/PublishReporter.php';

function publish_usage(): string
{
    return <<<USAGE
    CRVideo channel publisher -- compiles recurring-series programming into schedule.json

    Usage:
      php publish.php <channel-id> [options]

    Options:
      --days=N                   Forward window length in days (default: 14)
      --window-start=YYYY-MM-DD  Window start date (default: today, in --window-timezone)
      --window-timezone=TZ       Timezone the window boundary is computed in (default: UTC)
      --refresh-episode-set      Re-snapshot each block's approved-episode list right now
      --state-dir=PATH           Where approved-episode-set pins are kept (default: <channel>/.publish/)
      --channels-root=PATH       Directory containing channel folders (default: this script's own directory)
      --dry-run                  Print the report; write nothing
      --verbose                  List every occurrence and warning
      --help                     Display this message

    USAGE;
}

/** @return array{positional: list<string>, options: array<string,string|bool>} */
function publish_parse_args(array $argv): array
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

function publish_main(array $argv): int
{
    $parsed = publish_parse_args($argv);
    $opt = $parsed['options'];

    if (!empty($opt['help']) || !$parsed['positional']) {
        echo publish_usage();
        return empty($opt['help']) ? 1 : 0;
    }

    $channelId = $parsed['positional'][0];
    if (!preg_match('/^[a-z0-9][a-z0-9-]*$/', $channelId)) {
        fwrite(STDERR, "Error: invalid channel id \"$channelId\".\n");
        return 1;
    }
    // --channels-root exists for the test suite (an isolated temp directory
    // tree shaped like channels/<id>/ + series/<id>/), so tests never touch
    // the real repo; real usage never needs it (default: this file's own
    // directory, i.e. the real channels/).
    $channelsRoot = isset($opt['channels-root']) ? (string) $opt['channels-root'] : PUBLISH_ROOT;
    $channelDir = "$channelsRoot/$channelId";
    if (!is_dir($channelDir)) {
        fwrite(STDERR, "Error: no such channel: $channelDir\n");
        return 1;
    }

    $programmingPath = "$channelDir/programming.json";
    if (!is_file($programmingPath)) {
        fwrite(STDERR, "Error: $programmingPath not found -- this channel has no recurring-series programming to publish.\n");
        return 1;
    }
    $programming = json_decode((string) file_get_contents($programmingPath), true);
    if (!is_array($programming)) {
        fwrite(STDERR, "Error: $programmingPath is not valid JSON.\n");
        return 1;
    }

    $metaPath = "$channelDir/meta.json";
    $meta = is_file($metaPath) ? json_decode((string) file_get_contents($metaPath), true) : null;
    if (!is_array($meta)) {
        fwrite(STDERR, "Error: $metaPath is missing or not valid JSON.\n");
        return 1;
    }
    $channelName = is_string($meta['name'] ?? null) ? $meta['name'] : $channelId;

    $catalogPath = "$channelDir/catalog.json";
    $resolved = CatalogResolver::resolveCatalog($catalogPath);
    foreach ($resolved['errors'] as $e) {
        fwrite(STDERR, "Warning: $e\n");
    }

    $days = isset($opt['days']) ? max(1, (int) $opt['days']) : 14;
    $tzName = isset($opt['window-timezone']) ? (string) $opt['window-timezone'] : 'UTC';
    try {
        $tz = new DateTimeZone($tzName);
    } catch (Throwable $e) {
        fwrite(STDERR, "Error: invalid --window-timezone \"$tzName\": " . $e->getMessage() . "\n");
        return 1;
    }
    $windowStartDate = isset($opt['window-start']) ? (string) $opt['window-start'] : gmdate('Y-m-d');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $windowStartDate)) {
        fwrite(STDERR, "Error: --window-start must be \"YYYY-MM-DD\", got: \"$windowStartDate\"\n");
        return 1;
    }

    try {
        $windowStart = new DateTimeImmutable("$windowStartDate 00:00:00", $tz);
    } catch (Throwable $e) {
        fwrite(STDERR, 'Error: invalid --window-start: ' . $e->getMessage() . "\n");
        return 1;
    }
    $windowEnd = $windowStart->modify(sprintf('+%d day', $days));

    $stateDir = isset($opt['state-dir']) ? (string) $opt['state-dir'] : "$channelDir/.publish";
    $refresh = !empty($opt['refresh-episode-set']);
    $dryRun = !empty($opt['dry-run']);
    $verbose = !empty($opt['verbose']);

    try {
        $compiled = ProgrammingCompiler::compile(
            $programming, $resolved['series'], $stateDir, $channelId, $refresh, $windowStart, $windowEnd,
        );
    } catch (Throwable $e) {
        fwrite(STDERR, 'Error: ' . $e->getMessage() . "\n");
        return 1;
    }

    PublishReporter::printSummary($channelId, $windowStart, $windowEnd, $compiled['items'], $compiled['warnings'], $dryRun, $verbose);

    if (!$dryRun) {
        ScheduleWriter::writeSchedule(
            "$channelDir/schedule.json", $channelName, $compiled['items'], $windowStart, $windowEnd, $compiled['episodeSets'],
        );
        ScheduleWriter::updateAnchor($metaPath, $windowStart);
    }

    return 0;
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    exit(publish_main($argv));
}
