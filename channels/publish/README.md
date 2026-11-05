# channels/publish.php

A standalone PHP command-line tool that compiles a channel's recurring
"series" programming (`channels/<id>/programming.json`) into the
**existing** `schedule.json` format every channel already uses, so the
player (`broadcast.js`, `watch.html`, `index.html`) needs zero changes --
it only ever reads an already-flattened schedule with absolute-timestamp
items, exactly like `film-day-at-school`'s hand/ia-import-maintained one.

```
catalog.json (+ series/*/series.json)  --\
programming.json                           >--  publish.php  -->  schedule.json (+ meta.json's "anchor")
approved-episode-set pin (channels/<id>/.publish/, gitignored)  --/
```

A channel with no `programming.json` is never touched by this tool at
all. `film-day-at-school` keeps using whatever `ia-import` (or a human)
produced for its `schedule.json`, unaffected.

## Quick start

```sh
# Compile the next 14 days (the default) for a channel
php channels/publish.php science

# A specific window, in a specific timezone
php channels/publish.php science --days=30 --window-start=2026-11-02 --window-timezone=America/Los_Angeles

# See what would change without writing anything
php channels/publish.php science --dry-run --verbose

# After approving new episodes and wanting the rotation to include them
# going forward (see "Episode-set stability" below)
php channels/publish.php science --refresh-episode-set
```

Running this **overwrites** `channels/<id>/schedule.json` (atomically,
keeping `schedule.json.bak`) and updates `channels/<id>/meta.json`'s
`"anchor"` field (keeping `meta.json.bak`, every other field preserved).
For a channel that uses `programming.json`, `schedule.json` is a build
artifact from that point on -- the same way `ia-import`'s `schedule.json`
output is -- not something to hand-edit.

## `programming.json` format

```json
{
  "blocks": [
    {
      "id": "technology-hour",
      "type": "series",
      "series_id": "technology-connections",
      "recurrence": {
        "frequency": "daily",
        "time": "13:00",
        "timezone": "America/Los_Angeles"
      },
      "duration": 3600,
      "rotation": { "mode": "sequential", "loop": true, "anchor_date": "2026-11-02" }
    },
    {
      "id": "engineering-weekly",
      "type": "series",
      "series_id": "practical-engineering",
      "recurrence": {
        "frequency": "weekly",
        "weekday": "saturday",
        "time": "10:00",
        "timezone": "America/Los_Angeles"
      },
      "duration": 1800,
      "rotation": { "mode": "sequential", "loop": true, "anchor_date": "2026-11-02" }
    }
  ]
}
```

- `series_id` must be one of the series the channel's own `catalog.json`
  "series" array already references -- publish refuses to schedule a
  series the channel hasn't declared.
- `recurrence.frequency` is `daily` (uses `time`), `weekly` (adds
  `weekday`: `monday`..`sunday`), or `monthly` (adds `day_of_month`: 1-31,
  clamped to the target month's real last day if it doesn't have that
  many days -- e.g. 31 in February lands on the 28th or 29th).
- `rotation.mode` must be `"sequential"` -- the only mode implemented.
  Random rotation isn't built without guaranteed-reproducible seeding,
  per the project's determinism requirement.
- `rotation.loop: false` means the rotation simply has nothing to air
  once it runs past the end of the approved-episode list (or before its
  start) -- that occurrence is left as a station break, not an error.
- The same `series_id` can back more than one block, each with its own
  `anchor_date`/`recurrence` -- the two rotations are entirely
  independent (see `channels/publish/tests/ProgrammingCompilerTest.php`).

## How episode selection works (and why it's deterministic)

`episode_index = occurrence_index mod count(approved_episodes)`, looping
back to episode 0 after the last one. `occurrence_index` is a pure
calendar count -- days/weeks/months since `rotation.anchor_date` -- computed
via real `DateTimeImmutable`/`DateTimeZone` calendar arithmetic, **never**
by multiplying an index by a fixed number of seconds. That's what makes
it correct across a DST transition: the transition shifts an
occurrence's absolute instant by an hour, never which calendar day/week/
month it is, so it never perturbs which episode airs. See
`src/Recurrence.php`'s header comment for the full reasoning, and
`tests/RecurrenceTest.php` for explicit spring-forward/fall-back cases
against this system's real timezone database.

