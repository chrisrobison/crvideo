<?php
declare(strict_types=1);

final class YouTubeVideoClassifierTest
{
    private function video(array $overrides = []): array
    {
        $base = [
            'snippet' => [
                'title' => 'A Video',
                'description' => 'Description',
                'publishedAt' => '2024-03-15T12:00:00Z',
                'channelId' => 'UCabc',
                'channelTitle' => 'Some Channel',
                'liveBroadcastContent' => 'none',
                'thumbnails' => ['high' => ['url' => 'https://example.test/hi.jpg']],
            ],
            'contentDetails' => ['duration' => 'PT10M30S'],
            'status' => ['privacyStatus' => 'public', 'embeddable' => true, 'madeForKids' => false, 'uploadStatus' => 'processed'],
        ];
        return array_replace_recursive($base, $overrides);
    }

    public function testOrdinaryUploadIsClassifiedAsUpload(): void
    {
        $c = YouTubeVideoClassifier::classify($this->video());
        Assert::same('upload', $c['kind']);
        Assert::same(630.0, $c['duration']);
        Assert::same(false, $c['duration_is_provisional']);
    }

    public function testShortDurationVideoIsHeuristicallyAShort(): void
    {
        $c = YouTubeVideoClassifier::classify($this->video(['contentDetails' => ['duration' => 'PT38S']]));
        Assert::same('short', $c['kind']);
        Assert::same(38.0, $c['duration']);
    }

    public function testUpcomingLiveStreamDurationIsNullNotZero(): void
    {
        $raw = $this->video([
            'snippet' => ['liveBroadcastContent' => 'upcoming'],
            'contentDetails' => ['duration' => 'P0D'],
            'liveStreamingDetails' => ['scheduledStartTime' => '2030-01-01T00:00:00Z'],
        ]);
        $c = YouTubeVideoClassifier::classify($raw);
        Assert::same('live_upcoming', $c['kind']);
        Assert::null($c['duration']);
        Assert::true($c['duration_is_provisional']);
    }

    public function testActiveLiveStreamDurationIsNullNotZero(): void
    {
        // This is the case the spec calls out explicitly: YouTube reports
        // "P0D" (which parses to 0) while a stream is in progress. 0 must
        // never be mistaken for "a zero-length video."
        $raw = $this->video([
            'snippet' => ['liveBroadcastContent' => 'live'],
            'contentDetails' => ['duration' => 'P0D'],
            'liveStreamingDetails' => ['actualStartTime' => '2024-03-15T12:00:00Z'],
        ]);
        $c = YouTubeVideoClassifier::classify($raw);
        Assert::same('live_active', $c['kind']);
        Assert::null($c['duration']);
        Assert::true($c['duration_is_provisional']);
    }

    public function testEndedLiveStreamUsesBackfilledDurationWhenPresent(): void
    {
        $raw = $this->video([
            'snippet' => ['liveBroadcastContent' => 'none'],
            'contentDetails' => ['duration' => 'PT45M0S'],
            'liveStreamingDetails' => [
                'actualStartTime' => '2024-03-15T12:00:00Z',
                'actualEndTime' => '2024-03-15T12:45:00Z',
            ],
        ]);
        $c = YouTubeVideoClassifier::classify($raw);
        Assert::same('live_vod', $c['kind']);
        Assert::same(2700.0, $c['duration']);
        Assert::same(false, $c['duration_is_provisional']);
    }

    public function testEndedLiveStreamDerivesDurationFromTimestampsIfContentDetailsStillZero(): void
    {
        $raw = $this->video([
            'snippet' => ['liveBroadcastContent' => 'none'],
            'contentDetails' => ['duration' => 'P0D'], // not yet backfilled by YouTube
            'liveStreamingDetails' => [
                'actualStartTime' => '2024-03-15T12:00:00Z',
                'actualEndTime' => '2024-03-15T12:10:00Z',
            ],
        ]);
        $c = YouTubeVideoClassifier::classify($raw);
        Assert::same('live_vod', $c['kind']);
        Assert::same(600.0, $c['duration']);
        Assert::true($c['duration_is_provisional']); // derived, flagged as such
    }

    public function testRejectedUploadIsRestrictedWithDetail(): void
    {
        $raw = $this->video(['status' => ['uploadStatus' => 'rejected', 'rejectionReason' => 'copyright']]);
        $c = YouTubeVideoClassifier::classify($raw);
        Assert::same('restricted', $c['availability_signal']);
        Assert::true(str_contains((string) $c['availability_detail'], 'copyright'));
    }

    public function testRegionRestrictedVideoIsFlagged(): void
    {
        $raw = $this->video(['contentDetails' => ['regionRestriction' => ['blocked' => ['XX']]]]);
        $c = YouTubeVideoClassifier::classify($raw);
        Assert::same('restricted', $c['availability_signal']);
    }

    public function testPrivacyEmbeddableAndMadeForKidsAreSurfaced(): void
    {
        $raw = $this->video(['status' => ['privacyStatus' => 'unlisted', 'embeddable' => false, 'madeForKids' => true]]);
        $c = YouTubeVideoClassifier::classify($raw);
        Assert::same('unlisted', $c['privacy_status']);
        Assert::same(false, $c['embeddable']);
        Assert::same(true, $c['made_for_kids']);
    }

    public function testMissingDurationIsNullNeverZero(): void
    {
        $raw = $this->video(['contentDetails' => ['duration' => null]]);
        unset($raw['contentDetails']['duration']);
        $c = YouTubeVideoClassifier::classify($raw);
        Assert::null($c['duration']);
    }
}
