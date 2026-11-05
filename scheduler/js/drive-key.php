<?php
declare(strict_types=1);

// scheduler/js/drive-key.php
//
// Serves GOOGLE_API_KEY as a plain ES module, the same shape
// drive-config.js used to export it as a literal string -- so
// channel.html's `import { GOOGLE_API_KEY } from "..."` keeps working with
// a one-line change to *where* it imports from, nothing else.
//
// The real value is never committed. In order:
//   1. the GOOGLE_DRIVE_API_KEY environment variable, or
//   2. an untracked local PHP file (default scheduler/drive-config.local.php,
//      override with ?config=... for testing only -- see below) returning:
//        <?php
//        return ['api_key' => 'YOUR_KEY'];
//
// This key is still delivered to every browser that loads channel.html --
// that's inherent to how the Drive REST API is called client-side (see
// GOOGLE_DRIVE_SETUP.md). Moving it here only gets it out of version
// control and lets it be rotated without a code change; it is not a
// substitute for the Cloud Console "API restrictions" + "HTTP referrers"
// restrictions documented in GOOGLE_DRIVE_SETUP.md, which remain the real
// abuse control for a key that must be public-reachable by design.

header('Content-Type: application/javascript; charset=utf-8');
header('Cache-Control: no-store');

function drive_key_resolve(): ?string
{
    $fromEnv = getenv('GOOGLE_DRIVE_API_KEY');
    if (is_string($fromEnv) && $fromEnv !== '') {
        return $fromEnv;
    }

    $configPath = __DIR__ . '/../drive-config.local.php';
    if (is_file($configPath)) {
        $config = require $configPath;
        if (is_array($config) && is_string($config['api_key'] ?? null) && $config['api_key'] !== '') {
            return $config['api_key'];
        }
    }

    return null;
}

$apiKey = drive_key_resolve();

if ($apiKey === null) {
    // No key configured -- export null rather than failing the request, so
    // channel.html's own existing "Google API key not configured" message
    // (it already checks `if (!GOOGLE_API_KEY)`) is what the viewer sees,
    // not a broken module load.
    echo "export const GOOGLE_API_KEY = null;\n";
    exit;
}

echo 'export const GOOGLE_API_KEY = ' . json_encode($apiKey, JSON_THROW_ON_ERROR) . ";\n";
