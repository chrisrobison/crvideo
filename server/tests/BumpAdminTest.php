<?php
declare(strict_types=1);

// server/tests/BumpAdminTest.php
//
// Coverage for server/bump-admin.php's pure, filesystem-local functions:
// media-path containment, normalization/validation of every field, and
// create/update/delete/list against a throwaway tree built fresh per test
// (never the shared server/tests/fixtures/repo/ -- bumps don't live under
// channels/, and this needs its own small media/ tree with real files to
// validate paths against, which the shared fixture has no reason to carry).

final class BumpAdminTest
{
    private string $workDir;
    private string $repoRoot;
    private string $bumpsDir;
    private string $channelsDir;
    private string $mediaRoot;

    public function setUp(): void
    {
        $this->workDir = sys_get_temp_dir() . '/bump-admin-test-' . bin2hex(random_bytes(4));
        $this->repoRoot = $this->workDir;
        $this->bumpsDir = "$this->workDir/bumps";
        $this->channelsDir = "$this->workDir/channels";
        $this->mediaRoot = "$this->workDir/media";

        mkdir("$this->workDir/media/video", 0775, true);
        mkdir("$this->workDir/media/music", 0775, true);
        mkdir("$this->workDir/media/ambience", 0775, true);
        mkdir($this->bumpsDir, 0775, true);
        mkdir("$this->channelsDir/science", 0775, true);

        file_put_contents("$this->workDir/media/video/bg05.mp4", 'x');
        file_put_contents("$this->workDir/media/music/bg-music03.mp3", 'x');
        file_put_contents("$this->workDir/media/ambience/forest.mp3", 'x');
        file_put_contents("$this->workDir/leak.txt", 'x'); // sibling of media/ (real file, directly under workDir), NOT inside it -- used by the traversal-escape test below

        file_put_contents("$this->channelsDir/science/meta.json", json_encode(['name' => 'Science & Engineering']));
        file_put_contents("$this->channelsDir/science/announcements.json", json_encode([
            'schema_version' => 1,
            'announcements' => [
                [
                    'transitionId' => 'continuity-1',
                    'type' => 'coming_up_next',
                    'text' => 'Coming up next: a look at orbital mechanics.',
                    'audio' => '/media/announcements/science/abc123.mp3',
                    'status' => 'ready',
                ],
                [
                    'transitionId' => 'continuity-2',
                    'type' => 'coming_up_next',
                    'text' => 'Not actually ready yet.',
                    'audio' => null,
                    'status' => 'pending',
                ],
            ],
        ]));
        mkdir("$this->workDir/media/announcements/science", 0775, true);
        file_put_contents("$this->workDir/media/announcements/science/abc123.mp3", 'x');
    }

    public function tearDown(): void
    {
        self::rrmdir($this->workDir);
    }

