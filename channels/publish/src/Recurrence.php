<?php
declare(strict_types=1);

// channels/publish/src/Recurrence.php
//
// Computes the absolute instants ("occurrences") a recurring programming
// block airs at within a forward publish window, for "daily", "weekly",
// and "monthly" frequencies. This is the one place the spec's hard
// constraint applies: occurrence dates are always calendar arithmetic
// (DateTimeImmutable + a real DateTimeZone, which PHP resolves against
// the system's IANA tz database -- DST-aware by construction) on a
// LOCAL wall-clock time, converted to an absolute instant only at the
// very end. Nothing here ever multiplies an occurrence index by 86400 (or
// 7*86400, or 30*86400) to compute an actual occurrence's clock time --
// those constants are used ONLY as a rough starting guess for where to
// begin scanning (see scan() below), never as the result itself. The
// scan always walks forward/backward by exact calendar units (PHP's
// "+1 day" / "+1 week" / "+1 month" DateTime modifiers, which preserve
// local wall-clock time across a DST transition -- that's precisely
// "calendar day/week/month" semantics, not "elapsed seconds") until it
// lands on the real instant, so a spring-forward/fall-back day is simply
// a day that happens to be 23 or 25 real hours long; the published
// occurrence still reads "13:00 America/Los_Angeles" and gets the
// correct absolute UTC instant for that.
//
// occurrence index (an integer, 0 at the anchor's own occurrence,
// negative before it, positive after) is a pure calendar COUNT -- days
// since the anchor date for "daily", weeks since the anchor's first
// matching weekday for "weekly", months since the anchor's month for
// "monthly" -- never derived from a seconds quantity. It is this index
// (not the instant, not any clock-time arithmetic) that
// ProgrammingCompiler feeds into episode rotation
// (episode_index = floorMod(occurrence_index, count(approved_episodes))),
// which is what makes rotation itself immune to DST entirely: a DST
// transition can shift an occurrence's absolute UTC instant by an hour,
// but never changes which calendar day/week/month it is, so it never
// perturbs which episode airs.

final class Recurrence
{
    private const WEEKDAYS = [
        'monday' => 1, 'tuesday' => 2, 'wednesday' => 3, 'thursday' => 4,
        'friday' => 5, 'saturday' => 6, 'sunday' => 7,
    ];

    /**
     * @param array{frequency:string, time:string, timezone:string, weekday?:string, day_of_month?:int} $recurrence
     * @return list<array{index:int, at: DateTimeImmutable}> sorted ascending by `at`; `at` carries the
     *         recurrence's own local timezone (compare/format it however's convenient -- ->getTimestamp()
     *         gives the timezone-agnostic absolute Unix instant).
     */
    public static function occurrences(array $recurrence, string $anchorDate, DateTimeImmutable $windowStart, DateTimeImmutable $windowEnd): array
    {
        self::validateAnchorDate($anchorDate);
        $frequency = $recurrence['frequency'] ?? null;
        return match ($frequency) {
            'daily' => self::daily($recurrence, $anchorDate, $windowStart, $windowEnd),
            'weekly' => self::weekly($recurrence, $anchorDate, $windowStart, $windowEnd),
            'monthly' => self::monthly($recurrence, $anchorDate, $windowStart, $windowEnd),
            default => throw new InvalidArgumentException('Unsupported recurrence.frequency: ' . json_encode($frequency) . ' (must be daily, weekly, or monthly).'),
        };
    }

    /** Non-negative modulo -- same floor-mod convention broadcast.js's own
     *  `mod()` helper uses, so a negative occurrence index (an occurrence
     *  before the anchor) still indexes forward into the approved list
     *  correctly rather than throwing or returning a negative index. */
    public static function floorMod(int $n, int $len): int
    {
        if ($len <= 0) {
            throw new InvalidArgumentException('floorMod() divisor must be positive.');
        }
        $r = $n % $len;
        return $r < 0 ? $r + $len : $r;
    }

    private static function daily(array $recurrence, string $anchorDate, DateTimeImmutable $windowStart, DateTimeImmutable $windowEnd): array
    {
        $tz = self::timezone($recurrence);
        [$h, $m] = self::time($recurrence);
        $anchor = new DateTimeImmutable($anchorDate, $tz);
        $occurrenceAt = static fn (int $n): DateTimeImmutable => $anchor->modify(sprintf('%+d day', $n))->setTime($h, $m, 0);
        return self::scan($occurrenceAt, 86400, $windowStart, $windowEnd);
    }

    private static function weekly(array $recurrence, string $anchorDate, DateTimeImmutable $windowStart, DateTimeImmutable $windowEnd): array
    {
        $tz = self::timezone($recurrence);
        [$h, $m] = self::time($recurrence);
        $targetIso = self::weekdayNumber($recurrence['weekday'] ?? null);
        $anchor = new DateTimeImmutable($anchorDate, $tz);
        $anchorIso = (int) $anchor->format('N'); // 1 (Monday) .. 7 (Sunday)
        $daysToFirst = ($targetIso - $anchorIso + 7) % 7; // 0..6: forward to the first matching weekday on/after the anchor date
        $reference = $anchor->modify(sprintf('%+d day', $daysToFirst))->setTime($h, $m, 0); // occurrence index 0
        $occurrenceAt = static fn (int $n): DateTimeImmutable => $reference->modify(sprintf('%+d week', $n));
        return self::scan($occurrenceAt, 7 * 86400, $windowStart, $windowEnd);
    }

