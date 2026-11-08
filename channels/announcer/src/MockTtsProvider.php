<?php
declare(strict_types=1);

// channels/announcer/src/MockTtsProvider.php
//
// Test/offline double for TtsProviderInterface: writes a real, valid,
// correctly-sized PCM16 mono WAV file (silence) with NO network
// dependency and no Kokoro installation required, so unit tests and
// `--dry-run`-adjacent code paths can exercise the full
// synthesize -> AudioProcessor (ffmpeg/ffprobe) -> cache pipeline for
// real, with a plausible, text-length-derived duration.

final class MockTtsProvider implements TtsProviderInterface
{
    private const SAMPLE_RATE = 22050;

    public function __construct(private bool $shouldFail = false)
    {
    }

    public function synthesize(string $text, string $voice, float $speed, string $language, string $destWavPath): array
    {
        if ($this->shouldFail) {
            return ['wavPath' => null, 'sampleRate' => null, 'durationSeconds' => null, 'error' => 'simulated TTS failure'];
        }

        $wordCount = max(1, count(array_filter(preg_split('/\s+/', trim($text)) ?: [])));
        $wordsPerSecond = 2.5 * max(0.1, $speed);
        $duration = max(0.5, $wordCount / $wordsPerSecond);

        $tmpPath = $destWavPath . '.part';
        self::writeSilentWav($tmpPath, $duration, self::SAMPLE_RATE);
        if (!rename($tmpPath, $destWavPath)) {
            @unlink($tmpPath);
            return ['wavPath' => null, 'sampleRate' => null, 'durationSeconds' => null, 'error' => "Failed to finalize $destWavPath."];
        }

        return ['wavPath' => $destWavPath, 'sampleRate' => self::SAMPLE_RATE, 'durationSeconds' => $duration, 'error' => null];
    }

    private static function writeSilentWav(string $path, float $durationSeconds, int $sampleRate): void
    {
        $numSamples = (int) round($durationSeconds * $sampleRate);
        $bitsPerSample = 16;
        $numChannels = 1;
        $byteRate = $sampleRate * $numChannels * ($bitsPerSample / 8);
        $blockAlign = $numChannels * ($bitsPerSample / 8);
        $dataSize = $numSamples * $blockAlign;

        $fh = fopen($path, 'wb');
        if ($fh === false) {
            throw new RuntimeException("MockTtsProvider: could not open $path for writing.");
        }
        fwrite($fh, 'RIFF');
        fwrite($fh, pack('V', 36 + $dataSize));
        fwrite($fh, 'WAVEfmt ');
        fwrite($fh, pack('V', 16));          // fmt chunk size
        fwrite($fh, pack('v', 1));           // PCM
        fwrite($fh, pack('v', $numChannels));
        fwrite($fh, pack('V', $sampleRate));
        fwrite($fh, pack('V', (int) $byteRate));
        fwrite($fh, pack('v', (int) $blockAlign));
        fwrite($fh, pack('v', $bitsPerSample));
        fwrite($fh, 'data');
        fwrite($fh, pack('V', $dataSize));
        // Silence: a tiny low-amplitude sine (not pure zero) so ffprobe/any
        // waveform sanity check sees genuine audio-rate data, not an
        // all-zero file some tools flag as suspicious.
        $chunk = 4096;
        $written = 0;
        $amplitude = 50; // very quiet, well within int16 range
        while ($written < $numSamples) {
            $n = min($chunk, $numSamples - $written);
            $buf = '';
            for ($i = 0; $i < $n; $i++) {
                $t = ($written + $i) / $sampleRate;
                $sample = (int) round($amplitude * sin(2 * M_PI * 220 * $t));
                $buf .= pack('v', $sample & 0xFFFF);
            }
            fwrite($fh, $buf);
            $written += $n;
        }
        fclose($fh);
    }
}
