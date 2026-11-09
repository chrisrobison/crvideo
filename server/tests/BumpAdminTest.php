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

    // ---------- media listing ----------

    public function testListMediaFindsFixtureFilesByExtension(): void
    {
        $media = bump_admin_list_media($this->repoRoot, $this->channelsDir);
        Assert::count(1, $media['video']);
        Assert::same('bg05.mp4', $media['video'][0]['name']);
        Assert::count(1, $media['music']);
        Assert::count(1, $media['ambience']);
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
}
