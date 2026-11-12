<?php
declare(strict_types=1);

// youtube-import/src/YouTubeSeriesBuilder.php
//
// Merges freshly fetched YouTube video metadata into a series.json (the
// portable series schema; see series/*/series.json), either
// creating one from scratch or refreshing an existing one. This is where
// the spec's "Import safety and refreshes" rules actually live:
//
// YouTube-sourced fields (always safe to overwrite from a fresh fetch --
// they describe the source, not an editorial decision):
//   duration, year, published_at, thumbnail_url, and everything under
//   "source" (video_id, url, channel_id, channel_title, kind, embeddable,
//   made_for_kids, privacy_status, availability, availability_detail).
//
// Editorially-owned fields (set once, from YouTube, at the moment an
// episode is first created as a "candidate" -- NEVER touched again by any
// later refresh, even if nothing about them was ever hand-edited):
//   title, description, guests, status, rights, episode_number.
//
// We deliberately don't try to track a per-field "was this hand-edited?"
// dirty bit to allow safely re-syncing an untouched title/description --
// that would need to persist a shadow copy of "the last value we wrote"
// to tell "never touched" apart from "edited back to coincidentally the
// same text," which is more machinery than it is worth. Treating
// those fields as frozen at creation time is the simpler rule that can
// never clobber a hand edit, which is the hard requirement; the cost is
// that a title YouTube later corrects won't auto-sync, which an editor
// can still do by hand. This trade-off is called out again in the CLI's
// README/report, not just here.
//
// Show-level (series-wide) fields follow the same spirit: an existing
// series.json's top-level fields (title, description, thumbnail_url,
// logo_url, creator, source.channel_id/channel_url/playlist_id, etc.) are
// only ever *filled in* when they are currently null/missing -- never
// overwritten once set, so hand-written show metadata (or a previous
// import's result) is never clobbered by a later refresh either.
//
// New videos are appended as status "candidate" -- importing never
// publishes anything. A video that no longer resolves via videos.list is
// marked source.availability = "unavailable" in place; it is never
// removed from the episodes array.

