<?php
declare(strict_types=1);

// ia-import/src/IaSeriesBuilder.php
//
// The Internet-Archive counterpart to youtube-import/src/YouTubeSeriesBuilder.php:
// merges freshly resolved IA media (via MediaResolver, from raw
// /metadata/{identifier} responses already fetched by ArchiveMetadataClient)
// into a portable series.json, creating one from scratch or refreshing an
// existing one, under the exact same editorial-safety rules the YouTube
// importer already established (see docs/series-and-channels.md and
// YouTubeSeriesBuilder's header) -- deliberately mirrored, not reinvented,
// so both importers read the same way to a future maintainer:
//
// Source-reported fields (always safe to overwrite from a fresh fetch --
// they describe the source, not an editorial decision):
//   duration, year, thumbnail_url, and everything under "source" (url,
//   page_url, identifier, part_index, part_count, license, collections,
//   subjects, mediatype, format, duration_source, availability,
//   availability_detail, warnings).
//
// Editorially-owned fields (set once, at creation, NEVER touched again by
// a later refresh): title, description, creator, guests, status, rights,
// episode_number.
//
// A directly-hosted episode's "source.provider" is always the literal string
// "html5", not "internet_archive" or anything else. This is functional:
// channels/broadcast.js's provider dispatch (see player-adapters.js) only
// special-cases "youtube" (the iframe adapter) and "html5" (the <video>
// element via Html5PlayerAdapter); any other provider string passes the schema
// but is never wired to an adapter or made visible. Schedules produced by
// ia-import.php use "html5" implicitly (a bare media_url, no "source"), but
// series.json episodes need an explicit "source" object for episode_number/
// attribution/licensing bookkeeping, so they spell it out.
//
// New episodes are appended as status "candidate", rights {"status":
// "unverified", "notes": null} -- always, regardless of what IA's own
// licenseurl/rights metadata field says. A clear "publicdomainmark"-style
// licenseurl is a strong signal, not proof, and this importer never
// promotes a candidate or infers rights from a successful fetch, exactly
// like ia-import.php's existing catalog output (which leaves "license"
// plain and never assumes redistributability) and youtube-import's
// identical policy. The raw IA license string is still preserved, every
// refresh, at source.license -- for a human editor (or a later editorial
// pass) to read and decide, never for this code to decide for them.

final class IaSeriesBuilder
{
    /**
     * @param ?array<string,mixed> $existingSeries Previously loaded series.json, or null to create fresh.
     * @param array<string,mixed> $seriesDefaults Used only when $existingSeries is null: schema_version/id/title/
     *                                              description/creator/year/thumbnail_url/logo_url/rotation/source.
     * @param list<string> $discoveredOrder Identifiers found this run, in discovery order (list/search order) --
     *                                       drives the insertion order of brand-new episodes.
     * @param array<string, ?list<array<string,mixed>>> $resolvedByIdentifier Every identifier checked this run =>
     *                                       MediaResolver::resolve()'s part list, or null if the metadata fetch
     *                                       itself failed outright (never attempted resolution). An identifier
     *                                       simply absent from this map was not checked this run at all.
     * @return array{series: array<string,mixed>, summary: array{added:list<string>,updated:list<string>,unavailable:list<string>,unchanged:list<string>,warnings:list<string>}}
     */
    public static function build(
        ?array $existingSeries,
        array $seriesDefaults,
        array $discoveredOrder,
        array $resolvedByIdentifier,
    ): array {
        $summary = ['added' => [], 'updated' => [], 'unavailable' => [], 'unchanged' => [], 'warnings' => []];

        $series = $existingSeries ?? $seriesDefaults;
        if (!isset($series['episodes']) || !is_array($series['episodes'])) {
            $series['episodes'] = [];
        }

        foreach (['title', 'description', 'thumbnail_url', 'logo_url', 'creator', 'year'] as $field) {
            if (($series[$field] ?? null) === null && ($seriesDefaults[$field] ?? null) !== null) {
                $series[$field] = $seriesDefaults[$field];
            }
        }
        $series['source'] = is_array($series['source'] ?? null) ? $series['source'] : [];
        foreach (['provider', 'query', 'collection'] as $field) {
            if (($series['source'][$field] ?? null) === null && ($seriesDefaults['source'][$field] ?? null) !== null) {
                $series['source'][$field] = $seriesDefaults['source'][$field];
            }
        }

        $existingByKey = [];
        foreach ($series['episodes'] as $i => $ep) {
            $identifier = $ep['source']['identifier'] ?? null;
            $partIndex = $ep['source']['part_index'] ?? 1;
            if (!is_string($identifier) || $identifier === '') {
                continue;
            }
            $key = $identifier . '#' . (int) $partIndex;
            if (isset($existingByKey[$key])) {
                $summary['warnings'][] = "series.json already contained more than one episode for \"$key\"; only the first is updated.";
                continue;
            }
            $existingByKey[$key] = $i;
        }

        $maxEpisodeNumber = 0;
        foreach ($series['episodes'] as $ep) {
            if (is_int($ep['episode_number'] ?? null)) {
                $maxEpisodeNumber = max($maxEpisodeNumber, $ep['episode_number']);
            }
        }

        // ---- pass 1: refresh source-reported fields on episodes we already know ----
        foreach ($resolvedByIdentifier as $identifier => $parts) {
            if ($parts === null) {
                // The metadata fetch itself failed; mark every known part of
                // this identifier unavailable without fabricating a reason.
                foreach ($existingByKey as $key => $idx) {
                    if (!str_starts_with($key, $identifier . '#')) {
                        continue;
                    }
                    $ep = $series['episodes'][$idx];
                    $wasUnavailable = ($ep['source']['availability'] ?? null) === 'unavailable';
                    $ep['source']['availability'] = 'unavailable';
                    $ep['source']['availability_detail'] = 'metadata fetch failed on this run';
                    $series['episodes'][$idx] = $ep;
                    $summary['unavailable'][] = $ep['id'];
                    if (!$wasUnavailable) {
                        $summary['updated'][] = $ep['id'];
                    }
                }
                continue;
            }
            foreach ($parts as $part) {
                $partIndex = (int) ($part['part_index'] ?? 1);
                $key = $identifier . '#' . $partIndex;
                if (!isset($existingByKey[$key])) {
                    continue; // handled in pass 2, below, if genuinely new
                }
                $idx = $existingByKey[$key];
                $ep = $series['episodes'][$idx];
                $fresh = self::sourceReportedFields($identifier, $part);

                $beforeSnapshot = json_encode([$ep['duration'] ?? null, $ep['year'] ?? null, $ep['thumbnail_url'] ?? null, $ep['source'] ?? null]);
                $ep['duration'] = $fresh['duration'];
                $ep['year'] = $fresh['year'];
                $ep['thumbnail_url'] = $fresh['thumbnail_url'];
                $ep['source'] = $fresh['source'];
                $afterSnapshot = json_encode([$ep['duration'], $ep['year'], $ep['thumbnail_url'], $ep['source']]);

                $series['episodes'][$idx] = $ep;
                if ($beforeSnapshot !== $afterSnapshot) {
                    $summary['updated'][] = $ep['id'];
                } else {
                    $summary['unchanged'][] = $ep['id'];
                }
            }
        }

        // ---- pass 2: brand-new candidates, appended in discovery order ----
        foreach ($discoveredOrder as $identifier) {
            $parts = $resolvedByIdentifier[$identifier] ?? null;
            if ($parts === null) {
                continue;
            }
            foreach ($parts as $part) {
                $partIndex = (int) ($part['part_index'] ?? 1);
                $key = $identifier . '#' . $partIndex;
                if (isset($existingByKey[$key])) {
                    continue;
                }
                $fresh = self::sourceReportedFields($identifier, $part);
                $maxEpisodeNumber++;
                $partCount = (int) ($part['part_count'] ?? 1);
                $id = $partCount > 1 ? "ia-$identifier-p$partIndex" : "ia-$identifier";
                $series['episodes'][] = [
                    'id' => $id,
                    'episode_number' => $maxEpisodeNumber,
                    'title' => is_string($part['title'] ?? null) ? $part['title'] : $identifier,
                    'description' => is_string($part['description'] ?? null) ? $part['description'] : '',
                    'creator' => is_string($part['creator'] ?? null) ? $part['creator'] : null,
                    'duration' => $fresh['duration'],
                    'year' => $fresh['year'],
                    'published_at' => null,
                    'thumbnail_url' => $fresh['thumbnail_url'],
                    'guests' => [],
                    'source' => $fresh['source'],
                    'status' => 'candidate',
                    'rights' => ['status' => 'unverified', 'notes' => null],
                ];
                $existingByKey[$key] = array_key_last($series['episodes']);
                $summary['added'][] = $id;
            }
        }

        if (!empty($series['episodes']) && is_string($series['_note'] ?? null)
            && str_contains($series['_note'], 'STRUCTURAL PLACEHOLDER')) {
            unset($series['_note']);
        }

        return ['series' => $series, 'summary' => $summary];
    }

