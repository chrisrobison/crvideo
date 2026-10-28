<?php
declare(strict_types=1);

final class MediaCatalogTest
{
    public function testPreservesSourceOrderAndHandlesFailures(): void
    {
        $members = [
            ['identifier' => 'a', 'member_id' => 1, 'date_added' => null, 'original_position' => 1],
            ['identifier' => 'b', 'member_id' => 2, 'date_added' => null, 'original_position' => 2],
            ['identifier' => 'c', 'member_id' => 3, 'date_added' => null, 'original_position' => 3],
        ];
        $metadataResults = [
            'a' => ['raw' => ['metadata' => ['title' => 'A'], 'files' => [['name' => 'a.mp4', 'format' => 'h.264', 'length' => '100']]], 'from_cache' => false, 'error' => null],
            'b' => ['raw' => null, 'from_cache' => false, 'error' => 'HTTP 404'],
            'c' => ['raw' => ['metadata' => ['title' => 'C'], 'files' => [['name' => 'c.mp4', 'format' => 'h.264', 'length' => '200']]], 'from_cache' => false, 'error' => null],
        ];

        $result = MediaCatalog::build($members, $metadataResults);
        Assert::count(3, $result['items'], 'no entry should be dropped, including the failed fetch');
        Assert::same('a', $result['items'][0]['id']);
        Assert::same('b', $result['items'][1]['id']);
        Assert::same('c', $result['items'][2]['id']);
        Assert::same('error', $result['items'][1]['status']);
        Assert::same(1, $result['stats']['metadata_failed']);
        Assert::same(2, $result['stats']['playable']);
    }

    public function testToSchedulerItemsOnlyIncludesReadyItemsWithDuration(): void
    {
        $catalogItems = [
            ['id' => 'ready-1', 'status' => 'ready', 'duration' => 100.0, 'original_position' => 1, 'subjects' => [], 'collections' => [], 'creator' => null],
            ['id' => 'unknown-1', 'status' => 'unknown_duration', 'duration' => null, 'original_position' => 2, 'subjects' => [], 'collections' => [], 'creator' => null],
            ['id' => 'error-1', 'status' => 'error', 'duration' => null, 'original_position' => 3, 'subjects' => [], 'collections' => [], 'creator' => null],
        ];
        $schedulerItems = MediaCatalog::toSchedulerItems($catalogItems);
        Assert::count(1, $schedulerItems);
        Assert::same('ready-1', $schedulerItems[0]['id']);
    }
}
