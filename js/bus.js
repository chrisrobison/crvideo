// js/bus.js -- the one shared entry point to the page-level LARC/PAN
// message bus, for every page and module in this repo (scheduler/,
// channels/, Bump Studio). See docs/bus-topics.md for the topic
// dictionary, naming rules and the "what stays a DOM event" policy.
//
// Why a wrapper instead of importing `@larcjs/core` everywhere:
//
//   * Node: channels/tests/*.test.js import modules (bump-studio-store,
//     player-adapters, ...) that publish/subscribe. vendor/larc/pan.js
//     does `class PanBus extends HTMLElement` at top level and bare
//     specifiers don't resolve under `node --test`, so this module never
//     imports it statically. In a browser it loads `@larcjs/core` (via the
//     page's import map) with a dynamic import(); anywhere without
//     `document`/`customElements` -- or a page missing the import map --
//     it uses a small in-memory bus with the same semantics (topics,
//     `*` wildcards, retained messages, request/reply), so code under test
//     behaves exactly like it does on the page.
//
//   * Ordering: publish()/subscribe() can be called at module-evaluation
//     time, before the bus has loaded. Calls made before then are queued
//     and replayed in order once it's ready, so nothing published early
//     is dropped (a raw PanClient would silently drop it). Once ready,
//     delivery is synchronous, exactly like the EventTarget plumbing it
//     replaced.
//
//   * One host per subscription: PanBus delivers a message once per
//     matching subscription to that subscription's host element, and a
//     PanClient listener on a shared host sees every delivery made to
//     that host. Two subscriptions sharing `document` would therefore
//     each receive the other's messages (and the other's retained
//     replays). subscribe() gives every subscription its own hidden host
//     element inside <pan-bus>, so each handler sees each message once.
//
// Per-frame traffic (requestAnimationFrame loops, <cr-bump>'s bump-time,
// video timeupdate) must NOT go through here -- see docs/bus-topics.md.

// ---------------------------------------------------------------------------
// Topic dictionary (single source of truth -- keep docs/bus-topics.md in
// sync). Kinds: state = retained snapshot (`*.state`, publishState());
// event = something happened (past tense); command = imperative request
// for the owner to do something (fire-and-forget).
// ---------------------------------------------------------------------------

