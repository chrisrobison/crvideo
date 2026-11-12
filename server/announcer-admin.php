<?php
declare(strict_types=1);

// server/announcer-admin.php
//
// Backend for the admin UI's "Continuity announcer" section (see
// channels/announcer/README.md; a sibling to server/channel-admin.php, one
// file per editorial domain). Lets an editor:
//
//   - view every channel's effective announcer config (global defaults +
//     channels/<id>/announcer.json merged, via AnnouncerConfig::resolve()
//     -- the EXACT same resolution the real pipeline uses, so what this
//     endpoint shows can never drift from what a real run would do),
//     its current channels/<id>/announcements.json manifest, and its
//     background job queue counts,
//   - edit and save channels/<id>/announcer.json,
//   - list the voices a channel's configured Kokoro server actually has
//     loaded (GET <endpoint>/voices), and synthesize a short fixed sample
//     through it to preview a voice before committing to it,
//   - regenerate one specific transition's announcement synchronously
//     (shells out to channels/announce.php --sync --transition=ID, the
//     exact same code path a cron-driven worker run would use -- this
//     endpoint never reimplements any part of the generation pipeline),
//   - enqueue the backlog of missing announcements for a channel (async;
//     channels/announce-worker.php, run separately, drains it),
//   - approve/edit a cached script's text so routine regeneration never
//     silently overwrites a human's wording (ScriptCache::approve()).
//
// See server/lib/AdminSupport.php for the shared access-control hook
// (currently a no-op -- see docs/admin-ui.md) and the safe (argv-array,
// never shell-string) subprocess runner. Same "no access control" posture
// as channel-admin.php/series-admin.php: anyone who can reach this file
// can view and change any channel's announcer config, trigger a real
// `claude` CLI + Kokoro synthesis run (real cost/time), and edit cached
// scripts.
//
// GET  ?action=list                                                   -> every channel's config/announcements/queue
// GET  ?action=voices&channel_id=ID                                   -> voices the channel's configured Kokoro server reports
// POST {action:"save_config", channel_id, config}                     -> writes channels/<id>/announcer.json
// POST {action:"preview_voice", channel_id, voice}                    -> synthesizes a short sample, returns its URL
// POST {action:"regenerate", channel_id, transition_id,
//       force_script?, force_audio?}                                  -> channels/announce.php --sync --transition=ID
// POST {action:"generate_queue", channel_id}                          -> channels/announce.php (async enqueue)
// POST {action:"approve_script", channel_id, script_hash, text}       -> ScriptCache::approve()

require_once __DIR__ . '/lib/AdminSupport.php';

const ANNOUNCER_SRC_DIR = ADMIN_ROOT . '/channels/announcer/src';
foreach ([
    'ContentHash', 'AnnouncerConfig', 'AiWriterInterface', 'WriterPromptBuilder',
    'TtsProviderInterface', 'KokoroHttpTtsProvider', 'AudioProcessor',
    'ScriptCache', 'AudioCache', 'JobQueue',
] as $class) {
    require_once ANNOUNCER_SRC_DIR . "/$class.php";
}

final class AnnouncerAdminValidationError extends RuntimeException
{
}

const ANNOUNCER_ADMIN_TYPES = ['coming_up_next', 'now_showing', 'still_ahead', 'channel_id', 'lineup_preview', 'return_from_break'];
const ANNOUNCER_ADMIN_WRITER_PROVIDERS = ['claude-cli', 'template', 'mock'];
const ANNOUNCER_ADMIN_TTS_PROVIDERS = ['kokoro-http', 'mock'];
const ANNOUNCER_ADMIN_SUPPRESS_MODES = ['short', 'suppress', 'normal'];
const ANNOUNCER_ADMIN_VOICE_PATTERN = '/^[a-zA-Z0-9_]{1,40}$/';
const ANNOUNCER_ADMIN_TRANSITION_PATTERN = '/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/';
const ANNOUNCER_ADMIN_HASH_PATTERN = '/^[0-9a-f]{16,128}$/i';

// Fixed, deliberately generic preview line -- never channel-specific
// content, so previewing a voice never needs a real schedule/context and
// never risks sounding like a real (possibly stale) announcement.
const ANNOUNCER_ADMIN_PREVIEW_TEXT = "This is a preview of this voice for the continuity announcer.";

