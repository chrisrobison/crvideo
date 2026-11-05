#!/usr/bin/env php
<?php
declare(strict_types=1);

// ia-import/ia-series-import.php
//
// Standalone CLI: imports Internet Archive items -- by collection/search
// query, by a pre-fetched user list JSON (the same format ia-import.php
// already reads), or by an explicit identifier list -- into a portable
// series.json (see docs/series-and-channels.md and
// youtube-import/youtube-import.php, which this deliberately mirrors).
//
// This is NOT a replacement for ia-import.php. That tool's fixed-block
// catalog.json/schedule.json pipeline (used by channels/film-day-at-school
// today) is untouched and keeps working exactly as before. This is a
// second, additive output shape for IA content: a reusable series.json an
// editor can approve episodes in and a channel can air on a recurring
// schedule via channels/publish.php, the same way every YouTube-sourced
// series already does. Metadata fetching/resolution (ArchiveMetadataClient,
// MediaResolver, DurationParser) is fully shared with ia-import.php; only
// the final "what do we write" step differs.
//
// Importing never publishes anything: every new item becomes a
// "candidate" episode, rights "unverified" -- regardless of what IA's own
// license metadata says. See src/IaSeriesBuilder.php's header for exactly
// why and exactly which fields a refresh is and isn't allowed to touch.

const IAS_ROOT = __DIR__;

require_once IAS_ROOT . '/src/DurationParser.php';
require_once IAS_ROOT . '/src/ArchiveListParser.php';
require_once IAS_ROOT . '/src/MetadataCache.php';
require_once IAS_ROOT . '/src/ArchiveMetadataClient.php';
require_once IAS_ROOT . '/src/ArchiveCollectionSearch.php';
require_once IAS_ROOT . '/src/MediaResolver.php';
require_once IAS_ROOT . '/src/IaSeriesBuilder.php';
require_once IAS_ROOT . '/src/IaSeriesWriter.php';
require_once IAS_ROOT . '/src/IaSeriesImportReporter.php';

