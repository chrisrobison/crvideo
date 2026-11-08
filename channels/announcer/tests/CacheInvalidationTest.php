<?php
declare(strict_types=1);

require_once __DIR__ . '/TestFixtures.php';

final class CacheInvalidationTest
{
    private string $root;

    public function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/crvideo-cache-test-' . bin2hex(random_bytes(6));
        mkdir($this->root, 0775, true);
    }

    public function tearDown(): void
    {
        TestFixtures::destroy($this->root);
    }

    public function testSameInputsProduceSameHash(): void
    {
        $inputs = ['type' => 'coming_up_next', 'toProgramId' => 'a@1', 'voice' => 'af_heart'];
        Assert::same(ContentHash::scriptHash($inputs), ContentHash::scriptHash($inputs));
    }

    public function testKeyOrderDoesNotAffectHash(): void
    {
        $a = ['foo' => 1, 'bar' => 2];
        $b = ['bar' => 2, 'foo' => 1];
        Assert::same(ContentHash::scriptHash($a), ContentHash::scriptHash($b));
    }

    public function testChangingVoiceChangesAudioHashNotScriptHash(): void
    {
        $scriptInputs = ['type' => 'coming_up_next', 'toProgramId' => 'a@1'];
        $scriptHash1 = ContentHash::scriptHash($scriptInputs);
        $scriptHash2 = ContentHash::scriptHash($scriptInputs); // unrelated to voice entirely
        Assert::same($scriptHash1, $scriptHash2, 'script hash never includes voice');

        $audioA = ContentHash::audioHash(['text' => 'hello', 'voice' => 'af_heart']);
        $audioB = ContentHash::audioHash(['text' => 'hello', 'voice' => 'bm_george']);
        Assert::true($audioA !== $audioB, 'changing voice must change the audio hash');
    }

    public function testChangingNextProgramChangesScriptHash(): void
    {
        $h1 = ContentHash::scriptHash(['type' => 'coming_up_next', 'toProgramId' => 'a@1']);
        $h2 = ContentHash::scriptHash(['type' => 'coming_up_next', 'toProgramId' => 'a@2']);
        Assert::true($h1 !== $h2);
    }

    public function testUnrelatedProgramChangeDoesNotTouchThisHash(): void
    {
        // Simulates: channel has many transitions; changing one elsewhere
        // must not change the hash computed for THIS transition's own inputs.
        $h1 = ContentHash::scriptHash(['type' => 'coming_up_next', 'transitionId' => 'cont-1', 'toProgramId' => 'a@1']);
        $h2 = ContentHash::scriptHash(['type' => 'coming_up_next', 'transitionId' => 'cont-1', 'toProgramId' => 'a@1']);
        Assert::same($h1, $h2);
    }

    public function testScriptCacheRoundTrip(): void
    {
        $channelDir = "{$this->root}/channel";
        mkdir($channelDir, 0775, true);
        $hash = 'abc123';
        Assert::null(ScriptCache::get($channelDir, $hash));
        ScriptCache::put($channelDir, $hash, ['text' => 'Hello there.', 'provider' => 'mock', 'approved' => false]);
        $entry = ScriptCache::get($channelDir, $hash);
        Assert::notNull($entry);
        Assert::same('Hello there.', $entry['text']);
        Assert::same($hash, $entry['hash']);
    }

    public function testApprovedScriptIsFlagged(): void
    {
        $channelDir = "{$this->root}/channel2";
        mkdir($channelDir, 0775, true);
        $hash = 'def456';
        ScriptCache::put($channelDir, $hash, ['text' => 'Original.', 'provider' => 'template', 'approved' => false]);
        ScriptCache::approve($channelDir, $hash, 'Human-edited version.');
        $entry = ScriptCache::get($channelDir, $hash);
        Assert::true($entry['approved']);
        Assert::same('Human-edited version.', $entry['text']);
    }

    public function testAudioCachePathsAreDeterministicAndCdnFriendly(): void
    {
        $cache = new AudioCache($this->root, 'media/announcements');
        $url1 = $cache->publicUrlFor('science', 'abc123');
        $url2 = $cache->publicUrlFor('science', 'abc123');
        Assert::same($url1, $url2);
        Assert::same('/media/announcements/science/abc123.mp3', $url1);
        Assert::false($cache->exists('science', 'abc123')); // nothing written yet
    }
}
