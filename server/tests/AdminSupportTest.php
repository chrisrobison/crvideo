<?php
declare(strict_types=1);

final class AdminSupportTest
{
    private string $fixtureRoot;

    public function setUp(): void
    {
        $this->fixtureRoot = __DIR__ . '/fixtures/repo';
    }

    private function seriesDir(): string
    {
        return $this->fixtureRoot . '/series';
    }

    private function channelsDir(): string
    {
        return $this->fixtureRoot . '/channels';
    }

    // ---------- id validation ----------

    public function testValidIdsAreAccepted(): void
    {
        Assert::true(admin_valid_id('demo-series'));
        Assert::true(admin_valid_id('a'));
        Assert::true(admin_valid_id('a1-b2'));
    }

    public function testInvalidIdsAreRejected(): void
    {
        Assert::true(!admin_valid_id('../etc/passwd'));
        Assert::true(!admin_valid_id('UPPER'));
        Assert::true(!admin_valid_id('has space'));
        Assert::true(!admin_valid_id('-leading-dash'));
        Assert::true(!admin_valid_id(''));
        Assert::true(!admin_valid_id(null));
        Assert::true(!admin_valid_id(['array']));
        Assert::true(!admin_valid_id(str_repeat('a', 101)));
    }

    // ---------- path/existence whitelisting ----------

    public function testExistingSeriesPathResolvesForARealFixtureSeries(): void
    {
        $path = admin_existing_series_path('demo-series', $this->seriesDir());
        Assert::notNull($path);
        Assert::true(is_file($path));
    }

    public function testExistingSeriesPathRejectsPathTraversalAttempts(): void
    {
        Assert::null(admin_existing_series_path('../../../etc', $this->seriesDir()));
        Assert::null(admin_existing_series_path('..', $this->seriesDir()));
    }

    public function testExistingSeriesPathRejectsASeriesThatDoesNotExist(): void
    {
        Assert::null(admin_existing_series_path('totally-made-up', $this->seriesDir()));
    }

    public function testNewSeriesPathRejectsAnIdThatAlreadyExists(): void
    {
        Assert::null(admin_new_series_path('demo-series', $this->seriesDir()));
    }

    public function testNewSeriesPathAcceptsAFreshValidId(): void
    {
        $path = admin_new_series_path('brand-new-series', $this->seriesDir());
        Assert::notNull($path);
        Assert::true(str_ends_with($path, '/brand-new-series/series.json'));
    }

    public function testExistingChannelDirResolvesForARealFixtureChannel(): void
    {
        $dir = admin_existing_channel_dir('demo-channel', $this->channelsDir());
        Assert::notNull($dir);
        Assert::true(is_file("$dir/meta.json"));
    }

    public function testExistingChannelDirRejectsUnknownIds(): void
    {
        Assert::null(admin_existing_channel_dir('no-such-channel', $this->channelsDir()));
        Assert::null(admin_existing_channel_dir('../../etc', $this->channelsDir()));
    }

    // ---------- listing ----------

    public function testListSeriesPathsFindsEveryFixtureSeries(): void
    {
        $list = admin_list_series_paths($this->seriesDir());
        Assert::true(isset($list['demo-series']));
        Assert::true(isset($list['playlist-series']));
        Assert::true(isset($list['no-source-series']));
    }

    public function testListChannelDirsFindsEveryFixtureChannel(): void
    {
        $list = admin_list_channel_dirs($this->channelsDir());
        Assert::true(isset($list['demo-channel']));
        Assert::true(isset($list['no-programming-channel']));
    }

    // ---------- atomic write ----------

    public function testAtomicWriteRoundTripsAndKeepsABackup(): void
    {
        $dir = sys_get_temp_dir() . '/admin-support-test-' . bin2hex(random_bytes(4));
        mkdir($dir, 0775, true);
        $path = "$dir/x.json";
        admin_atomic_write_json($path, ['v' => 1]);
        admin_atomic_write_json($path, ['v' => 2]);

        Assert::same(2, json_decode(file_get_contents($path), true)['v']);
        Assert::same(1, json_decode(file_get_contents("$path.bak"), true)['v']);
        Assert::count(0, glob("$dir/*.tmp"), 'no leftover temp files');

        foreach (glob("$dir/*") ?: [] as $f) {
            unlink($f);
        }
        rmdir($dir);
    }

    // ---------- subprocess runner ----------

    public function testRunSubprocessUsesArgvArrayNeverAShellString(): void
    {
        // A value containing shell metacharacters must be passed through
        // literally as ONE argument, never interpreted -- proof the
        // array-form proc_open call never touches a shell at all.
        $dangerous = 'hello; rm -rf /tmp/should-not-run && echo pwned';
        $result = admin_run_subprocess(['echo', $dangerous]);
        Assert::same(0, $result['exitCode']);
        Assert::same($dangerous, trim($result['stdout']));
    }

    public function testRunSubprocessCapturesANonZeroExitCode(): void
    {
        $result = admin_run_subprocess(['php', '-r', 'exit(7);']);
        Assert::same(7, $result['exitCode']);
    }
}
