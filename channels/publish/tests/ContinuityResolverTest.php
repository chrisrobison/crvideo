<?php
declare(strict_types=1);

final class ContinuityResolverTest
{
    private function fixture(string $relative): string
    {
        return __DIR__ . "/fixtures/continuity-ok/$relative";
    }

    public function testNoContinuityArrayAtAllResolvesToAnEmptyPoolNotAnError(): void
    {
        $result = ContinuityResolver::resolveCatalog($this->fixture('channels/sample-no-continuity/catalog.json'));
        Assert::count(0, $result['assets']);
        Assert::count(0, $result['cards']);
        Assert::count(0, $result['errors']);
    }

    public function testMissingCatalogItselfResolvesToAnEmptyPoolNotAnError(): void
    {
        $result = ContinuityResolver::resolveCatalog($this->fixture('channels/does-not-exist/catalog.json'));
        Assert::count(0, $result['assets']);
        Assert::count(0, $result['errors']);
    }

    public function testMergesANetworkWideAndAChannelSpecificContinuityFile(): void
    {
        $result = ContinuityResolver::resolveCatalog($this->fixture('channels/sample/catalog.json'));
        Assert::count(0, $result['errors']);
        Assert::count(3, $result['assets'], 'two network station ids + one channel-specific filler item');
        Assert::count(2, $result['cards']);
    }

    public function testOnlyApprovedAssetsAreExposedAsApprovedTheRestStillReportedByStatus(): void
    {
        $result = ContinuityResolver::resolveCatalog($this->fixture('channels/sample/catalog.json'));
        $byId = [];
        foreach ($result['assets'] as $a) {
            $byId[$a['id']] = $a;
        }
        Assert::same('approved', $byId['network-id-15']['status']);
        Assert::same('candidate', $byId['network-id-30']['status'], 'present in the pool, but not approved -- ContinuityFiller must still exclude it from selection');
    }

    public function testDefaultsMergeLastRefWinsPerKey(): void
    {
        $result = ContinuityResolver::resolveCatalog($this->fixture('channels/sample/catalog.json'));
        Assert::same('up-next', $result['defaults']['preferredCard'], 'overridden by the channel-specific (second) ref');
        Assert::same(10, $result['defaults']['minimumVideoFiller'], 'kept from the network-wide (first) ref since the second never sets it');
    }

    public function testAMissingReferencedContinuityFileIsReportedNotFatal(): void
    {
        $result = ContinuityResolver::resolveCatalog($this->fixture('channels/sample-missing/catalog.json'));
        Assert::count(0, $result['assets']);
        Assert::count(1, $result['errors']);
        Assert::true(str_contains($result['errors'][0], 'not found'));
    }

    public function testADuplicateContinuityReferenceIsReportedNotSilentlyDoubleCounted(): void
    {
        $result = ContinuityResolver::resolveCatalog($this->fixture('channels/sample-dup/catalog.json'));
        Assert::count(2, $result['assets'], 'the network file is only actually merged once');
        Assert::count(1, $result['errors']);
        Assert::true(str_contains($result['errors'][0], 'duplicate'));
    }
}
