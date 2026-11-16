<?php
declare(strict_types=1);

umask(0002); // new files 664 / dirs 775 (dirs are setgid www-data): the web server and the CLI user both write these trees

// server/series-admin.php
//
// Backend for the admin UI's episode review/approval view
// (scheduler/js/components/cf-series-admin.js). Scans series/*/series.json
// (never hardcodes which series exist), lets an editor change an
// episode's editorial status and content rights, and can trigger
// youtube-import.php (refresh an existing series, or import a brand new
// one) as a subprocess, returning its summary output to the UI.
//
// See server/lib/AdminSupport.php for the shared access-control hook
// (currently a no-op -- see docs/admin-ui.md), id/path whitelisting, and
// the safe (argv-array, never shell-string) subprocess runner.
//
// GET  ?action=list                                    -> every series + its episodes
// POST {action:"save_episode", series_id, episode_id,
//       status, rights_status, rights_notes}            -> edits ONLY status/rights on one episode
// POST {action:"refresh", series_id, dry_run?}           -> youtube-import.php --refresh
// POST {action:"new_import", series_id, channel|channel_id|playlist,
//       title?, dry_run?}                                -> youtube-import.php (fresh import)
//
// Every write (save_episode) goes through YouTubeSeriesWriter -- the
// exact same class youtube-import.php itself uses, not a copy -- so the
// atomic-write/backup behavior and the file shape stay identical no
// matter which side writes it. save_episode never touches any
// YouTube-sourced field (duration/thumbnail/published_at/source.*,
// title, description, guests, episode_number) -- only status and rights,
// exactly like a human hand-editing the file would, which is also
// exactly what youtube-import.php's own refresh logic promises never to
// clobber.

require_once __DIR__ . '/lib/AdminSupport.php';
require_once __DIR__ . '/../youtube-import/src/YouTubeSeriesWriter.php';

final class AdminValidationError extends RuntimeException
{
}

const SERIES_ADMIN_STATUS_VALUES = ['candidate', 'approved', 'rejected', 'disabled'];
const SERIES_ADMIN_RIGHTS_VALUES = ['unverified', 'creator_permission', 'licensed', 'public_domain', 'restricted'];

/** @return list<array<string,mixed>> */
function series_admin_list(string $seriesDir = ADMIN_SERIES_DIR): array
{
    $out = [];
    foreach (admin_list_series_paths($seriesDir) as $id => $path) {
        $raw = json_decode((string) file_get_contents($path), true);
        if (!is_array($raw)) {
            continue;
        }
        $episodes = [];
        foreach (is_array($raw['episodes'] ?? null) ? $raw['episodes'] : [] as $ep) {
            if (!is_array($ep) || !is_string($ep['id'] ?? null)) {
                continue;
            }
            $source = is_array($ep['source'] ?? null) ? $ep['source'] : [];
            $rights = is_array($ep['rights'] ?? null) ? $ep['rights'] : [];
            $episodes[] = [
                'id' => $ep['id'],
                'episode_number' => $ep['episode_number'] ?? null,
                'title' => $ep['title'] ?? $ep['id'],
                'thumbnail_url' => $ep['thumbnail_url'] ?? null,
                'duration' => $ep['duration'] ?? null,
                'published_at' => $ep['published_at'] ?? null,
                'status' => $ep['status'] ?? null,
                'rights' => ['status' => $rights['status'] ?? null, 'notes' => $rights['notes'] ?? null],
                'source' => [
                    'provider' => $source['provider'] ?? null,
                    'url' => $source['url'] ?? null,
                    'channel_title' => $source['channel_title'] ?? null,
                    'availability' => $source['availability'] ?? null,
                ],
            ];
        }
        $source = is_array($raw['source'] ?? null) ? $raw['source'] : [];
        $out[] = [
            'id' => $id,
            'title' => $raw['title'] ?? $id,
            'description' => $raw['description'] ?? null,
            'creator' => $raw['creator'] ?? null,
            'thumbnail_url' => $raw['thumbnail_url'] ?? null,
            'source' => ['provider' => $source['provider'] ?? null, 'channel_url' => $source['channel_url'] ?? null, 'channel_id' => $source['channel_id'] ?? null, 'playlist_id' => $source['playlist_id'] ?? null],
            'episode_count' => count($episodes),
            'episodes' => $episodes,
        ];
    }
    return $out;
}

