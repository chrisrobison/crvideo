// channels/player-view.js
//
// <cr-channel-player>: the one full-player implementation shared by
// channels/watch.html (standalone, full-viewport, deep-linkable) and
// channels/index.html (the guide's small preview tile, which expands this
// same element in place). Because expanding never tears down or recreates
// the element, the stream isn't re-buffered, and the same click that expands
// it can also unmute and go fullscreen (see engage()); a freshly opened
// window's first paint carries no user activation, which is why a popup
// player could only unmute. See index.html's expandChannel(), which just
// reparents the already-playing element.
//
// Shadow DOM, no build step, like continuity-card.js. Descendants are sized
// `position:absolute; inset:0` against this host; :host itself decides
// whether it fills the viewport or is sized by its parent via the `compact`
// attribute (see the CSS).
//
// Public surface a host page uses:
//   - `compact` attribute/property: minimal chrome, sized by the parent.
//     Purely cosmetic; the BroadcastPlayer and what it's playing are
//     unaffected.
//   - `standalone` property (default true): whether this instance owns the
//     page's URL/title (watch.html) or not (index.html). false suppresses the
//     history.replaceState()/document.title side effects of tune() and
//     onAiring().
//   - `.tune(channelId)`: load and switch to a channel.
//   - `.engage()`: unmute + request fullscreen on this element. Call it
//     directly from a click/keydown handler, never from inside a
//     `document.startViewTransition()` callback or other microtask: browsers
//     grant unmuted autoplay/fullscreen only to a call still carrying the
//     original user activation.
//   - `.player` (the BroadcastPlayer) / `.channel` (the loaded channel
//     record): read-only, for hosts that build their own "what's on" UI.
//   - `cr-channel-change` event: fired after tune() switches to a different
//     channel (including via remote-control surfing), so a host can keep its
//     own UI in sync.
//   - `cr-back` event (cancelable): the built-in "‹ Channel guide" link
//     dispatches it before navigating. A host that wants its own behavior
//     (index.html: shrink back into the tile) calls `event.preventDefault()`,
//     which also cancels the link's navigation; watch.html just doesn't listen.
//   - `cr-airing` event: fired on every airing (program/break) change.
//
// Page bus (js/bus.js, docs/bus-topics.md): the DOM events above remain the
// API for the direct host; discrete page-level facts are also published on
// the bus -- player.state (retained snapshot), player.channel.changed,
// player.program.changed, player.bump.started / player.bump.ended. Nothing
// per-frame (video time, <cr-bump>'s bump-time) is published.

import {
  CHANNEL_ID, listChannels, loadChannel, loadCatalog, loadTheme, loadAnnouncements, loadBumpSchedule, loadBumpDefinitionsFor,
  airings, nextProgram, now, clock, minutesLeft, BroadcastPlayer,
} from "./broadcast.js";
import { TOPICS, publish, publishState } from "../js/bus.js";

const COMING_UP = 4; // programs listed under "Coming Up", after the "Up Next" one

