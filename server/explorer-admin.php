<?php
declare(strict_types=1);

// server/explorer-admin.php
//
// READ-ONLY backend for CRVideo Explorer (scheduler/js/components/explorer/).
// Explorer is a browser/inspector; this endpoint owns no data and writes
// nothing. It exists only because the existing series endpoint
// (series-admin.php?action=list) returns every episode of every series
// (~6 MB) and a single series.json can be 1.7 MB -- far too heavy for a
// navigation UI. These actions return compact projections of the same
// series/*/series.json files, nothing else.
//
// Same boundary as every other admin endpoint: admin_require_auth() first
// (see server/lib/AdminSupport.php and docs/admin-ui.md), ids validated
// against ADMIN_ID_PATTERN and the real filesystem, no filesystem paths in
// any response.
//
// GET ?action=series_index            -> every series, compact (no episodes)
// GET ?action=series&id=<series id>   -> one series with its episodes
// GET ?action=episode_index           -> id/title/duration/status per episode (search corpus)

require_once __DIR__ . '/lib/AdminSupport.php';

final class ExplorerAdminError extends RuntimeException
{
}

/** Counts of episodes per editorial status, e.g. ['approved' => 3, 'candidate' => 1]. */
function explorer_status_counts(array $episodes): array
{
    $counts = [];
    foreach ($episodes as $ep) {
        $status = is_array($ep) && is_string($ep['status'] ?? null) ? $ep['status'] : 'unknown';
        $counts[$status] = ($counts[$status] ?? 0) + 1;
    }
    ksort($counts);
    return $counts;
}

function explorer_read_series(string $path): ?array
{
    $raw = json_decode((string) file_get_contents($path), true);
    return is_array($raw) ? $raw : null;
}

function explorer_str(mixed $v, int $max = 4000): ?string
{
    return is_string($v) ? mb_substr($v, 0, $max) : null;
}

/** @return list<array<string,mixed>> */
function explorer_series_index(string $seriesDir = ADMIN_SERIES_DIR): array
{
    $out = [];
    foreach (admin_list_series_paths($seriesDir) as $id => $path) {
        $raw = explorer_read_series($path);
        if ($raw === null) {
            continue;
        }
        $episodes = is_array($raw['episodes'] ?? null) ? $raw['episodes'] : [];
        $source = is_array($raw['source'] ?? null) ? $raw['source'] : [];
        $out[] = [
            'id' => $id,
            'title' => explorer_str($raw['title'] ?? null, 300) ?? $id,
            'description' => explorer_str($raw['description'] ?? null, 600),
            'creator' => explorer_str($raw['creator'] ?? null, 300),
            'year' => $raw['year'] ?? null,
            'thumbnail_url' => explorer_str($raw['thumbnail_url'] ?? null, 1000),
            'logo_url' => explorer_str($raw['logo_url'] ?? null, 1000),
            'source_provider' => explorer_str($source['provider'] ?? null, 50),
            'episode_count' => count($episodes),
            'status_counts' => explorer_status_counts($episodes),
        ];
    }
    return $out;
}

