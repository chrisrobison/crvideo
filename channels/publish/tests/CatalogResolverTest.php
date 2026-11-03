<?php
declare(strict_types=1);

// Parity coverage for the PHP mirror of channels/catalog-resolver.js --
// see CatalogResolver.php's header for exactly which rules must stay in
// lockstep between the two. This is not a line-for-line port of the JS
// test suite, but it exercises the same categories of case: legacy/none,
// a valid series ref, a missing ref, and path-traversal/unsafe refs.

final class CatalogResolverTest
{
    private function fixture(string $relative): string
    {
        return __DIR__ . "/fixtures/$relative";
    }

    public function testResolvesAValidSeriesReferenceWithItsEpisodesInOrder(): void
    {
        $result = CatalogResolver::resolveCatalog($this->fixture('repo-root-ok/channels/sample/catalog.json'));
        Assert::count(0, $result['errors']);
        Assert::count(1, $result['series']);
        Assert::same('a', $result['series'][0]['id']);
        Assert::count(2, $result['series'][0]['episodes']);
        Assert::same('ep1', $result['series'][0]['episodes'][0]['id']);
    }

    public function testMissingSeriesFileProducesAnActionableErrorNotACrash(): void
    {
        $result = CatalogResolver::resolveCatalog($this->fixture('repo-root-ok/channels/sample-missing/catalog.json'));
        Assert::count(0, $result['series']);
        Assert::count(1, $result['errors']);
        Assert::true(str_contains($result['errors'][0], 'not found'));
    }

    public function testMissingCatalogItselfProducesAnActionableErrorNotACrash(): void
    {
        $result = CatalogResolver::resolveCatalog($this->fixture('repo-root-ok/channels/does-not-exist/catalog.json'));
        Assert::count(0, $result['series']);
        Assert::count(1, $result['errors']);
    }

    public function testPathTraversalAndUnsafeReferencesAreRejectedNotFollowed(): void
    {
        $result = CatalogResolver::resolveCatalog($this->fixture('traversal/channels/sample/catalog.json'));
        Assert::count(0, $result['series']);
        Assert::count(3, $result['errors']);
        foreach ($result['errors'] as $e) {
            Assert::true(
                str_contains($e, 'escapes the allowed root') || str_contains($e, 'absolute or protocol-relative'),
                "unexpected error message: $e"
            );
        }
    }

    public function testResolveRefRejectsAbsoluteAndProtocolRelativeReferences(): void
    {
        $catalogPath = $this->fixture('repo-root-ok/channels/sample/catalog.json');
        $abs = CatalogResolver::resolveRef($catalogPath, 'https://evil.example/x.json');
        Assert::true(isset($abs['error']));
        $protoRel = CatalogResolver::resolveRef($catalogPath, '//evil.example/x.json');
        Assert::true(isset($protoRel['error']));
        $fine = CatalogResolver::resolveRef($catalogPath, '../../series/a/series.json');
        Assert::true(isset($fine['path']));
    }
}
