<?php
declare(strict_types=1);

// server/bump-admin.php
//
// Backend for the admin UI's "Bumps" section (see bumps/README.md) -- a
// sibling to server/announcer-admin.php/channel-admin.php/series-admin.php,
// same posture: one PHP file per editorial domain, dual CLI/HTTP mode
// (PHP_SAPI guard at the bottom), no access control (see docs/admin-ui.md).
//
// A "bump" (bumps/<id>.json) pairs a background (a real video/image file
// under media/, or a plain color) with 0-2 looping background-audio layers
// (also real files under media/ -- typically media/music/ or
// media/ambience/) and an optional already-rendered announcement clip
// (one of a channel's existing channels/<id>/announcements.json entries --
// this endpoint never calls into the announcer pipeline or synthesizes
// anything new). It never stores the actual upcoming-show titles/times --
// see bumps/README.md's "upcoming.count" note -- those are supplied at
// render time by whatever's driving <cr-bump> (channels/bump-player.js).
//
// Every url a bump references is validated to resolve (via realpath) to a
// real file INSIDE media/ -- never trusted as a bare string, same posture
// as every path/id AdminSupport.php already guards elsewhere in this repo.
//
// GET  ?action=list    -> every bumps/*.json, in full
// GET  ?action=media   -> what's available to build a bump FROM: every
//                         media/video, media/images, media/music,
//                         media/ambience file,
//                         and every channel's "ready" announcements (with
//                         their text, for a human-readable picker -- never
//                         raw content-hashed filenames alone)
// POST {action:"create", name, background, audio?, announcement?, upcoming?, style?, description?, duration?}
//                       -> derives a new id from `name`, writes bumps/<id>.json
// POST {action:"update", id, name, background, audio?, announcement?, upcoming?, style?, description?, duration?}
//                       -> full replace of an existing bumps/<id>.json (the
//                          creator UI always submits the complete object)
//                       `duration` (seconds) and the timing fields
//                       announcement.start / upcoming.start / upcoming.end
//                       are optional (schema_version 2, bumps/README.md);
//                       a bump saved without `duration` stays version 1.
// POST {action:"delete", id}
//                       -> removes bumps/<id>.json
//
// A bump's PLAYBACK scheduling -- which channel shows it, and when -- is a
// completely separate concern, stored per channel (channels/<id>/
// bump-schedule.json), never inside the bump's own JSON: the same bump can
// be scheduled on several channels, or on none, independent of how it was
// built. See channels/player-adapters.js's "bump scheduling" header for WHY
// this is resolved and driven entirely client-side (by wall clock) rather
// than published into schedule.json.
//
// GET  ?action=schedules -> every channel's current bump-schedule.json
//                            (or {enabled:false, rules:[]} if it has none),
//                            plus read-only display hints: `logo` (repo-
//                            relative path, or null) and `accent` (the
//                            channel theme's accent color, or null)
// POST {action:"save_schedule", channel_id, enabled, rules}
//                       -> full replace of channels/<id>/bump-schedule.json.
//                          Each rule is {bumpId, every, offsetSeconds?,
//                          durationSeconds} -- "every" is "hour"/"halfHour"/
//                          "day"; `bumpId` must reference an existing bump.

require_once __DIR__ . '/lib/AdminSupport.php';

const BUMP_ADMIN_ROOT = ADMIN_ROOT . '/bumps';
const BUMP_ADMIN_MEDIA_ROOT = ADMIN_ROOT . '/media';
const BUMP_ADMIN_ID_PATTERN = '/^[a-z0-9][a-z0-9-]{0,59}$/';
const BUMP_ADMIN_BG_TYPES = ['video', 'image', 'color'];
const BUMP_ADMIN_AUDIO_SOURCES = ['music', 'ambience', 'custom'];
const BUMP_ADMIN_STYLE_KEYS = ['accent', 'accentWarm', 'bg', 'bg2', 'fg', 'muted'];
const BUMP_ADMIN_SCHEDULE_PERIODS = ['hour' => 3600, 'halfHour' => 1800, 'day' => 86400];
const BUMP_ADMIN_MAX_SCHEDULE_RULES = 20;
const BUMP_ADMIN_MAX_AUDIO_LAYERS = 2; // matches the two fixed <audio> slots in channels/bump-player.js's template
// schema_version 2 (see bumps/README.md "Timing"): an optional intrinsic
// composition length plus a few per-layer timing fields, all in seconds.
// A bump with no `duration` is written exactly as before (schema_version
// 1, no timing fields) -- v2 is opt-in per bump, never a migration.
const BUMP_ADMIN_MIN_DURATION = 1;
const BUMP_ADMIN_MAX_DURATION = 300;

