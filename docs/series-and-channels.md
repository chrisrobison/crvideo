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
consumption of pinned episodes currently is across publish runs. See
`channels/publish/README.md`'s "Multi-episode packing" section for the
full config (`mode`, `minimum_remaining`, `safety_margin`, `on_unfit`)
and `channels/publish/src/EpisodePacker.php` / `RotationState.php` for
how it stays deterministic and bounded-cost.

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

### Ideas for future Science & Engineering series (not implemented)

Purely illustrative, not a commitment or a to-do list -- candidates a
future import might cover, beyond the four already stubbed out
(Technology Connections, Practical Engineering, Steve Mould,
ElectroBOOM): plasma physics and high-voltage experiments (e.g. channels
built around Tesla coils/Jacob's ladders), and narrative science-history
shows in the vein of James Burke's *Connections*. None of this is
scheduled, imported, or otherwise acted on anywhere in this codebase.
