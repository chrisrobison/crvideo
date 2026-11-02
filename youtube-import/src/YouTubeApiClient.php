<?php
declare(strict_types=1);

// youtube-import/src/YouTubeApiClient.php
//
// Thin wrapper over the official YouTube Data API v3 REST endpoints this
// importer needs: channels.list, playlists.list, playlistItems.list,
// videos.list. Nothing here ever fetches a video file, scrapes a watch
// page, or shells out to yt-dlp -- metadata only, over documented API
// endpoints, exactly like ia-import's ArchiveMetadataClient restricts
// itself to archive.org's metadata API.
//
// The HTTP transport is injectable (a Closure(string $url, int
// $timeoutSeconds): array{status:int, body:?string, error:?string}), the
// same shape ArchiveMetadataClient uses, so tests and the CLI's
// --fixtures mode run with zero live network access. Without an injected
// transport, a real curl-based implementation is used (this repo's PHP
// has the curl extension already, same as ia-import relies on).
//
// Hard restriction: every request goes to https://www.googleapis.com/
// youtube/v3/... -- never a URL built from untrusted response data.

final class YouTubeApiClient
{
    private const BASE = 'https://www.googleapis.com/youtube/v3';
    private const PAGE_SIZE = 50; // YouTube's max for playlistItems.list and videos.list batches

    /** @var \Closure|null function(string $url, int $timeoutSeconds): array{status:int, body:?string, error:?string} */
    private ?\Closure $httpClient;
    /** @var \Closure|null function(string $message): void */
    private ?\Closure $logger;

    public function __construct(
        private string $apiKey,
        private int $timeoutSeconds = 15,
        ?\Closure $httpClient = null,
        ?\Closure $logger = null,
    ) {
        $this->httpClient = $httpClient;
        $this->logger = $logger;
    }

    private function log(string $message): void
    {
        if ($this->logger) {
            ($this->logger)($message);
        }
    }

    /**
     * Resolves a channel (by canonical id, @handle, or legacy username) to
     * its id, snippet, and uploads-playlist id in one channels.list call
     * (part=snippet,contentDetails covers both "resolve the canonical id"
     * and "retrieve the uploads playlist" from the spec in a single
     * request -- fewer quota units, same result).
     *
     * @return array{channelId: string, title: ?string, description: ?string,
     *               thumbnailUrl: ?string, uploadsPlaylistId: ?string}
     */
    public function resolveChannel(string $channelIdOrHandle, bool $isExplicitId): array
    {
        $params = ['part' => 'snippet,contentDetails'];
        if ($isExplicitId) {
            $params['id'] = $channelIdOrHandle;
        } elseif (str_starts_with($channelIdOrHandle, '@')) {
            $params['forHandle'] = $channelIdOrHandle;
        } else {
            $params['forUsername'] = $channelIdOrHandle;
        }

        $data = $this->get('/channels', $params);
        $item = $data['items'][0] ?? null;
        if (!is_array($item)) {
            throw new YouTubeApiException(
                YouTubeApiException::KIND_NOT_FOUND,
                "No YouTube channel found for \"$channelIdOrHandle\"."
            );
        }

        $snippet = $item['snippet'] ?? [];
        $uploads = $item['contentDetails']['relatedPlaylists']['uploads'] ?? null;

        return [
            'channelId' => (string) $item['id'],
            'title' => is_string($snippet['title'] ?? null) ? $snippet['title'] : null,
            'description' => is_string($snippet['description'] ?? null) ? $snippet['description'] : null,
            'thumbnailUrl' => $snippet['thumbnails']['high']['url'] ?? $snippet['thumbnails']['default']['url'] ?? null,
            'uploadsPlaylistId' => is_string($uploads) ? $uploads : null,
        ];
    }

    /**
     * @return array{title: ?string, description: ?string, channelId: ?string, channelTitle: ?string}
     */
    public function getPlaylistMeta(string $playlistId): array
    {
        $data = $this->get('/playlists', ['part' => 'snippet', 'id' => $playlistId]);
        $snippet = $data['items'][0]['snippet'] ?? null;
        if (!is_array($snippet)) {
            // Not fatal -- the playlist's videos can still be imported
            // without its own title/description; the CLI falls back to a
            // generic title.
            return ['title' => null, 'description' => null, 'channelId' => null, 'channelTitle' => null];
        }
        return [
            'title' => is_string($snippet['title'] ?? null) ? $snippet['title'] : null,
            'description' => is_string($snippet['description'] ?? null) ? $snippet['description'] : null,
            'channelId' => is_string($snippet['channelId'] ?? null) ? $snippet['channelId'] : null,
            'channelTitle' => is_string($snippet['channelTitle'] ?? null) ? $snippet['channelTitle'] : null,
        ];
    }

