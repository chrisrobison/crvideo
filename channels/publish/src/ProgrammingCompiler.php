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
//
// Program-level EPG metadata (docs/guide-update.md): every episode that
// this class schedules is also (via BoundaryResolver) grouped into one
// logical "programming occurrence" -- the thing a traditional cable guide
// would show as a single cell, regardless of how many individual
// episodes got packed into it. Each occurrence gets:
//
//   - occurrence_id: "<blockId>@<nominalStartUnixSeconds>" -- stable and
//     unique per scheduled instant, so an AM and a PM showing of the same
//     series_id (or the same block on two different days) are never
//     confused with each other, and the EPG never has to guess occurrence
//     boundaries from titles or adjacency.
//   - A resolved display title/description (see resolveProgramTitle/
//     resolveProgramDescription below) -- editorial metadata for the
//     guide, distinct from any individual episode's own title/description.
//
// This is computed once per block (title/description resolution) and once
// per occurrence (occurrence_id, nominal timing) here; BoundaryResolver is
// what actually stamps it onto the flattened item list and derives each
// occurrence's EFFECTIVE (post-delay) presentation window -- see its
// header for why that belongs there rather than here.

final class ProgrammingCompiler
{
    /**
     * @param array{blocks?: list<array<string,mixed>>} $programming decoded programming.json
     * @param list<array{id:string,title:string,url:string,episodes:list<array<string,mixed>>}> $resolvedSeries
     *        CatalogResolver::resolveCatalog()'s "series" list for this channel.
     * @param array<string,array{title:?string,description:?string}> $previousPrograms
     *        block_id -> the title/description it was last published with (see
     *        resolveProgramTitle/resolveProgramDescription's fallback tier 3). Pass
     *        [] (the default) when there is no previous schedule.json to consult --
     *        e.g. a channel's first-ever publish, or one not yet migrated to carrying
     *        a "programs" collection at all.
     * @param int $minimumLeadInSeconds reserve this many seconds at the FRONT of every
     *        occurrence (in both the packing and non-packing paths below), deliberately
     *        left unpacked so it stays an ordinary uncovered interval -- which
     *        ContinuityFiller already fills with a continuity card for any gap, and
     *        already folds into the occurrence's own `episodes[]` if that gap falls
     *        inside the program's effective window (it always will here, since the
     *        occurrence's own `nominalStart`/`durationSeconds` -- used to compute that
     *        window in BoundaryResolver -- are deliberately left at the FULL slot,
     *        never shrunk). This is what guarantees a channel-configured minimum "Up
     *        Next" bumper runs before every single program, not just wherever packing
     *        happened to leave a leftover. Default 0 is a byte-for-byte no-op, exactly
     *        like every other opt-in flag in this class (packing.enabled, boundary.mode,
     *        continuity.json itself) -- see channels/publish.php, which resolves
     *        continuity.json's `defaults.minimum_lead_in` BEFORE calling compile() and
     *        passes it here.
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

            // Phase 2/3: editorial program metadata for the guide -- resolved once per
            // block (title/description never vary occurrence to occurrence; only the
            // occurrence_id and timing do). See resolveProgramTitle()'s header for the
            // fallback order.
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

            // See this method's $minimumLeadInSeconds doc above: reserved, never
            // more than the block's own slot (leaving at least 1s nominally for
            // the episode itself -- an episode that still doesn't fit afterward
            // overruns exactly as it already could before this existed, caught
            // by BoundaryResolver's overlap check, same as always).
            $leadIn = min($minimumLeadInSeconds, max(0, $durationSeconds - 1));

            if (!$packingEnabled) {
                // Pre-packing path, unchanged except for $leadIn: exactly one
                // episode per occurrence.
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
                    // nominalStart/durationSeconds below stay the FULL slot (not
                    // shifted by $leadIn) -- see $minimumLeadInSeconds's doc: that's
                    // what keeps the reserved lead-in inside this program's own
                    // effective window instead of becoming its own unattributed gap.
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

                // $leadIn (see this method's $minimumLeadInSeconds doc) is carved off
                // the front: the packer only ever sees $durationSeconds - $leadIn as
                // available, so it never schedules into the reserved span -- but the
                // fallback duration passed below stays the FULL $durationSeconds
                // (unrelated to how much room is actually left; it's just the stand-in
                // "duration" used for an episode whose own is unknown, same as always).
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

        // BoundaryResolver is the only place overlap is decided: hard (the default,
        // and the pre-Phase-3 behavior byte-for-byte) refuses any overlap exactly as
        // the old inline check always did; soft/elastic may turn a bounded amount of
        // it into an explicit, reported delay instead. See its header for the full
        // reasoning.
        $resolved = BoundaryResolver::resolve($groups);
        $items = $resolved['items'];
        $warnings = [...$warnings, ...$resolved['warnings']];

        return ['items' => $items, 'warnings' => $warnings, 'episodeSets' => $episodeSets, 'programs' => $resolved['programs']];
    }

    /**
     * Phase 2 fallback order for a program's guide-facing TITLE:
     *   1. The block's own explicit "title".
     *   2. Its associated series' title.
     *   3. The title this exact block was last published with (so a title that was
     *      itself only ever resolved via tier 4 below doesn't flicker between
     *      different episode titles release to release merely because packing/
     *      rotation picked a different first episode this time).
     *   4. The first scheduled episode's own title (or id) -- a legacy fallback,
     *      never a hard failure. Generating a name directly from the internal
     *      block id is deliberately not in this list: by the time this is called
     *      the occurrence always has at least one item, so tier 4 always resolves.
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
     * Same idea as resolveProgramTitle() for the program's guide-facing
     * DESCRIPTION, except there is no episode-description fallback tier --
     * mixing an individual episode's description into the program's own
     * (editorial, block-level) description would blur exactly the distinction
     * Phase 2 requires ("They must be distinct from the actual video title and
     * description."). Absent everywhere, this is simply null.
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
