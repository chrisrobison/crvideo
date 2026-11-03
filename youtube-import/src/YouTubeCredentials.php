<?php
declare(strict_types=1);

// youtube-import/src/YouTubeCredentials.php
//
// Resolves a YouTube Data API v3 key from, in order:
//   1. the YOUTUBE_API_KEY environment variable
//   2. an untracked local PHP config file (default:
//      youtube-import/config.local.php, override with --config=PATH)
//      returning an array with an "api_key" string, e.g.:
//        <?php
//        return ['api_key' => 'AIza...'];
//      (same "untracked PHP file returned via require" shape this repo
//      already uses for server/publish-secret.php.)
//
// Never reads a key from a CLI argument -- CLI args are visible to any
// other process on the machine via `ps`, which this repo's existing
// secret-handling (service-account.json, publish-secret.php) also avoids.
// The key is never logged, printed, or embedded in any output file.

final class YouTubeCredentials
{
    /**
     * @return array{apiKey: ?string, source: ?string, error: ?string}
     */
    public static function resolve(?string $configPath = null): array
    {
        $envKey = (string) (getenv('YOUTUBE_API_KEY') ?: '');
        if ($envKey !== '') {
            return ['apiKey' => $envKey, 'source' => 'YOUTUBE_API_KEY environment variable', 'error' => null];
        }

        $path = $configPath ?? (dirname(__DIR__) . '/config.local.php');
        if (!is_file($path)) {
            return [
                'apiKey' => null,
                'source' => null,
                'error' => 'No YouTube API key found. Set the YOUTUBE_API_KEY environment variable, or '
                    . "create $path returning ['api_key' => '...'] (see youtube-import.php --help).",
            ];
        }

        $config = require $path;
        if (!is_array($config) || !isset($config['api_key']) || !is_string($config['api_key']) || $config['api_key'] === '') {
            return [
                'apiKey' => null,
                'source' => null,
                'error' => "$path does not return a valid ['api_key' => '...'] array.",
            ];
        }

        return ['apiKey' => $config['api_key'], 'source' => $path, 'error' => null];
    }
}