final class BumpAdminValidationError extends RuntimeException
{
}

// ---------- id/path helpers ----------

function bump_admin_valid_id(mixed $id): bool
{
    return is_string($id) && preg_match(BUMP_ADMIN_ID_PATTERN, $id) === 1;
}

function bump_admin_slugify(string $name): string
{
    $slug = strtolower(trim($name));
    $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
    $slug = trim($slug, '-');
    if ($slug === '') {
        $slug = 'bump';
    }
    return substr($slug, 0, 60);
}

function bump_admin_unique_id(string $base, string $bumpsDir): string
{
    if (!is_file("$bumpsDir/$base.json")) {
        return $base;
    }
    $n = 2;
    while (is_file("$bumpsDir/" . substr($base, 0, 56) . "-$n.json")) {
        $n++;
    }
    return substr($base, 0, 56) . "-$n";
}

/** Resolves $url (absolute-from-repo-root with or without a leading slash,
 *  e.g. "media/music/bg-music00.mp3" or "/media/music/bg-music00.mp3") and
 *  confirms it's a real, existing file strictly INSIDE $mediaRoot --
 *  realpath containment, not a string prefix check, so "media/../channels/
 *  ..." or a symlink escape is rejected exactly like any other admin path
 *  guard in this repo (see AdminSupport.php's header). $mediaRoot is a full
 *  filesystem path whose basename is "media" (the url's own "media/" first
 *  segment is always required, matching the stored/displayed form) --
 *  parameterized, like every other admin root in this repo, so tests can
 *  point it at a throwaway tree instead of the real repo's media/. */
function bump_admin_valid_media_url(mixed $url, string $mediaRoot = BUMP_ADMIN_MEDIA_ROOT): bool
{
    if (!is_string($url) || $url === '' || strlen($url) > 300 || str_contains($url, "\0")) {
        return false;
    }
    $rel = ltrim($url, '/');
    if (!str_starts_with($rel, 'media/')) {
        return false;
    }
    $real = realpath(dirname($mediaRoot) . '/' . $rel);
    $mediaReal = realpath($mediaRoot);
    if ($real === false || $mediaReal === false || !is_file($real)) {
        return false;
    }
    return $real === $mediaReal || str_starts_with($real, $mediaReal . DIRECTORY_SEPARATOR);
}

// ---------- normalization (validate + strip to exactly what's stored) ----------

function bump_admin_normalize_background(mixed $bg, string $mediaRoot = BUMP_ADMIN_MEDIA_ROOT): array
{
    if (!is_array($bg)) {
        throw new BumpAdminValidationError('background must be an object.');
    }
    $type = $bg['type'] ?? null;
    if (!in_array($type, BUMP_ADMIN_BG_TYPES, true)) {
        throw new BumpAdminValidationError('background.type must be one of: ' . implode(', ', BUMP_ADMIN_BG_TYPES));
    }
    if ($type === 'color') {
        $color = $bg['color'] ?? null;
        if (!is_string($color) || $color === '' || strlen($color) > 40) {
            throw new BumpAdminValidationError('background.color must be a non-empty string of at most 40 characters.');
        }
        return ['type' => 'color', 'color' => $color];
    }
    if (!bump_admin_valid_media_url($bg['url'] ?? null, $mediaRoot)) {
        throw new BumpAdminValidationError('background.url must point at an existing file under media/.');
    }
    return ['type' => $type, 'url' => ltrim((string) $bg['url'], '/')];
}

