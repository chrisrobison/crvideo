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

Every `url` in a bump is validated by `server/bump-admin.php` to resolve
to a real, existing file *inside* `media/` (realpath containment, not
just a string prefix check) -- a bump can never reference a path outside
that tree.

## The player: `channels/bump-player.js`

`<cr-bump>`, a dependency-free Web Component (shadow DOM, no build step
-- same posture as `channels/continuity-card.js`). Takes `.definition`
(a bump JSON object, exactly this schema), `.upcoming` (the caller-
supplied list of `{title, startsAt, subtitle?}`), optional `.channel`
(`{name, logo}` branding), and `.clockNow`. `.play()`/`.stop()`/
`.setMuted()` are explicit, caller-driven controls -- nothing auto-plays
on mount, since the bump creator UI mounts one to edit fields well before
anyone's clicked a preview button.

## The creator UI

`scheduler/` (the ChannelFlow dashboard) → **BUMPS** tab
(`scheduler/js/components/cf-bump-creator.js`, talking to
`server/bump-admin.php`). Pick a background/audio/announcement from what
actually exists under `media/` and each channel's generated
announcements, preview live with `<cr-bump>` against either hand-typed
sample upcoming-show rows or a real channel's real current lineup
(reusing `channels/broadcast.js` read-only, client-side), then save.

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
from the bump creator UI's bottom "Scheduling" panel -- pick a channel,
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
