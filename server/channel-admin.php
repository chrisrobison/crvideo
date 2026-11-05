<?php
declare(strict_types=1);

// server/channel-admin.php
//
// Backend for the admin UI's channel/programming management view
// (scheduler/js/components/cf-channel-admin.js). Scans channels/*/meta.json
// (never hardcodes which channels exist), lets an editor edit a channel's
// catalog.json series references and programming.json recurring blocks,
// and can trigger channels/publish.php (dry-run preview or a real
// publish) as a subprocess.
//
// See server/lib/AdminSupport.php for the shared access-control hook
// (currently a no-op -- see docs/admin-ui.md), id/path whitelisting, and
// the safe (argv-array, never shell-string) subprocess runner.
//
// GET  ?action=list                                          -> every channel + its catalog series refs + programming blocks
// POST {action:"save_catalog", channel_id, series_ids}        -> rewrites catalog.json's "series" array
// POST {action:"save_programming", channel_id, blocks}        -> rewrites programming.json's "blocks" array
// POST {action:"publish", channel_id, dry_run, days?,
//       window_start?, window_timezone?}                      -> channels/publish.php

require_once __DIR__ . '/lib/AdminSupport.php';
require_once __DIR__ . '/../channels/publish/src/Recurrence.php';
require_once __DIR__ . '/../channels/publish/src/EpisodePacker.php';
require_once __DIR__ . '/../channels/publish/src/BoundaryResolver.php';

final class ChannelAdminValidationError extends RuntimeException
{
}

const CHANNEL_ADMIN_FREQUENCIES = ['daily', 'weekly', 'monthly'];
const CHANNEL_ADMIN_WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** @return list<array<string,mixed>> */
function channel_admin_list(string $channelsDir = ADMIN_CHANNELS_DIR, string $seriesDir = ADMIN_SERIES_DIR): array
{
    $out = [];
    foreach (admin_list_channel_dirs($channelsDir) as $id => $dir) {
        $meta = is_file("$dir/meta.json") ? json_decode((string) file_get_contents("$dir/meta.json"), true) : null;
        $meta = is_array($meta) ? $meta : [];
        $catalog = is_file("$dir/catalog.json") ? json_decode((string) file_get_contents("$dir/catalog.json"), true) : null;
        $programmingPath = "$dir/programming.json";
        $programming = is_file($programmingPath) ? json_decode((string) file_get_contents($programmingPath), true) : null;

        $seriesRefs = [];
        foreach (is_array($catalog['series'] ?? null) ? $catalog['series'] : [] as $entry) {
            $ref = is_array($entry) && is_string($entry['ref'] ?? null) ? $entry['ref'] : null;
            // Display-only extraction of the id from the conventional
            // "../../series/<id>/series.json" shape -- path *resolution*
            // (and its safety rules) belongs to CatalogResolver.php, not
            // this endpoint; this is purely "what id to show/preselect".
            $seriesId = null;
            if ($ref !== null && preg_match('#series/([a-z0-9][a-z0-9-]*)/series\.json$#', $ref, $m) === 1) {
                $seriesId = $m[1];
            }
            $seriesRefs[] = ['ref' => $ref, 'series_id' => $seriesId, 'known' => $seriesId !== null && admin_existing_series_path($seriesId, $seriesDir) !== null];
        }

        $out[] = [
            'id' => $id,
            'name' => is_string($meta['name'] ?? null) ? $meta['name'] : $id,
            'description' => $meta['description'] ?? null,
            'number' => $meta['number'] ?? null,
            'hidden' => (bool) ($meta['hidden'] ?? false),
            'series_refs' => $seriesRefs,
            'programming_blocks' => is_array($programming['blocks'] ?? null) ? $programming['blocks'] : [],
            'has_programming' => $programming !== null,
        ];
    }
    return $out;
}

/** @return array{series_ids: list<string>} */
function channel_admin_save_catalog(array $body, string $channelsDir = ADMIN_CHANNELS_DIR, string $seriesDir = ADMIN_SERIES_DIR): array
{
    $channelId = $body['channel_id'] ?? null;
    $dir = admin_existing_channel_dir($channelId, $channelsDir);
    if ($dir === null) {
        throw new ChannelAdminValidationError('Unknown or invalid channel_id.');
    }
    $seriesIds = $body['series_ids'] ?? null;
    if (!is_array($seriesIds)) {
        throw new ChannelAdminValidationError('series_ids must be an array.');
    }

    $seen = [];
    $refs = [];
    foreach ($seriesIds as $sid) {
        if (admin_existing_series_path($sid, $seriesDir) === null) {
            throw new ChannelAdminValidationError('Unknown or invalid series id: ' . json_encode($sid));
        }
        if (isset($seen[$sid])) {
            throw new ChannelAdminValidationError("Duplicate series id in the list: \"$sid\".");
        }
        $seen[$sid] = true;
        // Same relative-path convention as the rest of this project's
        // catalog.json files (two directories up from channels/<id>/
        // catalog.json to the repo root, then into series/<id>/) --
        // resolved and safety-checked again by CatalogResolver.php
        // whenever anything actually reads this file; this endpoint only
        // ever writes a ref to a series it has already independently
        // verified exists, in the exact conventional shape.
        $refs[] = ['ref' => "../../series/$sid/series.json"];
    }

    $catalogPath = "$dir/catalog.json";
    $catalog = is_file($catalogPath) ? json_decode((string) file_get_contents($catalogPath), true) : null;
    $catalog = is_array($catalog) ? $catalog : ['schema_version' => 2, 'title' => $channelId, 'items' => []];
    $catalog['series'] = $refs;
    admin_atomic_write_json($catalogPath, $catalog);

    return ['series_ids' => array_values($seriesIds)];
}

