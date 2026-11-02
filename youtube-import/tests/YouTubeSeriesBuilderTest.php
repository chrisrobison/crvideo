<?php
declare(strict_types=1);

final class YouTubeSeriesBuilderTest
{
    private function rawVideo(string $id, array $overrides = []): array
    {
        $base = [
            'id' => $id,
            'snippet' => [
                'title' => "Title $id", 'description' => "Description $id",
                'publishedAt' => '2024-01-10T00:00:00Z', 'channelId' => 'UCabc', 'channelTitle' => 'Channel',
                'liveBroadcastContent' => 'none', 'thumbnails' => ['high' => ['url' => "https://example.test/$id.jpg"]],
            ],
            'contentDetails' => ['duration' => 'PT10M0S'],
            'status' => ['privacyStatus' => 'public', 'embeddable' => true, 'madeForKids' => false, 'uploadStatus' => 'processed'],
        ];
        return array_replace_recursive($base, $overrides);
    }

    private function seriesDefaults(): array
    {
        return [
            'schema_version' => 1, 'id' => 'my-series', 'title' => 'My Series', 'description' => 'Desc',
            'creator' => null, 'year' => null, 'thumbnail_url' => null, 'logo_url' => null,
            'source' => ['provider' => 'youtube', 'channel_id' => 'UCabc', 'channel_url' => 'https://www.youtube.com/channel/UCabc', 'playlist_id' => null],
            'rotation' => ['mode' => 'sequential', 'loop' => true], 'episodes' => [],
        ];
    }

