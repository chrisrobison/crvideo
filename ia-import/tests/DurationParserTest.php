<?php
declare(strict_types=1);

final class DurationParserTest
{
    public function testNumericFloat(): void
    {
        Assert::equalsFloat(754.5, DurationParser::parse(754.5));
    }

    public function testNumericInt(): void
    {
        Assert::equalsFloat(754.0, DurationParser::parse(754));
    }

    public function testNumericStringWithDecimal(): void
    {
        Assert::equalsFloat(754.5, DurationParser::parse('754.5'));
    }

    public function testPlainNumericString(): void
    {
        Assert::equalsFloat(754.0, DurationParser::parse('754'));
    }

    public function testMinutesSecondsTimestamp(): void
    {
        Assert::equalsFloat(754.0, DurationParser::parse('12:34'));
    }

    public function testHoursMinutesSecondsWithFraction(): void
    {
        // 00:12:34.500 => 12*60 + 34.5 = 754.5
        Assert::equalsFloat(754.5, DurationParser::parse('00:12:34.500'));
    }

    public function testNullIsUnknown(): void
    {
        Assert::null(DurationParser::parse(null));
    }

    public function testGarbageStringIsUnknown(): void
    {
        Assert::null(DurationParser::parse('not a duration'));
    }

    public function testEmptyStringIsUnknown(): void
    {
        Assert::null(DurationParser::parse(''));
    }

    public function testNegativeIsRejected(): void
    {
        Assert::null(DurationParser::parse(-5));
    }

    public function testArrayPicksFirstParseable(): void
    {
        Assert::equalsFloat(754.5, DurationParser::parse([null, '754.5', '999']));
    }

    public function testFormatUnderAnHour(): void
    {
        Assert::same('12:35', DurationParser::format(754.5));
    }

    public function testFormatOverAnHour(): void
    {
        Assert::same('1:02:03', DurationParser::format(3723.0));
    }
}
