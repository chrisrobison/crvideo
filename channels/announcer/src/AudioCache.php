<?php
declare(strict_types=1);

// channels/announcer/src/AudioCache.php
//
// Audio-level cache (spec sections 6/7): resolves the deterministic,
// CDN-cacheable path/URL for a given audio hash under the configured
// media root (default media/announcements/<channelId>/<hash>.mp3), and
// reports whether a valid file already exists there -- AudioProcessor is
// what actually writes it (atomically); this class never writes audio
// itself, only paths/existence checks, so it stays a tiny, dependency-free
// piece both AnnouncerPipeline and the CLI can share.

final class AudioCache
{
    public function __construct(private string $repoRoot, private string $mediaRoot = 'media/announcements')
    {
    }

    public function absoluteDir(string $channelId): string
    {
        return rtrim($this->repoRoot, '/') . '/' . trim($this->mediaRoot, '/') . "/$channelId";
    }

    public function absolutePathFor(string $channelId, string $hash): string
    {
        return $this->absoluteDir($channelId) . "/$hash.mp3";
    }

    /** Public, CDN-cacheable URL path (spec section 7's illustrative example:
     *  "/media/announcements/science/abc123.mp3"). */
    public function publicUrlFor(string $channelId, string $hash): string
    {
        return '/' . trim($this->mediaRoot, '/') . "/$channelId/$hash.mp3";
    }

    public function exists(string $channelId, string $hash): bool
    {
        $path = $this->absolutePathFor($channelId, $hash);
        return is_file($path) && filesize($path) > 0;
    }
}