final class YouTubeSeriesBuilder
{
    /**
     * @param ?array<string,mixed> $existingSeries Previously loaded series.json, or null to create fresh.
     * @param array<string,mixed> $seriesDefaults Used only when $existingSeries is null: schema_version/id/title/
     *                                              description/creator/year/thumbnail_url/logo_url/rotation/source.
     * @param list<string> $discoveredOrder Video ids found this run, in feed/playlist order (channel uploads or
     *                                       playlist order) -- drives the insertion order of brand-new episodes.
     * @param array<string, ?array<string,mixed>> $videosById Every video id checked this run => its raw
     *                                       videos.list item, or null if YouTube didn't return it (unavailable).
     *                                       An id simply absent from this map was not checked this run at all
     *                                       (the CLI's quota-saving skip of already-unavailable episodes) and is
     *                                       carried forward completely unchanged.
     * @param array{provider:string, channel_id:?string, channel_title:?string, playlist_id:?string} $sourceContext
     * @return array{series: array<string,mixed>, summary: array{added:list<string>,updated:list<string>,unavailable:list<string>,unchanged:list<string>,warnings:list<string>}}
     */
    public static function build(
        ?array $existingSeries,
        array $seriesDefaults,
        array $discoveredOrder,
        array $videosById,
        array $sourceContext,
    ): array {
        $summary = ['added' => [], 'updated' => [], 'unavailable' => [], 'unchanged' => [], 'warnings' => []];

        $series = $existingSeries ?? $seriesDefaults;
        if (!isset($series['episodes']) || !is_array($series['episodes'])) {
            $series['episodes'] = [];
        }

        // Fill-in-if-null for show-level fields -- never overwrite something already set.
        foreach (['title', 'description', 'thumbnail_url', 'logo_url', 'creator', 'year'] as $field) {
            if (($series[$field] ?? null) === null && ($seriesDefaults[$field] ?? null) !== null) {
                $series[$field] = $seriesDefaults[$field];
            }
        }
        $series['source'] = (is_array($series['source'] ?? null)) ? $series['source'] : [];
        foreach (['provider', 'channel_id', 'channel_url', 'playlist_id'] as $field) {
            if (($series['source'][$field] ?? null) === null && ($seriesDefaults['source'][$field] ?? null) !== null) {
                $series['source'][$field] = $seriesDefaults['source'][$field];
            }
        }

        $existingByVideoId = [];
        foreach ($series['episodes'] as $i => $ep) {
            $vid = $ep['source']['video_id'] ?? null;
            if (!is_string($vid) || $vid === '') {
                continue;
            }
            if (isset($existingByVideoId[$vid])) {
                $summary['warnings'][] = "series.json already contained more than one episode for video id \"$vid\"; only the first is updated.";
                continue;
            }
            $existingByVideoId[$vid] = $i;
        }

        $maxEpisodeNumber = 0;
        foreach ($series['episodes'] as $ep) {
            if (is_int($ep['episode_number'] ?? null)) {
                $maxEpisodeNumber = max($maxEpisodeNumber, $ep['episode_number']);
            }
        }

        // ---- pass 1: refresh YouTube-sourced fields on episodes we already know ----
        foreach ($videosById as $vid => $raw) {
            if (!isset($existingByVideoId[$vid])) {
                continue; // handled in pass 2, below, if it's genuinely new
            }
            $idx = $existingByVideoId[$vid];
            $ep = $series['episodes'][$idx];

            if ($raw === null) {
                $wasUnavailable = ($ep['source']['availability'] ?? null) === 'unavailable';
                $ep['source']['availability'] = 'unavailable';
                $ep['source']['availability_detail'] = 'not returned by videos.list (deleted, private, or otherwise inaccessible)';
                $series['episodes'][$idx] = $ep;
                $summary['unavailable'][] = $ep['id'];
                if (!$wasUnavailable) {
                    $summary['updated'][] = $ep['id'];
                }
                continue;
            }

            $fresh = self::youtubeSourcedFields($vid, $raw, $sourceContext);
            $beforeSnapshot = json_encode([
                $ep['duration'] ?? null, $ep['year'] ?? null, $ep['published_at'] ?? null,
                $ep['thumbnail_url'] ?? null, $ep['source'] ?? null,
            ]);

            $ep['duration'] = $fresh['duration'];
            $ep['year'] = $fresh['year'];
            $ep['published_at'] = $fresh['published_at'];
            $ep['thumbnail_url'] = $fresh['thumbnail_url'];
            $ep['source'] = $fresh['source'];

            $afterSnapshot = json_encode([
                $ep['duration'], $ep['year'], $ep['published_at'], $ep['thumbnail_url'], $ep['source'],
            ]);

            $series['episodes'][$idx] = $ep;
            if ($beforeSnapshot !== $afterSnapshot) {
                $summary['updated'][] = $ep['id'];
            } else {
                $summary['unchanged'][] = $ep['id'];
            }
        }

        // ---- pass 2: brand-new candidates, appended in discovery order ----
        foreach ($discoveredOrder as $vid) {
            if (isset($existingByVideoId[$vid])) {
                continue;
            }
            $raw = $videosById[$vid] ?? null;
            if ($raw === null) {
                // Listed in the feed a moment ago but already gone by the time
                // we asked videos.list for details -- nothing to add yet.
                $summary['warnings'][] = "yt-$vid was found in the feed but videos.list returned nothing for it; not added.";
                continue;
            }

            $fresh = self::youtubeSourcedFields($vid, $raw, $sourceContext);
            $maxEpisodeNumber++;
            $id = "yt-$vid";
            $series['episodes'][] = [
                'id' => $id,
                'episode_number' => $maxEpisodeNumber,
                'title' => is_string($raw['snippet']['title'] ?? null) ? $raw['snippet']['title'] : $id,
                'description' => is_string($raw['snippet']['description'] ?? null) ? $raw['snippet']['description'] : '',
                'duration' => $fresh['duration'],
                'year' => $fresh['year'],
                'published_at' => $fresh['published_at'],
                'thumbnail_url' => $fresh['thumbnail_url'],
                'guests' => [],
                'source' => $fresh['source'],
                'status' => 'candidate',
                'rights' => ['status' => 'unverified', 'notes' => null],
            ];
            $existingByVideoId[$vid] = array_key_last($series['episodes']);
            $summary['added'][] = $id;
        }

        // The phase-1 placeholder files carry a "_note" explaining they have
        // no real episodes yet; once a real import actually adds one, that
        // note no longer describes the file, so drop it. Only ever removes
        // our own placeholder text, never an editor's unrelated "_note".
        if (!empty($series['episodes']) && is_string($series['_note'] ?? null)
            && str_contains($series['_note'], 'STRUCTURAL PLACEHOLDER')) {
            unset($series['_note']);
        }

        return ['series' => $series, 'summary' => $summary];
    }

    /**
     * @return array{duration:?float, year:?int, published_at:?string, thumbnail_url:?string, source: array<string,mixed>}
     */
    private static function youtubeSourcedFields(string $videoId, array $raw, array $sourceContext): array
    {
        $classified = YouTubeVideoClassifier::classify($raw);
        $publishedAt = $classified['published_at'];
        $year = $publishedAt !== null && preg_match('/^(\d{4})-/', $publishedAt, $m) ? (int) $m[1] : null;

        $availability = 'available';
        if ($classified['privacy_status'] === 'private') {
            $availability = 'private';
        } elseif ($classified['availability_signal'] === 'restricted') {
            $availability = 'restricted';
        }

        $snippet = $raw['snippet'] ?? [];
        $thumbnail = $snippet['thumbnails']['high']['url']
            ?? $snippet['thumbnails']['medium']['url']
            ?? $snippet['thumbnails']['default']['url']
            ?? null;

        $source = [
            'provider' => 'youtube',
            'video_id' => $videoId,
            'url' => "https://www.youtube.com/watch?v=$videoId",
            'channel_id' => is_string($snippet['channelId'] ?? null) ? $snippet['channelId'] : ($sourceContext['channel_id'] ?? null),
            'channel_title' => is_string($snippet['channelTitle'] ?? null) ? $snippet['channelTitle'] : ($sourceContext['channel_title'] ?? null),
            'kind' => $classified['kind'],
            'embeddable' => $classified['embeddable'],
            'made_for_kids' => $classified['made_for_kids'],
            'privacy_status' => $classified['privacy_status'],
            'availability' => $availability,
            'availability_detail' => $classified['availability_detail'],
        ];
        if (!empty($sourceContext['playlist_id'])) {
            $source['playlist_id'] = $sourceContext['playlist_id'];
        }

        return [
            'duration' => $classified['duration'],
            'year' => $year,
            'published_at' => $publishedAt,
            'thumbnail_url' => is_string($thumbnail) ? $thumbnail : null,
            'source' => $source,
        ];
    }
}
