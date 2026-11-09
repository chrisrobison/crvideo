# AI continuity announcer

Generates natural-sounding, broadcast-style "coming up next" (and station-ID) narration
for a channel's compiled `schedule.json`, writes the script with an AI writer (or a
deterministic template fallback), synthesizes it with [Kokoro TTS](../../tools/kokoro-server/)
into a cached, CDN-friendly MP3, and records the result in a per-channel announcement
manifest. Strictly opt-in, per channel, and never blocks schedule compilation.

**Pass 1** built the core pipeline (context building, AI writing, TTS synthesis, caching,
job queue, CLI, `publish.php` integration, tests). **Pass 2** adds the admin UI (a
"Continuity announcer" section in `scheduler/js/components/cf-channel-admin.js`), its
backend (`server/announcer-admin.php`), and the actual playback wiring: a continuity card
on `watch.html`/`index.html` now plays the matching narration MP3 (if one exists and is
still fresh for what's actually airing) instead of staying silent. Both passes are purely
additive -- a channel with no `announcer.json` behaves exactly as it did before any of
this existed.

## How it fits into the existing architecture

CRVideo has no database, no daemon, and no existing AI/TTS integration anywhere -- every
"background" task in this repo is a plain, idempotent, cron-invoked CLI script (see
`server/download-cache.php`). This module follows that exact posture rather than
introducing a new one:

- **No new storage engine.** Everything is plain JSON files + atomic writes (temp file +
  `rename()`), the same convention `ScheduleWriter.php`/`AdminSupport.php` already use.
- **No new config system.** Per-channel config is `channels/<id>/announcer.json`, a sibling
  of `continuity.json`/`programming.json`; it is absent by default (feature off), matching
  every other opt-in feature's "absent = zero behavior change" rule.
- **No new secret-handling pattern.** Kokoro's endpoint/auth-token resolve via the same
  env-var-then-local-file precedence `YouTubeCredentials::resolve()` already established.
- **No new process model.** `channels/announce-worker.php` is a cron-invoked queue drainer,
  structurally identical to `server/download-cache.php` (see the suggested crontab line in
  its own `--help`).
- **The integration seam is `schedule.json`'s own `"continuity"` items** (emitted by
  `ScheduleWriter.php`/`ContinuityFiller.php`) -- these already carry the exact transition
  boundary, the upcoming program's `next_program_id`, and (usually) the `program_id` of the
  block being led into. `AnnouncementContextBuilder.php`'s header documents precisely how
  the "current" and "upcoming" programming **block** (never the raw video title) are
  resolved from them, confirmed against real `channels/science/schedule.json` data.

## Architecture

```
channels/announcer/
  config.php                      global defaults (safe to commit, no secrets)
  config.local.php                optional local overrides (gitignored)
  src/
    AnnouncementContextBuilder.php  builds structured contexts from schedule.json
    AnnouncerConfig.php             config.php -> config.local.php -> env -> announcer.json
    ContentHash.php                 canonical, order-independent sha256 hashing
    AiWriterInterface.php           provider-independent writer contract
    WriterPromptBuilder.php         prompt + JSON Schema + word budget
    TemplateAiWriter.php            deterministic, dependency-free fallback writer
    ClaudeCliAiWriter.php           real adapter: shells out to the `claude` CLI
    MockAiWriter.php                test double
    TtsProviderInterface.php        provider-independent TTS contract
    KokoroHttpTtsProvider.php       real adapter: HTTP to tools/kokoro-server/
    MockTtsProvider.php             test double (real, valid, silent WAV -- no network)
    AudioProcessor.php              ffmpeg WAV->MP3 (+loudnorm) and ffprobe validation
    ScriptCache.php / AudioCache.php  the two independent caches (see below)
    JobQueue.php                    file-based job queue (pending/running/done/error)
    AnnouncementManifestWriter.php  atomic, lock-guarded announcements.json writer
    AnnouncerPipeline.php           orchestrates all of the above
  tests/                            own run-tests.php + fixtures, see "Testing" below
channels/announce.php               CLI: generate/dry-run/force/sync/...
channels/announce-worker.php        CLI: drains the job queue (the actual AI+TTS work)
channels/<id>/announcer.json        per-channel opt-in config (e.g. channels/science/announcer.json)
channels/<id>/announcements.json    published manifest (atomic; separate from schedule.json)
channels/<id>/.announcer/           gitignored local build state (scripts cache + job queue)
media/announcements/<id>/<hash>.mp3 public, CDN-cacheable generated audio (gitignored; regenerable)
tools/kokoro-server/                the standalone Kokoro TTS HTTP microservice
```

