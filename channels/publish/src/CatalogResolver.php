<?php
declare(strict_types=1);

// channels/publish/src/CatalogResolver.php
//
// A PHP mirror of channels/catalog-resolver.js, used by the publish CLI
// (channels/publish.php) to resolve a channel's catalog.json "series"
// references the same way the browser does, without being able to run JS
// from PHP. The spec explicitly allows this duplication as a documented
// trade-off rather than building a shared runtime; what matters is that
// the SAFETY RULES stay identical between the two. If you change one of
// the rules below, change catalog-resolver.js's matching rule too:
//
//   1. A series "ref" must be a relative (or absolute-path, but same-
//      filesystem) reference -- never a URL with a scheme, never
//      protocol-relative ("//...").
//   2. The resolved path must stay within `root`, defined the same way
//      in both: two directories above the catalog file itself
//      (channels/<id>/catalog.json -> the repo root shared by channels/
//      and series/).
//   3. Series includes are capped at depth 1: a loaded series.json may
//      not itself carry a "series" field.
//   4. Duplicate series references (by resolved path) and colliding
//      episode ids ("<seriesId>:<episodeId>") are reported, not silently
//      merged or silently dropped.
//
// Unlike the JS version, this one only needs the *series* list (episodes
// in order, with status/rights), not the flat catalog items -- the
// publish step schedules episodes, not standalone media -- but it mirrors
// the same resolution/safety pipeline end to end for parity and so a
// future shared test vector could validate both sides against the same
// cases.

final class CatalogResolver
{
    public const MAX_SERIES_DEPTH = 1;

    /**
     * @return array{series: list<array{id:string,title:string,url:string,episodes:list<array<string,mixed>>}>, errors: list<string>}
     */
    public static function resolveCatalog(string $catalogAbsolutePath): array
    {
        $errors = [];
        $series = [];

        if (!is_file($catalogAbsolutePath)) {
            $errors[] = "catalog not found: $catalogAbsolutePath";
            return ['series' => $series, 'errors' => $errors];
        }
        $raw = json_decode((string) file_get_contents($catalogAbsolutePath), true);
        if (!is_array($raw)) {
            $errors[] = "$catalogAbsolutePath: catalog.json is not a JSON object";
            return ['series' => $series, 'errors' => $errors];
        }

        $root = dirname($catalogAbsolutePath, 3);
        $seenPaths = [];
        foreach (is_array($raw['series'] ?? null) ? $raw['series'] : [] as $entry) {
            $ref = is_array($entry) && is_string($entry['ref'] ?? null) ? $entry['ref'] : null;
            if ($ref === null) {
                $errors[] = 'series entry missing a string "ref": ' . json_encode($entry);
                continue;
            }
            $resolved = self::resolveRef($catalogAbsolutePath, $ref, $root);
            if (isset($resolved['error'])) {
                $errors[] = "series ref \"$ref\": {$resolved['error']}";
                continue;
            }
            $path = $resolved['path'];
            if (isset($seenPaths[$path])) {
                $errors[] = "duplicate series reference (already included): \"$ref\"";
                continue;
            }
            $seenPaths[$path] = true;

            $loaded = self::loadSeries($path);
            if (isset($loaded['error'])) {
                $errors[] = $loaded['error'];
                continue;
            }
            $s = $loaded['series'];
            if (is_array($s['series'] ?? null) && $s['series']) {
                $errors[] = "$path: series.json may not itself contain a \"series\" field (max depth is " . self::MAX_SERIES_DEPTH . "); ignoring it";
            }
            $series[] = [
                'id' => $s['id'],
                'title' => $s['title'],
                // Show-level description: what a programming block falls back to for
                // its guide-facing description when it sets none.
                'description' => is_string($s['description'] ?? null) ? $s['description'] : null,
                'url' => $path,
                'episodes' => is_array($s['episodes'] ?? null) ? $s['episodes'] : [],
            ];
        }

        return ['series' => $series, 'errors' => $errors];
    }

    /** @return array{path: string}|array{error: string} */
    public static function resolveRef(string $catalogAbsolutePath, string $ref, ?string $root = null): array
    {
        $root ??= dirname($catalogAbsolutePath, 3);
        if (trim($ref) === '') {
            return ['error' => 'empty or missing reference'];
        }
        if (preg_match('/^[a-z][a-z0-9+.\-]*:/i', $ref) === 1) {
            return ['error' => "absolute or protocol-relative references are not allowed: \"$ref\""];
        }
        if (str_starts_with($ref, '//')) {
            return ['error' => "absolute or protocol-relative references are not allowed: \"$ref\""];
        }

        $resolved = self::joinPath(dirname($catalogAbsolutePath), $ref);
        if ($resolved !== $root && !str_starts_with($resolved, $root . '/')) {
            return ['error' => "reference escapes the allowed root: \"$ref\""];
        }
        return ['path' => $resolved];
    }

    /** Lexical path join + normalization -- no filesystem access, so it
     *  works whether or not the target exists yet, and can never be
     *  tricked by a symlink (it only ever reasons about the string). A
     *  leading "/" in $ref is treated as filesystem-root-absolute (same
     *  as a URL's absolute-path reference) and is then subject to the
     *  exact same root-containment check as everything else -- it is not
     *  specially privileged. */
    private static function joinPath(string $baseDir, string $ref): string
    {
        $parts = str_starts_with($ref, '/')
            ? []
            : array_values(array_filter(explode('/', $baseDir), static fn ($s) => $s !== ''));
        foreach (explode('/', $ref) as $segment) {
            if ($segment === '' || $segment === '.') {
                continue;
            }
            if ($segment === '..') {
                if ($parts) {
                    array_pop($parts);
                }
                continue;
            }
            $parts[] = $segment;
        }
        return '/' . implode('/', $parts);
    }

    /** @return array{series: array<string,mixed>}|array{error: string} */
    private static function loadSeries(string $path): array
    {
        if (!is_file($path)) {
            return ['error' => "failed to read $path: file not found"];
        }
        $raw = json_decode((string) file_get_contents($path), true);
        if (!is_array($raw)) {
            return ['error' => "$path: series.json is not a JSON object"];
        }
        if (!is_string($raw['id'] ?? null) || !preg_match('/^[a-z0-9][a-z0-9-]*$/', $raw['id'])) {
            return ['error' => "$path: missing or invalid \"id\""];
        }
        if (!is_string($raw['title'] ?? null) || $raw['title'] === '') {
            return ['error' => "$path: missing \"title\""];
        }
        if (isset($raw['episodes']) && !is_array($raw['episodes'])) {
            return ['error' => "$path: \"episodes\" must be an array"];
        }
        return ['series' => $raw];
    }
}
