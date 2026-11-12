#!/usr/bin/env php
<?php
declare(strict_types=1);

// youtube-import/youtube-import.php
//
// Standalone CLI: imports a YouTube channel's uploads or a specific
// playlist via the official YouTube Data API v3 (metadata only -- no
// video files are ever fetched, no watch pages are scraped, no yt-dlp),
// and writes/refreshes a portable series.json (see series/*/series.json).
// No framework, no Composer: plain PHP, manually required, in the same style
// as ia-import/ia-import.php.
//
// Importing never publishes anything: every new video becomes a
// "candidate" episode. See src/YouTubeSeriesBuilder.php for exactly which
// fields a refresh is and isn't allowed to touch.

const YT_ROOT = __DIR__;

require YT_ROOT . '/src/YouTubeApiException.php';
require YT_ROOT . '/src/YouTubeCredentials.php';
require YT_ROOT . '/src/YouTubeIso8601Duration.php';
require YT_ROOT . '/src/YouTubeApiClient.php';
require YT_ROOT . '/src/YouTubeVideoClassifier.php';
require YT_ROOT . '/src/YouTubeSeriesBuilder.php';
require YT_ROOT . '/src/YouTubeSeriesWriter.php';
require YT_ROOT . '/src/YouTubeImportReporter.php';

