<?php
declare(strict_types=1);

// channels/announcer/src/WriterPromptBuilder.php
//
// Builds the structured prompt + JSON Schema sent to an AiWriterInterface
// implementation, and the deterministic word budget every writer
// (AI or template) must respect. Embeds ONLY fields already present on
// the supplied AnnouncementContext -- never anything invented here --
// and is the single place the "never invent facts / use the block title,
// not the raw video title / avoid spoilers / vary openings" guardrails
// (spec section 3) are spelled out for the AI writer.

final class WriterPromptBuilder
{
    private const MIN_WORD_BUDGET = 6;
    private const MAX_WORD_BUDGET = 80;

    /** @return array{prompt:string, schema:array<string,mixed>, wordBudget:int} */
    public static function build(array $context, array $styleConfig): array
    {
        $wordBudget = self::wordBudget($styleConfig);
        $schema = [
            'type' => 'object',
            'properties' => [
                'announcement' => ['type' => 'string'],
            ],
            'required' => ['announcement'],
            'additionalProperties' => false,
        ];

        return [
            'prompt' => self::buildPrompt($context, $styleConfig, $wordBudget),
            'schema' => $schema,
            'wordBudget' => $wordBudget,
        ];
    }

    public static function wordBudget(array $styleConfig): int
    {
        $targetDuration = is_numeric($styleConfig['targetDuration'] ?? null) ? (float) $styleConfig['targetDuration'] : 12.0;
        $wordsPerSecond = is_numeric($styleConfig['wordsPerSecond'] ?? null) ? (float) $styleConfig['wordsPerSecond'] : 2.5;
        $budget = (int) round($targetDuration * $wordsPerSecond);
        return max(self::MIN_WORD_BUDGET, min(self::MAX_WORD_BUDGET, $budget));
    }

    private static function buildPrompt(array $context, array $styleConfig, int $wordBudget): string
    {
        $style = is_string($styleConfig['style'] ?? null) ? $styleConfig['style'] : 'Clear, friendly broadcast announcer';
        $tone = is_string($styleConfig['tone'] ?? null) ? $styleConfig['tone'] : 'Neutral, warm';

        $lines = [];
        $lines[] = 'You are a professional television continuity announcer writing a SHORT spoken-word script '
            . 'for text-to-speech narration. Write ONLY the words to be spoken -- no stage directions, no '
            . 'quotation marks, no markdown, no sound-effect notes.';
        $lines[] = '';
        $lines[] = "Channel: {$context['channelName']}" . (($context['channelDescription'] ?? null) ? " -- {$context['channelDescription']}" : '');
        $lines[] = "House style: $style";
        $lines[] = "Tone: $tone";
        $lines[] = "Target word count: approximately $wordBudget words (hard ceiling: " . ($wordBudget + 10) . ' words). Shorter and natural beats padded to hit the count exactly.';
        $lines[] = '';

        $lines[] = match ($context['type']) {
            'coming_up_next' => self::comingUpNextBrief($context),
            'channel_id' => self::channelIdBrief($context),
            default => self::genericBrief($context),
        };

        $lines[] = '';
        $lines[] = 'Rules (must follow all of them):';
        $lines[] = '- Use ONLY the information given above. Never invent episode titles, guests, people, '
            . 'historical facts, or program content that was not explicitly supplied.';
        $lines[] = '- When announcing the upcoming show, use its BLOCK/SERIES name exactly as given -- never '
            . 'substitute a more specific episode title as if it were the show\'s name.';
        $lines[] = '- Do not reveal plot specifics or spoil what happens in the upcoming program.';
        $lines[] = '- Avoid generic promotional hyperbole ("you won\'t believe", "amazing", "epic").';
        $lines[] = '- Vary your sentence opening -- do not always start with "Coming up next" or "Up next" '
            . 'if other natural phrasings fit the tone.';
        $lines[] = '- If information (e.g. a description) is missing or null, do not invent a substitute --'
            . ' simply write around it.';
        $lines[] = '- Return ONLY the JSON object described by the schema -- a single field "announcement" '
            . 'containing the spoken script as plain text.';

        return implode("\n", $lines);
    }

    private static function comingUpNextBrief(array $context): string
    {
        $next = $context['nextBlock'] ?? null;
        if ($next === null) {
            return 'There is no confirmed upcoming program. Write a brief, generic "stay tuned" continuity line '
                . 'that names the channel but promises nothing specific.';
        }
        $lines = [];
        $lines[] = 'Write a "coming up next" announcement introducing the next program.';
        $lines[] = "Upcoming show (announce it by this name): {$next['title']}";
        if (!empty($next['description'])) {
            $lines[] = "Upcoming show description: {$next['description']}";
        }
        if (!empty($context['episodeInfo']['description'] ?? null)) {
            $lines[] = 'Optional episode flavor (do not read this out as the show\'s name): ' . $context['episodeInfo']['description'];
        }
        if (!empty($context['currentBlock']['title'] ?? null)) {
            $lines[] = "Currently airing (the show ending now): {$context['currentBlock']['title']}";
        }
        if (!empty($context['timeOfDay'] ?? null)) {
            $lines[] = "Scheduled local start time: {$context['timeOfDay']}";
        }
        if (!empty($context['isConsecutiveSameSeries'])) {
            $lines[] = 'IMPORTANT: this is another episode of the SAME series that is already airing. Keep this '
                . 'especially brief -- something like "another episode of ' . $next['title'] . ' is coming up" -- '
                . 'do not treat it as a brand new show.';
        }
        return implode("\n", $lines);
    }

    private static function channelIdBrief(array $context): string
    {
        return 'Write a short general station-identification announcement for this channel -- the kind of line '
            . 'that simply reminds the viewer what channel they are watching, with no specific program mentioned.';
    }

    private static function genericBrief(array $context): string
    {
        $type = (string) ($context['type'] ?? 'announcement');
        return "Write a short broadcast continuity announcement of type \"$type\" using only the context given.";
    }
}
