<?php
declare(strict_types=1);

require_once __DIR__ . '/TestFixtures.php';

// channels/announcer/tests/AnnouncerGcTest.php
//
// Covers AnnouncerGc::sweepChannel()'s core claim: it is a mark-and-sweep
// against the CURRENT manifest, not a date-based purge -- a live-hash
// file must survive no matter how old it is, and an unreferenced file
// must be removed no matter how it got there, but only once it's past
// the grace window (so an in-flight write is never mistaken for garbage).

final class AnnouncerGcTest
{
    private string $root;
    private string $channelDir;
    private string $mediaDir;

    public function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/crvideo-gc-test-' . bin2hex(random_bytes(6));
        $this->channelDir = "{$this->root}/channel";
        $this->mediaDir = "{$this->root}/media/test-channel";
        mkdir($this->channelDir, 0775, true);
        mkdir($this->mediaDir, 0775, true);
        mkdir(ScriptCache::dirFor($this->channelDir), 0775, true);
        mkdir("{$this->channelDir}/.announcer/jobs/done", 0775, true);
        mkdir("{$this->channelDir}/.announcer/jobs/error", 0775, true);
    }

    public function tearDown(): void
    {
        TestFixtures::destroy($this->root);
    }

    private function writeManifest(array $announcements): void
    {
        file_put_contents("{$this->channelDir}/announcements.json", json_encode([
            'schema_version' => 1,
            'announcements' => $announcements,
        ]));
    }

    private function hash(string $seed): string
    {
        return hash('sha256', $seed);
    }

    /** Creates a file and backdates its mtime so it clears the grace window. */
    private function touchOld(string $path, int $secondsAgo = 7200): void
    {
        file_put_contents($path, 'x');
        touch($path, time() - $secondsAgo);
    }

    public function testLiveAudioHashSurvivesNoMatterHowOld(): void
    {
        $liveHash = $this->hash('live-audio');
        $this->writeManifest([['audioHash' => $liveHash, 'scriptHash' => null]]);
        $this->touchOld("{$this->mediaDir}/$liveHash.mp3", secondsAgo: 999_999);

        $result = AnnouncerGc::sweepChannel('test-channel', $this->channelDir, $this->mediaDir, 3600, 1_209_600, dryRun: false);

        Assert::count(0, $result['audioRemoved'], 'a file referenced by the current manifest must never be swept');
        Assert::true(is_file("{$this->mediaDir}/$liveHash.mp3"), 'live audio file must still exist on disk');
    }

    public function testUnreferencedAudioIsRemovedPastGraceWindow(): void
    {
        $orphanHash = $this->hash('orphan-audio');
        $this->writeManifest([]); // nothing references it
        $this->touchOld("{$this->mediaDir}/$orphanHash.mp3", secondsAgo: 7200);

        $result = AnnouncerGc::sweepChannel('test-channel', $this->channelDir, $this->mediaDir, 3600, 1_209_600, dryRun: false);

        Assert::count(1, $result['audioRemoved']);
        Assert::false(is_file("{$this->mediaDir}/$orphanHash.mp3"), 'orphaned audio file must be deleted');
    }

    public function testUnreferencedAudioWithinGraceWindowIsSpared(): void
    {
        $freshHash = $this->hash('fresh-unreferenced-audio');
        $this->writeManifest([]); // manifest upsert for it just hasn't landed yet
        file_put_contents("{$this->mediaDir}/$freshHash.mp3", 'x'); // mtime = now

        $result = AnnouncerGc::sweepChannel('test-channel', $this->channelDir, $this->mediaDir, 3600, 1_209_600, dryRun: false);

        Assert::count(0, $result['audioRemoved'], 'a file newer than the grace window must never be swept, even if unreferenced');
        Assert::true(is_file("{$this->mediaDir}/$freshHash.mp3"));
    }

    public function testDryRunReportsWithoutDeletingAnything(): void
    {
        $orphanHash = $this->hash('dry-run-orphan');
        $this->writeManifest([]);
        $path = "{$this->mediaDir}/$orphanHash.mp3";
        $this->touchOld($path, secondsAgo: 7200);

        $result = AnnouncerGc::sweepChannel('test-channel', $this->channelDir, $this->mediaDir, 3600, 1_209_600, dryRun: true);

        Assert::count(1, $result['audioRemoved'], 'dry-run still reports what it would remove');
        Assert::true(is_file($path), 'dry-run must never actually delete');
    }

    public function testScriptCacheFollowsTheSameLiveSetRule(): void
    {
        $liveScript = $this->hash('live-script');
        $orphanScript = $this->hash('orphan-script');
        $this->writeManifest([['audioHash' => null, 'scriptHash' => $liveScript]]);
        $this->touchOld(ScriptCache::dirFor($this->channelDir) . "/$liveScript.json", secondsAgo: 999_999);
        $this->touchOld(ScriptCache::dirFor($this->channelDir) . "/$orphanScript.json", secondsAgo: 7200);

        $result = AnnouncerGc::sweepChannel('test-channel', $this->channelDir, $this->mediaDir, 3600, 1_209_600, dryRun: false);

        Assert::count(1, $result['scriptsRemoved']);
        Assert::true(is_file(ScriptCache::dirFor($this->channelDir) . "/$liveScript.json"));
        Assert::false(is_file(ScriptCache::dirFor($this->channelDir) . "/$orphanScript.json"));
    }

    public function testJobHistoryIsPurelyAgeBasedRegardlessOfLiveSet(): void
    {
        // Even a scriptHash that IS still live in the manifest should have its
        // old done/error job record expire -- job history is a dedup record,
        // not an output cache (see AnnouncerGc's docblock on JobQueue::enqueue()'s
        // "any existing file for this id, including stale ones, blocks re-enqueueing").
        $liveScript = $this->hash('live-script-with-old-job');
        $this->writeManifest([['audioHash' => null, 'scriptHash' => $liveScript]]);
        $this->touchOld("{$this->channelDir}/.announcer/jobs/done/$liveScript.json", secondsAgo: 30 * 86400);

        $result = AnnouncerGc::sweepChannel('test-channel', $this->channelDir, $this->mediaDir, 3600, 14 * 86400, dryRun: false);

        Assert::count(1, $result['jobsRemoved'], 'a job record past retention expires even if its hash is still live');
    }

    public function testJobHistoryWithinRetentionIsKept(): void
    {
        $scriptHash = $this->hash('recent-job');
        $this->writeManifest([]);
        $this->touchOld("{$this->channelDir}/.announcer/jobs/done/$scriptHash.json", secondsAgo: 3600);

        $result = AnnouncerGc::sweepChannel('test-channel', $this->channelDir, $this->mediaDir, 3600, 14 * 86400, dryRun: false);

        Assert::count(0, $result['jobsRemoved'], 'a job record within the retention window must be kept');
    }

    public function testNonHashNamedFilesAreNeverTouched(): void
    {
        // Defends listHashFiles()'s filename guard: only bare-hex-named files
        // are ever candidates for deletion, so a manifest's own .lock/.bak
        // files (which live alongside the scripts dir via ScriptCache::dirFor())
        // or anything hand-placed can never be swept by accident.
        $this->writeManifest([]);
        $weird = "{$this->mediaDir}/README.mp3";
        $this->touchOld($weird, secondsAgo: 999_999);

        $result = AnnouncerGc::sweepChannel('test-channel', $this->channelDir, $this->mediaDir, 3600, 1_209_600, dryRun: false);

        Assert::count(0, $result['audioRemoved']);
        Assert::true(is_file($weird));
    }
}
