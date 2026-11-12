<?php
declare(strict_types=1);

// channels/announcer/src/KokoroHttpTtsProvider.php
//
// Real TTS adapter: POSTs to a persistent Kokoro HTTP service (see
// tools/kokoro-server/ -- runs locally for CPU-only inference, or on a
// remote machine such as an Apple Silicon Mac mini; either way this
// class only ever knows a URL, a timeout, and an optional bearer token,
// matching spec section 4's "local vs remote is just an endpoint"
// requirement). Writes the response body to a `.part` temp file and only
// `rename()`s it into place once curl reports full success -- the same
// atomic-write posture as server/download-cache.php's downloadToFile().

final class KokoroHttpTtsProvider implements TtsProviderInterface
{
    public function __construct(
        private string $endpoint,
        private int $timeoutSeconds = 20,
        private ?string $authToken = null,
    ) {
    }

    public function synthesize(string $text, string $voice, float $speed, string $language, string $destWavPath): array
    {
        $url = rtrim($this->endpoint, '/') . '/synthesize';
        $body = json_encode(['text' => $text, 'voice' => $voice, 'speed' => $speed, 'lang' => $language], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        $tmpPath = $destWavPath . '.part';
        $fh = @fopen($tmpPath, 'wb');
        if ($fh === false) {
            return ['wavPath' => null, 'sampleRate' => null, 'durationSeconds' => null, 'error' => "Could not open $tmpPath for writing."];
        }

        $responseHeaders = [];
        $headers = ['Content-Type: application/json'];
        if ($this->authToken !== null && $this->authToken !== '') {
            $headers[] = "Authorization: Bearer {$this->authToken}";
        }

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_FILE => $fh,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_CONNECTTIMEOUT => min(10, $this->timeoutSeconds),
            CURLOPT_HEADERFUNCTION => function ($curlHandle, string $line) use (&$responseHeaders): int {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        ]);
        $ok = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        fclose($fh);

        if (!$ok || $status !== 200) {
            $body = is_file($tmpPath) ? (string) @file_get_contents($tmpPath) : '';
            @unlink($tmpPath);
            $detail = $err !== '' ? $err : trim($body);
            return ['wavPath' => null, 'sampleRate' => null, 'durationSeconds' => null, 'error' => "Kokoro request failed (HTTP $status): $detail"];
        }
        if (!is_file($tmpPath) || filesize($tmpPath) === 0) {
            @unlink($tmpPath);
            return ['wavPath' => null, 'sampleRate' => null, 'durationSeconds' => null, 'error' => 'Kokoro returned an empty response body.'];
        }

        if (!rename($tmpPath, $destWavPath)) {
            @unlink($tmpPath);
            return ['wavPath' => null, 'sampleRate' => null, 'durationSeconds' => null, 'error' => "Failed to finalize $destWavPath."];
        }

        $sampleRate = isset($responseHeaders['x-sample-rate']) && is_numeric($responseHeaders['x-sample-rate'])
            ? (int) $responseHeaders['x-sample-rate'] : null;
        $duration = isset($responseHeaders['x-audio-duration-seconds']) && is_numeric($responseHeaders['x-audio-duration-seconds'])
            ? (float) $responseHeaders['x-audio-duration-seconds'] : null;

        return ['wavPath' => $destWavPath, 'sampleRate' => $sampleRate, 'durationSeconds' => $duration, 'error' => null];
    }

    public static function fromConfig(array $ttsConfig): self
    {
        $endpoint = is_string($ttsConfig['endpoint'] ?? null) ? $ttsConfig['endpoint'] : 'http://127.0.0.1:8178';
        $timeout = is_numeric($ttsConfig['timeoutSeconds'] ?? null) ? (int) $ttsConfig['timeoutSeconds'] : 20;
        $token = is_string($ttsConfig['authToken'] ?? null) ? $ttsConfig['authToken'] : null;
        return new self($endpoint, $timeout, $token);
    }

    /**
     * GET <endpoint>/voices (see tools/kokoro-server/server.py's do_GET) --
     * used only by the admin UI's voice picker (server/announcer-
     * admin.php), never by the generation pipeline itself. Never throws:
     * an unreachable/misconfigured server just means the admin UI falls
     * back to a plain text input instead of a populated dropdown.
     *
     * @param array<string,mixed> $ttsConfig
     * @return array{voices: list<string>, error: ?string}
     */
    public static function listVoices(array $ttsConfig, int $timeoutSeconds = 10): array
    {
        $endpoint = is_string($ttsConfig['endpoint'] ?? null) ? $ttsConfig['endpoint'] : 'http://127.0.0.1:8178';
        $token = is_string($ttsConfig['authToken'] ?? null) ? $ttsConfig['authToken'] : null;
        $url = rtrim($endpoint, '/') . '/voices';

        $headers = [];
        if ($token !== null && $token !== '') {
            $headers[] = "Authorization: Bearer $token";
        }

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => $timeoutSeconds,
            CURLOPT_CONNECTTIMEOUT => min(5, $timeoutSeconds),
        ]);
        $body = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);

        if ($body === false || $status !== 200) {
            return ['voices' => [], 'error' => $err !== '' ? $err : "Kokoro /voices request failed (HTTP $status)."];
        }
        $decoded = json_decode((string) $body, true);
        $list = is_array($decoded['voices'] ?? null) ? $decoded['voices'] : [];
        $voices = array_values(array_filter($list, 'is_string'));
        sort($voices);
        return ['voices' => $voices, 'error' => null];
    }
}
