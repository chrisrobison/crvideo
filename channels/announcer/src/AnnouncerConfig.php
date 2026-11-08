<?php
declare(strict_types=1);

// channels/announcer/src/AnnouncerConfig.php
//
// Resolves the effective announcer configuration for one channel: global
// defaults (config.php) -> optional local overrides (config.local.php,
// gitignored) -> environment variables (secrets/endpoints always win) ->
// the channel's own channels/<id>/announcer.json. A channel with no
// announcer.json at all resolves to "enabled": false and nothing else
// about it is ever consulted -- the single opt-in gate the whole feature
// is built around.

final class AnnouncerConfig
{
    /** @return array<string,mixed> */
    public static function resolve(string $channelId, string $channelsRoot, string $announcerRoot): array
    {
        $config = require $announcerRoot . '/config.php';

        $localPath = $announcerRoot . '/config.local.php';
        if (is_file($localPath)) {
            $local = require $localPath;
            if (is_array($local)) {
                $config = self::mergeDeep($config, $local);
            }
        }

        $config = self::applyEnvOverrides($config);

        $channelPath = "$channelsRoot/$channelId/announcer.json";
        if (is_file($channelPath)) {
            $channelConfig = json_decode((string) file_get_contents($channelPath), true);
            if (is_array($channelConfig)) {
                $config = self::mergeDeep($config, $channelConfig);
            }
        } else {
            // No per-channel opt-in file: force disabled regardless of the
            // global default, so a future change to config.php's own
            // "enabled" default can never silently turn this on for every
            // channel that has never configured it.
            $config['enabled'] = false;
        }

        return $config;
    }

    /** @return array<string,mixed> */
    private static function applyEnvOverrides(array $config): array
    {
        $endpoint = (string) (getenv('KOKORO_ENDPOINT') ?: '');
        if ($endpoint !== '') {
            $config['tts']['endpoint'] = $endpoint;
        }
        $authToken = (string) (getenv('KOKORO_AUTH_TOKEN') ?: '');
        if ($authToken !== '') {
            $config['tts']['authToken'] = $authToken;
        }
        $timeout = (string) (getenv('KOKORO_TIMEOUT_SECONDS') ?: '');
        if ($timeout !== '' && is_numeric($timeout)) {
            $config['tts']['timeoutSeconds'] = (int) $timeout;
        }
        $claudeBin = (string) (getenv('CLAUDE_CLI_BIN') ?: '');
        if ($claudeBin !== '') {
            $config['writer']['bin'] = $claudeBin;
        }
        $claudeModel = (string) (getenv('CLAUDE_CLI_MODEL') ?: '');
        if ($claudeModel !== '') {
            $config['writer']['model'] = $claudeModel;
        }
        return $config;
    }

    /**
     * Recursive associative-array merge: $override's scalar/list values
     * replace $base's; nested associative arrays merge key-by-key. A
     * channel's announcer.json therefore only needs to mention the keys
     * it actually wants to change (e.g. just "voice"), not repeat every
     * default -- same "override only what you care about" posture as
     * continuity.json's "defaults" merging (ContinuityResolver.php).
     *
     * @param array<string,mixed> $base
     * @param array<string,mixed> $override
     * @return array<string,mixed>
     */
    public static function mergeDeep(array $base, array $override): array
    {
        foreach ($override as $key => $value) {
            if (is_array($value) && isset($base[$key]) && is_array($base[$key]) && !array_is_list($value)) {
                $base[$key] = self::mergeDeep($base[$key], $value);
            } else {
                $base[$key] = $value;
            }
        }
        return $base;
    }
}
