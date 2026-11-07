<?php
declare(strict_types=1);

// channels/publish/src/ContinuityFiller.php
//
// Phase 4 of docs/series-and-channels.md: turns every uncovered interval
// left by BoundaryResolver's final item list into real, gap-free
// continuity occurrences, using the resolved continuity pool
// (ContinuityResolver) and this priority order:
//
//   1. Additional episodes from the scheduled series -- already fully
//      handled upstream by EpisodePacker; by the time items reach this
//      class, packing has already used every episode that fits. There
//      is nothing left for this class to do for that tier.
//   2. Approved short-form filler / station IDs with known durations --
//      a short, bounded chain (never more than MAX_STATION_IDS_PER_GAP)
//      of real media assets, each picked to minimize what's left
//      afterward (same deterministic best-fit idea as EpisodePacker's
//      best_fit mode: largest-that-fits, ties broken by configured
//      order).
//   3. Whatever remains after that -- which, for a gap smaller than
//      `defaults.minimum_video_filler`, is the WHOLE gap, since station
//      IDs are not even attempted below that threshold -- is covered by
//      EXACTLY ONE dynamic continuity card sized to the exact remainder.
//      A card never needs a prerecorded asset, so it is always available
//      as the final fallback: a gap is never left undefined, and this
//      class never emits more than one card per gap, which is what keeps
//      a long stretch with no filler assets from turning into hundreds
//      of tiny occurrences.
//
// A channel that references no continuity.json at all (ContinuityResolver
// returns an empty pool) is untouched: fill() returns its input items
// completely unchanged, so every channel published before this phase
// keeps producing plain "gap" blocks exactly as before.
//
// Station-ID/filler occurrences are ordinary "video" items (they play
// through the existing Html5PlayerAdapter, same as any other directly-
// hosted media -- no player change needed for them at all); a dynamic
// card is a new "continuity" item (kind: "continuity"), which needs the
// Phase 5/6 renderer and player adapter to actually display -- until
// those exist, broadcast.js's existing "no provider -> not playable"
// rule already shows it as an ordinary station-break slate, never
// breaking anything.
//
// Program-level EPG (docs/guide-update.md, Phase 7): a filler occurrence
// created here to cover a programming block's own UNDER-FILLED remainder
// (e.g. packing's minimum_remaining left the last few minutes of an hour
// slot unfilled) must stay part of that block's guide presentation, not
// become its own tiny EPG cell. One created to cover a GENUINE gap between
// two unrelated programs (or where there is no program scheduled at all)
// must NOT be attributed to either neighbor -- that would misrepresent
// airtime that was never actually part of either program.
//
// $programs (optional; the BoundaryResolver-resolved occurrence list, each
// with its already-EFFECTIVE, post-delay "start"/"end" presentation
// window) is what makes this an explicit-boundary decision rather than a
// guess from adjacency: after filling, every produced filler item whose
// own [start,end) falls ENTIRELY within one program's window is stamped
// with that program's occurrence_id, exactly as if it had been one of the
// episodes EpisodePacker itself selected. A filler spanning a boundary
// (shouldn't happen for a hard-boundaried block, since packing never
// overflows one) or sitting in genuinely unscheduled time is left
// unattributed -- it renders as its own station-break cell, same as today.

final class ContinuityFiller
{
    private const MAX_STATION_IDS_PER_GAP = 3;
    private const FALLBACK_CARD_TEMPLATE = 'generic';