### Data flow

```
publish.php (unchanged schedule.json write)
   |
   v  (fast: no AI/TTS calls -- just hashing + file-exists checks)
AnnouncerPipeline::enqueueForSchedule()
   |  -- already cached (script+audio)? -> just (re)confirm the manifest entry
   |  -- missing? -> write a job file keyed by its own content hash (dedup for free)
   v
channels/<id>/.announcer/jobs/pending/<scriptHash>.json
   |
   v  (slow: this is the ONLY place that calls an AI writer or Kokoro)
channels/announce-worker.php  (cron-invoked, like download-cache.php)
   |  write (AI, falling back to template) -> synthesize -> encode/validate -> publish manifest entry
   v
channels/<id>/announcements.json  +  media/announcements/<id>/<hash>.mp3
```

`channels/announce.php --sync` runs the same `runJob()` step synchronously, in-process,
skipping the queue entirely -- useful for local testing/demoing and a future admin "generate
now" action.

### Caching (two independent hashes)

- **Script hash** = `sha256(type, transitionId, from/to program identity, block/series/episode
  snapshot, writer style+provider+model)`. Changing the *next* program changes this; changing
  an unrelated transition elsewhere never does (confirmed by
  `PipelineIntegrationTest::testRepeatedProgrammingBlockAcrossOccurrencesGetsIndependentCacheEntries`).
- **Audio hash** = `sha256(script text, voice, speed, language, TTS backend/model version,
  audio settings)`. Changing only the voice changes this but **not** the script hash -- the
  script is reused, only new audio is synthesized (confirmed by
  `CacheInvalidationTest::testChangingVoiceChangesAudioHashNotScriptHash`).
- An `approved` flag on a cached script (set by the Pass 2 admin editor, not by anything in
  this pass) is never overwritten by routine regeneration.

### Reliability

See `AnnouncerPipeline::checkStale()` (discards a job whose transition changed underneath
it), `JobQueue`'s content-hash-keyed filenames (duplicate enqueue = no-op), its
`reclaimStale()` (crash recovery), and its exponential-backoff retry. `TemplateAiWriter` is
always available offline and is what every writer failure falls through to -- a schedule is
never blocked on, or made invalid by, a missing announcement.

## Setup

### 1. The AI writer: the `claude` CLI (no API key needed)

The default adapter shells out to the already-installed Claude Code CLI using your existing
OAuth session -- `claude -p --output-format json --json-schema '<schema>' --restricted
--model <model> "<prompt>"`. Real, captured example of what that one call returns:

```json
{"is_error": false, "subtype": "success",
 "result": "{\"announcement\":\"Coming up next on Science Channel: Kurzgesagt...\"}",
 "structured_output": {"announcement": "Coming up next on Science Channel: Kurzgesagt..."},
 "total_cost_usd": 0.0024, ... }
```

**Every real call costs money/usage** (a few tenths of a cent each in testing, via Sonnet).
`ClaudeCliAiWriter` validates the response and falls through to `TemplateAiWriter` on any
failure (missing binary, timeout, malformed output, wildly-over-budget response) -- so a
machine with no `claude` CLI at all still works, just with template-only narration. Set
`writer.provider` to `"template"` (or `"mock"` for tests) in `announcer.json` to skip the AI
call entirely.

### 2. Kokoro TTS server

See **[tools/kokoro-server/README.md](../../tools/kokoro-server/README.md)** for full setup.
Short version:

```bash
cd tools/kokoro-server
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
./fetch-model.sh                 # downloads the ONNX model + voices (~350MB total)
python3 server.py                # keep this running (local) -- or run it on a remote
                                  # Mac mini and point KOKORO_ENDPOINT at it
```

