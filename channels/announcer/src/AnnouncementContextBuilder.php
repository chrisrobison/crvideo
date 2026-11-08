<?php
declare(strict_types=1);

// channels/announcer/src/AnnouncementContextBuilder.php
//
// Builds structured AnnouncementContext records (spec section 2) from an
// already-compiled channels/<id>/schedule.json, for every eligible
// transition this channel's announcer.json opts into.
//
// schedule.json's "continuity" items (ScheduleWriter.php, ContinuityFiller.php)
// are the exact transition points this walks:
//
//   {"type":"continuity","id","start","duration","template",
//    "next_program_id", "program_id"?}
//
// - "next_program_id" is the NEXT real "video" item's own id (an episode
//   id, e.g. "yt-xxxx") -- NOT an occurrence_id.
// - "program_id" (when present) is the occurrence_id of the programming
//   BLOCK this card sits inside -- i.e. the block it is leading INTO
//   (ProgrammingCompiler's minimum_lead_in reservation). This is the
//   common case for every block that reserves a lead-in and is the
//   cheapest, most direct way to resolve the upcoming show's BLOCK TITLE
//   (never the raw video title -- see WriterPromptBuilder).
// - When a card has no "program_id" (a genuine inter-program station
//   break, not inside anyone's lead-in), the upcoming block is resolved
//   one hop further: find the next "video" item (its id should match
//   next_program_id), then read THAT item's own "program_id".
// - The outgoing (current) block is resolved the same way from the
//   nearest PRECEDING "video" item's own "program_id".
//
// schedule.json's top-level "programs[]" (one entry per occurrence_id) is
// where the actual block title/description/series_id/series_title live --
// confirmed against real data (channels/science/schedule.json): this is
// the one and only source this builder reads for "what show is this",
// deliberately never the video item's own "title" field.
//
// Program/occurrence identity is always by occurrence_id, never by title
// -- so two completely unrelated blocks that happen to share a display
// title (spec section 11: "programs with identical titles") are still
// unambiguously distinguished for caching and context-building purposes.

final class AnnouncementContextBuilder
{
    /**
     * @param array<string,mixed> $schedule   decoded schedule.json
     * @param array<string,mixed> $meta       decoded meta.json
     * @param array<string,mixed> $programming decoded programming.json (for per-block timezone), or [] if absent
     * @param array<string,mixed> $config     resolved AnnouncerConfig::resolve() output
     * @return list<array<string,mixed>> AnnouncementContext records
     */
    public static function buildAll(
        string $channelId,
        array $schedule,
        array $meta,
        array $programming,
        array $config,
        string $seriesRoot,
    ): array {
        $items = $schedule['blocks'][0]['items'] ?? [];
        if (!is_array($items)) {
            return [];
        }
        $programsByOccurrence = [];
        foreach (($schedule['programs'] ?? []) as $p) {
            if (is_array($p) && is_string($p['occurrence_id'] ?? null)) {
                $programsByOccurrence[$p['occurrence_id']] = $p;
            }
        }
        $blockTimezone = [];
        foreach (($programming['blocks'] ?? []) as $b) {
            if (is_array($b) && is_string($b['id'] ?? null)) {
                $blockTimezone[$b['id']] = is_string($b['recurrence']['timezone'] ?? null) ? $b['recurrence']['timezone'] : 'UTC';
            }
        }

        $windowStartTs = self::parseWindowStart($schedule);
        $types = is_array($config['types'] ?? null) ? $config['types'] : [];
        $seriesCache = [];

        $contexts = [];

        if (in_array('channel_id', $types, true)) {
            $contexts[] = self::channelIdContext($channelId, $meta, $config);
        }

        if (in_array('coming_up_next', $types, true)) {
            $n = count($items);
            $lastVideoIndex = null;
            for ($i = 0; $i < $n; $i++) {
                $it = $items[$i];
                if (!is_array($it)) {
                    continue;
                }
                if (($it['type'] ?? null) === 'video') {
                    $lastVideoIndex = $i;
                    continue;
                }
                if (($it['type'] ?? null) !== 'continuity') {
                    continue;
                }

                $outgoing = $lastVideoIndex !== null
                    ? self::occurrenceFor($items[$lastVideoIndex], $programsByOccurrence)
                    : null;

                $nextVideoIndex = self::findNextVideoIndex($items, $i + 1);
                $nextVideoItem = $nextVideoIndex !== null ? $items[$nextVideoIndex] : null;

                $incoming = isset($it['program_id']) && is_string($it['program_id'])
                    ? ($programsByOccurrence[$it['program_id']] ?? null)
                    : ($nextVideoItem !== null ? self::occurrenceFor($nextVideoItem, $programsByOccurrence) : null);

                $context = self::buildComingUpNextContext(
                    $channelId, $meta, $config, $it, $outgoing, $incoming, $nextVideoItem,
                    $windowStartTs, $blockTimezone, $programsByOccurrence, $seriesRoot, $seriesCache,
                );
                $contexts[] = $context;
            }
        }

        return $contexts;
    }

