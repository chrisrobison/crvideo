# Admin UI: series review and channel/programming management

The ChannelFlow admin UI (`scheduler/index.html`): a shared top bar
(**Explorer / Series / Programming / Schedule / Bump Studio**) over five
workspaces, backed by PHP endpoints under `server/`. The three editorial
screens follow the "ChannelFlow" revamp mockups:

- **SERIES -- Series Review**: a three-pane workspace (series library |
  episodes of the selected series | episode details with an
  Approve/Reject decision). Review imported episodes and set their
  `status`/`rights` (the approval gate from
  `docs/series-and-channels.md`'s "Editorial status and content rights"),
  in bulk or one at a time; trigger a `youtube-import.php` refresh of an
  existing series, or a brand-new import, from the browser.
- **PROGRAMMING -- Visual Grid**: a channel's recurring programming
  template on a Mon-Sun week grid, with a per-block editor (recurrence,
  duration/timing, rotation, packing, boundary) plus catalog management,
  Preview & publish, and the AI continuity announcer in dialogs.
- **SCHEDULE -- Broadcast Schedule**: the *resolved* `schedule.json` of a
  channel (Day / Week / Rundown), a Scheduled Item inspector, and a
  published-vs-proposed comparison with **Compile Preview** and
  **Publish Schedule...** (see "Broadcast Schedule" below).

The pre-revamp Drive/live-playlist scheduler (`scheduler/js/store.js`) is
unchanged; it is no longer a top-level tab but is still available from the
gear menu in the header, or directly at `scheduler/?view=legacy-schedule`.
Switching views (`scheduler/js/view.js`) only toggles which section of the
page is visible; nothing is unmounted.

## No access control (read this before deploying)

**This admin UI has no login, no API key, no IP restriction -- nothing.**
Anyone who can reach `server/series-admin.php`,
`server/channel-admin.php`, `server/announcer-admin.php` or `server/explorer-admin.php` on the server can, right now, without
authenticating:

- change any episode's editorial status/rights in any series,
- edit any channel's catalog/programming,
- trigger a real `youtube-import.php` call against the YouTube Data API
  (consuming quota, and -- for a brand-new import -- creating a new
  `series/<id>/series.json` file),
- trigger a real `channels/publish.php` run that overwrites a channel's
  `schedule.json`,
- read every series' episode list, editorial status and rights notes through `server/explorer-admin.php`
  (read-only; CRVideo Explorer's endpoint -- it calls the same `admin_require_auth()` hook, so a
  future access check covers it with no other change),
- edit any channel's AI continuity announcer config (including which
  voice/writer/TTS provider it uses), and trigger a real `claude` CLI +
  Kokoro TTS generation run from it (see `channels/announcer/README.md`).

This is a **deliberate, explicit product decision** for this phase, not
an oversight -- recorded here so it's never mistaken for one. It was
chosen together with a separate, non-negotiable requirement that *was*
enforced regardless: every endpoint still validates every id against a
real, existing, whitelisted filesystem entry before it touches a path or
builds a subprocess command (see "Safety model" below) -- "no login
required" and "no injection/path-traversal possible" are independent
axes, and only the first was waived.

**Before any public deployment**, add a real access-control check.
Every endpoint calls `admin_require_auth()` (in
`server/lib/AdminSupport.php`) first, before touching anything else --
that function is currently empty on purpose, specifically so a real
check (a session cookie, a shared-secret header like
`server/publish-playlist.php`'s `X-Publish-Token`, an IP allowlist,
whatever's decided later) has exactly **one** place to go in, and every
endpoint picks it up automatically with no other code changes. Until
that's done, treat any server this is deployed on as "anyone who can
reach it can administer the whole catalog."

## Where it lives

- `scheduler/css/tokens.css` -- design tokens (violet primary, per-series
  swatches `--sw-0..7-*`); `scheduler/js/components/ui-kit.js` -- shared
  icons, panel/tab/chip/dialog CSS and the per-series swatch picker used by
  the three revamp screens.
- `scheduler/js/view.js` -- the tiny view-switcher (plain `EventTarget`,
  same convention as `store.js`).
- `scheduler/js/admin-api.js` -- fetch wrappers for all three endpoints.
  Deliberately independent of `store.js`'s state (a different backend,
  a different data model).
- `scheduler/js/components/cf-series-admin.js` -- the SERIES tab (Series
  Review). Episode descriptions are loaded lazily per series from the
  read-only `explorer-admin.php` projection (they are not in the 6 MB
  `series-admin.php?action=list` payload).