function bump_admin_normalize_audio_layers(mixed $layers, string $mediaRoot = BUMP_ADMIN_MEDIA_ROOT): array
{
    if ($layers === null) {
        return [];
    }
    if (!is_array($layers) || !array_is_list($layers)) {
        throw new BumpAdminValidationError('audio must be a list.');
    }
    if (count($layers) > BUMP_ADMIN_MAX_AUDIO_LAYERS) {
        throw new BumpAdminValidationError('audio supports at most ' . BUMP_ADMIN_MAX_AUDIO_LAYERS . ' layer(s).');
    }
    $out = [];
    foreach ($layers as $layer) {
        if (!is_array($layer)) {
            throw new BumpAdminValidationError('Each audio layer must be an object.');
        }
        $source = $layer['source'] ?? 'custom';
        if (!in_array($source, BUMP_ADMIN_AUDIO_SOURCES, true)) {
            throw new BumpAdminValidationError('audio[].source must be one of: ' . implode(', ', BUMP_ADMIN_AUDIO_SOURCES));
        }
        if (!bump_admin_valid_media_url($layer['url'] ?? null, $mediaRoot)) {
            throw new BumpAdminValidationError('audio[].url must point at an existing file under media/.');
        }
        $volume = $layer['volume'] ?? 0.6;
        if (!is_numeric($volume) || $volume < 0 || $volume > 1) {
            throw new BumpAdminValidationError('audio[].volume must be a number between 0 and 1.');
        }
        $out[] = ['source' => $source, 'url' => ltrim((string) $layer['url'], '/'), 'volume' => (float) $volume];
    }
    return $out;
}

/** Optional bump-level composition length (schema_version 2). null =>
 *  not set (a version-1 bump; editors preview it at the documented
 *  default, and live playback keeps its version-1 behavior exactly). */
function bump_admin_normalize_duration(mixed $duration): ?float
{
    if ($duration === null) {
        return null;
    }
    if (!is_numeric($duration) || $duration < BUMP_ADMIN_MIN_DURATION || $duration > BUMP_ADMIN_MAX_DURATION) {
        throw new BumpAdminValidationError('duration must be a number of seconds between ' . BUMP_ADMIN_MIN_DURATION . ' and ' . BUMP_ADMIN_MAX_DURATION . '.');
    }
    return round((float) $duration, 3);
}

/** One optional timing field (seconds into the composition). Every timing
 *  field requires an explicit bump `duration` -- an end/offset can only be
 *  validated against a known composition length, and a version-1 bump's
 *  on-air length is whatever its schedule rule says. */
function bump_admin_normalize_time(mixed $value, string $field, ?float $duration): ?float
{
    if ($value === null) {
        return null;
    }
    if ($duration === null) {
        throw new BumpAdminValidationError("$field requires the bump to have a duration.");
    }
    if (!is_numeric($value) || $value < 0) {
        throw new BumpAdminValidationError("$field must be a nonnegative number of seconds.");
    }
    if ($value > $duration) {
        throw new BumpAdminValidationError("$field must not exceed the bump's duration ($duration s).");
    }
    return round((float) $value, 3);
}

function bump_admin_normalize_announcement(mixed $ann, string $mediaRoot = BUMP_ADMIN_MEDIA_ROOT, ?float $duration = null): ?array
{
    if ($ann === null) {
        return null;
    }
    if (!is_array($ann)) {
        throw new BumpAdminValidationError('announcement must be an object or null.');
    }
    if (!bump_admin_valid_media_url($ann['url'] ?? null, $mediaRoot)) {
        throw new BumpAdminValidationError('announcement.url must point at an existing file under media/.');
    }
    $out = ['url' => ltrim((string) $ann['url'], '/')];
    if (isset($ann['channelId'])) {
        if (!admin_valid_id($ann['channelId'])) {
            throw new BumpAdminValidationError('announcement.channelId is invalid.');
        }
        $out['channelId'] = $ann['channelId'];
    }
    if (isset($ann['transitionId'])) {
        $t = $ann['transitionId'];
        if (!is_string($t) || $t === '' || strlen($t) > 150) {
            throw new BumpAdminValidationError('announcement.transitionId is invalid.');
        }
        $out['transitionId'] = $t;
    }
    $duckTo = $ann['duckTo'] ?? 0.3;
    if (!is_numeric($duckTo) || $duckTo < 0 || $duckTo > 1) {
        throw new BumpAdminValidationError('announcement.duckTo must be a number between 0 and 1.');
    }
    $out['duckTo'] = (float) $duckTo;
    $start = bump_admin_normalize_time($ann['start'] ?? null, 'announcement.start', $duration);
    if ($start !== null) {
        if ($start >= $duration) {
            throw new BumpAdminValidationError('announcement.start must be earlier than the end of the bump.');
        }
        $out['start'] = $start;
    }
    return $out;
}

