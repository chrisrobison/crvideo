<?php
declare(strict_types=1);

final class ExplorerAdminTest
{
    private string $seriesDir;

    public function setUp(): void
    {
        $this->seriesDir = __DIR__ . '/fixtures/repo/series';
    }

    public function testSeriesIndexListsEveryFixtureSeriesWithoutEpisodes(): void
    {
        $index = explorer_series_index($this->seriesDir);
        $ids = array_column($index, 'id');
        Assert::contains('demo-series', $ids);
        Assert::contains('playlist-series', $ids);
        foreach ($index as $row) {
            Assert::true(!array_key_exists('episodes', $row), 'index rows must not embed episodes');
            Assert::true(is_int($row['episode_count']));
            Assert::true(is_array($row['status_counts']));
        }
    }

    public function testSeriesDetailReturnsEpisodesWithStatusAndRights(): void
    {
        $detail = explorer_series_detail('demo-series', $this->seriesDir);
        Assert::same('demo-series', $detail['id']);
        Assert::same(count($detail['episodes']), $detail['episode_count']);
        foreach ($detail['episodes'] as $ep) {
            Assert::true(is_string($ep['id']));
            Assert::true(array_key_exists('status', $ep));
            Assert::true(array_key_exists('status', $ep['rights']));
        }
    }

    public function testSeriesDetailRejectsTraversalAndUnknownIds(): void
    {
        foreach (['../../etc/passwd', '..', 'no-such-series', '', null, 42, 'UPPER', 'a/b'] as $bad) {
            Assert::throws(ExplorerAdminError::class, function () use ($bad): void {
                explorer_series_detail($bad, $this->seriesDir);
            }, 'id ' . json_encode($bad));
        }
    }

    public function testResponsesNeverContainFilesystemPaths(): void
    {
        $json = json_encode([
            explorer_series_index($this->seriesDir),
            explorer_series_detail('demo-series', $this->seriesDir),
            explorer_episode_index($this->seriesDir),
        ]);
        Assert::true(!str_contains($json, __DIR__), 'no absolute path may leak');
        Assert::true(!str_contains($json, 'series.json'), 'no file names may leak');
    }

    public function testEpisodeIndexIsCompactAndKeyedBySeries(): void
    {
        $rows = explorer_episode_index($this->seriesDir);
        Assert::true(count($rows) > 0);
        foreach ($rows as $r) {
            Assert::same(['id', 's', 't', 'd', 'st'], array_keys($r));
        }
    }

    public function testStatusCountsGroupByStatus(): void
    {
        Assert::same(['approved' => 2, 'candidate' => 1, 'unknown' => 1], explorer_status_counts([
            ['status' => 'approved'], ['status' => 'approved'], ['status' => 'candidate'], ['x' => 1],
        ]));
    }
}