- `scheduler/js/components/cf-broadcast-schedule.js` -- the SCHEDULE tab.
- `scheduler/js/components/cf-channel-admin.js` -- the PROGRAMMING tab,
  plus the "Continuity announcer" dialog for `server/announcer-admin.php`.
  Edits are local until **Save Changes**, which writes ALL of the channel's
  blocks (the `save_programming` contract). A block is edited by overlaying
  fields onto the original object, so fields the UI has no control for
  (`title`, `description`, ...) survive a save. A recurrence has ONE weekday
  (`channels/publish/src/Recurrence.php`), so the Days chips are exclusive in
  Weekly mode and all-on in Daily mode.
- `server/lib/AdminSupport.php` -- shared bootstrap: the auth hook,
  id/path whitelisting, atomic JSON writes, and the subprocess runner.
- `server/series-admin.php`, `server/channel-admin.php`,
  `server/announcer-admin.php` -- the three endpoints.

## Endpoints

### `server/series-admin.php`

```
GET  ?action=list
POST {"action":"save_episode", "series_id", "episode_id", "status", "rights_status", "rights_notes"}
POST {"action":"refresh", "series_id", "dry_run"}
POST {"action":"new_import", "series_id", "channel"|"channel_id"|"playlist", "title"?, "dry_run"}
```

`save_episode` writes **only** `status` and `rights` on the targeted
episode, through `YouTubeSeriesWriter` (the exact class
`youtube-import.php` itself uses, not a copy) -- every YouTube-sourced
field (title, description, duration, thumbnail, `source.*`, ...) is left
byte-for-byte untouched. `refresh` derives which YouTube channel/playlist
to re-fetch from the series' **own recorded** `source.channel_id` /
`source.playlist_id` -- it never trusts a request body for that, so a
request can't redirect an existing series at a different YouTube source.
`new_import`'s dry-run preview, when the requested new id happens to
coincide with one that already exists, deliberately targets a path that
can't exist on disk rather than reading/merging the real file -- a
preview can never depend on or leak real episode data; the real
(non-dry-run) action still hard-rejects a colliding id outright.

### `server/channel-admin.php`

```
GET  ?action=list
POST {"action":"save_catalog", "channel_id", "series_ids":[...]}
POST {"action":"save_programming", "channel_id", "blocks":[...]}
POST {"action":"publish", "channel_id", "dry_run", "days"?, "window_start"?, "window_timezone"?}
POST {"action":"preview_schedule", "channel_id", "days"?, "window_start"?, "window_timezone"?}
```

`save_catalog` rewrites `catalog.json`'s `series` array to the standard
`{"ref": "../../series/<id>/series.json"}` shape -- every id is
independently verified to exist first. `save_programming` validates
each block's shape server-side, including actually calling
`channels/publish/src/Recurrence.php`'s own occurrence computation (on
a throwaway one-day window, result discarded) to validate
`recurrence`/`rotation.anchor_date` -- this validation cannot drift out
of sync with what `publish.php` itself enforces, because it IS what
`publish.php` enforces. The same is true of a block's optional
`packing` and `boundary` (see `channels/publish/README.md`): when
present, they're validated via `EpisodePacker::normalizeConfig()` /
`BoundaryResolver::normalizeBoundary()` directly, the exact same
functions the real compiler runs. `publish` builds a whitelisted argv for
`channels/publish.php`.

