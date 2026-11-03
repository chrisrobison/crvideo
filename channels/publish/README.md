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
selection/rotation/loop/overlap policies, and a full CLI end-to-end run
(atomic write + backup, idempotent re-publish, `--refresh-episode-set`,
`--dry-run`, error cases) -- all via fixtures, no real channel ever
touched by the test suite.

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
- One `--window-timezone` governs the window's day-boundary snapping;
  individual blocks can still each use their own `recurrence.timezone`
  independently of it.
