<?php
declare(strict_types=1);

// channels/publish/src/ContinuityFiller.php
//
// Turns every uncovered interval left in BoundaryResolver's final item list
// into gap-free continuity occurrences, using the resolved continuity pool
// (ContinuityResolver) in this priority order:
//
//   1. Additional episodes from the scheduled series: already handled
//      upstream by EpisodePacker, so nothing is left for this class to do.
//   2. Approved short-form filler / station IDs with known durations: a
//      short chain (at most MAX_STATION_IDS_PER_GAP) of real media assets,
//      each picked to minimize what's left (the same deterministic best-fit
//      as EpisodePacker's best_fit mode: largest that fits, ties broken by
//      configured order).
//   3. Whatever remains (the WHOLE gap when it's smaller than
//      `defaults.minimum_video_filler`, since station IDs aren't attempted
//      below that) is covered by exactly one dynamic continuity card sized
//      to the remainder. A card needs no prerecorded asset, so it's always
//      available: a gap is never left undefined, and one card per gap keeps
//      a long stretch with no filler assets from becoming hundreds of tiny
//      occurrences.
//
// A channel with no continuity.json (ContinuityResolver returns an empty
// pool) is untouched: fill() returns its input items unchanged, leaving
// plain "gap" blocks.
//
// Station-ID/filler occurrences are ordinary "video" items played through
// Html5PlayerAdapter. A dynamic card is a "continuity" item (kind:
// "continuity"), rendered by ContinuityRenderer; a player without one falls
// back to the station-break slate via broadcast.js's "no provider -> not
// playable" rule.
//
// Program-level EPG (docs/guide-update.md): a filler created to cover a
// programming block's own UNDER-FILLED remainder (e.g. packing's
// minimum_remaining left the last minutes of an hour slot) must stay part of
// that block's guide presentation, not become its own tiny EPG cell. One
// covering a GENUINE gap between unrelated programs (or where nothing is
// scheduled) must not be attributed to either neighbor.
//
// $programs (optional; BoundaryResolver's occurrence list, each with its
// effective, post-delay "start"/"end" window) makes this an explicit-boundary
// decision rather than a guess from adjacency: after filling, every filler
// item whose [start,end) falls entirely within one program's window is
// stamped with that program's occurrence_id, as if EpisodePacker had
// selected it. A filler spanning a boundary (shouldn't happen for a
// hard-boundaried block) or in unscheduled time is left unattributed and
// renders as its own station-break cell.

final class ContinuityFiller
{
    private const MAX_STATION_IDS_PER_GAP = 3;
    private const FALLBACK_CARD_TEMPLATE = 'generic';

    /**
     * @param list<array{start:int,end:int,id:string,title:string,source:?array,source_url:?string}> $items sorted, non-overlapping (BoundaryResolver's output)
     * @param array{assets:list<array<string,mixed>>, cards:list<array<string,mixed>>, defaults:array{preferredCard:?string,minimumVideoFiller:int}} $continuity
     * @param list<array{occurrence_id:string,start:int,end:int}> $programs BoundaryResolver's resolved program occurrences (effective, post-delay windows), for attributing an in-block filler to its owning program. Pass [] for a channel with no programming.json-sourced occurrences.
     * @return array{items: list<array<string,mixed>>, warnings: list<string>}
     */
    public static function fill(array $items, int $windowStartTs, int $windowEndTs, array $continuity, array $programs = []): array
    {
        if (!$continuity['assets'] && !$continuity['cards']) {
            return ['items' => $items, 'warnings' => []]; // no continuity configured for this channel -- opt-out, zero change
        }

        $warnings = [];
        $eligibleAssets = array_values(array_filter($continuity['assets'], static fn (array $a): bool => $a['status'] === 'approved'));

        // A raw gap is filled per PROGRAM-BOUNDARY segment, never as one run
        // straddling where one program's effective window ends and the next
        // begins. Otherwise a single fillGap() covering, say, a packed block's
        // trailing under-fill PLUS the next occurrence's leading reserved span
        // (ProgrammingCompiler's $minimumLeadInSeconds) would produce one card
        // ending past the first program's own `end`: it would fail the strict
        // containment check below, stay unattributed, and overlap both programs'
        // EPG cells (buildEpgTimeline() has no notion of one guide entry owned by
        // two programs). This is ScheduleWriter's `$splitGapByPrograms` idea
        // applied earlier, before the gap becomes a concrete item.
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

        // Attribute any filler this pass created (station-id videos and dynamic
        // cards) to the single program whose effective window fully contains it.
        // Real scheduled episodes already carry their program_id from
        // BoundaryResolver. Programs never overlap, so at most one can match.
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
     * Splits [start,end) into [segStart,segEnd) pairs, cut wherever one
     * program's effective window ends and/or another begins; the same
     * algorithm as ScheduleWriter::writeSchedule()'s `$splitGapByPrograms`. A
     * sub-interval in unscheduled time (outside every program) is returned as
     * its own segment, never merged across a boundary with one inside a
     * program's window.
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
                // Unowned (unscheduled) time: stop at $end or the start of the NEXT
                // program, whichever comes first. A raw gap in unowned territory that
                // extends past a following program's start (routine with
                // $minimumLeadInSeconds: a program's first real item starts a few
                // seconds after its effective window begins) would otherwise swallow
                // the front of that window into an unattributed segment.
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
        // No configured card's [min_duration, max_duration] covers this remainder (or
        // none are configured): the always-available fallback, since a dynamic card
        // needs no prerecorded asset.
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
