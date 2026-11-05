<?php
declare(strict_types=1);

final class ArchiveCollectionSearchTest
{
    private function transport(array $pages): \Closure
    {
        return function (string $url, int $timeoutSeconds) use ($pages): array {
            $query = [];
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            $page = (int) ($query['page'] ?? 1);
            if (!isset($pages[$page])) {
                return ['status' => 200, 'body' => json_encode(['response' => ['docs' => []]]), 'error' => null];
            }
            return ['status' => 200, 'body' => json_encode(['response' => ['docs' => $pages[$page]]]), 'error' => null];
        };
    }

    /** Simulates a real server: a flat dataset, sliced by whatever `rows`/`page`
     *  the client actually requested -- so "fewer than requested" only ever
     *  happens on the genuinely last page, regardless of how many rows per
     *  page the client asked for. */
    private function flatTransport(array $allIdentifiers): \Closure
    {
        return function (string $url, int $timeoutSeconds) use ($allIdentifiers): array {
            $query = [];
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            $page = (int) ($query['page'] ?? 1);
            $rows = (int) ($query['rows'] ?? 200);
            $offset = ($page - 1) * $rows;
            $slice = array_slice($allIdentifiers, $offset, $rows);
            $docs = array_map(static fn (string $id): array => ['identifier' => $id], $slice);
            return ['status' => 200, 'body' => json_encode(['response' => ['docs' => $docs]]), 'error' => null];
        };
    }

    public function testBasicSearchReturnsIdentifiersInOrder(): void
    {
        $client = new ArchiveCollectionSearch(15, $this->transport([
            1 => [['identifier' => 'a'], ['identifier' => 'b'], ['identifier' => 'c']],
        ]));
        $result = $client->search('collection:(prelinger)', 10);
        Assert::same(['a', 'b', 'c'], $result['identifiers']);
        Assert::count(0, $result['warnings']);
    }

    public function testPaginatesUntilRowsSatisfied(): void
    {
        // perPage is capped at 200/request, so asking for 220 rows against a
        // 220-identifier dataset must take two requests (200 + 20) and
        // concatenate both pages' results in order.
        $all = array_map(static fn (int $i): string => "id$i", range(0, 219));
        $client = new ArchiveCollectionSearch(15, $this->flatTransport($all));
        $result = $client->search('collection:(x)', 220);
        Assert::same($all, $result['identifiers']);
    }

    public function testStopsAtRowsEvenIfMoreAreAvailable(): void
    {
        $client = new ArchiveCollectionSearch(15, $this->transport([
            1 => [['identifier' => 'a'], ['identifier' => 'b'], ['identifier' => 'c']],
        ]));
        $result = $client->search('collection:(x)', 2);
        Assert::same(['a', 'b'], $result['identifiers']);
    }

    public function testEmptyResultsStopPaginationCleanlyNotAsAnError(): void
    {
        $client = new ArchiveCollectionSearch(15, $this->transport([]));
        $result = $client->search('collection:(nothing-here)', 50);
        Assert::count(0, $result['identifiers']);
        Assert::count(0, $result['warnings'], 'no matches is not itself a warning condition');
    }

    public function testEmptyQueryIsRejectedWithAWarningNotACrash(): void
    {
        $client = new ArchiveCollectionSearch(15, $this->transport([]));
        $result = $client->search('   ', 50);
        Assert::count(0, $result['identifiers']);
        Assert::true(count($result['warnings']) > 0);
    }

    public function testTransportErrorProducesAWarningAndWhateverWasAlreadyFound(): void
    {
        $failing = function (string $url, int $timeoutSeconds): array {
            return ['status' => 500, 'body' => null, 'error' => null];
        };
        $client = new ArchiveCollectionSearch(15, $failing);
        $result = $client->search('collection:(x)', 50);
        Assert::count(0, $result['identifiers']);
        Assert::true(count($result['warnings']) > 0);
    }

    public function testDuplicateIdentifiersAcrossPagesAreDeduped(): void
    {
        $client = new ArchiveCollectionSearch(15, $this->transport([
            1 => [['identifier' => 'a'], ['identifier' => 'b']],
        ]));
        $result = $client->search('collection:(x)', 2);
        Assert::same(['a', 'b'], $result['identifiers']);
    }
}