    /**
     * @param list<array{start:int,end:int,id:string,title:string,source:?array,source_url:?string}> $items sorted, non-overlapping (BoundaryResolver's output)
     * @param array{assets:list<array<string,mixed>>, cards:list<array<string,mixed>>, defaults:array{preferredCard:?string,minimumVideoFiller:int}} $continuity
     * @param list<array{occurrence_id:string,start:int,end:int}> $programs BoundaryResolver's resolved program occurrences (effective, post-delay windows), for attributing an in-block filler to its owning program. Pass [] (the default) for a channel with no programming.json-sourced occurrences at all.
     * @return array{items: list<array<string,mixed>>, warnings: list<string>}
     */
    public static function fill(array $items, int $windowStartTs, int $windowEndTs, array $continuity, array $programs = []): array
    {
        if (!$continuity['assets'] && !$continuity['cards']) {
            return ['items' => $items, 'warnings' => []]; // no continuity configured for this channel -- opt-out, zero change
        }

        $warnings = [];
        $eligibleAssets = array_values(array_filter($continuity['assets'], static fn (array $a): bool => $a['status'] === 'approved'));

        // A raw gap is filled per PROGRAM-BOUNDARY segment, never as one
        // continuous run straddling where one program's effective window ends
        // and the next one's begins. Without this, a single fillGap() call
        // covering, say, a packed block's own trailing under-fill remainder
        // PLUS the next occurrence's leading reserved span (ProgrammingCompiler's
        // $minimumLeadInSeconds -- see its header) would produce one card
        // whose END falls past the first program's own `end`, so it could
        // never satisfy the strict per-program containment check below --
        // leaving it unattributed and, worse, overlapping both programs' EPG
        // cells (buildEpgTimeline() in broadcast.js has no notion of a single
        // guide entry owned by two programs at once). Splitting first is
        // exactly ScheduleWriter::writeSchedule()'s own `$splitGapByPrograms`
        // idea, applied one stage earlier -- before a gap becomes a concrete
        // item at all, rather than after.
        $fillGapByPrograms = function (int $start, int $end) use ($eligibleAssets, $continuity, $programs): array {
            $out = [];
            foreach (self::splitByProgramBoundaries($start, $end, $programs) as [$segStart, $segEnd]) {
                foreach (self::fillGap($segStart, $segEnd, $eligibleAssets, $continuity['cards'], $continuity['defaults']) as $fillerItem) {
                    $out[] = $fillerItem;
                }
            }
            return $out;
        };

        $merged = [];
        $cursor = $windowStartTs;
        foreach ($items as $it) {
            if ($it['start'] > $cursor) {
                foreach ($fillGapByPrograms($cursor, $it['start']) as $fillerItem) {
                    $merged[] = $fillerItem;
                }
            }
            $merged[] = $it;
            $cursor = max($cursor, $it['end']);
        }
        if ($windowEndTs > $cursor) {
            foreach ($fillGapByPrograms($cursor, $windowEndTs) as $fillerItem) {
                $merged[] = $fillerItem;
            }
        }

        // next_program_id for every continuity card: the next real "video" item's id, if the window has one.
        for ($i = 0, $n = count($merged); $i < $n; $i++) {
            if (($merged[$i]['kind'] ?? 'video') !== 'continuity') {
                continue;
            }
            $next = null;
            for ($j = $i + 1; $j < $n; $j++) {
                if (($merged[$j]['kind'] ?? 'video') === 'video') {
                    $next = $merged[$j]['id'];
                    break;
                }
            }
            $merged[$i]['next_program_id'] = $next;
        }

        // Phase 7: attribute any filler item this pass just created (both station-id
        // videos and dynamic cards) to the single program whose effective window
        // fully contains it, if any. Items that were already real scheduled episodes
        // already carry their program_id from BoundaryResolver and are left alone.
        // Programs never overlap (BoundaryResolver's whole job), so at most one can
        // ever match.
        if ($programs) {
            foreach ($merged as &$it) {
                if (isset($it['program_id'])) {
                    continue;
                }
                foreach ($programs as $p) {
                    if ($it['start'] >= $p['start'] && $it['end'] <= $p['end']) {
                        $it['program_id'] = $p['occurrence_id'];
                        break;
                    }
                }
            }
            unset($it);
        }

        return ['items' => $merged, 'warnings' => $warnings];
    }

