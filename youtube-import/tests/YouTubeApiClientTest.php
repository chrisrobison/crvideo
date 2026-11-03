<?php
declare(strict_types=1);

final class YouTubeApiClientTest
{
    private function qs(string $url): array
    {
        $out = [];
        parse_str((string) parse_url($url, PHP_URL_QUERY), $out);
        return $out;
    }

    public function testResolveChannelByHandleUsesForHandleParam(): void
    {
        $seen = [];
        $http = function (string $url) use (&$seen): array {
            $seen[] = $url;
            return ['status' => 200, 'body' => json_encode(['items' => [[
                'id' => 'UC123', 'snippet' => ['title' => 'My Channel', 'description' => 'd'],
                'contentDetails' => ['relatedPlaylists' => ['uploads' => 'UU123']],
            ]]]), 'error' => null];
        };
        $client = new YouTubeApiClient('key', 5, $http);
        $resolved = $client->resolveChannel('@MyChannel', false);
        Assert::same('UC123', $resolved['channelId']);
        Assert::same('My Channel', $resolved['title']);
        Assert::same('UU123', $resolved['uploadsPlaylistId']);
        Assert::same('@MyChannel', $this->qs($seen[0])['forHandle'] ?? null);
    }

    public function testResolveChannelByExplicitIdUsesIdParam(): void
    {
        $seen = [];
        $http = function (string $url) use (&$seen): array {
            $seen[] = $url;
            return ['status' => 200, 'body' => json_encode(['items' => [[
                'id' => 'UC999', 'snippet' => ['title' => 'X'], 'contentDetails' => ['relatedPlaylists' => ['uploads' => 'UU999']],
            ]]]), 'error' => null];
        };
        $client = new YouTubeApiClient('key', 5, $http);
        $resolved = $client->resolveChannel('UC999', true);
        Assert::same('UC999', $this->qs($seen[0])['id'] ?? null);
        Assert::null($this->qs($seen[0])['forHandle'] ?? null);
    }

    public function testResolveChannelNotFoundThrowsNotFound(): void
    {
        $http = fn (string $url): array => ['status' => 200, 'body' => json_encode(['items' => []]), 'error' => null];
        $client = new YouTubeApiClient('key', 5, $http);
        try {
            $client->resolveChannel('@nope', false);
            throw new AssertionFailed('expected YouTubeApiException');
        } catch (YouTubeApiException $e) {
            Assert::same(YouTubeApiException::KIND_NOT_FOUND, $e->kind);
        }
    }

    public function testPlaylistItemsPaginatesUntilNoNextPageToken(): void
    {
        $pages = 0;
        $http = function (string $url) use (&$pages): array {
            $q = [];
            parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
            $pages++;
            if (($q['pageToken'] ?? null) === null) {
                return ['status' => 200, 'body' => json_encode([
                    'items' => [
                        ['contentDetails' => ['videoId' => 'v1']],
                        ['contentDetails' => ['videoId' => 'v2']],
                    ],
                    'nextPageToken' => 'PAGE2',
                ]), 'error' => null];
            }
            Assert::same('PAGE2', $q['pageToken']);
            return ['status' => 200, 'body' => json_encode([
                'items' => [['contentDetails' => ['videoId' => 'v3']]],
            ]), 'error' => null];
        };
        $client = new YouTubeApiClient('key', 5, $http);
        $ids = $client->listPlaylistVideoIds('PL1');
        Assert::same(['v1', 'v2', 'v3'], array_column($ids, 'videoId'));
        Assert::same(2, $pages);
    }

    public function testPlaylistItemsStopsEarlyAtMaxVideos(): void
    {
        $http = fn (string $url): array => ['status' => 200, 'body' => json_encode([
            'items' => [
                ['contentDetails' => ['videoId' => 'v1']],
                ['contentDetails' => ['videoId' => 'v2']],
                ['contentDetails' => ['videoId' => 'v3']],
            ],
            'nextPageToken' => 'MORE', // would paginate forever if maxVideos didn't stop it
        ]), 'error' => null];
        $client = new YouTubeApiClient('key', 5, $http);
        $ids = $client->listPlaylistVideoIds('PL1', 2);
        Assert::same(['v1', 'v2'], array_column($ids, 'videoId'));
    }

    public function testVideosDetailsChunksAt50AndOmitsUnreturnedIds(): void
    {
        $calls = [];
        $http = function (string $url) use (&$calls): array {
            $q = [];
            parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
            $ids = explode(',', $q['id']);
            $calls[] = count($ids);
            // Simulate the last id in the batch being deleted/private (omitted).
            $items = array_map(fn ($id) => ['id' => $id, 'snippet' => [], 'contentDetails' => [], 'status' => []], array_slice($ids, 0, -1));
            return ['status' => 200, 'body' => json_encode(['items' => $items]), 'error' => null];
        };
        $client = new YouTubeApiClient('key', 5, $http);
        $ids = array_map(fn ($i) => "v$i", range(1, 60));
        $result = $client->getVideosDetails($ids);
        Assert::same([50, 10], $calls, 'ids should be chunked into batches of at most 50');
        Assert::true(!isset($result['v50']), 'the omitted id in the first batch must not appear in the result');
        Assert::true(!isset($result['v60']), 'the omitted id in the second batch must not appear in the result');
        Assert::true(isset($result['v1']));
    }

    public function testQuotaExceededIsClassified(): void
    {
        $http = fn (string $url): array => ['status' => 403, 'body' => json_encode([
            'error' => ['code' => 403, 'message' => 'Quota exceeded', 'errors' => [['reason' => 'quotaExceeded']]],
        ]), 'error' => null];
        $client = new YouTubeApiClient('key', 5, $http);
        try {
            $client->getPlaylistMeta('PL1');
            throw new AssertionFailed('expected YouTubeApiException');
        } catch (YouTubeApiException $e) {
            Assert::same(YouTubeApiException::KIND_QUOTA_EXCEEDED, $e->kind);
        }
    }

    public function testInvalidKeyIsClassified(): void
    {
        $http = fn (string $url): array => ['status' => 403, 'body' => json_encode([
            'error' => ['code' => 403, 'message' => 'Bad key', 'errors' => [['reason' => 'keyInvalid']]],
        ]), 'error' => null];
        $client = new YouTubeApiClient('key', 5, $http);
        try {
            $client->getPlaylistMeta('PL1');
            throw new AssertionFailed('expected YouTubeApiException');
        } catch (YouTubeApiException $e) {
            Assert::same(YouTubeApiException::KIND_INVALID_KEY, $e->kind);
        }
    }

    public function testNetworkFailureRetriesThenThrows(): void
    {
        $attempts = 0;
        $http = function (string $url) use (&$attempts): array {
            $attempts++;
            return ['status' => 0, 'body' => null, 'error' => 'connection refused'];
        };
        $client = new YouTubeApiClient('key', 1, $http);
        try {
            $client->getPlaylistMeta('PL1');
            throw new AssertionFailed('expected YouTubeApiException');
        } catch (YouTubeApiException $e) {
            Assert::same(YouTubeApiException::KIND_NETWORK, $e->kind);
            Assert::same(3, $attempts, 'should retry up to 3 attempts total');
        }
    }

    public function testPlaylistMetaMissingIsNotFatal(): void
    {
        $http = fn (string $url): array => ['status' => 200, 'body' => json_encode(['items' => []]), 'error' => null];
        $client = new YouTubeApiClient('key', 5, $http);
        $meta = $client->getPlaylistMeta('PL-does-not-exist');
        Assert::null($meta['title']);
    }
}