export const TOPICS = Object.freeze({
  // ---- app shell (scheduler/index.html) ----
  /** state, retained. {view} -- which top-level scheduler view is shown ("schedule"|"series"|"programming"|"bumps"). Owner: scheduler/js/view.js. */
  APP_VIEW_STATE: "app.view.state",
  /** command. {view} -- switch the top-level scheduler view. Handled by scheduler/js/view.js. */
  APP_VIEW_OPEN: "app.view.open",

  // ---- Google Drive auth (scheduler/js/drive.js) ----
  /** state, retained. {connected} -- whether a valid Drive OAuth token is held. */
  DRIVE_AUTH_STATE: "drive.auth.state",

  // ---- ChannelFlow scheduler store (scheduler/js/store.js) ----
  /** state, retained. {channelId, name} -- the channel being edited. */
  SCHEDULER_CHANNEL_STATE: "scheduler.channel.state",
  /** state, retained. {date, isToday} -- the calendar day being edited (YYYY-MM-DD). */
  SCHEDULER_DATE_STATE: "scheduler.date.state",
  /** state, retained. {blockId|null} -- the selected timeline block. */
  SCHEDULER_SELECTION_STATE: "scheduler.selection.state",
  /** event. {channelId, date} -- blocks of the active schedule were added/moved/edited/removed/replaced. */
  SCHEDULER_BLOCKS_CHANGED: "scheduler.blocks.changed",
  /** event. {kind: "list"|"duration"|"thumbnail", count} -- the media library changed. */
  SCHEDULER_MEDIA_CHANGED: "scheduler.media.changed",
  /** state, retained. {drive: {id,name}|null, reels: {id,name}|null} -- linked Drive folders. */
  SCHEDULER_FOLDERS_STATE: "scheduler.folders.state",
  /** state, retained. {enabled} -- "auto-fill gaps with reels" toggle. */
  SCHEDULER_AUTOFILL_STATE: "scheduler.autofill.state",
  /** event. {publishedAt, target: "local"|"live"} -- a schedule was published. */
  SCHEDULER_SCHEDULE_PUBLISHED: "scheduler.schedule.published",
  /** event, 1 Hz. {now} -- wall-clock tick (UTC seconds of day) for clocks/playheads. The only periodic topic allowed on the bus. */
  SCHEDULER_TICK: "scheduler.tick",

  // ---- Bump Studio (scheduler/js/components/bump-studio/bump-studio-store.js) ----
  /** event. {keys: string[], source: string|null} -- store slices that changed in one mutation (see bump-studio-store.js for the key list). What studio components re-render from. Never carries "playback" (per-frame; see studioStore.transport). */
  STUDIO_CHANGED: "studio.changed",
  /** state, retained. {status: "idle"|"loading"|"ready"|"error", error} -- studio data load status. */
  STUDIO_STATUS_STATE: "studio.status.state",
  /** state, retained. {workspace: "compose"|"schedule"|"library"} -- the visible studio workspace. */
  STUDIO_WORKSPACE_STATE: "studio.workspace.state",
  /** command. {id} -- open a saved bump in Compose (guards unsaved edits). Handled by the studio store. */
  STUDIO_COMPOSE_OPEN: "studio.compose.open",
  /** command. {channelId} -- show a channel in the Schedule workspace. Handled by the studio store. */
  STUDIO_SCHEDULE_OPEN: "studio.schedule.open",
  /** event. {count, source} -- the saved bump list changed (load/save/rename/duplicate/remove). */
  BUMPS_LIST_CHANGED: "bumps.list.changed",
  /** state, retained. {id|null, isNew} -- the bump being edited (id null for a never-saved bump). */
  BUMPS_SELECTION_STATE: "bumps.selection.state",
  /** state, retained. {id|null, isNew, dirty, canSave} -- the draft's save status (NOT its contents; published only when these flags change). */
  BUMPS_DRAFT_STATE: "bumps.draft.state",
  /** event. {id, name, source: "save"|"duplicate"} -- a new bump definition was written to disk. */
  BUMPS_ITEM_CREATED: "bumps.item.created",
  /** event. {id, name, source: "save"|"rename"} -- an existing bump definition was rewritten. */
  BUMPS_ITEM_SAVED: "bumps.item.saved",
  /** event. {id} -- a bump definition was deleted. */
  BUMPS_ITEM_DELETED: "bumps.item.deleted",
  /** event. {channelId, enabled, ruleCount} -- a channel's bump-schedule.json was saved. */
  BUMPS_SCHEDULE_SAVED: "bumps.schedule.saved",

  // ---- channel player (channels/player-view.js, <cr-channel-player>) ----
  /** state, retained. {channelId, state, title, playable, startsAt, endsAt, bumpId} -- what the page's channel player is doing. `state` is BroadcastPlayer's state ("loading"|"buffering"|"playing"|"blocked"|"slate"|"continuity"|"bump"|"error"). */
  PLAYER_STATE: "player.state",
  /** event. {channelId, name, number} -- the player tuned to a different channel. */
  PLAYER_CHANNEL_CHANGED: "player.channel.changed",
  /** event. {channelId, title, playable, startsAt, endsAt} -- a new airing (program or station break) began, or a channel was first loaded. */
  PLAYER_PROGRAM_CHANGED: "player.program.changed",
  /** event. {channelId, bumpId, startsAt, endsAt} -- a clock-scheduled bump took over the screen. */
  PLAYER_BUMP_STARTED: "player.bump.started",
  /** event. {channelId, bumpId} -- that bump's window closed. */
  PLAYER_BUMP_ENDED: "player.bump.ended",
});

/** Every scheduler-store topic except the 1 Hz tick: "the schedule being
 *  edited changed somehow". Components that simply re-render on any
 *  scheduler change subscribe to this list. */
