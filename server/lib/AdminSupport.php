<?php
declare(strict_types=1);

// server/lib/AdminSupport.php
//
// Shared bootstrap every admin-UI PHP endpoint (series-admin.php,
// channel-admin.php, and any future one) requires first. Three jobs:
//
//  1. ACCESS CONTROL HOOK -- admin_require_auth(), currently a no-op.
//     Per an explicit, documented product decision, this admin UI has
//     NO ACCESS CONTROL as of this phase: anyone who can reach this PHP
//     on the server can view/edit series metadata, edit channel
//     programming, and trigger real YouTube API imports and schedule
//     publishes. See docs/admin-ui.md ("No access control") for the
//     full operational warning. Every endpoint calls admin_require_auth()
//     first, before touching the filesystem or a request body, so a real
//     check (session, API key, IP allowlist -- whatever's decided later)
//     has exactly one place to go in and every endpoint picks it up with
//     no other changes.
//
//  2. PATH/ID SAFETY -- separate from (1): even with no login required,
//     nothing here ever lets a request body steer a filesystem path or a
//     subprocess argument unchecked. Every id that becomes part of a
//     path (a series id, a channel id) is validated against a strict
//     whitelist regex AND, where it's expected to already exist, against
//     the real filesystem -- never trusted from a request body as a bare
//     string.
//
//  3. Small shared utilities: JSON request/response helpers, an atomic
//     JSON file writer (temp file + rename + one-generation .bak -- the
//     same pattern as youtube-import/src/YouTubeSeriesWriter.php and
//     channels/publish/src/ScheduleWriter.php -- series.json writes in
//     series-admin.php reuse YouTubeSeriesWriter directly instead of
//     this helper, since it already is exactly the right class;
//     catalog.json/programming.json writes in channel-admin.php use this
//     helper, mirrored rather than shared, since ScheduleWriter's
//     equivalent isn't exposed as a public reusable method), and a safe
//     subprocess runner.

const ADMIN_ROOT = __DIR__ . '/../..'; // repo root (server/lib/../..)
const ADMIN_SERIES_DIR = ADMIN_ROOT . '/series';
const ADMIN_CHANNELS_DIR = ADMIN_ROOT . '/channels';
const ADMIN_ID_PATTERN = '/^[a-z0-9][a-z0-9-]*$/'; // same convention as CHANNEL_ID (broadcast.js) and series ids everywhere else

/** The access-control hook. Currently a no-op -- see this file's header. */
function admin_require_auth(): void
{
    // Intentionally empty.
}

function admin_json_response(int $status, array $body): never
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/** @return array<string,mixed> empty array if the body is missing/not a JSON object */
function admin_read_json_body(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode((string) $raw, true);
    return is_array($data) ? $data : [];
}

function admin_valid_id(mixed $id): bool
{
    return is_string($id) && $id !== '' && strlen($id) <= 100 && preg_match(ADMIN_ID_PATTERN, $id) === 1;
}

/** Validates $id's shape AND that series/<id>/series.json really exists
 *  on disk right now. Returns the absolute path on success, null on any
 *  failure -- callers must treat null as "reject the request". */
function admin_existing_series_path(mixed $id, string $seriesDir = ADMIN_SERIES_DIR): ?string
{
    if (!admin_valid_id($id)) {
        return null;
    }
    $path = "$seriesDir/$id/series.json";
    return is_file($path) ? $path : null;
}

/** Validates $id's shape and that it does NOT already exist -- for
 *  creating a brand-new series via import, so a request can never
 *  silently overwrite an existing one through this path. */
function admin_new_series_path(mixed $id, string $seriesDir = ADMIN_SERIES_DIR): ?string
{
    if (!admin_valid_id($id)) {
        return null;
    }
    $dir = "$seriesDir/$id";
    return is_dir($dir) ? null : "$dir/series.json";
}

function admin_existing_channel_dir(mixed $id, string $channelsDir = ADMIN_CHANNELS_DIR): ?string
{
    if (!admin_valid_id($id)) {
        return null;
    }
    $dir = "$channelsDir/$id";
    return (is_dir($dir) && is_file("$dir/meta.json")) ? $dir : null;
}

