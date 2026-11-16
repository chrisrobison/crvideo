<?php
declare(strict_types=1);

// channels/finder/src/FinderBuilder.php
//
// Builds the VIEWER-SAFE projection of the series library that the public
// Browse / Show pages (channels/browse.html, channels/show.html) read through
// channels/finder.php.
//
// Why a server-side projection instead of the pages loading series.json
// directly (as the guide's catalog resolver does):
//
//   - size: series/ is ~30 MB of raw importer output, mostly episode
//     descriptions. Browse needs a few hundred bytes per show.
//   - privacy of editorial bookkeeping: series.json carries each episode's
//     editorial `status` and `rights` notes. The viewer projection exposes
//     neither; it only contains episodes that are `approved` (the only status
//     the publish step ever schedules) and not rights-`restricted`.
//   - tidy text: YouTube descriptions are mostly links, sponsor reads and
//     social handles. cleanText() reduces them to the lead sentence(s).
//
// A "show" is a series (series/<id>/series.json) that at least one visible
// channel's catalog.json references AND that has >= 1 approved episode. Which
// channels carry a show comes from those catalog references; WHEN a show airs
// is not computed here -- the pages derive it from each channel's published
// schedule with the same timeline code the guide uses, so it can never
// disagree with what is actually on.
//
// Plain data in, plain data out; the only I/O is reading files under $root.

final class FinderBuilder
{
    private const ID = '/^[a-z0-9][a-z0-9-]*$/';
    private const SERIES_REF = '#(?:^|/)series/([a-z0-9][a-z0-9-]*)/series\.json$#';

    public function __construct(private readonly string $root)
    {
    }

    /** Newest mtime among every input file: the cache key. */
    public function sourceMtime(): int
    {
        $newest = 0;
        foreach ([...$this->glob('/series/*/series.json'), ...$this->glob('/channels/*/catalog.json'), ...$this->glob('/channels/*/meta.json')] as $file) {
            $newest = max($newest, (int) @filemtime($file));
        }
        return $newest;
    }

    /**
     * @return array{generated_at:string,source_mtime:int,shows:list<array<string,mixed>>}
     */
    public function index(): array
    {
        $carriers = $this->carriers();
        $shows = [];
        foreach ($carriers as $seriesId => $channelIds) {
            $series = $this->readSeries($seriesId);
            if ($series === null) {
                continue;
            }
            $episodes = $this->approvedEpisodes($series);
            if ($episodes === []) {
                continue;
            }
            $shows[] = $this->showHeader($seriesId, $series, $channelIds) + ['episode_count' => count($episodes)];
        }
        usort($shows, static fn (array $a, array $b): int => strcasecmp((string) $a['title'], (string) $b['title']));
        return [
            'generated_at' => gmdate('c'),
            'source_mtime' => $this->sourceMtime(),
            'shows' => $shows,
        ];
    }

    /**
     * One show with its (approved) episodes, or null when the id is unknown,
     * not carried by any visible channel, or has nothing approved.
     *
     * @return array<string,mixed>|null
     */
    public function show(string $seriesId): ?array
    {
        if (preg_match(self::ID, $seriesId) !== 1) {
            return null;
        }
        $carriers = $this->carriers();
        if (!isset($carriers[$seriesId])) {
            return null;
        }
        $series = $this->readSeries($seriesId);
        if ($series === null) {
            return null;
        }
        $episodes = $this->approvedEpisodes($series);
        if ($episodes === []) {
            return null;
        }
        $out = [];
        foreach ($episodes as $ep) {
            $out[] = [
                'id' => (string) $ep['id'],
                'number' => isset($ep['episode_number']) && is_numeric($ep['episode_number']) ? (int) $ep['episode_number'] : null,
                'title' => $this->oneLine((string) ($ep['title'] ?? '')),
                'description' => self::cleanText((string) ($ep['description'] ?? ''), 240),
                'duration' => isset($ep['duration']) && is_numeric($ep['duration']) ? (int) $ep['duration'] : null,
                'thumbnail_url' => self::safeUrl($ep['thumbnail_url'] ?? null),
                'published_at' => is_string($ep['published_at'] ?? null) ? $ep['published_at'] : null,
            ];
        }
        return $this->showHeader($seriesId, $series, $carriers[$seriesId], 700) + [
            'episode_count' => count($out),
            'episodes' => $out,
        ];
    }

    // ---------- text helpers (static: unit-tested directly) ----------

    /**
     * Reduces a raw (usually YouTube) description to its lead text: URLs and
     * hashtags removed, boilerplate paragraphs ("Subscribe...", "Follow us...",
     * "Support ... on Patreon") skipped, whitespace collapsed, and cut to `$max`
     * characters at a word boundary with an ellipsis. Returns '' when nothing
     * readable is left.
     */
    public static function cleanText(string $raw, int $max): string
    {
        $raw = str_replace(["\r\n", "\r"], "\n", $raw);
        $fallback = '';
        foreach (preg_split('/\n\s*\n/u', $raw) ?: [] as $para) {
            $text = self::stripNoise($para);
            if ($text === '') {
                continue;
            }
            if ($fallback === '') {
                $fallback = $text;
            }
            if (mb_strlen($text) < 25) {
                continue;
            }
            if (preg_match('/^(subscribe|follow|support|become|check out|get |join|links?\b|social|patreon|instagram|twitter|facebook|tiktok|business inquir|for business|music by|this video is sponsored|sponsor|special thanks|thanks to)/iu', $text) === 1) {
                continue;
            }
            return self::clip($text, $max);
        }
        return self::clip($fallback, $max);
    }