    private static function parseWindowStart(array $schedule): int
    {
        $iso = $schedule['_publish']['window']['start'] ?? null;
        if (is_string($iso)) {
            try {
                return (new DateTimeImmutable($iso))->getTimestamp();
            } catch (Throwable) {
                // fall through
            }
        }
        return 0;
    }

    private static function findNextVideoIndex(array $items, int $fromIndex): ?int
    {
        for ($j = $fromIndex, $n = count($items); $j < $n; $j++) {
            if (is_array($items[$j]) && ($items[$j]['type'] ?? null) === 'video') {
                return $j;
            }
        }
        return null;
    }

    /** @return array<string,mixed>|null */
    private static function occurrenceFor(array $videoItem, array $programsByOccurrence): ?array
    {
        $occurrenceId = $videoItem['program_id'] ?? null;
        if (!is_string($occurrenceId)) {
            return null;
        }
        return $programsByOccurrence[$occurrenceId] ?? null;
    }

    /** @return array<string,mixed>|null */
    private static function followingProgram(?array $incoming, array $programsByOccurrence): ?array
    {
        if ($incoming === null) {
            return null;
        }
        $best = null;
        foreach ($programsByOccurrence as $p) {
            if (!is_int($p['start'] ?? null) || $p['start'] <= $incoming['end']) {
                continue;
            }
            if ($best === null || $p['start'] < $best['start']) {
                $best = $p;
            }
        }
        return $best;
    }

    /** @return array{title:?string,description:?string}|null */
    private static function loadSeries(string $seriesId, string $seriesRoot, array &$seriesCache): ?array
    {
        if (array_key_exists($seriesId, $seriesCache)) {
            return $seriesCache[$seriesId];
        }
        $path = "$seriesRoot/$seriesId/series.json";
        if (!is_file($path)) {
            return $seriesCache[$seriesId] = null;
        }
        $doc = json_decode((string) file_get_contents($path), true);
        if (!is_array($doc)) {
            return $seriesCache[$seriesId] = null;
        }
        return $seriesCache[$seriesId] = $doc;
    }

    /** @return array<string,mixed>|null episode record from a loaded series.json, matched by id */
    private static function findEpisode(?array $seriesDoc, ?string $episodeId): ?array
    {
        if ($seriesDoc === null || $episodeId === null) {
            return null;
        }
        foreach (($seriesDoc['episodes'] ?? []) as $ep) {
            if (is_array($ep) && ($ep['id'] ?? null) === $episodeId) {
                return $ep;
            }
        }
        return null;
    }

    /** @return array<string,mixed> */
    private static function channelIdContext(string $channelId, array $meta, array $config): array
    {
        return [
            'type' => 'channel_id',
            'transitionId' => 'channel-id', // stable, not tied to any one airtime -- see AnnouncerPipeline
            'channelId' => $channelId,
            'channelName' => is_string($meta['name'] ?? null) ? $meta['name'] : $channelId,
            'channelDescription' => is_string($meta['description'] ?? null) ? $meta['description'] : null,
            'channelPersonality' => ['style' => $config['style'] ?? null, 'tone' => $config['tone'] ?? null],
            'fromProgramId' => null,
            'toProgramId' => null,
            'toEpisodeId' => null,
            'currentBlock' => null,
            'nextBlock' => null,
            'seriesInfo' => null,
            'episodeInfo' => null,
            'followingProgram' => null,
            'scheduledStartTime' => null,
            'timezone' => null,
            'timeOfDay' => null,
            'isConsecutiveSameSeries' => false,
            'noUpcomingProgram' => true,
        ];
    }

