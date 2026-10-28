<?php
declare(strict_types=1);

// ia-import/src/DurationParser.php
//
// Parses the various ways a duration shows up in Internet Archive metadata
// (and in our own fixtures/filler libraries) into a plain float number of
// seconds. Never guesses: anything it can't confidently parse becomes null,
// which callers must treat as "unknown duration", not zero.

final class DurationParser
{
    /**
     * @param mixed $value Raw value from IA metadata (or filler JSON): may be
     *                      an int, float, numeric string ("754.5"), a
     *                      timestamp string ("12:34" or "00:12:34.500"), an
     *                      array (first parseable element is used), or null.
     */
    public static function parse(mixed $value): ?float
    {
        if ($value === null) {
            return null;
        }

        if (is_int($value) || is_float($value)) {
            return $value >= 0 ? (float) $value : null;
        }

        if (is_array($value)) {
            foreach ($value as $v) {
                $parsed = self::parse($v);
                if ($parsed !== null) {
                    return $parsed;
                }
            }
            return null;
        }

        if (!is_string($value)) {
            return null;
        }

        $trimmed = trim($value);
        if ($trimmed === '') {
            return null;
        }

        // Plain numeric seconds, e.g. "754.5" or "754".
        if (is_numeric($trimmed)) {
            $seconds = (float) $trimmed;
            return $seconds >= 0 ? $seconds : null;
        }

        // Timestamp formats: "HH:MM:SS(.sss)" or "MM:SS(.sss)".
        if (preg_match('/^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/', $trimmed, $m)) {
            $hours = (float) $m[1];
            $minutes = (float) $m[2];
            $seconds = (float) $m[3];
            return $hours * 3600 + $minutes * 60 + $seconds;
        }
        if (preg_match('/^([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/', $trimmed, $m)) {
            $minutes = (float) $m[1];
            $seconds = (float) $m[2];
            return $minutes * 60 + $seconds;
        }

        return null;
    }

    /** Formats seconds as H:MM:SS or M:SS for human-readable reports. */
    public static function format(float $seconds): string
    {
        $seconds = (int) round($seconds);
        $h = intdiv($seconds, 3600);
        $m = intdiv($seconds % 3600, 60);
        $s = $seconds % 60;
        if ($h > 0) {
            return sprintf('%d:%02d:%02d', $h, $m, $s);
        }
        return sprintf('%d:%02d', $m, $s);
    }

    /** Formats seconds as "41h 22m" style, used in the summary report. */
    public static function formatHoursMinutes(float $seconds): string
    {
        $totalMinutes = (int) round($seconds / 60);
        $h = intdiv($totalMinutes, 60);
        $m = $totalMinutes % 60;
        return sprintf('%dh %02dm', $h, $m);
    }
}
