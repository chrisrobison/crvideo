# CRVideo

A self-hosted, always-on "TV station" built out of your own video
catalogs: Internet Archive films and YouTube channels/playlists, scheduled
into looping, wall-clock-anchored channels and presented as a real
cable-style channel guide you tune into, not a playlist you scrub through.

No build step anywhere. The backend is plain PHP 8.2+ (no framework, no
Composer, nothing to `install`); the frontend is plain ES modules and
Shadow DOM custom elements (no bundler, no framework, no npm
dependencies). Point any PHP-capable web server at the repo root and
it runs.

## Two generations, one repo

- **The channel guide (`channels/`)** -- the current, actively developed
  system. Any number of independent 24-hour channels, each its own
  wall-clock-anchored, deterministically-computed program schedule,
  browsed from one cable-style grid guide and played back through one
  shared player component. This is what most of this README, and most
  of `docs/`, is about.
- **USTV (repo root + `scheduler/`)** -- the original, single-channel
  system this grew out of: one Google Drive folder of video segments,
  a hand/UI-edited `playlist.json`, and a clock-synced player
  (`sync-player.html`) that joins the "broadcast" already in progress
  based on the current time, the same way real TV works. It's still
  live: the channel guide's **channel 1, USTV**, is this exact lineup,
  embedded via `sync-player.html`. `scheduler/` (branded "ChannelFlow")
  is its admin UI, later extended with the channel guide's own editorial
  tooling (see "Admin / editorial tooling" below) rather than replaced.

## Quick start

```sh
php -S localhost:8080
```

Then open:

| URL | What it is |
| --- | --- |
| `/channels/` | **The channel guide** -- start here. |
| `/channels/watch.html?ch=science` | One channel, full-viewport, deep-linkable (any `channels/<id>`). |
| `/sync-player.html` | USTV's standalone clock-synced player. |
| `/scheduler/` | ChannelFlow: the Drive/playlist admin tool, plus the SERIES/PROGRAMMING editorial tabs. |

A few pieces need credentials to do anything live (YouTube imports, the
Google Drive scheduler, the local video cache downloader) -- see
"Secrets and local-only files" below. Everything else -- browsing the
guide, watching a channel, running the test suites -- works with
nothing but PHP and a browser.

## The channel lineup (`channels/`)

Adding a channel is just adding a folder under `channels/` with a
`meta.json`; there's no index to keep in sync (`channels/channels.php`
globs for it). Today's lineup:

| # | id | Name | What it is |
| - | -- | ---- | ---------- |
| 1 | `ustv` | USTV | A retro 24-hour lineup (Midnight Movies, Signal Sunrise, Revolution Rising, Mid-Day Music Videos, Musical Crafternoon, Prime Time Live) -- USTV's original Drive-backed stream, embedded via `sync-player.html`. |
| 2 | `film-day-at-school` | Film Day at School | Vintage classroom films from the Internet Archive: atomic drills, good manners, and the miracle of zinc. |
| 3 | `science` | Science & Engineering | A 12-hour, 12-show recurring lineup: Techmoan, SciShow, Plasma Channel, Real Engineering, Stuff Made Here, and more. |
| 4 | `lecture-hall` | The Lecture Hall | Full-length university courses and public talks from MIT, scientists, educators, and historians. |
| 5 | `retrovision` | RetroVision | A journey through TV/advertising/technology history -- vintage commercials, industrial films, and public-domain curiosities. |
| 6 | `maker` | Maker Channel | People making, building, repairing, inventing, and occasionally destroying fascinating things (Adam Savage's Tested, and more). |
| 7 | `pet-central` | Pet Central | Rescue stories, grooming, and animal personalities (The Dodo, Kitten Lady, and more). |
| 8 | `comedy-club` | Comedy Club | A 24-hour stand-up stage of complete sets/specials -- Dry Bar Comedy by day, Jim Gaffigan and others later. |
| 9 | `world-explorer` | World Explorer | A 24-hour atlas of travel/geography/culture: Rick Steves, DW Travel, Geography Now, Kara and Nate, Mark Wiens. |

(`channels/youtube-adapter-demo` also exists, deliberately hidden from
the guide -- a manual-verification fixture for the HTML5/YouTube
playback adapters, not real programming.)

## How a channel is put together

Every channel folder is some subset of:

```
channels/<id>/
  meta.json          number, name, description, logo, anchor, theme, …
  catalog.json        media/series this channel can air (catalog-resolver.js)
  schedule.json        the flattened, absolute-timestamp playback timeline
  programming.json      (optional) recurring series blocks -- compiled BY publish.php INTO schedule.json
  continuity.json       (optional) station IDs/filler/"Up Next" card config
  theme.json             (optional) per-channel bumper look (video loop / canvas / quote deck)
```

`schedule.json` is the one thing the player (`broadcast.js`/`watch.html`/
`index.html`) actually reads, and it comes from one of two places:

- **Hand- or `ia-import`-maintained**, for an Internet-Archive-sourced
  channel like `film-day-at-school` -- never touched by `publish.php`.
- **A build artifact of `channels/publish.php`**, for every other
  channel: it compiles `programming.json`'s recurring series blocks
  (daily/weekly/monthly recurrence, sequential rotation, multi-episode
  packing, soft/hard start boundaries, continuity/filler gap-filling)
  into that same flat `schedule.json` shape, so the player needs zero
  changes either way. **Never hand-edit a `publish.php`-managed
  `schedule.json`** -- re-run `publish.php` instead (it keeps a `.bak`).
  Full CLI reference, schema, and the determinism rules behind episode
  rotation: `channels/publish/README.md`.

The full design -- `series.json`'s schema, how a catalog references a
series, continuity/bumper theming, and the guide's program-level (not
per-video) grid -- is written up in `docs/series-and-channels.md` and
`docs/guide-update.md`.