function bump_admin_normalize_upcoming(mixed $upcoming, ?float $duration = null): array
{
    $upcoming = is_array($upcoming) ? $upcoming : [];
    $count = $upcoming['count'] ?? 3;
    if (!is_numeric($count) || $count < 0 || $count > 6) {
        throw new BumpAdminValidationError('upcoming.count must be a number between 0 and 6.');
    }
    $label = $upcoming['label'] ?? 'Coming Up';
    if (!is_string($label) || strlen($label) > 40) {
        throw new BumpAdminValidationError('upcoming.label must be a string of at most 40 characters.');
    }
    $out = ['count' => (int) $count, 'label' => trim($label) !== '' ? $label : 'Coming Up'];
    $start = bump_admin_normalize_time($upcoming['start'] ?? null, 'upcoming.start', $duration);
    $end = bump_admin_normalize_time($upcoming['end'] ?? null, 'upcoming.end', $duration);
    if ($start !== null && $end === null && $start >= $duration) {
        throw new BumpAdminValidationError('upcoming.start must be earlier than the end of the bump.');
    }
    if ($end !== null && $end <= ($start ?? 0.0)) {
        throw new BumpAdminValidationError('upcoming.end must be greater than upcoming.start.');
    }
    if ($start !== null) {
        $out['start'] = $start;
    }
    if ($end !== null) {
        $out['end'] = $end;
    }
    return $out;
}

function bump_admin_normalize_style(mixed $style): array
{
    if ($style === null) {
        return [];
    }
    if (!is_array($style)) {
        throw new BumpAdminValidationError('style must be an object.');
    }
    $out = [];
    foreach (BUMP_ADMIN_STYLE_KEYS as $key) {
        if (isset($style[$key])) {
            $v = $style[$key];
            if (!is_string($v) || $v === '' || strlen($v) > 40) {
                throw new BumpAdminValidationError("style.$key must be a non-empty string of at most 40 characters.");
            }
            $out[$key] = $v;
        }
    }
    return $out;
}

function bump_admin_normalize_description(mixed $d): string
{
    if ($d === null) {
        return '';
    }
    if (!is_string($d) || strlen($d) > 300) {
        throw new BumpAdminValidationError('description must be a string of at most 300 characters.');
    }
    return $d;
}

/** @return array<string,mixed> every field EXCEPT id/schema_version/timestamps
 *  (`duration` is present only when the bump has one -- see bump_admin_schema_version()) */
function bump_admin_normalize(array $body, string $mediaRoot = BUMP_ADMIN_MEDIA_ROOT): array
{
    $name = $body['name'] ?? null;
    if (!is_string($name) || trim($name) === '' || strlen($name) > 120) {
        throw new BumpAdminValidationError('name must be a non-empty string of at most 120 characters.');
    }
    $duration = bump_admin_normalize_duration($body['duration'] ?? null);
    $out = [
        'name' => trim($name),
        'description' => bump_admin_normalize_description($body['description'] ?? null),
    ];
    if ($duration !== null) {
        $out['duration'] = $duration;
    }
    return $out + [
        'background' => bump_admin_normalize_background($body['background'] ?? null, $mediaRoot),
        'audio' => bump_admin_normalize_audio_layers($body['audio'] ?? [], $mediaRoot),
        'announcement' => bump_admin_normalize_announcement($body['announcement'] ?? null, $mediaRoot, $duration),
        'upcoming' => bump_admin_normalize_upcoming($body['upcoming'] ?? null, $duration),
        'style' => bump_admin_normalize_style($body['style'] ?? null),
    ];
}

/** 2 when the normalized bump uses any schema_version-2 field (they all
 *  require `duration`, so that's the single tell), else 1 -- a bump that
 *  never opts into timing is stored byte-for-byte in the version-1 shape. */
function bump_admin_schema_version(array $normalized): int
{
    return array_key_exists('duration', $normalized) ? 2 : 1;
}

// ---------- list / create / update / delete ----------

