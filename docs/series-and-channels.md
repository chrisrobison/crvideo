# Portable series, catalog inclusion, and recurring programming

This doc ties together the pieces built across four phases of work so a
future maintainer doesn't have to reconstruct the design from four sets
of commit messages:

- **`series/<id>/series.json`** -- a show's metadata and episode list,
  written once, reusable across channels.
- **`channels/<id>/catalog.json`** -- a channel's media/series references
  (`channels/catalog-resolver.js` resolves it in the browser).
- **`youtube-import/`** -- imports a YouTube channel/playlist into a
  `series.json` (see `youtube-import/README.md` for CLI usage).
- **`channels/player-adapters.js`** -- plays an episode regardless of
  whether it's a directly-hosted file or a YouTube video.
- **`channels/publish.php`** -- compiles recurring-series programming
  into the plain `schedule.json` the player already knows how to read
  (see `channels/publish/README.md` for CLI usage).

Everything here is additive to the pre-existing architecture (a channel
folder with `meta.json`/`catalog.json`/`schedule.json`, a wall-clock-
anchored repeating cycle, `ia-import` producing IA-sourced channels like
`film-day-at-school`). None of that changed; this doc only covers what
was added on top of it.

## The `series.json` schema

```json
{
  "schema_version": 1,
  "id": "technology-connections",
  "title": "Technology Connections",
  "description": "Technology, engineering, and the everyday inventions behind them.",
  "creator": null,
  "year": null,
  "thumbnail_url": null,
  "logo_url": null,
  "source": {
    "provider": "youtube",
    "channel_id": "UCy0tKL1T7wFoYcxCe0xjN6Q",
    "channel_url": "https://www.youtube.com/channel/UCy0tKL1T7wFoYcxCe0xjN6Q"
  },
  "rotation": { "mode": "sequential", "loop": true },
  "episodes": [
    {
      "id": "yt-VIDEO_ID",
      "episode_number": 1,
      "title": "...",
      "description": "...",
      "duration": 1350.0,
      "year": 2023,
      "published_at": "2023-05-01T00:00:00Z",
      "thumbnail_url": "https://...",
      "guests": [],
      "source": {
        "provider": "youtube", "video_id": "VIDEO_ID",
        "url": "https://www.youtube.com/watch?v=VIDEO_ID",
        "channel_id": "...", "channel_title": "...",
        "kind": "upload", "embeddable": true, "made_for_kids": false,
        "privacy_status": "public", "availability": "available", "availability_detail": null
      },
      "status": "candidate",
      "rights": { "status": "unverified", "notes": null }
    }
  ]
}
```

A series file holds **content metadata and default episode order --
never absolute broadcast timestamps.** When/how an episode actually airs
is entirely the job of a channel's `programming.json` + `publish.php`
(see below); a series is just "the show," reusable by any number of
channels or programming blocks without duplicating its metadata.

Episode ids are stable and collision-resistant by construction: a
YouTube-sourced episode's id is always `"yt-<video_id>"`, and when a
`catalog.json` merges a series' episodes into its id→item map (see
below), the effective key becomes `"<seriesId>:<episodeId>"` -- so two
different series can never collide even if they happen to reuse an
episode id internally.

Episodes are authored/maintained by:

- **`youtube-import.php`** writing/refreshing them from the real API
  (see `youtube-import/README.md`), or
