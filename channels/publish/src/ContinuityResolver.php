<?php
declare(strict_types=1);

// channels/publish/src/ContinuityResolver.php
//
// Resolves a channel's `continuity.json` reference(s) -- a new, optional
// top-level `"continuity": [{"ref": "..."}]` array in catalog.json,
// resolved with the EXACT SAME path-safety rules as the existing
// `"series"` array (see CatalogResolver.php's header: relative-only,
// root-contained, no scheme/protocol-relative reference). This is the
// "reusable assets... shared between channels" mechanism Phase 4 asks
// for: a channel's catalog.json can reference both a network-wide
// continuity.json (station IDs/cards every channel can use) and its own
// station-specific one, merged into a single pool.
//
// Absent entirely (no "continuity" array in catalog.json): resolves to
// an EMPTY pool, which is what tells ProgrammingCompiler/ContinuityFiller
// to do absolutely nothing different -- every channel published before
// this phase keeps producing plain, uncovered "gap" blocks exactly as
// before, unless it opts in by referencing at least one continuity.json.
//
// continuity.json schema (schema_version 1):
//
//   {
//     "schema_version": 1,
//     "station_ids": [ { "id", "title", "category", "duration" (seconds,
//        required, > 0), "status" ("candidate"|"approved"|"rejected"|
//        "disabled" -- same editorial gate as series.json episodes, only
//        "approved" is ever eligible), "rights": {...}, "source": {
//        "provider", "url", ... } } ],
//     "filler": [ /* identical shape -- short-form filler; kept as a
//        separate list purely for operator readability, merged into the
//        exact same selection pool as station_ids */ ],
//     "cards": [ { "id", "template", "min_duration", "max_duration" } ],
//     "defaults": { "preferred_card", "minimum_video_filler", "minimum_lead_in" }
//   }
//
// "minimum_lead_in" (seconds, default 0): ProgrammingCompiler reserves this
// much time at the FRONT of every occurrence -- for EVERY program, not just
// wherever packing happens to leave a leftover -- so a continuity card
// always has at least this long to render before the program it precedes.
// 0 (the default, and every continuity.json published before this field
// existed) is a byte-for-byte no-op.
//
// Multiple referenced files merge: station_ids/filler/cards concatenate
// (a duplicate asset id across files is reported, never silently
// dropped or overwritten); "defaults" keys are last-wins across the
// referenced list in catalog.json's own order (so a channel-specific
// continuity.json listed after the network-wide one can override just
// the defaults it cares about, without having to repeat every asset).

final class ContinuityResolver
{
    private const VALID_STATUSES = ['candidate', 'approved', 'rejected', 'disabled'];

    /**
     * @return array{
     *   assets: list<array{id:string,title:string,category:string,duration:int,status:string,source:?array}>,
     *   cards: list<array{id:string,template:string,minDuration:int,maxDuration:int}>,
     *   defaults: array{preferredCard:?string,minimumVideoFiller:int,minimumLeadIn:int},
     *   errors: list<string>,
     * }
     */
    public static function resolveCatalog(string $catalogAbsolutePath): array
    {
        $errors = [];
        $assets = [];
        $cards = [];
        $defaults = ['preferredCard' => null, 'minimumVideoFiller' => 0, 'minimumLeadIn' => 0];

        if (!is_file($catalogAbsolutePath)) {
            return self::empty();
        }
        $raw = json_decode((string) file_get_contents($catalogAbsolutePath), true);
        if (!is_array($raw) || !isset($raw['continuity']) || !is_array($raw['continuity'])) {
            return self::empty(); // no "continuity" array at all -- opted out, not an error
        }

        $root = dirname($catalogAbsolutePath, 3);
        $seenPaths = [];
        $seenAssetIds = [];
        $seenCardIds = [];

        foreach ($raw['continuity'] as $entry) {
            $ref = is_array($entry) && is_string($entry['ref'] ?? null) ? $entry['ref'] : null;
            if ($ref === null) {
                $errors[] = 'continuity entry missing a string "ref": ' . json_encode($entry);
                continue;
            }
            $resolved = CatalogResolver::resolveRef($catalogAbsolutePath, $ref, $root);
            if (isset($resolved['error'])) {
                $errors[] = "continuity ref \"$ref\": {$resolved['error']}";
                continue;
            }
            $path = $resolved['path'];
            if (isset($seenPaths[$path])) {
                $errors[] = "duplicate continuity reference (already included): \"$ref\"";
                continue;
            }
            $seenPaths[$path] = true;

            if (!is_file($path)) {
                $errors[] = "continuity ref \"$ref\": file not found: $path";
                continue;
            }
            $doc = json_decode((string) file_get_contents($path), true);
            if (!is_array($doc)) {
                $errors[] = "$path: continuity.json is not a JSON object";
                continue;
            }

            foreach (['station_ids', 'filler'] as $listKey) {
                foreach (is_array($doc[$listKey] ?? null) ? $doc[$listKey] : [] as $raw) {
                    $parsed = self::parseAsset($raw, $listKey === 'filler' ? 'filler' : 'station_id', $path);
                    if (isset($parsed['error'])) {
                        $errors[] = $parsed['error'];
                        continue;
                    }
                    $asset = $parsed['asset'];
                    if (isset($seenAssetIds[$asset['id']])) {
                        $errors[] = "$path: duplicate continuity asset id \"{$asset['id']}\" (already included from another reference)";
                        continue;
                    }
                    $seenAssetIds[$asset['id']] = true;
                    $assets[] = $asset;
                }
            }

            foreach (is_array($doc['cards'] ?? null) ? $doc['cards'] : [] as $rawCard) {
                $parsed = self::parseCard($rawCard, $path);
                if (isset($parsed['error'])) {
                    $errors[] = $parsed['error'];
                    continue;
                }
                $card = $parsed['card'];
                if (isset($seenCardIds[$card['id']])) {
                    $errors[] = "$path: duplicate continuity card id \"{$card['id']}\" (already included from another reference)";
                    continue;
                }
                $seenCardIds[$card['id']] = true;
                $cards[] = $card;
            }

            if (is_array($doc['defaults'] ?? null)) {
                if (is_string($doc['defaults']['preferred_card'] ?? null)) {
                    $defaults['preferredCard'] = $doc['defaults']['preferred_card'];
                }
                if (is_numeric($doc['defaults']['minimum_video_filler'] ?? null)) {
                    $defaults['minimumVideoFiller'] = max(0, (int) $doc['defaults']['minimum_video_filler']);
                }
                if (is_numeric($doc['defaults']['minimum_lead_in'] ?? null)) {
                    $defaults['minimumLeadIn'] = max(0, (int) $doc['defaults']['minimum_lead_in']);
                }
            }
        }

        return ['assets' => $assets, 'cards' => $cards, 'defaults' => $defaults, 'errors' => $errors];
    }

