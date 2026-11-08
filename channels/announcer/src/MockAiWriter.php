<?php
declare(strict_types=1);

// channels/announcer/src/MockAiWriter.php
//
// Test double for AiWriterInterface: never shells out to anything,
// returns a fixed/predictable script (or simulates a failure, if
// constructed with $shouldFail), so tests can exercise
// AnnouncerPipeline/JobQueue/caching logic without any real AI
// dependency and without the non-determinism a real LLM call would add.

final class MockAiWriter implements AiWriterInterface
{
    public function __construct(
        private bool $shouldFail = false,
        private string $fixedText = 'Coming up next, a mock announcement for testing.',
    ) {
    }

    public function write(array $context, array $styleConfig): array
    {
        if ($this->shouldFail) {
            return ['text' => '', 'provider' => 'mock', 'model' => null, 'usedFallback' => false, 'error' => 'simulated failure'];
        }
        return ['text' => $this->fixedText, 'provider' => 'mock', 'model' => null, 'usedFallback' => false, 'error' => null];
    }
}