/** @return list<array<string,mixed>> every bumps/*.json, each with its id, sorted by name */
function bump_admin_list(string $bumpsDir = BUMP_ADMIN_ROOT): array
{
    $out = [];
    foreach (glob("$bumpsDir/*.json") ?: [] as $path) {
        $id = basename($path, '.json');
        if (!bump_admin_valid_id($id)) {
            continue;
        }
        $data = json_decode((string) file_get_contents($path), true);
        if (!is_array($data)) {
            continue;
        }
        $data['id'] = $id;
        $out[] = $data;
    }
    usort($out, fn (array $a, array $b): int => strcasecmp((string) ($a['name'] ?? ''), (string) ($b['name'] ?? '')));
    return $out;
}

/** @return array{bump: array<string,mixed>} */
function bump_admin_create(array $body, string $bumpsDir = BUMP_ADMIN_ROOT, string $mediaRoot = BUMP_ADMIN_MEDIA_ROOT): array
{
    if (!is_dir($bumpsDir) && !mkdir($bumpsDir, 0775, true) && !is_dir($bumpsDir)) {
        throw new RuntimeException("Failed to create directory: $bumpsDir");
    }
    $normalized = bump_admin_normalize($body, $mediaRoot);
    $normalized['style'] = $normalized['style'] ?: new stdClass(); // an empty PHP array json_encode()s as [] -- force {} so the schema (bumps/README.md) is never ambiguous about style's shape
    $id = bump_admin_unique_id(bump_admin_slugify($normalized['name']), $bumpsDir);
    $now = gmdate('c');
    $doc = ['schema_version' => bump_admin_schema_version($normalized), 'id' => $id] + $normalized + ['createdAt' => $now, 'updatedAt' => $now];
    admin_atomic_write_json("$bumpsDir/$id.json", $doc);
    return ['bump' => $doc];
}

/** @return array{bump: array<string,mixed>} */
function bump_admin_update(array $body, string $bumpsDir = BUMP_ADMIN_ROOT, string $mediaRoot = BUMP_ADMIN_MEDIA_ROOT): array
{
    $id = $body['id'] ?? null;
    if (!bump_admin_valid_id($id) || !is_file("$bumpsDir/$id.json")) {
        throw new BumpAdminValidationError('Unknown or invalid bump id.');
    }
    $existing = json_decode((string) file_get_contents("$bumpsDir/$id.json"), true);
    $createdAt = is_array($existing) && is_string($existing['createdAt'] ?? null) ? $existing['createdAt'] : gmdate('c');
    $normalized = bump_admin_normalize($body, $mediaRoot);
    $normalized['style'] = $normalized['style'] ?: new stdClass();
    $doc = ['schema_version' => bump_admin_schema_version($normalized), 'id' => $id] + $normalized + ['createdAt' => $createdAt, 'updatedAt' => gmdate('c')];
    admin_atomic_write_json("$bumpsDir/$id.json", $doc);
    return ['bump' => $doc];
}

/** @return array{ok: true} always succeeds (deleting an already-gone id is a no-op, not an error) */
function bump_admin_delete(array $body, string $bumpsDir = BUMP_ADMIN_ROOT): array
{
    $id = $body['id'] ?? null;
    if (!bump_admin_valid_id($id)) {
        throw new BumpAdminValidationError('Unknown or invalid bump id.');
    }
    $path = "$bumpsDir/$id.json";
    if (is_file($path)) {
        unlink($path);
    }
    return ['ok' => true];
}

// ---------- media listing (what a bump can be built FROM) ----------

/** @return list<array{url:string,name:string,bytes:int}> */
function bump_admin_list_dir_files(string $dir, string $relPrefix, array $extensions): array
{
    $out = [];
    foreach (glob("$dir/*") ?: [] as $path) {
        if (!is_file($path)) {
            continue;
        }
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if (!in_array($ext, $extensions, true)) {
            continue;
        }
        $out[] = ['url' => "$relPrefix/" . basename($path), 'name' => basename($path), 'bytes' => filesize($path) ?: 0];
    }
    usort($out, fn (array $a, array $b): int => strcasecmp($a['name'], $b['name']));
    return $out;
}

