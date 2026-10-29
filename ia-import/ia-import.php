#!/usr/bin/env php
<?php
declare(strict_types=1);

// ia-import/ia-import.php
//
// Standalone CLI: imports an Internet Archive user-created list, fetches
// metadata for each item, resolves one playable file + duration per film,
// and builds an optimized fixed-block programming schedule plus a reusable
// media catalog. See ia-import/README.md for full usage and output schema
// notes.
//
// No framework, no Composer -- plain PHP, manually required below, same
// style as server/publish-playlist.php elsewhere in this repo.

// This is a batch CLI job, not a shared web request, and the spec calls
// for supporting lists of hundreds to thousands of items -- all of whose
// decoded raw metadata is held in memory for the duration of a run (see
// README "Known limitations": this is not a streaming pipeline). Real IA
// /metadata/ responses run up to a couple of MB each, and PHP's decoded
// array overhead is a large multiple of that, so a default 128M CLI
// memory_limit is routinely too small for a few hundred real items. Raise
// it (without overriding an operator who has already set something more
// generous via php.ini/-d) rather than fail partway through a long run.
$currentLimitBytes = ia_import_bytes(ini_get('memory_limit'));
if ($currentLimitBytes !== -1 && $currentLimitBytes < 512 * 1024 * 1024) {
    ini_set('memory_limit', '512M');
}

function ia_import_bytes(string|false $iniValue): int
{
    $v = trim((string) $iniValue);
    if ($v === '' || $v === '-1') {
        return -1;
    }
    $unit = strtolower(substr($v, -1));
    $num = (int) $v;
    return match ($unit) {
        'g' => $num * 1024 * 1024 * 1024,
        'm' => $num * 1024 * 1024,
        'k' => $num * 1024,
        default => (int) $v,
    };
}

const IA_ROOT = __DIR__;

require IA_ROOT . '/src/DurationParser.php';
require IA_ROOT . '/src/ArchiveListParser.php';
require IA_ROOT . '/src/MetadataCache.php';
require IA_ROOT . '/src/ArchiveMetadataClient.php';
require IA_ROOT . '/src/MediaResolver.php';
require IA_ROOT . '/src/MediaCatalog.php';
require IA_ROOT . '/src/ScheduleOptimizer.php';
require IA_ROOT . '/src/FillerSelector.php';
require IA_ROOT . '/src/ScheduleExporter.php';
require IA_ROOT . '/src/ImportReporter.php';

function ia_import_usage(): string
{
    return <<<USAGE
    Internet Archive Import Scheduler

    Usage:
      php ia-import.php <list.json> [options]

    Options:
      --output=PATH          Output schedule JSON (default: schedule.json)
      --catalog=PATH         Output reusable media catalog (default: catalog.json)
      --slot=MINUTES         Scheduling block length: 15, 30, 60 (default: 30)
      --strategy=NAME        sequential, best-fit, balanced (default: balanced)
      --tolerance=SECONDS    Maximum acceptable unused slot time (default: 0)
      --filler=PATH          Optional JSON library of filler clips
      --preserve-order       Prefer original list order (alias for --strategy=sequential
                              unless --strategy is also given, in which case it is a no-op
                              hint already implied by "balanced")
      --max-shift=N          Maximum positional shift from original order
      --cache-dir=PATH       Local metadata cache (default: .cache/internet-archive)
      --refresh              Ignore cached metadata
      --concurrency=N        Concurrent metadata requests (default: 4)
      --timeout=SECONDS      Request timeout (default: 15)
      --dry-run              Analyze without writing outputs
      --verbose              Detailed logging + block-by-block report
      --allow-other-formats  Allow non-MP4 browser-playable formats (e.g. ogv/webm)
      --oversized=POLICY     overflow (default), exclude, or split (rejected: not implemented)
      --budget=N              Optimizer local-search iteration budget (default varies by strategy)
      --filler-window=N      Recent-filler avoidance window (default: 5)
      --fixtures=DIR         Serve metadata fetches from DIR/{identifier}.json instead of the
                              network (no live network access required; see tests/).
      --help                 Display this message

    Examples:
      php ia-import.php film-day.json
      php ia-import.php film-day.json --slot=15
      php ia-import.php film-day.json --slot=60 --strategy=best-fit --verbose

    USAGE;
}

/** @return array{positional: list<string>, options: array<string,string|bool>} */
function ia_import_parse_args(array $argv): array
{
    $positional = [];
    $options = [];
    foreach (array_slice($argv, 1) as $arg) {
        if ($arg === '--help' || $arg === '-h') {
            $options['help'] = true;
            continue;
        }
        if (str_starts_with($arg, '--')) {
            $body = substr($arg, 2);
            if (str_contains($body, '=')) {
                [$name, $value] = explode('=', $body, 2);
                $options[$name] = $value;
            } else {
                $options[$body] = true;
            }
            continue;
        }
        $positional[] = $arg;
    }
    return ['positional' => $positional, 'options' => $options];
}