Confirmed working on this project's reference hardware (an older Xeon, CPU-only, no
AVX2/VNNI): ~1.5x real-time (a 10s announcement takes ~15s to synthesize), ~54 voices
bundled, `af_heart`/`bm_george`/etc. Measure your own hardware with `tools/kokoro-server/bench.py`
-- do not assume CPU inference is always slower than real time.

### 3. Enable a channel

Create `channels/<id>/announcer.json` (see `channels/science/announcer.json` for a filled-in
example):

```json
{
  "enabled": true,
  "voice": "af_heart",
  "speed": 1.0,
  "language": "en-us",
  "style": "Clear, slightly dry science-channel announcer",
  "tone": "Curious, measured, a little wry",
  "targetDuration": 12,
  "types": ["coming_up_next", "channel_id"],
  "writer": {"provider": "claude-cli", "model": "sonnet"},
  "automaticGeneration": true
}
```

Every field not mentioned falls back to `channels/announcer/config.php`'s defaults. A
channel with no `announcer.json` at all is completely untouched by this feature.

### 4. Generate

```bash
# See what would happen -- writes nothing, calls nothing external:
php channels/announce.php --channel=science --dry-run --verbose

# Enqueue only (what publish.php does automatically on every republish):
php channels/announce.php --channel=science

# Drain the queue (the actual AI + TTS work -- run this via cron, see its --help):
php channels/announce-worker.php --verbose

# Or do it all synchronously, right here, for one specific transition:
php channels/announce.php --channel=science --sync --transition=continuity-1794009600
```

### 5. Admin UI (Pass 2)

A "Continuity announcer" section in `scheduler/js/components/cf-channel-admin.js`
(`scheduler/index.html`, same page as the existing catalog/programming editors), backed by
a new sibling endpoint `server/announcer-admin.php`. Per channel, it lets an editor:

- toggle `enabled` and edit voice/speed/language/style/tone/target duration/announcement
  types/consecutive-same-series behavior/writer provider+model -- everything in
  `announcer.json` except `tts` (the Kokoro endpoint is a deployment setting, not a
  per-channel editorial one, so it's shown but not editable here),
- **Load voices from Kokoro**, which calls `GET /voices` on the channel's configured
  Kokoro server (`KokoroHttpTtsProvider::listVoices()`) and populates the voice field's
  autocomplete list -- harmless if the server isn't reachable, it just means typing the
  voice id by hand instead,
- **Preview voice**, which synthesizes one short fixed sample line through the real TTS
  provider and plays it back, so an editor can audition a voice without touching any real
  schedule content,
- see every currently-generated announcement for the channel (type, transition, text,
  duration, status, an inline `<audio>` player) and **Regenerate** any one of them
  synchronously (`channels/announce.php --sync --transition=ID --force`, run as a
  subprocess -- the exact same code path a cron worker uses, never reimplemented),
  **Generate missing (queue)** to enqueue the backlog for a worker run to pick up, and
  **Edit -> Approve** a script's wording so routine regeneration never silently overwrites
  it (`ScriptCache::approve()`).

Same "no access control" posture as `channel-admin.php`/`series-admin.php` (see
`docs/admin-ui.md`): anyone who can reach this page can edit any channel's announcer
config and trigger a real `claude` CLI + Kokoro run from it.

### 6. Playback wiring (Pass 2)

`continuity-card.js`'s `<cr-continuity-card>` now has an `.audioUrl` property backing a
hidden `<audio>` element: setting it (re)starts narration playback from the top; setting it
to `null` stops it. `player-adapters.js`'s `ContinuityRenderer.show()` takes the resolved
audio URL as its new trailing parameter and `setMuted()` mirrors the player's mute state
onto it (the narration is "channel audio" exactly like any program's own soundtrack, so a
viewer's mute choice follows them into and out of a continuity card).

The URL itself comes from `broadcast.js`'s `findAnnouncementAudio(announcements, airing)`:
it matches a continuity airing's own `id` (== the announcement's `transitionId` -- the
same schedule continuity item both sides key off) against a `coming_up_next`, `status:
"ready"` entry in the channel's `announcements.json` (fetched by the new
`loadAnnouncements()`, same cached/fail-to-`[]` posture as `loadCatalog()`/`loadTheme()`).
It also re-checks `toEpisodeId` against the airing's own `nextProgramId` and discards the
match on disagreement -- the client-side half of spec section 11's "a schedule that
changes during audio generation," mirroring `AnnouncerPipeline::checkStale()`'s equivalent
server-side check with data the player already has on hand.