const TEMPLATE = `
<style>
:host {
  display: block; position: fixed; inset: 0; background: #000; color: #fff;
  font: 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  overflow: hidden; --accent: #ffcc33; --muted: #a3adbf; --live: #ff4b4b;
}
:host([compact]) { position: relative; inset: auto; width: 100%; height: 100%; }
:host(.idle) { cursor: none; }
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; border: 0; cursor: pointer; background: none; }
[hidden] { display: none !important; }

video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
.ytPlayer { position: absolute; inset: 0; width: 100%; height: 100%; background: #000; }
.ytPlayer iframe { width: 100%; height: 100%; display: block; }

.slate { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden;
  padding: clamp(14px,6vh,72px) clamp(12px,6vw,96px); background: radial-gradient(circle at 30% 35%,#1b2643,#020306 75%); }
.card { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: clamp(16px,5vw,88px); align-items: center; width: min(1400px,100%); }
.card img { display: block; height: clamp(28px,9vh,96px); margin-bottom: clamp(10px,4vh,40px); }
.fillerHost:not([hidden]) ~ .slate { background: none; }
.slate .label { color: var(--accent); font-weight: 800; letter-spacing: .14em; text-transform: uppercase; font-size: clamp(11px,1.4vw,18px); }
.upnext .title { font-size: clamp(20px,4.8vw,76px); font-weight: 800; line-height: 1.05; margin: 8px 0 12px; text-wrap: balance; }
.upnext .when { font-size: clamp(14px,2vw,28px); font-variant-numeric: tabular-nums; }
.upnext .when .count { color: var(--accent); }
.upnext .about { color: var(--muted); font-size: clamp(12px,1.5vw,20px); margin-top: 6px; }
.slate .msg { display: inline-block; margin-bottom: 14px; padding: 5px 10px; border-radius: 4px; background: rgba(255,75,75,.16); color: #ff9d9d; font-weight: 700; }
.coming { border-left: 1px solid rgba(255,255,255,.16); padding-left: clamp(14px,4vw,64px); }
.coming ol { list-style: none; margin: 12px 0 0; padding: 0; display: grid; grid-template-columns: auto minmax(0,1fr);
  column-gap: clamp(10px,2vw,28px); row-gap: clamp(8px,2.4vh,22px); align-items: baseline; font-size: clamp(13px,2vw,28px); line-height: 1.2; }
.coming li { display: contents; }
.coming time { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
.coming .t { font-weight: 700; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
:host([compact]) .coming { display: none; }
:host([compact]) .card { grid-template-columns: 1fr; text-align: center; }
:host([compact]) .card img { margin-inline: auto; }
@media (max-width: 820px), (orientation: portrait) {
  .card { grid-template-columns: 1fr; text-align: center; }
  .card img { margin-inline: auto; }
  .coming { border-left: 0; padding-left: 0; border-top: 1px solid rgba(255,255,255,.16); padding-top: clamp(12px,3vh,28px); }
  .coming ol { width: fit-content; max-width: 100%; margin-inline: auto; text-align: left; }
}
:host(.on-break) .lower, :host(.on-break) .bug { display: none; }
:host(.on-break) .hint { bottom: clamp(12px,4vh,40px); }

.continuityHost { position: absolute; inset: 0; }
.continuityHost cr-continuity-card { position: absolute; inset: 0; }
.bumpHost { position: absolute; inset: 0; }
.bumpHost cr-bump { position: absolute; inset: 0; }
.fillerHost { position: absolute; inset: 0; }

.bug { position: absolute; top: clamp(8px,3vh,32px); right: clamp(8px,3vw,40px); height: clamp(20px,6vh,64px); opacity: .55; pointer-events: none; }

.osd { position: absolute; top: clamp(8px,3vh,32px); left: clamp(8px,3vw,40px); font-size: clamp(26px,7vh,72px); font-weight: 800; color: var(--accent);
  text-shadow: 0 2px 8px rgba(0,0,0,.8); font-variant-numeric: tabular-nums; transition: opacity .3s; pointer-events: none; }

.lower { position: absolute; left: 0; right: 0; bottom: 0; padding: 40px clamp(12px,4vw,56px) clamp(14px,5vh,48px);
  background: linear-gradient(transparent,rgba(0,0,0,.85) 55%); transition: opacity .3s; pointer-events: none; }
.lower.off { opacity: 0; }
.lower .ch { display: flex; align-items: center; gap: 10px; color: var(--muted); font-weight: 700; }
.lower .ch .num { color: var(--accent); font-size: 18px; }
.lower .ch img { height: 22px; }
.lower .ch .live { background: var(--live); color: #fff; font-size: 11px; letter-spacing: .08em; padding: 2px 6px; border-radius: 3px; }
.lower h1 { margin: 6px 0 4px; font-size: clamp(18px,4vw,44px); line-height: 1.1; }
.lower .sub { color: var(--muted); font-variant-numeric: tabular-nums; }
.lower .sub b { color: #fff; }
.lower .guide { pointer-events: auto; color: var(--muted); text-decoration: none; font-size: 13px; display: inline-block; margin-top: 8px; }
.lower .guide:hover { color: #fff; }
:host([compact]) .lower { display: none; }

.hint { position: absolute; left: 50%; bottom: clamp(70px,22vh,200px); transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
  background: rgba(0,0,0,.72); border: 1px solid rgba(255,255,255,.25); border-radius: 999px; padding: 10px 16px; font-weight: 700; white-space: nowrap;
  box-shadow: 0 6px 24px rgba(0,0,0,.5); pointer-events: auto; }
.hint svg { width: 18px; height: 18px; flex: none; }
:host([compact]) .hint { display: none; }

.spinner { position: absolute; left: 50%; top: 50%; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%;
  border: 4px solid rgba(255,255,255,.2); border-top-color: #fff; animation: cr-spin 1s linear infinite; pointer-events: none; }
@keyframes cr-spin { to { transform: rotate(360deg); } }

.fatal { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  color: var(--muted); text-align: center; padding: 24px; }
.fatal a { color: var(--accent); pointer-events: auto; }
</style>
<video class="screen" muted playsinline autoplay></video>
<div class="ytPlayer" hidden></div>
<div class="continuityHost" hidden></div>
<div class="bumpHost" hidden></div>
<div class="fillerHost" hidden></div>

<div class="slate" hidden>
  <div class="card">
    <div class="upnext">
      <img class="slateLogo" alt="">
      <div class="msg" hidden>Signal lost, reconnecting…</div>
      <div class="label">Up Next</div>
      <div class="title"></div>
      <div class="when"></div>
      <div class="about"></div>
    </div>
    <div class="coming" hidden>
      <div class="label">Coming Up</div>
      <ol class="comingList"></ol>
    </div>
  </div>
</div>

<img class="bug" alt="" hidden>
<div class="osd" hidden></div>
<div class="spinner" hidden></div>

<div class="lower off">
  <div class="ch"><span class="num"></span><img class="lLogo" alt="" hidden><span class="lName"></span><span class="live">LIVE</span></div>
  <h1 class="lTitle"></h1>
  <div class="sub"></div>
  <a class="guide" href="./">‹ Channel guide</a>
</div>

<button class="hint" hidden>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6"/><path d="m17 9 6 6"/>
  </svg>
  <span class="hintText">Click for sound and full screen</span>
</button>

<div class="fatal" hidden></div>
`;