`preview_schedule` is a real, *non-dry* `channels/publish.php` run against a
**throwaway copy** of the channel (`--channels-root=<tmp>`), returning the
resulting `schedule.json` as `{exitCode, stdout, stderr, schedule}`. It
validates its arguments exactly like `publish`. The copy includes
`.publish/` (episode-set pins and rotation state, so the preview rotates like
the real next publish while the real pins are never modified) and
deliberately excludes `announcer.json` (the announcer's single opt-in gate)
and all `announcements.json*` files, so a preview can never enqueue announcer
work. `series/` is symlinked read-only and the temp tree is removed
afterwards without following the symlink. Nothing under the real `channels/`
tree is written.

### `server/announcer-admin.php`

```
GET  ?action=list
GET  ?action=voices&channel_id=ID
POST {"action":"save_config", "channel_id", "config"}
POST {"action":"preview_voice", "channel_id", "voice"}
POST {"action":"regenerate", "channel_id", "transition_id", "force"?/"force_script"?/"force_audio"?}
POST {"action":"generate_queue", "channel_id"}
POST {"action":"approve_script", "channel_id", "script_hash", "text"}
```

A sibling to `channel-admin.php` (same relationship as `series-admin.php`
being its own sibling) for the AI continuity announcer feature -- see
`channels/announcer/README.md` for the full picture. `list` resolves each
channel's EFFECTIVE config through the exact same `AnnouncerConfig::
resolve()` the real pipeline uses (never a reimplementation), so what
this endpoint shows can't drift from what a real run would do, and never
echoes back a Kokoro `authToken` even if one is configured. `save_config`
validates every field server-side (voice/speed/language/style/tone/
duration bounds, the announcement-type enum, writer/TTS provider enums,
TTS endpoint must be `http(s)://`). `regenerate`/`generate_queue` build a
whitelisted argv for `channels/announce.php` (`--sync --transition=ID` or
a plain async enqueue, respectively) and run it the same way `publish`
runs `channels/publish.php`. `preview_voice` synthesizes one short fixed
sample line through the channel's real configured TTS provider -- never
arbitrary user-supplied text through an unbounded synthesis call.

### Packing and boundary controls (PROGRAMMING tab)

Each block in `cf-channel-admin.js`'s editor has two collapsed,
progressive-disclosure `<details>` groups below the basic recurrence
fields, each defaulting to today's pre-existing behavior (closed/off) so
an operator who never opens them sees no change at all:

- **Multi-episode packing**: a single checkbox ("fill this block with as
  many complete episodes as fit") that, when checked, reveals `mode`,
  `on_unfit`, `minimum_remaining`, `safety_margin`, and
  `allow_repeat_within_block` -- each with a one-line plain-language
  explanation, not just the raw field name.
- **Start time boundary**: a `mode` select (`hard`/`soft`/`elastic`,
  defaulting to `hard`) that reveals `max_delay` only when it isn't
  `hard`.

### Broadcast Schedule

The SCHEDULE tab reads `channels/<id>/schedule.json` (and `meta.json`'s
`anchor`) directly as static files: every item's absolute time is
`anchor + block.relative_start + item.start`, and `programs[]` (the
occurrences) tie episodes back to the programming block that generated
them. Day / Week / Rundown are three views of the same data; the timezone
selector (channel zone / your zone / UTC) only changes day bucketing and
display.

- **Published** = the live `schedule.json`. **Proposed** = *Compile Preview*
  (`preview_schedule` above) -- the schedule the *saved* programming would
  produce right now. Because episode rotation continues from where the last
  publish left off, a re-publish typically changes which episodes air even
  when no block was edited; the comparison shows exactly that.
- **Schedule Changes (Preview)** aligns programs of the two versions by
  start time over their overlapping window and lists changed / added /
  removed slots. **Change History** does the same for the previous publish
  (`schedule.json.bak`) vs the live one.
- **Publish Schedule...** is enabled only after a preview has been compiled
  and re-uses the exact `days` / `window_start` / `window_timezone` the
  preview used, through the existing `publish` action.
- The mockup's "version numbers" (v2025.01.27.1) are not modelled: versions
  are identified by their generation time and window, because that is all
  the data records.

### Schedule preview (text)

There is no separate JavaScript approximation of the compiler to keep in
sync -- the PROGRAMMING tab's existing "Preview (dry run)" button already
runs the real `channels/publish.php --dry-run --verbose` (see `publish`
above), and `PublishReporter`'s verbose listing walks the compiler's own
final, fully-resolved item list, so it already reflects multi-episode
packing, boundary delays (and their `delay_seconds`), and continuity
occurrences automatically -- every one of those features was built
directly into `ProgrammingCompiler`'s shared path, not a separate admin-
only code path. This is deliberately the "equivalent detailed preview
through the existing dry-run publishing interface" the feature spec
allows in place of a bespoke visual timeline; a richer visual rendering
of the same dry-run data remains a nice-to-have for a future pass.

## Safety model

- **Id/path whitelisting** (`server/lib/AdminSupport.php`): every id
  that becomes part of a filesystem path is checked against
  `/^[a-z0-9][a-z0-9-]*$/` (no slashes, no `..`, nothing else) AND,
  where it's expected to already exist, against the real filesystem --
  never trusted from a request body as a bare string that gets
  concatenated into a path.
- **Subprocess calls never touch a shell.** `admin_run_subprocess()`
  always uses `proc_open()`'s argv-**array** form: each argument is
  passed as one literal value with no shell interpretation at all. This
  is not "escaping" -- there is no shell to inject into. It is still not
  a substitute for the whitelisting above: an argument that's perfectly
  safe from a shell's point of view (e.g. a YouTube handle string a user
  typed in) can still be a path-traversal string from this
  application's point of view if it were ever used to build a path --
  which is exactly why path-forming values (series/channel ids) are
  whitelisted *before* they reach this function, not relied on it to
  catch.
- **Atomic writes.** Every write (episode status/rights,
  catalog.json, programming.json) is temp-file-then-rename, with a
  single-generation `.bak` kept alongside -- the same pattern as
  `YouTubeSeriesWriter.php` / `ScheduleWriter.php` /
  `publish-playlist.php`.
- **Never auto-approves anything.** `save_episode` only ever writes
  whatever `status`/`rights.status` the request explicitly asked for;
  nothing here promotes a candidate automatically, and `new_import`
  always produces `status: "candidate"` episodes (the importer's own
  default), same as running `youtube-import.php` by hand.

## Operational requirements for the import/publish/refresh buttons

- The **web server process** (not just your own shell) needs whatever
  `youtube-import.php` needs to run: either the `YOUTUBE_API_KEY`
  environment variable set in that process's environment, or a readable
  `youtube-import/config.local.php`. If neither is present, the refresh/
  import buttons will return a clear "No YouTube API key found" error in
  the output panel -- not a crash.
- The web server process also needs a working CLI PHP binary to shell
  out to. `admin_php_binary()` prefers an explicit `CRVIDEO_PHP_BINARY`
  environment variable, falls back to `PHP_BINARY` only if that looks
  like a real executable (it's unreliable under some web server SAPIs --
  may point at a non-CLI binary, or be empty), and otherwise falls back
  to bare `php` relying on `$PATH`. Set `CRVIDEO_PHP_BINARY` explicitly
  if the default guess is wrong for your setup.
- Both of the above are ordinary PHP-FPM/Apache environment
  configuration, not anything this project's code can fix from inside
  itself.

## Testing

```sh
php server/tests/run-tests.php
```

155 tests (`AdminSupportTest`, `SeriesAdminTest`, `ChannelAdminTest`
-- including `preview_schedule` --, `AnnouncerAdminTest`, ...) against isolated fixtures under
`server/tests/fixtures/repo/` -- never the real `series/`/`channels/`
trees. Covers id/path whitelisting (including rejecting path-traversal
strings), atomic-write/backup behavior, the argv-array subprocess runner
(including a literal shell-metacharacter payload, proving no shell is
ever invoked), every `save_episode`/`save_catalog`/`save_programming`/
`announcer-admin.php` `save_config` validation rule (including
`packing`/`boundary`), and `refresh`/`new_import`/`publish`/
`announcer-admin.php` `regenerate` argv construction. The real
`youtube-import.php` subprocess (which needs live API credentials) and
`announce.php`'s `--sync`/`generate_queue` subprocess (which needs a real
`claude` CLI and Kokoro server) are never actually invoked by the
automated suite -- only their argv-building logic is tested directly;
`channels/publish.php` (which needs no network) is exercised for real
against a fixture-only channel id in one test, proving the wiring end to
end without the real `channels/` tree being reachable.

**What still needs a real browser** (no DOM/browser available in this
environment, same honesty standard as the YouTube player adapter
phase): that `cf-series-admin`/`cf-channel-admin` actually render inside
the scheduler shell without layout breakage, that the SERIES/
PROGRAMMING tab switch behaves correctly (including that the pre-
existing SCHEDULE view's own layout isn't disturbed by now living one
DOM level deeper -- see the CSS comment in `scheduler/index.html` about
restoring its `flex:1` sizing), that toasts/output panels render
legibly, and that the end-to-end click-through (save a status, click
refresh, click publish) looks right. See the phase 6 report for exactly
what *was* verified against the real `server/*.php` endpoints via direct
HTTP calls (curl), as a substitute proof for the backend side of that
same round trip. The same applies to the "Continuity announcer" section's
"Load voices"/"Preview voice" buttons (need a real Kokoro server and a
browser's `<audio>` playback) and the inline announcement `<audio>`
players and regenerate/approve buttons -- their backend logic is covered
by `AnnouncerAdminTest`, but the actual click-through is manual/browser-
verified only, same as everything else in this list.
