<?php
declare(strict_types=1);

final class RotationStateTest
{
    private string $stateDir;

    public function setUp(): void
    {
        $this->stateDir = sys_get_temp_dir() . '/publish-rotation-test-' . bin2hex(random_bytes(4));
    }

    public function tearDown(): void
    {
        if (is_dir($this->stateDir)) {
            foreach (glob($this->stateDir . '/*') ?: [] as $f) {
                unlink($f);
            }
            rmdir($this->stateDir);
        }
    }

    private function utc(string $s): DateTimeImmutable
    {
        return new DateTimeImmutable($s, new DateTimeZone('UTC'));
    }

    public function testLoadWithNoFileReturnsAFreshEmptyStateNotAReset(): void
    {
        $s = RotationState::load($this->stateDir, 'chan', 'b', 1);
        Assert::same(0, $s['cursor']);
        Assert::count(0, $s['deferred']);
        Assert::null($s['checkpoint_occurrence_index']);
        Assert::true(!$s['reset'], 'a fresh, never-published block is not a "reset" -- it just has nothing yet');
    }

    public function testSaveThenLoadRoundTripsExactly(): void
    {
        RotationState::save($this->stateDir, 'chan', 'b', 1, 5, [['episode_id' => 'e9', 'pinned_index' => 2]], 0, 10, $this->utc('2026-11-04T00:00:00Z'));
        $s = RotationState::load($this->stateDir, 'chan', 'b', 1);
        Assert::same(5, $s['cursor']);
        Assert::same(['episode_id' => 'e9', 'pinned_index' => 2], $s['deferred'][0]);
        Assert::same(10, $s['checkpoint_occurrence_index']);
    }

    public function testAPinVersionMismatchResetsWithAWarningReason(): void
    {
        RotationState::save($this->stateDir, 'chan', 'b', 1, 5, [], 0, 10, $this->utc('2026-11-04T00:00:00Z'));
        $s = RotationState::load($this->stateDir, 'chan', 'b', 2); // pin was refreshed to version 2
        Assert::same(0, $s['cursor']);
        Assert::true($s['reset']);
        Assert::notNull($s['resetReason']);
    }

    public function testSaveNeverRegressesAnAlreadyAdvancedCheckpointForTheSamePinVersion(): void
    {
        RotationState::save($this->stateDir, 'chan', 'b', 1, 5, [], 0, 20, $this->utc('2026-11-10T00:00:00Z'));
        RotationState::save($this->stateDir, 'chan', 'b', 1, 999, [], 0, 5, $this->utc('2026-11-01T00:00:00Z')); // earlier index -- must be ignored
        $s = RotationState::load($this->stateDir, 'chan', 'b', 1);
        Assert::same(5, $s['cursor'], 'the regression attempt (cursor 999) must never have been written');
        Assert::same(20, $s['checkpoint_occurrence_index']);
    }

    public function testDifferentBlocksOfTheSameChannelAreIndependentFiles(): void
    {
        RotationState::save($this->stateDir, 'chan', 'morning', 1, 3, [], 0, 1, $this->utc('2026-11-01T00:00:00Z'));
        RotationState::save($this->stateDir, 'chan', 'evening', 1, 7, [], 0, 1, $this->utc('2026-11-01T00:00:00Z'));
        Assert::same(3, RotationState::load($this->stateDir, 'chan', 'morning', 1)['cursor']);
        Assert::same(7, RotationState::load($this->stateDir, 'chan', 'evening', 1)['cursor']);
    }
}
