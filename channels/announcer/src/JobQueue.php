<?php
declare(strict_types=1);

// channels/announcer/src/JobQueue.php
//
// File-based job queue (spec sections 4/5/6/11) -- this project has no
// database and no daemon anywhere (see channels/announcer/README.md's
// architecture notes), so this follows the exact same posture every
// other "background" task already uses: plain files, atomic rename() as
// the claim/transition primitive, meant to be drained by a cron-invoked
// CLI worker (channels/announce-worker.php), not a long-running process
// manager.
//
// Layout, under channels/<id>/.announcer/jobs/:
//   pending/<jobId>.json   -- waiting to run (or waiting out a retry backoff)
//   running/<jobId>.json   -- claimed by a worker (mtime = claim time)
//   done/<jobId>.json      -- finished successfully
//   error/<jobId>.json     -- exhausted its retries
//
// $jobId IS the job's own content hash (ScriptCache's hash for that
// transition's inputs) -- so enqueueing the same transition twice before
// it's processed is a plain file-exists no-op (spec: "Deduplication of
// identical synthesis requests"), and an atomic rename() from pending/ to
// running/ is what guarantees two workers can never both claim the same
// job (spec: "Concurrent generation requests").

final class JobQueue
{
    public function __construct(private string $channelDir)
    {
    }

    private function dir(string $state): string
    {
        return "{$this->channelDir}/.announcer/jobs/$state";
    }

    private function ensureDirs(): void
    {
        foreach (['pending', 'running', 'done', 'error'] as $state) {
            $dir = $this->dir($state);
            if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
                throw new RuntimeException("Failed to create directory: $dir");
            }
        }
    }

    /** @return bool true if a new job was enqueued, false if one with this id already exists in any state (dedup) */
    public function enqueue(string $jobId, array $payload): bool
    {
        $this->ensureDirs();
        foreach (['pending', 'running', 'done', 'error'] as $state) {
            if (is_file("{$this->dir($state)}/$jobId.json")) {
                return false;
            }
        }
        $payload['id'] = $jobId;
        $payload['attempts'] = $payload['attempts'] ?? 0;
        $payload['createdAt'] = $payload['createdAt'] ?? gmdate('c');
        // Microsecond-resolution ordering key -- filemtime()/filesystem mtimes
        // are only 1-second resolution on most filesystems, which is not fine
        // enough to reliably order jobs enqueued milliseconds apart (e.g. every
        // transition in one publish.php run).
        $payload['createdAtMicro'] = $payload['createdAtMicro'] ?? microtime(true);
        $payload['nextRetryAt'] = $payload['nextRetryAt'] ?? null;
        $this->atomicWriteJson("{$this->dir('pending')}/$jobId.json", $payload);
        return true;
    }

    /** Reclaims any "running" job older than $staleSeconds back to "pending"
     *  -- spec: "Recovery after worker restarts" / "Restarted or interrupted
     *  generation workers". Call this before claimNext() on worker startup. */
    public function reclaimStale(int $staleSeconds): int
    {
        $this->ensureDirs();
        $reclaimed = 0;
        foreach (glob($this->dir('running') . '/*.json') ?: [] as $file) {
            if (time() - (int) filemtime($file) >= $staleSeconds) {
                $jobId = basename($file, '.json');
                if (@rename($file, "{$this->dir('pending')}/$jobId.json")) {
                    $reclaimed++;
                }
            }
        }
        return $reclaimed;
    }

    /** Atomically claims the oldest pending job that is actually due (no
     *  nextRetryAt, or one in the past). Returns null if the queue is
     *  empty or every pending job is still waiting out a retry backoff.
     *  @return array{id:string, payload:array<string,mixed>}|null
     */
    public function claimNext(): ?array
    {
        $this->ensureDirs();
        $files = glob($this->dir('pending') . '/*.json') ?: [];
        $payloads = [];
        foreach ($files as $file) {
            $payload = json_decode((string) file_get_contents($file), true);
            if (is_array($payload)) {
                $payloads[] = ['file' => $file, 'payload' => $payload];
            }
        }
        usort($payloads, static fn ($a, $b) => ($a['payload']['createdAtMicro'] ?? filemtime($a['file']))
            <=> ($b['payload']['createdAtMicro'] ?? filemtime($b['file'])));

        $now = time();
        foreach ($payloads as ['file' => $file, 'payload' => $payload]) {
            $nextRetryAt = $payload['nextRetryAt'] ?? null;
            if (is_string($nextRetryAt)) {
                try {
                    if ((new DateTimeImmutable($nextRetryAt))->getTimestamp() > $now) {
                        continue; // still backing off
                    }
                } catch (Throwable) {
                    // malformed timestamp -- treat as due rather than stuck forever
                }
            }
            $jobId = basename($file, '.json');
            $runningPath = "{$this->dir('running')}/$jobId.json";
            if (@rename($file, $runningPath)) {
                touch($runningPath); // claim time, for reclaimStale()'s staleness check
                return ['id' => $jobId, 'payload' => $payload];
            }
            // Lost the race to another worker (or the file vanished) -- try the next one.
        }
        return null;
    }

    public function complete(string $jobId, array $result = []): void
    {
        $this->ensureDirs();
        $runningPath = "{$this->dir('running')}/$jobId.json";
        $payload = is_file($runningPath) ? (json_decode((string) file_get_contents($runningPath), true) ?: []) : ['id' => $jobId];
        $payload['result'] = $result;
        $payload['completedAt'] = gmdate('c');
        $this->atomicWriteJson("{$this->dir('done')}/$jobId.json", $payload);
        @unlink($runningPath);
    }

    /** @param array{maxAttempts:int, baseDelaySeconds:int} $retryConfig */
    public function fail(string $jobId, string $error, array $retryConfig): void
    {
        $this->ensureDirs();
        $runningPath = "{$this->dir('running')}/$jobId.json";
        $payload = is_file($runningPath) ? (json_decode((string) file_get_contents($runningPath), true) ?: []) : ['id' => $jobId];
        $payload['attempts'] = (int) ($payload['attempts'] ?? 0) + 1;
        $payload['lastError'] = $error;
        $payload['lastErrorAt'] = gmdate('c');

        $maxAttempts = $retryConfig['maxAttempts'] ?? 5;
        if ($payload['attempts'] >= $maxAttempts) {
            $this->atomicWriteJson("{$this->dir('error')}/$jobId.json", $payload);
            @unlink($runningPath);
            return;
        }

        $base = $retryConfig['baseDelaySeconds'] ?? 30;
        $delay = $base * (2 ** ($payload['attempts'] - 1)); // exponential backoff
        $payload['nextRetryAt'] = gmdate('c', time() + $delay);
        $this->atomicWriteJson("{$this->dir('pending')}/$jobId.json", $payload);
        @unlink($runningPath);
    }

    /** @return array{pending:int,running:int,done:int,error:int} */
    public function counts(): array
    {
        $this->ensureDirs();
        $out = [];
        foreach (['pending', 'running', 'done', 'error'] as $state) {
            $out[$state] = count(glob($this->dir($state) . '/*.json') ?: []);
        }
        return $out;
    }

    private function atomicWriteJson(string $path, array $data): void
    {
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json === false) {
            throw new RuntimeException("Failed to encode JSON for: $path");
        }
        $tmp = $path . '.' . getmypid() . '.' . mt_rand(1000, 9999) . '.tmp';
        if (file_put_contents($tmp, $json . "\n") === false) {
            throw new RuntimeException("Failed to write temp file: $tmp");
        }
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException("Failed to finalize write for: $path");
        }
    }
}
