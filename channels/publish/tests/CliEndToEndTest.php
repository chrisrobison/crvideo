<?php
declare(strict_types=1);

// Exercises the real channels/publish.php CLI end to end against the
// cli-demo fixture, copied into a scratch temp directory each test (so
// no test run ever touches the committed fixture or the real channels/
// tree) -- the same technique ia-import's and youtube-import's own
// CliEndToEndTest use.

final class CliEndToEndTest
{
    private string $workDir;

    public function setUp(): void
    {
        $this->workDir = sys_get_temp_dir() . '/publish-e2e-' . bin2hex(random_bytes(4));
        mkdir($this->workDir, 0775, true);
        self::copyDir(__DIR__ . '/fixtures/cli-demo', $this->workDir);
    }

    public function tearDown(): void
    {
        self::rrmdir($this->workDir);
    }

    private static function copyDir(string $src, string $dst): void
    {
        foreach (scandir($src) as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $from = "$src/$entry";
            $to = "$dst/$entry";
            if (is_dir($from)) {
                mkdir($to, 0775, true);
                self::copyDir($from, $to);
            } else {
                copy($from, $to);
            }
        }
    }

    private static function rrmdir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (glob("$dir/*") ?: [] as $f) {
            is_dir($f) ? self::rrmdir($f) : unlink($f);
        }
        @rmdir($dir);
    }

    private function runCli(array $args): array
    {
        $php = PHP_BINARY;
        $script = __DIR__ . '/../../publish.php';
        $cmd = implode(' ', array_map('escapeshellarg', array_merge([$php, $script], $args)));
        $output = [];
        $exitCode = 0;
        exec($cmd . ' 2>&1', $output, $exitCode);
        return ['output' => implode("\n", $output), 'exit' => $exitCode];
    }

    private function defaultArgs(): array
    {
        return [
            'demo-channel',
            '--channels-root=' . $this->workDir . '/channels',
            '--days=5',
            '--window-start=2026-11-02',
            '--window-timezone=America/Los_Angeles',
        ];
    }

    public function testPublishesTheApprovedEpisodesOnlyAndWritesScheduleAndMetaAtomically(): void
    {
        $schedulePath = $this->workDir . '/channels/demo-channel/schedule.json';
        $metaPath = $this->workDir . '/channels/demo-channel/meta.json';
        Assert::true(!is_file($schedulePath), 'precondition: no schedule.json yet');

        $r = $this->runCli($this->defaultArgs());
        Assert::same(0, $r['exit'], "CLI should exit 0:\n" . $r['output']);
        Assert::true(is_file($schedulePath));

        $schedule = json_decode(file_get_contents($schedulePath), true);
        Assert::same(1, $schedule['schema_version']);
        $items = array_values(array_filter($schedule['blocks'][0]['items'], static fn ($i) => $i['type'] === 'video'));
        $ids = array_map(static fn ($i) => $i['id'], $items);
        Assert::true(!in_array('ep2', $ids, true), 'the still-candidate episode must never air');
        Assert::true(in_array('ep1', $ids, true) && in_array('ep3', $ids, true));

        $meta = json_decode(file_get_contents($metaPath), true);
        Assert::same('2026-11-02T00:00:00-08:00', $meta['anchor']);
        Assert::same('Demo Channel', $meta['name'], 'meta.json\'s other fields must be preserved untouched');
        Assert::same(99, $meta['number']);
    }

    public function testDryRunWritesNothing(): void
    {
        $args = $this->defaultArgs();
        $args[] = '--dry-run';
        $r = $this->runCli($args);
        Assert::same(0, $r['exit'], $r['output']);
        Assert::true(str_contains($r['output'], 'dry run'));
        Assert::true(!is_file($this->workDir . '/channels/demo-channel/schedule.json'));
    }

    public function testRepublishingTheSameWindowIsIdempotentAsideFromTheGeneratedAtTimestamp(): void
    {
        $schedulePath = $this->workDir . '/channels/demo-channel/schedule.json';
        $this->runCli($this->defaultArgs());
        $first = json_decode(file_get_contents($schedulePath), true);
        $this->runCli($this->defaultArgs());
        $second = json_decode(file_get_contents($schedulePath), true);

        unset($first['_publish']['generated_at'], $second['_publish']['generated_at']);
        Assert::same(json_encode($first), json_encode($second));
    }

    public function testRepublishingKeepsAOneGenerationBackupOfScheduleAndMeta(): void
    {
        $this->runCli($this->defaultArgs());
        $this->runCli($this->defaultArgs());
        Assert::true(is_file($this->workDir . '/channels/demo-channel/schedule.json.bak'));
        Assert::true(is_file($this->workDir . '/channels/demo-channel/meta.json.bak'));
    }

    public function testRefreshEpisodeSetFlagIsRequiredToPickUpANewlyApprovedEpisode(): void
    {
        $schedulePath = $this->workDir . '/channels/demo-channel/schedule.json';
        $seriesPath = $this->workDir . '/series/demo-series/series.json';

        $this->runCli($this->defaultArgs()); // pins {ep1, ep3} at version 1
        $series = json_decode(file_get_contents($seriesPath), true);
        $series['episodes'][1]['status'] = 'approved'; // approve ep2 too
        file_put_contents($seriesPath, json_encode($series));

        $without = $this->runCli($this->defaultArgs());
        Assert::same(0, $without['exit'], $without['output']);
        $scheduleWithout = json_decode(file_get_contents($schedulePath), true);
        $idsWithout = array_values(array_unique(array_map(
            static fn ($i) => $i['id'],
            array_filter($scheduleWithout['blocks'][0]['items'], static fn ($i) => $i['type'] === 'video'),
        )));
        sort($idsWithout);
        Assert::same(['ep1', 'ep3'], $idsWithout, 'without --refresh-episode-set, the newly approved ep2 must not appear yet');

        $withArgs = $this->defaultArgs();
        $withArgs[] = '--refresh-episode-set';
        $with = $this->runCli($withArgs);
        Assert::same(0, $with['exit'], $with['output']);
        $scheduleWith = json_decode(file_get_contents($schedulePath), true);
        $idsWith = array_values(array_unique(array_map(
            static fn ($i) => $i['id'],
            array_filter($scheduleWith['blocks'][0]['items'], static fn ($i) => $i['type'] === 'video'),
        )));
        sort($idsWith);
        Assert::same(['ep1', 'ep2', 'ep3'], $idsWith, 'with --refresh-episode-set, ep2 is now included');
    }

    public function testMissingProgrammingJsonIsAClearErrorNotACrash(): void
    {
        unlink($this->workDir . '/channels/demo-channel/programming.json');
        $r = $this->runCli($this->defaultArgs());
        Assert::true($r['exit'] !== 0);
        Assert::true(str_contains($r['output'], 'programming.json'));
    }

    public function testHelpFlagPrintsUsageAndExitsZero(): void
    {
        $r = $this->runCli(['--help']);
        Assert::same(0, $r['exit']);
        Assert::true(str_contains($r['output'], 'Usage:'));
    }

    public function testOverlappingOccurrencesFromAMisconfiguredDurationIsAHardErrorNotACorruptSchedule(): void
    {
        $seriesPath = $this->workDir . '/series/demo-series/series.json';
        $series = json_decode(file_get_contents($seriesPath), true);
        $series['episodes'][0]['duration'] = 90000; // 25h -- longer than a day, guaranteed to overlap the next daily occurrence
        file_put_contents($seriesPath, json_encode($series));

        $r = $this->runCli($this->defaultArgs());
        Assert::true($r['exit'] !== 0, 'an overlapping schedule must never be written');
        Assert::true(str_contains($r['output'], 'overlap'));
        Assert::true(!is_file($this->workDir . '/channels/demo-channel/schedule.json'));
    }
}
