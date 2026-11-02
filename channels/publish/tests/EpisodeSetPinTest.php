<?php
declare(strict_types=1);

final class EpisodeSetPinTest
{
    private string $dir;

    public function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/publish-pin-test-' . bin2hex(random_bytes(4));
    }

    public function tearDown(): void
    {
        if (is_dir($this->dir)) {
            foreach (glob($this->dir . '/*') ?: [] as $f) {
                unlink($f);
            }
            rmdir($this->dir);
        }
    }

    public function testFirstResolveCreatesAVersionOnePinFromTheGivenIds(): void
    {
        $r = EpisodeSetPin::resolve($this->dir, 'chan', 'block1', ['a', 'b', 'c'], false);
        Assert::same(['a', 'b', 'c'], $r['episodeIds']);
        Assert::same(1, $r['version']);
        Assert::true($r['refreshed']);
    }

    public function testSubsequentResolveWithoutRefreshReusesThePinnedListEvenIfInputChanged(): void
    {
        EpisodeSetPin::resolve($this->dir, 'chan', 'block1', ['a', 'b'], false);
        $r = EpisodeSetPin::resolve($this->dir, 'chan', 'block1', ['a', 'b', 'c', 'd'], false);
        Assert::same(['a', 'b'], $r['episodeIds'], 'the pinned set must not shift just because series.json now has more approved episodes');
        Assert::same(1, $r['version']);
        Assert::true(!$r['refreshed']);
    }

    public function testRefreshFlagBumpsTheVersionAndAdoptsTheNewList(): void
    {
        EpisodeSetPin::resolve($this->dir, 'chan', 'block1', ['a', 'b'], false);
        $r = EpisodeSetPin::resolve($this->dir, 'chan', 'block1', ['a', 'b', 'c'], true);
        Assert::same(['a', 'b', 'c'], $r['episodeIds']);
        Assert::same(2, $r['version']);
        Assert::true($r['refreshed']);

        // and it stays pinned at the new list afterward, without --refresh
        $after = EpisodeSetPin::resolve($this->dir, 'chan', 'block1', ['a', 'b', 'c', 'd', 'e'], false);
        Assert::same(['a', 'b', 'c'], $after['episodeIds']);
        Assert::same(2, $after['version']);
    }

    public function testDifferentBlocksForTheSameChannelHaveIndependentPins(): void
    {
        EpisodeSetPin::resolve($this->dir, 'chan', 'morning', ['a'], false);
        EpisodeSetPin::resolve($this->dir, 'chan', 'evening', ['x', 'y'], false);
        $morning = EpisodeSetPin::resolve($this->dir, 'chan', 'morning', ['a', 'b'], false);
        $evening = EpisodeSetPin::resolve($this->dir, 'chan', 'evening', ['x', 'y', 'z'], false);
        Assert::same(['a'], $morning['episodeIds']);
        Assert::same(['x', 'y'], $evening['episodeIds']);
    }

    public function testPinStateSurvivesAFreshResolveCallAsASeparateProcessWould(): void
    {
        EpisodeSetPin::resolve($this->dir, 'chan', 'block1', ['a', 'b'], false);
        // Simulate a brand-new CLI invocation: nothing but the state dir
        // on disk carries information forward.
        $r = EpisodeSetPin::resolve($this->dir, 'chan', 'block1', ['z'], false);
        Assert::same(['a', 'b'], $r['episodeIds']);
    }
}
