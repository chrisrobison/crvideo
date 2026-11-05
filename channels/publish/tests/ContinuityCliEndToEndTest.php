<?php
declare(strict_types=1);

// Exercises the real channels/publish.php CLI end to end against a
// channel whose catalog.json references a continuity.json (see
// fixtures/cli-demo-continuity/), proving the full pipeline -- resolve
// continuity assets, fill every remaining gap, write schedule.json --
// actually wires together correctly, not just each piece in isolation.

final class ContinuityCliEndToEndTest
{
    private string $workDir;

    public function setUp(): void
    {
        $this->workDir = sys_get_temp_dir() . '/publish-continuity-e2e-' . bin2hex(random_bytes(4));
        mkdir($this->workDir, 0775, true);
        self::copyDir(__DIR__ . '/fixtures/cli-demo-continuity', $this->workDir);
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
        $cmd = implode(' ', array_map('escapeshellarg', array_merge([PHP_BINARY, __DIR__ . '/../../publish.php'], $args)));
        $output = [];
        $exitCode = 0;
        exec($cmd . ' 2>&1', $output, $exitCode);
        return ['output' => implode("\n", $output), 'exit' => $exitCode];
    }

    public function testAChannelReferencingContinuityJsonGetsAGapFreeScheduleWithRealContinuityOccurrences(): void
    {
        $r = $this->runCli([
            'demo-channel', '--channels-root=' . $this->workDir . '/channels',
            '--days=2', '--window-start=2026-11-02', '--window-timezone=America/Los_Angeles',
        ]);
        Assert::same(0, $r['exit'], $r['output']);

        $schedule = json_decode(file_get_contents($this->workDir . '/channels/demo-channel/schedule.json'), true);
        $items = $schedule['blocks'][0]['items'];

        Assert::true(!in_array('gap', array_map(static fn ($i) => $i['type'], $items), true), 'no plain "gap" blocks remain once continuity is configured');

        $types = array_unique(array_map(static fn ($i) => $i['type'], $items));
        sort($types);
        Assert::same(['continuity', 'video'], $types);

        $continuityItems = array_values(array_filter($items, static fn ($i) => $i['type'] === 'continuity'));
        Assert::true(count($continuityItems) > 0);
        foreach ($continuityItems as $c) {
            Assert::same('up-next', $c['template']);
            Assert::true($c['duration'] > 0);
        }

        // Station-id filler items play back as ordinary direct-media "video" items -- no player change needed for them.
        $stationIdItems = array_values(array_filter($items, static fn ($i) => ($i['continuity_category'] ?? null) === 'station_id'));
        Assert::true(count($stationIdItems) > 0, 'the approved 30s station id is actually used somewhere');

        // The whole window is covered, back to back, no overlaps, no negative durations.
        $cursor = 0;
        foreach ($items as $it) {
            Assert::same($cursor, $it['start']);
            Assert::true($it['duration'] > 0);
            $cursor += $it['duration'];
        }
        Assert::same($schedule['blocks'][0]['duration'], $cursor);
    }
}
