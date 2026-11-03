<?php
declare(strict_types=1);

final class RecurrenceTest
{
    private function utc(string $s): DateTimeImmutable
    {
        return new DateTimeImmutable($s, new DateTimeZone('UTC'));
    }

    // ---------- daily ----------

    public function testDailyProducesOneOccurrencePerCalendarDayAtTheConfiguredLocalTime(): void
    {
        $recurrence = ['frequency' => 'daily', 'time' => '13:00', 'timezone' => 'America/Los_Angeles'];
        $occ = Recurrence::occurrences($recurrence, '2026-11-02', $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-05T00:00:00Z'));
        Assert::count(3, $occ);
        Assert::same(0, $occ[0]['index']);
        Assert::same(1, $occ[1]['index']);
        Assert::same(2, $occ[2]['index']);
        foreach ($occ as $o) {
            Assert::same('13:00', $o['at']->format('H:i'));
        }
    }

    public function testDailyIsIdempotentAcrossRepeatedCalls(): void
    {
        $recurrence = ['frequency' => 'daily', 'time' => '09:30', 'timezone' => 'UTC'];
        $a = Recurrence::occurrences($recurrence, '2026-01-01', $this->utc('2026-06-01T00:00:00Z'), $this->utc('2026-06-10T00:00:00Z'));
        $b = Recurrence::occurrences($recurrence, '2026-01-01', $this->utc('2026-06-01T00:00:00Z'), $this->utc('2026-06-10T00:00:00Z'));
        Assert::same(count($a), count($b));
        foreach ($a as $i => $o) {
            Assert::same($o['index'], $b[$i]['index']);
            Assert::same($o['at']->getTimestamp(), $b[$i]['at']->getTimestamp());
        }
    }

    public function testDailyOccurrenceIndexIsNegativeBeforeTheAnchorDate(): void
    {
        $recurrence = ['frequency' => 'daily', 'time' => '00:00', 'timezone' => 'UTC'];
        $occ = Recurrence::occurrences($recurrence, '2026-11-10', $this->utc('2026-11-07T00:00:00Z'), $this->utc('2026-11-09T00:00:00Z'));
        Assert::count(2, $occ);
        Assert::same(-3, $occ[0]['index']);
        Assert::same(-2, $occ[1]['index']);
    }

    // ---------- DST ----------

    public function testDailyAcrossFallBackTransitionKeepsTheConfiguredLocalTimeAndIsStillOneCalendarDayApart(): void
    {
        // America/Los_Angeles falls back from PDT to PST at 2am on 2026-11-01
        // (confirmed against this system's tzdata) -- that calendar day is
        // 25 real hours long. A daily 13:00 occurrence must still read
        // 13:00 local on both sides, 25 real hours apart that one day, and
        // the occurrence index must still just be "+1 day", never "+1" of
        // some fixed-seconds unit.
        $recurrence = ['frequency' => 'daily', 'time' => '13:00', 'timezone' => 'America/Los_Angeles'];
        $occ = Recurrence::occurrences($recurrence, '2026-10-30', $this->utc('2026-10-31T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        $byIndex = [];
        foreach ($occ as $o) {
            $byIndex[$o['index']] = $o['at'];
        }
        Assert::same('13:00', $byIndex[1]->format('H:i')); // 2026-10-31
        Assert::same('13:00', $byIndex[2]->format('H:i')); // 2026-11-01 (the 25-hour day)
        Assert::same('13:00', $byIndex[3]->format('H:i')); // 2026-11-02
        Assert::same(90000, $byIndex[2]->getTimestamp() - $byIndex[1]->getTimestamp(), 'the fall-back day is 25 real hours, not 24');
        Assert::same(86400, $byIndex[3]->getTimestamp() - $byIndex[2]->getTimestamp(), 'the day after DST ends is back to a normal 24h day');
    }

    public function testDailyAcrossSpringForwardTransitionKeepsTheConfiguredLocalTimeAndIsStillOneCalendarDayApart(): void
    {
        // America/Los_Angeles springs forward from PST to PDT at 2am on
        // 2027-03-14 -- that calendar day is 23 real hours long.
        $recurrence = ['frequency' => 'daily', 'time' => '13:00', 'timezone' => 'America/Los_Angeles'];
        $occ = Recurrence::occurrences($recurrence, '2027-03-12', $this->utc('2027-03-12T00:00:00Z'), $this->utc('2027-03-16T00:00:00Z'));
        $byIndex = [];
        foreach ($occ as $o) {
            $byIndex[$o['index']] = $o['at'];
        }
        Assert::same('13:00', $byIndex[1]->format('H:i')); // 2027-03-13
        Assert::same('13:00', $byIndex[2]->format('H:i')); // 2027-03-14 (the 23-hour day)
        Assert::same(82800, $byIndex[2]->getTimestamp() - $byIndex[1]->getTimestamp(), 'the spring-forward day is 23 real hours, not 24');
    }

    // ---------- weekly ----------

    public function testWeeklyLandsOnTheConfiguredWeekdayExactlySevenCalendarDaysApart(): void
    {
        $recurrence = ['frequency' => 'weekly', 'weekday' => 'saturday', 'time' => '10:00', 'timezone' => 'America/Los_Angeles'];
        // 2026-11-02 is a Monday; the first Saturday on/after it is 2026-11-07.
        $occ = Recurrence::occurrences($recurrence, '2026-11-02', $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-12-01T00:00:00Z'));
        Assert::true(count($occ) >= 3);
        foreach ($occ as $o) {
            Assert::same('Saturday', $o['at']->format('l'));
            Assert::same('10:00', $o['at']->format('H:i'));
        }
        Assert::same('2026-11-07', $occ[0]['at']->format('Y-m-d'));
        Assert::same(7 * 86400, $occ[1]['at']->getTimestamp() - $occ[0]['at']->getTimestamp());
    }

    public function testWeeklyAnchorOnTheTargetWeekdayItselfIsOccurrenceZero(): void
    {
        $recurrence = ['frequency' => 'weekly', 'weekday' => 'monday', 'time' => '08:00', 'timezone' => 'UTC'];
        // 2026-11-02 is itself a Monday.
        $occ = Recurrence::occurrences($recurrence, '2026-11-02', $this->utc('2026-11-02T00:00:00Z'), $this->utc('2026-11-03T00:00:00Z'));
        Assert::count(1, $occ);
        Assert::same(0, $occ[0]['index']);
        Assert::same('2026-11-02', $occ[0]['at']->format('Y-m-d'));
    }

    public function testWeeklyAcrossADstTransitionStaysExactlySevenCalendarDaysApart(): void
    {
        $recurrence = ['frequency' => 'weekly', 'weekday' => 'sunday', 'time' => '13:00', 'timezone' => 'America/Los_Angeles'];
        // 2026-11-01 (a Sunday) is the fall-back day itself.
        $occ = Recurrence::occurrences($recurrence, '2026-10-25', $this->utc('2026-10-24T00:00:00Z'), $this->utc('2026-11-09T00:00:00Z'));
        Assert::count(3, $occ);
        foreach ($occ as $o) {
            Assert::same('13:00', $o['at']->format('H:i'));
        }
        Assert::same(7 * 86400 + 3600, $occ[1]['at']->getTimestamp() - $occ[0]['at']->getTimestamp(), 'the week containing the fall-back day is one hour longer in real seconds');
    }

    // ---------- monthly ----------

    public function testMonthlyLandsOnTheConfiguredDayEachCalendarMonth(): void
    {
        $recurrence = ['frequency' => 'monthly', 'day_of_month' => 1, 'time' => '20:00', 'timezone' => 'America/Los_Angeles'];
        $occ = Recurrence::occurrences($recurrence, '2026-11-02', $this->utc('2026-11-03T00:00:00Z'), $this->utc('2027-03-01T00:00:00Z'));
        $dates = array_map(static fn ($o) => $o['at']->format('Y-m-d'), $occ);
        Assert::same(['2026-12-01', '2027-01-01', '2027-02-01'], $dates);
    }

    public function testMonthlyClampsADayOfMonthThatDoesNotExistInAShorterMonth(): void
    {
        // day_of_month 31 should land on the last real day of a 30-day or
        // 28/29-day month, never roll into the next month.
        $recurrence = ['frequency' => 'monthly', 'day_of_month' => 31, 'time' => '09:00', 'timezone' => 'UTC'];
        $occ = Recurrence::occurrences($recurrence, '2026-01-31', $this->utc('2026-01-31T00:00:00Z'), $this->utc('2026-05-01T00:00:00Z'));
        $dates = array_map(static fn ($o) => $o['at']->format('Y-m-d'), $occ);
        Assert::same(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'], $dates);
    }

    public function testMonthlyAnchorInDecemberWrapsTheYearForward(): void
    {
        $recurrence = ['frequency' => 'monthly', 'day_of_month' => 15, 'time' => '00:00', 'timezone' => 'UTC'];
        $occ = Recurrence::occurrences($recurrence, '2026-12-15', $this->utc('2026-12-15T00:00:00Z'), $this->utc('2027-03-01T00:00:00Z'));
        $dates = array_map(static fn ($o) => $o['at']->format('Y-m-d'), $occ);
        Assert::same(['2026-12-15', '2027-01-15', '2027-02-15'], $dates);
    }

    public function testMonthlyHandlesALargeNegativeIndexAcrossAYearBoundary(): void
    {
        // Exercises the floor-division correction in monthly() for an
        // occurrence well before the anchor, including a year rollback.
        $recurrence = ['frequency' => 'monthly', 'day_of_month' => 1, 'time' => '00:00', 'timezone' => 'UTC'];
        $occ = Recurrence::occurrences($recurrence, '2027-01-01', $this->utc('2025-11-02T00:00:00Z'), $this->utc('2025-12-02T00:00:00Z'));
        Assert::count(1, $occ);
        Assert::same('2025-12-01', $occ[0]['at']->format('Y-m-d'));
        Assert::same(-13, $occ[0]['index']);
    }

    // ---------- validation ----------

    public function testUnsupportedFrequencyIsRejected(): void
    {
        Assert::throws(InvalidArgumentException::class, function (): void {
            Recurrence::occurrences(['frequency' => 'yearly', 'time' => '00:00', 'timezone' => 'UTC'], '2026-01-01', $this->utc('2026-01-01T00:00:00Z'), $this->utc('2026-02-01T00:00:00Z'));
        });
    }

    public function testMissingTimezoneIsRejected(): void
    {
        Assert::throws(InvalidArgumentException::class, function (): void {
            Recurrence::occurrences(['frequency' => 'daily', 'time' => '13:00'], '2026-01-01', $this->utc('2026-01-01T00:00:00Z'), $this->utc('2026-01-02T00:00:00Z'));
        });
    }

    public function testMalformedAnchorDateIsRejected(): void
    {
        Assert::throws(InvalidArgumentException::class, function (): void {
            Recurrence::occurrences(['frequency' => 'daily', 'time' => '13:00', 'timezone' => 'UTC'], 'Nov 2nd', $this->utc('2026-01-01T00:00:00Z'), $this->utc('2026-01-02T00:00:00Z'));
        });
    }

    // ---------- floorMod ----------

    public function testFloorModWrapsNegativeIndicesForward(): void
    {
        Assert::same(2, Recurrence::floorMod(-1, 3));
        Assert::same(0, Recurrence::floorMod(-3, 3));
        Assert::same(1, Recurrence::floorMod(-5, 3));
    }

    public function testFloorModOfNonNegativeIndicesIsOrdinaryModulo(): void
    {
        Assert::same(0, Recurrence::floorMod(0, 3));
        Assert::same(1, Recurrence::floorMod(4, 3));
        Assert::same(2, Recurrence::floorMod(5, 3));
    }
}
