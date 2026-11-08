<?php
declare(strict_types=1);

require_once __DIR__ . '/TestFixtures.php';

final class JobQueueTest
{
    private string $root;
    private string $channelDir;

    public function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/crvideo-queue-test-' . bin2hex(random_bytes(6));
        $this->channelDir = "{$this->root}/channel";
        mkdir($this->channelDir, 0775, true);
    }

    public function tearDown(): void
    {
        TestFixtures::destroy($this->root);
    }

    public function testEnqueueDeduplicatesIdenticalJobs(): void
    {
        $queue = new JobQueue($this->channelDir);
        Assert::true($queue->enqueue('job-1', ['foo' => 'bar']));
        Assert::false($queue->enqueue('job-1', ['foo' => 'different']), 'a second enqueue with the same id must be a no-op');
        $counts = $queue->counts();
        Assert::same(1, $counts['pending']);
    }

    public function testClaimNextClaimsOldestFirstAndMovesToRunning(): void
    {
        $queue = new JobQueue($this->channelDir);
        $queue->enqueue('job-older', ['n' => 1]);
        usleep(10_000);
        $queue->enqueue('job-newer', ['n' => 2]);

        $claimed = $queue->claimNext();
        Assert::notNull($claimed);
        Assert::same('job-older', $claimed['id']);
        Assert::same(1, $queue->counts()['pending']);
        Assert::same(1, $queue->counts()['running']);
    }

    public function testTwoWorkersCanNeverClaimTheSameJob(): void
    {
        $queue = new JobQueue($this->channelDir);
        $queue->enqueue('only-job', ['n' => 1]);
        $first = $queue->claimNext();
        $second = $queue->claimNext(); // simulates a second worker racing for the same job
        Assert::notNull($first);
        Assert::null($second, 'nothing left to claim once the only job is already running');
    }

    public function testCompleteMovesJobToDone(): void
    {
        $queue = new JobQueue($this->channelDir);
        $queue->enqueue('job-1', ['n' => 1]);
        $job = $queue->claimNext();
        $queue->complete($job['id'], ['status' => 'ready']);
        $counts = $queue->counts();
        Assert::same(0, $counts['running']);
        Assert::same(1, $counts['done']);
    }

    public function testFailRetriesWithBackoffThenMovesToError(): void
    {
        $queue = new JobQueue($this->channelDir);
        $retryConfig = ['maxAttempts' => 2, 'baseDelaySeconds' => 3600]; // long backoff -- must not be immediately re-claimable
        $queue->enqueue('job-1', ['n' => 1]);

        $job = $queue->claimNext();
        $queue->fail($job['id'], 'first failure', $retryConfig);
        Assert::same(1, $queue->counts()['pending'], 'attempt 1 of 2 goes back to pending, waiting out backoff');
        Assert::null($queue->claimNext(), 'must not be claimable again immediately -- still backing off');

        // Force the backoff to have already elapsed, then fail a second time.
        $pendingFile = glob("{$this->channelDir}/.announcer/jobs/pending/*.json")[0];
        $payload = json_decode((string) file_get_contents($pendingFile), true);
        $payload['nextRetryAt'] = gmdate('c', time() - 10);
        file_put_contents($pendingFile, json_encode($payload));

        $job2 = $queue->claimNext();
        Assert::notNull($job2, 'claimable again once the backoff has elapsed');
        $queue->fail($job2['id'], 'second failure', $retryConfig);
        Assert::same(1, $queue->counts()['error'], 'attempt 2 of 2 exhausts retries -> error');
        Assert::same(0, $queue->counts()['pending']);
    }

    public function testReclaimStaleRecoversFromACrashedWorker(): void
    {
        $queue = new JobQueue($this->channelDir);
        $queue->enqueue('job-1', ['n' => 1]);
        $job = $queue->claimNext(); // now sitting in "running" as if a worker crashed
        Assert::same(1, $queue->counts()['running']);

        $reclaimed = $queue->reclaimStale(0); // anything in "running" at all counts as stale
        Assert::same(1, $reclaimed);
        Assert::same(1, $queue->counts()['pending']);
        Assert::same(0, $queue->counts()['running']);
    }

    public function testEnqueueAfterDoneIsStillDeduplicated(): void
    {
        $queue = new JobQueue($this->channelDir);
        $queue->enqueue('job-1', ['n' => 1]);
        $job = $queue->claimNext();
        $queue->complete($job['id']);
        // A caller re-deriving the same hash for the same transition must
        // not re-enqueue it once it's already done.
        Assert::false($queue->enqueue('job-1', ['n' => 1]));
    }
}
