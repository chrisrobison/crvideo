<?php
declare(strict_types=1);

final class MediaResolverTest
{
    private function loadFixture(string $identifier): array
    {
        $path = __DIR__ . "/fixtures/metadata/$identifier.json";
        return json_decode(file_get_contents($path), true);
    }

    public function testSingleEncodingSelectsH264(): void
    {
        $raw = $this->loadFixture('0771_Duck_and_Cover_12_33_20_12');
        $parts = MediaResolver::resolve($raw, '0771_Duck_and_Cover_12_33_20_12');
        Assert::count(1, $parts);
        Assert::same('0771_Duck_and_Cover_12_33_20_12.mp4', $parts[0]['selected_file']);
        Assert::equalsFloat(754.5, $parts[0]['duration']);
        Assert::same('ready', $parts[0]['status']);
        Assert::same('https://creativecommons.org/publicdomain/mark/1.0/', $parts[0]['license']);
    }

    public function testDescriptionHtmlIsStripped(): void
    {
        $raw = $this->loadFixture('0771_Duck_and_Cover_12_33_20_12');
        $parts = MediaResolver::resolve($raw, '0771_Duck_and_Cover_12_33_20_12');
        Assert::true(!str_contains($parts[0]['description'], '<p>'), 'description must not contain raw HTML tags');
        Assert::true(str_contains($parts[0]['description'], '"duck and cover"'), 'decoded entities should produce plain quotes');
    }

    public function testMultipleEncodingsCollapseToOneSelection(): void
    {
        $raw = $this->loadFixture('multi_encoding_item');
        $parts = MediaResolver::resolve($raw, 'multi_encoding_item');
        Assert::count(1, $parts, 'two encodings of the same film must resolve to a single logical video');
        Assert::same('multi_encoding_item.mp4', $parts[0]['selected_file'], 'the h.264 mp4 should win over the 512Kb variant and the ogv');
    }

    public function testMultiplePartsProduceDistinctEntries(): void
    {
        $raw = $this->loadFixture('multi_part_item');
        $parts = MediaResolver::resolve($raw, 'multi_part_item');
        Assert::count(2, $parts);
        Assert::equalsFloat(300.0, $parts[0]['duration']);
        Assert::equalsFloat(320.0, $parts[1]['duration']);
        Assert::same(1, $parts[0]['part_index']);
        Assert::same(2, $parts[1]['part_index']);
    }

    public function testAmbiguousItemIsFlaggedNotSilentlyGuessed(): void
    {
        $raw = $this->loadFixture('ambiguous_item');
        $parts = MediaResolver::resolve($raw, 'ambiguous_item');
        Assert::count(2, $parts);
        $flagged = array_filter($parts[0]['warnings'], static fn ($w) => str_contains($w, 'ambiguous') || str_contains($w, 'Review manually'));
        Assert::true(count($flagged) > 0, 'ambiguous grouping must produce a warning, not a silent guess');
    }

    public function testUnknownDurationIsNeverFabricated(): void
    {
        $raw = $this->loadFixture('unknown_duration_item');
        $parts = MediaResolver::resolve($raw, 'unknown_duration_item');
        Assert::count(1, $parts);
        Assert::null($parts[0]['duration']);
        Assert::same('unknown_duration', $parts[0]['status']);
    }

    public function testUnavailableItemHasNoPlayableFile(): void
    {
        $raw = $this->loadFixture('unavailable_item');
        $parts = MediaResolver::resolve($raw, 'unavailable_item');
        Assert::count(1, $parts);
        Assert::null($parts[0]['selected_file']);
        Assert::same('unavailable', $parts[0]['status']);
    }

    public function testMissingLicenseProducesWarning(): void
    {
        $raw = $this->loadFixture('Conquerb1943');
        $parts = MediaResolver::resolve($raw, 'Conquerb1943');
        Assert::null($parts[0]['license']);
        $found = array_filter($parts[0]['warnings'], static fn ($w) => str_contains($w, 'license'));
        Assert::true(count($found) > 0);
    }

    public function testMediaUrlIsProperlyEncoded(): void
    {
        $url = MediaResolver::buildDownloadUrl('my id', 'a file/name.mp4');
        Assert::same('https://archive.org/download/my%20id/a%20file/name.mp4', $url);
    }
}