    private static function monthly(array $recurrence, string $anchorDate, DateTimeImmutable $windowStart, DateTimeImmutable $windowEnd): array
    {
        $tz = self::timezone($recurrence);
        [$h, $m] = self::time($recurrence);
        $dayOfMonth = (int) ($recurrence['day_of_month'] ?? 1);
        if ($dayOfMonth < 1 || $dayOfMonth > 31) {
            throw new InvalidArgumentException("recurrence.day_of_month must be 1..31, got: $dayOfMonth");
        }
        $anchor = new DateTimeImmutable($anchorDate, $tz);
        $anchorYear = (int) $anchor->format('Y');
        $anchorMonth = (int) $anchor->format('n'); // 1..12

        // Documented policy: a day_of_month beyond the length of a given
        // target month (e.g. 31 in a 30-day month, or in February) is
        // clamped to that month's last real day -- never rolled over into
        // the next month, which would silently change which weekday/month
        // it lands on.
        $occurrenceAt = static function (int $n) use ($anchorYear, $anchorMonth, $dayOfMonth, $h, $m, $tz): DateTimeImmutable {
            $totalMonths = ($anchorMonth - 1) + $n;
            $year = $anchorYear + intdiv($totalMonths, 12);
            $monthIndex = $totalMonths % 12;
            if ($monthIndex < 0) {
                $monthIndex += 12;
                $year--;
            }
            $month = $monthIndex + 1;
            $daysInMonth = (int) (new DateTimeImmutable(sprintf('%04d-%02d-01', $year, $month), $tz))->format('t');
            $day = min($dayOfMonth, $daysInMonth);
            return (new DateTimeImmutable(sprintf('%04d-%02d-%02d', $year, $month, $day), $tz))->setTime($h, $m, 0);
        };
        return self::scan($occurrenceAt, 30 * 86400, $windowStart, $windowEnd);
    }

    /**
     * Shared scanner: given occurrenceAt(0..n..) -- a pure function from a
     * calendar-count index to the occurrence's absolute instant -- and a
     * rough period length used ONLY to pick a sane starting index (never
     * to compute an occurrence's actual time), walks forward/backward by
     * whole steps to find the exact first index whose instant falls at or
     * after $windowStart, then collects every subsequent occurrence up to
     * (not including) $windowEnd.
     *
     * @param callable(int):DateTimeImmutable $occurrenceAt
     * @return list<array{index:int, at: DateTimeImmutable}>
     */
    private static function scan(callable $occurrenceAt, int $approxPeriodSeconds, DateTimeImmutable $windowStart, DateTimeImmutable $windowEnd): array
    {
        $ref0 = $occurrenceAt(0);
        $n = (int) floor(($windowStart->getTimestamp() - $ref0->getTimestamp()) / max(1, $approxPeriodSeconds)) - 2;

        $guard = 0;
        while ($occurrenceAt($n) < $windowStart) {
            $n++;
            if (++$guard > 100000) {
                throw new RuntimeException('Recurrence::scan could not reach the window start; check the recurrence configuration.');
            }
        }
        while ($occurrenceAt($n - 1) >= $windowStart) {
            $n--;
            if (++$guard > 100000) {
                throw new RuntimeException('Recurrence::scan overshot searching backward; check the recurrence configuration.');
            }
        }

        $out = [];
        while (true) {
            $at = $occurrenceAt($n);
            if ($at >= $windowEnd) {
                break;
            }
            $out[] = ['index' => $n, 'at' => $at];
            $n++;
            if (count($out) > 100000) {
                throw new RuntimeException('Recurrence produced more than 100000 occurrences in one window; check the recurrence/window configuration.');
            }
        }
        return $out;
    }

    private static function timezone(array $recurrence): DateTimeZone
    {
        $name = $recurrence['timezone'] ?? null;
        if (!is_string($name) || $name === '') {
            throw new InvalidArgumentException('recurrence.timezone is required (an IANA zone name, e.g. "America/Los_Angeles").');
        }
        try {
            return new DateTimeZone($name);
        } catch (Exception $e) {
            throw new InvalidArgumentException("Invalid recurrence.timezone \"$name\": " . $e->getMessage());
        }
    }

    /** @return array{0:int,1:int} [hour, minute] */
    private static function time(array $recurrence): array
    {
        $t = $recurrence['time'] ?? null;
        if (!is_string($t) || !preg_match('/^([01]\d|2[0-3]):([0-5]\d)$/', $t, $m)) {
            throw new InvalidArgumentException('recurrence.time must be "HH:MM" (24-hour), got: ' . json_encode($t));
        }
        return [(int) $m[1], (int) $m[2]];
    }

    private static function weekdayNumber(mixed $weekday): int
    {
        $key = is_string($weekday) ? strtolower($weekday) : null;
        if ($key === null || !isset(self::WEEKDAYS[$key])) {
            throw new InvalidArgumentException('recurrence.weekday must be one of monday..sunday, got: ' . json_encode($weekday));
        }
        return self::WEEKDAYS[$key];
    }

    private static function validateAnchorDate(string $anchorDate): void
    {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $anchorDate)) {
            throw new InvalidArgumentException("rotation.anchor_date must be \"YYYY-MM-DD\", got: \"$anchorDate\"");
        }
    }
}
