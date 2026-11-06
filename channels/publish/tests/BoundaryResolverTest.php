<?php
declare(strict_types=1);

final class BoundaryResolverTest
{
    private function item(string $id, int $start, int $duration): array
    {
        return ['start' => $start, 'end' => $start + $duration, 'id' => $id, 'title' => $id, 'source' => null, 'source_url' => null];
    }

    private function group(string $blockId, array $boundary, int $nominalStart, array $items): array
    {
        return ['blockId' => $blockId, 'boundary' => BoundaryResolver::normalizeBoundary($boundary, $blockId), 'nominalStart' => $nominalStart, 'items' => $items];
    }

    /** Same as group() but with the Phase 2/3 program-identity keys populated,
     *  the same shape ProgrammingCompiler actually builds. */
    private function programGroup(string $blockId, array $boundary, int $nominalStart, int $durationSeconds, array $items, string $title = 'Title'): array
    {
        return [
            ...$this->group($blockId, $boundary, $nominalStart, $items),
            'durationSeconds' => $durationSeconds,
            'occurrenceId' => "$blockId@$nominalStart",
            'programTitle' => $title,
            'programDescription' => null,
            'seriesId' => 's',
            'seriesTitle' => 'S',
        ];
    }

    public function testDefaultBoundaryIsHardWhenAbsent(): void
    {
        $b = BoundaryResolver::normalizeBoundary(null, 'b');
        Assert::same('hard', $b['mode']);
    }

