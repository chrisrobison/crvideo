<?php
declare(strict_types=1);

// channels/publish/src/ProgrammingCompiler.php
//
// Turns a channel's programming.json (recurring "series" blocks) plus its
// resolved series (from CatalogResolver -- approved-episode-gated) into a
// flat list of dated occurrences: absolute start/end instants plus enough
// per-episode info (id, title, source) for ScheduleWriter to drop
// straight into the existing schedule.json item shape. This is the only
// place episode *selection* happens; Recurrence only computes *when*,
// never *which episode*.
//
// Policies implemented here (see the spec's explicit requirements):
//
// - Only episodes with status "approved" are ever eligible. candidate/
//   rejected/disabled episodes are excluded from the rotation set
//   entirely (they don't even occupy a rotation slot).
// - Episode selection is sequential and deterministic:
//   episode_index = floorMod(occurrence_index, count(approved episodes)),
//   looping back to episode 0 after the last one when rotation.loop is
//   true (the default and, for now, the only mode this phase implements
//   other than "no loop" -- rotation.mode must be "sequential"; anything
//   else is a hard error rather than silently behaving like sequential,
//   since random rotation needs guaranteed-reproducible seeding this
//   phase doesn't build).
// - rotation.loop: false means the rotation simply has no episode once
//   occurrence_index runs past the end of the approved list (or before
//   its start) -- that occurrence is left as a gap, not an error, and
//   not a wraparound.
// - The approved-episode list used for rotation math is the *pinned*
//   one (see EpisodeSetPin), not necessarily series.json's current list
//   -- see that file for why. If the pinned list's episode at a given
//   rotation position is no longer approved/present at publish time,
//   that single occurrence is left as a gap (a warning is reported) --
//   it never reshuffles any other occurrence's selection.
// - Slot-vs-episode-duration policy: an episode always plays in full,
//   using its own series.json `duration` when known. The programming
//   block's `duration` is used only (a) as a fallback when the episode's
//   own duration is unknown, and (b) to space out occurrences for
//   display purposes -- it is never used to truncate an episode. If an
//   episode's real duration would make it run into the next scheduled
//   occurrence (from this block or any other in the same channel), that
//   is a hard configuration error (see the overlap check in compile()) --
//   publish.php refuses to emit an ambiguous/overlapping schedule rather
//   than silently truncating content or corrupting the timeline.
// - A series with zero currently-approved episodes produces zero
//   occurrences for that block (every scheduled instant for it is left
//   as a gap) -- never an error, since "imported but not yet reviewed"
//   is an entirely normal, expected state.
//
// Multi-episode packing (block.packing.enabled -- see docs/series-and-
// channels.md): when ABSENT or false, every behavior above is exactly
// what runs, byte-for-byte -- this is the pre-packing, one-episode-per-
// occurrence path, kept intact specifically so every existing published
// channel (Science & Engineering included) keeps compiling identically
// forever unless it explicitly opts in. When true, EpisodePacker decides
// how many pinned episodes fill each occurrence (never truncating one to
// fit), and RotationState persists the small amount of additional
// cursor/deferred-queue state that requires, across publish runs, that a
// single "advance by one episode per occurrence" counter can no longer
// capture on its own -- see that file's header for why a checkpoint
// (rather than a full history) is enough to stay both deterministic and
// bounded-cost.

final class ProgrammingCompiler
{
    /**
     * @param array{blocks?: list<array<string,mixed>>} $programming decoded programming.json
     * @param list<array{id:string,title:string,url:string,episodes:list<array<string,mixed>>}> $resolvedSeries
     *        CatalogResolver::resolveCatalog()'s "series" list for this channel.
     * @return array{
     *   items: list<array{start:int,end:int,id:string,title:string,source:?array,source_url:?string}>,
     *   warnings: list<string>,
     *   episodeSets: list<array{block_id:string,series_id:string,version:int,episode_count:int}>,
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

            $packing = is_array($block['packing'] ?? null) ? $block['packing'] : [];
            $packingEnabled = (bool) ($packing['enabled'] ?? false);

            if (!$packingEnabled) {
                // Pre-packing path, unchanged: exactly one episode per occurrence.
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
                    $groups[] = [
                        'blockId' => $blockId,
                        'boundary' => $boundary,
                        'nominalStart' => $startAbs,
                        'items' => [self::buildItem($episode, $startAbs, $itemDuration)],
                    ];
                }
                continue;
            }

            // Packing path: EpisodePacker decides how many pinned episodes fill
            // each occurrence; RotationState carries its cursor/deferred queue
            // across publish runs. See both files' header comments.
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

                $packed = EpisodePacker::packOccurrence(
                    $durationSeconds, $pinnedIds, $episodesById,
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
                $offset = 0;
                $groupItems = [];
                foreach ($packed['scheduled'] as $sched) {
                    $episode = $episodesById[$sched['episode_id']];
                    $groupItems[] = self::buildItem($episode, $startAbs + $offset, $sched['duration']);
                    $offset += $sched['duration'];
                }
                $groups[] = ['blockId' => $blockId, 'boundary' => $boundary, 'nominalStart' => $startAbs, 'items' => $groupItems];
            }

            if ($checkpointCaptured) {
                RotationState::save(
                    $stateDir, $channelId, $blockId, $pin['version'],
                    $checkpointCursor, $checkpointDeferred, $checkpointAltCursor, $checkpointIndex, $checkpointAtToSave,
                );
            }
        }

        // BoundaryResolver is the only place overlap is decided: hard (the default,
        // and the pre-Phase-3 behavior byte-for-byte) refuses any overlap exactly as
        // the old inline check always did; soft/elastic may turn a bounded amount of
        // it into an explicit, reported delay instead. See its header for the full
        // reasoning.
        $resolved = BoundaryResolver::resolve($groups);
        $items = $resolved['items'];
        $warnings = [...$warnings, ...$resolved['warnings']];

        return ['items' => $items, 'warnings' => $warnings, 'episodeSets' => $episodeSets];
    }

    /** @return array{start:int,end:int,id:string,title:string,source:?array,source_url:?string} */
    private static function buildItem(array $episode, int $startAbs, int $durationSeconds): array
    {
        $source = is_array($episode['source'] ?? null) ? $episode['source'] : null;
        // A YouTube episode's source.url IS already the human-readable watch
        // page, so it's always both the right attribution link and (via
        // ScheduleWriter's separate, unchanged media_url derivation) never
        // the thing that becomes media_url. A directly-hosted (html5)
        // episode's source.url is the actual playable media file -- the
        // right thing for media_url, but the wrong thing to show as "the
        // source" (e.g. an archive.org .mp4 download link instead of its
        // /details/ page). source.page_url (optional; see
        // ia-import/src/IaSeriesBuilder.php) is exactly that distinct
        // human-readable link when a provider needs one; falling back to
        // source.url when absent keeps every existing episode (which never
        // sets page_url) byte-for-byte unchanged.
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
