<?php
declare(strict_types=1);

// ia-import/src/ArchiveCollectionSearch.php
//
// Discovers a list of Internet Archive identifiers matching a query (most
// commonly "collection:(some-collection)") via the public
// https://archive.org/advancedsearch.php endpoint, paginating as needed.
// This is a *discovery* step only -- it never fetches full item metadata
// (that's ArchiveMetadataClient's job, against /metadata/{identifier}) and
// never resolves media or writes anything. Siblings ArchiveListParser
// (reads a pre-fetched user list JSON) and this class both just produce a
// plain list of identifiers that downstream code treats identically.
//
// Same injectable-transport pattern as ArchiveMetadataClient, for the same
// reason: --fixtures / tests run with zero live network access.
//
// Hard restriction, same as ArchiveMetadataClient: only ever builds/
// requests archive.org (or *.archive.org) HTTPS URLs.

final class ArchiveCollectionSearch
{
    /** @var \Closure|null function(string $url, int $timeoutSeconds): array{status:int, body:?string, error:?string} */
    private ?\Closure $httpClient;
    /** @var \Closure|null function(string $message): void */
    private ?\Closure $logger;

    public function __construct(
        private int $timeoutSeconds = 15,
        ?\Closure $httpClient = null,
        ?\Closure $logger = null,
    ) {
        $this->httpClient = $httpClient;
        $this->logger = $logger;
    }

    private function log(string $message): void
    {
        if ($this->logger) {
            ($this->logger)($message);
        }
    }

    /**
     * @return array{identifiers: list<string>, warnings: list<string>}
     */
    public function search(string $query, int $rows = 200, string $sort = 'downloads desc'): array
    {
        $query = trim($query);
        if ($query === '') {
            return ['identifiers' => [], 'warnings' => ['Empty search query; nothing to discover.']];
        }
        $rows = max(1, $rows);
        $perPage = min(200, $rows);

        $identifiers = [];
        $warnings = [];
        $page = 1;
        $client = $this->httpClient ?? $this->defaultTransport();

        while (count($identifiers) < $rows) {
            // archive.org's "page" offset is computed server-side as
            // (page-1)*rows using THIS request's own "rows" value -- so
            // "rows" must stay constant across every page of the same
            // search, never shrunk to "just what's still needed" on a
            // later page (that would silently skip or re-fetch results).
            // Any surplus beyond the caller's requested $rows is trimmed
            // once, below, after pagination ends.
            $url = $this->buildUrl($query, $perPage, $page, $sort);
            if ($url === null) {
                $warnings[] = "Rejected query (did not resolve to an allowed archive.org URL): $query";
                break;
            }

            $resp = $client($url, $this->timeoutSeconds);
            $status = (int) ($resp['status'] ?? 0);
            $error = $resp['error'] ?? null;
            if ($error !== null || $status !== 200) {
                $warnings[] = "Search request failed (page $page): " . ($error ?? "HTTP $status");
                break;
            }

            $data = json_decode((string) ($resp['body'] ?? ''), true);
            $docs = $data['response']['docs'] ?? null;
            if (!is_array($docs)) {
                $warnings[] = "Search response (page $page) did not contain the expected response.docs array.";
                break;
            }
            if (!$docs) {
                break; // no more results
            }

            foreach ($docs as $doc) {
                $id = is_array($doc) ? ($doc['identifier'] ?? null) : null;
                if (is_string($id) && $id !== '') {
                    $identifiers[] = $id;
                }
            }
            $this->log('search page ' . $page . ': ' . count($docs) . ' docs (running total ' . count($identifiers) . ')');

            if (count($docs) < $perPage) {
                break; // last page -- server returned fewer than asked for
            }
            $page++;
        }

        return ['identifiers' => array_values(array_unique(array_slice($identifiers, 0, $rows))), 'warnings' => $warnings];
    }

    private function buildUrl(string $query, int $rows, int $page, string $sort): ?string
    {
        $params = [
            'q' => $query,
            'fl[]' => 'identifier',
            'sort[]' => $sort,
            'rows' => (string) $rows,
            'page' => (string) $page,
            'output' => 'json',
        ];
        $url = 'https://archive.org/advancedsearch.php?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986);
        return $this->isAllowedUrl($url) ? $url : null;
    }

    private function isAllowedUrl(string $url): bool
    {
        $parts = parse_url($url);
        if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https') {
            return false;
        }
        $host = strtolower($parts['host'] ?? '');
        return $host === 'archive.org' || str_ends_with($host, '.archive.org');
    }

    private function defaultTransport(): \Closure
    {
        return function (string $url, int $timeoutSeconds): array {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => $timeoutSeconds,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                CURLOPT_HTTPHEADER => ['Accept: application/json'],
                CURLOPT_USERAGENT => 'crvideo-ia-series-import/1.0',
            ]);
            $body = curl_exec($ch);
            $error = curl_error($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            curl_close($ch);
            return ['status' => $status, 'body' => $body === false ? null : $body, 'error' => $error !== '' ? $error : null];
        };
    }
}