function ia_import_main(array $argv): int
{
    $parsed = ia_import_parse_args($argv);
    $opt = $parsed['options'];

    if (!empty($opt['help']) || !$parsed['positional']) {
        echo ia_import_usage();
        return empty($opt['help']) ? 1 : 0;
    }

    $listPath = $parsed['positional'][0];
    $slotMinutes = isset($opt['slot']) ? (int) $opt['slot'] : 30;
    if (!in_array($slotMinutes, [15, 30, 60], true)) {
        fwrite(STDERR, "Error: --slot must be one of 15, 30, 60 (got: $slotMinutes)\n");
        return 1;
    }
    $slotSeconds = $slotMinutes * 60;

    $strategy = (string) ($opt['strategy'] ?? 'balanced');
    if (!empty($opt['preserve-order']) && !isset($opt['strategy'])) {
        $strategy = 'sequential';
    }
    if (!in_array($strategy, ['sequential', 'best-fit', 'balanced'], true)) {
        fwrite(STDERR, "Error: --strategy must be one of sequential, best-fit, balanced (got: $strategy)\n");
        return 1;
    }

    $oversizedPolicy = (string) ($opt['oversized'] ?? 'overflow');
    if ($oversizedPolicy === 'split') {
        fwrite(STDERR, "Error: --oversized=split is reserved for future use and is not implemented.\n");
        return 1;
    }
    if (!in_array($oversizedPolicy, ['overflow', 'exclude'], true)) {
        fwrite(STDERR, "Error: --oversized must be one of overflow, exclude (got: $oversizedPolicy)\n");
        return 1;
    }

    $verbose = !empty($opt['verbose']);
    $dryRun = !empty($opt['dry-run']);
    $refresh = !empty($opt['refresh']);
    $allowOtherFormats = !empty($opt['allow-other-formats']);
    $cacheDir = (string) ($opt['cache-dir'] ?? (IA_ROOT_DEFAULT_CACHE_DIR()));
    $outputPath = (string) ($opt['output'] ?? 'schedule.json');
    $catalogPath = (string) ($opt['catalog'] ?? 'catalog.json');
    $concurrency = isset($opt['concurrency']) ? max(1, (int) $opt['concurrency']) : 4;
    $timeout = isset($opt['timeout']) ? max(1, (int) $opt['timeout']) : 15;
    $tolerance = isset($opt['tolerance']) ? (float) $opt['tolerance'] : 0.0;
    $maxShift = isset($opt['max-shift']) ? (int) $opt['max-shift'] : null;
    $budget = isset($opt['budget']) ? (int) $opt['budget'] : null;
    $fillerWindow = isset($opt['filler-window']) ? (int) $opt['filler-window'] : 5;
    $fixturesDir = isset($opt['fixtures']) ? (string) $opt['fixtures'] : null;

    $log = function (string $msg) use ($verbose): void {
        if ($verbose) {
            fwrite(STDERR, "[verbose] $msg\n");
        }
    };

    try {
        $parsedList = ArchiveListParser::parse($listPath);
    } catch (Throwable $e) {
        fwrite(STDERR, 'Error: ' . $e->getMessage() . "\n");
        return 1;
    }
    foreach ($parsedList['warnings'] as $w) {
        $log("list warning: $w");
    }

    $cache = new MetadataCache($cacheDir);
    $httpClient = null;
    if ($fixturesDir !== null) {
        $httpClient = function (string $url, int $timeoutSeconds) use ($fixturesDir): array {
            $identifier = rawurldecode(basename(parse_url($url, PHP_URL_PATH) ?? ''));
            $sanitized = MetadataCache::sanitizeIdentifier($identifier);
            $file = rtrim($fixturesDir, '/') . "/$sanitized.json";
            if (!is_file($file)) {
                return ['status' => 404, 'body' => null, 'error' => null];
            }
            return ['status' => 200, 'body' => file_get_contents($file), 'error' => null];
        };
    }

    $client = new ArchiveMetadataClient(
        $cache,
        $timeout,
        $concurrency,
        $refresh,
        $httpClient,
        function (string $m) use ($log): void { $log($m); }
    );

    $identifiers = array_map(static fn (array $m): string => $m['identifier'], $parsedList['members']);
    $metadataResults = $client->fetchMany($identifiers);

    $catalogResult = MediaCatalog::build($parsedList['members'], $metadataResults, ['allow_other_formats' => $allowOtherFormats]);
    $catalogItems = $catalogResult['items'];
    $catalogWarnings = $catalogResult['warnings'];
    $stats = $catalogResult['stats'];

    $catalogById = [];
    foreach ($catalogItems as $item) {
        $catalogById[$item['id']] = $item;
    }

    $schedulerItems = MediaCatalog::toSchedulerItems($catalogItems);

    $optimizerOptions = [
        'oversized_policy' => $oversizedPolicy,
        'tolerance' => $tolerance,
    ];
    if ($maxShift !== null) {
        $optimizerOptions['max_shift'] = $maxShift;
    }
    if ($budget !== null) {
        $optimizerOptions['budget'] = $budget;
    }

    $optimizer = new ScheduleOptimizer($slotSeconds, $strategy, $optimizerOptions);
    $optimized = $optimizer->optimize($schedulerItems);
    $blocks = $optimized['blocks'];

    $fillerLibrary = [];
    if (isset($opt['filler'])) {
        $fillerRaw = json_decode((string) file_get_contents((string) $opt['filler']), true);
        if (!is_array($fillerRaw)) {
            fwrite(STDERR, "Error: --filler file is not valid JSON.\n");
            return 1;
        }
        $clips = $fillerRaw['clips'] ?? $fillerRaw;
        if (is_array($clips)) {
            foreach ($clips as $clip) {
                if (!is_array($clip) || !isset($clip['id'])) {
                    continue;
                }
                $d = DurationParser::parse($clip['duration'] ?? null);
                if ($d === null) {
                    $catalogWarnings[] = "filler clip '{$clip['id']}' has no usable duration; skipped.";
                    continue;
                }
                $fillerLibrary[] = ['id' => (string) $clip['id'], 'duration' => $d, 'title' => $clip['title'] ?? null];
            }
        }
    }
    $blocks = FillerSelector::applyToBlocks($blocks, $fillerLibrary, ['recent_window' => $fillerWindow]);

    $allWarnings = array_merge($catalogWarnings, $optimized['warnings']);

    // ---- stats for the report ----
    $normalBlocks = array_values(array_filter($blocks, static fn ($b) => $b['type'] === 'normal'));
    $overflowBlocks = array_values(array_filter($blocks, static fn ($b) => $b['type'] === 'overflow'));
    $totalContentSeconds = 0.0;
    $scheduledPrograms = 0;
    $fillerSeconds = 0.0;
    $totalUnusedSeconds = 0.0;
    foreach ($blocks as $b) {
        foreach ($b['items'] as $it) {
            if ($it['type'] === 'video') {
                $totalContentSeconds += $it['duration'];
                $scheduledPrograms++;
            } elseif ($it['type'] === 'filler') {
                $fillerSeconds += $it['duration'];
            }
        }
        if ($b['type'] === 'normal') {
            $totalUnusedSeconds += max(0.0, $b['remaining']);
        }
    }
    $avgFill = $normalBlocks
        ? (100.0 * array_sum(array_map(static fn ($b) => $b['used'] / $b['duration'], $normalBlocks)) / count($normalBlocks))
        : 0.0;

    $summary = [
        'list_name' => $parsedList['list_name'],
        'items_found' => $stats['members'],
        'metadata_fetched' => $stats['metadata_fetched'],
        'playable' => $stats['playable'],
        'unknown_duration' => $stats['unknown_duration'],
        'unavailable' => $stats['unavailable'] + $stats['metadata_failed'],
        'slot_minutes' => $slotMinutes,
        'strategy' => $strategy,
        'total_content_seconds' => $totalContentSeconds,
        'scheduled_programs' => $scheduledPrograms,
        'normal_blocks' => count($normalBlocks),
        'oversized_programs' => count($overflowBlocks),
        'average_fill_pct' => $avgFill,
        'total_unused_seconds' => $totalUnusedSeconds,
        'filler_seconds' => $fillerSeconds,
        'unscheduled_count' => count($optimized['unscheduled']),
        'dry_run' => $dryRun,
        'outputs' => $dryRun ? [] : [$catalogPath, $outputPath],
        'warnings' => $allWarnings,
        'violations' => $optimized['violations'],
    ];

    ImportReporter::printSummary($summary);
    if ($verbose) {
        ImportReporter::printVerboseBlocks($blocks, $catalogById);
        if ($optimized['unscheduled']) {
            echo "\nUnscheduled items (" . count($optimized['unscheduled']) . "):\n";
            foreach ($optimized['unscheduled'] as $u) {
                echo "  {$u['id']}: {$u['reason']}\n";
            }
        }
    }

    if (!$dryRun) {
        $catalogJson = ScheduleExporter::buildCatalog($catalogItems, $parsedList['list_name'], $parsedList['description']);
        $scheduleJson = ScheduleExporter::buildSchedule($blocks, $parsedList['list_name'], $slotSeconds, $strategy, $catalogById);
        ScheduleExporter::writeJson($catalogPath, $catalogJson);
        ScheduleExporter::writeJson($outputPath, $scheduleJson);
    }

    return 0;
}

function IA_ROOT_DEFAULT_CACHE_DIR(): string
{
    return IA_ROOT . '/.cache/internet-archive';
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    exit(ia_import_main($argv));
}
