<?php
declare(strict_types=1);

// channels/announcer/src/ScriptCache.php
//
// Script-level cache (spec section 6: "Separate script caching from
// audio caching... a change to the announcer voice should require new
// audio but not necessarily new writing"). Stored at
// channels/<id>/.announcer/scripts/<hash>.json -- gitignored build
// state, same posture as channels/<id>/.publish/.
//
// "approved" (set once a human edits/approves a script via the Pass 2
// admin UI) is the one flag routine regeneration must never clear or
// overwrite -- AnnouncerPipeline only ever calls put() for a NEW hash
// (the hash already encodes every input that should trigger a rewrite;
// an approved entry simply never gets looked up again once its inputs
// change, since its hash no longer matches anything the pipeline computes).

final class ScriptCache
{
    public static function dirFor(string $channelDir): string
    {
        return "$channelDir/.announcer/scripts";
    }

    /** @return array<string,mixed>|null */
    public static function get(string $channelDir, string $hash): ?array
    {
        $path = self::pathFor($channelDir, $hash);
        if (!is_file($path)) {
            return null;
        }
        $data = json_decode((string) file_get_contents($path), true);
        return is_array($data) ? $data : null;
    }

    /** @param array<string,mixed> $entry */
    public static function put(string $channelDir, string $hash, array $entry): void
    {
        $dir = self::dirFor($channelDir);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException("Failed to create directory: $dir");
        }
        $entry['hash'] = $hash;
        self::atomicWriteJson(self::pathFor($channelDir, $hash), $entry);
    }

    /** Marks an existing cached script as manually approved/edited -- never
     *  called by routine (re)generation, only by the Pass 2 admin editor.
     *  Works whether or not a script already exists for $hash (an editor
     *  can write a brand-new approved line for a transition that hasn't
     *  been generated yet), so this creates the scripts/ directory itself
     *  rather than relying on a prior put() having already done so. */
    public static function approve(string $channelDir, string $hash, string $text): void
    {
        $dir = self::dirFor($channelDir);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException("Failed to create directory: $dir");
        }
        $entry = self::get($channelDir, $hash) ?? ['hash' => $hash];
        $entry['text'] = $text;
        $entry['approved'] = true;
        $entry['approvedAt'] = gmdate('c');
        self::atomicWriteJson(self::pathFor($channelDir, $hash), $entry);
    }

    /** @return list<string> every cached hash present for this channel */
    public static function listHashes(string $channelDir): array
    {
        $dir = self::dirFor($channelDir);
        if (!is_dir($dir)) {
            return [];
        }
        $hashes = [];
        foreach (glob("$dir/*.json") ?: [] as $file) {
            $hashes[] = basename($file, '.json');
        }
        return $hashes;
    }

    private static function pathFor(string $channelDir, string $hash): string
    {
        return self::dirFor($channelDir) . "/$hash.json";
    }

    private static function atomicWriteJson(string $path, array $data): void
    {
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json === false) {
            throw new RuntimeException("Failed to encode JSON for: $path");
        }
        $tmp = $path . '.' . getmypid() . '.' . mt_rand(1000, 9999) . '.tmp';
        if (file_put_contents($tmp, $json . "\n") === false) {
            throw new RuntimeException("Failed to write temp file: $tmp");
        }
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException("Failed to finalize write for: $path");
        }
    }
}
