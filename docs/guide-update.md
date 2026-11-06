# Program-level channel guide (EPG)

Status: implemented, on `feature/program-level-epg`.

This document explains how CRVideo's channel guide renders one cell per
*scheduled program occurrence* (e.g. a one-hour "Electronics Lab" block)
rather than one cell per individual video/episode, the schema extension
that makes that possible, and what is and isn't covered yet.

## The problem

`channels/publish.php` compiles a channel's `programming.json` (recurring
series "blocks", with rotation/packing/boundary rules) into a flat
`schedule.json` of individual playable occurrences -- see
`channels/publish/README.md`. The frontend guide (`channels/index.html`)
rendered one `.prog` cell per entry returned by `airings()`, which is one
entry per flat item. A packed hour containing five videos therefore
rendered as five narrow cells instead of one hour-long "Electronics Lab"
cell -- a video-playlist view, not a television guide.

## Chosen representation (Phase 2/3)

The smallest backward-compatible extension to the existing schema:

1. **`programming.json` blocks may carry editorial `title`/`description`**
   (see the worked example in `channels/publish/README.md`), distinct
   from any individual episode's own title/description. If a block
   doesn't set one, `ProgrammingCompiler::resolveProgramTitle()` resolves
   a title via: explicit block title -> associated series' title -> the
   title this exact block was last published with (read from the
   channel's existing `schedule.json` before it's overwritten, so a
   title doesn't flicker release to release) -> the first scheduled
   episode's own title, as a legacy last resort. `resolveProgramDescription()`
   is the same chain minus the episode fallback (a program's description
   must never silently become an individual video's description).

2. **`schedule.json` gets one new top-level array, `"programs"`** -- one
   entry per scheduled occurrence, carrying the resolved title/
   description, `block_id`, `series_id`/`series_title`, `boundary_mode`,
   and both its **nominal** window (`nominal_start`/`nominal_end`, before
   any boundary delay -- the slot `programming.json` describes) and its
   **effective** window (`start`/`end` -- the nominal window shifted by
   whatever delay `BoundaryResolver` actually absorbed; identical to
   nominal for a hard-boundaried block, since its delay is always 0).
   Entirely omitted when a channel has no occurrences at all (e.g. no
   `programming.json`), so it's indistinguishable from any schedule.json
   written before this feature existed.

3. **Every item gets a compact `program_id`** referencing a `programs[]`
   entry's `occurrence_id`. `occurrence_id` is `"<blockId>@<nominal start,
   Unix seconds>"` -- explicit and stable, never re-derived from titles or
   adjacency, and guaranteed distinct for two different occurrences of
   the same block (an AM and a PM showing of the same series, or the same
   daily block on two different days never collide).

This was chosen over the alternative (duplicating full program metadata
onto every item) because it keeps `schedule.json`'s dominant cost -- the
flat item list, which is what the player actually reads every tick --
exactly as small as before, with one small reference per item and the
shared metadata stored once.

### Why identity has to be explicit

Two consecutive occurrences of the same `series_id`/title must never be
treated as one program just because they're adjacent or look alike (an
AM and a PM showing of "Electronics Lab" are different scheduled
instances). `occurrence_id`'s `<blockId>@<nominalStart>` makes every
occurrence's identity a fact already decided at compile time, not
something the guide has to infer later from timestamps or strings.

### Continuity fillers and genuinely unfilled time

A programming block's own trailing under-filled remainder (packing's
`minimum_remaining` deferred the next episode) must stay part of that
program's presentation, whether it's covered by an actual continuity
filler (`ContinuityFiller`, tagged the same way) or, for a channel with
no `continuity.json` at all, a plain `"gap"` item `ScheduleWriter` itself
writes. Both get the enclosing program's `program_id` -- but only for
the portion that's actually inside that program's effective window.
`ScheduleWriter::writeSchedule()` splits a single raw gap at a program's
own end when it straddles both that remainder and further genuinely-
unscheduled time beyond it (e.g. the last program in a published
window), so a true inter-program station break is never mislabeled as
part of either neighbor, and the program's own cell and a station-break
cell never end up describing overlapping time.