function announcer_admin_root(): string
{
    return ADMIN_ROOT . '/channels/announcer';
}

/** @return list<array<string,mixed>> */
function announcer_admin_list(string $channelsDir = ADMIN_CHANNELS_DIR): array
{
    $out = [];
    foreach (admin_list_channel_dirs($channelsDir) as $id => $dir) {
        $meta = is_file("$dir/meta.json") ? json_decode((string) file_get_contents("$dir/meta.json"), true) : null;
        $meta = is_array($meta) ? $meta : [];
        $hasAnnouncerJson = is_file("$dir/announcer.json");
        $config = AnnouncerConfig::resolve($id, $channelsDir, announcer_admin_root());

        $announcementsPath = "$dir/announcements.json";
        $announcementsDoc = is_file($announcementsPath) ? json_decode((string) file_get_contents($announcementsPath), true) : null;
        $announcements = is_array($announcementsDoc['announcements'] ?? null) ? $announcementsDoc['announcements'] : [];

        $out[] = [
            'id' => $id,
            'name' => is_string($meta['name'] ?? null) ? $meta['name'] : $id,
            'hasAnnouncerJson' => $hasAnnouncerJson,
            'config' => announcer_admin_public_config($config),
            'announcements' => $announcements,
            'queue' => (new JobQueue($dir))->counts(),
        ];
    }
    return $out;
}

/** Strips anything that isn't meant for the editor UI (nothing secret
 *  lives in config.php/announcer.json today, but authToken could arrive
 *  via config.local.php/env -- never echo it back to the browser). */
function announcer_admin_public_config(array $config): array
{
    unset($config['tts']['authToken']);
    return $config;
}

function announcer_admin_valid_voice(mixed $v): bool
{
    return is_string($v) && preg_match(ANNOUNCER_ADMIN_VOICE_PATTERN, $v) === 1;
}

function announcer_admin_valid_transition_id(mixed $v): bool
{
    return is_string($v) && strlen($v) <= 150 && preg_match(ANNOUNCER_ADMIN_TRANSITION_PATTERN, $v) === 1;
}

function announcer_admin_valid_hash(mixed $v): bool
{
    return is_string($v) && preg_match(ANNOUNCER_ADMIN_HASH_PATTERN, $v) === 1;
}

/** Validates and normalizes a channel's announcer.json from admin UI
 *  input. Throws AnnouncerAdminValidationError with a clear message on
 *  any problem; never partially writes anything on failure. */