/** Validates one programming block's shape without writing anything --
 *  reuses channels/publish/src/Recurrence.php's own validation by
 *  actually attempting a (tiny, one-day, discarded) occurrence
 *  computation, so the exact same rules publish.php itself enforces
 *  can't drift out of sync with what this endpoint accepts. Throws
 *  ChannelAdminValidationError with a clear message on any problem. */
function channel_admin_validate_block(mixed $block, string $seriesDir = ADMIN_SERIES_DIR): array
{
    if (!is_array($block)) {
        throw new ChannelAdminValidationError('Each block must be an object.');
    }
    $id = $block['id'] ?? null;
    if (!is_string($id) || $id === '') {
        throw new ChannelAdminValidationError('Each block needs a non-empty "id".');
    }
    if (($block['type'] ?? null) !== 'series') {
        throw new ChannelAdminValidationError("block \"$id\": \"type\" must be \"series\".");
    }
    $seriesId = $block['series_id'] ?? null;
    if (admin_existing_series_path($seriesId, $seriesDir) === null) {
        throw new ChannelAdminValidationError("block \"$id\": unknown or invalid series_id " . json_encode($seriesId) . '.');
    }
    $duration = $block['duration'] ?? null;
    if (!is_int($duration) && !is_float($duration) || $duration <= 0) {
        throw new ChannelAdminValidationError("block \"$id\": \"duration\" must be a positive number of seconds.");
    }
    $rotation = $block['rotation'] ?? null;
    if (!is_array($rotation) || ($rotation['mode'] ?? 'sequential') !== 'sequential') {
        throw new ChannelAdminValidationError("block \"$id\": rotation.mode must be \"sequential\" (the only mode implemented).");
    }
    if (!is_bool($rotation['loop'] ?? null)) {
        throw new ChannelAdminValidationError("block \"$id\": rotation.loop must be true or false.");
    }
    $anchorDate = $rotation['anchor_date'] ?? null;
    if (!is_string($anchorDate) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $anchorDate)) {
        throw new ChannelAdminValidationError("block \"$id\": rotation.anchor_date must be \"YYYY-MM-DD\".");
    }

    $recurrence = $block['recurrence'] ?? null;
    if (!is_array($recurrence) || !in_array($recurrence['frequency'] ?? null, CHANNEL_ADMIN_FREQUENCIES, true)) {
        throw new ChannelAdminValidationError("block \"$id\": recurrence.frequency must be one of: " . implode(', ', CHANNEL_ADMIN_FREQUENCIES));
    }
    if ($recurrence['frequency'] === 'weekly' && !in_array($recurrence['weekday'] ?? null, CHANNEL_ADMIN_WEEKDAYS, true)) {
        throw new ChannelAdminValidationError("block \"$id\": recurrence.weekday must be one of: " . implode(', ', CHANNEL_ADMIN_WEEKDAYS));
    }
    if ($recurrence['frequency'] === 'monthly') {
        $dom = $recurrence['day_of_month'] ?? null;
        if (!is_int($dom) || $dom < 1 || $dom > 31) {
            throw new ChannelAdminValidationError("block \"$id\": recurrence.day_of_month must be an integer 1..31.");
        }
    }

    try {
        $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        Recurrence::occurrences($recurrence, $anchorDate, $now, $now->modify('+1 day'));
    } catch (Throwable $e) {
        throw new ChannelAdminValidationError("block \"$id\": " . $e->getMessage());
    }

    // Both optional (Phases 1-3): validated the exact same way publish.php
    // itself validates them (EpisodePacker::normalizeConfig / BoundaryResolver::
    // normalizeBoundary, not a reimplementation of their rules), so this
    // endpoint's acceptance criteria cannot drift out of sync with what a real
    // publish would actually do with the same block.
    if (isset($block['packing'])) {
        if (!is_array($block['packing'])) {
            throw new ChannelAdminValidationError("block \"$id\": \"packing\" must be an object.");
        }
        try {
            EpisodePacker::normalizeConfig($block['packing'], $id);
        } catch (Throwable $e) {
            throw new ChannelAdminValidationError($e->getMessage());
        }
    }
    if (isset($block['boundary'])) {
        if (!is_array($block['boundary'])) {
            throw new ChannelAdminValidationError("block \"$id\": \"boundary\" must be an object.");
        }
        try {
            BoundaryResolver::normalizeBoundary($block['boundary'], $id);
        } catch (Throwable $e) {
            throw new ChannelAdminValidationError($e->getMessage());
        }
    }

    return $block;
}