/** @return array{video:list<array>, image:list<array>, music:list<array>, ambience:list<array>, channels:list<array{id:string,name:string,announcements:list<array>}>} */
function bump_admin_list_media(string $repoRoot = ADMIN_ROOT, string $channelsDir = ADMIN_CHANNELS_DIR): array
{
    $mediaDir = "$repoRoot/media";
    $video = bump_admin_list_dir_files("$mediaDir/video", 'media/video', ['mp4', 'webm', 'mov', 'm4v']);
    $music = bump_admin_list_dir_files("$mediaDir/music", 'media/music', ['mp3', 'm4a', 'ogg', 'wav']);
    $ambience = bump_admin_list_dir_files("$mediaDir/ambience", 'media/ambience', ['mp3', 'm4a', 'ogg', 'wav']);
    // Still-image backgrounds (background.type "image"). Additive: an
    // empty list (no media/images/ directory yet) just means the editor
    // doesn't offer image backgrounds.
    $image = bump_admin_list_dir_files("$mediaDir/images", 'media/images', ['jpg', 'jpeg', 'png', 'webp', 'gif']);

    $channels = [];
    foreach (admin_list_channel_dirs($channelsDir) as $id => $dir) {
        $meta = is_file("$dir/meta.json") ? json_decode((string) file_get_contents("$dir/meta.json"), true) : null;
        $announcementsDoc = is_file("$dir/announcements.json") ? json_decode((string) file_get_contents("$dir/announcements.json"), true) : null;
        $announcements = [];
        foreach (is_array($announcementsDoc['announcements'] ?? null) ? $announcementsDoc['announcements'] : [] as $entry) {
            if (!is_array($entry) || ($entry['status'] ?? null) !== 'ready' || empty($entry['audio'])) {
                continue; // only ever offer a clip that's actually ready to play
            }
            $announcements[] = [
                'transitionId' => $entry['transitionId'] ?? null,
                'type' => $entry['type'] ?? null,
                'text' => mb_substr((string) ($entry['text'] ?? ''), 0, 160),
                'url' => $entry['audio'],
            ];
        }
        $channels[] = [
            'id' => $id,
            'name' => is_array($meta) && is_string($meta['name'] ?? null) ? $meta['name'] : $id,
            'announcements' => $announcements,
        ];
    }

    return ['video' => $video, 'image' => $image, 'music' => $music, 'ambience' => $ambience, 'channels' => $channels];
}

// ---------- channel bump scheduling (channels/<id>/bump-schedule.json) ----------

/** @return array{bumpId:string, every:string, offsetSeconds:float, durationSeconds:float} */
function bump_admin_normalize_schedule_rule(mixed $rule, string $bumpsDir): array
{
    if (!is_array($rule)) {
        throw new BumpAdminValidationError('Each schedule rule must be an object.');
    }
    $bumpId = $rule['bumpId'] ?? null;
    if (!bump_admin_valid_id($bumpId) || !is_file("$bumpsDir/$bumpId.json")) {
        throw new BumpAdminValidationError('rules[].bumpId must reference an existing bump.');
    }
    $every = $rule['every'] ?? null;
    if (!is_string($every) || !array_key_exists($every, BUMP_ADMIN_SCHEDULE_PERIODS)) {
        throw new BumpAdminValidationError('rules[].every must be one of: ' . implode(', ', array_keys(BUMP_ADMIN_SCHEDULE_PERIODS)));
    }
    $period = BUMP_ADMIN_SCHEDULE_PERIODS[$every];
    $offset = $rule['offsetSeconds'] ?? 0;
    if (!is_numeric($offset) || $offset < 0 || $offset >= $period) {
        throw new BumpAdminValidationError("rules[].offsetSeconds must be between 0 and " . ($period - 1) . " for every=\"$every\".");
    }
    $duration = $rule['durationSeconds'] ?? null;
    if (!is_numeric($duration) || $duration <= 0 || $duration > $period) {
        throw new BumpAdminValidationError('rules[].durationSeconds must be a positive number of seconds, at most one full period.');
    }
    return ['bumpId' => (string) $bumpId, 'every' => $every, 'offsetSeconds' => (float) $offset, 'durationSeconds' => (float) $duration];
}

