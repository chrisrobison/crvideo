<?php
declare(strict_types=1);

// ia-import/src/ArchiveMetadataClient.php
//
// Fetches https://archive.org/metadata/{identifier} for a batch of
// identifiers, using the local MetadataCache first and falling back to HTTP
// only for misses (or when $refresh is set). Concurrency for real network
// fetches is done via curl_multi (plain PHP CLI has no real threads).
//
// The HTTP transport is injectable (a Closure(string $url, int $timeoutSeconds):
// array{status:int, body:?string, error:?string}) so tests -- and the CLI's
// --fixtures mode -- can run with zero live network access. When no
// transport is injected, a real curl_multi-based implementation is used.
//
// Hard restriction: this client will only ever build/request URLs on
// archive.org or *.archive.org over HTTPS. It never fetches a URL derived
// from untrusted metadata fields.

final class ArchiveMetadataClient
{
    /** @var \Closure|null function(string $url, int $timeoutSeconds): array{status:int, body:?string, error:?string} */
    private ?\Closure $httpClient;
    /** @var \Closure|null function(string $message): void */
    private ?\Closure $logger;

    public function __construct(
        private MetadataCache $cache,
        private int $timeoutSeconds = 15,
        private int $concurrency = 4,
        private bool $refresh = false,
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
     * @param list<string> $identifiers
     * @return array<string, array{raw: ?array, from_cache: bool, stale: bool, error: ?string}>
     */
    public function fetchMany(array $identifiers): array
    {
        $result = [];
        $toFetch = [];

        foreach (array_values(array_unique($identifiers)) as $id) {
            if (!$this->refresh) {
                $cached = $this->cache->get($id);
                if ($cached !== null) {
                    $result[$id] = ['raw' => $cached['raw'], 'from_cache' => true, 'stale' => false, 'error' => null];
                    $this->log("cache hit: $id");
                    continue;
                }
            }
            $toFetch[] = $id;
        }

        if ($toFetch) {
            $fetched = $this->httpClient !== null
                ? $this->fetchSequential($toFetch, $this->httpClient)
                : $this->fetchConcurrent($toFetch);

            foreach ($fetched as $id => $r) {
                if ($r['error'] === null && $r['raw'] !== null) {
                    $this->cache->set($id, $r['raw']);
                    $result[$id] = ['raw' => $r['raw'], 'from_cache' => false, 'stale' => false, 'error' => null];
                    $this->log("fetched: $id");
                    continue;
                }

                // A failed fetch must never invalidate a previously cached
                // successful result -- fall back to a stale cache entry if
                // one exists rather than reporting total failure.
                $stale = $this->cache->get($id, true);
                if ($stale !== null) {
                    $result[$id] = ['raw' => $stale['raw'], 'from_cache' => true, 'stale' => true, 'error' => null];
                    $this->log("fetch failed, using stale cache: $id ({$r['error']})");
                } else {
                    $result[$id] = ['raw' => null, 'from_cache' => false, 'stale' => false, 'error' => $r['error']];
                    $this->log("fetch failed: $id ({$r['error']})");
                }
            }
        }

        return $result;
    }

    public function buildUrl(string $identifier): ?string
    {
        $clean = trim($identifier);
        if ($clean === '') {
            return null;
        }
        // IA identifiers are restricted in practice to this charset; reject
        // anything else defensively rather than trying to URL-encode our
        // way around it.
        if (!preg_match('/^[A-Za-z0-9_.\-]+$/', $clean)) {
            return null;
        }
        $url = 'https://archive.org/metadata/' . rawurlencode($clean);
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

    private function isTransientStatus(int $status): bool
    {
        return $status === 0 || $status >= 500 || $status === 429;
    }

    /**
     * @return array<string, array{raw: ?array, error: ?string}>
     */
    private function fetchSequential(array $ids, \Closure $client): array
    {
        $out = [];
        foreach ($ids as $id) {
            $out[$id] = $this->fetchOneWithRetry($id, $client);
        }
        return $out;
    }

    private function fetchOneWithRetry(string $id, \Closure $client, int $attempt = 1): array
    {
        $url = $this->buildUrl($id);
        if ($url === null) {
            return ['raw' => null, 'error' => 'invalid identifier (rejected before any request was made)'];
        }

        $resp = $client($url, $this->timeoutSeconds);
        $status = (int) ($resp['status'] ?? 0);
        $error = $resp['error'] ?? null;

        if ($error !== null || $this->isTransientStatus($status)) {
            if ($attempt < 3) {
                usleep(100000 * $attempt);
                return $this->fetchOneWithRetry($id, $client, $attempt + 1);
            }
            return ['raw' => null, 'error' => $error ?? "HTTP $status after retries"];
        }

        if ($status !== 200) {
            return ['raw' => null, 'error' => "HTTP $status"];
        }

        $data = json_decode((string) ($resp['body'] ?? ''), true);
        if (!is_array($data)) {
            return ['raw' => null, 'error' => 'invalid JSON in metadata response'];
        }
        if (array_key_exists('error', $data)) {
            return ['raw' => null, 'error' => (string) $data['error']];
        }

        return ['raw' => $data, 'error' => null];
    }

    /**
     * Real network path: curl_multi, chunked by $this->concurrency, with one
     * retry pass for chunks that came back with transient errors.
     *
     * @return array<string, array{raw: ?array, error: ?string}>
     */
    private function fetchConcurrent(array $ids): array
    {
        $out = [];
        $pending = $ids;

        for ($attempt = 1; $attempt <= 3 && $pending; $attempt++) {
            $retry = [];
            foreach (array_chunk($pending, max(1, $this->concurrency)) as $chunk) {
                $mh = curl_multi_init();
                $handles = [];
                foreach ($chunk as $id) {
                    $url = $this->buildUrl($id);
                    if ($url === null) {
                        $out[$id] = ['raw' => null, 'error' => 'invalid identifier (rejected before any request was made)'];
                        continue;
                    }
                    $ch = curl_init($url);
                    curl_setopt_array($ch, [
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_TIMEOUT => $this->timeoutSeconds,
                        CURLOPT_FOLLOWLOCATION => true,
                        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                        CURLOPT_HTTPHEADER => ['Accept: application/json'],
                        CURLOPT_USERAGENT => 'crvideo-ia-import/1.0',
                    ]);
                    curl_multi_add_handle($mh, $ch);
                    $handles[$id] = $ch;
                }
                $running = null;
                do {
                    curl_multi_exec($mh, $running);
                    if ($running > 0) {
                        curl_multi_select($mh);
                    }
                } while ($running > 0);

                foreach ($handles as $id => $ch) {
                    $body = curl_multi_getcontent($ch);
                    $curlError = curl_error($ch);
                    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
                    curl_multi_remove_handle($mh, $ch);
                    curl_close($ch);

                    if ($curlError !== '' || $this->isTransientStatus($status)) {
                        $retry[] = $id;
                        continue;
                    }
                    if ($status !== 200) {
                        $out[$id] = ['raw' => null, 'error' => "HTTP $status"];
                        continue;
                    }
                    $data = json_decode((string) $body, true);
                    if (!is_array($data)) {
                        $out[$id] = ['raw' => null, 'error' => 'invalid JSON in metadata response'];
                        continue;
                    }
                    if (array_key_exists('error', $data)) {
                        $out[$id] = ['raw' => null, 'error' => (string) $data['error']];
                        continue;
                    }
                    $out[$id] = ['raw' => $data, 'error' => null];
                }
                curl_multi_close($mh);
            }
            if ($retry) {
                usleep(150000 * $attempt);
            }
            $pending = $retry;
        }

        foreach ($pending as $id) {
            $out[$id] = ['raw' => null, 'error' => 'HTTP error after retries'];
        }

        return $out;
    }
}
