<?php
declare(strict_types=1);

// ia-import/src/MediaResolver.php
//
// Turns one raw archive.org /metadata/{identifier} response into one or
// more "logical video" entries: picks a single preferred playable file per
// film (ignoring thumbnails/metadata XML/subtitles/torrents/other
// encodings of the same film), detects the case where an item actually
// contains several distinct video parts, and extracts a best-effort
// duration using DurationParser. Never invents a duration or a URL.

final class MediaResolver
{
    /** Extensions we will ever consider as "this might be a playable video". */
    private const VIDEO_EXTENSIONS = ['mp4', 'ogv', 'webm', 'mov', 'avi', 'mpg', 'mpeg', 'm4v'];

    /** Browser-compatible without the --allow-other-formats flag. */
    private const TIER1_EXT = ['mp4', 'm4v'];
    /** Browser-compatible, only used when --allow-other-formats is passed. */
    private const TIER3_EXT = ['ogv', 'webm'];

    private const EXCLUDED_FORMAT_KEYWORDS = [
        'metadata', 'thumbnail', 'item tile', 'jpeg', 'png', 'gif', 'tiff',
        'text', 'subtitle', 'srt', 'vtt', 'webvtt', 'bittorrent', 'torrent',
        'zip', 'spreadsheet', 'item image', 'json', 'xml', 'checksums',
    ];

    /**
     * @param array $raw Raw archive.org metadata response (decoded JSON).
     * @param array{allow_other_formats?: bool} $options
     * @return list<array<string, mixed>> One entry per logical video found
     *                                     in the item (usually exactly one).
     */
    public static function resolve(array $raw, string $identifier, array $options = []): array
    {
        $allowOtherFormats = $options['allow_other_formats'] ?? false;
        $meta = is_array($raw['metadata'] ?? null) ? $raw['metadata'] : [];
        $files = is_array($raw['files'] ?? null) ? $raw['files'] : [];

        $title = self::scalarize($meta['title'] ?? null) ?? $identifier;
        $description = self::stripHtml(self::scalarize($meta['description'] ?? null) ?? '');
        $creator = self::scalarize($meta['creator'] ?? null);
        $year = self::extractYear($meta['date'] ?? $meta['year'] ?? null);
        $subjects = self::toStringList($meta['subject'] ?? null);
        $collections = self::toStringList($meta['collection'] ?? null);
        $license = self::scalarize($meta['licenseurl'] ?? $meta['rights'] ?? null);
        $mediatype = self::scalarize($meta['mediatype'] ?? null);
        $sourceUrl = 'https://archive.org/details/' . rawurlencode($identifier);
        $thumbnailUrl = 'https://archive.org/services/img/' . rawurlencode($identifier);
        $itemLevelDuration = DurationParser::parse($meta['runtime'] ?? null);

        $groups = self::groupPlayableFiles($files, $allowOtherFormats);

        if (!$groups) {
            return [[
                'part_index' => 1,
                'part_count' => 1,
                'title' => $title,
                'description' => $description,
                'creator' => $creator,
                'year' => $year,
                'subjects' => $subjects,
                'collections' => $collections,
                'license' => $license,
                'mediatype' => $mediatype,
                'source_url' => $sourceUrl,
                'thumbnail_url' => $thumbnailUrl,
                'selected_file' => null,
                'media_url' => null,
                'format' => null,
                'duration' => null,
                'duration_source' => 'none',
                'status' => 'unavailable',
                'warnings' => ['No playable video file found for this item.'],
            ]];
        }

        $ambiguous = count($groups) > 1 && !self::looksLikeNumberedParts($groups);
        $partCount = count($groups);

        $results = [];
        foreach ($groups as $i => $group) {
            $partIndex = $i + 1;
            $file = $group['file'];
            $filename = (string) $file['name'];
            $mediaUrl = self::buildDownloadUrl($identifier, $filename);

            $duration = DurationParser::parse($file['length'] ?? null);
            $durationSource = $duration !== null ? 'file_length' : 'none';
            if ($duration === null && $partCount === 1 && $itemLevelDuration !== null) {
                $duration = $itemLevelDuration;
                $durationSource = 'item_runtime';
            }

            $warnings = [];
            if ($ambiguous) {
                $warnings[] = 'Item contains multiple candidate video files with no clear link between them; '
                    . 'treated as separate parts, but this may be wrong (e.g. unrelated encodings). Review manually.';
            }
            if ($license === null) {
                $warnings[] = 'No license/rights information found; do not assume this item is redistributable.';
            }
            if ($duration === null) {
                $warnings[] = 'Could not determine a duration for this file from available metadata.';
            }

            $title2 = $partCount > 1 ? "$title (Part $partIndex)" : $title;

            $results[] = [
                'part_index' => $partIndex,
                'part_count' => $partCount,
                'title' => $title2,
                'description' => $description,
                'creator' => $creator,
                'year' => $year,
                'subjects' => $subjects,
                'collections' => $collections,
                'license' => $license,
                'mediatype' => $mediatype,
                'source_url' => $sourceUrl,
                'thumbnail_url' => $thumbnailUrl,
                'selected_file' => $filename,
                'media_url' => $mediaUrl,
                'format' => self::scalarize($file['format'] ?? null),
                'duration' => $duration,
                'duration_source' => $durationSource,
                'status' => $duration === null ? 'unknown_duration' : 'ready',
                'warnings' => $warnings,
            ];
        }

        return $results;
    }

