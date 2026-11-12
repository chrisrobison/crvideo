<?php
declare(strict_types=1);

// channels/publish/src/ProgrammingCompiler.php
//
// Turns a channel's programming.json (recurring "series" blocks) plus its
// resolved series (from CatalogResolver, approved-episode-gated) into a flat
// list of dated occurrences: absolute start/end instants plus per-episode
// info (id, title, source) for ScheduleWriter to drop into the schedule.json
// item shape. This is the only place episode *selection* happens; Recurrence
// only computes *when*, never *which episode*.
//
// Policies:
//
// - Only episodes with status "approved" are eligible. candidate/rejected/
//   disabled episodes are excluded from the rotation set entirely (they
//   don't occupy a rotation slot).
// - Selection is sequential and deterministic:
//   episode_index = floorMod(occurrence_index, count(approved episodes)),
//   wrapping to episode 0 when rotation.loop is true (the default).
//   rotation.mode must be "sequential"; anything else is a hard error
//   rather than silently behaving like sequential (random rotation would
//   need guaranteed-reproducible seeding, which isn't built).
// - rotation.loop: false leaves an occurrence as a gap (not an error, not a
//   wraparound) once occurrence_index runs past either end of the list.
// - The list used for rotation math is the *pinned* one (see EpisodeSetPin),
//   not necessarily series.json's current list. If the pinned episode at a
//   position is no longer approved/present at publish time, that single
//   occurrence is a gap (with a warning); no other occurrence's selection
//   is reshuffled.
// - An episode always plays in full, using its own series.json `duration`
//   when known. The block's `duration` is only (a) the fallback when the
//   episode's duration is unknown and (b) the spacing of occurrences; it
//   never truncates an episode. An episode that would run into the next
//   occurrence (from this block or any other in the channel) is a hard
//   configuration error (see BoundaryResolver): publish.php refuses to emit
//   an overlapping schedule rather than truncate content.
// - A series with zero approved episodes yields zero occurrences for that
//   block (every instant is a gap), not an error: "imported but not yet
//   reviewed" is a normal state.
//
// Multi-episode packing (block.packing.enabled; see docs/series-and-
// channels.md): when absent or false, each occurrence holds exactly one
// episode and nothing below applies, so existing channels compile
// identically unless they opt in. When true, EpisodePacker decides how many
// pinned episodes fill each occurrence (never truncating one), and
// RotationState persists the cursor/deferred-queue state this needs across
// publish runs (see its header for why a checkpoint is enough).
//
// Program-level EPG metadata (docs/guide-update.md): every scheduled episode
// is grouped (via BoundaryResolver) into one logical "programming
// occurrence", the single cell a cable guide would show however many
// episodes were packed into it. Each occurrence gets:
//
//   - occurrence_id: "<blockId>@<nominalStartUnixSeconds>", unique per
//     scheduled instant, so an AM and PM showing of the same series (or the
//     same block on two days) are never confused and the EPG never infers
//     boundaries from titles or adjacency.
//   - A resolved display title/description (see resolveProgramTitle/
//     resolveProgramDescription): editorial guide metadata, distinct from any
//     episode's own title/description.
//
// Title/description are resolved once per block and occurrence_id/nominal
// timing once per occurrence here; BoundaryResolver stamps them onto the
// flattened item list and derives each occurrence's effective (post-delay)
// presentation window.

