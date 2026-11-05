<?php
declare(strict_types=1);

final class IaSeriesImportCliEndToEndTest
{
    private string $tmpDir;

    public function setUp(): void
    {
        $this->tmpDir = sys_get_temp_dir() . '/ia-series-import-test-' . bin2hex(random_bytes(4));
        mkdir($this->tmpDir, 0775, true);
    }

    public function tearDown(): void
    {
        foreach (glob($this->tmpDir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->tmpDir);
    }

    private function run(array $args): array
    {
        $php = PHP_BINARY;
        $script = __DIR__ . '/../ia-series-import.php';
        $cmd = array_merge([$php, $script], $args);
        $escaped = implode(' ', array_map('escapeshellarg', $cmd));
        $output = [];
        $exitCode = 0;
        exec($escaped . ' 2>&1', $output, $exitCode);
        return ['output' => implode("\n", $output), 'exit' => $exitCode];
    }

    public function testCollectionDiscoveryFetchesAndWritesACandidateSeries(): void
    {
        $outputPath = $this->tmpDir . '/series.json';
        $cacheDir = $this->tmpDir . '/cache';
        $result = $this->run([
            '--collection=prelinger',
            "--output=$outputPath",
            "--cache-dir=$cacheDir",
            '--fixtures=' . __DIR__ . '/fixtures/series-import',
            '--title=Test Prelinger Series',
        ]);
        Assert::same(0, $result['exit'], "CLI must exit 0; output:\n{$result['output']}");
        Assert::true(is_file($outputPath), 'series.json must be written');

        $series = json_decode((string) file_get_contents($outputPath), true);
        Assert::same('Test Prelinger Series', $series['title']);
        Assert::same('internet_archive', $series['source']['provider']);
        Assert::count(2, $series['episodes']);
        foreach ($series['episodes'] as $ep) {
            Assert::same('candidate', $ep['status']);
            Assert::same('unverified', $ep['rights']['status']);
            Assert::same('html5', $ep['source']['provider']);
        }
    }

    public function testDryRunWritesNothing(): void
    {
        $outputPath = $this->tmpDir . '/series-dry.json';
        $result = $this->run([
            '--collection=prelinger',
            "--output=$outputPath",
            "--cache-dir={$this->tmpDir}/cache2",
            '--fixtures=' . __DIR__ . '/fixtures/series-import',
            '--dry-run',
        ]);
        Assert::same(0, $result['exit']);
        Assert::true(!is_file($outputPath), '--dry-run must never write the output file');
        Assert::true(str_contains($result['output'], 'dry run'), 'summary must say it was a dry run');
    }

    public function testRunningTwiceIsIdempotentAndReportsUnchanged(): void
    {
        $outputPath = $this->tmpDir . '/series-twice.json';
        $cacheDir = $this->tmpDir . '/cache3';
        $first = $this->run([
            '--collection=prelinger', "--output=$outputPath", "--cache-dir=$cacheDir",
            '--fixtures=' . __DIR__ . '/fixtures/series-import',
        ]);
        Assert::same(0, $first['exit']);
        $firstContent = file_get_contents($outputPath);

        $second = $this->run([
            '--collection=prelinger', "--output=$outputPath", "--cache-dir=$cacheDir",
            '--fixtures=' . __DIR__ . '/fixtures/series-import', '--refresh', '--verbose',
        ]);
        Assert::same(0, $second['exit']);
        Assert::true(str_contains($second['output'], 'Added:       0'), 'a second run must add zero new episodes');
        Assert::same($firstContent, file_get_contents($outputPath), 'episode content must be stable across repeated runs');
    }

    public function testExplicitIdentifiersModeSkipsDiscoveryEntirely(): void
    {
        $outputPath = $this->tmpDir . '/series-explicit.json';
        $result = $this->run([
            '--identifiers=0771_Duck_and_Cover_12_33_20_12',
            "--output=$outputPath",
            "--cache-dir={$this->tmpDir}/cache4",
            '--fixtures=' . __DIR__ . '/fixtures/series-import',
        ]);
        Assert::same(0, $result['exit']);
        $series = json_decode((string) file_get_contents($outputPath), true);
        Assert::count(1, $series['episodes']);
        Assert::same('ia-0771_Duck_and_Cover_12_33_20_12', $series['episodes'][0]['id']);
    }

    public function testMissingDiscoveryModeIsAHardErrorNotASilentNoOp(): void
    {
        $result = $this->run(['--output=' . $this->tmpDir . '/x.json']);
        Assert::same(1, $result['exit']);
        Assert::true(str_contains($result['output'], 'Error'));
    }
}