## The frontend player

Dependency-free ES modules, no framework:

- **`channels/broadcast.js`** -- `BroadcastPlayer`: resolves "what's
  airing right now" from a schedule's absolute timestamps against the
  wall clock, drives provider adapters and drift correction, and
  projects the program-level EPG the guide renders.
- **`channels/player-adapters.js`** -- `Html5PlayerAdapter` (a plain
  `<video>`, for directly-hosted/Internet-Archive files) and
  `YouTubePlayerAdapter` (the official YouTube IFrame Player API),
  selected per-airing from structured provider metadata, never URL
  sniffing.
- **`channels/continuity-card.js`** -- the dynamic "Up Next" / station-ID
  bumper rendered during an unscheduled gap.
- **`channels/player-view.js`** -- `<cr-channel-player>`: the one full
  player implementation (chrome, slate, OSD, remote-control channel
  surf/dial, fullscreen/mute "engage" gesture), shared by `watch.html`
  (standalone) and `channels/index.html` (the guide's own small preview
  tile, which expands this exact same element in place via a View
  Transition rather than ever creating a second instance).

Components and stores on a page talk through one page-level message bus: the
[LARC/PAN](https://github.com/larcjs/larc) bus (`@larcjs/core` 3.0.2,
vendored as `vendor/larc/pan.js` -- see `vendor/larc/README.md` for
provenance and update steps), mapped in each page's import map and used
only through `js/bus.js`. Stores publish state/events on it and
components subscribe to it; `docs/bus-topics.md` is the topic dictionary.

## Content pipelines

Two standalone CLI importers, each independently documented and tested:

- **`ia-import/`** -- imports an Internet Archive list into a media
  catalog + an optimized fixed-block schedule. `ia-import/README.md`.
- **`youtube-import/`** -- imports a YouTube channel's uploads or a
  playlist (via the official YouTube Data API v3) into a portable
  `series/<id>/series.json`, reusable across any number of channels'
  `catalog.json` without duplicating metadata. `youtube-import/README.md`.

**Importing never publishes anything.** Every newly imported episode
starts as editorial `status: "candidate"`; only an editor approving it
(and a later `channels/publish.php` run) gets it onto a broadcast
channel -- see "Editorial status and content rights" in
`docs/series-and-channels.md`.

## AI continuity announcer (`channels/announcer/`)

Opt-in, per channel (`channels/<id>/announcer.json`): writes a broadcast-style "coming up
next" script for each of `schedule.json`'s continuity transitions (AI writer, with a
deterministic template fallback), synthesizes it with [Kokoro TTS](tools/kokoro-server/)
into a cached MP3, and records it in `channels/<id>/announcements.json` -- without ever
blocking schedule compilation. A continuity card on `watch.html`/`index.html` plays the
matching narration automatically; a "Continuity announcer" section in the PROGRAMMING admin
tab (`server/announcer-admin.php`) edits the config, previews voices, and can regenerate or
approve individual announcements. `channels/announcer/README.md`.

## Admin / editorial tooling

