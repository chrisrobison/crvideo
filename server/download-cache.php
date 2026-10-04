#!/usr/bin/env php
<?php
declare(strict_types=1);

// server/download-cache.php
//
// Pre-fetches the Drive-hosted video file for the playlist entry that is
// currently airing, plus the one airing next, down to local disk -- so
// sync-player.html can play a same-origin static file instead of every
// viewer's browser streaming straight from the Drive API with an OAuth
// token in the URL. That direct-from-browser pattern is what was tripping
// Google's anti-abuse "automated queries" block; a local copy sidesteps it
// entirely (no cross-site request, no token in the URL, no ORB involved).
//
// Run this on a short interval via cron (see server/README.md) -- it's
// cheap to invoke repeatedly since it only downloads what's missing and
// exits immediately once the two wanted files are present.
//
// Dependencies: PHP's curl + openssl + json extensions (all bundled with a
// normal PHP install, nothing to composer-install).
//
// One-time setup required before this will work: server/README.md.

const ROOT = __DIR__ . '/..';
const PLAYLIST_PATH = ROOT . '/playlist.json';
const CACHE_DIR = ROOT . '/cache';
const MANIFEST_PATH = CACHE_DIR . '/manifest.json';
const KEY_PATH = __DIR__ . '/service-account.json';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function log_line(string $msg): void
{
    fwrite(STDOUT, gmdate('c') . ' ' . $msg . PHP_EOL);
}

