# AI continuity announcer

Generates natural-sounding, broadcast-style "coming up next" (and station-ID) narration
for a channel's compiled `schedule.json`, writes the script with an AI writer (or a
deterministic template fallback), synthesizes it with [Kokoro TTS](../../tools/kokoro-server/)
into a cached, CDN-friendly MP3, and records the result in a per-channel announcement
manifest. Strictly opt-in, per channel, and never blocks schedule compilation.

This is **Pass 1**: the core pipeline (context building, AI writing, TTS synthesis,
caching, job queue, CLI, `publish.php` integration, tests). Admin UI, the admin API, and
`continuity-card.js` `<audio>` playback wiring are a deferred Pass 2 -- the manifest/asset
side built here is already shaped for that to be purely additive.

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