    /** @return array{assets:list<array<string,mixed>>, cards:list<array<string,mixed>>, defaults:array{preferredCard:?string,minimumVideoFiller:int,minimumLeadIn:int}, errors:list<string>} */
    private static function empty(): array
    {
        return ['assets' => [], 'cards' => [], 'defaults' => ['preferredCard' => null, 'minimumVideoFiller' => 0, 'minimumLeadIn' => 0], 'errors' => []];
    }

    /** @return array{asset: array{id:string,title:string,category:string,duration:int,status:string,source:?array}}|array{error:string} */
    private static function parseAsset(mixed $raw, string $defaultCategory, string $path): array
    {
        if (!is_array($raw) || !is_string($raw['id'] ?? null) || $raw['id'] === '') {
            return ['error' => "$path: a continuity asset is missing a valid \"id\": " . json_encode($raw)];
        }
        if (!is_numeric($raw['duration'] ?? null) || (float) $raw['duration'] <= 0) {
            return ['error' => "$path: continuity asset \"{$raw['id']}\" has no positive numeric \"duration\"."];
        }
        $status = is_string($raw['status'] ?? null) ? $raw['status'] : 'approved';
        if (!in_array($status, self::VALID_STATUSES, true)) {
            return ['error' => "$path: continuity asset \"{$raw['id']}\" has an invalid \"status\": " . json_encode($status)];
        }
        return ['asset' => [
            'id' => $raw['id'],
            'title' => is_string($raw['title'] ?? null) ? $raw['title'] : $raw['id'],
            'category' => is_string($raw['category'] ?? null) ? $raw['category'] : $defaultCategory,
            'duration' => (int) round((float) $raw['duration']),
            'status' => $status,
            'source' => is_array($raw['source'] ?? null) ? $raw['source'] : null,
        ]];
    }

    /** @return array{card: array{id:string,template:string,minDuration:int,maxDuration:int}}|array{error:string} */
    private static function parseCard(mixed $raw, string $path): array
    {
        if (!is_array($raw) || !is_string($raw['id'] ?? null) || $raw['id'] === '') {
            return ['error' => "$path: a continuity card is missing a valid \"id\": " . json_encode($raw)];
        }
        $template = is_string($raw['template'] ?? null) && $raw['template'] !== '' ? $raw['template'] : $raw['id'];
        $min = is_numeric($raw['min_duration'] ?? null) ? max(0, (int) $raw['min_duration']) : 0;
        $max = is_numeric($raw['max_duration'] ?? null) ? (int) $raw['max_duration'] : PHP_INT_MAX;
        if ($max < $min) {
            return ['error' => "$path: continuity card \"{$raw['id']}\" has max_duration < min_duration."];
        }
        return ['card' => ['id' => $raw['id'], 'template' => $template, 'minDuration' => $min, 'maxDuration' => $max]];
    }
}