function yt_import_usage(): string
{
    return <<<USAGE
    YouTube Channel / Playlist Importer -- writes a portable series.json

    Usage:
      php youtube-import.php --channel="@SomeChannel" --output=series/some-channel/series.json
      php youtube-import.php --channel-id=UCxxxxxxxxxxxxxxxxxxxxxx --output=series/x/series.json
      php youtube-import.php --playlist=PLxxxxxxxxxxxxxxxxxxxxxxxx --output=series/x/series.json

    Options:
      --channel=HANDLE_OR_USERNAME  Channel to import, by "@handle" or legacy username
      --channel-id=ID                Channel to import, by its canonical UC... id (skips handle lookup)
      --playlist=ID                  Playlist to import directly (ignored if --channel/--channel-id given)
      --output=PATH                  series.json to write/refresh (required)
      --series-id=ID                  Override the series "id" (default: the --output directory's name)
      --title=TITLE                   Override the series title (default: the channel/playlist's own title)
      --max-videos=N                  Stop after discovering N videos
      --refresh                       Also re-check videos previously marked unavailable/deleted/private
                                       (skipped by default to save API quota -- newly discovered and still-
                                       available videos are always refreshed regardless of this flag)
      --dry-run                       Print the summary of what would change; write nothing
      --verbose                       List every added/updated/unavailable episode id, not just counts
      --config=PATH                   Path to a local PHP file returning ['api_key' => '...']
                                       (default: youtube-import/config.local.php; see "Credentials" below)
      --timeout=SECONDS               Request timeout (default: 15)
      --fixtures=DIR                  Serve API responses from DIR/*.json instead of the network
                                       (see tests/ -- no live network access required)
      --help                          Display this message

    Credentials (never pass an API key on the command line -- it would be
    visible to other processes via `ps`):
      1. YOUTUBE_API_KEY environment variable, or
      2. an untracked PHP file (default youtube-import/config.local.php,
         override with --config) containing:
           <?php
           return ['api_key' => 'YOUR_YOUTUBE_DATA_API_V3_KEY'];

    Importing never publishes anything: every new video is written with
    status "candidate". A refresh matches existing episodes by YouTube
    video id, updates only YouTube-sourced fields (duration, thumbnail,
    published date, availability, etc.), and never touches an editor's
    title/description/guests/status/rights/episode order. Episodes that
    no longer resolve are marked unavailable, never deleted. Writes are
    atomic and the previous version is kept as "<output>.bak".

    USAGE;
}

/**
 * Reads a value-bearing option, or returns null if it was never passed.
 * Returns false (and writes a clear stderr error) if the flag was given
 * as a bare switch instead of `--name=value` -- almost always a typo
 * like `--output PATH` (space-separated) instead of `--output=PATH`,
 * which would otherwise silently become the string "1" and the real
 * path would be dropped as a stray positional argument.
 */
function yt_import_string_option(array $opt, string $name): string|false|null
{
    if (!isset($opt[$name])) {
        return null;
    }
    if ($opt[$name] === true) {
        fwrite(STDERR, "Error: --$name requires a value -- use --$name=VALUE, not a bare flag or a space-separated value.\n");
        return false;
    }
    return (string) $opt[$name];
}

/** @return array{positional: list<string>, options: array<string,string|bool>} */
function yt_import_parse_args(array $argv): array
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

/** Builds a fixture-backed HTTP transport for --fixtures=DIR: no live
 *  network access, used by the CLI end-to-end tests. Dispatches purely on
 *  the request path (and, for playlistItems, the pageToken) so a handful
 *  of canned JSON files can stand in for the whole API surface this tool
 *  uses. */
function yt_import_fixture_transport(string $dir): \Closure
{
    return function (string $url, int $timeoutSeconds) use ($dir): array {
        $path = (string) parse_url($url, PHP_URL_PATH);
        $query = [];
        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);

        $file = match (true) {
            str_ends_with($path, '/channels') => 'channels.json',
            str_ends_with($path, '/playlists') => 'playlists.json',
            str_ends_with($path, '/playlistItems') => (($query['pageToken'] ?? '') === 'PAGE2') ? 'playlistItems-2.json' : 'playlistItems-1.json',
            str_ends_with($path, '/videos') => 'videos.json',
            default => null,
        };

        $full = $file !== null ? (rtrim($dir, '/') . '/' . $file) : null;
        if ($full === null || !is_file($full)) {
            return ['status' => 404, 'body' => json_encode(['error' => ['code' => 404, 'message' => "no fixture for $path"]]), 'error' => null];
        }
        return ['status' => 200, 'body' => (string) file_get_contents($full), 'error' => null];
    };
}

function yt_import_main(array $argv): int
{
    $parsed = yt_import_parse_args($argv);
    $opt = $parsed['options'];

    if (!empty($opt['help'])) {
        echo yt_import_usage();
        return 0;
    }

    $channel = yt_import_string_option($opt, 'channel');
    $channelId = yt_import_string_option($opt, 'channel-id');
    $playlist = yt_import_string_option($opt, 'playlist');
    $outputPath = yt_import_string_option($opt, 'output');
    $seriesIdOpt = yt_import_string_option($opt, 'series-id');
    $titleOverride = yt_import_string_option($opt, 'title');
    $maxVideosOpt = yt_import_string_option($opt, 'max-videos');
    $timeoutOpt = yt_import_string_option($opt, 'timeout');
    $fixturesDir = yt_import_string_option($opt, 'fixtures');
    $configPath = yt_import_string_option($opt, 'config');
    if (in_array(false, [$channel, $channelId, $playlist, $outputPath, $seriesIdOpt, $titleOverride, $maxVideosOpt, $timeoutOpt, $fixturesDir, $configPath], true)) {
        return 1;
    }

    $given = array_filter([$channel, $channelId, $playlist], static fn ($v) => $v !== null);
    if (count($given) !== 1) {
        fwrite(STDERR, "Error: pass exactly one of --channel, --channel-id, --playlist.\n");
        return 1;
    }
    if ($outputPath === null || $outputPath === '') {
        fwrite(STDERR, "Error: --output=PATH is required.\n");
        return 1;
    }

    $seriesId = $seriesIdOpt ?? basename(rtrim(dirname($outputPath), '/'));
    $maxVideos = $maxVideosOpt !== null ? max(1, (int) $maxVideosOpt) : null;
    $refresh = !empty($opt['refresh']);
    $dryRun = !empty($opt['dry-run']);
    $verbose = !empty($opt['verbose']);
    $timeout = $timeoutOpt !== null ? max(1, (int) $timeoutOpt) : 15;

    $creds = YouTubeCredentials::resolve($configPath);
    if ($creds['apiKey'] === null) {
        fwrite(STDERR, 'Error: ' . $creds['error'] . "\n");
        return 1;
    }

    $httpClient = $fixturesDir !== null ? yt_import_fixture_transport($fixturesDir) : null;
    $log = function (string $msg) use ($verbose): void {
        if ($verbose) {
            fwrite(STDERR, "[verbose] $msg\n");
        }
    };
    $client = new YouTubeApiClient($creds['apiKey'], $timeout, $httpClient, $log);

    try {
        $sourceContext = ['provider' => 'youtube', 'channel_id' => null, 'channel_title' => null, 'playlist_id' => null];
        $defaultTitle = $seriesId;
        $defaultDescription = '';
        $defaultThumbnail = null;
        $channelUrl = null;

        if ($playlist !== null) {
            $meta = $client->getPlaylistMeta($playlist);
            $sourceContext['channel_id'] = $meta['channelId'];
            $sourceContext['channel_title'] = $meta['channelTitle'];
            $sourceContext['playlist_id'] = $playlist;
            $defaultTitle = $meta['title'] ?? $defaultTitle;
            $defaultDescription = $meta['description'] ?? $defaultDescription;
            $playlistId = $playlist;
        } else {
            $resolved = $client->resolveChannel((string) ($channelId ?? $channel), $channelId !== null);
            $sourceContext['channel_id'] = $resolved['channelId'];
            $sourceContext['channel_title'] = $resolved['title'];
            $defaultTitle = $resolved['title'] ?? $defaultTitle;
            $defaultDescription = $resolved['description'] ?? $defaultDescription;
            $defaultThumbnail = $resolved['thumbnailUrl'];
            $channelUrl = 'https://www.youtube.com/channel/' . $resolved['channelId'];
            if ($resolved['uploadsPlaylistId'] === null) {
                fwrite(STDERR, "Error: channel {$resolved['channelId']} has no uploads playlist.\n");
                return 1;
            }
            $playlistId = $resolved['uploadsPlaylistId'];
        }

        $discoveredPairs = $client->listPlaylistVideoIds($playlistId, $maxVideos);
        $discoveredOrder = array_values(array_unique(array_column($discoveredPairs, 'videoId')));
        $log('discovered ' . count($discoveredOrder) . ' video id(s)');

        $existingSeries = YouTubeSeriesWriter::read($outputPath);
        $existingVideoIds = [];
        $existingUnavailable = [];
        foreach ($existingSeries['episodes'] ?? [] as $ep) {
            $vid = $ep['source']['video_id'] ?? null;
            if (!is_string($vid)) {
                continue;
            }
            $existingVideoIds[] = $vid;
            if (($ep['source']['availability'] ?? null) === 'unavailable') {
                $existingUnavailable[$vid] = true;
            }
        }

        $toCheck = $discoveredOrder;
        foreach ($existingVideoIds as $vid) {
            if (isset($existingUnavailable[$vid]) && !$refresh) {
                continue; // quota-saving skip; carried forward unchanged by the builder
            }
            $toCheck[] = $vid;
        }
        $toCheck = array_values(array_unique($toCheck));

        $detailsRaw = $toCheck ? $client->getVideosDetails($toCheck) : [];
        $videosById = [];
        foreach ($toCheck as $vid) {
            $videosById[$vid] = $detailsRaw[$vid] ?? null;
        }

        $seriesDefaults = [
            'schema_version' => 1,
            'id' => $seriesId,
            'title' => $titleOverride ?? $defaultTitle,
            'description' => $defaultDescription,
            'creator' => null,
            'year' => null,
            'thumbnail_url' => $defaultThumbnail,
            'logo_url' => null,
            'source' => [
                'provider' => 'youtube',
                'channel_id' => $sourceContext['channel_id'],
                'channel_url' => $channelUrl,
                'playlist_id' => $sourceContext['playlist_id'],
            ],
            'rotation' => ['mode' => 'sequential', 'loop' => true],
            'episodes' => [],
        ];

        $result = YouTubeSeriesBuilder::build($existingSeries, $seriesDefaults, $discoveredOrder, $videosById, $sourceContext);

        YouTubeImportReporter::printSummary($seriesId, $outputPath, $result['summary'], $dryRun, $verbose);

        if (!$dryRun) {
            YouTubeSeriesWriter::write($outputPath, $result['series']);
        }

        return 0;
    } catch (YouTubeApiException $e) {
        fwrite(STDERR, 'Error [' . $e->kind . ']: ' . $e->getMessage() . "\n");
        return 1;
    } catch (Throwable $e) {
        fwrite(STDERR, 'Error: ' . $e->getMessage() . "\n");
        return 1;
    }
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    exit(yt_import_main($argv));
}