export const SCHEDULER_CHANGE_TOPICS = Object.freeze([
  TOPICS.SCHEDULER_CHANNEL_STATE,
  TOPICS.SCHEDULER_DATE_STATE,
  TOPICS.SCHEDULER_SELECTION_STATE,
  TOPICS.SCHEDULER_BLOCKS_CHANGED,
  TOPICS.SCHEDULER_MEDIA_CHANGED,
  TOPICS.SCHEDULER_FOLDERS_STATE,
  TOPICS.SCHEDULER_AUTOFILL_STATE,
  TOPICS.SCHEDULER_SCHEDULE_PUBLISHED,
]);

// ---------------------------------------------------------------------------
// Matching -- identical semantics to PanBus.matches/PanClient.matches in
// vendor/larc/pan.js: `*` matches exactly one dot-separated segment, a bare
// `*` matches everything.
// ---------------------------------------------------------------------------

export function matches(topic, pattern) {
  if (pattern === "*" || topic === pattern) return true;
  if (pattern && pattern.includes("*")) {
    const esc = (s) => s.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, "[^.]+");
    return new RegExp(`^${esc(pattern)}$`).test(topic);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

const reportError = (err) => {
  if (typeof globalThis.reportError === "function") globalThis.reportError(err);
  else console.error(err);
};

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/** In-memory bus with PanBus semantics, for Node and pages without the
 *  import map. Delivery is synchronous; a throwing handler is reported and
 *  doesn't stop delivery to the others (same as DOM event listeners). */
export function createMemoryBackend() {
  let subs = [];
  const retained = new Map();
  const deliver = (sub, msg) => { try { sub.handler(msg); } catch (err) { reportError(err); } };
  const backend = {
    mode: "memory",
    publish(msg) {
      const full = { ts: Date.now(), id: uuid(), ...msg };
      if (full.retain) retained.set(full.topic, full);
      for (const s of subs) if (s.topics.some((p) => matches(full.topic, p))) deliver(s, full);
    },
    subscribe(topics, handler, { retained: wantRetained = false } = {}) {
      const sub = { topics, handler };
      subs = [...subs, sub];
      if (wantRetained) for (const [topic, msg] of retained) if (topics.some((p) => matches(topic, p))) deliver(sub, msg);
      return () => { subs = subs.filter((s) => s !== sub); };
    },
    request(topic, data, { timeoutMs = 5000 } = {}) {
      const correlationId = uuid();
      const replyTo = `pan:$reply:memory:${correlationId}`;
      return new Promise((resolve, reject) => {
        const off = backend.subscribe([replyTo], (m) => { clearTimeout(timer); off(); resolve(m); });
        const timer = setTimeout(() => { off(); reject(new Error("PAN request timeout")); }, timeoutMs);
        backend.publish({ topic, data, replyTo, correlationId });
      });
    },
  };
  return backend;
}

/** Backend over the real vendored LARC bus (`@larcjs/core` 3.0.1). */
async function createPanBackend() {
  const { createClient, PanClient } = await import("@larcjs/core");
  const client = createClient(document); // ensureBus() + a document-hosted client used for publish/request
  await client.ready();
  const busEl = document.querySelector("pan-bus");
  return {
    mode: "pan",
    publish(msg) { client.publish(msg); },
    subscribe(topics, handler, { retained = false } = {}) {
      const host = document.createElement("pan-subscription");
      host.hidden = true;
      busEl.append(host);
      const sub = new PanClient(host);
      const off = sub.subscribe(topics, handler, { retained });
      return () => { off(); host.remove(); };
    },
    request(topic, data, opts) { return client.request(topic, data, opts); },
  };
}

const hasDom = typeof document !== "undefined" && typeof customElements !== "undefined" && typeof HTMLElement !== "undefined";

let backend = null;
let loading = null;
let pending = [];

function load() {
  if (loading) return loading;
  if (!hasDom) {
    backend = createMemoryBackend();
    loading = Promise.resolve(backend);
    return loading;
  }
  loading = createPanBackend()
    .catch((err) => {
      console.warn("[bus] @larcjs/core unavailable (missing import map?) -- using the in-memory fallback bus.", err);
      return createMemoryBackend();
    })
    .then((b) => {
      backend = b;
      const queued = pending;
      pending = [];
      for (const fn of queued) fn(b);
      return b;
    });
  return loading;
}

// Start loading as soon as anything imports this module (in Node the
// in-memory backend is ready synchronously).
load();

function withBackend(fn) {
  if (backend) fn(backend);
  else { pending.push(fn); load(); }
}

/** Ignores repeat deliveries of the same message id (a subscription whose
 *  patterns overlap, e.g. ["a.*", "a.b"], gets one delivery per matching
 *  pattern from PanBus). */
function dedupe(handler) {
  const seen = [];
  return (msg) => {
    if (msg.id) {
      if (seen.includes(msg.id)) return;
      seen.push(msg.id);
      if (seen.length > 32) seen.shift();
    }
    handler(msg);
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolves once the bus is usable; `mode` is "pan" (real LARC bus) or
 *  "memory" (Node / fallback). */
export function ready() { return load().then((b) => ({ mode: b.mode })); }

/** "pan" | "memory" | null (still loading). */
export function busMode() { return backend ? backend.mode : null; }

/** Publish an event or command. `data` must be JSON-serializable. */
export function publish(topic, data = null, { retain = false } = {}) {
  const msg = retain ? { topic, data, retain: true } : { topic, data };
  withBackend((b) => b.publish(msg));
}

const lastState = new Map();

/** Publish a `.state` topic: always retained, and skipped when `data` is
 *  identical (JSON) to the last snapshot published on that topic, so
 *  state subscribers only hear about real changes. */
export function publishState(topic, data) {
  const json = JSON.stringify(data);
  if (lastState.get(topic) === json) return false;
  lastState.set(topic, json);
  publish(topic, data, { retain: true });
  return true;
}

/** Subscribe to one topic or pattern, or an array of them. `handler(msg)`
 *  receives the full PAN message ({topic, data, id, ts, ...}). Options:
 *  `retained` -- also deliver the current retained snapshot(s) right away;
 *  `signal` -- an AbortSignal that unsubscribes (the usual pattern in a
 *  custom element: create an AbortController in connectedCallback, abort
 *  it in disconnectedCallback). Returns an unsubscribe function. */
export function subscribe(topics, handler, { retained = false, signal } = {}) {
  const list = Array.isArray(topics) ? [...topics] : [topics];
  let off = null;
  let cancelled = false;
  const unsubscribe = () => {
    if (cancelled) return;
    cancelled = true;
    off?.();
    off = null;
  };
  if (signal?.aborted) return unsubscribe;
  signal?.addEventListener("abort", unsubscribe, { once: true });
  withBackend((b) => {
    if (cancelled) return;
    const stop = b.subscribe(list, dedupe(handler), { retained });
    // A retained delivery runs inside b.subscribe(); if its handler already
    // unsubscribed, honour that now that there is something to stop.
    if (cancelled) stop();
    else off = stop;
  });
  return unsubscribe;
}

/** Request/reply: publishes `data` on `topic` and resolves with the
 *  responder's result (see respond()), or rejects with its error or on
 *  timeout. */
export async function request(topic, data = null, { timeoutMs = 5000 } = {}) {
  const b = await load();
  const reply = await b.request(topic, data, { timeoutMs });
  const body = reply?.data;
  if (body && body.ok === false) throw new Error(body.error || "request failed");
  return body?.result;
}

/** Answers request()s on `topic` with `fn(data, msg)` (sync or async).
 *  Replies are `{ok: true, result}` or `{ok: false, error}`. Returns an
 *  unsubscribe function; accepts the same `signal` option as subscribe(). */
export function respond(topic, fn, { signal } = {}) {
  return subscribe(topic, async (msg) => {
    if (!msg.replyTo) return;
    let body;
    try { body = { ok: true, result: await fn(msg.data, msg) }; }
    catch (err) { body = { ok: false, error: String(err?.message || err) }; }
    withBackend((b) => b.publish({ topic: msg.replyTo, data: body, correlationId: msg.correlationId }));
  }, { signal });
}

/** Test-only: drops the current backend, queued calls and state-dedupe
 *  cache and starts over with a fresh in-memory backend. */
export function _resetForTests() {
  if (hasDom) throw new Error("_resetForTests() is only for Node tests");
  backend = null;
  loading = null;
  pending = [];
  lastState.clear();
  load();
}
