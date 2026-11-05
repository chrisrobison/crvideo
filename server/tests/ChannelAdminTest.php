<?php
declare(strict_types=1);

final class ChannelAdminTest
{
    private string $workDir;
    private string $channelsDir;
    private string $seriesDir;

    public function setUp(): void
    {
        $this->workDir = sys_get_temp_dir() . '/channel-admin-test-' . bin2hex(random_bytes(4));
        self::copyDir(__DIR__ . '/fixtures/repo/channels', "$this->workDir/channels");
        self::copyDir(__DIR__ . '/fixtures/repo/series', "$this->workDir/series");
        $this->channelsDir = "$this->workDir/channels";
        $this->seriesDir = "$this->workDir/series";
    }

    public function tearDown(): void
    {
        self::rrmdir($this->workDir);
    }

    private static function copyDir(string $src, string $dst): void
    {
        mkdir($dst, 0775, true);
        foreach (scandir($src) as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $from = "$src/$entry";
            $to = "$dst/$entry";
            if (is_dir($from)) {
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

    // ---------- listing ----------

    public function testListReturnsEveryFixtureChannelWithResolvedSeriesRefs(): void
    {
        $list = channel_admin_list($this->channelsDir, $this->seriesDir);
        $byId = [];
        foreach ($list as $c) {
            $byId[$c['id']] = $c;
        }
        Assert::true(isset($byId['demo-channel']));
        Assert::same('demo-series', $byId['demo-channel']['series_refs'][0]['series_id']);
        Assert::true($byId['demo-channel']['series_refs'][0]['known']);
        Assert::true($byId['demo-channel']['has_programming']);
        Assert::true(!$byId['no-programming-channel']['has_programming']);
    }

    // ---------- save_catalog ----------

    public function testSaveCatalogWritesTheConventionalRelativeRefShape(): void
    {
        $result = channel_admin_save_catalog(['channel_id' => 'demo-channel', 'series_ids' => ['demo-series', 'playlist-series']], $this->channelsDir, $this->seriesDir);
        Assert::same(['demo-series', 'playlist-series'], $result['series_ids']);

        $catalog = json_decode(file_get_contents("$this->channelsDir/demo-channel/catalog.json"), true);
        Assert::same(['ref' => '../../series/demo-series/series.json'], $catalog['series'][0]);
        Assert::same(['ref' => '../../series/playlist-series/series.json'], $catalog['series'][1]);
        // "items" and other pre-existing fields must survive untouched.
        Assert::true(array_key_exists('items', $catalog));
    }

    public function testSaveCatalogKeepsAnAtomicBackup(): void
    {
        channel_admin_save_catalog(['channel_id' => 'demo-channel', 'series_ids' => ['demo-series']], $this->channelsDir, $this->seriesDir);
        Assert::true(is_file("$this->channelsDir/demo-channel/catalog.json.bak"));
    }

    public function testSaveCatalogRejectsAnUnknownSeriesId(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_catalog(['channel_id' => 'demo-channel', 'series_ids' => ['no-such-series']], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveCatalogRejectsPathTraversalAsASeriesId(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_catalog(['channel_id' => 'demo-channel', 'series_ids' => ['../../../etc/passwd']], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveCatalogRejectsADuplicateSeriesId(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_catalog(['channel_id' => 'demo-channel', 'series_ids' => ['demo-series', 'demo-series']], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveCatalogRejectsAnUnknownChannelId(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_catalog(['channel_id' => 'no-such-channel', 'series_ids' => ['demo-series']], $this->channelsDir, $this->seriesDir);
        });
    }

    // ---------- save_programming / block validation ----------

    private function validBlock(array $overrides = []): array
    {
        return array_replace([
            'id' => 'daily-hour', 'type' => 'series', 'series_id' => 'demo-series',
            'recurrence' => ['frequency' => 'daily', 'time' => '13:00', 'timezone' => 'America/Los_Angeles'],
            'duration' => 1800,
            'rotation' => ['mode' => 'sequential', 'loop' => true, 'anchor_date' => '2026-11-02'],
        ], $overrides);
    }

    public function testSaveProgrammingAcceptsAValidDailyBlock(): void
    {
        $result = channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock()]], $this->channelsDir, $this->seriesDir);
        Assert::count(1, $result['blocks']);
        $written = json_decode(file_get_contents("$this->channelsDir/demo-channel/programming.json"), true);
        Assert::same('daily-hour', $written['blocks'][0]['id']);
    }

    public function testSaveProgrammingAcceptsAValidWeeklyBlock(): void
    {
        $block = $this->validBlock(['id' => 'weekly', 'recurrence' => ['frequency' => 'weekly', 'weekday' => 'saturday', 'time' => '10:00', 'timezone' => 'UTC']]);
        $result = channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$block]], $this->channelsDir, $this->seriesDir);
        Assert::count(1, $result['blocks']);
    }

    public function testSaveProgrammingAcceptsAValidMonthlyBlock(): void
    {
        $block = $this->validBlock(['id' => 'monthly', 'recurrence' => ['frequency' => 'monthly', 'day_of_month' => 1, 'time' => '09:00', 'timezone' => 'UTC']]);
        $result = channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$block]], $this->channelsDir, $this->seriesDir);
        Assert::count(1, $result['blocks']);
    }

    public function testSaveProgrammingRejectsAnUnknownSeriesId(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(['series_id' => 'no-such-series'])]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingRejectsNonSequentialRotationMode(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(['rotation' => ['mode' => 'random', 'loop' => true, 'anchor_date' => '2026-11-02']])]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingRejectsAnInvalidTimezone(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(['recurrence' => ['frequency' => 'daily', 'time' => '13:00', 'timezone' => 'Not/ARealZone']])]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingRejectsAMissingWeekdayOnAWeeklyBlock(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(['recurrence' => ['frequency' => 'weekly', 'time' => '13:00', 'timezone' => 'UTC']])]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingRejectsAnOutOfRangeDayOfMonth(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(['recurrence' => ['frequency' => 'monthly', 'day_of_month' => 42, 'time' => '09:00', 'timezone' => 'UTC']])]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingRejectsAMalformedAnchorDate(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(['rotation' => ['mode' => 'sequential', 'loop' => true, 'anchor_date' => 'not-a-date']])]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingRejectsDuplicateBlockIds(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(), $this->validBlock()]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingRejectsANonPositiveDuration(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(['duration' => 0])]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingAcceptsAValidPackingConfig(): void
    {
        $block = $this->validBlock(['packing' => ['enabled' => true, 'mode' => 'best_fit', 'minimum_remaining' => 60]]);
        $result = channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$block]], $this->channelsDir, $this->seriesDir);
        Assert::same('best_fit', $result['blocks'][0]['packing']['mode']);
    }

    public function testSaveProgrammingRejectsAnInvalidPackingMode(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(['packing' => ['enabled' => true, 'mode' => 'random']])]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingRejectsPackingThatIsNotAnObject(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(['packing' => 'enabled'])]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingAcceptsAValidSoftBoundary(): void
    {
        $block = $this->validBlock(['boundary' => ['mode' => 'soft', 'max_delay' => 300]]);
        $result = channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$block]], $this->channelsDir, $this->seriesDir);
        Assert::same('soft', $result['blocks'][0]['boundary']['mode']);
    }

    public function testSaveProgrammingRejectsASoftBoundaryWithoutMaxDelay(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(['boundary' => ['mode' => 'soft']])]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingRejectsAnInvalidBoundaryMode(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock(['boundary' => ['mode' => 'bogus']])]], $this->channelsDir, $this->seriesDir);
        });
    }

    public function testSaveProgrammingKeepsAnAtomicBackup(): void
    {
        channel_admin_save_programming(['channel_id' => 'demo-channel', 'blocks' => [$this->validBlock()]], $this->channelsDir, $this->seriesDir);
        Assert::true(is_file("$this->channelsDir/demo-channel/programming.json.bak"));
    }

    // ---------- publish argv construction ----------

    public function testPublishArgvIncludesChannelIdDaysWindowAndVerbose(): void
    {
        $argv = channel_admin_build_publish_argv('demo-channel', ['days' => 10, 'window_start' => '2026-11-02', 'window_timezone' => 'UTC']);
        Assert::contains('demo-channel', $argv);
        Assert::contains('--days=10', $argv);
        Assert::contains('--window-start=2026-11-02', $argv);
        Assert::contains('--window-timezone=UTC', $argv);
        Assert::contains('--verbose', $argv);
    }

    public function testPublishArgvIncludesDryRunWhenRequested(): void
    {
        $argv = channel_admin_build_publish_argv('demo-channel', ['dry_run' => true]);
        Assert::contains('--dry-run', $argv);
    }

    public function testPublishArgvRejectsAnInvalidTimezone(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_build_publish_argv('demo-channel', ['window_timezone' => 'Nowhere/Fake']);
        });
    }

    public function testPublishArgvRejectsAnOutOfRangeDays(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_build_publish_argv('demo-channel', ['days' => 9999]);
        });
    }

    public function testPublishArgvRejectsAMalformedWindowStart(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_build_publish_argv('demo-channel', ['window_start' => 'next tuesday']);
        });
    }

    // ---------- publish() validation (stops before ever touching a subprocess) ----------

    public function testPublishRejectsAnUnknownChannelId(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_publish(['channel_id' => 'no-such-channel'], $this->channelsDir);
        });
    }

    public function testPublishRejectsAChannelWithNoProgrammingJson(): void
    {
        Assert::throws(ChannelAdminValidationError::class, function (): void {
            channel_admin_publish(['channel_id' => 'no-programming-channel'], $this->channelsDir);
        });
    }

    public function testPublishOnAValidFixtureChannelReachesTheRealPublishScriptSafely(): void
    {
        // This fixture channel id does not exist under the REAL
        // channels/ directory (channels/publish.php hard-codes its own
        // directory as the channel root, by design -- the admin endpoint
        // has no way to redirect it, nor should it in production). So
        // this call legitimately reaches and runs the real
        // channels/publish.php as a subprocess, which then correctly
        // rejects the unknown id itself -- proving the argv/subprocess
        // wiring actually works end to end without ever touching or
        // depending on the real channels/ tree.
        $result = channel_admin_publish(['channel_id' => 'demo-channel', 'dry_run' => true], $this->channelsDir);
        Assert::true($result['exitCode'] !== 0);
        Assert::true(str_contains($result['stderr'], 'no such channel') || str_contains($result['stderr'], 'Error'));
    }
}
