<?php
// Lists the channels for the guide: every folder under channels/ that has a
// meta.json. Adding a channel is adding a folder -- there is no index to
// keep in sync. A channel folder looks like:
//
//   channels/<id>/meta.json      {"number": 2, "name": "...", "description": "...",
//                                 "logo": "logo.svg", "anchor": "optional ISO time",
//                                 "hidden": false}
//   channels/<id>/schedule.json  ia-import --output
//   channels/<id>/catalog.json   ia-import --catalog (optional; adds year/description)
//   channels/<id>/logo.svg       any image meta.json's "logo" points at
//
// <id> must be lowercase letters, digits and dashes; it's the ?ch= value
// watch.html takes.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache');

$channels = [];
foreach (glob(__DIR__ . '/*/meta.json') ?: [] as $file) {
    $id = basename(dirname($file));
    if (!preg_match('/^[a-z0-9][a-z0-9-]*$/', $id)) {
        continue;
    }
    $meta = json_decode((string) file_get_contents($file), true);
    if (!is_array($meta) || !empty($meta['hidden'])) {
        continue;
    }
    $channels[] = ['id' => $id] + $meta;
}

// By channel number, then name; channels without a number go last.
usort($channels, static function (array $a, array $b): int {
    $an = isset($a['number']) && is_numeric($a['number']) ? (float) $a['number'] : INF;
    $bn = isset($b['number']) && is_numeric($b['number']) ? (float) $b['number'] : INF;
    return [$an, (string) ($a['name'] ?? $a['id'])] <=> [$bn, (string) ($b['name'] ?? $b['id'])];
});

echo json_encode(['channels' => $channels], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