    /**
     * Enumerates a playlist's video ids in playlist order, paginating with
     * playlistItems.list until exhausted or $maxVideos is reached.
     *
     * @return list<array{videoId: string, position: int}>
     */
    public function listPlaylistVideoIds(string $playlistId, ?int $maxVideos = null): array
    {
        $out = [];
        $pageToken = null;
        do {
            $params = ['part' => 'contentDetails', 'playlistId' => $playlistId, 'maxResults' => self::PAGE_SIZE];
            if ($pageToken !== null) {
                $params['pageToken'] = $pageToken;
            }
            $data = $this->get('/playlistItems', $params);
            foreach ($data['items'] ?? [] as $item) {
                $videoId = $item['contentDetails']['videoId'] ?? null;
                if (!is_string($videoId) || $videoId === '') {
                    continue; // a playlist can contain a privated/deleted item with no usable video id at all
                }
                $out[] = ['videoId' => $videoId, 'position' => count($out)];
                if ($maxVideos !== null && count($out) >= $maxVideos) {
                    return $out;
                }
            }
            $pageToken = is_string($data['nextPageToken'] ?? null) ? $data['nextPageToken'] : null;
            $this->log("playlistItems page fetched: " . count($data['items'] ?? []) . ' item(s)' . ($pageToken ? ', more to follow' : ''));
        } while ($pageToken !== null);

        return $out;
    }

    /**
     * Fetches full video details in batches of up to 50 ids (the API's
     * limit for videos.list). Ids YouTube's response omits (deleted,
     * fully private, or otherwise inaccessible) are simply absent from the
     * returned map -- callers treat a missing id as "unavailable", per the
     * spec's note that the API often signals this by omission, not an
     * error.
     *
     * @param list<string> $videoIds
     * @return array<string, array<string,mixed>> videoId => raw videos.list item
     */
    public function getVideosDetails(array $videoIds): array
    {
        $out = [];
        foreach (array_chunk(array_values(array_unique($videoIds)), self::PAGE_SIZE) as $chunk) {
            $data = $this->get('/videos', [
                'part' => 'snippet,contentDetails,status,liveStreamingDetails',
                'id' => implode(',', $chunk),
                'maxResults' => self::PAGE_SIZE,
            ]);
            foreach ($data['items'] ?? [] as $item) {
                if (is_string($item['id'] ?? null)) {
                    $out[$item['id']] = $item;
                }
            }
        }
        return $out;
    }

    /** @return array<string,mixed> decoded JSON body */
    private function get(string $path, array $params): array
    {
        $params['key'] = $this->apiKey;
        $url = self::BASE . $path . '?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986);
        $client = $this->httpClient ?? $this->realHttpClient();
        return $this->requestWithRetry($url, $client);
    }

    private function requestWithRetry(string $url, \Closure $client, int $attempt = 1): array
    {
        $resp = $client($url, $this->timeoutSeconds);
        $status = (int) ($resp['status'] ?? 0);
        $transportError = $resp['error'] ?? null;

        if ($transportError !== null || $status === 0 || $status >= 500 || $status === 429) {
            if ($attempt < 3) {
                usleep(150000 * $attempt);
                return $this->requestWithRetry($url, $client, $attempt + 1);
            }
            throw new YouTubeApiException(
                YouTubeApiException::KIND_NETWORK,
                'Network error contacting the YouTube Data API after retries: ' . ($transportError ?? "HTTP $status")
            );
        }

        $body = (string) ($resp['body'] ?? '');
        $data = json_decode($body, true);

        if ($status !== 200) {
            $this->throwForErrorResponse($status, is_array($data) ? $data : null, $body);
        }
        if (!is_array($data)) {
            throw new YouTubeApiException(YouTubeApiException::KIND_API, 'YouTube API returned invalid JSON.');
        }
        return $data;
    }

    private function throwForErrorResponse(int $status, ?array $data, string $rawBody): never
    {
        $reason = $data['error']['errors'][0]['reason'] ?? null;
        $message = $data['error']['message'] ?? null;

        if ($status === 403 && in_array($reason, ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'], true)) {
            throw new YouTubeApiException(
                YouTubeApiException::KIND_QUOTA_EXCEEDED,
                'YouTube Data API quota exceeded' . ($message ? ": $message" : '.') . ' Try again after your quota resets, or use a different project/key.'
            );
        }
        if (($status === 400 && in_array($reason, ['keyInvalid', 'badRequest'], true) && str_contains((string) $message, 'key'))
            || ($status === 403 && in_array($reason, ['keyInvalid', 'forbidden', 'accessNotConfigured'], true))
        ) {
            throw new YouTubeApiException(
                YouTubeApiException::KIND_INVALID_KEY,
                'YouTube Data API rejected the credentials' . ($message ? ": $message" : '.')
                . ' Check YOUTUBE_API_KEY / config.local.php and that the YouTube Data API v3 is enabled for this key\'s project.'
            );
        }
        if ($status === 404) {
            throw new YouTubeApiException(YouTubeApiException::KIND_NOT_FOUND, 'YouTube API: resource not found' . ($message ? ": $message" : '.'));
        }

        throw new YouTubeApiException(
            YouTubeApiException::KIND_API,
            "YouTube API error (HTTP $status)" . ($message ? ": $message" : (': ' . substr($rawBody, 0, 200)))
        );
    }

    private function realHttpClient(): \Closure
    {
        return function (string $url, int $timeoutSeconds): array {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => $timeoutSeconds,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                CURLOPT_HTTPHEADER => ['Accept: application/json'],
                CURLOPT_USERAGENT => 'crvideo-youtube-import/1.0',
            ]);
            $body = curl_exec($ch);
            $error = curl_error($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            curl_close($ch);
            if ($body === false || $error !== '') {
                return ['status' => 0, 'body' => null, 'error' => $error !== '' ? $error : 'unknown curl error'];
            }
            return ['status' => $status, 'body' => (string) $body, 'error' => null];
        };
    }
}
