<?php
declare(strict_types=1);

// server/tests/AnnouncerAdminTest.php
//
// Coverage for server/announcer-admin.php's pure, filesystem-local
// functions: listing, config validation/save, argv-building for the
// regenerate action, and approve_script. Deliberately does NOT exercise
// announcer_admin_regenerate()/announcer_admin_generate_queue() end to
// end (those shell out to channels/announce.php, which needs a real or
// mocked `claude` CLI and Kokoro server -- see channels/announcer/tests/
// for that coverage) or announcer_admin_voices()/preview_voice() (both
// need a real Kokoro HTTP server) -- those are exercised manually/
// end-to-end per channels/announcer/README.md, same posture as
// ChannelAdminTest not actually running channels/publish.php for real.

final class AnnouncerAdminTest
{
    private string $workDir;
    private string $channelsDir;

    public function setUp(): void
    {
        $this->workDir = sys_get_temp_dir() . '/announcer-admin-test-' . bin2hex(random_bytes(4));
        self::copyDir(__DIR__ . '/fixtures/repo/channels', "$this->workDir/channels");
        $this->channelsDir = "$this->workDir/channels";

        // Fixture-local additions (never written into the checked-in
        // fixtures/repo/ tree, which ChannelAdminTest/SeriesAdminTest also
        // share): give "demo-channel" an announcer.json and a small
        // announcements.json manifest to list/edit/approve against.
        file_put_contents("$this->channelsDir/demo-channel/announcer.json", json_encode([
            'enabled' => true,
            'voice' => 'af_heart',
            'speed' => 1.0,
            'language' => 'en-us',
            'style' => 'Clear, friendly broadcast announcer',
            'tone' => 'Neutral, warm, professional',
            'targetDuration' => 12,
            'types' => ['coming_up_next'],
            'consecutiveSameSeries' => 'short',
            'writer' => ['provider' => 'claude-cli', 'model' => 'sonnet'],
            'tts' => ['provider' => 'kokoro-http', 'endpoint' => 'http://127.0.0.1:8178'],
        ]));
        file_put_contents("$this->channelsDir/demo-channel/announcements.json", json_encode([
            'schema_version' => 1,
            'announcements' => [
                [
                    'id' => 'demo-channel-continuity-1-next',
                    'channelId' => 'demo-channel',
                    'type' => 'coming_up_next',
                    'transitionId' => 'continuity-1',
                    'text' => 'Coming up next.',
                    'audio' => '/media/announcements/demo-channel/abc123.mp3',
                    'status' => 'ready',
                    'scriptHash' => str_repeat('a', 64),
                ],
            ],
        ]));
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

    /** Plain shallow-merge-per-key override (never array_replace_recursive,
     *  which merges a list override KEY-BY-KEY instead of replacing it --
     *  an override of `['types' => []]` would then silently keep the
     *  base's list element at index 0 instead of actually emptying it). */
    private function validConfig(array $overrides = []): array
    {
        $base = [
            'enabled' => true,
            'voice' => 'af_heart',
            'speed' => 1.0,
            'language' => 'en-us',
            'style' => 'Clear, friendly broadcast announcer',
            'tone' => 'Neutral, warm, professional',
            'targetDuration' => 12,
            'types' => ['coming_up_next'],
            'consecutiveSameSeries' => 'short',
            'writer' => ['provider' => 'claude-cli', 'model' => 'sonnet'],
            'tts' => ['provider' => 'kokoro-http', 'endpoint' => 'http://127.0.0.1:8178'],
        ];
        foreach ($overrides as $key => $value) {
            $base[$key] = $value;
        }
        return $base;
    }

    // ---------- listing ----------

    public function testListReturnsEveryFixtureChannelWithResolvedConfig(): void
    {
        $list = announcer_admin_list($this->channelsDir);
        $byId = [];
        foreach ($list as $c) {
            $byId[$c['id']] = $c;
        }
        Assert::true(isset($byId['demo-channel']), 'demo-channel should be listed');
        Assert::true($byId['demo-channel']['hasAnnouncerJson'], 'demo-channel has announcer.json');
        Assert::true($byId['demo-channel']['config']['enabled'], 'demo-channel announcer should resolve enabled');
        Assert::same('af_heart', $byId['demo-channel']['config']['voice']);
        Assert::count(1, $byId['demo-channel']['announcements']);
        Assert::same(['pending' => 0, 'running' => 0, 'done' => 0, 'error' => 0], $byId['demo-channel']['queue']);
    }

    public function testListResolvesDisabledForAChannelWithNoAnnouncerJson(): void
    {
        $list = announcer_admin_list($this->channelsDir);
        $byId = [];
        foreach ($list as $c) {
            $byId[$c['id']] = $c;
        }
        Assert::true(isset($byId['no-programming-channel']));
        Assert::true(!$byId['no-programming-channel']['hasAnnouncerJson']);
        Assert::true(!$byId['no-programming-channel']['config']['enabled'], 'no announcer.json -- must resolve disabled regardless of config.php defaults');
    }

    public function testPublicConfigNeverLeaksAnAuthToken(): void
    {
        $config = announcer_admin_public_config(['tts' => ['provider' => 'kokoro-http', 'authToken' => 'super-secret']]);
        Assert::true(!array_key_exists('authToken', $config['tts']));
    }

    // ---------- save_config validation ----------

    public function testSaveConfigAcceptsAValidConfigAndWritesAnnouncerJson(): void
    {
        $result = announcer_admin_save_config(['channel_id' => 'no-programming-channel', 'config' => $this->validConfig()], $this->channelsDir);
        Assert::true($result['config']['enabled']);
        $written = json_decode((string) file_get_contents("$this->channelsDir/no-programming-channel/announcer.json"), true);
        Assert::same('af_heart', $written['voice']);
    }

    public function testSaveConfigRejectsUnknownChannel(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_save_config(['channel_id' => 'no-such-channel', 'config' => $this->validConfig()], $this->channelsDir);
        });
    }

    public function testSaveConfigRejectsBadVoice(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_save_config(['channel_id' => 'demo-channel', 'config' => $this->validConfig(['voice' => 'not a voice!'])], $this->channelsDir);
        });
    }

    public function testSaveConfigRejectsOutOfRangeSpeed(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_save_config(['channel_id' => 'demo-channel', 'config' => $this->validConfig(['speed' => 9.9])], $this->channelsDir);
        });
    }

    public function testSaveConfigRejectsEmptyTypesList(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_save_config(['channel_id' => 'demo-channel', 'config' => $this->validConfig(['types' => []])], $this->channelsDir);
        });
    }

    public function testSaveConfigRejectsUnknownAnnouncementType(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_save_config(['channel_id' => 'demo-channel', 'config' => $this->validConfig(['types' => ['not_a_real_type']])], $this->channelsDir);
        });
    }

    public function testSaveConfigRejectsUnknownWriterProvider(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_save_config(['channel_id' => 'demo-channel', 'config' => $this->validConfig(['writer' => ['provider' => 'gpt-5', 'model' => 'x']])], $this->channelsDir);
        });
    }

    public function testSaveConfigRejectsNonHttpTtsEndpoint(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_save_config(['channel_id' => 'demo-channel', 'config' => $this->validConfig(['tts' => ['provider' => 'kokoro-http', 'endpoint' => 'ftp://evil']])], $this->channelsDir);
        });
    }

    public function testSaveConfigRejectsOverlongStyleText(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_save_config(['channel_id' => 'demo-channel', 'config' => $this->validConfig(['style' => str_repeat('x', 400)])], $this->channelsDir);
        });
    }

    // ---------- merge-onto-existing-file behavior (never a wholesale replace) ----------

    public function testSaveConfigOmittingTtsPreservesTheExistingTtsEndpoint(): void
    {
        // demo-channel's fixture announcer.json (see setUp()) already has
        // tts.endpoint set to a non-default value -- the admin UI's own
        // payload shape (no "tts" key at all, since it isn't editable
        // there) must never clobber it back to the global default.
        $config = $this->validConfig();
        unset($config['tts']);
        $result = announcer_admin_save_config(['channel_id' => 'demo-channel', 'config' => $config], $this->channelsDir);
        Assert::same('http://127.0.0.1:8178', $result['config']['tts']['endpoint']);

        $written = json_decode((string) file_get_contents("$this->channelsDir/demo-channel/announcer.json"), true);
        Assert::same('http://127.0.0.1:8178', $written['tts']['endpoint']);
    }

    public function testSaveConfigPreservesAnUnexposedWriterFieldAcrossASave(): void
    {
        // Seed a per-channel writer.timeoutSeconds override the admin UI
        // has no field for, then save through the UI's own payload shape
        // (writer.provider/model only) -- the override must survive.
        file_put_contents("$this->channelsDir/demo-channel/announcer.json", json_encode(array_replace_recursive(
            $this->validConfig(),
            ['writer' => ['provider' => 'claude-cli', 'model' => 'sonnet', 'timeoutSeconds' => 99, 'bin' => '/opt/custom/claude']],
        )));

        $config = $this->validConfig(['writer' => ['provider' => 'template', 'model' => 'n/a']]);
        unset($config['tts']);
        $result = announcer_admin_save_config(['channel_id' => 'demo-channel', 'config' => $config], $this->channelsDir);

        Assert::same('template', $result['config']['writer']['provider']);
        Assert::same(99, $result['config']['writer']['timeoutSeconds']);
        Assert::same('/opt/custom/claude', $result['config']['writer']['bin']);
    }

    // ---------- regenerate argv building (never actually run) ----------

    public function testBuildRegenerateArgvIncludesChannelAndTransition(): void
    {
        $argv = announcer_admin_build_regenerate_argv('demo-channel', 'continuity-1', []);
        Assert::contains('--channel=demo-channel', $argv);
        Assert::contains('--transition=continuity-1', $argv);
        Assert::contains('--sync', $argv);
        Assert::true(!in_array('--force', $argv, true));
    }

    public function testBuildRegenerateArgvHonorsForceFlags(): void
    {
        $argv = announcer_admin_build_regenerate_argv('demo-channel', 'continuity-1', ['force_script' => true]);
        Assert::contains('--force-script', $argv);
        Assert::true(!in_array('--force-audio', $argv, true));
    }

    public function testBuildRegenerateArgvForcePrefersCombinedFlagOverIndividualOnes(): void
    {
        $argv = announcer_admin_build_regenerate_argv('demo-channel', 'continuity-1', ['force' => true, 'force_script' => true]);
        Assert::contains('--force', $argv);
        Assert::true(!in_array('--force-script', $argv, true), 'force=true should short-circuit the individual flags');
    }

    public function testRegenerateRejectsInvalidTransitionId(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_regenerate(['channel_id' => 'demo-channel', 'transition_id' => '../../etc/passwd'], $this->channelsDir);
        });
    }

    public function testRegenerateRejectsChannelWithNoAnnouncerJson(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_regenerate(['channel_id' => 'no-programming-channel', 'transition_id' => 'continuity-1'], $this->channelsDir);
        });
    }

    // ---------- approve_script ----------

    public function testApproveScriptWritesAnApprovedEntry(): void
    {
        $hash = str_repeat('b', 64);
        $result = announcer_admin_approve_script(['channel_id' => 'demo-channel', 'script_hash' => $hash, 'text' => 'A human-edited line.'], $this->channelsDir);
        Assert::true($result['ok']);
        $entry = ScriptCache::get("$this->channelsDir/demo-channel", $hash);
        Assert::notNull($entry);
        Assert::same('A human-edited line.', $entry['text']);
        Assert::true($entry['approved']);
    }

    public function testApproveScriptRejectsInvalidHash(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_approve_script(['channel_id' => 'demo-channel', 'script_hash' => '../not-a-hash', 'text' => 'x'], $this->channelsDir);
        });
    }

    public function testApproveScriptRejectsEmptyText(): void
    {
        Assert::throws(AnnouncerAdminValidationError::class, function (): void {
            announcer_admin_approve_script(['channel_id' => 'demo-channel', 'script_hash' => str_repeat('c', 64), 'text' => '   '], $this->channelsDir);
        });
    }
}