/** @return array<string,string> series id => absolute series.json path, for every series directory on disk */
function admin_list_series_paths(string $seriesDir = ADMIN_SERIES_DIR): array
{
    $out = [];
    foreach (glob($seriesDir . '/*/series.json') ?: [] as $path) {
        $id = basename(dirname($path));
        if (admin_valid_id($id)) {
            $out[$id] = $path;
        }
    }
    ksort($out);
    return $out;
}

/** @return array<string,string> channel id => absolute channel directory, for every channel directory on disk */
function admin_list_channel_dirs(string $channelsDir = ADMIN_CHANNELS_DIR): array
{
    $out = [];
    foreach (glob($channelsDir . '/*/meta.json') ?: [] as $path) {
        $id = basename(dirname($path));
        if (admin_valid_id($id)) {
            $out[$id] = dirname($path);
        }
    }
    ksort($out);
    return $out;
}

/** Atomic write (temp file + rename) with a single-generation .bak --
 *  mirrors youtube-import/src/YouTubeSeriesWriter.php and
 *  channels/publish/src/ScheduleWriter.php. */
function admin_atomic_write_json(string $path, array $data): void
{
    $dir = dirname($path);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        throw new RuntimeException("Failed to create directory: $dir");
    }
    if (is_file($path)) {
        // Replace (don't overwrite) a stale .bak: it may be owned by the other user (web server vs CLI)
        // and not writable, but removing/creating it only needs the directory's group write bit.
        @unlink($path . '.bak');
        if (!copy($path, $path . '.bak')) {
            throw new RuntimeException("Failed to back up existing file before overwriting: $path.bak");
        }
        @chmod($path . '.bak', 0664);
    }
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        throw new RuntimeException("Failed to encode JSON for: $path");
    }
    static $counter = 0;
    $tmp = $path . '.' . getmypid() . '.' . (++$counter) . '.tmp';
    if (file_put_contents($tmp, $json . "\n") === false) {
        throw new RuntimeException("Failed to write temp file: $tmp");
    }
    if (!rename($tmp, $path)) {
        @unlink($tmp);
        throw new RuntimeException("Failed to finalize write for: $path");
    }
    @chmod($path, 0664); // group-writable: the web server (www-data) and the CLI user share these files
}

/** The CLI PHP binary to shell out to. PHP_BINARY is unreliable under
 *  some web server SAPIs (e.g. may point at php-fpm's own binary, not a
 *  usable CLI executable, or be empty under mod_php) -- prefer an
 *  explicit CRVIDEO_PHP_BINARY env var when set, fall back to PHP_BINARY
 *  only if it looks like a real, executable CLI binary, else fall back
 *  to bare "php" relying on $PATH. */
function admin_php_binary(): string
{
    $override = getenv('CRVIDEO_PHP_BINARY');
    if (is_string($override) && $override !== '') {
        return $override;
    }
    if (PHP_BINARY !== '' && is_executable(PHP_BINARY)) {
        return PHP_BINARY;
    }
    return 'php';
}

/**
 * Runs a subprocess from an argv ARRAY -- never a shell string. PHP
 * passes each element as a literal argument with no shell interpretation
 * at all (this is not "escaping", the shell is never invoked), which is
 * the strongest available protection against command injection
 * regardless of what the arguments contain. This is still not a
 * substitute for the path/id whitelisting above: an argument that's
 * perfectly safe from a shell's point of view can still be a path-
 * traversal string from this application's point of view, which is why
 * every argument that becomes a filesystem path is whitelist-validated
 * *before* it ever reaches this function, not relied on this function to
 * catch.
 *
 * @param list<string> $argv
 * @return array{exitCode:int, stdout:string, stderr:string}
 */
function admin_run_subprocess(array $argv, ?string $cwd = null): array
{
    $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $process = proc_open($argv, $descriptors, $pipes, $cwd ?? ADMIN_ROOT);
    if (!is_resource($process)) {
        throw new RuntimeException('Failed to start subprocess: ' . ($argv[0] ?? ''));
    }
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exitCode = proc_close($process);
    return ['exitCode' => $exitCode, 'stdout' => (string) $stdout, 'stderr' => (string) $stderr];
}