Only episodes with `status: "approved"` are ever eligible. A series with
zero approved episodes produces zero occurrences for its block (every
scheduled instant is left as a gap) -- not an error; see
`channels/science/programming.json` for a real, currently-dormant example
of exactly this (its two referenced series have no approved episodes yet).

### Episode-set stability (`--refresh-episode-set`)

The ordered list of approved episode ids used for a block's rotation is
**pinned** the first time that block is published (to
`channels/<id>/.publish/<channel>.<block-id>.json`, gitignored -- same
operational posture as `ia-import`'s local metadata cache) and reused on
every later run, **even if** series.json's approved-episode list has
since grown or reordered. This is what the spec calls "a stable,
versioned approved episode set, so imports do not unexpectedly shift
episode numbering": approving one more candidate between publishes does
not silently reshuffle which episode airs on every other already-
scheduled occurrence.

Pass `--refresh-episode-set` when you deliberately want a block's
rotation to adopt the current approved list (e.g. after approving a
batch of new episodes) -- this bumps a version number recorded with the
pin, visible in the publish report.

### Slot-vs-episode-duration policy

An episode always plays in full -- its own `duration` from series.json,
falling back to the block's nominal `duration` only when the episode's
own is unknown. If an episode's real length would overlap the next
scheduled occurrence (from this block or any other block in the same
channel), publish **refuses to write anything** with a clear error
rather than truncating content or emitting an overlapping/corrupt
timeline. In practice this essentially never happens at daily/weekly/
monthly cadences with any sane episode length; it exists as a safety net
for misconfiguration.

## Multi-episode packing (`packing`)

```json
{
  "id": "technology-hour",
  "type": "series",
  "series_id": "technology-connections",
  "recurrence": { "frequency": "daily", "time": "14:00", "timezone": "America/Los_Angeles" },
  "duration": 3600,
  "rotation": { "mode": "sequential", "loop": true, "anchor_date": "2026-11-04" },
  "packing": {
    "enabled": true,
    "mode": "sequential",
    "minimum_remaining": 60,
    "safety_margin": 0,
    "on_unfit": "defer",
    "allow_repeat_within_block": false
  }
}
```

Absent or `"enabled": false` (the default): **nothing changes** -- exactly
one episode per occurrence, the pre-existing behavior, byte-for-byte.
This is deliberate: every already-published channel (Science &
Engineering included) keeps compiling identically forever unless a block
explicitly opts in.

When `enabled` is `true`, a single occurrence can be filled with as many
pinned episodes, in rotation order, as actually fit in the block's
`duration` -- an episode is **never truncated**; it either plays in full
or isn't scheduled this occurrence at all. All fields but `enabled` have
sane defaults:

- `mode`:
  - `"sequential"` (default): play episodes in their pinned order,
    fitting as many complete ones as possible. Best for structured/
    episodic series where airing order matters.
  - `"best_fit"`: ignores pinned order -- at each pick, greedily takes
    whichever eligible episode minimizes leftover time (a bounded,
    deterministic search, never exhaustive/combinatorial). Ties break by
    distance from a fairness cursor that rotates forward past whatever
    was just used (so one conveniently-sized episode can't dominate
    every occurrence), then by pinned index. `on_unfit` doesn't apply to
    this mode -- every occurrence already considers every eligible
    episode. Best for collections where order doesn't matter.
  - `"hybrid"`: prefers the main sequential cursor whenever it fits (the
    scheduled show stays recognizable); when it doesn't, makes one
    bounded search through a *separate* alternate rotation
    (`alt_cursor`, its own small piece of persisted state) for filler.
    The main cursor is never disturbed by an alternate pick -- it always
    resumes exactly where it left off -- and the alternate rotation
    itself advances past whatever it used, so repeated filler needs
    don't always reach for the same episode.
- `minimum_remaining` (seconds, default 0): once fitting another episode
  would leave less than this much time afterward (and it isn't the exact
  remainder), stop packing -- leaves a deliberate, continuity-sized gap
  rather than cramming in one more episode right up to the wire.
- `safety_margin` (seconds, default 0): added to an episode's own
  duration only for the purposes of the fit check (not subtracted from
  what's actually used) -- a stricter "does this really fit" cushion.
- `on_unfit` (default `"defer"`, the conservative choice): what happens
  the moment the next episode in rotation doesn't fit the time left in
  this occurrence --
  - `"defer"`: stop packing this occurrence. The rotation cursor is
    deliberately **not** advanced past the unfit episode, which is
    exactly what gives it priority again: the very next occurrence of
    this block tries it first, with a full fresh slot. If an episode is
    longer than the block's own configured `duration`, no occurrence of
    that block will ever fit it -- a clear warning says so by name and
    names the fix (a larger `duration`, or a different `on_unfit`).
  - `"skip_for_block"`: look ahead (bounded by the pinned list's own
    length) for a different pinned episode that *does* fit; every
    episode skipped over to find it -- including the original unfit one
    -- is queued and retried, with priority, at a future occurrence, so
    nothing pinned is ever permanently dropped from rotation just
    because something else filled this slot instead.
  - `"allow_overrun"`: schedule the unfit episode anyway, letting the
    occurrence run long. This is only ever safe because the existing
    hard overlap check (see "Slot-vs-episode-duration policy" above)
    still refuses to publish a schedule where that overrun collides with
    the next occurrence -- the same safety net a single naturally-
    overlong episode always relied on, packing or not.
- `allow_repeat_within_block` (default `false`): whether the *same*
  episode may air twice within one occurrence. Almost never useful with
  a real catalog; exists mainly for a single-episode series paired with
  a long block.

### Rotation state (`channels/<id>/.publish/<channel>.<block>.rotation.json`)

A packing-enabled block needs a little more persisted state than
`EpisodeSetPin` alone provides: not just *which* episodes are eligible,
but *where* a block's sequential consumption of them currently is, now
that a single occurrence can consume more than one. This file (same
gitignored, atomic-write, operator-local posture as the episode-set pin)
holds that rotation cursor and small deferred-episode queue.

It only ever stores one checkpoint -- the state entering the most recent
publish's own window -- not a full history, because every occurrence's
packing is a pure function of the state entering it: replaying forward
from a checkpoint always reproduces the same result. This is what keeps
republishing the same (or a later-starting, overlapping) window
idempotent, and keeps replay cost bounded by how far the window moved
since the last publish rather than by the channel's total lifetime. See
`src/RotationState.php`'s header for the full reasoning, including the
one documented edge case (publishing a window that starts *before* the
last known checkpoint resets rotation state with a clear warning, same
honesty standard as `EpisodeSetPin`'s own documented limitations).

A pin refresh (`--refresh-episode-set`) that changes the pinned list
also resets the matching block's rotation state (a cursor position
computed against one pinned ordering isn't meaningful against another)
-- reported the same way.

## Hard and soft start boundaries (`boundary`)

```json
{
  "id": "evening-news",
  "type": "series",
  "series_id": "local-news",
  "recurrence": { "frequency": "daily", "time": "18:00", "timezone": "America/Los_Angeles" },
  "duration": 1800,
  "rotation": { "mode": "sequential", "loop": true, "anchor_date": "2026-11-04" },
  "boundary": { "mode": "soft", "max_delay": 600 }
}
```

Absent (the default): `"mode": "hard"` -- **nothing changes**: any overlap
with the previous occurrence (from this block or any other block in the
channel) is still a hard publish error, exactly the pre-Phase-3
behavior, byte-for-byte.

- `"hard"`: this occurrence's nominal start can never move. If the
  previous occurrence runs past it, publish refuses to emit anything --
  shorten the preceding block, adjust timing, or give the preceding
  block room via its own boundary.
- `"soft"`: this occurrence may begin up to `max_delay` seconds (a
  required, non-negative number -- there is no unbounded "soft") later
  than its nominal start. A resulting delay is never silently absorbed:
  it is recorded on every item in the occurrence (`delay_seconds`) and
  reported in the publish warnings. An overlap bigger than `max_delay`
  is still a hard publish error.
- `"elastic"`: for now, deliberately simplified to behave exactly like
  `"soft"` (same required `max_delay`) -- full elastic semantics (several
  consecutive blocks sharing one pooled flexible window, rather than one
  block's own tolerance) is intentionally deferred rather than half-
  built. See `src/BoundaryResolver.php`'s header for the reasoning. It
  still, honestly, "never allows unbounded drift" and "respects the next
  hard boundary", because those fall straight out of how it's resolved.

Resolution is a single deterministic, chronological left-to-right walk
across every block's occurrences together (`src/BoundaryResolver.php`):
it never reorders occurrences, never moves one earlier than its nominal
start, and a delay cascades correctly if several soft-boundaried
occurrences are adjacent. It operates purely on the absolute instants
`Recurrence` already resolved, so it needs no DST-awareness of its own
-- "the previous program ran N seconds long" is elapsed-time arithmetic,
not calendar arithmetic, even across a DST transition.

## Broadcast continuity and filler (`continuity.json`)

A channel opts in by adding a `"continuity"` array to its `catalog.json`
(the exact same portable-reference shape as `"series"`, resolved with
the identical path-safety rules):

```json
{
  "schema_version": 2,
  "title": "Science & Engineering",
  "series": [ { "ref": "../../series/technology-connections/series.json" } ],
  "continuity": [
    { "ref": "../../continuity/network/continuity.json" },
    { "ref": "./continuity.json" }
  ]
}
```

Absent entirely (no `"continuity"` array): **nothing changes** -- every
remaining gap is still a plain `{"type":"gap",...}` block, exactly as
before this phase. This is what lets a channel adopt continuity on its
own schedule, with no migration required for anyone else.

`continuity.json` itself:

```json
{
  "schema_version": 1,
  "station_ids": [
    {
      "id": "science-id-15", "title": "Science Station ID",
      "category": "station_id", "duration": 15, "status": "approved",
      "source": { "provider": "direct", "url": "/media/science/id-15.mp4" }
    }
  ],
  "filler": [ /* identical shape -- short-form filler, merged into the same selection pool as station_ids */ ],
  "cards": [
    { "id": "up-next", "template": "up-next", "min_duration": 5, "max_duration": 300 },
    { "id": "station-id", "template": "station-id", "min_duration": 3, "max_duration": 120 }
  ],
  "defaults": { "preferred_card": "up-next", "minimum_video_filler": 10 }
}
```

- `station_ids`/`filler` entries use the exact same editorial gate as
  series.json episodes: `status` must be `"approved"` to ever be
  selected (`"candidate"`/`"rejected"`/`"disabled"` are loaded into the
  pool, reported, but never scheduled).
- `cards` describe a dynamically-rendered continuity card template (no
  media asset needed) and the `[min_duration, max_duration]` range of
  gap sizes it's suitable for.
- `defaults.preferred_card` is used when it qualifies for a given gap's
  size; otherwise the first qualifying card in configured order wins
  (deterministic). A gap no configured card covers (or no cards
  configured at all) falls back to a universal `"generic"` template --
  a dynamic card needs no prerecorded asset, so a gap is **never** left
  undefined.
- Multiple referenced `continuity.json` files merge: asset/card lists
  concatenate (a duplicate id across files is reported, never silently
  merged); `defaults` keys are last-wins across the referenced list in
  `catalog.json`'s own order (so a channel-specific file listed after a
  network-wide one can override just the default it cares about).

### Exact gap coverage (`ContinuityFiller`)

For every interval `ProgrammingCompiler`/`BoundaryResolver` left
uncovered, in this priority order:

1. Additional episodes from the scheduled series -- already fully
   handled upstream by multi-episode packing; there is nothing left for
   this stage to do for that tier by the time it runs.
2. A short, bounded chain (at most 3) of approved station-id/filler
   assets, each picked to minimize what's left afterward (same
   deterministic best-fit idea as `packing.mode=best_fit`) -- skipped
   entirely for a gap smaller than `defaults.minimum_video_filler`.
3. Exactly one dynamic continuity card, sized to whatever's left. A gap
   that no real asset could usefully fill still gets exactly one card
   for the whole thing -- never hundreds of tiny filler occurrences.

A station-id/filler occurrence is an ordinary `"video"` schedule item
(it plays back through the ordinary direct-media path -- no player
change needed for it at all) with a `continuity_category` field for
information. A dynamic card is a new `"continuity"` item type:

```json
{
  "type": "continuity",
  "id": "continuity-1762300800",
  "start": 1800, "duration": 27,
  "template": "up-next",
  "next_program_id": "practical-engineering-episode-42"
}
```

`next_program_id` is the next real scheduled program's id within this
compile's window, or `null` if there isn't one (e.g. the window's own
trailing edge). Until the Phase 5/6 renderer and player adapter exist,
a `"continuity"` item simply displays as the same station-break slate a
plain gap always has (`broadcast.js`'s existing "no provider -> not
playable" rule already covers it) -- nothing breaks by publishing one
early.

## Forward window / regeneration workflow

The published window is fixed-length (`--days`, default 14) and does
**not** extend itself. Once real time passes the window's end, the
player's existing wall-clock-cycle behavior repeats the last published
window on a loop rather than the channel going dark -- but episode
rotation stops advancing while that's happening. **Re-run `publish.php`
again before the window runs out** to produce the next one; running it
with the same (or an overlapping) window is idempotent -- same pinned
episode set, same recurrence math, same output (aside from the
`_publish.generated_at` timestamp).

No daemon or cron job is built by this tool -- set one up yourself if you
want this automatic, e.g.:

```sh
# crontab: republish every night at 03:00, comfortably inside any
# reasonable --days window
0 3 * * * php /path/to/channels/publish.php science >> /var/log/crvideo-publish.log 2>&1
```

To check how much runway a channel's current window has left without
re-running publish:

```sh
php -r '$m = json_decode(file_get_contents("channels/science/schedule.json"), true);
echo $m["_publish"]["window"]["end"], "\n";'
```

If that instant is soon (or already past), republish.

## CLI options

```
--days=N                   Forward window length in days (default: 14)
--window-start=YYYY-MM-DD  Window start date (default: today, in --window-timezone)
--window-timezone=TZ       Timezone the window boundary is computed in (default: UTC)
--refresh-episode-set      Re-snapshot each block's approved-episode list right now
--state-dir=PATH           Where approved-episode-set pins are kept (default: <channel>/.publish/)
--channels-root=PATH       Directory containing channel folders (default: this script's own directory;
                            only ever overridden by the test suite)
--dry-run                  Print the report; write nothing
--verbose                  List every occurrence and warning
--help                     Display usage
```

## Testing

```sh
php channels/publish/tests/run-tests.php            # run everything
php channels/publish/tests/run-tests.php Recurrence # filter by substring
```

Covers: daily/weekly/monthly determinism (including explicit DST spring-
forward/fall-back cases and month-end clamping against this system's real
timezone database), the PHP `CatalogResolver`'s path-safety parity with
`channels/catalog-resolver.js`, approved-episode-set pinning, episode
selection/rotation/loop/overlap policies, multi-episode packing in all
three modes (`sequential`/`best_fit`/`hybrid`; every `on_unfit` policy,
`minimum_remaining`/`safety_margin`, empty/single-episode/all-unavailable
catalogs, rotation stability across adjacent overlapping publish
windows, pin-refresh resets, best-fit's deterministic tie-breaking,
hybrid's main-cursor-never-disturbed guarantee), hard/soft/elastic
boundary resolution (preserved hard anchors, within/exceeding-tolerance
soft delays, cascading adjacent soft blocks, soft-into-hard, DST and
midnight-crossing delay arithmetic), continuity resolution and exact-gap
filling (network-wide/channel-specific merging, editorial gating,
tiny/large/exact-multiple gaps, missing assets, bounded station-id
chains, next-program-id correctness), and a full CLI end-to-
end run (atomic write + backup, idempotent re-publish,
`--refresh-episode-set`, `--dry-run`, error cases) -- all via fixtures, no
real channel ever touched by the test suite.

`channels/tests/published-schedule.test.js` (Node) separately proves the
PHP output and the JS player agree: it loads a real compiled
`schedule.json` through the actual, unmodified
`buildTimeline()`/`locate()` and confirms joining mid-episode resolves
the correct program and the correct offset into it.

## Known limitations

- `CatalogResolver.php` is a hand-maintained PHP mirror of
  `catalog-resolver.js` -- there is no shared runtime between PHP and
  JS, so the two must be kept in lockstep by hand (both files' headers
  cross-reference each other and list exactly which rules must match).
- Episode-set pinning (see above) is pinned at the whole-block level, not
  a per-individual-past-occurrence historical ledger -- refreshing mid-
  window can shift any not-yet-elapsed occurrence in the currently
  published window, which is an accepted, operator-opt-in consequence of
  explicitly passing `--refresh-episode-set`.
- Rotation state (see "Rotation state" above) resets if a publish's
  `--window-start` moves to an occurrence earlier than the last known
  checkpoint -- there is no history before it to replay from. The
  documented forward-rolling workflow (re-publish before the window
  runs out, same or later `--window-start` each time) never hits this.
- One `--window-timezone` governs the window's day-boundary snapping;
  individual blocks can still each use their own `recurrence.timezone`
  independently of it.
