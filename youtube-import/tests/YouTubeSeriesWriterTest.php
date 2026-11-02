<?php
declare(strict_types=1);

final class YouTubeSeriesWriterTest
{
    private string $dir;

    public function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/yt-import-writer-test-' . bin2hex(random_bytes(4));
        mkdir($this->dir, 0775, true);
    }

    private function cleanup(): void
    {
        foreach (glob($this->dir . '/*') as $f) {
            unlink($f);
        }
        rmdir($this->dir);
    }

    public function testReadReturnsNullWhenFileDoesNotExist(): void
    {
        Assert::null(YouTubeSeriesWriter::read($this->dir . '/nope.json'));
        $this->cleanup();
    }

    public function testWriteThenReadRoundTrips(): void
    {
        $path = $this->dir . '/series.json';
        YouTubeSeriesWriter::write($path, ['id' => 'x', 'episodes' => []]);
        $read = YouTubeSeriesWriter::read($path);
        Assert::same('x', $read['id']);
        $this->cleanup();
    }

    public function testSecondWriteKeepsThePriorVersionAsBak(): void
    {
        $path = $this->dir . '/series.json';
        YouTubeSeriesWriter::write($path, ['id' => 'x', 'version' => 1]);
        YouTubeSeriesWriter::write($path, ['id' => 'x', 'version' => 2]);

        $current = json_decode(file_get_contents($path), true);
        $backup = json_decode(file_get_contents($path . '.bak'), true);
        Assert::same(2, $current['version']);
        Assert::same(1, $backup['version'], 'the .bak must hold the version right before the latest write');
        $this->cleanup();
    }

    public function testBackupIsOverwrittenEachRunNotAccumulated(): void
    {
        $path = $this->dir . '/series.json';
        YouTubeSeriesWriter::write($path, ['version' => 1]);
        YouTubeSeriesWriter::write($path, ['version' => 2]);
        YouTubeSeriesWriter::write($path, ['version' => 3]);

        $backup = json_decode(file_get_contents($path . '.bak'), true);
        Assert::same(2, $backup['version'], 'only one backup generation is kept, matching the version just before the latest write');
        Assert::count(2, glob($this->dir . '/*'), 'exactly series.json and series.json.bak should exist, no accumulation of old versions');
        $this->cleanup();
    }

    public function testNoTempFilesAreLeftBehind(): void
    {
        $path = $this->dir . '/series.json';
        YouTubeSeriesWriter::write($path, ['id' => 'x']);
        $leftovers = glob($this->dir . '/*.tmp');
        Assert::count(0, $leftovers);
        $this->cleanup();
    }
}
