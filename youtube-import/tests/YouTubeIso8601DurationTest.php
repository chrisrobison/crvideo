<?php
declare(strict_types=1);

final class YouTubeIso8601DurationTest
{
    public function testHoursMinutesSeconds(): void
    {
        Assert::same(3730.0, YouTubeIso8601Duration::parse('PT1H2M10S'));
    }

    public function testMinutesOnly(): void
    {
        Assert::same(2730.0, YouTubeIso8601Duration::parse('PT45M30S'));
    }

    public function testSecondsOnly(): void
    {
        Assert::same(45.0, YouTubeIso8601Duration::parse('PT45S'));
    }

    public function testDaysComponent(): void
    {
        Assert::same(86400.0 + 3600.0, YouTubeIso8601Duration::parse('P1DT1H'));
    }

    public function testZeroDurationParsesToZeroNotNull(): void
    {
        // The parser itself has no opinion on whether 0 is "real" --
        // YouTubeVideoClassifier is what decides that based on live-
        // broadcast state. Parsing alone must be faithful to the string.
        Assert::same(0.0, YouTubeIso8601Duration::parse('P0D'));
        Assert::same(0.0, YouTubeIso8601Duration::parse('PT0S'));
    }

    public function testBarePIsNotAValidDuration(): void
    {
        Assert::null(YouTubeIso8601Duration::parse('P'));
    }

    public function testMalformedStringsReturnNull(): void
    {
        Assert::null(YouTubeIso8601Duration::parse('not a duration'));
        Assert::null(YouTubeIso8601Duration::parse(''));
        Assert::null(YouTubeIso8601Duration::parse(null));
        Assert::null(YouTubeIso8601Duration::parse(12345)); // not a ever string from the API, reject defensively
    }

    public function testFormatUnderAnHour(): void
    {
        Assert::same('5:09', YouTubeIso8601Duration::format(309.0));
    }

    public function testFormatOverAnHour(): void
    {
        Assert::same('1:02:10', YouTubeIso8601Duration::format(3730.0));
    }
}
