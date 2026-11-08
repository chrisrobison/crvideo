<?php
declare(strict_types=1);

// channels/announcer/src/TtsProviderInterface.php
//
// Provider-independent TTS interface (spec section 4). Kokoro is the
// initial (and currently only real) implementation, reached purely over
// HTTP -- so "local" vs "remote" deployment is nothing more than which
// URL is configured, and a future alternative engine only needs to
// implement this same interface, never touching AnnouncerPipeline.

interface TtsProviderInterface
{
    /**
     * Synthesizes $text and writes a WAV (or equivalent PCM container) file
     * to $destWavPath. Implementations must write atomically (temp file +
     * rename) so a caller never observes a partially-written file.
     *
     * @return array{wavPath:?string, sampleRate:?int, durationSeconds:?float, error:?string}
     */
    public function synthesize(string $text, string $voice, float $speed, string $language, string $destWavPath): array;
}
