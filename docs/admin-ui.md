# Admin UI: series review and channel/programming management

An editorial/admin UI built as two new tabs (**SERIES**, **PROGRAMMING**)
in the existing ChannelFlow scheduler (`scheduler/index.html`), backed by
two new PHP endpoints under `server/`. It lets an editor:

- review imported episodes and set their `status`/`rights` (the
  approval gate from `docs/series-and-channels.md`'s "Editorial status
  and content rights"),
- trigger a `youtube-import.php` refresh of an existing series, or a
  brand-new import, from the browser,
- edit a channel's `catalog.json` series references and
  `programming.json` recurring blocks,
- preview or run `channels/publish.php` for a channel.

It is **additive** to the existing scheduler: the pre-existing SCHEDULE
tab (the Drive-folder/live-playlist tool, `scheduler/js/store.js`) is
completely unchanged and still works exactly as before. Switching tabs
(`scheduler/js/view.js`) only toggles which section of the page is
visible; nothing is unmounted.

## No access control (read this before deploying)

**This admin UI has no login, no API key, no IP restriction -- nothing.**
Anyone who can reach `server/series-admin.php` or
`server/channel-admin.php` on the server can, right now, without
authenticating:

- change any episode's editorial status/rights in any series,
- edit any channel's catalog/programming,
- trigger a real `youtube-import.php` call against the YouTube Data API
  (consuming quota, and -- for a brand-new import -- creating a new
  `series/<id>/series.json` file),
- trigger a real `channels/publish.php` run that overwrites a channel's
  `schedule.json`.

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

- `scheduler/js/view.js` -- the tiny view-switcher (plain `EventTarget`,
  same convention as `store.js`).
- `scheduler/js/admin-api.js` -- fetch wrappers for the two endpoints.
  Deliberately independent of `store.js`'s state (a different backend,
  a different data model).
- `scheduler/js/components/cf-series-admin.js` -- the SERIES tab.
- `scheduler/js/components/cf-channel-admin.js` -- the PROGRAMMING tab.
- `server/lib/AdminSupport.php` -- shared bootstrap: the auth hook,
  id/path whitelisting, atomic JSON writes, and the subprocess runner.
- `server/series-admin.php`, `server/channel-admin.php` -- the two
  endpoints.

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
```

`save_catalog` rewrites `catalog.json`'s `series` array to the standard
`{"ref": "../../series/<id>/series.json"}` shape -- every id is
independently verified to exist first. `save_programming` validates
each block's shape server-side, including actually calling
`channels/publish/src/Recurrence.php`'s own occurrence computation (on
a throwaway one-day window, result discarded) to validate
`recurrence`/`rotation.anchor_date` -- this validation cannot drift out
of sync with what `publish.php` itself enforces, because it IS what
`publish.php` enforces. `publish` builds a whitelisted argv for
`channels/publish.php`.

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

60 tests (`AdminSupportTest`, `SeriesAdminTest`, `ChannelAdminTest`)
against isolated fixtures under `server/tests/fixtures/repo/` -- never
the real `series/`/`channels/` trees. Covers id/path whitelisting
(including rejecting path-traversal strings), atomic-write/backup
behavior, the argv-array subprocess runner (including a literal shell-
metacharacter payload, proving no shell is ever invoked), every
`save_episode`/`save_catalog`/`save_programming` validation rule, and
`refresh`/`new_import`/`publish` argv construction. The real
`youtube-import.php` subprocess (which needs live API credentials) is
never actually invoked by the automated suite -- only its argv-building
logic is tested directly; `channels/publish.php` (which needs no
network) is exercised for real against a fixture-only channel id in one
test, proving the wiring end to end without the real `channels/` tree
being reachable.

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
same round trip.
