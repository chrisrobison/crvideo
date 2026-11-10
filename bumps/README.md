# Bumps

A **bump** is a produced interstitial -- a looping background video (or
image/solid color), one or two looping background audio beds (drawn from
`media/music/` and/or `media/ambience/`), an optional single voice-over
("announcement", drawn from an already-generated
`channels/<id>/announcements.json` entry -- never newly synthesized by
this feature), and a live, schedule-driven list of upcoming shows'
titles and times. It's meant to stand in for an actual video file in a
channel's rotation -- "Coming Up Next" as a fully produced screen rather
than the plain default card `channels/continuity-card.js` renders when a
channel has no theme configured.

**Not the same thing as `channels/<id>/theme.json`'s `bumpers` list.**
That's a lighter-weight, pre-existing concept: a weighted set of
background/content *treatments* (a looping clip or a canvas animation,
paired with the plain "up next" info block or a quote card) that
`<cr-continuity-card>` picks between automatically, per-occurrence, for
a channel that's opted in. A **bump** (this directory) is a complete,
individually authored unit an editor builds and previews by hand in the
bump creator UI (`scheduler/` → BUMPS), combining a specific video, a
specific audio bed (or two), and optionally a specific pre-generated
announcement clip. The two systems don't reference each other -- see
"Live scheduling" below for how a bump actually gets on the air, which
is a deliberately different mechanism than theme.json's bumpers.

## Storage

One JSON file per bump: `bumps/<id>.json`. `<id>` is a slug
(`^[a-z0-9][a-z0-9-]{0,59}$`), derived from the bump's name when it's
first created and stable after that (renaming the bump later only
changes its `name`, never the filename/id). Written/read exclusively
through `server/bump-admin.php` (atomic write + `.bak`, same convention
as every other admin-edited JSON in this repo) -- never hand-edit one of
these files while the bump creator UI might also be open on it.

## Schema (schema_version 1)

```json
{
  "schema_version": 1,
  "id": "forest-interlude",
  "name": "Forest Interlude",
  "description": "",
  "background": { "type": "video", "url": "media/video/bg05.mp4" },
  "audio": [
    { "source": "ambience", "url": "media/ambience/forest.mp3", "volume": 0.4 },
    { "source": "music", "url": "media/music/bg-music03.mp3", "volume": 0.6 }
  ],
  "announcement": {
    "url": "media/announcements/science/<hash>.mp3",
    "channelId": "science",
    "transitionId": "continuity-1794016800",
    "duckTo": 0.3
  },
  "upcoming": { "count": 3, "label": "Coming Up" },
  "style": { "accent": "#ffcc33", "accentWarm": "#ff8a3d" },
  "createdAt": "2026-11-09T22:40:00+00:00",
  "updatedAt": "2026-11-09T22:40:00+00:00"
}
```

- `background.type`: `"video"` or `"image"` (both require `url`, a path
  under `media/` that must exist on disk) or `"color"` (requires `color`,
  any CSS color string -- the graceful fallback for a bump that hasn't
  had a video picked yet).
- `audio`: 0-2 looping layers. `source` is just a UI hint (`"music"`,
  `"ambience"`, or `"custom"` for anything else under `media/`); `volume`
  is 0-1.
- `announcement` (optional, may be `null`): a single, already-rendered
  narration clip that plays once, ducking the audio layers' volume to
  `volume * duckTo` for its duration. `channelId`/`transitionId` are
  carried along purely as a human-readable label of where the clip came
  from (so the creator UI can show "from science: 'Coming up next...'")
  -- never re-validated against that channel's current
  `announcements.json` on save, since the clip itself is what's actually
  played.
- `upcoming.count`: how many upcoming shows to list (0-6). The actual
  titles/times are **never stored here** -- they're supplied at render
  time by whatever's driving `<cr-bump>` (the creator UI's own preview,
  pulling a real channel's live timeline via `channels/broadcast.js`;
  eventually, real channel playback). A bump is a *presentation*, not a
  snapshot of one night's lineup.
