<?php
declare(strict_types=1);

// channels/announcer/src/TemplateAiWriter.php
//
// Deterministic, dependency-free fallback writer (spec section 3: "Support
// a deterministic template-based fallback when the AI provider is
// unavailable."). Always succeeds, uses only fields present on the
// context, and never calls out to anything external -- this is what
// ClaudeCliAiWriter falls through to on any failure, and what every test
// that doesn't specifically exercise the AI path should use.
//
// Variant selection is a stable hash of the transition id, never
// Math.random()-equivalent -- the same transition picks the same
// opening every time it's (re)generated, matching this codebase's
// existing determinism convention (channels/continuity-card.js's
// hashSeed()/pickWeightedIndex()).

final class TemplateAiWriter implements AiWriterInterface
{
    /** @var list<string> %s = upcoming show title */
    private const COMING_UP_OPENINGS = [
        'Coming up next, %s.',
        "Up next on the schedule, it's %s.",
        'Stay with us -- %s is next.',
        "In just a moment, we'll have %s.",
        'Next on the lineup: %s.',
    ];

    /** @var list<string> %s = channel name */
    private const CHANNEL_ID_LINES = [
        "You're watching %s.",
        "This is %s.",
        "You're tuned to %s.",
    ];

    public function write(array $context, array $styleConfig): array
    {
        $wordBudget = WriterPromptBuilder::wordBudget($styleConfig);
        $seed = (string) ($context['transitionId'] ?? $context['type'] ?? 'announcement');

        $text = match ($context['type'] ?? null) {
            'coming_up_next' => $this->comingUpNext($context, $seed, $wordBudget),
            'channel_id' => $this->channelId($context, $seed),
            default => $this->generic($context),
        };

        return [
            'text' => self::capWords($text, $wordBudget + 10),
            'provider' => 'template',
            'model' => null,
            'usedFallback' => false, // the template IS the primary writer when selected, not a fallback of itself
            'error' => null,
        ];
    }

    private function comingUpNext(array $context, string $seed, int $wordBudget): string
    {
        $next = $context['nextBlock'] ?? null;
        $channelName = (string) ($context['channelName'] ?? 'this channel');

        if ($next === null || empty($next['title'])) {
            return "Stay with us on $channelName -- more is on the way.";
        }

        $title = (string) $next['title'];

        if (!empty($context['isConsecutiveSameSeries'])) {
            return "Stay tuned -- another episode of $title is coming up next.";
        }

        $opening = self::pick(self::COMING_UP_OPENINGS, $seed);
        $line = sprintf($opening, $title);

        // Add a short descriptive clause if the word budget has room and a
        // description was actually supplied -- never invented.
        $description = trim((string) ($next['description'] ?? ''));
        if ($description !== '') {
            $clause = ' ' . self::firstSentence($description);
            if (self::wordCount($line . $clause) <= $wordBudget + 6) {
                $line .= $clause;
            }
        }

        return $line;
    }

    private function channelId(array $context, string $seed): string
    {
        $channelName = (string) ($context['channelName'] ?? 'this channel');
        return sprintf(self::pick(self::CHANNEL_ID_LINES, $seed), $channelName);
    }

    private function generic(array $context): string
    {
        $channelName = (string) ($context['channelName'] ?? 'this channel');
        return "You're watching $channelName.";
    }

    private static function pick(array $options, string $seed): string
    {
        $index = self::hashSeed($seed) % count($options);
        return $options[$index];
    }

    /** 32-bit FNV-1a -- same algorithm as continuity-card.js's hashSeed(), kept
     *  in lockstep deliberately so a future shared "deterministic pick" helper
     *  could move between PHP and JS without changing any existing selection. */
    private static function hashSeed(string $seed): int
    {
        $h = 0x811c9dc5;
        for ($i = 0, $len = strlen($seed); $i < $len; $i++) {
            $h ^= ord($seed[$i]);
            $h = (int) (($h * 0x01000193) & 0xFFFFFFFF);
        }
        return $h & 0x7FFFFFFF; // keep it a non-negative PHP int on 64-bit
    }

    private static function firstSentence(string $text): string
    {
        $parts = preg_split('/(?<=[.!?])\s+/', $text, 2);
        return rtrim($parts[0] ?? $text, " \t\n");
    }

    private static function wordCount(string $text): int
    {
        return count(array_filter(preg_split('/\s+/', trim($text)) ?: []));
    }

    private static function capWords(string $text, int $maxWords): string
    {
        $words = preg_split('/\s+/', trim($text)) ?: [];
        if (count($words) <= $maxWords) {
            return trim($text);
        }
        return implode(' ', array_slice($words, 0, $maxWords)) . '.';
    }
}