- **`server/`** -- standalone PHP endpoints: `download-cache.php` (cron
  job pre-fetching the next couple of Drive segments to local disk so
  `sync-player.html` never hits Drive's anti-automation block),
  `publish-playlist.php` (lets the scheduler push a new `playlist.json`
  live), and `series-admin.php`/`channel-admin.php`/`announcer-admin.php`
  (back the SERIES/PROGRAMMING tabs below, the last for the "Continuity
  announcer" section specifically). `server/README.md`.
- **`scheduler/`** (ChannelFlow) -- the admin UI: its original SCHEDULE
  tab (Drive folder picker, media library, rundown/timeline editor for
  `playlist.json`) plus newer SERIES tabs (episode approval, triggering
  a `youtube-import.php` refresh) and PROGRAMMING tabs (editing a
  channel's `catalog.json`/`programming.json`, previewing or running
  `publish.php`, plus a "Continuity announcer" section per channel) layered
  on top, additively -- switching tabs never unmounts anything.
  `scheduler/GOOGLE_DRIVE_SETUP.md` for the Drive OAuth setup.

> **Before deploying any of this reachable from the internet:** the
> SERIES/PROGRAMMING/announcer admin endpoints have **no login, no API key, no IP
> restriction at all** -- a deliberate, explicit decision, not an
> oversight. Read `docs/admin-ui.md` in full before exposing them.

## Determinism

Every piece of scheduling here shares one contract: **two viewers tuned
to the same channel at the same instant always see the same thing**,
and nothing about what's airing ever depends on `Math.random()`, a
viewer's own timezone, or wall-clock drift at playback time.
Concretely: episode rotation is pure calendar arithmetic (occurrences
since an anchor date, DST-safe), continuity/filler selection happens
once at publish time (never re-rolled per viewer), and republishing the
same or a later, overlapping window is idempotent. The full rationale
(and every documented edge case) is in "Determinism and schedule
publication" in `docs/series-and-channels.md`.

## Docs index

| Doc | Covers |
| --- | ------ |
| `docs/series-and-channels.md` | The whole series/catalog/recurring-programming/continuity design; start here for anything `channels/` or `publish.php`-related. |
| `docs/guide-update.md` | Why/how the guide renders one cell per *program*, not per video. |
| `docs/bus-topics.md` | The LARC/PAN page bus: topic dictionary, naming/retained-state rules, request/reply, what stays a DOM event. |
| `docs/admin-ui.md` | The SERIES/PROGRAMMING admin tabs and their (lack of) access control. |
| `docs/science-packing-report.md` | A worked example of the Science channel's multi-episode packing. |
| `channels/publish/README.md` | `publish.php` CLI reference and `programming.json`/`continuity.json` schema. |
| `channels/announcer/README.md` | The AI continuity announcer: architecture, caching, CLI, setup. |
| `tools/kokoro-server/README.md` | The standalone Kokoro TTS HTTP microservice (local or remote). |
| `ia-import/README.md` | `ia-import.php` CLI reference and input format. |
| `youtube-import/README.md` | `youtube-import.php` CLI reference, credentials, and editorial-status handling. |
| `server/README.md` | The cache downloader and admin endpoints. |
| `scheduler/GOOGLE_DRIVE_SETUP.md` | Google Drive OAuth setup for the scheduler's SCHEDULE tab. |

## Testing

No single top-level runner -- each PHP subproject (and the one JS test
tree) carries its own, all fixture-driven, none touching a real
channel, real credentials, or the network:

```sh
php channels/publish/tests/run-tests.php   # publish.php: recurrence, packing, boundaries, continuity, CLI
php channels/announcer/tests/run-tests.php # AI announcer: contexts, caching, job queue, writer/TTS validation
php ia-import/tests/run-tests.php          # ia-import.php
php youtube-import/tests/run-tests.php     # youtube-import.php
php server/tests/run-tests.php             # admin endpoints
cd channels && node --test "tests/*.test.js"   # player/broadcast/EPG logic (Node's built-in test runner)
```

Every `run-tests.php` also takes a substring filter, e.g.
`php channels/publish/tests/run-tests.php Recurrence`.

## Secrets and local-only files

Never committed (see `.gitignore`); each is read from the environment
or an explicit local file, never hardcoded:

- `YOUTUBE_API_KEY` (env var, or `youtube-import/config.local.php`) --
  `youtube-import/README.md`.
- `server/service-account.json` -- the cache downloader's Google
  service-account credential -- `server/README.md`.
- `server/publish-secret.php` -- the scheduler's publish-endpoint shared
  secret.
- `scheduler/drive-config.local.php` -- the Drive OAuth client id for
  `channel.html`'s key-serving endpoint -- `scheduler/GOOGLE_DRIVE_SETUP.md`.
- `.env` / `.env.sh` -- local environment convenience, never committed.
- `channels/announcer/config.local.php` -- Kokoro endpoint/auth-token overrides for the AI
  announcer (no key needed for the AI writer itself -- it uses the `claude` CLI's existing
  OAuth session) -- `channels/announcer/README.md`.
