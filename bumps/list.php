<?php
// Public, read-only list of every bump for bumps/bump.html (the standalone
// previewer). Like channels/channels.php, adding a bump is adding a file --
// there is no index to keep in sync. server/bump-admin.php stays the only
// writer (and is auth-gated, which is why the previewer can't use it).
//
// Returns {"bumps": [<full bump JSON>, ...]} sorted by name.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache');

$bumps = [];
foreach (glob(__DIR__ . '/*.json') ?: [] as $file) {
    $id = basename($file, '.json');
    if (!preg_match('/^[a-z0-9][a-z0-9-]{0,59}$/', $id)) {
        continue;
    }
    $doc = json_decode((string) file_get_contents($file), true);
    if (!is_array($doc) || !isset($doc['background']) || !is_array($doc['background'])) {
        continue;
    }
    $doc['id'] = $id;
    $doc['name'] = is_string($doc['name'] ?? null) && $doc['name'] !== '' ? $doc['name'] : $id;
    $bumps[] = $doc;
}

usort($bumps, static fn (array $a, array $b): int => strcasecmp($a['name'], $b['name']));

echo json_encode(['bumps' => $bumps], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
