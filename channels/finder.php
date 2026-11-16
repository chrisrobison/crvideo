<?php
// Viewer-facing show data for Browse / Show pages (channels/browse.html,
// channels/show.html). See channels/finder/src/FinderBuilder.php for what is
// (and deliberately is not) exposed.
//
//   GET finder.php              {"generated_at", "shows": [{id, title, description,
//                                thumbnail_url, creator, year, channels[], episode_count}]}
//   GET finder.php?show=<id>    one show plus its approved episodes
//
// The index touches ~30 MB of series files, so it is cached in
// channels/finder/.cache/index.json and rebuilt only when any input file
// (series.json, a channel's catalog.json/meta.json) is newer than the cache.
// Cache I/O is best effort: if the directory isn't writable the index is just
// rebuilt per request.

declare(strict_types=1);

require __DIR__ . '/finder/src/FinderBuilder.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=60');

const FINDER_JSON = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;

$builder = new FinderBuilder(dirname(__DIR__));

if (isset($_GET['show'])) {
    $show = is_string($_GET['show']) ? $builder->show($_GET['show']) : null;
    if ($show === null) {
        http_response_code(404);
        echo json_encode(['error' => 'Unknown show'], FINDER_JSON);
        exit;
    }
    echo json_encode($show, FINDER_JSON);
    exit;
}

$cacheDir = __DIR__ . '/finder/.cache';
$cacheFile = $cacheDir . '/index.json';
$sourceMtime = $builder->sourceMtime();

$cached = @file_get_contents($cacheFile);
if ($cached !== false) {
    $decoded = json_decode($cached, true);
    if (is_array($decoded) && ($decoded['source_mtime'] ?? -1) >= $sourceMtime) {
        echo $cached;
        exit;
    }
}

$json = json_encode($builder->index(), FINDER_JSON);
if (is_string($json)) {
    if (!is_dir($cacheDir)) {
        @mkdir($cacheDir, 0775, true);
        @chmod($cacheDir, 02775); // group-writable: www-data and the CLI user share it (umask would strip it)
    }
    $tmp = $cacheFile . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (@file_put_contents($tmp, $json) !== false) {
        @chmod($tmp, 0664);
        if (!@rename($tmp, $cacheFile)) {
            @unlink($tmp);
        }
    }
}
echo $json;
