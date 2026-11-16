# Page bus (LARC/PAN) -- topic dictionary and conventions

Every page with component code (`scheduler/index.html`,
`channels/index.html`, `channels/watch.html`) runs one page-level
message bus: [LARC/PAN](https://github.com/larcjs/larc), `@larcjs/core`
3.0.2, vendored byte-for-byte as `vendor/larc/pan.js` (provenance and
update steps: `vendor/larc/README.md`). Stores and custom elements talk
through it instead of through ad-hoc `EventTarget`s, so a new component
(the coming scheduling-UI revamp, a debug panel, a second player) can
join by subscribing to topics, without importing or being imported by
the code that owns the state.

The topic list below is mirrored by `TOPICS` in `js/bus.js` -- that
constant is the single source of truth for code; `channels/tests/bus.test.js`
fails if a topic is missing from this document.

## Wiring

```html
<!-- in <head>, before any module script; path relative to the page -->
<script type="importmap">{ "imports": { "@larcjs/core": "../vendor/larc/pan.js" } }</script>
...
<body>
<pan-bus hidden></pan-bus>
```

Pages only ever map the bare specifier `@larcjs/core`, with a path
relative to the page (the site is served from a subdirectory in
production, so no leading `/`), so upgrading LARC means replacing one
file. The `<pan-bus>` element is declared in markup for clarity;
`js/bus.js` would create it (`ensureBus()`) if it were missing.

Code never imports `@larcjs/core` directly. It imports `js/bus.js` by
**relative path** (`../../js/bus.js` from `scheduler/js/`,
`../js/bus.js` from `channels/`):

```js
import { TOPICS, publish, publishState, subscribe, request, respond } from "../../js/bus.js";

class MyThing extends HTMLElement {
  connectedCallback() {
    this._subs = new AbortController();
    const signal = this._subs.signal;
    subscribe(TOPICS.SCHEDULER_BLOCKS_CHANGED, () => this.render(), { signal });
    subscribe(TOPICS.APP_VIEW_STATE, ({ data }) => this.onView(data.view), { retained: true, signal });
  }
  disconnectedCallback() { this._subs.abort(); }
}
```

### What `js/bus.js` adds over a raw `PanClient`

- **Node / no-DOM fallback.** `vendor/larc/pan.js` declares
  `class PanBus extends HTMLElement` at top level and bare specifiers
  don't resolve under `node --test`, so `js/bus.js` never imports it
  statically. In a browser it does `import("@larcjs/core")` (resolved by
  the page's import map). Without `document`/`customElements` (Node), or
  if that import fails (a page without the import map -- a console
  warning says so), it switches to a small in-memory bus with the same
  semantics: topics, one-segment `*` wildcards, retained messages,
  request/reply, synchronous delivery. That is what lets
  `bump-studio-store.js` and friends be imported and tested under Node;
  `busMode()` reports `"pan"` or `"memory"`.
- **No dropped early messages.** LARC drops anything published before
  `<pan-bus>` is connected. `publish()`/`subscribe()` calls made before
  the bus has loaded (e.g. a store's constructor at module-evaluation
  time) are queued and replayed in order. After that, delivery is
  synchronous, like the `EventTarget` plumbing it replaced.
- **One host per subscription.** PanBus delivers a message once per
  matching subscription *to that subscription's host element*, and every
  PanClient listener on a host sees every delivery to that host. Two
  subscriptions sharing `document` would each get the other's messages
  and retained replays. `subscribe()` gives every subscription its own
  hidden `<pan-subscription>` host inside `<pan-bus>`, and de-duplicates
  by message id (overlapping patterns like `["a.*", "a.b"]` deliver once).
- **`publishState(topic, data)`** -- see "State topics" below.
- **`request()` / `respond()`** -- a result/error envelope over LARC's
  `replyTo`/`correlationId` request/reply.

Handlers receive the full PAN message: `{ topic, data, id, ts, retain?,
replyTo?, correlationId? }`. Read `msg.data`.

## Naming conventions

Topics are lower-case, dot-separated `domain.subject[.qualifier].kind`:

| Kind | Shape | Example | Published with |
| --- | --- | --- | --- |
| **state** | ends in `.state` | `scheduler.channel.state` | `publishState()` -- always retained |
| **event** | past tense | `bumps.item.saved` | `publish()` -- never retained |
| **command** | imperative verb | `studio.schedule.open` | `publish()` -- fire-and-forget; the owner subscribes and acts |
| **request** | a question (`*.get`, `*.query`) | -- (none yet) | `request()` / `respond()` |

Domains in use: `app` (scheduler page shell), `drive` (Google Drive
auth), `scheduler` (ChannelFlow store), `studio` (Bump Studio UI state),
`bumps` (bump definitions and schedules), `player` (the channel player).
Don't add a new domain for one topic; extend an existing one.

**Wildcards:** `*` matches exactly one dot segment -- `bumps.*` matches
`bumps.saved` but NOT `bumps.item.saved` (use `bumps.item.*` or
`bumps.*.*`); a bare `*` matches everything. Every wildcard subscription
costs a freshly-built RegExp per message (PanBus doesn't cache them), so
production code subscribes to explicit topics or explicit lists (e.g.
`SCHEDULER_CHANGE_TOPICS`); keep `*` for debugging.

## State topics (`.state`) -- the retained-state rule

- A `.state` topic carries a **complete snapshot** of one small piece of
  state, never a delta, so the last message alone tells a newcomer the
  current value.
- It is **always retained** (`publishState()` does that), so a component
  that mounts late subscribes with `{ retained: true }` and gets the
  current value immediately.
- `publishState()` **skips a snapshot identical** (JSON) to the last one
  on that topic, so subscribers only hear about real changes and owners
  can call it liberally (e.g. `player.state` from a 1 Hz timer).
- The owner publishes an initial snapshot at startup.
- State topics carry *identifiers and flags*, not documents: the store
  stays the owner of the data, and components read details from it
  (`store.findBlock(id)`, `studioStore.state.draft`). E.g.
  `bumps.draft.state` says whether the draft is dirty, not what's in it.
- Exactly one owner publishes a given state topic. (Corollary: one
  `<cr-channel-player>` per page publishes `player.state`.)

## Request / reply

```js
// owner
respond("bumps.list.get", () => studioStore.state.bumps.map(({ id, name }) => ({ id, name })), { signal });
// anyone
const bumps = await request("bumps.list.get", null, { timeoutMs: 2000 });
```

`respond(topic, fn)` replies `{ok: true, result}` with `fn(data, msg)`'s
(possibly async) return value, or `{ok: false, error}` if it throws.
`request()` resolves with `result`, or rejects with the error / a
timeout (default 5 s). Use requests when the caller needs an answer
(a query, or a command whose outcome it must know); otherwise prefer a
command plus the owner's resulting state/event. No production topic
uses request/reply yet; the API is there (and tested) for the revamp.

## What stays a DOM event, and why

Not everything belongs on the bus:

- **Per-frame / high-rate signals never go on the bus.** PanBus matches
  every message against every subscription (building a RegExp for each
  wildcard pattern) and allocates a message + UUID per publish. That's
  fine for discrete changes and the scheduler's 1 Hz tick, not for
  60 Hz. Concretely:
  - `<cr-bump>`'s `bump-time` (every frame while playing), and its
    `bump-state` / `bump-media` / `bump-ended`, stay DOM events on the
    element -- they're its public API for whoever hosts it (the studio
    preview, the Library detail panel, `BumpRenderer`).
  - Bump Studio's `playback` slice (playhead time, playing, durations,
    mute/loop/volume) is fed from `bump-time` at frame rate, so it is
    announced as a plain `playback` event on `studioStore.transport`
    (an `EventTarget`), never as `studio.changed`. Timeline/preview/
    inspector listen there.
  - `requestAnimationFrame` loops, `<video>` `timeupdate`, pointer-move
    drag feedback, the program monitor's meter animation.
- **Element-local UI events stay DOM events**: input-like events from a
  child to its direct parent (`<cf-toggle>`'s `change`,
  `thumb-duration` in `studio-ui.js`, native `<input>`/`<select>`
  `change`), and a component's public events for its host page
  (`<cr-channel-player>`'s `cr-channel-change`, `cr-airing`, and the
  cancelable `cr-back`, which needs `preventDefault()` -- impossible over
  the bus). Where something page-level would care, the owner
  **additionally** publishes the discrete fact on the bus
  (`cr-channel-change` -> `player.channel.changed`, `cr-airing` ->
  `player.program.changed`, `<cr-bump>` windows -> `player.bump.*`).
- **Library classes stay bus-free.** `BroadcastPlayer`, the player
  adapters, renderers and the pure models (`broadcast.js`,
  `player-adapters.js`, `bump-player.js`'s helpers, `bump-model.js`,
  `schedule-model.js`) take callbacks and return values; the custom
  element or store that owns them is the bus participant. This keeps
  them reusable and trivially testable.
- **Payloads must be JSON-serializable** -- no `Set`, `Map`, `Blob`,
  DOM nodes or class instances. Keys go as arrays (`studio.changed`'s
  `keys`); `changeOf(msg)` in `bump-studio-store.js` turns that back
  into a `Set` for the components.

## Topic dictionary

Retained = published with `retain: true` (late subscribers can ask for
it with `{ retained: true }`).

### App shell -- `scheduler/js/view.js`

| Topic | Kind | Retained | Payload | Notes |
| --- | --- | --- | --- | --- |
| `app.view.state` | state | yes | `{view}` -- `"schedule"\|"guide"\|"legacy-schedule"\|"series"\|"programming"\|"bumps"\|"explorer"` | Which top-level section is visible. `main.js` toggles `[data-view]` from it; `cf-header` highlights its nav; `cf-bump-studio` lazy-loads on first `"bumps"`. |
| `app.view.open` | command | no | `{view}` | Switch view. Published by `cf-header`'s nav and Bump Studio's "set up the announcer" link; handled by `view.js`. |

`view.js` also keeps `?view=<name>` in the URL (`history.pushState` on every
change, `popstate` -> view) so Back returns from Bump Studio to Explorer; the
`explorer` view's own query parameters are owned by `explorer-store.js`.

### Explorer -- `scheduler/js/components/explorer/explorer-store.js`

Explorer is a read-only browser/inspector (see `docs/explorer.md`). It publishes
its selection and accepts a command to be driven from elsewhere; all hand-offs
to editors are commands those editors own.

| Topic | Kind | Retained | Payload | Notes |
| --- | --- | --- | --- | --- |
| `explorer.route.state` | state | yes | `{mode, channel, series, episode, airing, t, cat, asset, q}` | Semantic ids only. `airing` is the airing's start in epoch seconds (an airing is `channel` + start, never an episode id); `asset` is a typed ref (`{kind:"bump",id}` etc.). |
| `explorer.route.open` | command | no | same fields | Switch to Explorer and select that entity. Validated exactly like the URL (malformed ids are dropped). |
| `series.review.open` | command | no | `{seriesId, episodeId?}` | Published by Explorer's "Open in Series Review"; handled by `cf-series-admin` (opens the series card, scrolls to the episode row; changes nothing). |
| `programming.channel.open` | command | no | `{channelId, blockId?}` | Published by Explorer's "Open in Programming"; handled by `cf-channel-admin` (opens the channel card; changes nothing). |

Bump Studio hand-offs reuse the existing `studio.compose.open` (`{id}`) and
`studio.schedule.open` (`{channelId}`) after `app.view.open {view:"bumps"}`.

### Google Drive -- `scheduler/js/drive.js`

| Topic | Kind | Retained | Payload | Notes |
| --- | --- | --- | --- | --- |
| `drive.auth.state` | state | yes | `{connected}` | Initial snapshot at import (a token restored from sessionStorage counts). `cf-header` re-renders its Drive menu. |

### ChannelFlow scheduler -- `scheduler/js/store.js` (mapping in `store-notify.js`)

The store keeps its state and mutators; every mutation's internal
`reason` maps to the messages below (`schedulerNotifications()`,
unit-tested). Components that just re-render on "anything changed"
subscribe to `SCHEDULER_CHANGE_TOPICS` (all of these except the tick).

| Topic | Kind | Retained | Payload | Published when |
| --- | --- | --- | --- | --- |
| `scheduler.channel.state` | state | yes | `{channelId, name}` | `setChannel()`; initial. |
| `scheduler.date.state` | state | yes | `{date, isToday}` (`YYYY-MM-DD`) | `shiftDate()`; initial. |
| `scheduler.selection.state` | state | yes | `{blockId \| null}` | `selectBlock()`, and whenever a channel/date/blocks change alters the selection; initial. |
| `scheduler.blocks.changed` | event | no | `{channelId, date}` | Any block add/update/move/resize/duplicate/remove, auto-fill, schedule load/hydrate. |
| `scheduler.media.changed` | event | no | `{kind: "list"\|"duration"\|"thumbnail", count}` | Media library list replaced/extended, a probed duration arrived, a Drive thumbnail resolved. |
| `scheduler.folders.state` | state | yes | `{drive: {id,name}\|null, reels: {id,name}\|null}` | Drive / reels folder linked or cleared; initial. |
| `scheduler.autofill.state` | state | yes | `{enabled}` | "Auto-fill gaps with reels" toggled; initial. |
| `scheduler.schedule.published` | event | no | `{publishedAt, target: "local"\|"live"}` | `publish()` (download) or `publishLiveSchedule()` succeeded. |
| `scheduler.tick` | event | no | `{now}` (UTC seconds of day) | Every second. Header clock, timeline playhead, rundown and stat cards. The only periodic topic on the bus. |

### Bump Studio -- `scheduler/js/components/bump-studio/bump-studio-store.js`

| Topic | Kind | Retained | Payload | Notes |
| --- | --- | --- | --- | --- |
| `studio.changed` | event | no | `{keys: string[], source: string\|null}` | One per store mutation. `keys` ⊆ `bumps, selection, draft, layer, workspace, preview, schedules, media, status, saving, scheduleFocus` (never `playback`). `source` names the component that caused it (`"timeline"`, `"inspector"`, `"save"`, `"rename"`, ...) so it can skip its own echo. Every studio component re-renders from this. |
| `studio.status.state` | state | yes | `{status: "idle"\|"loading"\|"ready"\|"error", error}` | Data load status. |
| `studio.workspace.state` | state | yes | `{workspace: "compose"\|"schedule"\|"library"}` | Visible workspace. |
| `studio.compose.open` | command | no | `{id}` | Open a saved bump in Compose (asks before discarding unsaved edits). Published by the Library; handled by the store (`openInCompose`). |
| `studio.schedule.open` | command | no | `{channelId}` | Show a channel in the Schedule workspace. Published by the Library's "used by" chips; handled by the store (`openInSchedule`, which the Schedule workspace picks up via `studio.changed` key `scheduleFocus`). |
| `bumps.list.changed` | event | no | `{count, source}` | The saved bump list changed (load, save, rename, duplicate, remove). |
| `bumps.selection.state` | state | yes | `{id \| null, isNew}` | Bump being edited; `id` is null for a never-saved bump. |
| `bumps.draft.state` | state | yes | `{id \| null, isNew, dirty, canSave}` | Draft save flags only -- republished when a flag changes, not per keystroke. |
| `bumps.item.created` | event | no | `{id, name, source: "save"\|"duplicate"}` | A new bump definition was written (`bumps/<id>.json`). |
| `bumps.item.saved` | event | no | `{id, name, source: "save"\|"rename"}` | An existing definition was rewritten. |
| `bumps.item.deleted` | event | no | `{id}` | A definition was deleted. |
| `bumps.schedule.saved` | event | no | `{channelId, enabled, ruleCount}` | A channel's `bump-schedule.json` was saved. |

### Channel player -- `channels/player-view.js` (`<cr-channel-player>`)

| Topic | Kind | Retained | Payload | Notes |
| --- | --- | --- | --- | --- |
| `player.state` | state | yes | `{channelId, state, title, playable, startsAt, endsAt, bumpId}` | `state` is `BroadcastPlayer.state` (`loading`, `buffering`, `playing`, `blocked`, `slate`, `continuity`, `bump`, `error`); `title` is null during a station break; `bumpId` is set while a scheduled bump is on screen. Checked on every state/airing change and once a second. |
| `player.channel.changed` | event | no | `{channelId, name, number}` | Tuned to a different channel (guide, deep link, remote surf/dial). Mirrors the `cr-channel-change` DOM event. |
| `player.program.changed` | event | no | `{channelId, title, playable, startsAt, endsAt}` | A new airing began (or a channel was first loaded). Mirrors `cr-airing`. |
| `player.bump.started` | event | no | `{channelId, bumpId, startsAt, endsAt}` | A clock-scheduled bump window opened. |
| `player.bump.ended` | event | no | `{channelId, bumpId}` | That window closed. |

## Pages without a bus

`channel.html` and `sync-player.html` (standalone module-script players
built on plain classes, no custom elements) and `schedule.html` (one
classic inline script) have no component code and nothing on the page
to talk to, so they carry no import map and don't load the bus. If one
of them grows components, add the import map and `<pan-bus hidden>`
as above.

## Adding a topic

1. Add it to `TOPICS` in `js/bus.js` with a one-line comment (kind,
   payload, retained).
2. Add a row here (the test checks every topic is documented).
3. Owner publishes it (`publishState` for `.state`, `publish`
   otherwise); consumers subscribe with an `AbortSignal` tied to
   `disconnectedCallback`.
4. If the mapping is non-trivial, keep it in a pure function and test
   it under `channels/tests/` (see `store-notify.js`).

## Debugging

In the page's devtools console:

```js
const { createClient } = await import("@larcjs/core");
createClient().subscribe("*", (m) => console.log(m.topic, m.data));
```

(or `const bus = await import("../js/bus.js")` from a `channels/` or
`scheduler/` page for the wrapper, e.g. `bus.busMode()`).