/** @return array<string,mixed> */
function explorer_series_detail(mixed $id, string $seriesDir = ADMIN_SERIES_DIR): array
{
    $path = admin_existing_series_path($id, $seriesDir);
    if ($path === null) {
        throw new ExplorerAdminError('Unknown or invalid series id.');
    }
    $raw = explorer_read_series($path);
    if ($raw === null) {
        throw new ExplorerAdminError('Series file could not be read.');
    }

    $episodes = [];
    foreach (is_array($raw['episodes'] ?? null) ? $raw['episodes'] : [] as $ep) {
        if (!is_array($ep) || !is_string($ep['id'] ?? null)) {
            continue;
        }
        $src = is_array($ep['source'] ?? null) ? $ep['source'] : [];
        $rights = is_array($ep['rights'] ?? null) ? $ep['rights'] : [];
        $episodes[] = [
            'id' => $ep['id'],
            'episode_number' => $ep['episode_number'] ?? null,
            'title' => explorer_str($ep['title'] ?? null, 500) ?? $ep['id'],
            'description' => explorer_str($ep['description'] ?? null, 1500),
            'duration' => is_numeric($ep['duration'] ?? null) ? $ep['duration'] + 0 : null,
            'year' => $ep['year'] ?? null,
            'published_at' => explorer_str($ep['published_at'] ?? null, 40),
            'thumbnail_url' => explorer_str($ep['thumbnail_url'] ?? null, 1000),
            'creator' => explorer_str($ep['creator'] ?? null, 300),
            'guests' => is_array($ep['guests'] ?? null) ? array_slice(array_values(array_filter($ep['guests'], 'is_string')), 0, 20) : [],
            'status' => explorer_str($ep['status'] ?? null, 40),
            'rights' => [
                'status' => explorer_str($rights['status'] ?? null, 60),
                'notes' => explorer_str($rights['notes'] ?? null, 1000),
            ],
            'source' => [
                'provider' => explorer_str($src['provider'] ?? null, 50),
                'video_id' => explorer_str($src['video_id'] ?? null, 100),
                'url' => explorer_str($src['url'] ?? null, 1000),
                'channel_title' => explorer_str($src['channel_title'] ?? null, 300),
                'kind' => explorer_str($src['kind'] ?? null, 50),
                'embeddable' => isset($src['embeddable']) ? (bool) $src['embeddable'] : null,
                'made_for_kids' => isset($src['made_for_kids']) ? (bool) $src['made_for_kids'] : null,
                'privacy_status' => explorer_str($src['privacy_status'] ?? null, 50),
                'availability' => explorer_str($src['availability'] ?? null, 50),
                'availability_detail' => explorer_str($src['availability_detail'] ?? null, 500),
            ],
            'media_url' => explorer_str($ep['media_url'] ?? null, 1000),
        ];
    }
    $source = is_array($raw['source'] ?? null) ? $raw['source'] : [];
    $rotation = is_array($raw['rotation'] ?? null) ? $raw['rotation'] : [];
    return [
        'id' => (string) $id,
        'title' => explorer_str($raw['title'] ?? null, 300) ?? (string) $id,
        'description' => explorer_str($raw['description'] ?? null, 4000),
        'creator' => explorer_str($raw['creator'] ?? null, 300),
        'year' => $raw['year'] ?? null,
        'thumbnail_url' => explorer_str($raw['thumbnail_url'] ?? null, 1000),
        'logo_url' => explorer_str($raw['logo_url'] ?? null, 1000),
        'source' => [
            'provider' => explorer_str($source['provider'] ?? null, 50),
            'channel_url' => explorer_str($source['channel_url'] ?? null, 1000),
            'playlist_id' => explorer_str($source['playlist_id'] ?? null, 100),
        ],
        // The series' own default rotation hint (series.json "rotation") --
        // NOT any channel's actual rotation state (that lives in programming.json
        // and the published schedule; see docs/explorer.md).
        'rotation' => ['mode' => explorer_str($rotation['mode'] ?? null, 30), 'loop' => isset($rotation['loop']) ? (bool) $rotation['loop'] : null],
        'episode_count' => count($episodes),
        'status_counts' => explorer_status_counts($episodes),
        'episodes' => $episodes,
    ];
}

/** @return list<array{id:string,s:string,t:string,d:?int,st:?string}> */
function explorer_episode_index(string $seriesDir = ADMIN_SERIES_DIR): array
{
    $out = [];
    foreach (admin_list_series_paths($seriesDir) as $sid => $path) {
        $raw = explorer_read_series($path);
        if ($raw === null) {
            continue;
        }
        foreach (is_array($raw['episodes'] ?? null) ? $raw['episodes'] : [] as $ep) {
            if (!is_array($ep) || !is_string($ep['id'] ?? null)) {
                continue;
            }
            $out[] = [
                'id' => $ep['id'],
                's' => $sid,
                't' => explorer_str($ep['title'] ?? null, 300) ?? $ep['id'],
                'd' => is_numeric($ep['duration'] ?? null) ? (int) $ep['duration'] : null,
                'st' => explorer_str($ep['status'] ?? null, 40),
            ];
        }
    }
    return $out;
}

if (PHP_SAPI !== 'cli') {
    admin_require_auth();

    try {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            admin_json_response(405, ['ok' => false, 'error' => 'GET only; Explorer is read-only.']);
        }
        $action = $_GET['action'] ?? null;
        if ($action === 'series_index') {
            admin_json_response(200, ['ok' => true, 'series' => explorer_series_index()]);
        }
        if ($action === 'series') {
            admin_json_response(200, ['ok' => true, 'series' => explorer_series_detail($_GET['id'] ?? null)]);
        }
        if ($action === 'episode_index') {
            admin_json_response(200, ['ok' => true, 'episodes' => explorer_episode_index()]);
        }
        admin_json_response(400, ['ok' => false, 'error' => 'Unknown action.']);
    } catch (ExplorerAdminError $e) {
        admin_json_response(400, ['ok' => false, 'error' => $e->getMessage()]);
    } catch (Throwable $e) {
        // Never echo internal messages (they can contain filesystem paths).
        admin_json_response(500, ['ok' => false, 'error' => 'Internal error.']);
    }
}