function announcer_admin_normalize_config(mixed $config): array
{
    if (!is_array($config)) {
        throw new AnnouncerAdminValidationError('config must be an object.');
    }

    $out = ['enabled' => (bool) ($config['enabled'] ?? false)];

    if (!announcer_admin_valid_voice($config['voice'] ?? null)) {
        throw new AnnouncerAdminValidationError('voice must be a short alphanumeric/underscore identifier (e.g. "af_heart").');
    }
    $out['voice'] = $config['voice'];

    $speed = $config['speed'] ?? 1.0;
    if (!is_numeric($speed) || $speed < 0.5 || $speed > 2.0) {
        throw new AnnouncerAdminValidationError('speed must be a number between 0.5 and 2.0.');
    }
    $out['speed'] = (float) $speed;

    $language = $config['language'] ?? 'en-us';
    if (!is_string($language) || !preg_match('/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/', $language)) {
        throw new AnnouncerAdminValidationError('language must look like a BCP-47 tag, e.g. "en-us".');
    }
    $out['language'] = strtolower($language);

    foreach (['style', 'tone'] as $field) {
        $value = $config[$field] ?? '';
        if (!is_string($value) || strlen($value) > 300) {
            throw new AnnouncerAdminValidationError("$field must be a string of at most 300 characters.");
        }
        $out[$field] = $value;
    }

    $targetDuration = $config['targetDuration'] ?? 12;
    if (!is_numeric($targetDuration) || $targetDuration < 5 || $targetDuration > 60) {
        throw new AnnouncerAdminValidationError('targetDuration must be a number of seconds between 5 and 60.');
    }
    $out['targetDuration'] = (int) $targetDuration;

    $types = $config['types'] ?? null;
    if (!is_array($types) || $types === [] || !array_is_list($types)) {
        throw new AnnouncerAdminValidationError('types must be a non-empty list.');
    }
    $seen = [];
    foreach ($types as $t) {
        if (!is_string($t) || !in_array($t, ANNOUNCER_ADMIN_TYPES, true)) {
            throw new AnnouncerAdminValidationError('types must only contain: ' . implode(', ', ANNOUNCER_ADMIN_TYPES));
        }
        if (isset($seen[$t])) {
            throw new AnnouncerAdminValidationError("Duplicate type in list: \"$t\".");
        }
        $seen[$t] = true;
    }
    $out['types'] = array_values($types);

    $suppress = $config['consecutiveSameSeries'] ?? 'short';
    if (!in_array($suppress, ANNOUNCER_ADMIN_SUPPRESS_MODES, true)) {
        throw new AnnouncerAdminValidationError('consecutiveSameSeries must be one of: ' . implode(', ', ANNOUNCER_ADMIN_SUPPRESS_MODES));
    }
    $out['consecutiveSameSeries'] = $suppress;

    $writer = $config['writer'] ?? [];
    if (!is_array($writer)) {
        throw new AnnouncerAdminValidationError('writer must be an object.');
    }
    $writerProvider = $writer['provider'] ?? 'claude-cli';
    if (!in_array($writerProvider, ANNOUNCER_ADMIN_WRITER_PROVIDERS, true)) {
        throw new AnnouncerAdminValidationError('writer.provider must be one of: ' . implode(', ', ANNOUNCER_ADMIN_WRITER_PROVIDERS));
    }
    $writerModel = $writer['model'] ?? 'sonnet';
    if (!is_string($writerModel) || $writerModel === '' || strlen($writerModel) > 60) {
        throw new AnnouncerAdminValidationError('writer.model must be a non-empty string of at most 60 characters.');
    }
    $out['writer'] = ['provider' => $writerProvider, 'model' => $writerModel];

    // tts is a deployment-level setting (which Kokoro server/provider a
    // channel talks to), not editable in the admin UI. Unlike the fields
    // above, it's validated and included ONLY if the caller sent one, so a
    // request that omits it (every save from the UI) leaves whatever the channel's announcer.json
    // already has for `tts` completely untouched by the merge in
    // announcer_admin_save_config(), instead of clobbering a real
    // per-channel endpoint/provider override with a fabricated default.
    if (array_key_exists('tts', $config)) {
        $tts = $config['tts'];
        if (!is_array($tts)) {
            throw new AnnouncerAdminValidationError('tts must be an object.');
        }
        $ttsProvider = $tts['provider'] ?? 'kokoro-http';
        if (!in_array($ttsProvider, ANNOUNCER_ADMIN_TTS_PROVIDERS, true)) {
            throw new AnnouncerAdminValidationError('tts.provider must be one of: ' . implode(', ', ANNOUNCER_ADMIN_TTS_PROVIDERS));
        }
        $out['tts'] = ['provider' => $ttsProvider];
        if (isset($tts['endpoint'])) {
            if (!is_string($tts['endpoint']) || strlen($tts['endpoint']) > 300 || !preg_match('#^https?://#i', $tts['endpoint'])) {
                throw new AnnouncerAdminValidationError('tts.endpoint must be an http(s) URL.');
            }
            $out['tts']['endpoint'] = $tts['endpoint'];
        }
    }

    return $out;
}

/** @return array{config: array<string,mixed>} */
function announcer_admin_save_config(array $body, string $channelsDir = ADMIN_CHANNELS_DIR): array
{
    $channelId = $body['channel_id'] ?? null;
    $dir = admin_existing_channel_dir($channelId, $channelsDir);
    if ($dir === null) {
        throw new AnnouncerAdminValidationError('Unknown or invalid channel_id.');
    }
    $normalized = announcer_admin_normalize_config($body['config'] ?? null);

    // Merge onto the EXISTING raw announcer.json (same posture as
    // channel_admin_save_catalog()/save_programming() only touching the
    // key(s) their own UI edits) rather than replacing the whole file --
    // the UI only exposes a subset of possible fields (nothing for
    // writer.timeoutSeconds/bin, tts.timeoutSeconds/modelVersion/
    // authToken, mediaRoot, lookaheadHours, retry, wordsPerSecond,
    // audio...), and a hand-set value for any of those must survive a
    // click of "Save announcer config" rather than silently reverting to
    // the global default the next time this channel's config resolves.
    $existingPath = "$dir/announcer.json";
    $existing = is_file($existingPath) ? json_decode((string) file_get_contents($existingPath), true) : null;
    $merged = AnnouncerConfig::mergeDeep(is_array($existing) ? $existing : [], $normalized);

    admin_atomic_write_json($existingPath, $merged);
    return ['config' => $merged];
}

