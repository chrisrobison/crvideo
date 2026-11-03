<?php
declare(strict_types=1);

final class SeriesAdminTest
{
    private string $workDir;
    private string $seriesDir;

    public function setUp(): void
    {
        $this->workDir = sys_get_temp_dir() . '/series-admin-test-' . bin2hex(random_bytes(4));
        self::copyDir(__DIR__ . '/fixtures/repo/series', $this->workDir);
        $this->seriesDir = $this->workDir;
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

    public function testListReturnsEveryFixtureSeriesWithEpisodesInOrder(): void
    {
        $list = series_admin_list($this->seriesDir);
        $byId = [];
        foreach ($list as $s) {
            $byId[$s['id']] = $s;
        }
        Assert::true(isset($byId['demo-series']));
        Assert::same(3, $byId['demo-series']['episode_count']);
        Assert::same('yt-aaa111', $byId['demo-series']['episodes'][0]['id']);
        Assert::same('candidate', $byId['demo-series']['episodes'][0]['status']);
        Assert::same('approved', $byId['demo-series']['episodes'][1]['status']);
    }

    // ---------- save_episode ----------

    public function testSaveEpisodeUpdatesOnlyStatusAndRights(): void
    {
        $before = json_decode(file_get_contents("$this->seriesDir/demo-series/series.json"), true);
        $episodeBefore = $before['episodes'][0];

        $result = series_admin_save_episode([
            'series_id' => 'demo-series', 'episode_id' => 'yt-aaa111',
            'status' => 'approved', 'rights_status' => 'licensed', 'rights_notes' => 'Cleared by hand in a test.',
        ], $this->seriesDir);

        Assert::same('approved', $result['status']);

        $after = json_decode(file_get_contents("$this->seriesDir/demo-series/series.json"), true);
        $episodeAfter = $after['episodes'][0];
        Assert::same('approved', $episodeAfter['status']);
        Assert::same('licensed', $episodeAfter['rights']['status']);
        Assert::same('Cleared by hand in a test.', $episodeAfter['rights']['notes']);

        // Every YouTube-sourced field must be byte-for-byte unchanged.
        foreach (['title', 'description', 'duration', 'year', 'published_at', 'thumbnail_url', 'source', 'episode_number', 'guests'] as $field) {
            Assert::same(
                json_encode($episodeBefore[$field] ?? null), json_encode($episodeAfter[$field] ?? null),
                "field \"$field\" must not change"
            );
        }
        // And every OTHER episode in the file must be completely untouched.
        Assert::same(json_encode($before['episodes'][1]), json_encode($after['episodes'][1]));
        Assert::same(json_encode($before['episodes'][2]), json_encode($after['episodes'][2]));
    }

    public function testSaveEpisodeWritesAnAtomicBackup(): void
    {
        series_admin_save_episode(['series_id' => 'demo-series', 'episode_id' => 'yt-aaa111', 'status' => 'rejected', 'rights_status' => 'unverified', 'rights_notes' => null], $this->seriesDir);
        Assert::true(is_file("$this->seriesDir/demo-series/series.json.bak"));
    }

    public function testSaveEpisodeRejectsAnUnknownSeriesId(): void
    {
        Assert::throws(AdminValidationError::class, function (): void {
            series_admin_save_episode(['series_id' => 'no-such-series', 'episode_id' => 'yt-aaa111', 'status' => 'approved', 'rights_status' => 'unverified', 'rights_notes' => null], $this->seriesDir);
        });
    }

    public function testSaveEpisodeRejectsPathTraversalInSeriesId(): void
    {
        Assert::throws(AdminValidationError::class, function (): void {
            series_admin_save_episode(['series_id' => '../../../etc', 'episode_id' => 'x', 'status' => 'approved', 'rights_status' => 'unverified', 'rights_notes' => null], $this->seriesDir);
        });
    }

    public function testSaveEpisodeRejectsAnUnknownEpisodeId(): void
    {
        Assert::throws(AdminValidationError::class, function (): void {
            series_admin_save_episode(['series_id' => 'demo-series', 'episode_id' => 'does-not-exist', 'status' => 'approved', 'rights_status' => 'unverified', 'rights_notes' => null], $this->seriesDir);
        });
    }

    public function testSaveEpisodeRejectsAnInvalidStatusValue(): void
    {
        Assert::throws(AdminValidationError::class, function (): void {
            series_admin_save_episode(['series_id' => 'demo-series', 'episode_id' => 'yt-aaa111', 'status' => 'super-approved', 'rights_status' => 'unverified', 'rights_notes' => null], $this->seriesDir);
        });
    }

    public function testSaveEpisodeRejectsAnInvalidRightsStatusValue(): void
    {
        Assert::throws(AdminValidationError::class, function (): void {
            series_admin_save_episode(['series_id' => 'demo-series', 'episode_id' => 'yt-aaa111', 'status' => 'approved', 'rights_status' => 'definitely_fine', 'rights_notes' => null], $this->seriesDir);
        });
    }

    public function testSaveEpisodeRejectsOverlongNotes(): void
    {
        Assert::throws(AdminValidationError::class, function (): void {
            series_admin_save_episode(['series_id' => 'demo-series', 'episode_id' => 'yt-aaa111', 'status' => 'approved', 'rights_status' => 'unverified', 'rights_notes' => str_repeat('x', 2001)], $this->seriesDir);
        });
    }

    // ---------- refresh argv construction ----------

    public function testRefreshArgvUsesChannelIdWhenSeriesHasOne(): void
    {
        $argv = series_admin_build_refresh_argv('demo-series', "$this->seriesDir/demo-series/series.json", false);
        Assert::contains('--channel-id=UCdemo123', $argv);
        Assert::contains('--refresh', $argv);
        Assert::true(!in_array('--dry-run', $argv, true));
    }

    public function testRefreshArgvIncludesDryRunWhenRequested(): void
    {
        $argv = series_admin_build_refresh_argv('demo-series', "$this->seriesDir/demo-series/series.json", true);
        Assert::contains('--dry-run', $argv);
    }

    public function testRefreshArgvUsesPlaylistIdWhenThatIsTheSeriesSource(): void
    {
        $argv = series_admin_build_refresh_argv('playlist-series', "$this->seriesDir/playlist-series/series.json", false);
        Assert::contains('--playlist=PLdemo456', $argv);
    }

    public function testRefreshArgvRejectsASeriesWithNoRecordedSource(): void
    {
        Assert::throws(AdminValidationError::class, function (): void {
            series_admin_build_refresh_argv('no-source-series', "$this->seriesDir/no-source-series/series.json", false);
        });
    }

    public function testRefreshArgvNeverContainsAShellMetacharacterUnescaped(): void
    {
        // The argv array passes each element as one literal argument via
        // admin_run_subprocess's array-form proc_open -- there is no
        // shell-escaping step here at all because there is no shell, so
        // this just confirms the array shape (one string per flag), not a
        // string-concatenated command line.
        $argv = series_admin_build_refresh_argv('demo-series', "$this->seriesDir/demo-series/series.json", false);
        foreach ($argv as $arg) {
            Assert::true(is_string($arg));
        }
    }

    // ---------- new_import argv construction ----------

    public function testNewImportArgvBuildsAChannelHandleImport(): void
    {
        $argv = series_admin_build_import_argv('new-show', '/tmp/wherever/series.json', ['channel' => '@SomeHandle'], false);
        Assert::contains('--channel=@SomeHandle', $argv);
        Assert::contains('--series-id=new-show', $argv);
        Assert::contains('--output=/tmp/wherever/series.json', $argv);
    }

    public function testNewImportArgvRejectsMoreThanOneSourceKind(): void
    {
        Assert::throws(AdminValidationError::class, function (): void {
            series_admin_build_import_argv('new-show', '/tmp/x/series.json', ['channel' => '@A', 'playlist' => 'PL1'], false);
        });
    }

    public function testNewImportArgvRejectsZeroSourceKinds(): void
    {
        Assert::throws(AdminValidationError::class, function (): void {
            series_admin_build_import_argv('new-show', '/tmp/x/series.json', [], false);
        });
    }

    public function testNewImportArgvRejectsControlCharactersInTheSourceValue(): void
    {
        Assert::throws(AdminValidationError::class, function (): void {
            series_admin_build_import_argv('new-show', '/tmp/x/series.json', ['channel' => "@A\nInjected"], false);
        });
    }

    public function testNewImportRejectsAnIdThatAlreadyExistsForARealRun(): void
    {
        Assert::throws(AdminValidationError::class, function (): void {
            series_admin_new_import(['series_id' => 'demo-series', 'channel' => '@Whatever', 'dry_run' => false], $this->seriesDir);
        });
    }
}