- `style`: optional CSS custom-property overrides (`accent`, `accentWarm`,
  `bg`, `bg2`, `fg`, `muted`) -- same small palette convention as a
  channel's own `meta.json` `theme` field.

## Timing (schema_version 2, optional)

A bump may opt into an intrinsic **composition length** and a few
per-layer timing fields. All are in **seconds**, measured from the moment
the bump begins:

```json
{
  "schema_version": 2,
  "id": "comedy-club-spotlight",
  "name": "Comedy Club Spotlight",
  "duration": 15,
  "background": { "type": "video", "url": "media/video/bg01.mp4" },
  "audio": [{ "source": "music", "url": "media/music/bg-music04.mp3", "volume": 0.6 }],
  "announcement": { "url": "media/announcements/...mp3", "duckTo": 0.3, "start": 2 },
  "upcoming": { "count": 3, "label": "Coming Up", "start": 0, "end": 15 },
  "style": {}
}
```

| Field | Meaning | When absent |
|---|---|---|
| `duration` | Composition length, 1-300 s | Not set: a version-1 bump. Editors preview it at the **default of 15 s** (`DEFAULT_BUMP_DURATION` in `channels/bump-player.js`); on air nothing changes |
| `announcement.start` | When the voice clip starts | 0 (plays immediately, as in v1) |
| `upcoming.start` | When the text layer appears | 0 |
| `upcoming.end` | When the text layer disappears (`> start`) | Visible until the bump ends, as in v1 |

Rules (enforced by `server/bump-admin.php`): every timing field requires
`duration`; starts are nonnegative; ends are greater than starts and never
past `duration`; `announcement.start` is earlier than `duration`.
`schema_version` is **derived** on save: 2 when `duration` is present,
otherwise 1, so a bump that never uses timing is stored exactly in the
version-1 shape. Existing version-1 files load and play unchanged; no
migration is needed or performed.

**Duration vs. the schedule rule.** A bump's `duration` is its intended
composition length. A channel's rule `durationSeconds` still decides how
long the bump actually interrupts that channel and is never rewritten when
a bump's duration changes. When the two differ, the bump is either **cut
short** (window shorter than the composition) or **looped** (the window
outlasts it, and the composition restarts from 0, voice included).
`scheduleFit(ruleDurationSeconds, bump)` in `channels/bump-player.js`
returns `"exact" | "cut" | "loop" | "open"` (`"open"` = a v1 bump, where
the rule alone decides) for UIs that need to warn about this.

**One composition-time model.** `<cr-bump>` computes everything from a
single composition time `t`, the seconds since the bump began. It is always
derived from a clock reading (`CompositionClock`) and never accumulated
from timer ticks, so throttled background tabs and late frames cannot
drift it. Video and music loop by their own length (`t mod length`), the
voice clip is a one-shot positioned at `announcement.start`, and the text
layer fades in and out at `upcoming.start` / `upcoming.end`. Elements more
than about 0.35 s off are re-seeked. Live playback starts the composition
at the clock-derived offset into the scheduled window
(`now() - window.startsAt`), so a viewer who tunes in mid-bump sees and
hears the same moment as everyone else. The editor preview uses the same
component and the same model, with `endBehavior = "stop"` so it stops at
the end.

Every `url` in a bump is validated by `server/bump-admin.php` to resolve
to a real, existing file *inside* `media/` (realpath containment, not
just a string prefix check) -- a bump can never reference a path outside
that tree.

## The player: `channels/bump-player.js`