    /** @return array<string,mixed> */
    private static function buildComingUpNextContext(
        string $channelId,
        array $meta,
        array $config,
        array $continuityItem,
        ?array $outgoing,
        ?array $incoming,
        ?array $nextVideoItem,
        int $windowStartTs,
        array $blockTimezone,
        array $programsByOccurrence,
        string $seriesRoot,
        array &$seriesCache,
    ): array {
        $seriesDoc = $incoming !== null && is_string($incoming['series_id'] ?? null)
            ? self::loadSeries($incoming['series_id'], $seriesRoot, $seriesCache)
            : null;
        $episode = self::findEpisode($seriesDoc, $nextVideoItem['id'] ?? null);
        $following = self::followingProgram($incoming, $programsByOccurrence);

        $startAbs = $nextVideoItem !== null
            ? $windowStartTs + (int) $nextVideoItem['start']
            : $windowStartTs + (int) $continuityItem['start'] + (int) $continuityItem['duration'];

        $tzName = $incoming !== null && is_string($incoming['block_id'] ?? null)
            ? ($blockTimezone[$incoming['block_id']] ?? 'UTC')
            : 'UTC';
        $timeOfDay = null;
        try {
            $timeOfDay = (new DateTimeImmutable('@' . $startAbs))->setTimezone(new DateTimeZone($tzName))->format('H:i');
        } catch (Throwable) {
            // invalid/unknown timezone -- leave timeOfDay null rather than fail the whole context
        }

        $isConsecutiveSameSeries = $outgoing !== null && $incoming !== null
            && is_string($outgoing['series_id'] ?? null) && is_string($incoming['series_id'] ?? null)
            && $outgoing['series_id'] === $incoming['series_id'];

        return [
            'type' => 'coming_up_next',
            'transitionId' => $continuityItem['id'],
            'channelId' => $channelId,
            'channelName' => is_string($meta['name'] ?? null) ? $meta['name'] : $channelId,
            'channelDescription' => is_string($meta['description'] ?? null) ? $meta['description'] : null,
            'channelPersonality' => ['style' => $config['style'] ?? null, 'tone' => $config['tone'] ?? null],
            // Occurrence identity (never title-based -- see class header).
            'fromProgramId' => $outgoing['occurrence_id'] ?? null,
            'toProgramId' => $incoming['occurrence_id'] ?? null,
            'toEpisodeId' => $nextVideoItem['id'] ?? null,
            'currentBlock' => $outgoing !== null ? [
                'title' => $outgoing['title'] ?? null,
                'description' => $outgoing['description'] ?? null,
                'seriesId' => $outgoing['series_id'] ?? null,
                'seriesTitle' => $outgoing['series_title'] ?? null,
            ] : null,
            // The BLOCK title/description -- this is what must be announced,
            // never $nextVideoItem['title'] (the raw underlying video title).
            'nextBlock' => $incoming !== null ? [
                'title' => $incoming['title'] ?? null,
                'description' => $incoming['description'] ?? null,
                'seriesId' => $incoming['series_id'] ?? null,
                'seriesTitle' => $incoming['series_title'] ?? null,
            ] : null,
            'seriesInfo' => $seriesDoc !== null ? [
                'title' => $seriesDoc['title'] ?? null,
                'description' => $seriesDoc['description'] ?? null,
            ] : null,
            // Episode metadata is supplied for optional color/flavor only --
            // WriterPromptBuilder explicitly instructs the writer to name the
            // show by its BLOCK title, never read out the raw episode title
            // as if it were the show name (spec section 2).
            'episodeInfo' => $episode !== null ? [
                'title' => $episode['title'] ?? null,
                'description' => $episode['description'] ?? null,
                'episodeNumber' => $episode['episode_number'] ?? null,
            ] : null,
            'followingProgram' => $following !== null ? ['title' => $following['title'] ?? null] : null,
            'scheduledStartTime' => $startAbs,
            'timezone' => $tzName,
            'timeOfDay' => $timeOfDay,
            'isConsecutiveSameSeries' => $isConsecutiveSameSeries,
            'noUpcomingProgram' => $incoming === null,
        ];
    }
}