    /**
     * Splits [start,end) into one or more [segStart,segEnd) pairs, cut at
     * every point where one program's effective window ends and/or another
     * begins -- identical in spirit (and, deliberately, in algorithm) to
     * ScheduleWriter::writeSchedule()'s own `$splitGapByPrograms`. A sub-
     * interval that falls in genuinely unscheduled time (outside every
     * program) is still returned as its own segment, just never merged
     * across a boundary with one that falls inside a program's window.
     * @param list<array{occurrence_id:string,start:int,end:int}> $programs
     * @return list<array{0:int,1:int}>
     */
    private static function splitByProgramBoundaries(int $start, int $end, array $programs): array
    {
        if (!$programs) {
            return [[$start, $end]];
        }
        $segments = [];
        $cursor = $start;
        while ($cursor < $end) {
            $owner = null;
            foreach ($programs as $p) {
                if ($cursor >= $p['start'] && $cursor < $p['end']) {
                    $owner = $p;
                    break; // programs never overlap -- at most one can ever match
                }
            }
            if ($owner !== null) {
                $segEnd = min($end, $owner['end']);
            } else {
                // Unowned (genuinely unscheduled) time: stop at whichever comes
                // first, $end or the start of the NEXT program -- never run past
                // where that program's own window begins. Without this, a raw
                // gap landing in unowned territory but extending past a
                // following program's start (exactly what ProgrammingCompiler's
                // $minimumLeadInSeconds now does routinely: a program's own
                // first real item starts a few seconds AFTER its nominal/
                // effective window begins) would swallow the front of that
                // program's window into an unattributed segment instead of
                // stopping at its boundary and letting the next loop iteration
                // pick it up as owned.
                $nextStart = $end;
                foreach ($programs as $p) {
                    if ($p['start'] > $cursor && $p['start'] < $nextStart) {
                        $nextStart = $p['start'];
                    }
                }
                $segEnd = $nextStart;
            }
            $segments[] = [$cursor, $segEnd];
            $cursor = $segEnd;
        }
        return $segments;
    }

    /** @return list<array<string,mixed>> */
    private static function fillGap(int $start, int $end, array $assets, array $cards, array $defaults): array
    {
        $out = [];
        $cursor = $start;
        $remaining = $end - $start;
        if ($remaining <= 0) {
            return $out;
        }

        if ($remaining >= $defaults['minimumVideoFiller'] && $assets) {
            for ($chain = 0; $chain < self::MAX_STATION_IDS_PER_GAP && $remaining > 0; $chain++) {
                $best = null;
                foreach ($assets as $i => $a) {
                    if ($a['duration'] > $remaining) {
                        continue;
                    }
                    if ($best === null || $a['duration'] > $best['duration']) {
                        $best = $a;
                    }
                }
                if ($best === null) {
                    break; // nothing fits (even the smallest asset is bigger than what's left) -- stop the chain
                }
                $out[] = self::videoItem($best, $cursor);
                $cursor += $best['duration'];
                $remaining -= $best['duration'];
            }
        }

        if ($remaining > 0) {
            $card = self::pickCard($remaining, $cards, $defaults['preferredCard']);
            $out[] = self::continuityItem($card, $cursor, $remaining);
        }

        return $out;
    }

    /** @return array{id:string,template:string,minDuration:int,maxDuration:int} */
    private static function pickCard(int $remaining, array $cards, ?string $preferredId): array
    {
        $qualifying = array_values(array_filter(
            $cards,
            static fn (array $c): bool => $remaining >= $c['minDuration'] && $remaining <= $c['maxDuration'],
        ));
        if ($preferredId !== null) {
            foreach ($qualifying as $c) {
                if ($c['id'] === $preferredId) {
                    return $c;
                }
            }
        }
        if ($qualifying) {
            return $qualifying[0]; // first qualifying card in configured order -- deterministic
        }
        // No configured card's [min_duration, max_duration] covers this exact remainder (or
        // none are configured at all) -- the universal, always-available fallback. A dynamic
        // card needs no prerecorded asset, so this never leaves an undefined hole.
        return ['id' => self::FALLBACK_CARD_TEMPLATE, 'template' => self::FALLBACK_CARD_TEMPLATE, 'minDuration' => 0, 'maxDuration' => PHP_INT_MAX];
    }

    /** @return array{kind:string,start:int,end:int,id:string,title:string,source:?array,source_url:?string,continuity_category:string} */
    private static function videoItem(array $asset, int $startAbs): array
    {
        $source = $asset['source'];
        return [
            'kind' => 'video',
            'start' => $startAbs,
            'end' => $startAbs + $asset['duration'],
            'id' => $asset['id'],
            'title' => $asset['title'],
            'source' => $source,
            'source_url' => is_string($source['url'] ?? null) ? $source['url'] : null,
            'continuity_category' => $asset['category'],
        ];
    }

    /** @return array{kind:string,start:int,end:int,id:string,title:?string,template:string,source:null,source_url:null} */
    private static function continuityItem(array $card, int $startAbs, int $durationSeconds): array
    {
        return [
            'kind' => 'continuity',
            'start' => $startAbs,
            'end' => $startAbs + $durationSeconds,
            'id' => 'continuity-' . $startAbs,
            'title' => null,
            'template' => $card['template'],
            'source' => null,
            'source_url' => null,
        ];
    }
}
