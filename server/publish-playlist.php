<?php
declare(strict_types=1);

// server/publish-playlist.php
//
// Lets the scheduler (scheduler/index.html) write a new recurring-format
// playlist.json directly to the live file sync-player.html and
// download-cache.php both read -- the instant-effect alternative to
// round-tripping through Drive. Protected by a shared-secret token (see
// server/publish-secret.php) since this is a write-capable endpoint on a
// publicly reachable domain with no login system in front of it.

const ROOT = __DIR__ . '/..';
const PLAYLIST_PATH = ROOT . '/playlist.json';
const BACKUP_PATH = ROOT . '/playlist.json.bak';
const SECRET_PATH = __DIR__ . '/publish-secret.php';
const LOG_PATH = __DIR__ . '/publish.log';
const MAX_ENTRIES = 1000; // sanity ceiling, not a real-world limit (72 today)

header('Content-Type: application/json');

function respond(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body);
    exit;
}

function log_line(string $msg): void
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    @file_put_contents(LOG_PATH, gmdate('c') . " [$ip] $msg" . PHP_EOL, FILE_APPEND);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['ok' => false, 'error' => 'POST only.']);
}

if (!is_file(SECRET_PATH)) {
    respond(500, ['ok' => false, 'error' => 'Server not configured: missing publish-secret.php.']);
}
$expectedToken = (string) require SECRET_PATH;
$givenToken = $_SERVER['HTTP_X_PUBLISH_TOKEN'] ?? '';
if ($expectedToken === '' || !hash_equals($expectedToken, $givenToken)) {
    log_line('REJECTED: bad or missing token');
    respond(403, ['ok' => false, 'error' => 'Invalid or missing publish token.']);
}

$raw = file_get_contents('php://input');
$data = json_decode($raw, true);
if (!is_array($data)) {
    respond(400, ['ok' => false, 'error' => 'Body is not valid JSON.']);
}

// ---- Validate shape: only the recurring format is accepted here. ----
if (($data['recurring'] ?? null) !== true) {
    respond(400, ['ok' => false, 'error' => '"recurring" must be true -- this endpoint only accepts the recurring playlist format.']);
}
$timezone = $data['timezone'] ?? null;
if (!is_string($timezone) || $timezone === '') {
    respond(400, ['ok' => false, 'error' => 'Missing or invalid "timezone".']);
}
try {
    new DateTimeZone($timezone);
} catch (Throwable) {
    respond(400, ['ok' => false, 'error' => "\"$timezone\" is not a valid IANA timezone."]);
}
$entries = $data['entries'] ?? null;
if (!is_array($entries) || !$entries) {
    respond(400, ['ok' => false, 'error' => '"entries" must be a non-empty array.']);
}
if (count($entries) > MAX_ENTRIES) {
    respond(400, ['ok' => false, 'error' => 'Too many entries (max ' . MAX_ENTRIES . ').']);
}

$seenIds = [];
foreach ($entries as $i => $e) {
    if (!is_array($e)) {
        respond(400, ['ok' => false, 'error' => "entries[$i] is not an object."]);
    }
    foreach (['id', 'title'] as $field) {
        if (!is_string($e[$field] ?? null) || $e[$field] === '') {
            respond(400, ['ok' => false, 'error' => "entries[$i].$field must be a non-empty string."]);
        }
    }
    foreach (['startSec', 'endSec'] as $field) {
        if (!is_int($e[$field] ?? null) && !is_float($e[$field] ?? null)) {
            respond(400, ['ok' => false, 'error' => "entries[$i].$field must be a number."]);
        }
    }
    if ($e['endSec'] <= $e['startSec']) {
        respond(400, ['ok' => false, 'error' => "entries[$i]: endSec must be after startSec."]);
    }
    $hasDriveFileId = is_string($e['driveFileId'] ?? null) && $e['driveFileId'] !== '';
    $hasUrl = is_string($e['url'] ?? null) && $e['url'] !== '';
    if (!$hasDriveFileId && !$hasUrl) {
        respond(400, ['ok' => false, 'error' => "entries[$i] needs either driveFileId or url."]);
    }
    if (isset($seenIds[$e['id']])) {
        respond(400, ['ok' => false, 'error' => "Duplicate entry id \"{$e['id']}\"."]);
    }
    $seenIds[$e['id']] = true;
}

// ---- Write: back up the current file, then atomic replace. ----
usort($entries, fn($a, $b) => $a['startSec'] <=> $b['startSec']);
$out = [
    'version' => 2,
    'recurring' => true,
    'timezone' => $timezone,
    'entries' => array_values($entries),
];

if (is_file(PLAYLIST_PATH)) {
    if (!copy(PLAYLIST_PATH, BACKUP_PATH)) {
        respond(500, ['ok' => false, 'error' => 'Could not back up the existing playlist.json; aborting without writing.']);
    }
    @chmod(BACKUP_PATH, 0664); // keep it editable by the cdr-group side too, not just whoever wrote it
}

$tmpPath = PLAYLIST_PATH . '.tmp';
if (file_put_contents($tmpPath, json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) === false) {
    respond(500, ['ok' => false, 'error' => 'Could not write temp file.']);
}
@chmod($tmpPath, 0664);
if (!rename($tmpPath, PLAYLIST_PATH)) {
    @unlink($tmpPath);
    respond(500, ['ok' => false, 'error' => 'Could not replace playlist.json.']);
}

log_line('Published ' . count($entries) . ' entries.');
respond(200, ['ok' => true, 'entries' => count($entries)]);