/** @return array{voices: list<string>, error: ?string} */
function announcer_admin_voices(string $channelId, string $channelsDir = ADMIN_CHANNELS_DIR): array
{
    $dir = admin_existing_channel_dir($channelId, $channelsDir);
    if ($dir === null) {
        throw new AnnouncerAdminValidationError('Unknown or invalid channel_id.');
    }
    $config = AnnouncerConfig::resolve($channelId, $channelsDir, announcer_admin_root());
    return KokoroHttpTtsProvider::listVoices($config['tts'] ?? [], 8);
}

/** @return list<string> */
function announcer_admin_build_regenerate_argv(string $channelId, string $transitionId, array $body): array
{
    $argv = [
        admin_php_binary(), ADMIN_ROOT . '/channels/announce.php',
        "--channel=$channelId", "--transition=$transitionId", '--sync', '--verbose',
    ];
    if (!empty($body['force'])) {
        $argv[] = '--force';
    } else {
        if (!empty($body['force_script'])) {
            $argv[] = '--force-script';
        }
        if (!empty($body['force_audio'])) {
            $argv[] = '--force-audio';
        }
    }
    return $argv;
}

/** @return array{exitCode:int, stdout:string, stderr:string, announcement:?array<string,mixed>} */
function announcer_admin_regenerate(array $body, string $channelsDir = ADMIN_CHANNELS_DIR): array
{
    $channelId = $body['channel_id'] ?? null;
    $dir = admin_existing_channel_dir($channelId, $channelsDir);
    if ($dir === null) {
        throw new AnnouncerAdminValidationError('Unknown or invalid channel_id.');
    }
    if (!is_file("$dir/announcer.json")) {
        throw new AnnouncerAdminValidationError('This channel has no announcer.json yet -- save a config first.');
    }
    $transitionId = $body['transition_id'] ?? null;
    if (!announcer_admin_valid_transition_id($transitionId)) {
        throw new AnnouncerAdminValidationError('Unknown or invalid transition_id.');
    }

    $argv = announcer_admin_build_regenerate_argv((string) $channelId, (string) $transitionId, $body);
    $result = admin_run_subprocess($argv);

    $announcement = null;
    $announcementsDoc = is_file("$dir/announcements.json") ? json_decode((string) file_get_contents("$dir/announcements.json"), true) : null;
    foreach (is_array($announcementsDoc['announcements'] ?? null) ? $announcementsDoc['announcements'] : [] as $entry) {
        if (is_array($entry) && ($entry['transitionId'] ?? null) === $transitionId) {
            $announcement = $entry;
            break;
        }
    }

    return $result + ['announcement' => $announcement];
}

/** @return array{exitCode:int, stdout:string, stderr:string} */
function announcer_admin_generate_queue(array $body, string $channelsDir = ADMIN_CHANNELS_DIR): array
{
    $channelId = $body['channel_id'] ?? null;
    $dir = admin_existing_channel_dir($channelId, $channelsDir);
    if ($dir === null) {
        throw new AnnouncerAdminValidationError('Unknown or invalid channel_id.');
    }
    if (!is_file("$dir/announcer.json")) {
        throw new AnnouncerAdminValidationError('This channel has no announcer.json yet -- save a config first.');
    }
    $argv = [admin_php_binary(), ADMIN_ROOT . '/channels/announce.php', "--channel=$channelId", '--verbose'];
    return admin_run_subprocess($argv);
}

