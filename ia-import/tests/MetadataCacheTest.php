<?php
declare(strict_types=1);

final class MetadataCacheTest
{
    private string $dir;

    public function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/ia-import-cache-test-' . bin2hex(random_bytes(4));
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

    public function testMissIsNull(): void
    {
        $cache = new MetadataCache($this->dir);
        Assert::null($cache->get('nope'));
        $this->cleanup();
    }

    public function testSetThenGetIsHit(): void
    {
        $cache = new MetadataCache($this->dir);
        $cache->set('some-id', ['metadata' => ['title' => 'X']]);
        $wrapper = $cache->get('some-id');
        Assert::notNull($wrapper);
        Assert::same('X', $wrapper['raw']['metadata']['title']);
        $this->cleanup();
    }

    public function testExpiryIsRespected(): void
    {
        $cache = new MetadataCache($this->dir, 10); // 10 second TTL
        $cache->set('old-id', ['metadata' => []]);
        // Rewrite the cache file with a fetched_at far in the past.
        $path = $this->dir . '/' . MetadataCache::sanitizeIdentifier('old-id') . '.json';
        $wrapper = json_decode(file_get_contents($path), true);
        $wrapper['fetched_at'] = time() - 3600;
        file_put_contents($path, json_encode($wrapper));

        Assert::null($cache->get('old-id'), 'expired entry should be treated as a miss');
        Assert::notNull($cache->get('old-id', true), 'ignoreExpiry=true should still return the stale entry');
        $this->cleanup();
    }

    public function testIdentifierSanitizationPreventsPathEscape(): void
    {
        $clean = MetadataCache::sanitizeIdentifier('../../etc/passwd');
        Assert::true(!str_contains($clean, '/'), 'sanitized identifier must not contain path separators');
        Assert::true(!str_contains($clean, '..'), 'sanitized identifier must not contain ".."');
    }

    public function testHasReflectsPresence(): void
    {
        $cache = new MetadataCache($this->dir);
        Assert::true(!$cache->has('missing-id'));
        $cache->set('present-id', ['metadata' => []]);
        Assert::true($cache->has('present-id'));
        $this->cleanup();
    }
}
