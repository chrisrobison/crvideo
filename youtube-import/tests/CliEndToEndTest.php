<?php
declare(strict_types=1);

// Exercises the real CLI entry point end to end via --fixtures (no live
// network), the same technique ia-import/tests/CliEndToEndTest.php uses.

final class CliEndToEndTest
{
    private string $workDir;

    public function setUp(): void
    {
        $this->workDir = sys_get_temp_dir() . '/yt-import-e2e-' . bin2hex(random_bytes(4));
        mkdir($this->workDir, 0775, true);
        putenv('YOUTUBE_API_KEY=test-key-not-real');
    }

    private function cleanup(): void
    {
        self::rrmdir($this->workDir);
        putenv('YOUTUBE_API_KEY');
    }

    private static function rrmdir(string $dir): void
    {
        foreach (glob("$dir/*") ?: [] as $f) {
            is_dir($f) ? self::rrmdir($f) : unlink($f);
        }
        @rmdir($dir);
    }

    private function runCli(array $args): array
    {
        $php = PHP_BINARY;
        $script = __DIR__ . '/../youtube-import.php';
        $cmd = implode(' ', array_map('escapeshellarg', array_merge([$php, $script], $args)));
        $output = [];
        $exitCode = 0;
        exec($cmd . ' 2>&1', $output, $exitCode);
        return ['output' => implode("\n", $output), 'exit' => $exitCode];
    }

    public function testChannelImportCreatesCandidatesWithPaginationAndShortDetection(): void
    {
        $fixtures = __DIR__ . '/fixtures/channel-import';
        $outputPath = $this->workDir . '/series.json';
        $r = $this->runCli([
            '--channel=@RealChannel', "--output=$outputPath", "--fixtures=$fixtures", '--verbose',
        ]);
        Assert::same(0, $r['exit'], "CLI should exit 0:\n" . $r['output']);
        Assert::true(str_contains($r['output'], 'Added:       3'));
        Assert::true(is_file($outputPath));

        $series = json_decode(file_get_contents($outputPath), true);
        Assert::same('Real Channel Title', $series['title']);
        Assert::same('https://example.test/channel.jpg', $series['thumbnail_url']);
        Assert::same('UCreal1', $series['source']['channel_id']);
        Assert::count(3, $series['episodes']);

        Assert::same('yt-vid1', $series['episodes'][0]['id']);
        Assert::same('candidate', $series['episodes'][0]['status']);
        Assert::same('unverified', $series['episodes'][0]['rights']['status']);
        Assert::same('upload', $series['episodes'][0]['source']['kind']);

        Assert::same('short', $series['episodes'][1]['source']['kind'], 'the 45-second video should be classified as a short');

        Assert::same('yt-vid3', $series['episodes'][2]['id'], 'pagination across two playlistItems pages must preserve order');
        Assert::same(3, $series['episodes'][2]['episode_number']);
        $this->cleanup();
    }

    public function testDryRunWritesNothing(): void
    {
        $fixtures = __DIR__ . '/fixtures/channel-import';
        $outputPath = $this->workDir . '/series.json';
        $r = $this->runCli([
            '--channel=@RealChannel', "--output=$outputPath", "--fixtures=$fixtures", '--dry-run',
        ]);
        Assert::same(0, $r['exit'], $r['output']);
        Assert::true(str_contains($r['output'], 'dry run'));
        Assert::true(!is_file($outputPath), 'dry-run must not write the output file');
        $this->cleanup();
    }

    public function testPlaylistImportDistinguishesActiveLiveStreamDurationFromZero(): void
    {
        $fixtures = __DIR__ . '/fixtures/playlist-import';
        $outputPath = $this->workDir . '/series.json';
        $r = $this->runCli([
            '--playlist=PLsomething', "--output=$outputPath", "--fixtures=$fixtures",
        ]);
        Assert::same(0, $r['exit'], $r['output']);

        $series = json_decode(file_get_contents($outputPath), true);
        Assert::same('My Playlist', $series['title']);
        Assert::same('PLsomething', $series['source']['playlist_id']);

        $byId = [];
        foreach ($series['episodes'] as $ep) {
            $byId[$ep['id']] = $ep;
        }
        Assert::same(300.0, (float) $byId['yt-pvid1']['duration']); // JSON round-trips a whole-number float as an int
        Assert::same('live_active', $byId['yt-pvid2']['source']['kind']);
        Assert::null($byId['yt-pvid2']['duration'], 'an in-progress live stream must never be recorded as a zero-length episode');
        $this->cleanup();
    }

