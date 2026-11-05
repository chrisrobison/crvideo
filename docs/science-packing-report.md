# Science & Engineering: before/after report (Phase 10)

Both measurements are of the channel's real, compiled 14-day
`schedule.json` -- the "before" column is the window published under the
original one-episode-per-occurrence lineup (`2026-11-04` –
`2026-11-18`); the "after" column is the same real catalog, the same 24
one-hour blocks, republished (`2026-11-05` – `2026-11-19`) after this
project's changes: `packing.enabled` (`mode: "sequential"`,
`on_unfit: "defer"`, `minimum_remaining: 30`) and a `continuity.json`
reference added to every block, plus an explicit `boundary.mode: "hard"`
on every block (see "Why no soft boundaries" below). Nothing else about
the channel changed -- same 12 shows, same catalogs, same two slots a
day per show, same approved-episode sets.

| Metric | Before | After |
|---|---|---|
| Total programmed hours (window length) | 336h (14 days) | 336h (14 days) |
| Actual episode playback hours | 78.0h | 280.1h |
| Number of episode occurrences scheduled | 336 | 2,542 |
| Distinct episodes actually used | 336 | 521 |
| Total unfilled gap time | 258.0h (100% of non-episode time) | **0h** |
| Continuity time | 0h (every non-episode second was an undefined `"gap"`) | 55.9h, as 336 real "Coming Up Next" occurrences |
| Overlapping occurrences | 0 | 0 |
| Unusable episodes (can never fit any configured slot) | n/a | 0 |

Useful-programming share of total airtime: **23.2% -> 83.4%**.

## What actually changed and why

- Every block's catalog (12 real YouTube imports, 50 recent videos each)
  turns out to mix regular videos with YouTube Shorts -- the shortest
  approved episode across the whole catalog is 10 seconds, the median is
  a few hundred, and the single longest is 3,597 seconds (under the
  3,600-second slot). Before packing, each hour-long block aired exactly
  one of these, in sequence, and the rest of the hour -- on average
  about 46 minutes -- was a plain, undefined `"gap"` block. After
  packing, each occurrence plays as many complete episodes, in order, as
  actually fit; nothing is ever truncated.
- The 336 occurrences that would previously have ended in dead air now
  end in a real, compiled `"continuity"` occurrence instead -- a
  dynamically-rendered "Coming Up Next" card (`science-up-next` template,
  `channels/science/continuity.json`), sized to the exact remainder.
  There are no real prerecorded station-id assets for this channel yet,
  so none are referenced (inventing a path to a video that doesn't exist
  was explicitly out of scope for this phase) -- the card alone is
  enough to make every one of those 336 remainders a real, intentional,
  *gap-free* occurrence rather than undefined dead air.
- 521 distinct episodes aired in this window versus 336 before --
  packing's `on_unfit: "defer"` policy means an episode that doesn't fit
  one occurrence simply holds its place (with priority) for the next
  one, so nothing is skipped or lost; the rotation genuinely gets further
  through each show's catalog per unit of real time.

## Why no soft boundaries

The spec asks for "configure hard starts for major schedule boundaries;
allow modest soft starts where useful." Every block in this lineup is
wall-to-wall (the next block's nominal start is always exactly the
previous one's nominal end), so every single boundary is a "major" one
-- `boundary.mode: "hard"` is declared explicitly on all 24 blocks,
matching the lineup's pre-existing (and already correct) behavior.

A **soft** boundary was deliberately not added anywhere in this real
catalog: as the "unusable episodes" row shows, nothing in the approved
set ever actually threatens to overrun its hour (longest approved
episode: 3,597s, under the 3,600s slot), and `packing.on_unfit: "defer"`
never schedules something that doesn't fit in the first place. A soft
boundary configured here would be permanently dormant -- it would never
actually absorb a delay, because there is never a delay to absorb.
Rather than fabricate an overrun scenario this
real data doesn't have, this report says so plainly: the feature exists,
was evaluated against the real catalog, and genuinely isn't needed here
today. (`channels/publish/tests/BoundaryResolverTest.php` and
`ProgrammingCompilerTest.php` exercise soft/elastic delays directly,
against synthetic fixtures built specifically to need them.)

## How to reproduce these numbers

```sh
# "before": the committed schedule.json from the previous publish
# (channels/science/schedule.json as of commit 530ddb0^, before this
# branch's changes) -- or re-run publish.php against programming.json
# with packing/continuity stripped back out.

# "after" (the current channels/science/schedule.json):
php channels/publish.php science --days=14 --window-start=2026-11-05 --window-timezone=America/Los_Angeles --dry-run --verbose
```

The counts above were computed directly from each `schedule.json`'s
`blocks[0].items` (summing `duration` by `type`), not estimated.