const HTMLElementBase = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

export class ChannelPlayer extends HTMLElementBase {
  static get observedAttributes() { return ["compact"]; }

  constructor() {
    super();
    this._root = this.attachShadow({ mode: "open" });
    this._root.innerHTML = TEMPLATE;
    this.standalone = true;

    this._channel = null;
    this._lineup = null;
    this._infoTimer = 0;
    this._idleTimer = 0;
    this._osdTimer = 0;
    this._dialed = "";
    this._dialTimer = 0;
    this._engaged = false;
    this._slateKey = null;
    this._busBump = null; // the activeBump last announced on the bus
    this._boundKeydown = (e) => this._onKeydown(e);

    const q = (sel) => this._root.querySelector(sel);
    this.player = new BroadcastPlayer(q(".screen"), {
      youtubeContainer: q(".ytPlayer"),
      continuityContainer: q(".continuityHost"),
      bumpContainer: q(".bumpHost"),
      fillerContainer: q(".fillerHost"),
      onAiring: (airing) => this._onAiring(airing),
      onState: (state, airing) => this._onState(state, airing),
    });

    q(".guide").addEventListener("click", (e) => {
      const allowDefault = this.dispatchEvent(new CustomEvent("cr-back", { cancelable: true }));
      if (!allowDefault) e.preventDefault();
    });
    // Click-to-engage/dblclick-to-fullscreen apply only when this is the full
    // player. In compact mode a click means whatever the HOST decides
    // (index.html: expand), so this component stays out of the way.
    this.addEventListener("click", (e) => {
      if (this.compact || e.target.closest("a, button")) return;
      const wasEngaged = this._engaged && !this.player.isMuted();
      this.engage();
      this._updateHint();
      if (wasEngaged) this._showInfo();
    });
    this.addEventListener("dblclick", (e) => { if (!this.compact && !e.target.closest("a")) this._toggleFullscreen(); });
    this.addEventListener("mousemove", () => { this._wake(); this._showInfo(3000); });
    q(".hint").addEventListener("click", () => { this.engage(); this._updateHint(); });
  }

  connectedCallback() {
    this.player.start();
    this._wake();
    if (!this._everySecond) {
      this._everySecond = setInterval(() => { this._renderInfo(); this._publishPlayerState(); }, 1000);
    }
    if (!this.compact) document.addEventListener("keydown", this._boundKeydown);
  }

  disconnectedCallback() {
    clearInterval(this._everySecond);
    this._everySecond = 0;
    document.removeEventListener("keydown", this._boundKeydown);
  }