    private static function stripNoise(string $s): string
    {
        $s = preg_replace('#\b(?:https?://|www\.)\S+#iu', ' ', $s) ?? $s;
        $s = preg_replace('/(?<!\w)[#@][\w.]+/u', ' ', $s) ?? $s;
        $s = preg_replace('/\s+/u', ' ', $s) ?? $s;
        return trim($s, " \t\n\r\0\x0B-–—:|");
    }

    private static function clip(string $s, int $max): string
    {
        if ($s === '' || mb_strlen($s) <= $max) {
            return $s;
        }
        $cut = mb_substr($s, 0, $max);
        $space = mb_strrpos($cut, ' ');
        if ($space !== false && $space > (int) ($max * 0.6)) {
            $cut = mb_substr($cut, 0, $space);
        }
        return rtrim($cut, " ,;:-–—.") . '…';
    }

    private function oneLine(string $s): string
    {
        return trim(preg_replace('/\s+/u', ' ', $s) ?? $s);
    }

    private static function safeUrl(mixed $u): ?string
    {
        return is_string($u) && preg_match('#^https?://#i', $u) === 1 ? $u : null;
    }

    // ---------- data ----------

    /**
     * @param list<string> $channelIds
     * @return array<string,mixed>
     */
    private function showHeader(string $id, array $series, array $channelIds, int $descMax = 280): array
    {
        return [
            'id' => $id,
            'title' => $this->oneLine((string) ($series['title'] ?? $id)),
            'description' => self::cleanText((string) ($series['description'] ?? ''), $descMax),
            'thumbnail_url' => self::safeUrl($series['thumbnail_url'] ?? null),
            'creator' => is_string($series['creator'] ?? null) && $series['creator'] !== '' ? $series['creator'] : null,
            'year' => is_numeric($series['year'] ?? null) ? (int) $series['year'] : null,
            'channels' => $channelIds,
        ];
    }

    /** @return list<array<string,mixed>> approved, not rights-restricted, by episode number */
    private function approvedEpisodes(array $series): array
    {
        $out = [];
        foreach ($series['episodes'] ?? [] as $ep) {
            if (!is_array($ep) || !isset($ep['id']) || !is_string($ep['id'])) {
                continue;
            }
            if (($ep['status'] ?? null) !== 'approved') {
                continue;
            }
            if (($ep['rights']['status'] ?? null) === 'restricted') {
                continue;
            }
            $out[] = $ep;
        }
        usort($out, static fn (array $a, array $b): int => ($a['episode_number'] ?? PHP_INT_MAX) <=> ($b['episode_number'] ?? PHP_INT_MAX));
        return $out;
    }

    /**
     * series id => ids of the visible channels whose catalog.json references it.
     * Channel order follows channel number (as channels.php does).
     *
     * @return array<string,list<string>>
     */
    private function carriers(): array
    {
        $channels = [];
        foreach ($this->glob('/channels/*/meta.json') as $metaFile) {
            $id = basename(dirname($metaFile));
            $meta = $this->readJson($metaFile);
            if (preg_match(self::ID, $id) !== 1 || $meta === null || !empty($meta['hidden'])) {
                continue;
            }
            $channels[] = [$id, is_numeric($meta['number'] ?? null) ? (float) $meta['number'] : INF];
        }
        usort($channels, static fn (array $a, array $b): int => [$a[1], $a[0]] <=> [$b[1], $b[0]]);

        $map = [];
        foreach ($channels as [$channelId]) {
            $catalog = $this->readJson($this->root . "/channels/$channelId/catalog.json");
            foreach ($catalog['series'] ?? [] as $entry) {
                $ref = is_array($entry) ? ($entry['ref'] ?? null) : null;
                if (!is_string($ref) || preg_match(self::SERIES_REF, $ref, $m) !== 1) {
                    continue;
                }
                $seriesId = $m[1];
                if (!is_file($this->root . "/series/$seriesId/series.json")) {
                    continue;
                }
                if (!in_array($channelId, $map[$seriesId] ?? [], true)) {
                    $map[$seriesId][] = $channelId;
                }
            }
        }
        return $map;
    }

    private function readSeries(string $seriesId): ?array
    {
        return $this->readJson($this->root . "/series/$seriesId/series.json");
    }

    private function readJson(string $file): ?array
    {
        $raw = @file_get_contents($file);
        if ($raw === false) {
            return null;
        }
        $data = json_decode($raw, true);
        return is_array($data) ? $data : null;
    }

    /** @return list<string> */
    private function glob(string $pattern): array
    {
        return glob($this->root . $pattern) ?: [];
    }
}