final class ProgrammingCompiler
{
    /**
     * @param array{blocks?: list<array<string,mixed>>} $programming decoded programming.json
     * @param list<array{id:string,title:string,url:string,episodes:list<array<string,mixed>>}> $resolvedSeries
     *        CatalogResolver::resolveCatalog()'s "series" list for this channel.
     * @param array<string,array{title:?string,description:?string}> $previousPrograms
     *        block_id -> the title/description it was last published with (fallback
     *        tier 3 of resolveProgramTitle/resolveProgramDescription). Pass [] when
     *        there is no previous schedule.json (a first-ever publish, or one not
     *        yet carrying a "programs" collection).
     * @param int $minimumLeadInSeconds reserve this many seconds at the FRONT of every
     *        occurrence (packing and non-packing paths), left unpacked so it stays an
     *        ordinary uncovered interval that ContinuityFiller fills with a continuity
     *        card and folds into the occurrence's own `episodes[]`. That works because
     *        the occurrence's `nominalStart`/`durationSeconds` (which BoundaryResolver
     *        uses for the effective window) are deliberately left at the FULL slot.
     *        This guarantees a channel-configured minimum "Up Next" bumper before every
     *        program, not just where packing left a leftover. 0 (the default) is a
     *        no-op. publish.php resolves continuity.json's `defaults.minimum_lead_in`
     *        before calling compile() and passes it here.
     * @return array{
     *   items: list<array{start:int,end:int,id:string,title:string,source:?array,source_url:?string}>,
     *   warnings: list<string>,
     *   episodeSets: list<array{block_id:string,series_id:string,version:int,episode_count:int}>,
     *   programs: list<array<string,mixed>>,
     * }
     */
    public static function compile(
        array $programming,
        array $resolvedSeries,
        string $stateDir,
        string $channelId,
        bool $refreshEpisodeSet,
        DateTimeImmutable $windowStart,
        DateTimeImmutable $windowEnd,
        array $previousPrograms = [],
        int $minimumLeadInSeconds = 0,
    ): array {
        $seriesById = [];
        foreach ($resolvedSeries as $s) {
            $seriesById[$s['id']] = $s;
        }

        $groups = []; // one entry per scheduled occurrence that has at least one item -- see BoundaryResolver
        $warnings = [];
        $episodeSets = [];

        foreach ($programming['blocks'] ?? [] as $block) {
            $blockId = is_string($block['id'] ?? null) ? $block['id'] : '';
            if ($blockId === '') {
                $warnings[] = 'a programming block is missing "id"; skipped.';
                continue;
            }
            if (($block['type'] ?? null) !== 'series') {
                $warnings[] = "block \"$blockId\": unsupported type " . json_encode($block['type'] ?? null) . '; skipped.';
                continue;
            }
            $seriesId = $block['series_id'] ?? null;
            if (!is_string($seriesId) || !isset($seriesById[$seriesId])) {
                $warnings[] = "block \"$blockId\": series_id " . json_encode($seriesId)
                    . ' is not declared in this channel\'s catalog.json "series" references; skipped.';
                continue;
            }

            $rotation = is_array($block['rotation'] ?? null) ? $block['rotation'] : [];
            $rotationMode = $rotation['mode'] ?? 'sequential';
            if ($rotationMode !== 'sequential') {
                throw new RuntimeException(
                    "block \"$blockId\": rotation.mode \"$rotationMode\" is not implemented -- only \"sequential\" is "
                    . 'supported (random rotation needs guaranteed-reproducible seeding this phase does not implement).'
                );
            }
            $loop = array_key_exists('loop', $rotation) ? (bool) $rotation['loop'] : true;
            $anchorDate = $rotation['anchor_date'] ?? null;
            if (!is_string($anchorDate) || $anchorDate === '') {
                throw new RuntimeException("block \"$blockId\": rotation.anchor_date is required (\"YYYY-MM-DD\").");
            }

            $episodesById = [];
            $approvedIds = [];
            foreach ($seriesById[$seriesId]['episodes'] as $ep) {
                if (!is_array($ep) || !is_string($ep['id'] ?? null)) {
                    continue;
                }
                $episodesById[$ep['id']] = $ep;
                if (($ep['status'] ?? null) === 'approved') {
                    $approvedIds[] = $ep['id'];
                }
            }

            if (!$approvedIds) {
                $warnings[] = "block \"$blockId\": series \"$seriesId\" has no approved episodes yet; zero occurrences published for this block.";
                continue;
            }

            $pin = EpisodeSetPin::resolve($stateDir, $channelId, $blockId, $approvedIds, $refreshEpisodeSet);
            $pinnedIds = $pin['episodeIds'];
            if (!$pinnedIds) {
                $warnings[] = "block \"$blockId\": pinned episode set is empty; zero occurrences published for this block.";
                continue;
            }
            if ($pin['refreshed']) {
                $warnings[] = "block \"$blockId\": episode set (re)pinned at version {$pin['version']} (" . count($pinnedIds) . ' episode(s)).';
            }
            $pinnedCount = count($pinnedIds);
            $episodeSets[] = [
                'block_id' => $blockId,
                'series_id' => $seriesId,
                'version' => $pin['version'],
                'episode_count' => $pinnedCount,
            ];

            $durationSeconds = (int) ($block['duration'] ?? 0);
            if ($durationSeconds <= 0) {
                throw new RuntimeException("block \"$blockId\": duration must be a positive number of seconds.");
            }

            $boundary = BoundaryResolver::normalizeBoundary($block['boundary'] ?? null, $blockId);

            // Editorial program metadata for the guide: resolved once per block (title/
            // description don't vary per occurrence; only occurrence_id and timing do).
            // See resolveProgramTitle() for the fallback order.
            $seriesTitle = is_string($seriesById[$seriesId]['title'] ?? null) ? $seriesById[$seriesId]['title'] : null;
            $seriesDescription = is_string($seriesById[$seriesId]['description'] ?? null) ? $seriesById[$seriesId]['description'] : null;
            $blockTitle = is_string($block['title'] ?? null) && $block['title'] !== '' ? $block['title'] : null;
            $blockDescription = is_string($block['description'] ?? null) && $block['description'] !== '' ? $block['description'] : null;
            $previous = $previousPrograms[$blockId] ?? null;
            $previousTitle = is_string($previous['title'] ?? null) ? $previous['title'] : null;
            $previousDescription = is_string($previous['description'] ?? null) ? $previous['description'] : null;
            $programDescription = self::resolveProgramDescription($blockDescription, $seriesDescription, $previousDescription);

            $packing = is_array($block['packing'] ?? null) ? $block['packing'] : [];
            $packingEnabled = (bool) ($packing['enabled'] ?? false);

            // See $minimumLeadInSeconds above. Capped to leave at least 1s of the slot
            // for the episode; one that still doesn't fit overruns and is caught by
            // BoundaryResolver's overlap check.
            $leadIn = min($minimumLeadInSeconds, max(0, $durationSeconds - 1));

            if (!$packingEnabled) {
                // One episode per occurrence.
                $occurrences = Recurrence::occurrences($block['recurrence'] ?? [], $anchorDate, $windowStart, $windowEnd);
                foreach ($occurrences as $occ) {
                    $n = $occ['index'];
                    if ($loop) {
                        $episodeIndex = Recurrence::floorMod($n, $pinnedCount);
                    } elseif ($n >= 0 && $n < $pinnedCount) {
                        $episodeIndex = $n;
                    } else {
                        continue; // non-looping rotation has run out (or hasn't started) -- leave as a gap
                    }

                    $episodeId = $pinnedIds[$episodeIndex];
                    $episode = $episodesById[$episodeId] ?? null;
                    if ($episode === null || ($episode['status'] ?? null) !== 'approved') {
                        $warnings[] = "block \"$blockId\" occurrence " . $occ['at']->format('c')
                            . ": pinned episode \"$episodeId\" is no longer approved/present; this occurrence is left as a gap.";
                        continue;
                    }

                    $episodeDuration = is_numeric($episode['duration'] ?? null) ? (float) $episode['duration'] : null;
                    $itemDuration = ($episodeDuration !== null && $episodeDuration > 0) ? (int) round($episodeDuration) : $durationSeconds;
                    $startAbs = $occ['at']->getTimestamp();
                    // nominalStart/durationSeconds stay the FULL slot (not shifted by
                    // $leadIn), which keeps the reserved lead-in inside this program's
                    // effective window instead of becoming an unattributed gap.
                    $item = self::buildItem($episode, $startAbs + $leadIn, $itemDuration);
                    $groups[] = [
                        'blockId' => $blockId,
                        'boundary' => $boundary,
                        'nominalStart' => $startAbs,
                        'durationSeconds' => $durationSeconds,
                        'occurrenceId' => "$blockId@$startAbs",
                        'programTitle' => self::resolveProgramTitle($blockTitle, $seriesTitle, $previousTitle, $item['title']),
                        'programDescription' => $programDescription,
                        'seriesId' => $seriesId,
                        'seriesTitle' => $seriesTitle,
                        'items' => [$item],
                    ];
                }
                continue;
            }

            // Packing path: EpisodePacker decides how many pinned episodes fill each
            // occurrence; RotationState carries its cursor/deferred queue across runs.
            $config = EpisodePacker::normalizeConfig($packing, $blockId);
            $rot = RotationState::load($stateDir, $channelId, $blockId, $pin['version']);
            if ($rot['reset']) {
                $warnings[] = "block \"$blockId\": {$rot['resetReason']}";
            }

            $replayStart = $windowStart;
            if ($rot['checkpoint_at'] !== null) {
                $checkpointAt = new DateTimeImmutable($rot['checkpoint_at']);
                if ($checkpointAt < $windowStart) {
                    $replayStart = $checkpointAt;
                } elseif ($checkpointAt > $windowStart) {
                    // --window-start moved earlier than the last known checkpoint: there is
                    // no history before the checkpoint to replay from. Documented limitation
                    // (see RotationState's header) -- reset and warn rather than guess.
                    $warnings[] = "block \"$blockId\": --window-start (" . $windowStart->format('c') . ') is earlier than the '
                        . 'last known rotation checkpoint (' . $checkpointAt->format('c') . '); rotation cursor and deferred '
                        . 'queue reset to the start for this publish (will not match a previously published overlapping window).';
                    $rot = RotationState::empty();
                }
            }

            $occurrences = Recurrence::occurrences($block['recurrence'] ?? [], $anchorDate, $replayStart, $windowEnd);

            $cursor = $rot['cursor'];
            $deferred = $rot['deferred'];
            $altCursor = $rot['altCursor'];
            $checkpointCaptured = false;
            $checkpointCursor = $cursor;
            $checkpointDeferred = $deferred;
            $checkpointAltCursor = $altCursor;
            $checkpointIndex = null;
            $checkpointAtToSave = null;

            foreach ($occurrences as $occ) {
                $emit = $occ['at'] >= $windowStart;
                if ($emit && !$checkpointCaptured) {
                    $checkpointCaptured = true;
                    $checkpointCursor = $cursor;
                    $checkpointDeferred = $deferred;
                    $checkpointAltCursor = $altCursor;
                    $checkpointIndex = $occ['index'];
                    $checkpointAtToSave = $occ['at'];
                }

                // $leadIn is carved off the front: the packer sees only
                // $durationSeconds - $leadIn as available. The fallback duration passed
                // below stays the FULL $durationSeconds (it's just the stand-in for an
                // episode whose own duration is unknown).
                $packed = EpisodePacker::packOccurrence(
                    $durationSeconds - $leadIn, $pinnedIds, $episodesById,
                    ['cursor' => $cursor, 'deferred' => $deferred, 'altCursor' => $altCursor],
                    $config, $loop, $durationSeconds, $blockId, $occ['at']->format('c'),
                );
                $cursor = $packed['state']['cursor'];
                $deferred = $packed['state']['deferred'];
                $altCursor = $packed['state']['altCursor'];

                if (!$emit) {
                    continue; // replay-only: re-derives cursor/deferred state, nothing is (re-)published for it
                }

                $warnings = [...$warnings, ...$packed['warnings']];
                if (!$packed['scheduled']) {
                    continue; // nothing packed into this occurrence -- no group, exactly like a non-packing-path gap
                }
                $startAbs = $occ['at']->getTimestamp();
                $offset = $leadIn; // reserve [startAbs, startAbs+leadIn) -- see $minimumLeadInSeconds's doc
                $groupItems = [];
                foreach ($packed['scheduled'] as $sched) {
                    $episode = $episodesById[$sched['episode_id']];
                    $groupItems[] = self::buildItem($episode, $startAbs + $offset, $sched['duration']);
                    $offset += $sched['duration'];
                }
                $groups[] = [
                    'blockId' => $blockId,
                    'boundary' => $boundary,
                    'nominalStart' => $startAbs,
                    'durationSeconds' => $durationSeconds,
                    'occurrenceId' => "$blockId@$startAbs",
                    'programTitle' => self::resolveProgramTitle($blockTitle, $seriesTitle, $previousTitle, $groupItems[0]['title']),
                    'programDescription' => $programDescription,
                    'seriesId' => $seriesId,
                    'seriesTitle' => $seriesTitle,
                    'items' => $groupItems,
                ];
            }

            if ($checkpointCaptured) {
                RotationState::save(
                    $stateDir, $channelId, $blockId, $pin['version'],
                    $checkpointCursor, $checkpointDeferred, $checkpointAltCursor, $checkpointIndex, $checkpointAtToSave,
                );
            }
        }

        // BoundaryResolver is the only place overlap is decided: hard (the default)
        // refuses any overlap; soft/elastic may turn a bounded amount into an
        // explicit, reported delay. See its header.
        $resolved = BoundaryResolver::resolve($groups);
        $items = $resolved['items'];
        $warnings = [...$warnings, ...$resolved['warnings']];

        return ['items' => $items, 'warnings' => $warnings, 'episodeSets' => $episodeSets, 'programs' => $resolved['programs']];
    }

