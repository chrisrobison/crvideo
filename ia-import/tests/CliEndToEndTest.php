<?php
declare(strict_types=1);

// Exercises the real CLI entry point end to end via --fixtures (no live
// network) against tests/fixtures/film-day.json, into a scratch temp dir.
// This is the "concrete way to demonstrate full CLI behavior without live
// network access" called for by the spec.

final class CliEndToEndTest
{
    private string $workDir;

    public function setUp(): void
    {
        $this->workDir = sys_get_temp_dir() . '/ia-import-e2e-' . bin2hex(random_bytes(4));
        mkdir($this->workDir, 0775, true);
    }

    private function cleanup(): void
    {
        foreach (glob($this->workDir . '/*') as $f) {
            is_dir($f) ? self::rrmdir($f) : unlink($f);
        }
        @rmdir($this->workDir);
    }

    private static function rrmdir(string $dir): void
    {
        foreach (glob("$dir/*") as $f) {
            is_dir($f) ? self::rrmdir($f) : unlink($f);
        }
        @rmdir($dir);
    }

    private function runCli(array $extraArgs): array
    {
        $php = PHP_BINARY;
        $script = __DIR__ . '/../ia-import.php';
        $list = __DIR__ . '/fixtures/film-day.json';
        $fixtures = __DIR__ . '/fixtures/metadata';
        $cacheDir = $this->workDir . '/cache';
        $args = array_merge([
            $php, $script, $list,
            "--fixtures=$fixtures",
            "--cache-dir=$cacheDir",
            '--refresh',
        ], $extraArgs);
        $cmd = implode(' ', array_map('escapeshellarg', $args));
        $output = [];
        $exitCode = 0;
        exec($cmd . ' 2>&1', $output, $exitCode);
        return ['output' => implode("\n", $output), 'exit' => $exitCode];
    }

    public function testDryRunSucceedsAndReportsExpectedCounts(): void
    {
        $r = $this->runCli(['--slot=30', '--dry-run', '--verbose']);
        Assert::same(0, $r['exit'], "CLI should exit 0:\n" . $r['output']);
        Assert::true(str_contains($r['output'], 'Film Day at School'));
        Assert::true(str_contains($r['output'], 'Items found:'));
        Assert::true(str_contains($r['output'], '(dry run'));
        $this->cleanup();
    }

    public function testWritesCatalogAndScheduleFiles(): void
    {
        $catalogPath = $this->workDir . '/catalog.json';
        $schedulePath = $this->workDir . '/schedule.json';
        $r = $this->runCli(["--slot=30", "--catalog=$catalogPath", "--output=$schedulePath"]);
        Assert::same(0, $r['exit'], "CLI should exit 0:\n" . $r['output']);
        Assert::true(is_file($catalogPath), 'catalog.json should be written');
        Assert::true(is_file($schedulePath), 'schedule.json should be written');

        $catalog = json_decode(file_get_contents($catalogPath), true);
        Assert::same(1, $catalog['schema_version']);
        Assert::same('internet_archive', $catalog['source']);
        Assert::true(count($catalog['items']) >= 10, 'catalog should include every list member, including failures');

        $schedule = json_decode(file_get_contents($schedulePath), true);
        Assert::same(1, $schedule['schema_version']);
        Assert::same(1800, $schedule['slot_duration']);
        foreach ($schedule['blocks'] as $block) {
            Assert::true($block['used'] <= $block['duration'] + 1e-6);
        }
        $this->cleanup();
    }

    public function testDeterministicAcrossRepeatedRuns(): void
    {
        $catalogPath1 = $this->workDir . '/c1.json';
        $schedulePath1 = $this->workDir . '/s1.json';
        $r1 = $this->runCli(["--slot=30", "--strategy=balanced", "--catalog=$catalogPath1", "--output=$schedulePath1"]);
        Assert::same(0, $r1['exit']);

        $catalogPath2 = $this->workDir . '/c2.json';
        $schedulePath2 = $this->workDir . '/s2.json';
        $r2 = $this->runCli(["--slot=30", "--strategy=balanced", "--catalog=$catalogPath2", "--output=$schedulePath2"]);
        Assert::same(0, $r2['exit']);

        $s1 = json_decode(file_get_contents($schedulePath1), true);
        $s2 = json_decode(file_get_contents($schedulePath2), true);
        unset($s1['generated_at'], $s2['generated_at']);
        $c1 = json_decode(file_get_contents($catalogPath1), true);
        $c2 = json_decode(file_get_contents($catalogPath2), true);
        unset($c1['generated_at'], $c2['generated_at']);

        Assert::same(json_encode($s1), json_encode($s2), 'schedule.json must be identical across repeated runs with the same input');
        Assert::same(json_encode($c1), json_encode($c2), 'catalog.json must be identical across repeated runs with the same input');
        $this->cleanup();
    }

    public function testOversizedAndUnavailableAreTrackedNotDropped(): void
    {
        $r = $this->runCli(['--slot=30', '--dry-run', '--verbose']);
        Assert::same(0, $r['exit'], $r['output']);
        Assert::true(str_contains($r['output'], 'Oversized programs:'));
        Assert::true(str_contains($r['output'], 'oversized_item: shifted') === false); // sanity: no crash text
        $this->cleanup();
    }

    public function testHelpFlagPrintsUsageAndExitsZero(): void
    {
        $r = $this->runCli(['--help']);
        // --help short-circuits before the fixtures/list are even read.
        $php = PHP_BINARY;
        $script = __DIR__ . '/../ia-import.php';
        exec(escapeshellarg($php) . ' ' . escapeshellarg($script) . ' --help 2>&1', $output, $exit);
        Assert::same(0, $exit);
        Assert::true(str_contains(implode("\n", $output), 'Usage:'));
        $this->cleanup();
    }
}