`<cr-bump>`, a dependency-free Web Component (shadow DOM, no build step
-- same posture as `channels/continuity-card.js`). Takes `.definition`
(a bump JSON object, exactly this schema), `.upcoming` (the caller-
supplied list of `{title, startsAt, subtitle?}`), optional `.channel`
(`{name, logo}` branding), and `.clockNow`. `.play({muted, offset})`,
`.pause()`, `.seek(t)`, `.stop()` and `.setMuted()` are explicit,
caller-driven controls. Nothing auto-plays on mount, since the editor
mounts one well before anyone has clicked play. Read-only `.currentTime`,
`.duration` (effective) and `.mediaDurations` report state. `.endBehavior`
is `"continue"` (the default, used for live playback), `"loop"`, or
`"stop"`. The element fires `bump-time` (every frame while playing),
`bump-state` (play/pause), `bump-media` (when media metadata loads, with
real clip lengths) and `bump-ended` (only with `"stop"`). Setting
`.definition` while playing is safe: only sources whose URL changed are
reloaded, and playback continues from the current time. Two editor-only
properties, `.masterVolume` (monitor level) and `.hiddenLayers` (the
timeline's eye toggles: `"text"`, `"voice"`, `"music"`, `"background"`),
affect only the preview. Live playback never sets them, and they are
never part of a bump definition.

## The creator UI

`scheduler/` (the ChannelFlow dashboard) → **BUMPS** tab, the **Bump
Studio** (`scheduler/js/components/bump-studio/`, talking to
`server/bump-admin.php`). It has three workspaces:

- **Compose**: a searchable bump list, a persistent 16:9 `<cr-bump>`
  preview with a multitrack timeline under it, and a contextual inspector
  for Background / Music / Announcer / Text. Pick media from what actually
  exists under `media/` and each channel's already-generated announcements
  (the studio never generates narration). Preview against editable sample
  programming or a real channel's current lineup, read-only through
  `channels/broadcast.js`. Preview data is never saved, and nothing
  reaches a channel until you click Save.
- **Schedule**: per-channel `bump-schedule.json` rules.
- **Library**: an overview of every bump.

Still images for `background.type: "image"` are listed from
`media/images/` (jpg/png/webp/gif). The editor offers image backgrounds
only when that directory has files in it.

## Live scheduling

A bump goes on the air by WALL CLOCK, never by being published into
`schedule.json`. Each channel has its own optional
`channels/<id>/bump-schedule.json`:

```json
{
  "schema_version": 1,
  "enabled": true,
  "rules": [
    { "bumpId": "forest-interlude", "every": "hour", "offsetSeconds": 0, "durationSeconds": 12 }
  ]
}
```

`every` is `"hour"` / `"halfHour"` / `"day"`; `offsetSeconds` (default 0)
is how far into that period the window opens (0 = exactly on the hour);
`durationSeconds` is how long it stays up. Written/read through the same
`server/bump-admin.php` (its `schedules`/`save_schedule` actions), edited
from the Bump Studio's **Schedule** workspace -- pick a channel,
toggle it on, add a rule naming one of the bumps above.

**Why clock-anchored and client-side, not published into the schedule:**
`channels/publish/src/ContinuityFiller.php` can only fill a gap that
already exists between packed programming -- it has no operation that
carves a slot out of an otherwise contiguous block, so most hour
boundaries have no gap to insert into. Driving it from
`BroadcastPlayer.tick()`'s own wall clock instead (see
`channels/player-adapters.js`'s "bump scheduling" header for the full
rationale) sidesteps that entirely and is unconditional: it always fires,
regardless of how tightly packed the channel's programming is. Every
viewer's player independently computes the identical window from the
same absolute instant -- same determinism contract `locate()`/`airings()`
already rely on.

A bump DRAWS OVER whatever's airing without pausing the underlying
schedule -- exactly like a real broadcast station break, and the same
trade-off this project's continuity cards already make: a viewer who
watches through it simply misses that slice of the program, and the
program resumes at its own now-current live point (a hard reseek
forward, not a plain resume) once the window closes. A bump preempts
even a continuity occurrence baked into the published schedule, since
it's an explicit, guaranteed interruption rather than organic filler.
