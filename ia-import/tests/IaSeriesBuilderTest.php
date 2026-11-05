<?php
declare(strict_types=1);

final class IaSeriesBuilderTest
{
    private function loadFixture(string $identifier): array
    {
        $path = __DIR__ . "/fixtures/metadata/$identifier.json";
        return json_decode(file_get_contents($path), true);
    }

    private function resolved(string $identifier): array
    {
        return MediaResolver::resolve($this->loadFixture($identifier), $identifier);
    }

    private function defaults(): array
    {
        return [
            'schema_version' => 1, 'id' => 's', 'title' => 'S', 'description' => '',
            'creator' => null, 'year' => null, 'thumbnail_url' => null, 'logo_url' => null,
            'source' => ['provider' => 'internet_archive', 'query' => 'collection:(x)', 'collection' => 'x'],
            'rotation' => ['mode' => 'sequential', 'loop' => true], 'episodes' => [],
        ];
    }

    public function testFreshImportCreatesACandidateEpisodeWithUnverifiedRights(): void
    {
        $id = '0771_Duck_and_Cover_12_33_20_12';
        $result = IaSeriesBuilder::build(null, $this->defaults(), [$id], [$id => $this->resolved($id)]);
        Assert::count(1, $result['series']['episodes']);
        $ep = $result['series']['episodes'][0];
        Assert::same('ia-' . $id, $ep['id']);
        Assert::same('candidate', $ep['status']);
        Assert::same('unverified', $ep['rights']['status'], 'importer must never auto-set rights, even though this fixture has a public-domain-mark licenseurl');
        Assert::same('html5', $ep['source']['provider']);
        Assert::notNull($ep['source']['url']);
        Assert::notNull($ep['source']['page_url']);
        Assert::true($ep['source']['url'] !== $ep['source']['page_url'], 'the playable media file and the human attribution page must be distinct URLs');
        Assert::same(['added' => [$ep['id']], 'updated' => [], 'unavailable' => [], 'unchanged' => [], 'warnings' => []], $result['summary']);
    }

    public function testMultiPartItemProducesDistinctSuffixedEpisodeIds(): void
    {
        $id = 'multi_part_item';
        $result = IaSeriesBuilder::build(null, $this->defaults(), [$id], [$id => $this->resolved($id)]);
        Assert::count(2, $result['series']['episodes']);
        Assert::same("ia-$id-p1", $result['series']['episodes'][0]['id']);
        Assert::same("ia-$id-p2", $result['series']['episodes'][1]['id']);
        Assert::same(1, $result['series']['episodes'][0]['episode_number']);
        Assert::same(2, $result['series']['episodes'][1]['episode_number']);
    }

    public function testRefreshNeverTouchesEditoriallyOwnedFields(): void
    {
        $id = '0771_Duck_and_Cover_12_33_20_12';
        $first = IaSeriesBuilder::build(null, $this->defaults(), [$id], [$id => $this->resolved($id)]);
        $series = $first['series'];
        // An editor approves it and hand-edits the title.
        $series['episodes'][0]['status'] = 'approved';
        $series['episodes'][0]['title'] = 'Hand-Edited Title';
        $series['episodes'][0]['rights'] = ['status' => 'public_domain', 'notes' => 'confirmed via IA licenseurl, 2026-11-05'];

        $second = IaSeriesBuilder::build($series, $this->defaults(), [$id], [$id => $this->resolved($id)]);
        $ep = $second['series']['episodes'][0];
        Assert::same('approved', $ep['status'], 'status must never be reset by a refresh');
        Assert::same('Hand-Edited Title', $ep['title'], 'title must never be overwritten by a refresh');
        Assert::same('public_domain', $ep['rights']['status'], 'rights must never be reset by a refresh');
        Assert::contains($ep['id'], $second['summary']['unchanged'], 'a refresh with identical source data changes nothing observable');
    }

    public function testRefreshUpdatesSourceReportedFieldsLikeDurationAndThumbnail(): void
    {
        $id = '0771_Duck_and_Cover_12_33_20_12';
        $first = IaSeriesBuilder::build(null, $this->defaults(), [$id], [$id => $this->resolved($id)]);
        $series = $first['series'];
        $series['episodes'][0]['duration'] = 1.0; // simulate stale data
        $series['episodes'][0]['source']['availability'] = 'unavailable';

        $second = IaSeriesBuilder::build($series, $this->defaults(), [$id], [$id => $this->resolved($id)]);
        $ep = $second['series']['episodes'][0];
        Assert::equalsFloat(754.5, $ep['duration'], 0.01, 'duration is source-reported and must re-sync on refresh');
        Assert::same('available', $ep['source']['availability']);
        Assert::contains($ep['id'], $second['summary']['updated']);
    }

    public function testFailedMetadataFetchMarksKnownEpisodesUnavailableWithoutRemovingThem(): void
    {
        $id = '0771_Duck_and_Cover_12_33_20_12';
        $first = IaSeriesBuilder::build(null, $this->defaults(), [$id], [$id => $this->resolved($id)]);
        $series = $first['series'];

        $second = IaSeriesBuilder::build($series, $this->defaults(), [$id], [$id => null]);
        Assert::count(1, $second['series']['episodes'], 'a failed refresh must never delete an episode');
        Assert::same('unavailable', $second['series']['episodes'][0]['source']['availability']);
        Assert::contains('ia-' . $id, $second['summary']['unavailable']);
    }

    public function testBrandNewIdentifiersAreAppendedInDiscoveryOrder(): void
    {
        $idA = 'Conquerb1943';
        $idB = '0771_Duck_and_Cover_12_33_20_12';
        $result = IaSeriesBuilder::build(null, $this->defaults(), [$idA, $idB], [
            $idA => $this->resolved($idA),
            $idB => $this->resolved($idB),
        ]);
        Assert::same(["ia-$idA", "ia-$idB"], array_column($result['series']['episodes'], 'id'));
        Assert::same([1, 2], array_column($result['series']['episodes'], 'episode_number'));
    }

    public function testItemWithNoPlayableFileIsStillRecordedAsAnUnavailableCandidate(): void
    {
        $id = 'unavailable_item';
        $result = IaSeriesBuilder::build(null, $this->defaults(), [$id], [$id => $this->resolved($id)]);
        Assert::count(1, $result['series']['episodes']);
        $ep = $result['series']['episodes'][0];
        Assert::same('unavailable', $ep['source']['availability']);
        Assert::null($ep['source']['url'], 'no playable file -- media url must stay null, never fabricated');
        Assert::same('candidate', $ep['status']);
    }

    public function testSeriesLevelFieldsAreFilledInOnceButNeverOverwritten(): void
    {
        $id = '0771_Duck_and_Cover_12_33_20_12';
        $defaults = $this->defaults();
        $defaults['description'] = 'A fresh description';
        $first = IaSeriesBuilder::build(null, $defaults, [$id], [$id => $this->resolved($id)]);
        Assert::same('A fresh description', $first['series']['description']);

        $series = $first['series'];
        $otherDefaults = $defaults;
        $otherDefaults['description'] = 'A DIFFERENT description that must never clobber the first one';
        $second = IaSeriesBuilder::build($series, $otherDefaults, [$id], [$id => $this->resolved($id)]);
        Assert::same('A fresh description', $second['series']['description']);
    }
}