  attributeChangedCallback(name) {
    if (name !== "compact") return;
    if (!this.isConnected) return;
    if (this.compact) document.removeEventListener("keydown", this._boundKeydown);
    else document.addEventListener("keydown", this._boundKeydown);
  }

  get compact() { return this.hasAttribute("compact"); }
  set compact(v) { this.toggleAttribute("compact", !!v); }

  get channel() { return this._channel; }

  // ---------- tuning ----------

  async tune(id) {
    let next;
    try {
      next = await loadChannel(id);
    } catch (err) {
      console.error(err);
      if (!this._channel) this._fatal(`Channel "${id}" is off the air.`);
      return;
    }
    const changed = this._channel?.id !== next.id;
    this._channel = next;
    if (this.standalone) {
      history.replaceState(null, "", `?ch=${encodeURIComponent(id)}`);
    }
    const q = (sel) => this._root.querySelector(sel);
    loadTheme(next).then((bumperTheme) => {
      if (this._channel !== next) return;
      this._bumperTheme = bumperTheme;
      // Patch the running player's channelMeta in place (see
      // BroadcastPlayer.updateChannelMeta()): a continuity card that appears
      // after this resolves picks up the theme; one already on screen doesn't.
      this.player.updateChannelMeta({ bumperTheme });
    });
    // This channel's announcements.json manifest (see loadAnnouncements()).
    loadAnnouncements(next).then((announcements) => {
      if (this._channel !== next) return;
      this._announcements = announcements;
      this.player.updateChannelMeta({ announcements });
    });
    // Clock-anchored bump schedule (see player-adapters.js's "bump scheduling"
    // header). Each referenced bumps/<id>.json is resolved in the same chain
    // so `bumpDefinitions` is never patched in before `bumpSchedule`.
    loadBumpSchedule(next).then(async (schedule) => {
      if (this._channel !== next) return;
      const rules = schedule.enabled ? schedule.rules : [];
      const bumpDefinitions = await loadBumpDefinitionsFor(rules);
      if (this._channel !== next) return;
      this._bumpSchedule = rules;
      this._bumpDefinitions = bumpDefinitions;
      this.player.updateChannelMeta({ bumpSchedule: rules, bumpDefinitions });
    });
    for (const img of [q(".bug"), q(".slateLogo"), q(".lLogo")]) {
      img.hidden = !next.logo;
      if (next.logo) img.src = next.logo;
    }
    q(".num").textContent = next.number ?? "";
    q(".lName").textContent = next.name;
    if (next.number != null) this._flashOsd(String(next.number));
    this.player.setTimeline(next.timeline, {
      id: next.id, name: next.name, logo: next.logo, theme: next.theme, bumperTheme: this._bumperTheme, announcements: this._announcements,
      bumpSchedule: this._bumpSchedule, bumpDefinitions: this._bumpDefinitions,
    });
    this._updateHint();
    if (changed) {
      this.dispatchEvent(new CustomEvent("cr-channel-change", { detail: { channel: next } }));
      publish(TOPICS.PLAYER_CHANNEL_CHANGED, { channelId: next.id, name: next.name ?? null, number: next.number ?? null });
    }
  }

  // ---------- sound + full screen ----------
  // Call engage() directly from a user gesture (click/keydown), never from a
  // promise callback or startViewTransition() callback, so the browser still
  // credits the original gesture for unmuted autoplay/requestFullscreen().

  /** Unmute (+, by default, request real browser fullscreen); see the class
   *  header for the user-gesture requirement. `{ fullscreen: false }` skips
   *  the OS-level fullscreen request, e.g. index.html's in-page "theater"
   *  expand, which leaves real fullscreen as a separate action (dblclick/'f'). */
  engage({ fullscreen = true } = {}) {
    if (this.player.state === "blocked") this.player.resume();
    this.player.setMuted(false);
    if (!this._engaged && fullscreen) this._enterFullscreen();
    this._engaged = true;
  }

  isFullscreen() { return document.fullscreenElement === this; }

  _enterFullscreen() {
    if (!this.isFullscreen() && this.requestFullscreen) this.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  }

  _toggleFullscreen() {
    if (this.isFullscreen()) document.exitFullscreen().catch(() => {});
    else this._enterFullscreen();
  }

  // ---------- rendering ----------