`BroadcastPlayer.updateChannelMeta()` lets `player-view.js`'s `tune()` patch in the
announcements manifest (and, as a side benefit, the bumper theme) once its async fetch
resolves, without calling `setTimeline()` again -- which would reset `airing` and visibly
reload whatever is currently playing. The trade-off: a continuity card that's already on
screen when the fetch resolves won't retroactively start narrating; the next one will.

## Verified end-to-end on real sample data

Using the real, already-published `channels/science/schedule.json` (no synthetic fixtures),
with the real `claude` CLI and a real local Kokoro server:

```
OK  coming_up_next continuity-1794009600: At four o'clock, it's Stuff Made Here. Expect
    months of software upgrades, a robotic golf club, and a determined attempt to teach it
    some physics. Stay with us.
OK  coming_up_next continuity-1794012713: Another episode of Stuff Made Here is coming up
    next, at five o'clock. Same series, same workshop, and presumably more things built in
    ways nobody asked for. Stay tuned.                                [consecutive-episode case]
OK  coming_up_next continuity-1794013200: Stuff Made Here wraps up. At five o'clock, The
    Engineering Mindset takes over, with practical engineering knowledge and a question
    worth asking: what's actually going on inside the processor you're probably near right now?
OK  channel_id channel-id: You're watching the Science and Engineering channel. Twelve hours,
    twelve shows, one hour each, then we start again. Stay curious, stay measured, and
    perhaps keep a notebook nearby.
```

Each produced a valid MP3 (`ffprobe`-confirmed duration, e.g. 13.368s/11.088s/11.280s/10.104s),
written to `media/announcements/science/<hash>.mp3`, recorded in `channels/science/announcements.json`.
The async path (`announce.php` enqueue -> `announce-worker.php` drain) and cache reuse (a
second `--dry-run`/enqueue over already-generated transitions reports `REUSE`/`reused`, not
`GENERATE`/`enqueued`) were both exercised for real as well.

**What remains unverified in this environment:** a *remote* Kokoro deployment (only tested
locally; the remote case is "just a different URL" -- no code path differs), and
high-concurrency / sustained-load behavior of the job queue (tested for correctness, not for
throughput under real production volume).

## Testing

```bash
php channels/announcer/tests/run-tests.php
```

43 tests covering: transition detection and block-title-not-video-title resolution, context
construction (missing descriptions, no-upcoming-program, consecutive-same-series,
title-collision-but-different-occurrence disambiguation), AI writer validation (prompt
guardrails, word budget, template determinism, simulated failures), cache hashing and
invalidation rules (voice-only vs. next-program-changing vs. unrelated-change), the job queue
(dedup, claim races, retry/backoff, crash recovery), real `ffmpeg`/`ffprobe` MP3 validation
(including rejecting invalid input without leaving a partial file), and full pipeline
integration (end-to-end cache reuse, concurrent-enqueue dedup, stale-transition discarding,
forced regeneration). All run against a synthetic fixture tree (`tests/TestFixtures.php`),
never the real `channels/`/`series/` directories, using `MockAiWriter`/`MockTtsProvider` --
no network, no `claude` CLI, no Kokoro server required to run the suite.