    private static function rrmdir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = "$dir/$entry";
            is_dir($path) ? self::rrmdir($path) : unlink($path);
        }
        rmdir($dir);
    }

    private function validBody(array $overrides = []): array
    {
        $base = [
            'name' => 'Forest Interlude',
            'background' => ['type' => 'video', 'url' => 'media/video/bg05.mp4'],
            'audio' => [
                ['source' => 'ambience', 'url' => 'media/ambience/forest.mp3', 'volume' => 0.4],
            ],
            'upcoming' => ['count' => 3, 'label' => 'Coming Up'],
        ];
        foreach ($overrides as $key => $value) {
            $base[$key] = $value;
        }
        return $base;
    }

    // ---------- media path containment ----------

    public function testValidMediaUrlAcceptsARealFileUnderMedia(): void
    {
        Assert::true(bump_admin_valid_media_url('media/video/bg05.mp4', $this->mediaRoot));
    }

    public function testValidMediaUrlRejectsPathTraversal(): void
    {
        Assert::true(!bump_admin_valid_media_url('media/../bumps/README.md', $this->mediaRoot));
    }

    public function testValidMediaUrlRejectsAPathOutsideMedia(): void
    {
        // "media/../leak.txt" starts with the required "media/" prefix and
        // resolves to a REAL file (leak.txt, see setUp()) -- but that file
        // sits OUTSIDE media/, one level up. Containment must catch this
        // even though the naive prefix check alone would not.
        Assert::true(!bump_admin_valid_media_url('media/../leak.txt', $this->mediaRoot));
    }

    public function testValidMediaUrlRejectsANonExistentFile(): void
    {
        Assert::true(!bump_admin_valid_media_url('media/video/does-not-exist.mp4', $this->mediaRoot));
    }

    public function testValidMediaUrlAcceptsALeadingSlash(): void
    {
        Assert::true(bump_admin_valid_media_url('/media/video/bg05.mp4', $this->mediaRoot));
    }

    public function testValidMediaUrlRejectsAUrlNotUnderMediaAtAll(): void
    {
        Assert::true(!bump_admin_valid_media_url('bumps/README.md', $this->mediaRoot));
    }

    // ---------- normalization ----------

    public function testNormalizeBackgroundRejectsUnknownType(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize_background(['type' => 'gif', 'url' => 'media/video/bg05.mp4'], $this->mediaRoot);
        });
    }

    public function testNormalizeBackgroundAcceptsColorWithoutAUrl(): void
    {
        $bg = bump_admin_normalize_background(['type' => 'color', 'color' => '#102030'], $this->mediaRoot);
        Assert::same('color', $bg['type']);
        Assert::same('#102030', $bg['color']);
    }

    public function testNormalizeBackgroundRejectsAMissingVideoFile(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize_background(['type' => 'video', 'url' => 'media/video/nope.mp4'], $this->mediaRoot);
        });
    }

    public function testNormalizeAudioLayersRejectsMoreThanTheMax(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize_audio_layers([
                ['source' => 'music', 'url' => 'media/music/bg-music03.mp3'],
                ['source' => 'music', 'url' => 'media/music/bg-music03.mp3'],
                ['source' => 'music', 'url' => 'media/music/bg-music03.mp3'],
            ], $this->mediaRoot);
        });
    }

    public function testNormalizeAudioLayersRejectsOutOfRangeVolume(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize_audio_layers([['source' => 'music', 'url' => 'media/video/bg05.mp4', 'volume' => 2.0]], $this->mediaRoot);
        });
    }

    public function testNormalizeAudioLayersRejectsAFileOutsideMedia(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize_audio_layers([['source' => 'custom', 'url' => 'media/../leak.txt']], $this->mediaRoot);
        });
    }

    public function testNormalizeAnnouncementAllowsNull(): void
    {
        Assert::null(bump_admin_normalize_announcement(null, $this->mediaRoot));
    }

    public function testNormalizeAnnouncementDefaultsDuckTo(): void
    {
        $ann = bump_admin_normalize_announcement(['url' => '/media/announcements/science/abc123.mp3'], $this->mediaRoot);
        Assert::same(0.3, $ann['duckTo']);
    }

    public function testNormalizeUpcomingRejectsOutOfRangeCount(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize_upcoming(['count' => 99]);
        });
    }

    public function testNormalizeUpcomingDefaultsLabelWhenBlank(): void
    {
        $u = bump_admin_normalize_upcoming(['count' => 2, 'label' => '   ']);
        Assert::same('Coming Up', $u['label']);
    }

    public function testNormalizeStyleKeepsOnlyKnownKeys(): void
    {
        $style = bump_admin_normalize_style(['accent' => '#fff', 'notarealkey' => 'x']);
        Assert::same(['accent' => '#fff'], $style);
    }

    public function testNormalizeRejectsEmptyName(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize($this->validBody(['name' => '   ']), $this->mediaRoot);
        });
    }

    // ---------- create / update / delete / list (against this test's own throwaway bumps/ dir) ----------

    public function testCreateDerivesASlugIdFromName(): void
    {
        $result = bump_admin_create($this->validBody(), $this->bumpsDir, $this->mediaRoot);
        Assert::same('forest-interlude', $result['bump']['id']);
        Assert::true(is_file("$this->bumpsDir/forest-interlude.json"));
    }

    public function testCreateDedupesACollidingSlug(): void
    {
        bump_admin_create($this->validBody(), $this->bumpsDir, $this->mediaRoot);
        $second = bump_admin_create($this->validBody(['name' => 'Forest Interlude']), $this->bumpsDir, $this->mediaRoot);
        Assert::same('forest-interlude-2', $second['bump']['id']);
    }

    public function testCreateRejectsAMediaUrlThatDoesNotExist(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_create($this->validBody(['background' => ['type' => 'video', 'url' => 'media/video/nope.mp4']]), $this->bumpsDir, $this->mediaRoot);
        });
    }

    public function testUpdateRejectsUnknownId(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_update($this->validBody(['id' => 'does-not-exist']), $this->bumpsDir, $this->mediaRoot);
        });
    }

    public function testUpdatePreservesCreatedAtAndBumpsUpdatedAt(): void
    {
        $created = bump_admin_create($this->validBody(), $this->bumpsDir, $this->mediaRoot);
        $id = $created['bump']['id'];
        usleep(1100000); // ensure gmdate('c')'s second-resolution timestamp actually differs
        $updated = bump_admin_update($this->validBody(['id' => $id, 'name' => 'Forest Interlude (v2)']), $this->bumpsDir, $this->mediaRoot);
        Assert::same($created['bump']['createdAt'], $updated['bump']['createdAt']);
        Assert::true($updated['bump']['updatedAt'] !== $created['bump']['updatedAt']);
        Assert::same('Forest Interlude (v2)', $updated['bump']['name']);
    }

    public function testUpdateIsAFullReplaceNotAMerge(): void
    {
        $created = bump_admin_create($this->validBody(), $this->bumpsDir, $this->mediaRoot);
        $id = $created['bump']['id'];
        // Save again with NO audio layers at all -- the previous ambience
        // layer must be gone, not merged/kept (full replace, same posture
        // as channel-admin's save_programming replacing the whole block list).
        $updated = bump_admin_update($this->validBody(['id' => $id, 'audio' => []]), $this->bumpsDir, $this->mediaRoot);
        Assert::count(0, $updated['bump']['audio']);
    }

    public function testDeleteRemovesTheFile(): void
    {
        $created = bump_admin_create($this->validBody(), $this->bumpsDir, $this->mediaRoot);
        $id = $created['bump']['id'];
        bump_admin_delete(['id' => $id], $this->bumpsDir);
        Assert::true(!is_file("$this->bumpsDir/$id.json"));
    }

    public function testDeleteOfAnAlreadyMissingIdIsANoOp(): void
    {
        $result = bump_admin_delete(['id' => 'never-existed'], $this->bumpsDir);
        Assert::true($result['ok']);
    }

    public function testDeleteRejectsAnInvalidId(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_delete(['id' => '../etc/passwd'], $this->bumpsDir);
        });
    }

    public function testListReturnsEveryCreatedBumpSortedByName(): void
    {
        bump_admin_create($this->validBody(['name' => 'Zeta Bump']), $this->bumpsDir, $this->mediaRoot);
        bump_admin_create($this->validBody(['name' => 'Alpha Bump']), $this->bumpsDir, $this->mediaRoot);
        $list = bump_admin_list($this->bumpsDir);
        Assert::count(2, $list);
        Assert::same('Alpha Bump', $list[0]['name']);
        Assert::same('Zeta Bump', $list[1]['name']);
    }

    public function testListAddsTheFileModifiedTimeAsModifiedAt(): void
    {
        $id = bump_admin_create($this->validBody(), $this->bumpsDir, $this->mediaRoot)['bump']['id'];
        touch("$this->bumpsDir/$id.json", 1794000000);
        clearstatcache();
        $list = bump_admin_list($this->bumpsDir);
        Assert::same(gmdate('c', 1794000000), $list[0]['modifiedAt']);
    }

    public function testModifiedAtIsNeverWrittenIntoTheBumpFile(): void
    {
        $id = bump_admin_create($this->validBody(), $this->bumpsDir, $this->mediaRoot)['bump']['id'];
        $listed = bump_admin_list($this->bumpsDir)[0];
        // The editor round-trips whatever it was given; an update carrying
        // modifiedAt must still store only schema fields.
        bump_admin_update($listed + ['id' => $id], $this->bumpsDir, $this->mediaRoot);
        $stored = json_decode((string) file_get_contents("$this->bumpsDir/$id.json"), true);
        Assert::true(!array_key_exists('modifiedAt', $stored));
    }

    // ---------- schema_version 2: duration + timing (bumps/README.md "Timing") ----------

    public function testCreateWithoutDurationStaysSchemaVersion1WithNoTimingFields(): void
    {
        $bump = bump_admin_create($this->validBody(), $this->bumpsDir, $this->mediaRoot)['bump'];
        Assert::same(1, $bump['schema_version']);
        Assert::true(!array_key_exists('duration', $bump), 'v1 bump must not gain a duration');
        Assert::same(['count' => 3, 'label' => 'Coming Up'], $bump['upcoming']);
        $onDisk = json_decode((string) file_get_contents("$this->bumpsDir/{$bump['id']}.json"), true);
        Assert::same(1, $onDisk['schema_version']);
        Assert::true(!array_key_exists('duration', $onDisk));
    }

    public function testCreateWithDurationAndTimingWritesSchemaVersion2(): void
    {
        $bump = bump_admin_create($this->validBody([
            'duration' => 15,
            'announcement' => ['url' => 'media/announcements/science/abc123.mp3', 'duckTo' => 0.3, 'start' => 2],
            'upcoming' => ['count' => 3, 'label' => 'Coming Up', 'start' => 1.5, 'end' => 14],
        ]), $this->bumpsDir, $this->mediaRoot)['bump'];
        Assert::same(2, $bump['schema_version']);
        Assert::same(15.0, $bump['duration']);
        Assert::same(2.0, $bump['announcement']['start']);
        Assert::same(1.5, $bump['upcoming']['start']);
        Assert::same(14.0, $bump['upcoming']['end']);
    }

    public function testSaveAndReloadPreservesTiming(): void
    {
        $created = bump_admin_create($this->validBody(['duration' => 20, 'upcoming' => ['count' => 2, 'label' => 'Next', 'start' => 3, 'end' => 18]]), $this->bumpsDir, $this->mediaRoot)['bump'];
        $list = bump_admin_list($this->bumpsDir);
        Assert::same(20.0, (float) $list[0]['duration']);
        Assert::same(3.0, (float) $list[0]['upcoming']['start']);
        Assert::same(18.0, (float) $list[0]['upcoming']['end']);
        // Re-saving the reloaded document through update round-trips unchanged.
        $updated = bump_admin_update($list[0] + ['id' => $created['id']], $this->bumpsDir, $this->mediaRoot)['bump'];
        Assert::same(2, $updated['schema_version']);
        Assert::same(['count' => 2, 'label' => 'Next', 'start' => 3.0, 'end' => 18.0], $updated['upcoming']);
    }

    public function testUpdateDroppingDurationReturnsToSchemaVersion1(): void
    {
        $id = bump_admin_create($this->validBody(['duration' => 12]), $this->bumpsDir, $this->mediaRoot)['bump']['id'];
        $updated = bump_admin_update($this->validBody(['id' => $id]), $this->bumpsDir, $this->mediaRoot)['bump'];
        Assert::same(1, $updated['schema_version']);
        Assert::true(!array_key_exists('duration', $updated));
    }

    public function testExistingVersion1RepoBumpsStillValidate(): void
    {
        // Every real bumps/*.json in the repo must still pass normalization
        // unchanged (against the real media/ tree) and stay version 1.
        $realMedia = dirname(__DIR__, 2) . '/media';
        if (!is_dir($realMedia)) {
            return; // media/ is not part of every checkout
        }
        foreach (glob(dirname(__DIR__, 2) . '/bumps/*.json') ?: [] as $path) {
            $doc = json_decode((string) file_get_contents($path), true);
            Assert::same(1, $doc['schema_version'], basename($path));
            try {
                $normalized = bump_admin_normalize($doc, $realMedia);
            } catch (BumpAdminValidationError $e) {
                if (str_contains($e->getMessage(), 'existing file')) {
                    continue; // a referenced media file is absent in this checkout -- not a schema problem
                }
                throw $e;
            }
            Assert::same(1, bump_admin_schema_version($normalized), basename($path));
            Assert::same($doc['upcoming'], $normalized['upcoming'], basename($path));
        }
    }

    public function testDurationRejectsOutOfRangeValues(): void
    {
        foreach ([0, -5, 301, 'abc'] as $bad) {
            Assert::throws(BumpAdminValidationError::class, function () use ($bad): void {
                bump_admin_normalize($this->validBody(['duration' => $bad]), $this->mediaRoot);
            }, 'duration ' . var_export($bad, true));
        }
    }

    public function testTimingFieldsRequireADuration(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize($this->validBody(['upcoming' => ['count' => 3, 'start' => 1]]), $this->mediaRoot);
        });
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize($this->validBody(['announcement' => ['url' => 'media/announcements/science/abc123.mp3', 'start' => 1]]), $this->mediaRoot);
        });
    }

    public function testTimingRejectsNegativeStart(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize($this->validBody(['duration' => 15, 'upcoming' => ['count' => 3, 'start' => -1]]), $this->mediaRoot);
        });
    }

    public function testTimingRejectsEndPastDuration(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize($this->validBody(['duration' => 15, 'upcoming' => ['count' => 3, 'end' => 16]]), $this->mediaRoot);
        });
    }

    public function testTimingRejectsEndNotAfterStart(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize($this->validBody(['duration' => 15, 'upcoming' => ['count' => 3, 'start' => 5, 'end' => 5]]), $this->mediaRoot);
        });
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize($this->validBody(['duration' => 15, 'upcoming' => ['count' => 3, 'start' => 15]]), $this->mediaRoot);
        });
    }

    public function testAnnouncementStartMustBeInsideTheComposition(): void
    {
        $ann = ['url' => 'media/announcements/science/abc123.mp3'];
        Assert::throws(BumpAdminValidationError::class, function () use ($ann): void {
            bump_admin_normalize($this->validBody(['duration' => 10, 'announcement' => $ann + ['start' => 10]]), $this->mediaRoot);
        });
        Assert::throws(BumpAdminValidationError::class, function () use ($ann): void {
            bump_admin_normalize($this->validBody(['duration' => 10, 'announcement' => $ann + ['start' => -0.5]]), $this->mediaRoot);
        });
        $ok = bump_admin_normalize($this->validBody(['duration' => 10, 'announcement' => $ann + ['start' => 9.5]]), $this->mediaRoot);
        Assert::same(9.5, $ok['announcement']['start']);
    }

    public function testDurationAloneIsValidAndOmitsTimingFields(): void
    {
        $n = bump_admin_normalize($this->validBody(['duration' => 15]), $this->mediaRoot);
        Assert::same(15.0, $n['duration']);
        Assert::same(['count' => 3, 'label' => 'Coming Up'], $n['upcoming']);
        Assert::same(2, bump_admin_schema_version($n));
    }

    // ---------- media listing ----------

    public function testListMediaFindsFixtureFilesByExtension(): void
    {
        $media = bump_admin_list_media($this->repoRoot, $this->channelsDir);
        Assert::count(1, $media['video']);
        Assert::same('bg05.mp4', $media['video'][0]['name']);
        Assert::count(1, $media['music']);
        Assert::count(1, $media['ambience']);
        Assert::count(0, $media['image'], 'no media/images/ dir in the fixture -> empty, not missing');
    }

    public function testListMediaFindsStillImages(): void
    {
        mkdir("$this->workDir/media/images", 0775, true);
        file_put_contents("$this->workDir/media/images/card.png", 'x');
        file_put_contents("$this->workDir/media/images/notes.txt", 'x');
        $media = bump_admin_list_media($this->repoRoot, $this->channelsDir);
        Assert::count(1, $media['image']);
        Assert::same('media/images/card.png', $media['image'][0]['url']);
    }

    public function testListMediaOnlyOffersReadyAnnouncementsWithAudio(): void
    {
        $media = bump_admin_list_media($this->repoRoot, $this->channelsDir);
        $science = null;
        foreach ($media['channels'] as $c) {
            if ($c['id'] === 'science') {
                $science = $c;
            }
        }
        Assert::notNull($science);
        Assert::count(1, $science['announcements']);
        Assert::same('continuity-1', $science['announcements'][0]['transitionId']);
    }

    // ---------- channel bump scheduling ----------

    private function createBump(): string
    {
        return bump_admin_create($this->validBody(), $this->bumpsDir, $this->mediaRoot)['bump']['id'];
    }

    public function testNormalizeScheduleRuleRejectsAnUnknownBumpId(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_normalize_schedule_rule(['bumpId' => 'does-not-exist', 'every' => 'hour', 'durationSeconds' => 12], $this->bumpsDir);
        });
    }

    public function testNormalizeScheduleRuleRejectsAnUnknownPeriod(): void
    {
        $id = $this->createBump();
        Assert::throws(BumpAdminValidationError::class, function () use ($id): void {
            bump_admin_normalize_schedule_rule(['bumpId' => $id, 'every' => 'fortnight', 'durationSeconds' => 12], $this->bumpsDir);
        });
    }

    public function testNormalizeScheduleRuleDefaultsOffsetToZero(): void
    {
        $id = $this->createBump();
        $rule = bump_admin_normalize_schedule_rule(['bumpId' => $id, 'every' => 'hour', 'durationSeconds' => 12], $this->bumpsDir);
        Assert::same(0.0, $rule['offsetSeconds']);
    }

    public function testNormalizeScheduleRuleRejectsAnOffsetAtOrPastThePeriod(): void
    {
        $id = $this->createBump();
        Assert::throws(BumpAdminValidationError::class, function () use ($id): void {
            bump_admin_normalize_schedule_rule(['bumpId' => $id, 'every' => 'hour', 'offsetSeconds' => 3600, 'durationSeconds' => 12], $this->bumpsDir);
        });
    }

    public function testNormalizeScheduleRuleRejectsANonPositiveDuration(): void
    {
        $id = $this->createBump();
        Assert::throws(BumpAdminValidationError::class, function () use ($id): void {
            bump_admin_normalize_schedule_rule(['bumpId' => $id, 'every' => 'hour', 'durationSeconds' => 0], $this->bumpsDir);
        });
    }

    public function testNormalizeScheduleRejectsMoreThanTheRuleLimit(): void
    {
        $id = $this->createBump();
        $rules = array_fill(0, BUMP_ADMIN_MAX_SCHEDULE_RULES + 1, ['bumpId' => $id, 'every' => 'hour', 'durationSeconds' => 12]);
        Assert::throws(BumpAdminValidationError::class, function () use ($rules): void {
            bump_admin_normalize_schedule(['rules' => $rules], $this->bumpsDir);
        });
    }

    public function testSaveScheduleRejectsUnknownChannel(): void
    {
        Assert::throws(BumpAdminValidationError::class, function (): void {
            bump_admin_save_schedule(['channel_id' => 'no-such-channel', 'enabled' => true, 'rules' => []], $this->channelsDir, $this->bumpsDir);
        });
    }

    public function testSaveScheduleWritesBumpScheduleJsonForTheChannel(): void
    {
        $id = $this->createBump();
        $result = bump_admin_save_schedule(
            ['channel_id' => 'science', 'enabled' => true, 'rules' => [['bumpId' => $id, 'every' => 'hour', 'durationSeconds' => 12]]],
            $this->channelsDir,
            $this->bumpsDir,
        );
        Assert::true($result['schedule']['enabled']);
        Assert::count(1, $result['schedule']['rules']);
        $written = json_decode((string) file_get_contents("$this->channelsDir/science/bump-schedule.json"), true);
        Assert::same($id, $written['rules'][0]['bumpId']);
        Assert::same('hour', $written['rules'][0]['every']);
    }

    public function testListSchedulesIncludesEveryChannelEvenWithoutAScheduleFile(): void
    {
        $list = bump_admin_list_schedules($this->channelsDir);
        $byId = [];
        foreach ($list as $c) {
            $byId[$c['id']] = $c;
        }
        Assert::true(isset($byId['science']));
        Assert::true(!$byId['science']['enabled']);
        Assert::count(0, $byId['science']['rules']);
    }

    public function testListSchedulesReflectsASavedSchedule(): void
    {
        $id = $this->createBump();
        bump_admin_save_schedule(
            ['channel_id' => 'science', 'enabled' => true, 'rules' => [['bumpId' => $id, 'every' => 'halfHour', 'durationSeconds' => 8]]],
            $this->channelsDir,
            $this->bumpsDir,
        );
        $list = bump_admin_list_schedules($this->channelsDir);
        $science = null;
        foreach ($list as $c) {
            if ($c['id'] === 'science') {
                $science = $c;
            }
        }
        Assert::notNull($science);
        Assert::true($science['enabled']);
        Assert::same('halfHour', $science['rules'][0]['every']);
    }

    public function testListSchedulesAddsLogoAndAccentDisplayHints(): void
    {
        file_put_contents("$this->channelsDir/science/meta.json", json_encode(['name' => 'Science & Engineering', 'logo' => 'logo.svg', 'theme' => ['accent' => '#4dd8e6']]));
        file_put_contents("$this->channelsDir/science/logo.svg", '<svg/>');
        mkdir("$this->channelsDir/plain", 0775, true);
        file_put_contents("$this->channelsDir/plain/meta.json", json_encode(['name' => 'Plain', 'logo' => 'missing.svg', 'theme' => ['accent' => 'red; x']]));
        $byId = [];
        foreach (bump_admin_list_schedules($this->channelsDir) as $c) {
            $byId[$c['id']] = $c;
        }
        Assert::same('channels/science/logo.svg', $byId['science']['logo']);
        Assert::same('#4dd8e6', $byId['science']['accent']);
        Assert::null($byId['plain']['logo']); // a logo file that doesn't exist is not advertised
        Assert::null($byId['plain']['accent']); // nor a non-color accent
    }
}
