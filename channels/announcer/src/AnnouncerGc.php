<?php
declare(strict_types=1);

// channels/announcer/src/AnnouncerGc.php
//
// Garbage collector for the announcer's two content-addressed caches
// (media/announcements/<channelId>/<audioHash>.mp3 and
// channels/<id>/.announcer/scripts/<scriptHash>.json) plus its job-queue
// history (channels/<id>/.announcer/jobs/{done,error}/<scriptHash>.json).
//
// Why this exists: AnnouncementManifestWriter::pruneExcept() already
// removes STALE ENTRIES from announcements.json whenever a transition
// rolls out of the schedule (e.g. publish.php's nightly rolling window
// moving forward) or a config change (e.g. switching voice) produces a
// new audio/script hash for a still-live transition. It has never
// deleted the underlying files those old entries pointed to -- so
// without this, media/announcements/** grows forever.
//
// Why this is NOT "delete anything older than N days": both caches are
// CONTENT-addressed, not date-addressed. The same audio file (e.g. a
// generic "another episode of X is coming up" line) is very often
// reused across many different days' transitions, so a file's age has
// no relationship to whether it is still needed -- a file created
// yesterday can be referenced by something airing in three weeks, and a
// file nobody has written in weeks can still be exactly what today's
// schedule needs. The only correct test is "does the CURRENT manifest
// reference this hash", i.e. a plain mark-and-sweep GC: the live set is
// read directly out of announcements.json (the "mark"), and anything on
// disk not in that set is swept, after a small grace window so an
// in-flight write from a worker that hasn't upserted the manifest yet is
// never mistaken for garbage.
//
// Job history (.announcer/jobs/{done,error}/<scriptHash>.json) is swept
// separately and purely by AGE, independent of the live set: these are
// not a cache that produces output, they are JobQueue's own dedup
// records ("has this exact script already been generated once?"), and
// unlike the audio/script caches, keeping a stale one around is not
// risk-free in return for allowing a script/audio to be reused -- see
// JobQueue::enqueue(), which treats ANY existing job file for an id
// (including a long-done one) as "already handled" and skips
// re-enqueueing, even if the pipeline's own audio-exists check just
// determined regeneration IS needed (e.g. after a voice change touches
// the audio hash but not the script hash). Expiring old done/error
// records after a retention window lets a future run reconsider a
// scriptHash instead of being permanently blocked by ancient history.

final class AnnouncerGc
{
    /**
     * @return array{
     *   channelId: string,
     *   audioRemoved: list<string>, audioBytes: int,
     *   scriptsRemoved: list<string>,
     *   jobsRemoved: list<string>,
     *   errors: list<string>,
     * }
     */
    public static function sweepChannel(
        string $channelId,
        string $channelDir,
        string $mediaDir,
        int $graceSeconds,
        int $jobRetentionSeconds,
        bool $dryRun,
    ): array {
        $result = [
            'channelId' => $channelId,
            'audioRemoved' => [],
            'audioBytes' => 0,
            'scriptsRemoved' => [],
            'jobsRemoved' => [],
            'errors' => [],
        ];

        $manifest = AnnouncementManifestWriter::read("$channelDir/announcements.json");
        $liveAudio = [];
        $liveScripts = [];
        foreach ($manifest['announcements'] as $record) {
            if (is_array($record)) {
                if (is_string($record['audioHash'] ?? null)) {
                    $liveAudio[$record['audioHash']] = true;
                }
                if (is_string($record['scriptHash'] ?? null)) {
                    $liveScripts[$record['scriptHash']] = true;
                }
            }
        }

        $now = time();

        // Audio cache: media/announcements/<channelId>/<audioHash>.mp3
        foreach (self::listHashFiles($mediaDir, 'mp3') as $hash => $path) {
            if (isset($liveAudio[$hash])) {
                continue;
            }
            if ($now - self::safeMtime($path) < $graceSeconds) {
                continue; // too recent to be sure it isn't an in-flight write
            }
            $size = @filesize($path) ?: 0;
            if ($dryRun || self::remove($path)) {
                $result['audioRemoved'][] = $path;
                $result['audioBytes'] += $size;
            } else {
                $result['errors'][] = "failed to remove $path";
            }
        }

        // Script cache: channels/<id>/.announcer/scripts/<scriptHash>.json
        $scriptsDir = ScriptCache::dirFor($channelDir);
        foreach (self::listHashFiles($scriptsDir, 'json') as $hash => $path) {
            if (isset($liveScripts[$hash])) {
                continue;
            }
            if ($now - self::safeMtime($path) < $graceSeconds) {
                continue;
            }
            if ($dryRun || self::remove($path)) {
                $result['scriptsRemoved'][] = $path;
            } else {
                $result['errors'][] = "failed to remove $path";
            }
        }

        // Job-queue history: channels/<id>/.announcer/jobs/{done,error}/<hash>.json
        // -- age-based only, not keyed off the live set (see class docblock).
        foreach (['done', 'error'] as $state) {
            $dir = "$channelDir/.announcer/jobs/$state";
            foreach (self::listHashFiles($dir, 'json') as $hash => $path) {
                if ($now - self::safeMtime($path) < $jobRetentionSeconds) {
                    continue;
                }
                if ($dryRun || self::remove($path)) {
                    $result['jobsRemoved'][] = $path;
                } else {
                    $result['errors'][] = "failed to remove $path";
                }
            }
        }

        return $result;
    }

    /** @return array<string,string> hash (lowercase hex, no extension) => absolute path.
     *  Only matches bare-hex-named files with the given extension -- never touches
     *  .lock/.bak files, the manifest itself, or anything hand-placed in these dirs. */
    private static function listHashFiles(string $dir, string $ext): array
    {
        if (!is_dir($dir)) {
            return [];
        }
        $out = [];
        foreach (glob("$dir/*.$ext") ?: [] as $path) {
            $base = basename($path, ".$ext");
            if (preg_match('/^[0-9a-f]{16,64}$/', $base) === 1) {
                $out[$base] = $path;
            }
        }
        return $out;
    }

    private static function safeMtime(string $path): int
    {
        $mtime = @filemtime($path);
        return $mtime !== false ? $mtime : 0;
    }

    private static function remove(string $path): bool
    {
        return @unlink($path);
    }
}