function ias_usage(): string
{
    return <<<USAGE
    Internet Archive Series Importer -- writes a portable series.json

    Usage:
      php ia-series-import.php --collection=prelinger --output=../series/retro-prelinger/series.json
      php ia-series-import.php --query="collection:(classic_tv) AND mediatype:(movies)" --output=../series/x/series.json
      php ia-series-import.php --list=my-list.json --output=../series/x/series.json
      php ia-series-import.php --identifiers=id1,id2,id3 --output=../series/x/series.json

    Discovery (exactly one required):
      --collection=ID        Shorthand for --query="collection:(ID)"
      --query=STRING         A raw archive.org advancedsearch.php query
      --list=PATH            A pre-fetched IA user-list JSON (same format ia-import.php reads)
      --identifiers=A,B,C    An explicit, comma-separated identifier list

    Options:
      --output=PATH            series.json to write/refresh (required)
      --series-id=ID            Override the series "id" (default: the --output directory's name)
      --title=TITLE             Series title (only used when creating a new series.json)
      --description=TEXT       Series description (only used when creating a new series.json)
      --creator=NAME            Series-level creator/curator credit (only used when creating)
      --rows=N                  Max identifiers to discover via --collection/--query (default: 200)
      --sort=FIELD              advancedsearch sort (default: "downloads desc")
      --max-items=N             Stop after resolving N identifiers (applies to any discovery mode)
      --refresh                 Ignore the local metadata cache (re-fetch everything)
      --allow-other-formats     Allow non-MP4 browser-playable formats (ogv/webm)
      --dry-run                 Print the summary of what would change; write nothing
      --verbose                 List every added/updated/unavailable episode id, not just counts
      --cache-dir=PATH          Local metadata cache (default: ia-import/.cache/internet-archive)
      --concurrency=N           Concurrent metadata requests (default: 4)
      --timeout=SECONDS         Request timeout (default: 15)
      --fixtures=DIR            Serve search/metadata responses from DIR instead of the network
                                 (see tests/ -- no live network access required)
      --help                    Display this message

    Every new item is written as episode status "candidate", rights
    "unverified" -- never anything else, regardless of what IA's own
    license metadata says (see src/IaSeriesBuilder.php). An editor has to
    set status to "approved" by hand before channels/publish.php will ever
    schedule it. Writes are atomic; the previous version is kept as
    "<output>.bak".

    USAGE;
}

/** Same semantics as youtube-import.php's yt_import_string_option(): a
 *  bare flag where a value was expected is a hard error, not a silent "1". */
function ias_string_option(array $opt, string $name): string|false|null
{
    if (!isset($opt[$name])) {
        return null;
    }
    if ($opt[$name] === true) {
        fwrite(STDERR, "Error: --$name requires a value -- use --$name=VALUE, not a bare flag or a space-separated value.\n");
        return false;
    }
    return (string) $opt[$name];
}

/** @return array{positional: list<string>, options: array<string,string|bool>} */
function ias_parse_args(array $argv): array
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

/** Builds a fixture-backed transport serving BOTH advancedsearch.php
 *  (DIR/search-page-{N}.json) and /metadata/{identifier} (DIR/{identifier}.json)
 *  requests -- dispatched purely by URL shape, same spirit as
 *  youtube-import.php's fixture transport. */
function ias_fixture_transport(string $dir): \Closure
{
    return function (string $url, int $timeoutSeconds) use ($dir): array {
        $path = (string) parse_url($url, PHP_URL_PATH);
        if (str_contains($path, 'advancedsearch.php')) {
            $query = [];
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            $page = (int) ($query['page'] ?? 1);
            $file = rtrim($dir, '/') . "/search-page-$page.json";
            if (!is_file($file)) {
                return ['status' => 200, 'body' => json_encode(['response' => ['docs' => []]]), 'error' => null];
            }
            return ['status' => 200, 'body' => (string) file_get_contents($file), 'error' => null];
        }

        $identifier = rawurldecode(basename($path));
        $sanitized = MetadataCache::sanitizeIdentifier($identifier);
        $file = rtrim($dir, '/') . "/$sanitized.json";
        if (!is_file($file)) {
            return ['status' => 200, 'body' => json_encode(new stdClass()), 'error' => null]; // IA's own "not found" shape
        }
        return ['status' => 200, 'body' => (string) file_get_contents($file), 'error' => null];
    };
}

function ias_main(array $argv): int
{
    $parsed = ias_parse_args($argv);
    $opt = $parsed['options'];

    if (!empty($opt['help'])) {
        echo ias_usage();
        return 0;
    }

    $collection = ias_string_option($opt, 'collection');
    $query = ias_string_option($opt, 'query');
    $listPath = ias_string_option($opt, 'list');
    $identifiersOpt = ias_string_option($opt, 'identifiers');
    $outputPath = ias_string_option($opt, 'output');
    $seriesIdOpt = ias_string_option($opt, 'series-id');
    $titleOpt = ias_string_option($opt, 'title');
    $descriptionOpt = ias_string_option($opt, 'description');
    $creatorOpt = ias_string_option($opt, 'creator');
    $rowsOpt = ias_string_option($opt, 'rows');
    $sortOpt = ias_string_option($opt, 'sort');
    $maxItemsOpt = ias_string_option($opt, 'max-items');
    $cacheDirOpt = ias_string_option($opt, 'cache-dir');
    $concurrencyOpt = ias_string_option($opt, 'concurrency');
    $timeoutOpt = ias_string_option($opt, 'timeout');
    $fixturesDir = ias_string_option($opt, 'fixtures');

    if (in_array(false, [
        $collection, $query, $listPath, $identifiersOpt, $outputPath, $seriesIdOpt, $titleOpt,
        $descriptionOpt, $creatorOpt, $rowsOpt, $sortOpt, $maxItemsOpt, $cacheDirOpt,
        $concurrencyOpt, $timeoutOpt, $fixturesDir,
    ], true)) {
        return 1;
    }

    $given = array_filter([$collection, $query, $listPath, $identifiersOpt], static fn ($v) => $v !== null);
    if (count($given) !== 1) {
        fwrite(STDERR, "Error: pass exactly one of --collection, --query, --list, --identifiers.\n");
        return 1;
    }
    if ($outputPath === null || $outputPath === '') {
        fwrite(STDERR, "Error: --output=PATH is required.\n");
        return 1;
    }

    $seriesId = $seriesIdOpt ?? basename(rtrim(dirname($outputPath), '/'));
    $rows = $rowsOpt !== null ? max(1, (int) $rowsOpt) : 200;
    $sort = $sortOpt ?? 'downloads desc';
    $maxItems = $maxItemsOpt !== null ? max(1, (int) $maxItemsOpt) : null;
    $refresh = !empty($opt['refresh']);
    $dryRun = !empty($opt['dry-run']);
    $verbose = !empty($opt['verbose']);
    $allowOtherFormats = !empty($opt['allow-other-formats']);
    $timeout = $timeoutOpt !== null ? max(1, (int) $timeoutOpt) : 15;
    $concurrency = $concurrencyOpt !== null ? max(1, (int) $concurrencyOpt) : 4;
    $cacheDir = $cacheDirOpt ?? (IAS_ROOT . '/.cache/internet-archive');

    $log = function (string $msg) use ($verbose): void {
        if ($verbose) {
            fwrite(STDERR, "[verbose] $msg\n");
        }
    };

    $httpClient = $fixturesDir !== null ? ias_fixture_transport($fixturesDir) : null;

    try {
        $discoveredOrder = [];
        $resolvedQuery = null;
        if ($identifiersOpt !== null) {
            $discoveredOrder = array_values(array_filter(array_map('trim', explode(',', $identifiersOpt)), static fn ($s) => $s !== ''));
        } elseif ($listPath !== null) {
            $parsedList = ArchiveListParser::parse($listPath);
            foreach ($parsedList['warnings'] as $w) {
                $log("list warning: $w");
            }
            $discoveredOrder = array_column($parsedList['members'], 'identifier');
        } else {
            $resolvedQuery = $query ?? "collection:($collection)";
            $searcher = new ArchiveCollectionSearch($timeout, $httpClient, function (string $m) use ($log): void { $log($m); });
            $searchResult = $searcher->search($resolvedQuery, $rows, $sort);
            foreach ($searchResult['warnings'] as $w) {
                $log("search warning: $w");
            }
            $discoveredOrder = $searchResult['identifiers'];
        }

        $discoveredOrder = array_values(array_unique($discoveredOrder));
        if ($maxItems !== null) {
            $discoveredOrder = array_slice($discoveredOrder, 0, $maxItems);
        }
        $log('discovered ' . count($discoveredOrder) . ' identifier(s)');

        $existingSeries = IaSeriesWriter::read($outputPath);
        $existingIdentifiers = [];
        foreach ($existingSeries['episodes'] ?? [] as $ep) {
            $id = $ep['source']['identifier'] ?? null;
            if (is_string($id)) {
                $existingIdentifiers[] = $id;
            }
        }
        $toFetch = array_values(array_unique([...$discoveredOrder, ...$existingIdentifiers]));

        $cache = new MetadataCache($cacheDir);
        $client = new ArchiveMetadataClient($cache, $timeout, $concurrency, $refresh, $httpClient, function (string $m) use ($log): void { $log($m); });
        $fetchResults = $toFetch ? $client->fetchMany($toFetch) : [];

        $resolvedByIdentifier = [];
        foreach ($toFetch as $identifier) {
            $raw = $fetchResults[$identifier]['raw'] ?? null;
            $resolvedByIdentifier[$identifier] = $raw === null
                ? null
                : MediaResolver::resolve($raw, $identifier, ['allow_other_formats' => $allowOtherFormats]);
        }

        $seriesDefaults = [
            'schema_version' => 1,
            'id' => $seriesId,
            'title' => $titleOpt ?? $seriesId,
            'description' => $descriptionOpt ?? '',
            'creator' => $creatorOpt,
            'year' => null,
            'thumbnail_url' => null,
            'logo_url' => null,
            'source' => [
                'provider' => 'internet_archive',
                'query' => $resolvedQuery,
                'collection' => $collection,
            ],
            'rotation' => ['mode' => 'sequential', 'loop' => true],
            'episodes' => [],
        ];

        $result = IaSeriesBuilder::build($existingSeries, $seriesDefaults, $discoveredOrder, $resolvedByIdentifier);

        IaSeriesImportReporter::printSummary($seriesId, $outputPath, $result['summary'], $dryRun, $verbose);

        if (!$dryRun) {
            IaSeriesWriter::write($outputPath, $result['series']);
        }

        return 0;
    } catch (Throwable $e) {
        fwrite(STDERR, 'Error: ' . $e->getMessage() . "\n");
        return 1;
    }
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    exit(ias_main($argv));
}
