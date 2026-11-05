#!/usr/bin/env php
<?php
declare(strict_types=1);

// channels/ustv/build-schedule.php
//
// Converts ../../playlist.json -- the recurring, Drive-backed schedule
// sync-player.html already plays -- into this channel's schedule.json, so
// the same lineup shows up in the channel guide and watch.html too.
//
// No new provider/adapter needed: server/download-cache.php keeps the
// currently/next-airing Drive file as a plain, local, seekable mp4 in
// ../../cache/<driveFileId>.mp4 (see its remux step), so by the time a
// viewer tunes in here it's just another direct-file URL and plays through
// the existing Html5PlayerAdapter exactly like an archive.org file would --
// same as every other html5-provider channel (see channels/player-
// adapters.js's resolveProvider()).
//
// This channel's 24h cycle is anchored in meta.json ("anchor") to a
// Pacific-time midnight, matching playlist.json's own "timezone":
// "America/Los_Angeles" and startSec-since-local-midnight entries. Like
// every other anchor-based channel here, that offset isn't DST-corrected
// going forward (see broadcast.js's locate()) -- re-anchor meta.json if a
// DST change ever drifts this channel's clock by an hour.
//
// Re-run this (`php channels/ustv/build-schedule.php`) whenever
// playlist.json's lineup changes.

const ROOT = __DIR__ . '/../..';
const PLAYLIST_PATH = ROOT . '/playlist.json';
const OUTPUT_PATH = __DIR__ . '/schedule.json';

function main(): int
{
    $playlist = json_decode((string) file_get_contents(PLAYLIST_PATH), true);
    if (!is_array($playlist) || empty($playlist['recurring']) || !is_array($playlist['entries'] ?? null)) {
        fwrite(STDERR, "playlist.json must be the recurring {\"entries\": [...]} format.\n");
        return 1;
    }

    $entries = $playlist['entries'];
    usort($entries, static fn(array $a, array $b): int => $a['startSec'] <=> $b['startSec']);

    // Group consecutive entries into one block per distinct show (e.g. all
    // twelve "Midnight Movies (n/12)" parts) -- purely cosmetic, since
    // buildTimeline() in broadcast.js flattens every block back into one
    // flat, sorted list regardless, but it keeps schedule.json readable and
    // matches how ia-import/youtube-import group theirs.
    $blocks = [];
    $show = null;
    $blockStart = 0;
    foreach ($entries as $entry) {
        $title = (string) ($entry['title'] ?? $entry['id']);
        $name = preg_replace('/\s*\(\d+\/\d+\)\s*$/', '', $title) ?? $title;
        if ($show === null || $show !== $name) {
            $show = $name;
            $blockStart = (int) $entry['startSec'];
            $blocks[] = ['show' => $name, 'items' => []];
        }
        if (empty($entry['driveFileId'])) {
            fwrite(STDERR, "Skipping \"{$title}\": no driveFileId (only driveFileId entries are supported here).\n");
            continue;
        }
        $blocks[count($blocks) - 1]['items'][] = [
            'type' => 'video',
            'id' => $entry['id'],
            'start' => (int) $entry['startSec'] - $blockStart,
            'duration' => (int) $entry['endSec'] - (int) $entry['startSec'],
            'title' => $title,
            // Relative to channels/index.html and channels/watch.html (both
            // one level under the project root, same as ../cache/ is) --
            // not to this script's own location.
            'media_url' => "../cache/{$entry['driveFileId']}.mp4",
        ];
    }

    $schedule = ['channel' => 'USTV', 'blocks' => []];
    foreach ($blocks as $b) {
        if (!$b['items']) {
            continue;
        }
        $duration = array_sum(array_map(static fn(array $i): int => $i['duration'], $b['items']));
        $schedule['blocks'][] = ['duration' => $duration, 'items' => $b['items']];
    }

    $json = json_encode($schedule, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    file_put_contents(OUTPUT_PATH, $json . "\n");

    $itemCount = array_sum(array_map(static fn(array $b): int => count($b['items']), $schedule['blocks']));
    fwrite(STDOUT, 'Wrote ' . OUTPUT_PATH . ' (' . count($schedule['blocks']) . " blocks, {$itemCount} items)\n");
    return 0;
}

exit(main());
