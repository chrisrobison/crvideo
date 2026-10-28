<?php
declare(strict_types=1);

final class ArchiveMetadataClientTest
{
    private string $dir;

    public function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/ia-import-client-test-' . bin2hex(random_bytes(4));
    }

    private function cleanup(): void
    {
        if (is_dir($this->dir)) {
            foreach (glob($this->dir . '/*') as $f) {
                unlink($f);
            }
            rmdir($this->dir);
        }
    }

    public function testSuccessfulFetchIsCached(): void
    {
        $cache = new MetadataCache($this->dir);
        $calls = [];
        $http = function (string $url, int $timeout) use (&$calls): array {
            $calls[] = $url;
            return ['status' => 200, 'body' => json_encode(['metadata' => ['title' => 'Hello']]), 'error' => null];
        };
        $client = new ArchiveMetadataClient($cache, 5, 4, false, $http);
        $result = $client->fetchMany(['abc']);
        Assert::same('Hello', $result['abc']['raw']['metadata']['title']);
        Assert::true(!$result['abc']['from_cache']);
        Assert::count(1, $calls);
        Assert::true($cache->has('abc'));
        $this->cleanup();
    }

    public function testCacheHitAvoidsNetworkCall(): void
    {
        $cache = new MetadataCache($this->dir);
        $cache->set('abc', ['metadata' => ['title' => 'Cached']]);
        $calls = 0;
        $http = function (string $url, int $timeout) use (&$calls): array {
            $calls++;
            return ['status' => 200, 'body' => json_encode(['metadata' => ['title' => 'Fresh']]), 'error' => null];
        };
        $client = new ArchiveMetadataClient($cache, 5, 4, false, $http);
        $result = $client->fetchMany(['abc']);
        Assert::same('Cached', $result['abc']['raw']['metadata']['title']);
        Assert::true($result['abc']['from_cache']);
        Assert::same(0, $calls, 'cached entry must not trigger a network call');
        $this->cleanup();
    }

    public function testRefreshBypassesCache(): void
    {
        $cache = new MetadataCache($this->dir);
        $cache->set('abc', ['metadata' => ['title' => 'Cached']]);
        $calls = 0;
        $http = function (string $url, int $timeout) use (&$calls): array {
            $calls++;
            return ['status' => 200, 'body' => json_encode(['metadata' => ['title' => 'Fresh']]), 'error' => null];
        };
        $client = new ArchiveMetadataClient($cache, 5, 4, true, $http);
        $result = $client->fetchMany(['abc']);
        Assert::same('Fresh', $result['abc']['raw']['metadata']['title']);
        Assert::same(1, $calls);
        $this->cleanup();
    }

    public function testSimulatedNetworkFailureFallsBackToStaleCache(): void
    {
        $cache = new MetadataCache($this->dir, 10);
        $cache->set('abc', ['metadata' => ['title' => 'OldButGood']]);
        $path = $this->dir . '/' . MetadataCache::sanitizeIdentifier('abc') . '.json';
        $wrapper = json_decode(file_get_contents($path), true);
        $wrapper['fetched_at'] = time() - 3600; // force expiry
        file_put_contents($path, json_encode($wrapper));

        $http = function (string $url, int $timeout): array {
            return ['status' => 0, 'body' => null, 'error' => 'connection refused'];
        };
        $client = new ArchiveMetadataClient($cache, 5, 4, false, $http);
        $result = $client->fetchMany(['abc']);
        Assert::notNull($result['abc']['raw'], 'a failed refetch must fall back to the stale cached value');
        Assert::same('OldButGood', $result['abc']['raw']['metadata']['title']);
        $this->cleanup();
    }

    public function testSimulatedNetworkFailureWithNoCacheReportsError(): void
    {
        $cache = new MetadataCache($this->dir);
        $http = function (string $url, int $timeout): array {
            return ['status' => 0, 'body' => null, 'error' => 'connection refused'];
        };
        $client = new ArchiveMetadataClient($cache, 5, 4, false, $http);
        $result = $client->fetchMany(['abc']);
        Assert::null($result['abc']['raw']);
        Assert::notNull($result['abc']['error']);
        $this->cleanup();
    }

    public function testInvalidIdentifierNeverReachesTransport(): void
    {
        $cache = new MetadataCache($this->dir);
        $calls = 0;
        $http = function (string $url, int $timeout) use (&$calls): array {
            $calls++;
            return ['status' => 200, 'body' => '{}', 'error' => null];
        };
        $client = new ArchiveMetadataClient($cache, 5, 4, false, $http);
        $result = $client->fetchMany(['../../etc/passwd']);
        Assert::same(0, $calls, 'an identifier with path-escape characters must never reach the HTTP transport');
        Assert::null($result['../../etc/passwd']['raw']);
        $this->cleanup();
    }
}
