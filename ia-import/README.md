# ia-import

A standalone PHP command-line tool that imports an Internet Archive
user-created list, fetches metadata for each item, resolves one playable
file + duration per film, and builds an optimized fixed-block programming
schedule plus a reusable media catalog.

No framework, no Composer, no external PHP dependencies -- plain PHP 8.2+,
manually `require`d, in the same style as this repo's `server/*.php`
scripts. The only optional external dependency is `ffprobe`, used nowhere
in the current implementation (see "Known limitations" below).

It is deliberately self-contained (its own `src/`, its own test runner) so
it can be dropped into CRVideo's channel-management system later without
having pulled in anything that would conflict with the rest of the app.
**It does not touch `scheduler/`, `server/`, `playlist.json`,
`sync-player.html`, `schedule.html`, or `cache/`** -- it is a new, separate
tool living entirely under `ia-import/`.

## Quick start

```sh
php ia-import.php my-list.json
php ia-import.php my-list.json --slot=15
php ia-import.php my-list.json --slot=60 --strategy=best-fit --verbose
```

This reads `my-list.json` (see "Input format" below), fetches metadata for
every member from `https://archive.org/metadata/{identifier}`, caches it
locally, and writes `catalog.json` + `schedule.json` in the current
directory, plus a human-readable report on stdout.

### Fetching a real list

This tool imports from a *local JSON file* -- it never fetches the list
itself, only per-item metadata. An IA list page (e.g.
`https://archive.org/details/@someuser/lists/1/some-list-name`) is a JS
app with no visible "export" button, but the JSON it renders from is
public at a predictable URL: swap `details` for `services/users` and drop
the trailing slug, i.e.

```text
https://archive.org/details/@someuser/lists/<id>/<slug>
                          ↓
https://archive.org/services/users/@someuser/lists/<id>
```

```sh
curl -s "https://archive.org/services/users/@someuser/lists/1" -o my-list.json
php ia-import.php my-list.json --slot=30
```

This only works for a public list (`is_private: false`); a private list
needs the owner's logged-in session cookies, which this tool does not
handle.

### Running without live network access

Every HTTP fetch in `ArchiveMetadataClient` goes through an injectable
transport closure. Two ways to exercise the whole pipeline with zero live
network calls:

1. **`--fixtures=DIR`** -- the CLI flag. Points at a directory of
   `{identifier}.json` files (sanitized the same way cache filenames are),
   each containing exactly the raw archive.org `/metadata/{id}` response
   body. See `tests/fixtures/metadata/` for examples, and
   `tests/CliEndToEndTest.php` for how it's invoked.
2. **Pre-seed `--cache-dir`** -- write files shaped like
   `MetadataCache::set()` produces (`{"identifier":...,"fetched_at":...,"raw":{...}}`)
   into a cache directory, then run without `--refresh`.

(1) is simpler and is what the test suite and the demo below use.

## CLI options

```
--output=PATH          Output schedule JSON (default: schedule.json)
--catalog=PATH         Output reusable media catalog (default: catalog.json)
--slot=MINUTES         Scheduling block length: 15, 30, 60 (default: 30)
--strategy=NAME        sequential, best-fit, balanced (default: balanced)
--tolerance=SECONDS    Maximum acceptable unused slot time (default: 0)
--filler=PATH          Optional JSON library of filler clips
--preserve-order       Shorthand for --strategy=sequential (if --strategy wasn't also given)
--max-shift=N          Maximum positional shift from original order (soft constraint; violations reported)
--cache-dir=PATH       Local metadata cache (default: .cache/internet-archive)
--refresh              Ignore cached metadata
--concurrency=N        Concurrent metadata requests via curl_multi (default: 4)
--timeout=SECONDS      Request timeout (default: 15)
--dry-run              Analyze without writing outputs
--verbose              Detailed logging + block-by-block report
--allow-other-formats  Allow non-MP4 browser-playable formats (ogv/webm)
--oversized=POLICY     overflow (default), exclude, or split (rejected -- not implemented)
--budget=N             Optimizer local-search iteration budget
--filler-window=N      Recent-filler avoidance window (default: 5)
--fixtures=DIR         Serve metadata from DIR/{identifier}.json instead of the network
--help                 Display usage
```

## Input format

