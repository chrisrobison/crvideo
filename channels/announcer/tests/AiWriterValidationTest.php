<?php
declare(strict_types=1);

require_once __DIR__ . '/TestFixtures.php';

final class AiWriterValidationTest
{
    private array $context;
    private array $styleConfig;

    public function setUp(): void
    {
        $this->context = [
            'type' => 'coming_up_next',
            'transitionId' => 'cont-1',
            'channelName' => 'Test Channel',
            'channelDescription' => 'A channel for testing.',
            'nextBlock' => ['title' => 'Show B', 'description' => 'A show about other things.'],
            'currentBlock' => ['title' => 'Show A', 'description' => null],
            'episodeInfo' => null,
            'isConsecutiveSameSeries' => false,
            'timeOfDay' => '14:00',
        ];
        $this->styleConfig = ['style' => 'test style', 'tone' => 'test tone', 'targetDuration' => 10, 'wordsPerSecond' => 2.5];
    }

    public function testWordBudgetIsWithinConfiguredBounds(): void
    {
        $budget = WriterPromptBuilder::wordBudget(['targetDuration' => 10, 'wordsPerSecond' => 2.5]);
        Assert::same(25, $budget);
    }

    public function testWordBudgetIsClamped(): void
    {
        $tiny = WriterPromptBuilder::wordBudget(['targetDuration' => 0, 'wordsPerSecond' => 2.5]);
        Assert::true($tiny >= 6, 'never below the minimum budget');
        $huge = WriterPromptBuilder::wordBudget(['targetDuration' => 1000, 'wordsPerSecond' => 2.5]);
        Assert::true($huge <= 80, 'never above the maximum budget');
    }

    public function testPromptNeverInventsInformationNotInContext(): void
    {
        $built = WriterPromptBuilder::build($this->context, $this->styleConfig);
        // The prompt must carry the supplied show name...
        Assert::stringContains('Show B', $built['prompt']);
        // ...but never a name that was never supplied anywhere in the context.
        Assert::false(str_contains($built['prompt'], 'Connections'));
        Assert::stringContains('Never invent', $built['prompt']);
    }

    public function testTemplateWriterAlwaysSucceeds(): void
    {
        $writer = new TemplateAiWriter();
        $result = $writer->write($this->context, $this->styleConfig);
        Assert::null($result['error']);
        Assert::true(trim($result['text']) !== '');
        Assert::stringContains('Show B', $result['text'], 'must name the upcoming show');
    }

    public function testTemplateWriterIsDeterministic(): void
    {
        $writer = new TemplateAiWriter();
        $a = $writer->write($this->context, $this->styleConfig);
        $b = $writer->write($this->context, $this->styleConfig);
        Assert::same($a['text'], $b['text'], 'same context must always produce the same template text');
    }

    public function testTemplateWriterHandlesNoUpcomingProgram(): void
    {
        $writer = new TemplateAiWriter();
        $context = $this->context;
        $context['nextBlock'] = null;
        $result = $writer->write($context, $this->styleConfig);
        Assert::null($result['error']);
        Assert::true(trim($result['text']) !== '');
    }

    public function testTemplateWriterKeepsConsecutiveEpisodesBrief(): void
    {
        $writer = new TemplateAiWriter();
        $context = $this->context;
        $context['isConsecutiveSameSeries'] = true;
        $result = $writer->write($context, $this->styleConfig);
        Assert::stringContains('another episode', strtolower($result['text']));
    }

    public function testMockWriterCanSimulateFailure(): void
    {
        $writer = new MockAiWriter(shouldFail: true);
        $result = $writer->write($this->context, $this->styleConfig);
        Assert::notNull($result['error']);
    }

    public function testMockWriterSucceedsByDefault(): void
    {
        $writer = new MockAiWriter();
        $result = $writer->write($this->context, $this->styleConfig);
        Assert::null($result['error']);
        Assert::true(trim($result['text']) !== '');
    }
}