    /**
     * Fallback order for a program's guide-facing TITLE:
     *   1. The block's own explicit "title".
     *   2. Its associated series' title.
     *   3. The title this block was last published with, so a title that only
     *      ever resolved via tier 4 doesn't flicker between episode titles when
     *      packing/rotation picks a different first episode.
     *   4. The first scheduled episode's own title (or id). Never a hard failure:
     *      the occurrence always has at least one item by now.
     */
    private static function resolveProgramTitle(?string $blockTitle, ?string $seriesTitle, ?string $previousTitle, string $episodeFallbackTitle): string
    {
        foreach ([$blockTitle, $seriesTitle, $previousTitle] as $candidate) {
            if (is_string($candidate) && $candidate !== '') {
                return $candidate;
            }
        }
        return $episodeFallbackTitle;
    }

    /**
     * Same idea as resolveProgramTitle() for the guide-facing DESCRIPTION, but
     * with no episode-description tier: mixing an episode's description into the
     * program's editorial block-level description would blur the distinction
     * between them. Absent everywhere, this is null.
     */
    private static function resolveProgramDescription(?string $blockDescription, ?string $seriesDescription, ?string $previousDescription): ?string
    {
        foreach ([$blockDescription, $seriesDescription, $previousDescription] as $candidate) {
            if (is_string($candidate) && $candidate !== '') {
                return $candidate;
            }
        }
        return null;
    }

    /** @return array{start:int,end:int,id:string,title:string,source:?array,source_url:?string} */
    private static function buildItem(array $episode, int $startAbs, int $durationSeconds): array
    {
        $source = is_array($episode['source'] ?? null) ? $episode['source'] : null;
        // A YouTube episode's source.url is already the human-readable watch page, so
        // it's the attribution link (and never becomes media_url; see ScheduleWriter).
        // For a directly-hosted (html5) episode, source.url is the playable media file,
        // right for media_url but wrong to show as "the source" (an archive.org .mp4
        // rather than its /details/ page). Optional source.page_url (see
        // ia-import/src/IaSeriesBuilder.php) is that human-readable link; absent,
        // source.url is used.
        $sourceUrl = is_string($source['page_url'] ?? null) ? $source['page_url'] : (is_string($source['url'] ?? null) ? $source['url'] : null);
        return [
            'start' => $startAbs,
            'end' => $startAbs + $durationSeconds,
            'id' => $episode['id'],
            'title' => is_string($episode['title'] ?? null) ? $episode['title'] : $episode['id'],
            'source' => $source,
            'source_url' => $sourceUrl,
        ];
    }
}