    public function testFreshImportCreatesCandidatesInDiscoveryOrderWithSequentialEpisodeNumbers(): void
    {
        $videosById = ['v1' => $this->rawVideo('v1'), 'v2' => $this->rawVideo('v2')];
        $result = YouTubeSeriesBuilder::build(null, $this->seriesDefaults(), ['v1', 'v2'], $videosById, ['provider' => 'youtube', 'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'playlist_id' => null]);

        $episodes = $result['series']['episodes'];
        Assert::count(2, $episodes);
        Assert::same('yt-v1', $episodes[0]['id']);
        Assert::same(1, $episodes[0]['episode_number']);
        Assert::same('yt-v2', $episodes[1]['id']);
        Assert::same(2, $episodes[1]['episode_number']);
        Assert::same('candidate', $episodes[0]['status']);
        Assert::same('unverified', $episodes[0]['rights']['status']);
        Assert::same(['yt-v1', 'yt-v2'], $result['summary']['added']);
    }

    public function testRefreshUpdatesYoutubeSourcedFieldsWithoutTouchingEditorialFields(): void
    {
        $existing = $this->seriesDefaults();
        $existing['episodes'] = [[
            'id' => 'yt-v1', 'episode_number' => 1,
            'title' => 'Hand-edited title', 'description' => 'Hand-edited description',
            'duration' => 100.0, 'year' => 2020, 'published_at' => '2020-01-01T00:00:00Z', 'thumbnail_url' => 'old.jpg',
            'guests' => ['Alice'], 'status' => 'approved', 'rights' => ['status' => 'cleared', 'notes' => 'ok to air'],
            'source' => ['provider' => 'youtube', 'video_id' => 'v1', 'url' => 'https://www.youtube.com/watch?v=v1',
                'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'kind' => 'upload', 'embeddable' => true,
                'made_for_kids' => false, 'privacy_status' => 'public', 'availability' => 'available', 'availability_detail' => null],
        ]];

        // YouTube now reports a longer duration and a new thumbnail for v1.
        $fresh = $this->rawVideo('v1', ['contentDetails' => ['duration' => 'PT20M0S'], 'snippet' => ['title' => 'A YouTube-side title change', 'thumbnails' => ['high' => ['url' => 'new.jpg']]]]);
        $result = YouTubeSeriesBuilder::build($existing, $this->seriesDefaults(), ['v1'], ['v1' => $fresh], ['provider' => 'youtube', 'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'playlist_id' => null]);

        $ep = $result['series']['episodes'][0];
        // Editorial fields: untouched.
        Assert::same('Hand-edited title', $ep['title']);
        Assert::same('Hand-edited description', $ep['description']);
        Assert::same(['Alice'], $ep['guests']);
        Assert::same('approved', $ep['status']);
        Assert::same('cleared', $ep['rights']['status']);
        Assert::same('ok to air', $ep['rights']['notes']);
        Assert::same(1, $ep['episode_number']);
        // YouTube-sourced fields: refreshed.
        Assert::same(1200.0, $ep['duration']);
        Assert::same('new.jpg', $ep['thumbnail_url']);
        Assert::contains('yt-v1', $result['summary']['updated']);
    }

    public function testUnmatchedVideoIsAppendedAsNewCandidateAlongsideExistingEpisodes(): void
    {
        $existing = $this->seriesDefaults();
        $existing['episodes'] = [[
            'id' => 'yt-v1', 'episode_number' => 1, 'title' => 'T1', 'description' => '', 'duration' => 100.0,
            'year' => 2020, 'published_at' => null, 'thumbnail_url' => null, 'guests' => [], 'status' => 'approved',
            'rights' => ['status' => 'cleared', 'notes' => null],
            'source' => ['provider' => 'youtube', 'video_id' => 'v1', 'url' => 'https://www.youtube.com/watch?v=v1',
                'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'kind' => 'upload', 'embeddable' => true,
                'made_for_kids' => false, 'privacy_status' => 'public', 'availability' => 'available', 'availability_detail' => null],
        ]];
        $videosById = ['v1' => $this->rawVideo('v1'), 'v2' => $this->rawVideo('v2')];
        $result = YouTubeSeriesBuilder::build($existing, $this->seriesDefaults(), ['v1', 'v2'], $videosById, ['provider' => 'youtube', 'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'playlist_id' => null]);

        Assert::count(2, $result['series']['episodes']);
        Assert::same('approved', $result['series']['episodes'][0]['status'], 'the pre-existing episode must keep its approval');
        Assert::same('yt-v2', $result['series']['episodes'][1]['id']);
        Assert::same('candidate', $result['series']['episodes'][1]['status']);
        Assert::same(2, $result['series']['episodes'][1]['episode_number'], 'new episode numbers continue from the existing max, never renumbering');
        Assert::same(['yt-v2'], $result['summary']['added']);
    }

    public function testMissingVideoIsMarkedUnavailableInPlaceNotRemoved(): void
    {
        $existing = $this->seriesDefaults();
        $existing['episodes'] = [[
            'id' => 'yt-v1', 'episode_number' => 1, 'title' => 'T1', 'description' => '', 'duration' => 100.0,
            'year' => 2020, 'published_at' => null, 'thumbnail_url' => null, 'guests' => [], 'status' => 'approved',
            'rights' => ['status' => 'cleared', 'notes' => null],
            'source' => ['provider' => 'youtube', 'video_id' => 'v1', 'url' => 'https://www.youtube.com/watch?v=v1',
                'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'kind' => 'upload', 'embeddable' => true,
                'made_for_kids' => false, 'privacy_status' => 'public', 'availability' => 'available', 'availability_detail' => null],
        ]];
        // v1 was checked this run (its id is a key in videosById) but YouTube returned nothing for it.
        $result = YouTubeSeriesBuilder::build($existing, $this->seriesDefaults(), [], ['v1' => null], ['provider' => 'youtube', 'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'playlist_id' => null]);

        Assert::count(1, $result['series']['episodes'], 'the episode must still be present, not deleted');
        Assert::same('yt-v1', $result['series']['episodes'][0]['id']);
        Assert::same('approved', $result['series']['episodes'][0]['status'], 'status (editorial) must not be touched either');
        Assert::same('unavailable', $result['series']['episodes'][0]['source']['availability']);
        Assert::contains('yt-v1', $result['summary']['unavailable']);
    }

    public function testUncheckedExistingEpisodeIsCarriedForwardUnchanged(): void
    {
        $existing = $this->seriesDefaults();
        $existing['episodes'] = [[
            'id' => 'yt-v1', 'episode_number' => 1, 'title' => 'T1', 'description' => '', 'duration' => 100.0,
            'year' => 2020, 'published_at' => null, 'thumbnail_url' => null, 'guests' => [], 'status' => 'approved',
            'rights' => ['status' => 'cleared', 'notes' => null],
            'source' => ['provider' => 'youtube', 'video_id' => 'v1', 'url' => 'https://www.youtube.com/watch?v=v1',
                'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'kind' => 'upload', 'embeddable' => true,
                'made_for_kids' => false, 'privacy_status' => 'public', 'availability' => 'unavailable', 'availability_detail' => 'x'],
        ]];
        // v1 is NOT a key in videosById at all -- simulates the CLI's quota-saving skip of
        // an already-unavailable episode when --refresh wasn't passed.
        $result = YouTubeSeriesBuilder::build($existing, $this->seriesDefaults(), [], [], ['provider' => 'youtube', 'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'playlist_id' => null]);

        Assert::same($existing['episodes'][0], $result['series']['episodes'][0], 'an episode never checked this run must be byte-for-byte unchanged');
        Assert::true(!in_array('yt-v1', $result['summary']['updated'], true));
        Assert::true(!in_array('yt-v1', $result['summary']['unavailable'], true));
    }

    public function testShowLevelFieldsAreFilledOnlyWhenNull(): void
    {
        $existing = $this->seriesDefaults();
        $existing['title'] = 'Hand-written show title';
        $existing['thumbnail_url'] = null; // not yet filled in
        $existing['source']['channel_id'] = null; // placeholder, per phase 1

        $defaults = $this->seriesDefaults();
        $defaults['title'] = 'Fetched Channel Title';
        $defaults['thumbnail_url'] = 'https://example.test/channel.jpg';
        $defaults['source']['channel_id'] = 'UCreal';

        $result = YouTubeSeriesBuilder::build($existing, $defaults, [], [], ['provider' => 'youtube', 'channel_id' => 'UCreal', 'channel_title' => 'Channel', 'playlist_id' => null]);

        Assert::same('Hand-written show title', $result['series']['title'], 'an already-set title must never be overwritten');
        Assert::same('https://example.test/channel.jpg', $result['series']['thumbnail_url'], 'a null field should be filled in');
        Assert::same('UCreal', $result['series']['source']['channel_id'], 'a null channel_id placeholder should be filled in');
    }

    public function testPlaceholderNoteIsDroppedOnceARealEpisodeExists(): void
    {
        $existing = $this->seriesDefaults();
        $existing['_note'] = 'STRUCTURAL PLACEHOLDER. No real episodes yet.';
        $videosById = ['v1' => $this->rawVideo('v1')];
        $result = YouTubeSeriesBuilder::build($existing, $this->seriesDefaults(), ['v1'], $videosById, ['provider' => 'youtube', 'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'playlist_id' => null]);
        Assert::true(!array_key_exists('_note', $result['series']));
    }

    public function testDuplicateVideoIdInExistingFileIsWarnedNotCrashed(): void
    {
        $existing = $this->seriesDefaults();
        $makeEp = fn (string $title) => [
            'id' => 'yt-v1', 'episode_number' => 1, 'title' => $title, 'description' => '', 'duration' => 100.0,
            'year' => null, 'published_at' => null, 'thumbnail_url' => null, 'guests' => [], 'status' => 'candidate',
            'rights' => ['status' => 'unverified', 'notes' => null],
            'source' => ['provider' => 'youtube', 'video_id' => 'v1', 'url' => 'https://www.youtube.com/watch?v=v1',
                'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'kind' => 'upload', 'embeddable' => true,
                'made_for_kids' => false, 'privacy_status' => 'public', 'availability' => 'available', 'availability_detail' => null],
        ];
        $existing['episodes'] = [$makeEp('first'), $makeEp('second')];
        $result = YouTubeSeriesBuilder::build($existing, $this->seriesDefaults(), [], [], ['provider' => 'youtube', 'channel_id' => 'UCabc', 'channel_title' => 'Channel', 'playlist_id' => null]);
        Assert::true(count($result['summary']['warnings']) >= 1);
        Assert::count(2, $result['series']['episodes'], 'neither duplicate is dropped -- just not both treated as the update target');
    }
}