/** @return array<string,mixed> the saved {episode_id, status, rights} */
function series_admin_save_episode(array $body, string $seriesDir = ADMIN_SERIES_DIR): array
{
    $seriesId = $body['series_id'] ?? null;
    $path = admin_existing_series_path($seriesId, $seriesDir);
    if ($path === null) {
        throw new AdminValidationError('Unknown or invalid series_id.');
    }
    $episodeId = $body['episode_id'] ?? null;
    if (!is_string($episodeId) || $episodeId === '') {
        throw new AdminValidationError('episode_id is required.');
    }
    $status = $body['status'] ?? null;
    if (!in_array($status, SERIES_ADMIN_STATUS_VALUES, true)) {
        throw new AdminValidationError('status must be one of: ' . implode(', ', SERIES_ADMIN_STATUS_VALUES));
    }
    $rightsStatus = $body['rights_status'] ?? null;
    if (!in_array($rightsStatus, SERIES_ADMIN_RIGHTS_VALUES, true)) {
        throw new AdminValidationError('rights_status must be one of: ' . implode(', ', SERIES_ADMIN_RIGHTS_VALUES));
    }
    $notes = $body['rights_notes'] ?? null;
    if ($notes !== null && !is_string($notes)) {
        throw new AdminValidationError('rights_notes must be a string or null.');
    }
    if (is_string($notes) && strlen($notes) > 2000) {
        throw new AdminValidationError('rights_notes is too long (max 2000 characters).');
    }

    $series = YouTubeSeriesWriter::read($path);
    if ($series === null || !is_array($series['episodes'] ?? null)) {
        throw new RuntimeException("Could not read $path.");
    }

    $found = false;
    foreach ($series['episodes'] as $i => $ep) {
        if (is_array($ep) && ($ep['id'] ?? null) === $episodeId) {
            // Only these two fields are touched here; everything else (title,
            // description, duration, thumbnail_url, published_at, source.*,
            // guests, episode_number) is left as it was. This is the inverse of
            // youtube-import.php's refresh promise: an editor's edit here must
            // never clobber a YouTube-sourced field.
            $series['episodes'][$i]['status'] = $status;
            $series['episodes'][$i]['rights'] = ['status' => $rightsStatus, 'notes' => $notes];
            $found = true;
            break;
        }
    }
    if (!$found) {
        throw new AdminValidationError("No episode \"$episodeId\" in series \"$seriesId\".");
    }

    YouTubeSeriesWriter::write($path, $series);
    return ['episode_id' => $episodeId, 'status' => $status, 'rights' => ['status' => $rightsStatus, 'notes' => $notes]];
}

/** @return list<string> */
function series_admin_build_refresh_argv(string $seriesId, string $path, bool $dryRun): array
{
    $raw = json_decode((string) file_get_contents($path), true);
    $source = is_array($raw['source'] ?? null) ? $raw['source'] : [];
    $channelId = is_string($source['channel_id'] ?? null) && $source['channel_id'] !== '' ? $source['channel_id'] : null;
    $playlistId = is_string($source['playlist_id'] ?? null) && $source['playlist_id'] !== '' ? $source['playlist_id'] : null;

    $argv = [admin_php_binary(), ADMIN_ROOT . '/youtube-import/youtube-import.php'];
    if ($playlistId !== null) {
        $argv[] = "--playlist=$playlistId";
    } elseif ($channelId !== null) {
        $argv[] = "--channel-id=$channelId";
    } else {
        throw new AdminValidationError("Series \"$seriesId\" has no source.channel_id or source.playlist_id recorded; cannot refresh automatically.");
    }
    $argv[] = "--output=$path";
    $argv[] = "--series-id=$seriesId";
    $argv[] = '--refresh';
    $argv[] = '--verbose';
    if ($dryRun) {
        $argv[] = '--dry-run';
    }
    return $argv;
}

/** @return array{exitCode:int, stdout:string, stderr:string, dry_run:bool} */
function series_admin_refresh(array $body, string $seriesDir = ADMIN_SERIES_DIR): array
{
    $seriesId = $body['series_id'] ?? null;
    $path = admin_existing_series_path($seriesId, $seriesDir);
    if ($path === null) {
        throw new AdminValidationError('Unknown or invalid series_id.');
    }
    $dryRun = !empty($body['dry_run']);
    $argv = series_admin_build_refresh_argv((string) $seriesId, $path, $dryRun);
    $result = admin_run_subprocess($argv);
    return ['dry_run' => $dryRun] + $result;
}