    /**
     * Groups candidate files by logical film and picks the single best
     * encoding per group. Returns a list ordered by group key, each entry
     * ['key' => string, 'file' => array].
     *
     * Grouping happens in two passes:
     *  1. By the file-level "original" attribute when present (the
     *     reliable signal: IA stamps every derivative of a source upload
     *     with the source filename), falling back to the file's own name
     *     when absent.
     *  2. A near-identical-duration merge across whatever groups pass 1
     *     produced. Real IA items routinely carry one or more derivatives
     *     (e.g. a hand-edited "_edit.mp4", a plain ".avi") that omit
     *     "original" entirely, so pass 1 alone leaves them as spurious
     *     extra "parts" of the very same film. Those derivatives are
     *     transcoded from the same source and their lengths agree to a
     *     fraction of a second; genuinely distinct parts of a multi-part
     *     item differ by many seconds. A tight absolute tolerance tells
     *     the two apart without needing duration parsing beyond what we
     *     already do.
     */
    private static function groupPlayableFiles(array $files, bool $allowOtherFormats): array
    {
        $candidatesByGroup = [];
        foreach ($files as $file) {
            if (!is_array($file) || !isset($file['name'])) {
                continue;
            }
            $name = (string) $file['name'];
            $ext = strtolower((string) (pathinfo($name, PATHINFO_EXTENSION)));
            if (!in_array($ext, self::VIDEO_EXTENSIONS, true)) {
                continue;
            }
            $format = strtolower(self::scalarize($file['format'] ?? null) ?? '');
            if (self::isExcludedFormat($format)) {
                continue;
            }

            $tier = self::tierFor($ext, $format, $allowOtherFormats);
            if ($tier === null) {
                continue;
            }

            $original = self::scalarize($file['original'] ?? null);
            $groupKey = $original !== null && $original !== '' ? $original : $name;

            $candidatesByGroup[$groupKey][] = ['file' => $file, 'tier' => $tier, 'name' => $name];
        }

        $groups = [];
        foreach ($candidatesByGroup as $groupKey => $candidates) {
            usort($candidates, static function (array $a, array $b): int {
                return $a['tier'] <=> $b['tier'] ?: strcmp($a['name'], $b['name']);
            });
            $duration = DurationParser::parse($candidates[0]['file']['length'] ?? null);
            $groups[] = ['key' => $groupKey, 'candidates' => $candidates, 'duration' => $duration];
        }

        ksort($groups, SORT_STRING);
        $groups = self::mergeByDurationSimilarity(array_values($groups));

        $result = [];
        foreach ($groups as $g) {
            $result[] = ['key' => $g['key'], 'file' => $g['candidates'][0]['file']];
        }
        return $result;
    }