/** @return array{blocks: list<array<string,mixed>>} */
function channel_admin_save_programming(array $body, string $channelsDir = ADMIN_CHANNELS_DIR, string $seriesDir = ADMIN_SERIES_DIR): array
{
    $channelId = $body['channel_id'] ?? null;
    $dir = admin_existing_channel_dir($channelId, $channelsDir);
    if ($dir === null) {
        throw new ChannelAdminValidationError('Unknown or invalid channel_id.');
    }
    $blocks = $body['blocks'] ?? null;
    if (!is_array($blocks)) {
        throw new ChannelAdminValidationError('blocks must be an array.');
    }

    $seenIds = [];
    $validated = [];
    foreach ($blocks as $block) {
        $validated[] = $block = channel_admin_validate_block($block, $seriesDir);
        if (isset($seenIds[$block['id']])) {
            throw new ChannelAdminValidationError("Duplicate block id: \"{$block['id']}\".");
        }
        $seenIds[$block['id']] = true;
    }

    $programmingPath = "$dir/programming.json";
    $programming = is_file($programmingPath) ? json_decode((string) file_get_contents($programmingPath), true) : null;
    $programming = is_array($programming) ? $programming : ['schema_version' => 1];
    $programming['blocks'] = $validated;
    admin_atomic_write_json($programmingPath, $programming);

    return ['blocks' => $validated];
}

/** @return list<string> */
function channel_admin_build_publish_argv(string $channelId, array $body): array
{
    $argv = [admin_php_binary(), ADMIN_ROOT . '/channels/publish.php', $channelId];

    $days = $body['days'] ?? null;
    if ($days !== null) {
        if (!is_int($days) && !(is_string($days) && ctype_digit($days))) {
            throw new ChannelAdminValidationError('days must be a positive integer.');
        }
        $days = (int) $days;
        if ($days < 1 || $days > 365) {
            throw new ChannelAdminValidationError('days must be between 1 and 365.');
        }
        $argv[] = "--days=$days";
    }

    $windowStart = $body['window_start'] ?? null;
    if ($windowStart !== null) {
        if (!is_string($windowStart) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $windowStart)) {
            throw new ChannelAdminValidationError('window_start must be "YYYY-MM-DD".');
        }
        $argv[] = "--window-start=$windowStart";
    }

    $windowTimezone = $body['window_timezone'] ?? null;
    if ($windowTimezone !== null) {
        if (!is_string($windowTimezone)) {
            throw new ChannelAdminValidationError('window_timezone must be a string.');
        }
        try {
            new DateTimeZone($windowTimezone);
        } catch (Throwable) {
            throw new ChannelAdminValidationError("\"$windowTimezone\" is not a valid IANA timezone.");
        }
        $argv[] = "--window-timezone=$windowTimezone";
    }

    $argv[] = '--verbose';
    if (!empty($body['dry_run'])) {
        $argv[] = '--dry-run';
    }
    return $argv;
}

/** @return array{exitCode:int, stdout:string, stderr:string, dry_run:bool} */
function channel_admin_publish(array $body, string $channelsDir = ADMIN_CHANNELS_DIR): array
{
    $channelId = $body['channel_id'] ?? null;
    $dir = admin_existing_channel_dir($channelId, $channelsDir);
    if ($dir === null) {
        throw new ChannelAdminValidationError('Unknown or invalid channel_id.');
    }
    if (!is_file("$dir/programming.json")) {
        throw new ChannelAdminValidationError('This channel has no programming.json yet -- add at least one recurring block first.');
    }
    $dryRun = !empty($body['dry_run']);
    $argv = channel_admin_build_publish_argv((string) $channelId, $body);
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
                admin_json_response(200, ['ok' => true, 'channels' => channel_admin_list()]);
            }
            admin_json_response(400, ['ok' => false, 'error' => 'Unknown GET action.']);
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $body = admin_read_json_body();
            $action = $body['action'] ?? null;
            $result = match ($action) {
                'save_catalog' => channel_admin_save_catalog($body),
                'save_programming' => channel_admin_save_programming($body),
                'publish' => channel_admin_publish($body),
                default => throw new ChannelAdminValidationError('Unknown action.'),
            };
            admin_json_response(200, ['ok' => true] + $result);
        }

        admin_json_response(405, ['ok' => false, 'error' => 'GET or POST only.']);
    } catch (ChannelAdminValidationError $e) {
        admin_json_response(400, ['ok' => false, 'error' => $e->getMessage()]);
    } catch (Throwable $e) {
        admin_json_response(500, ['ok' => false, 'error' => $e->getMessage()]);
    }
}
