<?php
declare(strict_types=1);

// channels/publish/tests/ScheduleWriterTest.php
//
// Covers Phase 3/4/7 of docs/guide-update.md's additions to ScheduleWriter:
// the top-level "programs" collection (window-relative, omitted when empty
// for backward compatibility) and attributing a genuinely unfilled block
// remainder -- a plain "gap" item ContinuityFiller never even saw, because
// this channel has no continuity.json at all -- to its own enclosing
// program, so the EPG's program-level cell and this gap never end up as
// two overlapping guide timeline entries.

final class ScheduleWriterTest
{
    private string $path;

    public function setUp(): void
    {
        $this->path = sys_get_temp_dir() . '/schedule-writer-test-' . bin2hex(random_bytes(4)) . '.json';
    }

    public function tearDown(): void
    {
        foreach ([$this->path, $this->path . '.bak'] as $f) {
            if (is_file($f)) {
                unlink($f);
            }
        }
    }

    private function utc(string $s): DateTimeImmutable
    {
        return new DateTimeImmutable($s, new DateTimeZone('UTC'));
    }

    private function videoItem(string $id, int $start, int $end, ?string $programId = null): array
    {
        return [
            'start' => $start, 'end' => $end, 'id' => $id, 'title' => "Title $id",
            'source' => ['provider' => 'youtube', 'video_id' => "v-$id", 'url' => "https://example.test/$id"],
            'source_url' => "https://example.test/$id",
            ...($programId !== null ? ['program_id' => $programId] : []),
        ];
    }

    private function program(string $occurrenceId, string $blockId, int $start, int $end, string $title): array
    {
        return [
            'occurrence_id' => $occurrenceId, 'block_id' => $blockId, 'title' => $title, 'description' => null,
            'series_id' => 's', 'series_title' => 'S', 'boundary_mode' => 'hard',
            'nominal_start' => $start, 'nominal_end' => $end, 'start' => $start, 'end' => $end,
        ];
    }

    public function testProgramsKeyIsOmittedEntirelyWhenThereAreNoPrograms(): void
    {
        $items = [$this->videoItem('e1', 0, 500)];
        $schedule = ScheduleWriter::writeSchedule($this->path, 'Chan', $items, $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-02T00:10:00Z'), []);
        Assert::true(!array_key_exists('programs', $schedule), 'identical to every schedule.json written before this feature existed');
    }

    public function testProgramsAreWrittenAsWindowRelativeSecondsLikeEveryItem(): void
    {
        $windowStart = $this->utc('2026-11-02T00:00:00Z');
        $absoluteStart = $windowStart->getTimestamp() + 3600;
        $items = [$this->videoItem('e1', $absoluteStart, $absoluteStart + 500, 'b@' . $absoluteStart)];
        $programs = [$this->program('b@' . $absoluteStart, 'b', $absoluteStart, $absoluteStart + 3600, 'My Show')];
        $schedule = ScheduleWriter::writeSchedule($this->path, 'Chan', $items, $windowStart, $windowStart->modify('+1 day'), [], $programs);
        Assert::count(1, $schedule['programs']);
        Assert::same(3600, $schedule['programs'][0]['start'], 'relative to the window start, same convention as items');
        Assert::same(7200, $schedule['programs'][0]['end']);
        Assert::same('b@' . $absoluteStart, $schedule['blocks'][0]['items'][1]['program_id'], 'the video item (after the leading gap) carries the matching reference');
    }

    public function testAGenuinelyUnfilledRemainderInsideAProgramsWindowIsTaggedWithThatProgramId(): void
    {
        // A one-hour program whose single episode only used the first 500s of it
        // (e.g. packing's minimum_remaining deferred the next one) -- and this
        // channel has no continuity.json, so nothing ever filled the remaining
        // 3100s. ScheduleWriter itself is the only place that gap gets written.
        $windowStart = $this->utc('2026-11-02T00:00:00Z');
        $start = $windowStart->getTimestamp();
        $items = [$this->videoItem('e1', $start, $start + 500, 'b@' . $start)];
        $programs = [$this->program('b@' . $start, 'b', $start, $start + 3600, 'My Show')];
        $schedule = ScheduleWriter::writeSchedule($this->path, 'Chan', $items, $windowStart, $windowStart->modify('+2 hour'), [], $programs);

        $gap = null;
        foreach ($schedule['blocks'][0]['items'] as $it) {
            if ($it['type'] === 'gap' && $it['start'] === 500) {
                $gap = $it;
            }
        }
        Assert::notNull($gap, 'precondition: there is a gap item covering the program\'s own under-filled remainder');
        Assert::same('b@' . $start, $gap['program_id'] ?? null, 'the unfilled remainder belongs to the program whose window fully contains it');
        Assert::same(3100, $gap['duration'], 'bounded by the programs own end -- 3600 (program end) - 500 (where its content stopped)');
    }

    public function testASingleRawGapStraddlingAProgramsEndIsSplitRatherThanLeftUntagged(): void
    {
        // The unfilled remainder (500..3600) is still this program's own slot;
        // what comes after its nominal end (3600..7200, nothing else scheduled
        // in this 2-hour window) is genuinely uncovered time and must not be
        // folded into the program's cell.
        $windowStart = $this->utc('2026-11-02T00:00:00Z');
        $start = $windowStart->getTimestamp();
        $items = [$this->videoItem('e1', $start, $start + 500, 'b@' . $start)];
        $programs = [$this->program('b@' . $start, 'b', $start, $start + 3600, 'My Show')];
        $schedule = ScheduleWriter::writeSchedule($this->path, 'Chan', $items, $windowStart, $windowStart->modify('+2 hour'), [], $programs);

        $gaps = array_values(array_filter($schedule['blocks'][0]['items'], static fn ($it) => $it['type'] === 'gap'));
        Assert::count(2, $gaps, 'one raw gap split into its in-program and out-of-program segments');
        Assert::same(500, $gaps[0]['start']);
        Assert::same(3100, $gaps[0]['duration']);
        Assert::same('b@' . $start, $gaps[0]['program_id']);
        Assert::same(3600, $gaps[1]['start']);
        Assert::same(3600, $gaps[1]['duration']);
        Assert::true(!isset($gaps[1]['program_id']));
    }

    public function testAGapOutsideEveryProgramsWindowIsNeverTagged(): void
    {
        $windowStart = $this->utc('2026-11-02T00:00:00Z');
        $start = $windowStart->getTimestamp();
        // Program ends at +1800s; the next item (unrelated, no program) starts at
        // +2400s -- the 600s in between is a genuine, unattributed station break.
        $items = [
            $this->videoItem('e1', $start, $start + 1800, 'b@' . $start),
            $this->videoItem('e2', $start + 2400, $start + 2700),
        ];
        $programs = [$this->program('b@' . $start, 'b', $start, $start + 1800, 'My Show')];
        $schedule = ScheduleWriter::writeSchedule($this->path, 'Chan', $items, $windowStart, $windowStart->modify('+1 hour'), [], $programs);

        $gap = null;
        foreach ($schedule['blocks'][0]['items'] as $it) {
            if ($it['type'] === 'gap' && $it['start'] === 1800) {
                $gap = $it;
            }
        }
        Assert::notNull($gap);
        Assert::true(!isset($gap['program_id']), 'a genuine inter-program gap must never be mislabeled as part of a program');
    }
}