function base64url(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

/** Mint a short-lived Drive-readonly access token from the service-account key. */
function getAccessToken(): string
{
    if (!is_file(KEY_PATH)) {
        throw new RuntimeException(
            'Missing server/service-account.json -- see server/README.md for the one-time ' .
            'service-account setup (create it, share the Drive folder with it, drop the JSON key here).'
        );
    }
    $key = json_decode((string) file_get_contents(KEY_PATH), true);
    if (!is_array($key) || empty($key['private_key']) || empty($key['client_email'])) {
        throw new RuntimeException('service-account.json is missing private_key/client_email.');
    }

    $now = time();
    $header = base64url((string) json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
    $claims = base64url((string) json_encode([
        'iss' => $key['client_email'],
        'scope' => DRIVE_SCOPE,
        'aud' => TOKEN_URL,
        'iat' => $now,
        'exp' => $now + 3600,
    ]));
    $signingInput = $header . '.' . $claims;

    $signature = '';
    if (!openssl_sign($signingInput, $signature, $key['private_key'], OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('Failed to sign JWT with the service-account private key.');
    }
    $jwt = $signingInput . '.' . base64url($signature);

    $ch = curl_init(TOKEN_URL);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query([
            'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'assertion' => $jwt,
        ]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    if ($body === false) {
        throw new RuntimeException("Token request failed: $err");
    }
    $data = json_decode((string) $body, true);
    if ($status !== 200 || empty($data['access_token'])) {
        throw new RuntimeException("Token request returned HTTP $status: $body");
    }
    return $data['access_token'];
}

/** seconds-since-local-midnight in $tz -- mirrors sync-player.html's math. */
function secondsSinceMidnight(DateTimeImmutable $now, string $tz): int
{
    $local = $now->setTimezone(new DateTimeZone($tz));
    return ((int) $local->format('H')) * 3600 + ((int) $local->format('i')) * 60 + ((int) $local->format('s'));
}

function loadPlaylist(): array
{
    $raw = json_decode((string) file_get_contents(PLAYLIST_PATH), true);
    if (!is_array($raw) || empty($raw['recurring'])) {
        throw new RuntimeException('download-cache.php only supports the recurring playlist format right now.');
    }
    $entries = $raw['entries'];
    usort($entries, fn(array $a, array $b) => $a['startSec'] <=> $b['startSec']);
    return ['entries' => $entries, 'timezone' => $raw['timezone'] ?? 'UTC'];
}

function findCurrentAndNext(array $entries, int $nowSec): array
{
    $idx = null;
    foreach ($entries as $i => $e) {
        if ($nowSec >= $e['startSec'] && $nowSec < $e['endSec']) {
            $idx = $i;
            break;
        }
    }
    if ($idx === null) {
        return ['current' => null, 'next' => $entries[0] ?? null];
    }
    return ['current' => $entries[$idx], 'next' => $entries[($idx + 1) % count($entries)]];
}

function downloadToFile(string $fileId, string $token, string $destPath): void
{
    $tmpPath = $destPath . '.part';
    $fh = fopen($tmpPath, 'wb');
    if ($fh === false) {
        throw new RuntimeException("Could not open $tmpPath for writing.");
    }

    $ch = curl_init("https://www.googleapis.com/drive/v3/files/$fileId?alt=media");
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => ["Authorization: Bearer $token"],
        CURLOPT_FILE => $fh,
        CURLOPT_TIMEOUT => 1800, // large files; generous ceiling
        CURLOPT_CONNECTTIMEOUT => 30,
    ]);
    $ok = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    fclose($fh);

    if (!$ok || $status !== 200) {
        @unlink($tmpPath);
        throw new RuntimeException("Download failed (HTTP $status): $err");
    }
    rename($tmpPath, $destPath);
}

function readManifest(): array
{
    if (!is_file(MANIFEST_PATH)) {
        return [];
    }
    $data = json_decode((string) file_get_contents(MANIFEST_PATH), true);
    return is_array($data) ? $data : [];
}

function cleanupOrphanedPartFiles(): void
{
    // A cron entry wraps this script in `flock -n`, so only one instance ever
    // runs at a time -- any .part file found here is leftover from a run that
    // crashed or got killed mid-download, never one that's actively writing.
    foreach (glob(CACHE_DIR . '/*.mp4.part') ?: [] as $f) {
        log_line('Removing orphaned partial download ' . basename($f));
        @unlink($f);
    }
}

function main(): int
{
    if (!is_dir(CACHE_DIR)) {
        mkdir(CACHE_DIR, 0775, true);
    }
    cleanupOrphanedPartFiles();

    ['entries' => $entries, 'timezone' => $tz] = loadPlaylist();
    $nowSec = secondsSinceMidnight(new DateTimeImmutable('now'), $tz);
    ['current' => $current, 'next' => $next] = findCurrentAndNext($entries, $nowSec);
    $wanted = array_values(array_filter([$current, $next]));

    if (!$wanted) {
        log_line('Nothing scheduled right now; nothing to do.');
        return 0;
    }

    $manifest = readManifest();
    $keepIds = array_map(fn(array $e) => $e['driveFileId'], $wanted);
    $token = null;
    $hadFailure = false;

    foreach ($wanted as $entry) {
        $fileId = $entry['driveFileId'];
        $destPath = CACHE_DIR . "/$fileId.mp4";

        if (is_file($destPath) && filesize($destPath) > 0) {
            $manifest[$fileId] = [
                'ready' => true,
                'path' => "cache/$fileId.mp4",
                'title' => $entry['title'],
                'updatedAt' => $manifest[$fileId]['updatedAt'] ?? gmdate('c'),
            ];
            continue;
        }

        log_line("Downloading \"{$entry['title']}\" ($fileId)...");
        try {
            $token ??= getAccessToken();
            downloadToFile($fileId, $token, $destPath);
            $manifest[$fileId] = [
                'ready' => true,
                'path' => "cache/$fileId.mp4",
                'title' => $entry['title'],
                'updatedAt' => gmdate('c'),
            ];
            log_line("Done: \"{$entry['title']}\"");
        } catch (Throwable $e) {
            log_line("FAILED to download \"{$entry['title']}\" ($fileId): " . $e->getMessage());
            $manifest[$fileId] = [
                'ready' => false,
                'title' => $entry['title'],
                'error' => $e->getMessage(),
                'updatedAt' => gmdate('c'),
            ];
            $hadFailure = true;
        }
    }

    // Keep the cache to exactly what's current/next -- evict everything else
    // (manifest entries and the .mp4 files themselves) so disk usage stays
    // bounded to ~2 segments instead of growing toward the full 24h loop.
    foreach (array_keys($manifest) as $id) {
        if (!in_array($id, $keepIds, true)) {
            unset($manifest[$id]);
        }
    }
    foreach (glob(CACHE_DIR . '/*.mp4') ?: [] as $f) {
        $id = basename($f, '.mp4');
        if (!in_array($id, $keepIds, true)) {
            log_line('Evicting stale cached file ' . basename($f));
            @unlink($f);
        }
    }

    file_put_contents(MANIFEST_PATH, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    return $hadFailure ? 1 : 0;
}

exit(main());