/** @return array{url: string} */
function announcer_admin_preview_voice(array $body, string $channelsDir = ADMIN_CHANNELS_DIR): array
{
    $channelId = $body['channel_id'] ?? null;
    $dir = admin_existing_channel_dir($channelId, $channelsDir);
    if ($dir === null) {
        throw new AnnouncerAdminValidationError('Unknown or invalid channel_id.');
    }
    $voice = $body['voice'] ?? null;
    if (!announcer_admin_valid_voice($voice)) {
        throw new AnnouncerAdminValidationError('Unknown or invalid voice.');
    }

    $config = AnnouncerConfig::resolve((string) $channelId, $channelsDir, announcer_admin_root());
    $ttsConfig = $config['tts'] ?? [];
    if (($ttsConfig['provider'] ?? 'kokoro-http') === 'mock') {
        throw new AnnouncerAdminValidationError('This channel is configured to use the mock TTS provider -- nothing real to preview.');
    }

    $mediaRoot = is_string($config['mediaRoot'] ?? null) ? $config['mediaRoot'] : 'media/announcements';
    $previewDir = rtrim(ADMIN_ROOT, '/') . '/' . trim($mediaRoot, '/') . "/$channelId/.previews";
    if (!is_dir($previewDir) && !mkdir($previewDir, 0775, true) && !is_dir($previewDir)) {
        throw new RuntimeException("Failed to create directory: $previewDir");
    }

    $tts = KokoroHttpTtsProvider::fromConfig($ttsConfig);
    $wavPath = "$previewDir/$voice." . bin2hex(random_bytes(4)) . '.wav';
    $synth = $tts->synthesize(ANNOUNCER_ADMIN_PREVIEW_TEXT, (string) $voice, 1.0, (string) ($config['language'] ?? 'en-us'), $wavPath);
    if ($synth['error'] !== null || $synth['wavPath'] === null) {
        throw new RuntimeException("Voice preview synthesis failed: {$synth['error']}");
    }

    $mp3Path = "$previewDir/$voice.mp3";
    $audioProcessor = new AudioProcessor();
    $encoded = $audioProcessor->convertToMp3($synth['wavPath'], $mp3Path, $config['audio'] ?? []);
    @unlink($synth['wavPath']);
    if ($encoded['error'] !== null || $encoded['mp3Path'] === null) {
        throw new RuntimeException("Voice preview encoding failed: {$encoded['error']}");
    }

    return ['url' => '/' . trim($mediaRoot, '/') . "/$channelId/.previews/$voice.mp3?t=" . time()];
}

/** @return array{ok: true} */
function announcer_admin_approve_script(array $body, string $channelsDir = ADMIN_CHANNELS_DIR): array
{
    $channelId = $body['channel_id'] ?? null;
    $dir = admin_existing_channel_dir($channelId, $channelsDir);
    if ($dir === null) {
        throw new AnnouncerAdminValidationError('Unknown or invalid channel_id.');
    }
    $hash = $body['script_hash'] ?? null;
    if (!announcer_admin_valid_hash($hash)) {
        throw new AnnouncerAdminValidationError('Unknown or invalid script_hash.');
    }
    $text = $body['text'] ?? null;
    if (!is_string($text) || trim($text) === '') {
        throw new AnnouncerAdminValidationError('text must be a non-empty string.');
    }
    if (strlen($text) > 2000) {
        throw new AnnouncerAdminValidationError('text is implausibly long for a spoken announcement (2000 character limit).');
    }
    ScriptCache::approve($dir, (string) $hash, $text);
    return ['ok' => true];
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
                admin_json_response(200, ['ok' => true, 'channels' => announcer_admin_list()]);
            }
            if ($action === 'voices') {
                $result = announcer_admin_voices((string) ($_GET['channel_id'] ?? ''));
                admin_json_response(200, ['ok' => true] + $result);
            }
            admin_json_response(400, ['ok' => false, 'error' => 'Unknown GET action.']);
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $body = admin_read_json_body();
            $action = $body['action'] ?? null;
            $result = match ($action) {
                'save_config' => announcer_admin_save_config($body),
                'preview_voice' => announcer_admin_preview_voice($body),
                'regenerate' => announcer_admin_regenerate($body),
                'generate_queue' => announcer_admin_generate_queue($body),
                'approve_script' => announcer_admin_approve_script($body),
                default => throw new AnnouncerAdminValidationError('Unknown action.'),
            };
            admin_json_response(200, ['ok' => true] + $result);
        }

        admin_json_response(405, ['ok' => false, 'error' => 'GET or POST only.']);
    } catch (AnnouncerAdminValidationError $e) {
        admin_json_response(400, ['ok' => false, 'error' => $e->getMessage()]);
    } catch (Throwable $e) {
        admin_json_response(500, ['ok' => false, 'error' => $e->getMessage()]);
    }
}