    /**
     * Merges groups whose best candidate's duration is within a tight
     * absolute tolerance of each other -- almost certainly the same source
     * material, just encoded differently and lacking (or disagreeing on)
     * an "original" link. Groups without a parseable duration are left
     * untouched (no safe signal to merge on).
     */
    private static function mergeByDurationSimilarity(array $groups): array
    {
        $withDuration = [];
        $withoutDuration = [];
        foreach ($groups as $g) {
            if ($g['duration'] === null) {
                $withoutDuration[] = $g;
            } else {
                $withDuration[] = $g;
            }
        }
        usort($withDuration, static fn(array $a, array $b): int => $a['duration'] <=> $b['duration']);

        $clusters = [];
        foreach ($withDuration as $g) {
            $placed = false;
            foreach ($clusters as &$cluster) {
                $tolerance = max(2.0, $cluster['duration'] * 0.005);
                if (abs($g['duration'] - $cluster['duration']) <= $tolerance) {
                    $cluster['keys'][] = $g['key'];
                    $cluster['candidates'] = array_merge($cluster['candidates'], $g['candidates']);
                    $placed = true;
                    break;
                }
            }
            unset($cluster);
            if (!$placed) {
                $clusters[] = ['duration' => $g['duration'], 'keys' => [$g['key']], 'candidates' => $g['candidates']];
            }
        }

        $merged = [];
        foreach ($clusters as $cluster) {
            usort($cluster['candidates'], static function (array $a, array $b): int {
                return $a['tier'] <=> $b['tier'] ?: strcmp($a['name'], $b['name']);
            });
            $merged[] = ['key' => implode('|', $cluster['keys']), 'candidates' => $cluster['candidates']];
        }
        foreach ($withoutDuration as $g) {
            $merged[] = ['key' => $g['key'], 'candidates' => $g['candidates']];
        }

        usort($merged, static fn(array $a, array $b): int => strcmp($a['key'], $b['key']));
        return $merged;
    }

    private static function tierFor(string $ext, string $format, bool $allowOtherFormats): ?int
    {
        if (in_array($ext, self::TIER1_EXT, true)) {
            return str_contains($format, 'h.264') ? 1 : 2;
        }
        if ($allowOtherFormats && in_array($ext, self::TIER3_EXT, true)) {
            return 3;
        }
        return null;
    }

    private static function isExcludedFormat(string $format): bool
    {
        foreach (self::EXCLUDED_FORMAT_KEYWORDS as $kw) {
            if (str_contains($format, $kw)) {
                return true;
            }
        }
        return false;
    }

    /** Crude heuristic: do the group keys look like "...part1", "...pt2", "..._1" etc.? */
    private static function looksLikeNumberedParts(array $groups): bool
    {
        $numbered = 0;
        foreach ($groups as $g) {
            if (preg_match('/(part|pt)[\s_-]?\d+|[_-]\d+$/i', (string) $g['key'])) {
                $numbered++;
            }
        }
        return $numbered === count($groups);
    }

    public static function buildDownloadUrl(string $identifier, string $filename): string
    {
        $segments = explode('/', $filename);
        $encoded = array_map('rawurlencode', $segments);
        return 'https://archive.org/download/' . rawurlencode($identifier) . '/' . implode('/', $encoded);
    }

    private static function scalarize(mixed $value): ?string
    {
        if (is_string($value)) {
            $v = trim($value);
            return $v === '' ? null : $v;
        }
        if (is_numeric($value)) {
            return (string) $value;
        }
        if (is_array($value)) {
            foreach ($value as $v) {
                $s = self::scalarize($v);
                if ($s !== null) {
                    return $s;
                }
            }
        }
        return null;
    }

    /** @return list<string> */
    private static function toStringList(mixed $value): array
    {
        if ($value === null) {
            return [];
        }
        $items = [];
        if (is_array($value)) {
            foreach ($value as $v) {
                if (is_string($v) || is_numeric($v)) {
                    $items[] = (string) $v;
                }
            }
        } elseif (is_string($value)) {
            $items = str_contains($value, ';') ? array_map('trim', explode(';', $value)) : [$value];
        }
        $items = array_values(array_unique(array_filter($items, static fn ($s) => trim((string) $s) !== '')));
        return $items;
    }

    private static function extractYear(mixed $dateValue): ?int
    {
        $s = self::scalarize($dateValue);
        if ($s === null) {
            return null;
        }
        if (preg_match('/(\d{4})/', $s, $m)) {
            $year = (int) $m[1];
            return ($year >= 1800 && $year <= 2200) ? $year : null;
        }
        return null;
    }

    public static function stripHtml(string $html): string
    {
        $decoded = html_entity_decode($html, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $text = strip_tags($decoded);
        $text = preg_replace('/\s+/u', ' ', $text) ?? $text;
        return trim($text);
    }
}
