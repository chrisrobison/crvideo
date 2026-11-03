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

        $items = [];
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
                $source = is_array($episode['source'] ?? null) ? $episode['source'] : null;

                $items[] = [
                    'start' => $startAbs,
                    'end' => $startAbs + $itemDuration,
                    'id' => $episode['id'],
                    'title' => is_string($episode['title'] ?? null) ? $episode['title'] : $episode['id'],
                    'source' => $source,
                    'source_url' => is_string($source['url'] ?? null) ? $source['url'] : null,
                ];
            }
        }

        usort($items, static fn (array $a, array $b): int => $a['start'] <=> $b['start']);
        for ($i = 1, $count = count($items); $i < $count; $i++) {
            if ($items[$i]['start'] < $items[$i - 1]['end']) {
                throw new RuntimeException(sprintf(
                    'Occurrence "%s" starting %s overlaps the previous occurrence "%s", which runs until %s. '
                    . 'Adjust block durations or recurrence timing -- publish refuses to emit an overlapping schedule.',
                    $items[$i]['id'], gmdate('c', $items[$i]['start']),
                    $items[$i - 1]['id'], gmdate('c', $items[$i - 1]['end']),
                ));
            }
        }

        return ['items' => $items, 'warnings' => $warnings, 'episodeSets' => $episodeSets];
    }
}
