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
require PUBLISH_ROOT . '/publish/src/BoundaryResolver.php';
require PUBLISH_ROOT . '/publish/src/ContinuityResolver.php';
require PUBLISH_ROOT . '/publish/src/ContinuityFiller.php';
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

    // Phase 2 metadata fallback tier 3 ("the title/description this block was
    // last published with"): read whatever schedule.json this channel already
    // has (if any) before it gets overwritten below, and index its "programs"
    // collection by block_id. A channel publishing for the first time, or one
    // whose existing schedule.json predates this feature entirely, simply has
    // nothing here -- ProgrammingCompiler falls through to its next tier.
    $previousPrograms = [];
    $existingSchedulePath = "$channelDir/schedule.json";
    if (is_file($existingSchedulePath)) {
        $existingSchedule = json_decode((string) file_get_contents($existingSchedulePath), true);
        if (is_array($existingSchedule)) {
            foreach ($existingSchedule['programs'] ?? [] as $p) {
                $blockIdKey = is_string($p['block_id'] ?? null) ? $p['block_id'] : null;
                if ($blockIdKey !== null && !isset($previousPrograms[$blockIdKey])) {
                    $previousPrograms[$blockIdKey] = ['title' => $p['title'] ?? null, 'description' => $p['description'] ?? null];
                }
            }
        }
    }

    // Resolved BEFORE compile() (moved ahead of its previous position, right after
    // the Phase 4 gap-filling call below) because ProgrammingCompiler now also
    // needs defaults.minimum_lead_in -- it reserves that time at the front of
    // EVERY occurrence it builds, not just the leftover gaps ContinuityFiller
    // fills afterward. See ProgrammingCompiler::compile()'s $minimumLeadInSeconds
    // doc. A channel with no continuity.json reference still gets 0 here (this
    // call's own default), so it's completely unaffected either way.
    $continuity = ContinuityResolver::resolveCatalog($catalogPath);
    foreach ($continuity['errors'] as $e) {
        fwrite(STDERR, "Warning: $e\n");
    }

    try {
        $compiled = ProgrammingCompiler::compile(
            $programming, $resolved['series'], $stateDir, $channelId, $refresh, $windowStart, $windowEnd, $previousPrograms,
            $continuity['defaults']['minimumLeadIn'],
        );
    } catch (Throwable $e) {
        fwrite(STDERR, 'Error: ' . $e->getMessage() . "\n");
        return 1;
    }

    // Phase 4: fill every remaining gap (including every reserved lead-in above)
    // with continuity occurrences, if (and only if) this channel's catalog.json
    // references at least one continuity.json -- see ContinuityResolver/
    // ContinuityFiller's headers. A channel that doesn't is completely
    // unaffected: fill() hands back its input unchanged.
    $filled = ContinuityFiller::fill(
        $compiled['items'], $windowStart->getTimestamp(), $windowEnd->getTimestamp(), $continuity, $compiled['programs'],
    );
    $compiled['items'] = $filled['items'];
    $compiled['warnings'] = [...$compiled['warnings'], ...$filled['warnings']];

    PublishReporter::printSummary($channelId, $windowStart, $windowEnd, $compiled['items'], $compiled['warnings'], $dryRun, $verbose);

    if (!$dryRun) {
        ScheduleWriter::writeSchedule(
            "$channelDir/schedule.json", $channelName, $compiled['items'], $windowStart, $windowEnd, $compiled['episodeSets'], $compiled['programs'],
        );
        ScheduleWriter::updateAnchor($metaPath, $windowStart);
    }

    return 0;
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    exit(publish_main($argv));
}
