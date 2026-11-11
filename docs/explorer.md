# CRVideo Explorer

Explorer is a read-only, Finder-style browser/inspector inside ChannelFlow
(`scheduler/?view=explorer`). It owns no data: every entity is resolved at
runtime from the files and APIs that already own it. It never publishes,
saves, regenerates or overrides anything.

## Implementation plan (written before coding)

### Reused as-is

| Need | Existing source |
|---|---|
| Channel list, meta, catalog series refs, programming blocks | `server/channel-admin.php?action=list` via `channelAdminApi.list()` (includes hidden channels; Explorer filters `hidden`) |
| Published schedule, timeline math | `channels/broadcast.js`: `loadChannel`, `buildTimeline`, `buildEpgTimeline`, `locate`, `airings`, `episodeAiringTimes` |
| Announcements | `channels/<id>/announcements.json` via `loadAnnouncements`; `findAnnouncementAudio` semantics |
| Bump definitions | `bumpAdminApi.list()` / `loadBumpDefinition` (`bumps/*.json`) |
| Bump scheduling rules | `loadBumpSchedule` (`channels/<id>/bump-schedule.json`), `bumpRuleWindow` / `locateActiveBump` from `channels/player-adapters.js` |
| Bump rendering / preview | the existing `<cr-bump>` (`channels/bump-player.js`); no second renderer |
| Media inventory (video/music/ambience, announcement audio) | `bumpAdminApi.media()` |
| Waveforms | `bump-studio/media-peaks.js` |
| Episode playback | `YouTubePlayerAdapter` / `Html5PlayerAdapter` (`player-adapters.js`), iframe-only for YouTube |
| Cross-workspace navigation | LARC/PAN bus: `app.view.open`, `studio.compose.open`, `studio.schedule.open` |

### Relationships that resolve reliably from current data

- channel → series: `catalog.json` `series[].ref` (shown by channel-admin as `series_refs`).
- channel → programming blocks → series: `programming.json` blocks (`series_id`).
- series → episodes: `series/<id>/series.json`.
- airing identity: `channel id` + program `occurrence_id` (e.g. `lineup-techmoan-am@1794384000`).
  Episode airings: schedule `items[].id` equals the series episode id, `items[].program_id` ties
  it to a program occurrence, `programs[].series_id` to the series.
