#!/usr/bin/env php
<?php
declare(strict_types=1);

umask(0002); // new files 664 / dirs 775 (dirs are setgid www-data): the web server and the CLI user both write these trees

// channels/publish.php
//
// Compiles a channel's recurring-series programming (channels/<id>/
// programming.json) into the schedule.json the player already reads, so no
// player code needs to know about recurrence rules, timezones or rotation:
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
// A channel with no programming.json is not touched; its schedule.json stays
// whatever ia-import (or a human) produced. For a channel with one, running
// this OVERWRITES schedule.json (atomically, keeping schedule.json.bak and
// meta.json.bak): it is a build artifact, not something to hand-edit.
//
// Rollover: the published window is fixed-length and does not extend itself.
// Once real time passes its end, the player repeats the last published window
// rather than going dark, but episode rotation does NOT advance until the
// window is regenerated. Re-run this (manually or from an external schedule
// such as a nightly cron; no daemon is built or required) comfortably before
// --days runs out. Running it again with the same or an overlapping window is
// idempotent: same approved-episode-set pin, same recurrence math, same
// output (aside from the "_publish.generated_at" timestamp).

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

// AI continuity announcer (channels/announcer/): opt-in per channel via
// channels/<id>/announcer.json; see that module's README.md. Required
// unconditionally since the module is a no-op for channels without that file.
require PUBLISH_ROOT . '/announcer/src/ContentHash.php';
require PUBLISH_ROOT . '/announcer/src/AnnouncerConfig.php';
require PUBLISH_ROOT . '/announcer/src/AnnouncementContextBuilder.php';
require PUBLISH_ROOT . '/announcer/src/AiWriterInterface.php';
require PUBLISH_ROOT . '/announcer/src/WriterPromptBuilder.php';
require PUBLISH_ROOT . '/announcer/src/TemplateAiWriter.php';
require PUBLISH_ROOT . '/announcer/src/TtsProviderInterface.php';
require PUBLISH_ROOT . '/announcer/src/AudioProcessor.php';
require PUBLISH_ROOT . '/announcer/src/JobQueue.php';
require PUBLISH_ROOT . '/announcer/src/ScriptCache.php';
require PUBLISH_ROOT . '/announcer/src/AudioCache.php';
require PUBLISH_ROOT . '/announcer/src/AnnouncementManifestWriter.php';
require PUBLISH_ROOT . '/announcer/src/AnnouncerPipeline.php';

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
    // --channels-root exists for the test suite (an isolated temp tree shaped like
    // channels/<id>/ + series/<id>/); real usage defaults to this file's directory.
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

    // Fallback tier 3 for program title/description ("what this block was last
    // published with"): read the existing schedule.json (if any) before it's
    // overwritten and index its "programs" by block_id. With none (a first
    // publish, or a schedule predating "programs"), ProgrammingCompiler falls
    // through to its next tier.
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

    // Resolved before compile() because ProgrammingCompiler needs
    // defaults.minimum_lead_in: it reserves that time at the front of every
    // occurrence it builds, not just the gaps ContinuityFiller fills afterward
    // (see ProgrammingCompiler::compile()'s $minimumLeadInSeconds). A channel
    // with no continuity.json reference gets 0.
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

    // Fill every remaining gap (including every reserved lead-in above) with
    // continuity occurrences, only if this channel's catalog.json references at
    // least one continuity.json; otherwise fill() returns its input unchanged.
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

        // AI continuity announcer: enqueue-only. It never calls an AI writer or
        // Kokoro here, so it can't slow or fail compilation (channels/announce-
        // worker.php does that work asynchronously). Opt-in per channel via
        // announcer.json. A failure here is reported but never fails an otherwise
        // successful publish; the schedule is already written and valid.
        try {
            $announcerRoot = PUBLISH_ROOT . '/announcer';
            $seriesRoot = dirname(PUBLISH_ROOT) . '/series';
            $pipeline = new AnnouncerPipeline($channelsRoot, $announcerRoot, $seriesRoot, dirname(PUBLISH_ROOT));
            $announcerResult = $pipeline->enqueueForSchedule($channelId);
            if (!empty($announcerResult['enabled'])) {
                if (isset($announcerResult['error'])) {
                    fwrite(STDERR, "Warning: announcer enqueue step: {$announcerResult['error']}\n");
                } else {
                    printf(
                        "Announcer: %d enqueued, %d reused (of %d eligible transition(s)). Run channels/announce-worker.php to process the queue.\n",
                        $announcerResult['enqueued'], $announcerResult['reused'], $announcerResult['contexts'],
                    );
                }
            }
        } catch (Throwable $e) {
            fwrite(STDERR, 'Warning: announcer enqueue step failed (the schedule itself was still published successfully): ' . $e->getMessage() . "\n");
        }
    }

    return 0;
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    exit(publish_main($argv));
}