- **by hand**, for a directly-hosted or Internet-Archive-style episode
  (give it a `source.provider` other than `"youtube"` -- see "Provider
  selection" below), or
- by any future importer for another provider -- the schema doesn't
  assume YouTube; `source.provider` is exactly the extension point.

### Editorial status and content rights

Two independent fields, both per-episode:

| Field | Values | Meaning |
|---|---|---|
| `status` | `candidate`, `approved`, `rejected`, `disabled` | editorial review state |
| `rights.status` | `unverified`, `creator_permission`, `licensed`, `public_domain`, `restricted` | content licensing |

- **`status`**: `candidate` is what every importer writes and the only
  thing it ever writes for a new episode -- never `approved`. Only
  `approved` episodes are eligible for `publish.php`'s recurring-series
  rotation; `candidate`/`rejected`/`disabled` are simply skipped (not
  removed from the file). `rejected` is permanent ("reviewed and
  declined"); `disabled` is for a previously-approved episode
  temporarily pulled from rotation without un-approving it for good.
  **This is the approval gate**: importing a public YouTube channel
  populates `series.json` with candidates only, and nothing in this
  codebase ever promotes a candidate to approved automatically. An
  editor (a human, today -- no approval UI is built in this project)
  has to change `status` to `"approved"` by hand before an episode can
  ever be scheduled.
- **`rights.status`**: tracked entirely separately from editorial status,
  and **never inferred** from a video being publicly fetchable or from a
  successful API import -- every importer-written episode gets
  `"unverified"` and nothing else, ever, from that code path. Setting it
  to anything else is a human editorial decision, recorded in `notes` if
  there's a reason worth keeping (e.g. "verbal OK from creator over
  email, 2026-11-02"). Importantly, **`"creator_permission"` here is
  purely bookkeeping about *your* rights situation with the creator -- it
  has no effect whatsoever on playback and does not override YouTube's
  own API terms of service.** The player (see "Provider selection and
  playback" below) always uses the standard, official YouTube embed --
  full branding, full controls, whatever ads YouTube serves -- regardless
  of what `rights.status` says. There is no code path anywhere in this
  project that reads `rights.status` to change playback behavior, and
  there should never be one.
- **Attribution**: `source.channel_title`/`source.channel_url` (or the
  series-level equivalents) and `source.url` (the link back to the
  original video) are written by the importer and preserved verbatim on
  every refresh -- see "which fields a refresh touches" in
  `youtube-import/README.md`. Nothing strips or overwrites attribution.

## A directly-hosted (Internet Archive) series

Every series described above has so far been YouTube-sourced. A series
can equally be built from Internet Archive (or any other directly-hosted)
media -- `ia-import/ia-series-import.php` (new, additive; see
`ia-import/README.md`'s "ia-series-import.php" section) writes the same
`series.json` schema, reusing `ia-import`'s existing metadata-fetching and
media-resolution code (`ArchiveMetadataClient`, `MediaResolver`) rather
than duplicating it. Two schema details that section explains in full:
a directly-hosted episode's `source.provider` is always the literal
string `"html5"` (the only non-`"youtube"` value `channels/broadcast.js`
actually wires to a visible player -- see that file's header), and such
an episode carries **two** URLs (`source.url`, the actual playable media
file; `source.page_url`, the human-readable attribution page) where a
YouTube episode only ever needed one. `channels/publish/src/
ProgrammingCompiler.php` prefers `page_url` for the published
`source_url` when present, falling back to `url` otherwise -- so every
pre-existing (YouTube-only) series compiles identically to before.

## `catalog.json` and series inclusion

```json
{
  "schema_version": 2,
  "title": "Science & Engineering",
  "items": [],
  "series": [
    { "ref": "../../series/technology-connections/series.json" },
    { "ref": "../../series/practical-engineering/series.json" }
  ]
}
```

`items` is the pre-existing flat format (`schema_version` 1 or absent,
one row per piece of media -- what `ia-import` still produces for
`film-day-at-school`, untouched by any of this). `series` is new: a list
of `{"ref": "<relative path>"}` entries, resolved by
`channels/catalog-resolver.js` (in the browser, for the guide/player's
metadata lookups) and mirrored by `channels/publish/src/CatalogResolver.php`
(in PHP, for `publish.php` -- the two **must be kept in lockstep by
hand**; there is no shared runtime, and both files' headers say so).

Resolution rules (identical in both implementations):

- A `ref` must be a relative path; no absolute URL, no protocol-relative
  reference.
- The resolved path must stay within `root`, defined as two directories
  above the `catalog.json` file itself (`channels/<id>/catalog.json` ->
  the directory containing both `channels/` and `series/`) -- this is
  the path-traversal guard.
- Includes are capped at depth 1: a `series.json` may not itself carry a
  `series` field (if it does, it's ignored with a warning, never
  followed).
- Duplicate references (same resolved path listed twice) and colliding
  episode ids are reported, never silently merged or silently dropped.
- A missing file, malformed JSON, or any other single bad reference
  degrades gracefully (reported, that one series is skipped) -- it never
  takes down the rest of the catalog or an unrelated channel.

`channels/catalog-resolver.js` is used by `loadCatalog()` in
`broadcast.js`, so both the channel guide (`index.html`) and the watch
player (`watch.html`) pick this up with no changes of their own --
they've always called `loadCatalog()` for display metadata (year,
creator, description); it now also returns series episodes, indexed as
`"<seriesId>:<episodeId>"`.

## Provider selection and playback

`channels/player-adapters.js` defines a small shared interface:

```js
class PlayerAdapter {
  load(source, offsetSeconds) {}
  play() {}
  pause() {}
  seek(seconds) {}
  getCurrentTime() {}
  getDuration() {}
  setMuted(muted) {}
  isMuted() {}
  destroy() {}
}
```

- **`Html5PlayerAdapter`** wraps a `<video>` element -- the pre-existing
  Internet-Archive-style direct-file playback, unchanged in behavior,
  just extracted into this shape.
- **`YouTubePlayerAdapter`** wraps the official YouTube IFrame Player API
  (loaded once per page from `https://www.youtube.com/iframe_api`,
  YouTube's own CDN). It never hides YouTube's own controls/branding,
  never draws anything over the iframe, and never attempts to suppress
  ads or otherwise manipulate playback -- see the file's header comment
  and `channels/youtube-adapter-demo/` (a hidden, manual-verification-
  only channel) for how to see it working in a real browser.

`BroadcastPlayer` (in `broadcast.js`) owns one instance of each adapter
for the page's lifetime and picks between them **per scheduled
item, using that item's own structured `source.provider` field** --
never by sniffing a URL string. An item with no `source` at all but a
`media_url` resolves to the pre-existing implicit `"html5"` convention
every `ia-import`-produced `schedule.json` already uses, so every
existing schedule file keeps working unchanged. Switching between
programs (same or different provider) only pauses the outgoing adapter
and loads the incoming one -- the YouTube iframe, once created, is never
destroyed/recreated just because a different program is airing.

Retries are bounded (5 attempts, exponential backoff, same formula as
before); a permanent YouTube error (video removed, embedding disabled by
the uploader) skips straight to "no more retries." Once exhausted, that
program just shows a station break until the schedule's own clock
advances to the next one -- which **is** the "fall back to approved
programming" behavior; there's no separate program-substitution logic.

## Recurring programming and publishing

A channel opts into calendar-based recurring programming by adding
`channels/<id>/programming.json` (see `channels/publish/README.md` for
the full format and CLI usage) and running `php channels/publish.php
<id>`, which compiles it -- resolving the channel's declared series,
picking each occurrence's episode via deterministic sequential rotation
over the **approved** episodes only, DST-correct calendar math, no
seconds-based approximation -- into a plain `schedule.json` covering a
forward window of days. The player needs no changes to read it.

A channel can mix this with nothing else (as `channels/science` does
today, with zero approved episodes and so zero occurrences published)
or, in principle, alongside its own hand/`ia-import`-maintained content
-- though no channel currently combines both, so that combination isn't
exercised end to end (see `channels/publish/README.md`'s "Known
limitations").

A block can additionally opt into **multi-episode packing**
(`packing.enabled` in `programming.json`): instead of exactly one
episode per scheduled occurrence, as many pinned episodes as actually
fit the block's `duration` are packed in, back to back, in rotation
order -- never truncated. This is off by default (so every channel
published before this feature, Science & Engineering included, keeps
compiling identically unless it opts in) and needs one more small,
gitignored, per-block state file (`.publish/<channel>.<block>.rotation.json`)
beyond the episode-set pin, to remember where a block's sequential
consumption of pinned episodes currently is across publish runs. A block also picks a `packing.mode`: `"sequential"` (pinned order,
default), `"best_fit"` (minimize leftover time, order doesn't matter),
or `"hybrid"` (prefer the main sequential show, fall back to a bounded,
separately-rotated alternate for filler without disturbing the main
cursor). See `channels/publish/README.md`'s "Multi-episode packing"
section for the full config (`mode`, `minimum_remaining`,
`safety_margin`, `on_unfit`) and `channels/publish/src/EpisodePacker.php`
/ `RotationState.php` for how every mode stays deterministic and
bounded-cost.

A block can also declare a `boundary` (`hard`, the default and the
pre-existing behavior; `soft`, with a required `max_delay`; `elastic`,
for now simplified to behave like `soft`): whether its own nominal start
time can ever be pushed later by an overrunning predecessor, and by how
much. A dedicated `BoundaryResolver` stage resolves every block's
occurrences together, chronologically, after per-block compilation --
see `channels/publish/README.md`'s "Hard and soft start boundaries"
section.

## Dynamic continuity rendering and playback (Phase 5/6)

`channels/continuity-card.js` defines `<cr-continuity-card>`, a
dependency-free Web Component (native custom element, shadow DOM, plain
CSS -- no React, no build step, no prerecorded asset) that renders a
"Coming Up Next" card: channel logo/name, the upcoming program's title/
description/thumbnail (when available), its start time, and a live
countdown. It decides nothing about scheduling -- it only ever formats
whatever `.program`/`.channel` it's given against its own clock function
(`.clockNow`, normally the project's drift-corrected broadcast clock),
recomputed from absolute instants on every tick, which is what makes a
mid-card refresh or a background-tab timer suspension land on the
correct remaining time with no special-case recovery logic needed.
Theming is entirely CSS custom properties with generic defaults; a
specific channel's identity (e.g. Science & Engineering's dark
background, cyan highlights, warm accent) is layered on by the caller
via `meta.json`'s optional `theme` field, never hardcoded in the
component itself.

`channels/player-adapters.js`'s `ContinuityRenderer` mounts/updates/
hides one `<cr-continuity-card>` inside a container element the calling
page owns -- structurally alongside `Html5PlayerAdapter`/
`YouTubePlayerAdapter`, but deliberately not forced through their
`PlayerAdapter` interface, since a card is rendered, never played/
paused/sought. `BroadcastPlayer` (`broadcast.js`) treats a `"continuity"`
airing as a dedicated third case in `switchTo()`: it pauses/hides
whichever adapter was active first (the YouTube iframe's required
presentation is never drawn under anything else), then renders the card
with the real upcoming program's info (via the existing `nextProgram()`
timeline helper) and the continuity occurrence's own exact span. A page
that passes no `continuityContainer` (e.g. the channel guide's small
preview in `index.html`) is completely unaffected -- a continuity airing
simply falls back to the ordinary not-playable station-break slate,
exactly like an unsupported provider already does.

`watch.html` is the first integration: a `#continuityHost` element,
passed as `continuityContainer`, shown/hidden independently of the
pre-existing generic "Up Next" slate (which still handles the plain-gap,
no-program-at-all case exactly as before).

**What's unit-tested vs. what still needs a real browser** (same honesty
standard this project already applies to the YouTube player adapter):
`buildTimeline()`'s continuity field passthrough and the card's pure
`formatCountdown()` helper are covered under `node --test` (no DOM
involved). `<cr-continuity-card>`'s actual shadow-DOM rendering, its
`visibilitychange`-triggered re-render, the pause/hide transition away
from a live YouTube iframe, and the card's layout/animations have no
meaningful behavior without a real browser -- faking enough of the DOM
to exercise them wouldn't prove anything a browser wouldn't prove
better, so they are **not** covered by the automated suite and need
manual/Playwright verification before relying on them in production.

A channel can additionally reference a `continuity.json` (or several --
network-wide and channel-specific, merged, the same portable-reference
shape as `series`) from its `catalog.json`. When it does,
`ContinuityFiller` replaces every remaining gap with real continuity
occurrences -- a short, bounded chain of approved station-id/filler
media, then exactly one dynamically-rendered continuity card for
whatever's left -- instead of a plain `"gap"` block. A channel that
references no `continuity.json` is completely unaffected. See
`channels/publish/README.md`'s "Broadcast continuity and filler"
section for the full schema and `channels/publish/src/
ContinuityResolver.php` / `ContinuityFiller.php` for the resolution and
exact-gap-coverage rules. The dynamic card's actual on-screen rendering
and player integration are a later phase (continuity occurrences compile
correctly today; they render as an ordinary station-break slate in the
existing player until that phase lands).

`continuity.json`'s `defaults.minimum_lead_in` (seconds) goes further
than exact-gap-coverage: `ProgrammingCompiler` reserves that much time
at the front of **every** occurrence it builds, not just wherever
packing happens to leave a leftover, so a continuity card is guaranteed
to run at least that long before every program -- including two
back-to-back programs with no natural gap at all. See `channels/publish/
src/ProgrammingCompiler.php`'s `$minimumLeadInSeconds` doc for exactly
how the reserved span stays inside the program's own effective window
(so it folds into that program's guide cell, never becoming an
unattributed one of its own) at zero cost to every existing, unaffected
code path. 0 (the default) is a byte-for-byte no-op.

A channel can also author an optional `channels/<id>/theme.json`
(resolved client-side by `broadcast.js`'s `loadTheme()`, never at
publish time) describing what its continuity card actually looks like
beyond the plain default "Coming Up Next" info block: a weighted list of
`bumpers`, each pairing a background (`"video-loop"` with a channel-
supplied asset, or a built-in `"canvas"` animation -- see `continuity-
card.js`'s `CANVAS_GENERATORS`, no asset needed at all) with content
(the default up-next info, or a `"quote"` card drawing from a named
`quoteDecks` entry -- an SNL-"Deep Thoughts"-style aside). Which bumper
renders for a given occurrence is picked **deterministically** from its
own absolute `startsAt` (`continuity-card.js`'s `pickWeightedIndex()`),
never `Math.random()` -- the same determinism contract as everything
else here: two viewers tuned to the same occurrence at the same instant
always see the same bumper. No `theme.json` (every channel today)
renders exactly the pre-existing plain card.

## Determinism and schedule publication (Phase 8)

Everything built across these phases shares the same determinism
contract the original recurring-programming design already established
(no unseeded randomness, no viewer-timezone-dependent boundaries, no
`setTimeout()`-as-authoritative-clock), extended to cover the new state:

- **No filler selection at playback time.** `ContinuityFiller` runs
  entirely inside `publish.php`; the browser only ever displays what
  the compiler already decided and formats a countdown from absolute
  instants (`continuity-card.js`) -- it never picks a card or asset
  itself.
- **Stable rotation across publication windows.** `EpisodeSetPin`
  (which episodes/which order) and `RotationState` (where a packing-
  enabled block's cursor/deferred queue currently is) are both small,
  versioned, gitignored state files, not recomputed from scratch on
  every publish -- see `RotationState.php`'s header for exactly how its
  single forward-only checkpoint stays both correct and bounded-cost
  regardless of how long a channel has been running.
- **Never retroactively shifts an already-published occurrence.** A
  compile only ever emits items at or after its own `--window-start`;
  `RotationState`'s checkpoint only ever advances to *that* window's own
  start, never past it, which is exactly what keeps republishing the
  same or a later-starting (overlapping) window idempotent.
- **Stable occurrence ids.** An episode occurrence keeps the episode's
  own stable id; a continuity occurrence's id (`continuity-<its own
  absolute start timestamp>`) is a pure function of when it airs, so
  republishing an unchanged window reproduces the identical id.
- **Timezone/DST-correct throughout.** `Recurrence` (occurrence timing)
  and `BoundaryResolver` (delay arithmetic -- plain elapsed-seconds math
  over already-resolved absolute instants, so it needs no DST-awareness
  of its own) are both covered by explicit spring-forward/fall-back/
  midnight-crossing tests.
- **Backward compatible by construction, not by convention.** Packing,
  boundaries, and continuity are each gated by their own explicit opt-in
  field (`packing.enabled`, a non-`"hard"` `boundary.mode`, a
  `"continuity"` catalog reference); every one of them defaults to
  exactly the pre-existing behavior, which is what the full regression
  suite (232 tests: 124 PHP `publish`, 66 PHP `server`, 42 JS, all
  passing as of this phase) verifies on every change rather than merely
  asserting.

If a schedule genuinely cannot be resolved deterministically and safely
(an impossible hard boundary, a rotation mode this project doesn't
implement, a malformed config), every stage in this pipeline fails the
whole publish with a clear `RuntimeException`/`InvalidArgumentException`
rather than guessing or writing a partial/inconsistent `schedule.json` --
the same "fail safely" posture `ProgrammingCompiler`'s original overlap
check already established, just now shared by `BoundaryResolver` and
`EpisodePacker` too.

## Worked example: adding a channel end to end

Using `channels/science` (Science & Engineering) as the actual, currently
in-progress example in this repo:

1. **Inspect** the existing architecture (`channels/broadcast.js`,
   `channels/channels.php`, an existing channel like
   `channels/film-day-at-school/`) to understand the conventions before
   adding anything -- channel discovery is automatic (any folder under
   `channels/` with a `meta.json` and no `"hidden": true` shows up in the
   guide; no separate list to edit).

2. **Create the channel skeleton**: `channels/science/{meta,catalog,
   schedule}.json`, the last one a minimal valid placeholder (one gap
   block) so the guide/player don't break before there's real
   programming. `catalog.json`'s `series` array references the shows
   this channel intends to air
   (`series/technology-connections/series.json`, etc.) -- these can
   start as structural placeholders (`"episodes": []`, a `_note`
   explaining why) before any real import has happened.

3. **Import** a real show: `php youtube-import.php --channel "@..." \
   --output series/technology-connections/series.json` -- see
   `youtube-import/README.md`. This writes real episodes, every one of
   them `status: "candidate"`. (Or trigger the same import from the
   browser -- see step 4a.)

4. **Review and approve candidates.** Either open `series.json` directly
   and change a candidate's `"status"` to `"approved"` (and
   `rights.status` to whatever's actually true) by hand, or use the
   admin UI's SERIES tab (`scheduler/index.html`, added in a later
   phase -- see `docs/admin-ui.md`), which does exactly that through
   `server/series-admin.php`. Nothing in this project promotes a
   candidate automatically, by design (section 8's approval gate) --
   including that UI, which only ever writes the status an editor
   explicitly picked.
   - **4a.** That same admin UI can also trigger step 3's import (or a
     `--refresh` of an existing series) directly from the browser,
     including a dry-run preview first -- see `docs/admin-ui.md`,
     **and read its "No access control" section before deploying it
     anywhere reachable.**

5. **Add `channels/science/programming.json`** declaring which series
   airs when (daily/weekly/monthly), referencing the now-approved
   episodes implicitly through `series_id` -- by hand, or via the admin
   UI's PROGRAMMING tab (`server/channel-admin.php`), which also offers
   a dry-run preview of `publish.php` before actually running it (next
   step).

6. **Publish**: `php channels/publish.php science` (or the PROGRAMMING
   tab's Publish button). With at least one
   approved episode, this writes real dated occurrences into
   `channels/science/schedule.json`; with zero (the actual current state
   of this repo's `science` channel), it writes nothing wrong -- it
   correctly produces zero occurrences and says so, which is why this
   repo's own `channels/science/schedule.json` is still phase 1's
   placeholder rather than a pointless all-gap rewrite.

7. **Verify in the guide**: open `channels/index.html`, confirm the
   channel appears (or, before step 6 produces real content, confirm it
   still loads and shows a station break rather than erroring) and that
   `watch.html?ch=science` tunes in correctly.

8. **Keep it fresh**: re-run `youtube-import.php --refresh` periodically
   to pick up new uploads (as new candidates -- still gated by step 4),
   and re-run `publish.php` before its forward window runs out (see
   "Forward window / regeneration workflow" in
   `channels/publish/README.md`).

## Maintaining RetroVision, The Lecture Hall, and Maker Channel

Three more channels were built on top of all of the above:
`channels/retrovision` (Internet Archive -- see `ia-import/README.md`'s
"ia-series-import.php" section), `channels/lecture-hall` and
`channels/maker` (YouTube -- ordinary `youtube-import.php`). Each
channel's own `catalog.json`/`programming.json` `_note` field documents
its specific source list and scheduling design decisions in full; this
section only covers the recurring maintenance loop, which is the same
shape for all three (and for `channels/science`):

1. **Refresh a series** to pick up new uploads/re-check availability,
   without touching any hand-set `status`/`rights`/title:
   ```sh
   # YouTube (lecture-hall, maker):
   php youtube-import/youtube-import.php --channel="@Handle" \
     --output=series/<id>/series.json --refresh

   # Internet Archive (retrovision):
   php ia-import/ia-series-import.php --collection=<id> \
     --output=series/<id>/series.json --refresh
   ```
2. **Review new candidates** (every new episode starts
   `status: "candidate"`, `rights.status: "unverified"` -- never
   promoted automatically) and hand-approve the ones that belong in
   rotation, same editorial criteria as the series already documents in
   its own episodes (resolvable/embeddable, on-topic, sane duration).
3. **Republish** that channel's forward window before it runs out (see
   `channels/publish/README.md`'s "Forward window / regeneration
   workflow"):
   ```sh
   php channels/publish.php retrovision --days=14
   php channels/publish.php lecture-hall --days=14
   php channels/publish.php maker --days=14
   ```
   Always run with `--dry-run --verbose` first on an unfamiliar change --
   `publish.php` fails loudly (never silently truncates or fabricates)
   on an unresolvable overlap, and every warning it prints is worth
   reading before trusting a fresh publish.

Each channel's `number` in `meta.json` must stay unique across every
channel folder (`ustv`=1, `film-day-at-school`=2, `science`=3,
`lecture-hall`=4, `retrovision`=5, `maker`=6, at the time of writing) --
there's no shared registry enforcing this, just the convention; check
`channels/*/meta.json` before assigning a new one.

None of these three channels' real-browser/embed playback has been
verified end to end (no browser was available while building them) --
see each channel's git history for the exact, explicit list of what was
and wasn't checked. That's the one piece of the "definition of done"
still genuinely outstanding, same caveat the project already applies to
the YouTube adapter elsewhere in this doc.

### Ideas for future Science & Engineering series (not implemented)

Purely illustrative, not a commitment or a to-do list -- candidates a
future import might cover, beyond the four already stubbed out
(Technology Connections, Practical Engineering, Steve Mould,
ElectroBOOM): plasma physics and high-voltage experiments (e.g. channels
built around Tesla coils/Jacob's ladders), and narrative science-history
shows in the vein of James Burke's *Connections*. None of this is
scheduled, imported, or otherwise acted on anywhere in this codebase.