    /**
     * @param array<string,mixed> $part One MediaResolver::resolve() result entry.
     * @return array{duration:?float, year:?int, thumbnail_url:?string, source: array<string,mixed>}
     */
    private static function sourceReportedFields(string $identifier, array $part): array
    {
        $status = is_string($part['status'] ?? null) ? $part['status'] : 'unavailable';
        $availability = $status === 'unavailable' ? 'unavailable' : 'available';
        $availabilityDetail = $status === 'unavailable' ? 'no playable video file found for this item' : null;

        $source = [
            'provider' => 'html5',
            'identifier' => $identifier,
            'part_index' => (int) ($part['part_index'] ?? 1),
            'part_count' => (int) ($part['part_count'] ?? 1),
            // The actual direct, playable media file -- what the player loads.
            'url' => is_string($part['media_url'] ?? null) ? $part['media_url'] : null,
            // The human-readable archive.org details page -- what "view source" /
            // attribution links point at. Deliberately a separate field from
            // "url" (see channels/publish/src/ProgrammingCompiler.php's
            // buildItem(), which prefers source.page_url for the displayed/
            // attributed source_url and always uses source.url as the only
            // thing that ever becomes media_url).
            'page_url' => is_string($part['source_url'] ?? null) ? $part['source_url'] : null,
            'license' => is_string($part['license'] ?? null) ? $part['license'] : null,
            'collections' => is_array($part['collections'] ?? null) ? $part['collections'] : [],
            'subjects' => is_array($part['subjects'] ?? null) ? $part['subjects'] : [],
            'mediatype' => is_string($part['mediatype'] ?? null) ? $part['mediatype'] : null,
            'format' => is_string($part['format'] ?? null) ? $part['format'] : null,
            'duration_source' => is_string($part['duration_source'] ?? null) ? $part['duration_source'] : 'none',
            'availability' => $availability,
            'availability_detail' => $availabilityDetail,
            'warnings' => is_array($part['warnings'] ?? null) ? $part['warnings'] : [],
        ];

        return [
            'duration' => is_float($part['duration'] ?? null) || is_int($part['duration'] ?? null) ? (float) $part['duration'] : null,
            'year' => is_int($part['year'] ?? null) ? $part['year'] : null,
            'thumbnail_url' => is_string($part['thumbnail_url'] ?? null) ? $part['thumbnail_url'] : null,
            'source' => $source,
        ];
    }
}