    public function testHardBoundaryIsPreservedWhenThereIsNoOverlap(): void
    {
        $groups = [
            $this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 500)]),
            $this->group('b', ['mode' => 'hard'], 1500, [$this->item('e2', 1500, 500)]),
        ];
        $result = BoundaryResolver::resolve($groups);
        Assert::same(1000, $result['items'][0]['start']);
        Assert::same(1500, $result['items'][1]['start'], 'hard boundary never moves, even by one second');
        Assert::count(0, $result['warnings']);
    }

    public function testHardBoundaryViolatedByAnOverlapIsRejected(): void
    {
        $groups = [
            $this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 600)]), // ends 1600
            $this->group('b', ['mode' => 'hard'], 1500, [$this->item('e2', 1500, 500)]), // starts before 1600
        ];
        Assert::throws(RuntimeException::class, function () use ($groups): void {
            BoundaryResolver::resolve($groups);
        });
    }

    public function testSoftBoundaryWithinToleranceDelaysExplicitly(): void
    {
        $groups = [
            $this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 700)]), // ends 1700, 100s late for b
            $this->group('b', ['mode' => 'soft', 'max_delay' => 300], 1600, [$this->item('e2', 1600, 500)]),
        ];
        $result = BoundaryResolver::resolve($groups);
        Assert::same(1700, $result['items'][1]['start'], 'pushed to exactly where the previous occurrence ends');
        Assert::same(100, $result['items'][1]['delay_seconds']);
        Assert::count(1, $result['warnings']);
    }

    public function testSoftBoundaryExceedingToleranceIsRejected(): void
    {
        $groups = [
            $this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 1000)]), // ends 2000, 400s late for b
            $this->group('b', ['mode' => 'soft', 'max_delay' => 300], 1600, [$this->item('e2', 1600, 500)]),
        ];
        Assert::throws(RuntimeException::class, function () use ($groups): void {
            BoundaryResolver::resolve($groups);
        });
    }

    public function testAdjacentSoftBlocksCascadeTheDelayChronologically(): void
    {
        $groups = [
            $this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 700)]), // ends 1700
            $this->group('b', ['mode' => 'soft', 'max_delay' => 600], 1600, [$this->item('e2', 1600, 400)]), // pushed to 1700, ends 2100
            $this->group('c', ['mode' => 'soft', 'max_delay' => 600], 2000, [$this->item('e3', 2000, 300)]), // pushed to 2100 too (cascaded)
        ];
        $result = BoundaryResolver::resolve($groups);
        Assert::same(1700, $result['items'][1]['start']);
        Assert::same(2100, $result['items'][2]['start']);
        Assert::same(100, $result['items'][2]['delay_seconds'], 'computed against the already-cascaded previous end (2100), not a stale nominal one');
    }

    public function testSoftBlockFollowedByHardBlockStillEnforcesTheHardAnchor(): void
    {
        $groups = [
            $this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 700)]), // ends 1700
            $this->group('b', ['mode' => 'soft', 'max_delay' => 600], 1600, [$this->item('e2', 1600, 400)]), // pushed to 1700, ends 2100
            $this->group('c', ['mode' => 'hard'], 2050, []), // only 50s of slack before this hard anchor -- impossible
        ];
        // Give block c a real item so the impossibility actually manifests.
        $groups[2]['items'] = [$this->item('e3', 2050, 300)];
        Assert::throws(RuntimeException::class, function () use ($groups): void {
            BoundaryResolver::resolve($groups);
        });
    }

    public function testSoftBlockFollowedByHardBlockThatStillFitsSucceeds(): void
    {
        $groups = [
            $this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 700)]), // ends 1700
            $this->group('b', ['mode' => 'soft', 'max_delay' => 600], 1600, [$this->item('e2', 1600, 400)]), // pushed to 1700, ends 2100
            $this->group('c', ['mode' => 'hard'], 2100, [$this->item('e3', 2100, 300)]), // exactly touches -- fine
        ];
        $result = BoundaryResolver::resolve($groups);
        Assert::same(2100, $result['items'][2]['start']);
        Assert::true(!isset($result['items'][2]['delay_seconds']));
    }

    public function testElasticBehavesLikeSoftWithItsOwnExplicitMaxDelay(): void
    {
        $groups = [
            $this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 700)]), // ends 1700, 100s late for b
            $this->group('b', ['mode' => 'elastic', 'max_delay' => 300], 1600, [$this->item('e2', 1600, 500)]),
        ];
        $result = BoundaryResolver::resolve($groups);
        Assert::same(1700, $result['items'][1]['start']);
        Assert::same(100, $result['items'][1]['delay_seconds']);
    }

    public function testSoftModeRequiresAnExplicitNonNegativeMaxDelay(): void
    {
        Assert::throws(RuntimeException::class, function (): void {
            BoundaryResolver::normalizeBoundary(['mode' => 'soft'], 'b');
        });
        Assert::throws(RuntimeException::class, function (): void {
            BoundaryResolver::normalizeBoundary(['mode' => 'soft', 'max_delay' => -1], 'b');
        });
    }

    public function testInvalidBoundaryModeIsRejected(): void
    {
        Assert::throws(RuntimeException::class, function (): void {
            BoundaryResolver::normalizeBoundary(['mode' => 'bogus'], 'b');
        });
    }

    public function testEmptyGroupsAreSkippedAndNeverCountAsAPreviousOccurrence(): void
    {
        $groups = [
            $this->group('a', ['mode' => 'hard'], 1000, []), // nothing scheduled -- a gap, not an occurrence
            $this->group('b', ['mode' => 'hard'], 1500, [$this->item('e2', 1500, 100)]),
        ];
        $result = BoundaryResolver::resolve($groups);
        Assert::count(1, $result['items']);
        Assert::same(1500, $result['items'][0]['start']);
    }

    public function testResolutionIsDeterministicAndOrderIndependentOfInputOrder(): void
    {
        $a = $this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 700)]);
        $b = $this->group('b', ['mode' => 'soft', 'max_delay' => 600], 1600, [$this->item('e2', 1600, 400)]);
        $r1 = BoundaryResolver::resolve([$a, $b]);
        $r2 = BoundaryResolver::resolve([$b, $a]); // fed out of nominal order -- resolver must sort first
        Assert::same(json_encode($r1['items']), json_encode($r2['items']));
    }

    public function testDelayArithmeticIsPlainElapsedSecondsNotCalendarMathSoDstNeverMattersHere(): void
    {
        // Spans the US fall-back transition (2026-11-01, America/Los_Angeles: 02:00
        // becomes 01:00 again -- a 25-real-hour day). 00:30 to 03:30 LOOKS like 3
        // wall-clock hours but is actually 4 real hours because of the repeated hour.
        // BoundaryResolver only ever sees already-resolved absolute Unix instants
        // (Recurrence's job is done by the time these reach it), so its delay
        // arithmetic -- plain integer subtraction -- gets this right automatically,
        // with no DST-awareness of its own needed.
        $tz = new DateTimeZone('America/Los_Angeles');
        $aStart = (new DateTimeImmutable('2026-11-01 00:30:00', $tz))->getTimestamp();
        $bNominal = (new DateTimeImmutable('2026-11-01 03:30:00', $tz))->getTimestamp();
        Assert::same(14400, $bNominal - $aStart, 'sanity: 4 real hours, not 3, across the fall-back transition');

        $groups = [
            $this->group('a', ['mode' => 'hard'], $aStart, [$this->item('e1', $aStart, 15000)]), // 4h10m real -- runs 600s past bNominal
            $this->group('b', ['mode' => 'soft', 'max_delay' => 900], $bNominal, [$this->item('e2', $bNominal, 600)]),
        ];
        $result = BoundaryResolver::resolve($groups);
        Assert::same($aStart + 15000, $result['items'][1]['start']);
        Assert::same(600, $result['items'][1]['delay_seconds']);
    }

    public function testSoftDelayWorksAcrossAMidnightCrossing(): void
    {
        $utc = new DateTimeZone('UTC');
        $aStart = (new DateTimeImmutable('2026-11-04 23:30:00', $utc))->getTimestamp();
        $bNominal = (new DateTimeImmutable('2026-11-05 00:00:00', $utc))->getTimestamp();
        $groups = [
            $this->group('a', ['mode' => 'hard'], $aStart, [$this->item('e1', $aStart, 2400)]), // ends 00:10 the next day
            $this->group('b', ['mode' => 'soft', 'max_delay' => 900], $bNominal, [$this->item('e2', $bNominal, 600)]),
        ];
        $result = BoundaryResolver::resolve($groups);
        Assert::same($aStart + 2400, $result['items'][1]['start']);
        Assert::same(600, $result['items'][1]['delay_seconds']);
    }

    public function testNoNegativeOrOverlappingDurationsEverComeOutOfResolution(): void
    {
        $groups = [
            $this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 700)]),
            $this->group('b', ['mode' => 'soft', 'max_delay' => 600], 1600, [$this->item('e2', 1600, 400)]),
            $this->group('c', ['mode' => 'soft', 'max_delay' => 600], 2000, [$this->item('e3', 2000, 300)]),
        ];
        $result = BoundaryResolver::resolve($groups);
        for ($i = 0, $n = count($result['items']); $i < $n; $i++) {
            Assert::true($result['items'][$i]['end'] > $result['items'][$i]['start'], 'no negative/zero duration');
            if ($i > 0) {
                Assert::true($result['items'][$i]['start'] >= $result['items'][$i - 1]['end'], 'never overlaps the previous item');
            }
        }
    }

    // ---------------- Phase 3/4: program-level identity ----------------

    public function testGroupsWithNoProgramKeysProduceNoProgramsBackwardCompatible(): void
    {
        // Every pre-existing test above in this file builds groups with the
        // group() helper (no occurrenceId/programTitle/...) -- resolve() must
        // keep working for them exactly as before, with an empty "programs" list.
        $groups = [$this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 500)])];
        $result = BoundaryResolver::resolve($groups);
        Assert::count(0, $result['programs']);
    }

    public function testResolveEmitsOneProgramPerOccurrenceGroupCoveringItsEffectiveWindow(): void
    {
        $groups = [$this->programGroup('b', ['mode' => 'hard'], 1000, 1800, [
            $this->item('e1', 1000, 500), $this->item('e2', 1500, 300),
        ], 'My Show')];
        $result = BoundaryResolver::resolve($groups);
        Assert::count(1, $result['programs']);
        $p = $result['programs'][0];
        Assert::same('b@1000', $p['occurrence_id']);
        Assert::same('b', $p['block_id']);
        Assert::same('My Show', $p['title']);
        Assert::same(1000, $p['nominal_start']);
        Assert::same(2800, $p['nominal_end'], 'nominal end is the full configured block duration, not just the packed items');
        Assert::same(1000, $p['start']);
        Assert::same(2800, $p['end']);
    }

    public function testEveryItemInAProgramGroupCarriesItsOccurrenceIdAsProgramId(): void
    {
        $groups = [$this->programGroup('b', ['mode' => 'hard'], 1000, 1800, [
            $this->item('e1', 1000, 500), $this->item('e2', 1500, 300),
        ])];
        $result = BoundaryResolver::resolve($groups);
        Assert::same('b@1000', $result['items'][0]['program_id']);
        Assert::same('b@1000', $result['items'][1]['program_id']);
    }

    public function testSoftBoundaryDelayShiftsTheProgramsEffectiveWindowButNotItsNominalOne(): void
    {
        $groups = [
            $this->group('a', ['mode' => 'hard'], 1000, [$this->item('e1', 1000, 700)]), // ends 1700, 100s late for b
            $this->programGroup('b', ['mode' => 'soft', 'max_delay' => 300], 1600, 500, [$this->item('e2', 1600, 500)]),
        ];
        $result = BoundaryResolver::resolve($groups);
        $p = $result['programs'][0];
        Assert::same('b', $p['block_id']);
        Assert::same(1600, $p['nominal_start'], 'the nominal slot never moves');
        Assert::same(2100, $p['nominal_end']);
        Assert::same(1700, $p['start'], 'the EFFECTIVE window is shifted by the absorbed delay');
        Assert::same(2200, $p['end']);
    }

    public function testTwoDistinctOccurrencesOfTheSameBlockIdGetDistinctOccurrenceIds(): void
    {
        // Same block, two different scheduled instants (e.g. two different days,
        // or an AM/PM pair modeled as the same block firing twice) -- Phase 3
        // requires these never be confused with each other.
        $groups = [
            $this->programGroup('b', ['mode' => 'hard'], 1000, 500, [$this->item('e1', 1000, 500)]),
            $this->programGroup('b', ['mode' => 'hard'], 90000, 500, [$this->item('e2', 90000, 500)]),
        ];
        $result = BoundaryResolver::resolve($groups);
        Assert::count(2, $result['programs']);
        Assert::true($result['programs'][0]['occurrence_id'] !== $result['programs'][1]['occurrence_id']);
    }
}
