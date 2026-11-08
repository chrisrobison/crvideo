<?php
declare(strict_types=1);

// channels/announcer/config.php
//
// Global defaults for the AI continuity announcer feature (see
// channels/announcer/README.md). Safe to commit: no secrets live here.
//
// Resolution order (AnnouncerConfig::resolve()):
//   1. this file (global defaults)
//   2. channels/announcer/config.local.php, if present (gitignored --
//      same "untracked PHP file returned via require" shape this repo
//      already uses for server/publish-secret.php /
//      youtube-import/config.local.php) -- local overrides for things
//      like a non-default Kokoro endpoint or shared-secret token.
//   3. environment variables (KOKORO_ENDPOINT, KOKORO_AUTH_TOKEN,
//      KOKORO_TIMEOUT_SECONDS, CLAUDE_CLI_BIN, CLAUDE_CLI_MODEL) -- always
//      win over both files, same precedence YouTubeCredentials::resolve()
//      already uses.
//   4. channels/<id>/announcer.json -- per-channel overrides, merged last.
//      Absent entirely: that channel's announcer stays disabled regardless
//      of what this file says, matching every other opt-in feature's
//      "absent = zero behavior change" posture.

return [
    // Nothing is generated for a channel unless ITS OWN announcer.json
    // explicitly sets "enabled": true -- this global default only matters
    // for keys a channel's announcer.json doesn't mention at all.
    'enabled' => false,

    // Voice/speech defaults -- identifiers are examples only; CRVideo does
    // not assume every Kokoro backend supports the same voice set. See
    // GET /voices on the Kokoro server for what is actually available.
    'voice' => 'af_heart',
    'speed' => 1.0,
    'language' => 'en-us',

    // Writing style defaults.
    'style' => 'Clear, friendly broadcast announcer',
    'tone' => 'Neutral, warm, professional',
    'targetDuration' => 12, // seconds; spec default band is 10-15s
    'wordsPerSecond' => 2.5, // natural speaking rate used to derive a word budget
    'types' => ['coming_up_next'],

    // How to handle back-to-back episodes of the same series: "short"
    // (a brief "another episode of X" announcement), "suppress" (skip
    // entirely), or "normal" (treat like any other transition).
    'consecutiveSameSeries' => 'short',

    // AI writer.
    'writer' => [
        'provider' => 'claude-cli', // 'claude-cli' | 'template' | 'mock'
        'model' => 'sonnet',        // passed to `claude --model`
        'timeoutSeconds' => 25,
        'bin' => 'claude',          // resolved against PATH; override via CLAUDE_CLI_BIN
    ],

    // TTS (Kokoro HTTP service -- local or remote, just a URL either way).
    'tts' => [
        'provider' => 'kokoro-http', // 'kokoro-http' | 'mock'
        'endpoint' => 'http://127.0.0.1:8178',
        // Measured on this project's reference CPU (an older Xeon with no
        // AVX2/VNNI): real-time factor ~1.5, i.e. a 15s announcement can take
        // ~22s to synthesize -- see tools/kokoro-server/README.md's benchmark.
        // 45s leaves real headroom above that without masking a genuinely
        // stuck request forever.
        'timeoutSeconds' => 45,
        'modelVersion' => 'kokoro-v1.0',
    ],

    // Audio post-processing.
    'audio' => [
        'bitrateKbps' => 128,
        'loudnorm' => true,
    ],

    // Background job queue.
    'maxConcurrentJobs' => 1,
    'lookaheadHours' => 36,
    'retry' => [
        'maxAttempts' => 5,
        'baseDelaySeconds' => 30,
    ],
    'staleJobSeconds' => 900, // a "running" job older than this is presumed crashed

    // Storage.
    'mediaRoot' => 'media/announcements', // relative to the repo root
];