```json
{
  "success": true,
  "value": {
    "list_name": "Film Day at School",
    "description": "Vintage educational films",
    "is_private": false,
    "id": 1,
    "date_created": "2026-10-28T16:08:14Z",
    "members": [
      { "identifier": "0771_Duck_and_Cover_12_33_20_12", "member_id": 1, "date_added": "2026-10-28T16:08:15Z" }
    ]
  }
}
```

The file is only ever read, never written back to. Malformed members
(missing/empty `identifier`) are skipped with a warning, not fatal.
Repeated identifiers in `members` are preserved as separate entries (two
plays of the same film are two scheduled programs, not a collapsed one) --
`MediaCatalog` disambiguates their catalog ids as `{identifier}@2`,
`{identifier}@3`, etc. when a duplicate is detected.

## Output: catalog.json

One row per *logical video* (not per list member -- an item with two
distinct video parts produces two rows, `{id}#1` / `{id}#2`). Source list
order is always preserved, independent of how the schedule reorders
things.

```json
{
  "schema_version": 1,
  "source": "internet_archive",
  "list_name": "Film Day at School",
  "description": "Vintage educational films",
  "items": [
    {
      "id": "0771_Duck_and_Cover_12_33_20_12",
      "identifier": "0771_Duck_and_Cover_12_33_20_12",
      "member_id": 1,
      "original_position": 1,
      "part_index": 1,
      "part_count": 1,
      "title": "Duck and Cover",
      "duration": 754.5,
      "duration_source": "file_length",
      "year": 1951,
      "creator": null,
      "description": "...",
      "subjects": ["Civil Defense"],
      "collections": ["prelinger"],
      "source_url": "https://archive.org/details/0771_Duck_and_Cover_12_33_20_12",
      "media_url": "https://archive.org/download/0771_Duck_and_Cover_12_33_20_12/0771_Duck_and_Cover_12_33_20_12.mp4",
      "thumbnail_url": "https://archive.org/services/img/0771_Duck_and_Cover_12_33_20_12",
      "selected_file": "0771_Duck_and_Cover_12_33_20_12.mp4",
      "format": "h.264",
      "license": null,
      "status": "ready",
      "warnings": []
    }
  ]
}
```

`status` is one of `ready`, `unknown_duration`, `unavailable`, or `error`.
`duration` is `null`, never fabricated, for anything but `ready`.
`license` is surfaced plainly and left `null` when unknown -- **this tool
never assumes an item is public domain or redistributable.**

## Output: schedule.json

```json
{
  "schema_version": 1,
  "channel": "Film Day at School",
  "slot_duration": 1800,
  "strategy": "balanced",
  "blocks": [
    {
      "block": 1,
      "type": "normal",
      "duration": 1800,
      "used": 1765,
      "remaining": 35,
      "relative_start": 0,
      "items": [
        { "type": "video", "id": "example-film-1", "start": 0, "duration": 750, "title": "...", "media_url": "...", "source_url": "..." },
        { "type": "filler", "id": "station-id-01", "start": 1750, "duration": 10 },
        { "type": "gap", "start": 1760, "duration": 40 }
      ]
    }
  ]
}
```

- `type: "normal"` blocks are exactly `slot_duration` seconds.
  `type: "overflow"` blocks hold exactly one oversized film and are sized
  to that film's duration (see "Oversized films" below).
- `start`/`duration` on each item are **relative seconds within the
  block**. `relative_start` on the block itself is `(block - 1) *
  slot_duration` -- the documented extension point for converting to
  absolute times later (see `ScheduleExporter::absoluteBlockStart()`,
  which takes a cycle-start `DateTimeImmutable` and returns the absolute
  UTC instant for any block/offset pair). No CLI flag emits absolute times
  today; the data model doesn't need one to add it later, and nothing
  here precludes a future version storing a per-block `slot_duration` to
  support mixed-length blocks.
- `gap` events are the **only** way empty time is ever represented --
  nothing synthesizes blank video media.

## Scheduling strategies

- **`sequential`** -- fills blocks in original list order, closing a block
  as soon as the next item wouldn't fit. Baseline for comparison; always
  has movement = 0.
- **`best-fit`** -- best-fit-decreasing bin packing, then a bounded
  deterministic local search. See "How local search actually reduces
  gaps" below.