/** @return list<string> */
function series_admin_build_import_argv(string $newSeriesId, string $outputPath, array $body, bool $dryRun): array
{
    $channel = $body['channel'] ?? null;
    $channelId = $body['channel_id'] ?? null;
    $playlist = $body['playlist'] ?? null;
    $given = array_filter([$channel, $channelId, $playlist], static fn ($v) => is_string($v) && $v !== '');
    if (count($given) !== 1) {
        throw new AdminValidationError('Pass exactly one of channel, channel_id, playlist.');
    }
    foreach ($given as $v) {
        // Not a filesystem path -- this is just a CLI flag value the
        // argv-array subprocess call passes through literally (see
        // admin_run_subprocess()'s header for why that's already safe
        // against shell injection) -- this is a basic sanity check
        // (length, no control characters), defense in depth, not the
        // real safety mechanism.
        if (strlen($v) > 200 || preg_match('/[\x00-\x1f]/', $v) === 1) {
            throw new AdminValidationError('Invalid channel/channel_id/playlist value.');
        }
    }

    $argv = [admin_php_binary(), ADMIN_ROOT . '/youtube-import/youtube-import.php'];
    if (is_string($channel) && $channel !== '') {
        $argv[] = "--channel=$channel";
    } elseif (is_string($channelId) && $channelId !== '') {
        $argv[] = "--channel-id=$channelId";
    } else {
        $argv[] = "--playlist=$playlist";
    }
    $argv[] = "--output=$outputPath";
    $argv[] = "--series-id=$newSeriesId";
    $title = $body['title'] ?? null;
    if (is_string($title) && $title !== '') {
        if (strlen($title) > 200) {
            throw new AdminValidationError('title is too long.');
        }
        $argv[] = "--title=$title";
    }
    $argv[] = '--verbose';
    if ($dryRun) {
        $argv[] = '--dry-run';
    }
    return $argv;
}

/** @return array{exitCode:int, stdout:string, stderr:string, dry_run:bool} */
function series_admin_new_import(array $body, string $seriesDir = ADMIN_SERIES_DIR): array
{
    $newSeriesId = $body['series_id'] ?? null;
    if (!is_string($newSeriesId) || $newSeriesId === '') {
        throw new AdminValidationError('series_id is required.');
    }
    $dryRun = !empty($body['dry_run']);
    $outputPath = admin_new_series_path($newSeriesId, $seriesDir);

    if ($outputPath === null) {
        if (!$dryRun) {
            throw new AdminValidationError("series_id \"$newSeriesId\" is invalid or already exists -- use the refresh action for an existing series.");
        }
        if (!admin_valid_id($newSeriesId)) {
            throw new AdminValidationError('series_id is invalid (lowercase letters, digits, dashes only).');
        }
        // A dry-run preview for an id that already exists previews what
        // a FRESH import would look like -- it deliberately never reads
        // or merges against the real existing file (a path that can't
        // exist is used instead), so a preview can never accidentally
        // depend on or reveal already-approved editorial content. The
        // real (non-dry-run) action above still hard-rejects this case
        // outright.
        $outputPath = "$seriesDir/$newSeriesId/.preview-only-series.json";
    }

    $argv = series_admin_build_import_argv($newSeriesId, $outputPath, $body, $dryRun);
    $result = admin_run_subprocess($argv);
    return ['dry_run' => $dryRun] + $result;
}

// ---------------------------------------------------------------------
// HTTP dispatch -- runs only when actually serving a web request, never
// when this file is `require`d by the test suite (SAPI is "cli" there).
// ---------------------------------------------------------------------
if (PHP_SAPI !== 'cli') {
    admin_require_auth();

    try {
        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $action = $_GET['action'] ?? null;
            if ($action === 'list') {
                admin_json_response(200, ['ok' => true, 'series' => series_admin_list()]);
            }
            admin_json_response(400, ['ok' => false, 'error' => 'Unknown GET action.']);
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $body = admin_read_json_body();
            $action = $body['action'] ?? null;
            $result = match ($action) {
                'save_episode' => series_admin_save_episode($body),
                'refresh' => series_admin_refresh($body),
                'new_import' => series_admin_new_import($body),
                default => throw new AdminValidationError('Unknown action.'),
            };
            admin_json_response(200, ['ok' => true] + $result);
        }

        admin_json_response(405, ['ok' => false, 'error' => 'GET or POST only.']);
    } catch (AdminValidationError $e) {
        admin_json_response(400, ['ok' => false, 'error' => $e->getMessage()]);
    } catch (Throwable $e) {
        admin_json_response(500, ['ok' => false, 'error' => $e->getMessage()]);
    }
}
