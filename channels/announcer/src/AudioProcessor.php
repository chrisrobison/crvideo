<?php
declare(strict_types=1);

// channels/announcer/src/AudioProcessor.php
//
// WAV -> MP3 conversion + loudness normalization (ffmpeg) and duration
// measurement/validation (ffprobe) -- mirrors server/download-cache.php's
// remux()'s exact shape (escapeshellarg/escapeshellcmd + exec() + exit-code
// check, `.part` temp file + rename()). An MP3 is never handed back as
// usable until ffprobe has independently confirmed it has a real,
// positive duration -- spec section 4/11: "Do not publish an audio asset
// as ready until it has been successfully written and validated."

final class AudioProcessor
{
    public function __construct(
        private string $ffmpegBin = '/usr/bin/ffmpeg',
        private string $ffprobeBin = '/usr/bin/ffprobe',
    ) {
    }

    /**
     * @param array{bitrateKbps?:int, loudnorm?:bool} $audioConfig
     * @return array{mp3Path:?string, durationSeconds:?float, error:?string}
     */
    public function convertToMp3(string $wavPath, string $destMp3Path, array $audioConfig = []): array
    {
        if (!is_file($wavPath) || filesize($wavPath) === 0) {
            return ['mp3Path' => null, 'durationSeconds' => null, 'error' => "Source WAV missing or empty: $wavPath"];
        }

        $bitrate = is_numeric($audioConfig['bitrateKbps'] ?? null) ? (int) $audioConfig['bitrateKbps'] : 128;
        $loudnorm = $audioConfig['loudnorm'] ?? true;

        $dir = dirname($destMp3Path);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            return ['mp3Path' => null, 'durationSeconds' => null, 'error' => "Failed to create directory: $dir"];
        }

        $tmpPath = $destMp3Path . '.part';
        $filterArgs = $loudnorm ? sprintf('-af %s', escapeshellarg('loudnorm')) : '';
        $cmd = sprintf(
            '%s -v error -i %s %s -codec:a libmp3lame -b:a %dk -f mp3 -y %s 2>&1',
            escapeshellcmd($this->ffmpegBin),
            escapeshellarg($wavPath),
            $filterArgs,
            $bitrate,
            escapeshellarg($tmpPath),
        );
        exec($cmd, $output, $exitCode);
        if ($exitCode !== 0 || !is_file($tmpPath) || filesize($tmpPath) === 0) {
            @unlink($tmpPath);
            return ['mp3Path' => null, 'durationSeconds' => null, 'error' => 'ffmpeg mp3 encode failed (exit ' . $exitCode . '): ' . implode(' | ', $output)];
        }

        $duration = $this->probeDuration($tmpPath);
        if ($duration === null || $duration <= 0) {
            @unlink($tmpPath);
            return ['mp3Path' => null, 'durationSeconds' => null, 'error' => 'ffprobe could not confirm a valid positive duration for the encoded MP3 -- discarding.'];
        }

        if (!rename($tmpPath, $destMp3Path)) {
            @unlink($tmpPath);
            return ['mp3Path' => null, 'durationSeconds' => null, 'error' => "Failed to finalize $destMp3Path."];
        }

        return ['mp3Path' => $destMp3Path, 'durationSeconds' => $duration, 'error' => null];
    }

    public function probeDuration(string $path): ?float
    {
        $cmd = sprintf(
            '%s -v error -show_entries format=duration -of json %s 2>&1',
            escapeshellcmd($this->ffprobeBin),
            escapeshellarg($path),
        );
        exec($cmd, $output, $exitCode);
        if ($exitCode !== 0) {
            return null;
        }
        $json = json_decode(implode("\n", $output), true);
        $d = $json['format']['duration'] ?? null;
        return is_numeric($d) ? (float) $d : null;
    }
}