## The frontend projection (Phase 4/5/6)

`channels/broadcast.js` gains `buildEpgTimeline(schedule, anchor)`, a
pure function alongside the existing playback-facing `buildTimeline()`:
same raw input, same absolute-cycle-position math, but items sharing a
`program_id` that resolves against `schedule.json`'s `"programs"` are
folded into one guide entry (type `"program"`, with an ordered
`episodes` array) instead of each becoming their own. Anything without a
resolvable `program_id` -- a legacy schedule with no programming-block
identity at all, or a genuine station break -- passes through exactly as
`buildTimeline()` always produced it. Both timelines share the same
`{start,end,playable,...}` entry shape, so the existing `locate()`/
`airings()` functions work completely unchanged over either one.

`channels/index.html`'s guide now iterates `channel.epgTimeline` instead
of `channel.timeline` for its grid; `channel.timeline` (built the same
way as always) still drives the live preview player and `watch.html` --
**the playback timeline and its construction are completely untouched**.

Selecting a future program opens the existing detail-card UI (never
tunes the channel) showing the program's title/description, channel
name/number, scheduled start/end and total duration, series/publisher,
a thumbnail from its first episode's catalog entry, which underlying
episode is airing right now (via `episodeAiringTimes()`, resolving an
episode's absolute time from the program airing it belongs to), and the
ordered list of every actual video/filler scheduled within it. A legacy
airing (no programming-block identity) still renders through the
original single-episode detail card.

## Compatibility and limitations

- **No channel is required to migrate.** A channel with no
  `programming.json` (Film Day at School, or any future Internet-
  Archive-direct channel) produces a `schedule.json` with no `"programs"`
  key at all; `buildEpgTimeline()` then behaves exactly like
  `buildTimeline()`, one guide cell per raw item, unchanged.
- **Previously-published-title fallback is best-effort.** It only sees
  whatever `schedule.json` already existed before an overwrite; a
  channel's very first publish, or one whose schedule predates this
  feature, simply has nothing there and falls through to the next tier.
- **A standalone short program is never merged with its neighbor**, even
  when its guide cell is narrow -- by design (Phase 5); legibility for
  genuinely short programs relies on the cell's native tooltip and the
  detail view, not on widening the whole timeline.
- **`CatalogResolver.php`'s series `description` field** (added so a
  block can fall back to its series' description) is a hand-maintained
  PHP-side addition; `catalog-resolver.js`'s JS-side `resolveCatalog()`
  already returned this field for its own, unrelated purposes, so no
  change was needed there.

## Where to look

- `channels/publish/src/ProgrammingCompiler.php` -- title/description
  resolution, `occurrence_id` assignment.
- `channels/publish/src/BoundaryResolver.php` -- emits the `"programs"`
  collection and stamps `program_id`, using each occurrence's *effective*
  (post-delay) window.
- `channels/publish/src/ContinuityFiller.php` -- attributes in-block
  filler to its owning program.
- `channels/publish/src/ScheduleWriter.php` -- writes `"programs"` and
  per-item `program_id`; splits a gap at a program boundary.
- `channels/broadcast.js` -- `buildEpgTimeline()`, `episodeAiringTimes()`.
- `channels/index.html` -- guide rendering, `renderProgramDetail()`/
  `renderEpisodeDetail()`.
- `channels/publish/README.md` -- the full `programming.json` schema,
  including `title`/`description` and the `"programs"`/`program_id`
  output.
- Tests: `channels/publish/tests/{ProgrammingCompiler,BoundaryResolver,
  ContinuityFiller,ScheduleWriter}Test.php`,
  `channels/tests/epg-timeline.test.js`,
  `channels/tests/published-schedule-programs.test.js`.