Pass 2's own additions: `server/tests/AnnouncerAdminTest.php` (20 tests, run as part of
`php server/tests/run-tests.php`) covers `server/announcer-admin.php`'s pure logic --
listing/config resolution, `save_config` validation (every rejected shape: bad voice,
out-of-range speed, empty/unknown announcement types, unknown writer provider, non-http
TTS endpoint, overlong text), the `regenerate` action's argv-building (never actually
shelling out), and `approve_script`. `channels/tests/player-adapters.test.js` gained
`findAnnouncementAudio()` coverage (matching, staleness discarding, missing-manifest/
non-continuity-airing fallbacks) plus a real-`buildTimeline()` check that a continuity
item's `id`/`next_program_id` actually survive into the `airing` object those matches key
off. Deliberately **not** covered by an automated test (needs a real Kokoro server/browser,
same posture as `YouTubePlayerAdapter` already being manual/browser-verified only): the
admin UI's "Load voices"/"Preview voice" buttons, and `<cr-continuity-card>`'s actual
`<audio>` element playback/autoplay behavior.

Re-run the rest of the existing suite to confirm nothing else regressed:

```bash
php channels/publish/tests/run-tests.php && php server/tests/run-tests.php && (cd channels && node --test "tests/*.test.js")
```

## CLI reference

`php channels/announce.php --help` and `php channels/announce-worker.php --help` are the
source of truth. Highlights: `--channel=ID` / `--all-channels`, `--date=`/`--from=`/`--to=`
(filter by scheduled airtime), `--transition=ID[,ID2]` (one or a few specific transitions),
`--voice=` (override for this run), `--force` / `--force-script` / `--force-audio`,
`--scripts-only` / `--audio-only`, `--sync` (run in-process instead of enqueueing),
`--dry-run` (shows reuse-vs-generate and the full context JSON with `--verbose`, writes nothing).

## Known Pass-1 simplifications

- **Lookahead filtering is relative to real "now."** If a channel's published window has
  fully elapsed without a fresh `publish.php` run (the player then loops the stale window --
  see `publish.php`'s own header comment), every transition in that window still looks
  "not more than `lookaheadHours` in the future" (it's in the past, which isn't excluded
  either) and gets generated. This is a safe default (bounded over-generation across one
  published window, never missing audio) but not the tightest possible interpretation of
  "generate only the next 24-48h" -- keeping a channel's window fresh via regular `publish.php`
  reruns is what makes the lookahead filter bite as tightly as intended.
- **`now_showing` / `still_ahead` / `lineup_preview` / `return_from_break`** have their
  `WriterPromptBuilder` branches stubbed to a generic brief and are reachable via
  `announcer.json`'s `types`, but only `coming_up_next` and `channel_id` were exercised
  against real data end-to-end in this pass.

## Known Pass-2 simplifications

- **`channel_id` audio is generated and cached but never automatically played.** It isn't
  tied to any one `schedule.json` continuity occurrence (`AnnouncementContextBuilder`
  builds exactly one, stable `transitionId: "channel-id"` per channel, not per airing), and
  nothing in `schedule.json`'s compiler currently carves out a dedicated slot for a station
  ID drop the way it does for a `coming_up_next` continuity card. `findAnnouncementAudio()`
  only ever matches `type === "coming_up_next"` for exactly this reason. Wiring a real
  airtime for station IDs (e.g. its own schedule item type, or periodic insertion) is future
  work; today it's reachable from the admin UI (regenerate/preview) but not from playback.
- **The admin UI's `tts` (Kokoro endpoint/provider) is shown but not editable.** It's a
  deployment-level setting (which Kokoro server a channel talks to), not a per-channel
  editorial one -- changing it is a `channels/<id>/announcer.json` edit outside the UI, or a
  `config.local.php`/env var change for every channel at once.
- **No "delete announcement" admin action.** Regenerate-with-force covers "redo it";
  removing an entry outright (e.g. after disabling a type) isn't exposed yet -- the next
  `publish.php`/`announce.php` run's `AnnouncementManifestWriter::pruneExcept()` already
  removes anything no longer eligible, so this mostly self-heals on its own.
- **A continuity card already on screen when its channel's announcements/theme fetch
  resolves won't retroactively start narrating** (see `BroadcastPlayer.updateChannelMeta()`'s
  header) -- only the next continuity occurrence will. In practice the fetch is a small
  same-origin JSON request that resolves well within one 500ms player tick, so this only
  matters if a continuity card happens to start in the same instant as the channel tune.