  _onAiring(airing) {
    if (this.standalone) {
      document.title = this._channel ? `${this._channel.name} · ${airing.playable ? airing.title : "Station break"}` : "Watch";
    }
    this._renderInfo();
    if (airing.playable) this._showInfo(7000);
    // For hosts with their own "what's on" UI next to this element; fires on
    // every program transition and right after tune() first loads a channel.
    this.dispatchEvent(new CustomEvent("cr-airing", { detail: { airing } }));
    publish(TOPICS.PLAYER_PROGRAM_CHANGED, {
      channelId: this._channel?.id ?? null, title: airing.playable ? airing.title : null,
      playable: !!airing.playable, startsAt: airing.startsAt ?? null, endsAt: airing.endsAt ?? null,
    });
    this._publishPlayerState();
  }

  /** Mirrors the player's discrete state onto the bus: the retained
   *  player.state snapshot (publishState() skips unchanged snapshots, so
   *  the 1 Hz call from connectedCallback's timer is cheap) plus
   *  player.bump.started/ended whenever BroadcastPlayer.activeBump changes
   *  (checked here rather than only on state changes, because two
   *  back-to-back bump windows never leave the "bump" state). */
  _publishPlayerState() {
    const channelId = this._channel?.id ?? null;
    const bump = this.player.activeBump;
    const prev = this._busBump;
    if (prev !== bump && (prev?.bumpId !== bump?.bumpId || prev?.startsAt !== bump?.startsAt)) {
      if (prev) publish(TOPICS.PLAYER_BUMP_ENDED, { channelId, bumpId: prev.bumpId });
      if (bump) publish(TOPICS.PLAYER_BUMP_STARTED, { channelId, bumpId: bump.bumpId, startsAt: bump.startsAt ?? null, endsAt: bump.endsAt ?? null });
    }
    this._busBump = bump;
    const a = this.player.airing;
    publishState(TOPICS.PLAYER_STATE, {
      channelId, state: this.player.state ?? null,
      title: a?.playable ? a.title : null, playable: !!a?.playable,
      startsAt: a?.startsAt ?? null, endsAt: a?.endsAt ?? null,
      bumpId: bump?.bumpId ?? null,
    });
  }

  _onState(state, airing) {
    const q = (sel) => this._root.querySelector(sel);
    const continuity = state === "continuity";
    const bump = state === "bump";
    const slate = !continuity && !bump && (state === "slate" || state === "error" || !airing?.playable);
    q(".slate").hidden = !slate;
    q(".continuityHost").hidden = !continuity;
    q(".bumpHost").hidden = !bump;
    this.classList.toggle("on-break", slate || continuity || bump);
    q(".msg").hidden = state !== "error";
    q(".spinner").hidden = !(state === "loading" || state === "buffering");
    if (state === "blocked") {
      q(".hintText").textContent = "Click to start watching";
      q(".hint").hidden = false;
    }
    this._renderInfo();
    this._publishPlayerState();
  }

  _renderInfo() {
    const q = (sel) => this._root.querySelector(sel);
    const a = this.player.airing;
    if (!this._channel || !a) return;
    const t = now();
    const next = nextProgram(this._channel.timeline, t);
    q(".lTitle").textContent = a.playable ? a.title : "Station break";
    const sub = q(".sub");
    sub.replaceChildren(`${clock(a.startsAt)} – ${clock(a.endsAt)} · ${minutesLeft(a.endsAt - t)} left`);
    if (next) sub.append("  ·  Next: ", Object.assign(document.createElement("b"), { textContent: next.title }), ` at ${clock(next.startsAt)}`);
    if (!q(".slate").hidden) this._renderSlate(t);
  }