    public function testRefreshPreservesEditorialFieldsAppendsNewMarksUnavailableAndKeepsBackup(): void
    {
        $outputPath = $this->workDir . '/series.json';
        $preExisting = [
            'schema_version' => 1, 'id' => 'refresh-series', 'title' => 'Refresh Series', 'description' => 'd',
            'creator' => null, 'year' => null, 'thumbnail_url' => null, 'logo_url' => null,
            'source' => ['provider' => 'youtube', 'channel_id' => 'UCref', 'channel_url' => 'https://www.youtube.com/channel/UCref', 'playlist_id' => null],
            'rotation' => ['mode' => 'sequential', 'loop' => true],
            'episodes' => [
                [
                    'id' => 'yt-r1', 'episode_number' => 1,
                    'title' => 'Editor Renamed This', 'description' => 'Editor also rewrote this description.',
                    'duration' => 100.0, 'year' => 2023, 'published_at' => '2023-01-01T00:00:00Z', 'thumbnail_url' => 'old1.jpg',
                    'guests' => ['Guest A'], 'status' => 'approved', 'rights' => ['status' => 'cleared', 'notes' => 'Approved by editor'],
                    'source' => ['provider' => 'youtube', 'video_id' => 'r1', 'url' => 'https://www.youtube.com/watch?v=r1',
                        'channel_id' => 'UCref', 'channel_title' => 'Channel', 'kind' => 'upload', 'embeddable' => true,
                        'made_for_kids' => false, 'privacy_status' => 'public', 'availability' => 'available', 'availability_detail' => null],
                ],
                [
                    'id' => 'yt-r2', 'episode_number' => 2, 'title' => 'R2 Title', 'description' => 'R2 desc',
                    'duration' => 200.0, 'year' => 2023, 'published_at' => '2023-01-02T00:00:00Z', 'thumbnail_url' => 'old2.jpg',
                    'guests' => [], 'status' => 'candidate', 'rights' => ['status' => 'unverified', 'notes' => null],
                    'source' => ['provider' => 'youtube', 'video_id' => 'r2', 'url' => 'https://www.youtube.com/watch?v=r2',
                        'channel_id' => 'UCref', 'channel_title' => 'Channel', 'kind' => 'upload', 'embeddable' => true,
                        'made_for_kids' => false, 'privacy_status' => 'public', 'availability' => 'available', 'availability_detail' => null],
                ],
            ],
        ];
        file_put_contents($outputPath, json_encode($preExisting, JSON_PRETTY_PRINT));

        $fixtures = __DIR__ . '/fixtures/refresh';
        $r = $this->runCli([
            '--channel-id=UCref', "--output=$outputPath", "--fixtures=$fixtures", '--verbose',
        ]);
        Assert::same(0, $r['exit'], "CLI should exit 0:\n" . $r['output']);
        Assert::true(str_contains($r['output'], 'Added:       1'));
        Assert::true(str_contains($r['output'], 'Unavailable: 1'));

        Assert::true(is_file($outputPath . '.bak'), 'the pre-existing file must be preserved as a .bak');
        $backup = json_decode(file_get_contents($outputPath . '.bak'), true);
        Assert::same('Editor Renamed This', $backup['episodes'][0]['title'], 'the backup should hold exactly the pre-refresh content');

        $series = json_decode(file_get_contents($outputPath), true);
        Assert::count(3, $series['episodes'], 'r1 and r2 stay (one now unavailable), plus the new r3');

        $byId = [];
        foreach ($series['episodes'] as $ep) {
            $byId[$ep['id']] = $ep;
        }

        // r1: editorial fields untouched, YouTube-sourced fields refreshed.
        Assert::same('Editor Renamed This', $byId['yt-r1']['title']);
        Assert::same('Editor also rewrote this description.', $byId['yt-r1']['description']);
        Assert::same(['Guest A'], $byId['yt-r1']['guests']);
        Assert::same('approved', $byId['yt-r1']['status']);
        Assert::same('cleared', $byId['yt-r1']['rights']['status']);
        Assert::same(100.0, (float) $byId['yt-r1']['duration'], 'PT1M40S from the refreshed fixture');
        Assert::same('new1.jpg', $byId['yt-r1']['thumbnail_url'], 'thumbnail is YouTube-sourced and should refresh');

        // r2: no longer resolves -- marked unavailable in place, never removed, editorial status untouched.
        Assert::same('unavailable', $byId['yt-r2']['source']['availability']);
        Assert::same('candidate', $byId['yt-r2']['status']);
        Assert::same(2, $byId['yt-r2']['episode_number'], 'episode_number is never renumbered');

        // r3: brand new candidate, numbered after the existing max.
        Assert::same('candidate', $byId['yt-r3']['status']);
        Assert::same(3, $byId['yt-r3']['episode_number']);
        Assert::same('Brand New Upload', $byId['yt-r3']['title']);

        $this->cleanup();
    }

    public function testMissingCredentialsProduceAClearErrorNotACrash(): void
    {
        putenv('YOUTUBE_API_KEY'); // unset for this one test
        $r = $this->runCli([
            '--channel=@RealChannel', "--output={$this->workDir}/series.json",
            "--fixtures=" . __DIR__ . '/fixtures/channel-import',
            '--config=' . $this->workDir . '/no-such-config.php',
        ]);
        Assert::true($r['exit'] !== 0);
        Assert::true(str_contains($r['output'], 'YOUTUBE_API_KEY'));
        $this->cleanup();
    }

    public function testHelpFlagPrintsUsageAndExitsZero(): void
    {
        $r = $this->runCli(['--help']);
        Assert::same(0, $r['exit']);
        Assert::true(str_contains($r['output'], 'Usage:'));
        $this->cleanup();
    }

    public function testRejectsWhenMoreThanOneSourceIsGiven(): void
    {
        $r = $this->runCli(['--channel=@A', '--playlist=PL1', '--output=' . $this->workDir . '/s.json']);
        Assert::true($r['exit'] !== 0);
        Assert::true(str_contains($r['output'], 'exactly one of'));
        $this->cleanup();
    }
}
