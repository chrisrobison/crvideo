<?php
declare(strict_types=1);

// youtube-import/src/YouTubeIso8601Duration.php
//
// Parses the ISO 8601 duration strings YouTube's Data API returns in
// videos.list's contentDetails.duration (e.g. "PT1H2M10S", "PT45S", "P0D")
// into a plain float number of seconds. Never guesses: anything it can't
// confidently parse becomes null ("unknown"), matching ia-import's
// DurationParser convention of never fabricating a duration.
//
// Important: YouTube reports "P0D" (which parses to exactly 0 seconds) for
// a live broadcast that is upcoming or currently in progress -- the real
// duration isn't known until the stream ends, at which point YouTube
// updates contentDetails.duration to the actual length. Zero is not a
// legitimate duration for a stream that hasn't ended, so callers (see
// YouTubeVideoClassifier) must check live-broadcast state *before*
// trusting a parsed duration of 0, not treat it as "a very short video."
// This class only parses the string; it deliberately does not special-case
// "P0D" itself, since whether a zero is meaningful depends on broadcast
// state this class doesn't have.

final class YouTubeIso8601Duration
{
    private const PATTERN = '/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/';

    public static function parse(mixed $value): ?float
    {
        if (!is_string($value) || $value === '') {
            return null;
        }
        $trimmed = trim($value);
        if ($trimmed === '' || $trimmed[0] !== 'P') {
            return null;
        }
        if (!preg_match(self::PATTERN, $trimmed, $m)) {
            return null;
        }
        // A bare "P" (no date or time component at all) matched everything
        // as empty groups -- that's not a valid duration, not "0 seconds".
        if ($trimmed === 'P') {
            return null;
        }
        $years = (float) ($m[1] ?? 0);
        $months = (float) ($m[2] ?? 0);
        $days = (float) ($m[3] ?? 0);
        $hours = (float) ($m[4] ?? 0);
        $minutes = (float) ($m[5] ?? 0);
        $seconds = (float) ($m[6] ?? 0);

        // YouTube durations never carry years/months in practice, but
        // handle them with the same (approximate, calendar-free) factors
        // other ISO 8601 duration parsers use rather than reject the whole
        // string outright.
        return $years * 365 * 86400 + $months * 30 * 86400 + $days * 86400 + $hours * 3600 + $minutes * 60 + $seconds;
    }

    /** Formats seconds as H:MM:SS or M:SS for the stdout summary report. */
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
}
