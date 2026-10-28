<?php
declare(strict_types=1);

// ia-import/src/MediaCatalog.php
//
// Combines parsed list members + fetched IA metadata + MediaResolver output
// into the flat, normalized "catalog" item list described in the README /
// schema. Source list order is always preserved in the returned items list,
// even though the schedule built from it later may reorder things.

final class MediaCatalog
{
    /**
     * @param list<array{identifier:string,member_id:mixed,date_added:mixed,original_position:int}> $members
     * @param array<string, array{raw: ?array, from_cache: bool, stale: bool, error: ?string}> $metadataResults
     * @return array{items: list<array<string,mixed>>, warnings: list<string>, stats: array<string,int>}
     */
    public static function build(array $members, array $metadataResults, array $options = []): array
    {
        $items = [];
        $warnings = [];
        $stats = [
            'members' => count($members),
            'metadata_fetched' => 0,
            'metadata_failed' => 0,
            'cache_hits' => 0,
            'playable' => 0,
            'unknown_duration' => 0,
            'unavailable' => 0,
        ];

        // The same identifier can legitimately appear more than once in the
        // source list (the spec requires preserving each as a separate
        // entry -- the user chose to list a film twice, it's not an
        // accidental duplicate). Give repeated occurrences distinct catalog
        // ids so they never collide in the scheduler or in lookups keyed by
        // id further downstream.
        $identifierCounts = [];
        foreach ($members as $member) {
            $identifierCounts[$member['identifier']] = ($identifierCounts[$member['identifier']] ?? 0) + 1;
        }
        $occurrenceSeen = [];

        foreach ($members as $member) {
            $id = $member['identifier'];
            $occurrenceSeen[$id] = ($occurrenceSeen[$id] ?? 0) + 1;
            $occurrenceIndex = $occurrenceSeen[$id];
            $idSuffix = $identifierCounts[$id] > 1 ? ('@' . $occurrenceIndex) : '';

            $result = $metadataResults[$id] ?? ['raw' => null, 'from_cache' => false, 'error' => 'not fetched'];

            if ($result['from_cache'] ?? false) {
                $stats['cache_hits']++;
            }

            if ($result['raw'] === null) {
                $stats['metadata_failed']++;
                $msg = $result['error'] ?? 'unknown error';
                $warnings[] = "$id: metadata fetch failed ($msg)";
                $items[] = self::errorItem($member, "metadata fetch failed: $msg", $idSuffix);
                continue;
            }

            $stats['metadata_fetched']++;

            try {
                $resolved = MediaResolver::resolve($result['raw'], $id, $options);
            } catch (Throwable $e) {
                $warnings[] = "$id: failed to resolve media (" . $e->getMessage() . ')';
                $items[] = self::errorItem($member, 'media resolution failed: ' . $e->getMessage(), $idSuffix);
                continue;
            }

            foreach ($resolved as $part) {
                $catalogId = $id . $idSuffix . ($part['part_count'] > 1 ? ('#' . $part['part_index']) : '');
                // Fractional offset keeps multi-part siblings in order
                // relative to each other without colliding with the
                // integer original_position of other list members.
                $originalPosition = $member['original_position'] + (($part['part_index'] - 1) * 0.001);

                foreach ($part['warnings'] as $w) {
                    $warnings[] = "$id: $w";
                }

                if ($part['status'] === 'ready') {
                    $stats['playable']++;
                } elseif ($part['status'] === 'unknown_duration') {
                    $stats['unknown_duration']++;
                } else {
                    $stats['unavailable']++;
                }

                $items[] = [
                    'id' => $catalogId,
                    'identifier' => $id,
                    'member_id' => $member['member_id'],
                    'original_position' => $originalPosition,
                    'list_position' => $member['original_position'],
                    'part_index' => $part['part_index'],
                    'part_count' => $part['part_count'],
                    'title' => $part['title'],
                    'duration' => $part['duration'],
                    'duration_source' => $part['duration_source'],
                    'year' => $part['year'],
                    'creator' => $part['creator'],
                    'description' => $part['description'],
                    'subjects' => $part['subjects'],
                    'collections' => $part['collections'],
                    'source_url' => $part['source_url'],
                    'media_url' => $part['media_url'],
                    'thumbnail_url' => $part['thumbnail_url'],
                    'selected_file' => $part['selected_file'],
                    'format' => $part['format'],
                    'license' => $part['license'],
                    'status' => $part['status'],
                    'warnings' => $part['warnings'],
                ];
            }
        }

        return ['items' => $items, 'warnings' => $warnings, 'stats' => $stats];
    }

    private static function errorItem(array $member, string $reason, string $idSuffix = ''): array
    {
        return [
            'id' => $member['identifier'] . $idSuffix,
            'identifier' => $member['identifier'],
            'member_id' => $member['member_id'],
            'original_position' => $member['original_position'],
            'list_position' => $member['original_position'],
            'part_index' => 1,
            'part_count' => 1,
            'title' => $member['identifier'],
            'duration' => null,
            'duration_source' => 'none',
            'year' => null,
            'creator' => null,
            'description' => '',
            'subjects' => [],
            'collections' => [],
            'source_url' => 'https://archive.org/details/' . rawurlencode($member['identifier']),
            'media_url' => null,
            'thumbnail_url' => null,
            'selected_file' => null,
            'format' => null,
            'license' => null,
            'status' => 'error',
            'warnings' => [$reason],
        ];
    }

    /**
     * Projects catalog items with a known duration and status=ready into the
     * generic shape the (IA-agnostic) ScheduleOptimizer understands: id,
     * duration, original_position, plus a few optional hint fields it may
     * use for the balanced strategy's variety scoring.
     *
     * @param list<array<string,mixed>> $catalogItems
     * @return list<array<string,mixed>>
     */
    public static function toSchedulerItems(array $catalogItems): array
    {
        $out = [];
        foreach ($catalogItems as $item) {
            if ($item['status'] !== 'ready' || $item['duration'] === null) {
                continue;
            }
            $out[] = [
                'id' => $item['id'],
                'duration' => (float) $item['duration'],
                'original_position' => (float) $item['original_position'],
                'subjects' => $item['subjects'] ?? [],
                'collections' => $item['collections'] ?? [],
                'creator' => $item['creator'] ?? null,
            ];
        }
        return $out;
    }
}