  _renderSlate(t) {
    const q = (sel) => this._root.querySelector(sel);
    const ch = this._channel;
    const [next, ...later] = airings(ch.timeline, t, t + 12 * 3600)
      .filter((a) => a.playable && a.startsAt > t)
      .slice(0, 1 + COMING_UP);
    if (!next) return;

    const key = `${ch.id}@${next.startsAt}`;
    if (key !== this._slateKey) {
      this._slateKey = key;
      q(".title").textContent = next.title;
      q(".about").textContent = "";
      loadCatalog(ch).then((catalog) => {
        const item = catalog.get(next.id);
        if (item && this._slateKey === key) q(".about").textContent = [item.year, item.creator].filter(Boolean).join(" · ");
      });
      q(".comingList").replaceChildren(...later.map((a) => {
        const li = document.createElement("li");
        const time = Object.assign(document.createElement("time"), {
          dateTime: new Date(a.startsAt * 1000).toISOString(), textContent: clock(a.startsAt),
        });
        li.append(time, Object.assign(document.createElement("span"), { className: "t", textContent: a.title, title: a.title }));
        return li;
      }));
      q(".coming").hidden = !later.length;
    }

    const wait = Math.max(0, Math.round(next.startsAt - t));
    const when = q(".when");
    when.replaceChildren(clock(next.startsAt));
    if (wait < 600) {
      when.append(" · ", Object.assign(document.createElement("span"), {
        className: "count", textContent: `starts in ${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, "0")}`,
      }));
    }
  }

  _showInfo(ms = 4000) {
    const lower = this._root.querySelector(".lower");
    lower.classList.remove("off");
    clearTimeout(this._infoTimer);
    this._infoTimer = setTimeout(() => lower.classList.add("off"), ms);
  }

  _flashOsd(text, ms = 3000) {
    const osd = this._root.querySelector(".osd");
    osd.textContent = text;
    osd.hidden = false;
    clearTimeout(this._osdTimer);
    this._osdTimer = setTimeout(() => { osd.hidden = true; }, ms);
  }

  _fatal(message) {
    const box = this._root.querySelector(".fatal");
    const back = Object.assign(document.createElement("a"), { href: "./", textContent: "Back to the channel guide" });
    back.addEventListener("click", (e) => {
      const allowDefault = this.dispatchEvent(new CustomEvent("cr-back", { cancelable: true }));
      if (!allowDefault) e.preventDefault();
    });
    box.replaceChildren(Object.assign(document.createElement("div"), { textContent: message }), back);
    box.hidden = false;
  }

  _updateHint() {
    const q = (sel) => this._root.querySelector(sel);
    if (this.player.state === "blocked") return;
    q(".hintText").textContent = "Click for sound and full screen";
    q(".hint").hidden = !this.player.isMuted();
  }

  _wake() {
    this.classList.remove("idle");
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this.classList.add("idle"), 3000);
  }

  // ---------- remote control (channel surf/dial) -- wired up only while this
  // element isn't compact, so the guide's arrow-key row navigation isn't
  // intercepted by the small preview tile. ----------

  async _surf(step) {
    try { this._lineup ??= await listChannels(); } catch { return; }
    if (!this._lineup.length) return;
    const i = this._lineup.findIndex((c) => c.id === this._channel?.id);
    const next = this._lineup[(Math.max(i, 0) + step + this._lineup.length) % this._lineup.length];
    if (next && next.id !== this._channel?.id) this.tune(next.id);
  }

  _dial(digit) {
    this._dialed = (this._dialed + digit).slice(-4);
    this._flashOsd(`${this._dialed}-`, 2000);
    clearTimeout(this._dialTimer);
    this._dialTimer = setTimeout(async () => {
      const number = Number(this._dialed);
      this._dialed = "";
      try { this._lineup ??= await listChannels(); } catch { return; }
      const match = this._lineup.find((c) => Number(c.number) === number);
      if (match) this.tune(match.id);
      else this._flashOsd(`${number} —`, 1500);
    }, 1300);
  }

  _onKeydown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key;
    if (key === "f" || key === "F") { this._toggleFullscreen(); this._engaged = true; }
    else if (key === "m" || key === "M") { if (this.player.state === "blocked") this.player.resume(); this.player.setMuted(!this.player.isMuted()); }
    else if (key === "i" || key === "I" || key === "Enter" || key === " ") { e.preventDefault(); if (!this._engaged) this.engage(); this._showInfo(); }
    else if (key === "ArrowUp" || key === "PageUp" || key === "+") { e.preventDefault(); this._surf(1); }
    else if (key === "ArrowDown" || key === "PageDown" || key === "-") { e.preventDefault(); this._surf(-1); }
    else if (/^[0-9]$/.test(key)) this._dial(key);
    else return;
    this._updateHint();
  }
}

if (typeof customElements !== "undefined" && !customElements.get("cr-channel-player")) {
  customElements.define("cr-channel-player", ChannelPlayer);
}

export { CHANNEL_ID };