/** @return array{enabled:bool, rules:list<array>} */
function bump_admin_normalize_schedule(array $body, string $bumpsDir = BUMP_ADMIN_ROOT): array
{
    $rules = $body['rules'] ?? [];
    if (!is_array($rules) || !array_is_list($rules)) {
        throw new BumpAdminValidationError('rules must be a list.');
    }
    if (count($rules) > BUMP_ADMIN_MAX_SCHEDULE_RULES) {
        throw new BumpAdminValidationError('rules supports at most ' . BUMP_ADMIN_MAX_SCHEDULE_RULES . ' entries.');
    }
    return [
        'enabled' => (bool) ($body['enabled'] ?? false),
        'rules' => array_map(fn (mixed $r): array => bump_admin_normalize_schedule_rule($r, $bumpsDir), $rules),
    ];
}

/** @return array{schedule: array<string,mixed>} */
function bump_admin_save_schedule(array $body, string $channelsDir = ADMIN_CHANNELS_DIR, string $bumpsDir = BUMP_ADMIN_ROOT): array
{
    $channelId = $body['channel_id'] ?? null;
    $dir = admin_existing_channel_dir($channelId, $channelsDir);
    if ($dir === null) {
        throw new BumpAdminValidationError('Unknown or invalid channel_id.');
    }
    $normalized = bump_admin_normalize_schedule($body, $bumpsDir);
    $doc = ['schema_version' => 1] + $normalized;
    admin_atomic_write_json("$dir/bump-schedule.json", $doc);
    return ['schedule' => $doc];
}

/** @return list<array{id:string, name:string, enabled:bool, rules:list<array>, logo:?string, accent:?string}> every channel, whether or not it has a bump-schedule.json yet */
function bump_admin_list_schedules(string $channelsDir = ADMIN_CHANNELS_DIR): array
{
    $out = [];
    foreach (admin_list_channel_dirs($channelsDir) as $id => $dir) {
        $meta = is_file("$dir/meta.json") ? json_decode((string) file_get_contents("$dir/meta.json"), true) : null;
        $path = "$dir/bump-schedule.json";
        $doc = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
        $logo = is_array($meta) && is_string($meta['logo'] ?? null) ? basename($meta['logo']) : null;
        $accent = is_array($meta) && is_string($meta['theme']['accent'] ?? null) ? $meta['theme']['accent'] : null;
        $out[] = [
            'id' => $id,
            'name' => is_array($meta) && is_string($meta['name'] ?? null) ? $meta['name'] : $id,
            'enabled' => is_array($doc) && ($doc['enabled'] ?? false) === true,
            'rules' => is_array($doc) && is_array($doc['rules'] ?? null) ? $doc['rules'] : [],
            // Display-only hints for the Schedule workspace's channel list
            // (additive; never part of bump-schedule.json).
            'logo' => $logo !== null && $logo !== '' && is_file("$dir/$logo") ? "channels/$id/$logo" : null,
            'accent' => $accent !== null && preg_match('/^#[0-9a-fA-F]{3,8}$/', $accent) ? $accent : null,
        ];
    }
    return $out;
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
                admin_json_response(200, ['ok' => true, 'bumps' => bump_admin_list()]);
            }
            if ($action === 'media') {
                admin_json_response(200, ['ok' => true] + bump_admin_list_media());
            }
            if ($action === 'schedules') {
                admin_json_response(200, ['ok' => true, 'channels' => bump_admin_list_schedules()]);
            }
            admin_json_response(400, ['ok' => false, 'error' => 'Unknown GET action.']);
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $body = admin_read_json_body();
            $action = $body['action'] ?? null;
            $result = match ($action) {
                'create' => bump_admin_create($body),
                'update' => bump_admin_update($body),
                'delete' => bump_admin_delete($body),
                'save_schedule' => bump_admin_save_schedule($body),
                default => throw new BumpAdminValidationError('Unknown action.'),
            };
            admin_json_response(200, ['ok' => true] + $result);
        }

        admin_json_response(405, ['ok' => false, 'error' => 'GET or POST only.']);
    } catch (BumpAdminValidationError $e) {
        admin_json_response(400, ['ok' => false, 'error' => $e->getMessage()]);
    } catch (Throwable $e) {
        admin_json_response(500, ['ok' => false, 'error' => $e->getMessage()]);
    }
}
