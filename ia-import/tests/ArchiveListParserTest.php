<?php
declare(strict_types=1);

final class ArchiveListParserTest
{
    private string $fixturesDir;

    public function setUp(): void
    {
        $this->fixturesDir = __DIR__ . '/fixtures';
    }

    public function testValidListParsesAllFields(): void
    {
        $result = ArchiveListParser::parse($this->fixturesDir . '/film-day.json');
        Assert::same('Film Day at School', $result['list_name']);
        Assert::same('Vintage educational films', $result['description']);
        Assert::same(false, $result['is_private']);
        // 11 raw entries, 1 missing identifier => 10 valid members.
        Assert::count(10, $result['members']);
    }

    public function testDuplicateIdentifiersPreservedAsSeparateEntries(): void
    {
        $result = ArchiveListParser::parse($this->fixturesDir . '/film-day.json');
        $matching = array_values(array_filter(
            $result['members'],
            static fn (array $m) => $m['identifier'] === '0771_Duck_and_Cover_12_33_20_12'
        ));
        Assert::count(2, $matching, 'duplicate identifier should appear as two separate member entries');
        Assert::true($matching[0]['original_position'] !== $matching[1]['original_position'], 'duplicates must keep distinct original positions');
    }

    public function testMissingIdentifierIsReportedAndSkipped(): void
    {
        $result = ArchiveListParser::parse($this->fixturesDir . '/film-day.json');
        $found = false;
        foreach ($result['warnings'] as $w) {
            if (str_contains($w, 'missing a valid "identifier"')) {
                $found = true;
            }
        }
        Assert::true($found, 'expected a warning about the member missing an identifier');
    }

    public function testSourceFileIsNeverModified(): void
    {
        $path = $this->fixturesDir . '/film-day.json';
        $before = file_get_contents($path);
        ArchiveListParser::parse($path);
        $after = file_get_contents($path);
        Assert::same($before, $after, 'parsing must never modify the source list file');
    }

    public function testInvalidJsonThrows(): void
    {
        $tmp = tempnam(sys_get_temp_dir(), 'ia-test-');
        file_put_contents($tmp, '{not valid json');
        try {
            $threw = false;
            try {
                ArchiveListParser::parse($tmp);
            } catch (InvalidArgumentException $e) {
                $threw = true;
            }
            Assert::true($threw, 'expected InvalidArgumentException for malformed JSON');
        } finally {
            unlink($tmp);
        }
    }

    public function testMissingMembersKeyThrows(): void
    {
        $tmp = tempnam(sys_get_temp_dir(), 'ia-test-');
        file_put_contents($tmp, json_encode(['success' => true, 'value' => ['list_name' => 'X']]));
        try {
            $threw = false;
            try {
                ArchiveListParser::parse($tmp);
            } catch (InvalidArgumentException $e) {
                $threw = true;
            }
            Assert::true($threw, 'expected InvalidArgumentException for missing members');
        } finally {
            unlink($tmp);
        }
    }

    public function testMissingSuccessFlagThrows(): void
    {
        $tmp = tempnam(sys_get_temp_dir(), 'ia-test-');
        file_put_contents($tmp, json_encode(['value' => ['members' => []]]));
        try {
            $threw = false;
            try {
                ArchiveListParser::parse($tmp);
            } catch (InvalidArgumentException $e) {
                $threw = true;
            }
            Assert::true($threw, 'expected InvalidArgumentException for missing success:true');
        } finally {
            unlink($tmp);
        }
    }

    public function testNonexistentFileThrows(): void
    {
        $threw = false;
        try {
            ArchiveListParser::parse($this->fixturesDir . '/does-not-exist.json');
        } catch (RuntimeException $e) {
            $threw = true;
        }
        Assert::true($threw, 'expected RuntimeException for missing file');
    }
}