- continuity item → announcement: `announcements[].transitionId === item.id` (`coming_up_next`
  matches the schedule's continuity item id; `channel_id` ones have a fixed transition id).
- bump → channels/rules: `channels/<id>/bump-schedule.json` `rules[].bumpId`.
- bump → media: `background.url`, `audio[].url`, `announcement` fields in the bump JSON.

### Data that does not exist (so Explorer does not invent it)

- Series category, tags, season numbers, creators/rights beyond `rights.status/notes`:
  `series.json` has no `category`/`tags`/`season`; Explorer shows only `creator`, `year`,
  `source`, episode `status`, `rights`. Missing -> "Not recorded".
- Viewer counts, player health, "On Air" telemetry. The only truthful channel states are
  *Schedule available*, *Scheduled now: <program>* (from the published schedule + clock),
  *Schedule unavailable*, and *Outside published window*.
- Asset libraries beyond what is in the repo: only Bumps, Announcements, Music, Ambience,
  Background videos exist (and images, currently empty). No Lower Thirds, Templates, etc.
- Actual/verification drift, per-asset "Online" checks, LUFS, "Draft/Active" bump state.
- Rotation state per channel: derivable from the published schedule only (which episode ids
  were actually scheduled and in what order); `schedule._publish.episode_sets` is shown when present.

### Mockup vs. implementation differences

- Mockup stat footer ("System healthy", "Alerts") is not shown; nothing backs it.
- "Before/After bump" rows in the Airing Inspector come only from published continuity
  items adjacent to the airing; clock-triggered bump overlays are a separate layer.
- Relationship Map (node-link diagram) is optional per spec; a structured list is built.
- Sample data (Jan 28, 2025 etc.) is replaced by real repository data.

### New server surface

`server/explorer-admin.php` (read-only, same `admin_require_auth()` hook and id whitelist):

- `?action=series_index` – compact list (id, title, thumb, episode/status counts, provider).
- `?action=series&id=<id>` – one series with its episodes (status, rights, source, description).
- `?action=episode_index` – id/series/title/duration/status per episode, for search only.

Reason: `series-admin.php?action=list` is ~6 MB and `series.json` files reach 1.7 MB each.

### Files

```
scheduler/js/components/explorer/
  explorer-route.js     pure URL <-> route state
  explorer-model.js     pure relationship/airing/time-travel/bump-rule/search logic (Node-tested)
  explorer-api.js       cached read-only loaders
  explorer-store.js     state, history, bus handoffs
  explorer-ui.js        formatters, icons, shared CSS
  cf-explorer.js        shell, breadcrumbs, columns
  explorer-inspector.js + explorer-{channel,series,episode,airing,asset,search}.js
server/explorer-admin.php
channels/tests/explorer-*.test.js, server/tests/ExplorerAdminTest.php
```

### Phases

1. Shell, routing, Channel→Series→Episode columns, `explorer-admin.php`.
2. Channel and Series inspectors, editor handoffs.
3. Episode + Airing inspectors, Time Travel, continuity timeline, preview.
4. Production asset explorer (bumps, announcements, media), where-used.
5. Global search, relationships.
6. Polish: keyboard, responsive, resize, history, a11y.

---

## What was built (as of this branch)

Open it from the **EXPLORER** tab in ChannelFlow, or deep-link:

```
scheduler/?view=explorer&channel=science&series=techmoan&episode=yt-3H3QRtDTE4Y
scheduler/?view=explorer&channel=science&airing=1794384010&t=1794543420     # airing = start (epoch s); t = inspected instant
scheduler/?view=explorer&mode=production&cat=bumps&asset=bump:forest-interlude
scheduler/?view=explorer&q=bridge&scope=episodes
```

- **Programs**: Channels -> Shows -> Episodes | Schedule -> Airings, with a contextual Inspector
  (channel, series, episode, airing, asset). A series is reachable without a channel (All shows).
- **Time travel** (toolbar): any instant; answers come from the *published* schedule via
  `broadcast.js` `locate()`. Outside `_publish.window` the result is an explicit out-of-range state.
- **Production**: Bumps, voiceover announcements, music, ambience, background videos (libraries that
  exist in the repo) with a "Where used" column. Bump previews use the existing `<cr-bump>`.
- **Search**: one box (Ctrl/Cmd+K), client-side over metadata, grouped by type, scope chips, and a
  relationship inspector for the picked result.
- **Hand-offs** (all read-only commands over the bus): Programming (`programming.channel.open`),
  Series Review (`series.review.open`), Bump Studio compose/schedule (`studio.compose.open`,
  `studio.schedule.open`). Browser Back returns to the exact Explorer state.
- **Keyboard**: Up/Down/Home/End within a column; Enter/Space selects; Right selects and enters the next
  column; Left goes back a column; Enter on the selected item (or double-click) opens its editor;
  Esc clears search / closes the audio dock; Ctrl/Cmd+K focuses search.

### Honest limits

- Playback health, audience, "on air", asset availability checks, drift/sync, LUFS: **not known**, not shown.
- Series have no category/tags/season in `series.json`: shown as "Not recorded".
- Search "airings" covers only the channel schedules loaded (all of them load in the background, one at a time).
- Episode preview plays through the YouTube iframe adapter (or a native `<video>` for directly hosted
  files). Videos whose provider disallows embedding show the reason and a link to the source instead.
- Continuity cards are previewed with the channel's own `<cr-continuity-card>`; announcements play in a dock.
- Not built (optional per spec): node-link relationship diagram, per-column resizing (the Inspector
  splitter is resizable), a server-side search API.
- Pre-existing, unrelated: the Series tab eagerly renders all ~9.8k episode rows at page load (~4 s main-thread
  stall) regardless of the visible view. Explorer does not depend on it, but it affects first-load responsiveness.

### Tests

`node --test channels/tests/*.test.js` (route, model, store, view history, plus the existing suites) and
`php server/tests/run-tests.php` (ExplorerAdminTest).