- **`balanced`** (default) -- starts from the `sequential` arrangement (to
  retain as much original order as possible), then applies the same
  gap-closing consolidation pass, then a weighted local search trading off
  unused time, "variety" (shared creator/subject/collection, or two very
  short films back to back in one block), and how far an item has drifted
  from its sequential position. `--max-shift` gates swaps during the
  weighted phase; violations that still occur (from the initial
  consolidation step, which is not itself shift-limited -- see "Known
  limitations") are reported explicitly, never silently dropped.

### How local search actually reduces gaps

A useful thing to understand about this implementation: swapping one item
for another between two blocks **never changes the combined used time of
that pair** (and so never reduces total unused time) unless a block empties
out completely. Total unused time across a fixed number of blocks is just
`block_count * slot_duration - total_content_duration` -- a constant until
a block disappears. So both `best-fit` and `balanced` run a
**consolidation pass** (`ScheduleOptimizer::consolidateBins()`) that
repeatedly tries to empty out the least-full remaining block by
redistributing all of its items into other blocks, dropping the block
entirely when it succeeds. That's what actually closes gaps; the
subsequent swap-based local search only refines *which* items end up
together (useful for the balanced strategy's variety/movement scoring),
not how many blocks exist.

### Oversized films

A film longer than the slot is **never discarded or cut**. Policy via
`--oversized=`:

- `overflow` (default) -- a dedicated block, `"type": "overflow"`, sized
  exactly to the film's duration.
- `exclude` -- removed from the optimized schedule, kept in the
  unscheduled list (reason `oversized_excluded`).
- `split` -- reserved for a future "break into multiple blocks" mode.
  **Not implemented.** Passing it is a hard CLI error, not a silent
  fallback.

### Determinism

No randomness anywhere in the pipeline (not even for temp filenames, which
use a static counter instead of `mt_rand`). Every local search iterates
blocks/items in a fixed, sorted order. The same input file + the same
options always produce byte-identical `catalog.json`/`schedule.json`
(aside from the `generated_at` timestamp). See
`tests/ScheduleOptimizerTest::testDeterministicOutputForSameInputAndSettings`
and `tests/CliEndToEndTest::testDeterministicAcrossRepeatedRuns`.

## Filler clips

`--filler=PATH` points at a JSON file: either `{"clips": [...]}` or a bare
array of `{"id", "title", "duration"}`. After the main schedule is built,
`FillerSelector` greedily closes each block's remaining gap with filler
clips (duration never fabricated, never exceeding the gap), preferring
variety and avoiding an immediate repeat of the clip just used when an
equally-good alternative fits. Whatever time filler genuinely can't cover
is left as an explicit `gap` event, same as when no filler library is
given at all.

## Reusing the scheduling engine elsewhere

`ScheduleOptimizer` and `FillerSelector` (`src/ScheduleOptimizer.php`,
`src/FillerSelector.php`) know nothing about Internet Archive. They operate
on plain arrays with at least `id` (string), `duration` (float seconds or
`null`), and `original_position` (number, used only for ordering/tie-
breaks) -- `balanced` optionally reads `subjects`/`collections`/`creator`
hints for its variety scoring. `MediaCatalog::toSchedulerItems()` is the
one-line adapter from an IA catalog to this generic shape. This is what the
task spec means by "structured so its functionality can later be
integrated into CRVideo's channel management system" -- the same two
classes should drop straight into a non-IA playlist/channel scheduler.

## Testing

No PHPUnit, no Composer -- a small self-contained runner
(`tests/run-tests.php`) that discovers `tests/*Test.php`, instantiates each
class, and calls every `public function test...()`. Assertions
(`Assert::same`, `Assert::true`, etc., in the runner itself) throw on
failure; the runner prints `PASS`/`FAIL` per test and exits non-zero if
anything failed.

```sh
php ia-import/tests/run-tests.php            # run everything
php ia-import/tests/run-tests.php Optimizer  # filter by substring
```

Coverage includes: list parsing (valid/invalid/missing members/duplicate
identifiers/malformed entries), duration parsing (all documented formats),
the metadata cache (hit/miss/expiry/atomic writes/path-escape
sanitization), the metadata client (injected transport, simulated network
failures, stale-cache fallback, cache bypass via `--refresh`), media
resolution (single/multi-encoding collapse, genuinely ambiguous multi-part
items, missing license/duration warnings), the optimizer (every strategy,
oversized policies, the `split`-is-rejected guard, determinism, "no block
ever exceeds its slot," "no item ever dropped or duplicated," and a
synthetic case proving `sequential` leaves a materially larger gap than
`best-fit`/`balanced` on the same input), filler selection, and a full CLI
end-to-end run via `--fixtures` (including writing real output files and
diffing two independent runs for determinism).

`tests/fixtures/film-day.json` + `tests/fixtures/metadata/*.json` are a
synthetic IA list and mocked `/metadata/{id}` responses covering: a clean
single-encoding film, multiple encodings of one film, two genuinely
distinct video parts, a genuinely ambiguous multi-file item, missing
duration, missing license, an oversized film, an item with no playable
file, a duplicate identifier, a malformed member, and an identifier with no
matching fixture (simulating a fetch failure). `tests/fixtures/filler.json`
is a small filler library.

## Verified against the real API

This was also run against the live `https://archive.org/metadata/...`
endpoint (no `--fixtures`, no `--cache-dir` pre-seeding) for
`0771_Duck_and_Cover_12_33_20_12`, `Conquerb1943`, and a deliberately
nonexistent identifier, and produced a correct report (3 fetched, 1
flagged `unavailable` with no playable file, durations and media URLs
matching the real file listing, license surfaced as unknown where IA's
response didn't include one). That confirmed two things worth noting for
future maintenance:

- A nonexistent IA identifier returns **HTTP 200 with an essentially empty
  metadata object**, not a 404 or an `"error"` key -- `ArchiveMetadataClient`
  treats that as a successful fetch, and `MediaResolver` is what correctly
  turns the resulting "no files" item into `status: "unavailable"`.
- Real items commonly have a video "original" (e.g. a `.m4v` master) with
  several derivatives (`.mp4` h.264, `.ogv`, `.mp3` audio-only, `.vtt`
  captions, etc.) all pointing back to it via the `original` field -- which
  is exactly the grouping key `MediaResolver` uses, confirming that
  heuristic against real data, not just the hand-built fixtures.

## Known limitations / deliberate simplifications

Being upfront about what was simplified under time constraints:

- **`ffprobe` probing is not implemented.** The spec allows it as an
  optional, bounded fallback for duration detection; this implementation
  stops at "item-level runtime when the item has exactly one logical
  video" and otherwise reports `unknown_duration`. It never fabricates a
  duration, which is the hard requirement; it just doesn't have the extra
  fallback tier. `shell_exec('which ffprobe')`-style detection would slot
  into `MediaResolver::resolve()` as an additional duration-source tier.
- **Multi-part vs. ambiguous detection is a naming heuristic**
  (`(part|pt)\d+` / trailing `_\d+`), not content inspection. A genuinely
  ambiguous item is still surfaced as separate catalog entries (never
  silently merged into one, never silently duplicated into unrelated
  entries) with an explicit warning asking for manual review, per spec --
  but the heuristic can occasionally flag a real multi-part item as
  "ambiguous" (extra warning noise) or vice versa.
- **`balanced`'s initial consolidation pass is not itself constrained by
  `--max-shift`** (see "How local search actually reduces gaps" above);
  only the subsequent weighted swap phase is. This is documented in code
  (`ScheduleOptimizer::packBalanced()`) and is what makes "retain original
  order" and "don't leave a block almost empty" simultaneously satisfiable
  without unbounded search. Any resulting shift beyond the configured
  limit is still reported via the `[max-shift]` warnings, never hidden.
- **The "variety" and "short films back-to-back" scoring terms are
  evaluated on each block's current (pre-final-sort) item order**, not the
  exact final playback order, as a cheap proxy. Close enough for a local
  search's accept/reject decisions; the final block output is always
  re-sorted by `original_position` for playback regardless.
- **Best-fit-decreasing bin packing, not provably-optimal bin packing.**
  The bounded subset-sum/knapsack pass described in the spec for "filling
  poorly-utilized blocks" is covered by the consolidation pass above
  (which already performs a bounded first-fit redistribution), not a
  separate standalone knapsack solver.
- **No real concurrency benchmark.** `--concurrency` is wired through to a
  real `curl_multi` implementation, exercised against the live API above,
  but the automated test suite only exercises the sequential (injected
  transport) path, since that's what makes the tests network-free.
- **`--oversized=split` is intentionally rejected**, not implemented, per
  spec ("reserved for future use").
