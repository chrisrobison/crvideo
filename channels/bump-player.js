// channels/bump-player.js
//
// <cr-bump>: a dependency-free Web Component (shadow DOM, no build step --
// same posture as channels/continuity-card.js) that renders a produced
// "bump" interstitial: a looping background video/image/color, 0-2 looping
// background-audio layers, an optional single voice-over clip, and a list
// of upcoming shows' titles/times. See bumps/README.md for the full
// schema and the "not the same thing as theme.json's bumpers" distinction.
//
// This component decides NOTHING about scheduling or content -- same
// contract as continuity-card.js. `.definition` is the bump's own JSON
// object (background/audio/announcement/upcoming/style); `.upcoming` is
// the caller-supplied list of real {title, startsAt, subtitle?} entries --
// NEVER invented or stored here, see bumps/README.md's "upcoming.count"
// note for why. The Bump Studio preview (scheduler/js/components/
// bump-studio/bump-preview.js) feeds either editable sample rows or a real
// channel's real current lineup (via channels/broadcast.js, read-only);
// live playback (BumpRenderer in player-adapters.js) feeds the real channel
// being interrupted.
//
// Unlike continuity-card.js (which auto-renders/auto-plays its narration
// the instant ContinuityRenderer.show() sets its properties, because it's
// always mounted into an already-live, always-playing broadcast), nothing
// here auto-plays on connect: the creator UI mounts one well before anyone
// has clicked a preview button, and firing audio/video the instant a field
// changes while editing would be unusable. Playback is only ever started
// by an explicit `.play()` call (ideally from a user gesture's own call
// stack, same autoplay-policy posture as the rest of this project) and
// stopped by `.stop()`; `.setMuted()` can be called at any time.

import { formatCountdown } from "./continuity-card.js";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

// ---------- pure, unit-testable helpers ----------

/** Clamps to the [0,1] volume range Html5/Web Audio expects, tolerating a
 *  missing/non-numeric value by falling back to `fallback` rather than
 *  producing NaN (which would silently mute the element). */
export function clampVolume(v, fallback = 0.6) {
  if (v === null || v === undefined) return fallback; // `Number(null)` is 0 -- a legit volume, so "missing" must be checked before the numeric coercion below
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** The volume an audio layer should drop to while the announcement clip is
 *  playing ("ducking") -- `base` is the layer's own configured volume,
 *  `duckTo` (0-1, from announcement.duckTo) is how much of it survives. */
export function duckedVolume(base, duckTo) {
  return clampVolume(base, 0) * clampVolume(duckTo, 0.3);
}

/** Slices/validates a caller-supplied upcoming-shows list down to at most
 *  `count` playable entries with a finite `startsAt` -- never throws on a
 *  malformed entry (an unknown/partial item is just dropped), since this
 *  feeds straight into rendering with no other validation layer in front
 *  of it (unlike every PHP-side bump field, which server/bump-admin.php
 *  already validates before it's ever stored). */
export function normalizeUpcoming(list, count) {
  const n = Math.max(0, Math.min(6, Math.trunc(Number(count) || 0)));
  if (!Array.isArray(list) || n === 0) return [];
  return list
    .filter((item) => item && typeof item.title === "string" && Number.isFinite(item.startsAt))
    .slice(0, n);
}

// ---------- composition timing (schema_version 2, see bumps/README.md "Timing") ----------
//
// ONE composition-time model shared by the editor preview and live channel
// playback: `t` = seconds since the bump began. Everything the player
// shows/plays is a pure function of `t` (layerStateAt / mediaPosition),
// and `t` itself is always DERIVED from a clock reading (CompositionClock),
// never accumulated from timer ticks -- so a throttled background tab, a
// late rAF, or a slow media seek can never make it drift. Live playback
// starts the clock at the clock-derived offset into the scheduled window
// (BumpRenderer.show()'s `offset`), so a viewer who tunes in mid-bump sees
// and hears exactly what everyone else does at that instant.

/** Composition length the EDITOR uses for a bump with no explicit
 *  `duration` (every schema_version-1 bump). Display/preview only: it never
 *  changes on-air behavior -- a v1 bump on air still runs for exactly its
 *  schedule rule's durationSeconds, with no composition looping. */
export const DEFAULT_BUMP_DURATION = 15;

/** A bump's explicit composition length in seconds, or null (v1 / unset). */
export function bumpDuration(def) {
  const d = Number(def?.duration);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/** Explicit duration, else the documented editor default. */
export function effectiveDuration(def, fallback = DEFAULT_BUMP_DURATION) {
  return bumpDuration(def) ?? fallback;
}

/** Normalized timing for a definition. `upcomingEnd` is Infinity when not
 *  set, so a v1 bump's text is visible for the whole interruption window
 *  exactly as before; announcementStart 0 matches v1's "plays at once". */
export function bumpTiming(def) {
  const duration = bumpDuration(def);
  const num = (v, fb) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fb);
  const announcementStart = Math.max(0, num(def?.announcement?.start, 0));
  const upcomingStart = Math.max(0, num(def?.upcoming?.start, 0));
  const upcomingEnd = num(def?.upcoming?.end, Infinity);
  return { duration, announcementStart, upcomingStart, upcomingEnd };
}

/**
 * Maps real elapsed seconds since the bump began to composition time.
 * mode "continue" (live default): a bump WITH an explicit duration loops
 * its composition when the schedule window outlasts it; a v1 bump (no
 * duration) just keeps running, exactly as before. "loop": always wrap at
 * the effective duration. "stop": clamp at the effective duration.
 */
export function compositionTime(elapsed, def, mode = "continue") {
  const e = Math.max(0, Number(elapsed) || 0);
  const explicit = bumpDuration(def);
  if (mode === "stop") return Math.min(e, effectiveDuration(def));
  const wrapAt = mode === "loop" ? effectiveDuration(def) : explicit;
  return wrapAt ? e % wrapAt : e;
}

/**
 * What should be visible/audible at composition time `t`. `announcementDuration`
 * is the clip's real length when known (metadata loaded), else null --
 * then the clip counts as active from its start until it ends on its own.
 */
export function layerStateAt(def, t, { announcementDuration = null } = {}) {
  const { announcementStart, upcomingStart, upcomingEnd } = bumpTiming(def);
  const textVisible = t >= upcomingStart && t < upcomingEnd;
  let announcement = null;
  if (def?.announcement?.url) {
    const offset = t - announcementStart;
    const known = Number.isFinite(announcementDuration) && announcementDuration > 0;
    const active = offset >= 0 && (!known || offset < announcementDuration);
    announcement = { active, offset: Math.max(0, offset), before: offset < 0 };
  }
  return { textVisible, announcement };
}

/** Where a media element should be at composition time `t`: looping media
 *  wraps by its own length; one-shot media clamps at its end. `mediaDuration`
 *  unknown (metadata not loaded) => `t` as-is. */
export function mediaPosition(t, mediaDuration, loop) {
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return Math.max(0, t);
  return loop ? ((t % mediaDuration) + mediaDuration) % mediaDuration : Math.min(Math.max(0, t), mediaDuration);
}

/** True when a playing element is far enough from `target` to need a seek
 *  -- a small tolerance so we never fight the element's own clock. For
 *  looping media the distance is measured around the loop seam. */
export function needsResync(current, target, { tolerance = 0.35, loopLength = null } = {}) {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return false;
  let diff = Math.abs(current - target);
  if (Number.isFinite(loopLength) && loopLength > 0) diff = Math.min(diff, loopLength - diff);
  return diff > tolerance;
}

/** How a schedule rule's window relates to a bump's composition length:
 *  "open" (v1 bump -- the rule alone decides), "exact", "cut" (the window
 *  ends before the composition does), or "loop" (it outlasts it). */
export function scheduleFit(ruleDurationSeconds, def) {
  const d = bumpDuration(def);
  const r = Number(ruleDurationSeconds);
  if (!d || !Number.isFinite(r)) return "open";
  if (Math.abs(r - d) < 0.01) return "exact";
  return r < d ? "cut" : "loop";
}

/**
 * A play/pause/seek clock whose reading is always computed from `now()`
 * (seconds, monotonic) rather than accumulated -- see the header above.
 */
export class CompositionClock {
  constructor(now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000) {
    this._now = now;
    this._base = 0; // composition-elapsed seconds at _anchor
    this._anchor = 0;
    this.playing = false;
  }

  /** Real elapsed seconds (unwrapped -- map through compositionTime()). */
  get elapsed() {
    return this.playing ? this._base + (this._now() - this._anchor) : this._base;
  }

  play(from = this.elapsed) {
    this._base = Math.max(0, Number(from) || 0);
    this._anchor = this._now();
    this.playing = true;
  }

  pause() {
    this._base = this.elapsed;
    this.playing = false;
  }

  seek(to) {
    this._base = Math.max(0, Number(to) || 0);
    this._anchor = this._now();
  }
}

const TEMPLATE = `
<style>
:host {
  --bp-bg: #0a0d14;
  --bp-bg-2: #141a26;
  --bp-fg: #f4f6fb;
  --bp-muted: #9aa5b8;
  --bp-accent: #4dd8e6;
  --bp-accent-warm: #ffb454;
  display: block;
  position: relative;
  overflow: hidden;
  font: 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--bp-fg);
  background: radial-gradient(circle at 25% 20%, var(--bp-bg-2), var(--bp-bg) 70%);
}
[hidden] { display: none !important; }
.bgvideo, .bgimage, .bgcolor { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.bgcolor { background: var(--bp-bg); }
.scrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(5,6,10,.45), rgba(5,6,10,.82)); }

.wrap { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100%; box-sizing: border-box;
  padding: clamp(20px, 5vh, 56px) clamp(20px, 5vw, 72px); gap: clamp(14px, 3vh, 28px); }
.brand { display: flex; align-items: center; gap: 10px; }
.brand img { height: clamp(20px, 3.6vh, 32px); display: block; }
.brand img[hidden] { display: none; }
.brand .name { color: var(--bp-muted); font-weight: 700; letter-spacing: .02em; }

.eyebrow { color: var(--bp-accent); font-weight: 800; letter-spacing: .16em; text-transform: uppercase; font-size: clamp(12px, 1.3vw, 16px); }

.hero .label { color: var(--bp-accent); font-weight: 800; letter-spacing: .14em; text-transform: uppercase; font-size: clamp(11px, 1.2vw, 15px); margin-bottom: 6px; }
.hero .title { font-size: clamp(24px, 4.2vw, 56px); font-weight: 800; line-height: 1.06; margin: 0 0 8px; text-wrap: balance; }
.hero .when { font-variant-numeric: tabular-nums; font-size: clamp(14px, 1.6vw, 20px); display: flex; align-items: baseline; gap: .6em; flex-wrap: wrap; color: var(--bp-muted); }
.hero .when .count { color: var(--bp-accent-warm); font-weight: 800; animation: bp-pulse 1.6s ease-in-out infinite; }
@keyframes bp-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .55 } }

.list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: auto minmax(0,1fr);
  column-gap: clamp(10px, 2vw, 28px); row-gap: clamp(6px, 1.6vh, 14px); align-items: baseline; font-size: clamp(13px, 1.6vw, 22px); line-height: 1.25; }
.list li { display: contents; }
.list time { color: var(--bp-muted); font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
.list .t { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.empty { color: var(--bp-muted); font-style: italic; }

/* Text layer timing (upcoming.start/end): faded, not removed, so layout never jumps. */
.wrap > :not(.brand) { transition: opacity .35s ease; }
.wrap.text-off > :not(.brand) { opacity: 0; }

@media (max-width: 640px) {
  .wrap { text-align: center; align-items: center; }
  .brand { justify-content: center; }
  .list { grid-template-columns: 1fr; text-align: center; }
  .list time { text-align: center; }
}
</style>
<video class="bgvideo" hidden muted loop playsinline></video>
<img class="bgimage" hidden alt="">
<div class="bgcolor" hidden></div>
<div class="scrim"></div>
<audio class="bgaudio0" hidden loop preload="metadata"></audio>
<audio class="bgaudio1" hidden loop preload="metadata"></audio>
<audio class="announcement" hidden preload="metadata"></audio>
<div class="wrap">
  <div class="brand"><img alt="" hidden><span class="name"></span></div>
  <div class="eyebrow"></div>
  <div class="hero" hidden>
    <div class="label">Up Next</div>
    <div class="title"></div>
    <div class="when"><span class="start"></span><span class="count" hidden></span></div>
  </div>
  <ol class="list"></ol>
  <div class="empty" hidden>No upcoming shows to display yet.</div>
</div>
`;

const HTMLElementBase = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

const REPO_ROOT_URL = new URL("../", import.meta.url);

const END_BEHAVIORS = ["continue", "loop", "stop"];

export class BumpPlayer extends HTMLElementBase {
  constructor() {
    super();
    this._root = this.attachShadow({ mode: "open" });
    this._root.innerHTML = TEMPLATE;
    this._definition = null;
    this._upcoming = [];
    this._channel = null;
    this._clockNow = () => Date.now() / 1000;
    this._timer = 0;
    this._raf = 0;
    this._muted = true;
    this._clock = new CompositionClock();
    this._endBehavior = "continue";
    this._masterVolume = 1; // preview-only monitor level, never part of a bump definition
    this._hiddenLayers = new Set(); // preview-only "eye" toggles: "text" | "voice" | "music" | "background"
    this._forceSeek = new Set(); // media elements whose metadata just arrived -- re-seek them on the next _sync()
    this._lastSeekAt = new WeakMap();
    this._wired = false;
    this._onMediaMeta = (e) => {
      this._forceSeek.add(e.target);
      this._sync();
      this.dispatchEvent(new CustomEvent("bump-media", { detail: this.mediaDurations }));
    };
    this._onAnnouncementChange = () => this._applyVolumes();
    this._frame = () => {
      this._raf = 0;
      this._sync();
      this._emitTime();
      if (this._clock.playing) this._raf = requestAnimationFrame(this._frame);
    };
  }

  connectedCallback() {
    this._wireMedia();
    this._renderStatic();
    this._tick();
    // 1s safety net: rAF stops entirely in a background tab, but the
    // composition clock keeps reading real time, so this just re-aligns
    // media/text with it (never advances anything by itself).
    this._timer = setInterval(() => { this._tick(); this._sync(); }, 1000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this.stop();
  }

  /** @param {object|null} definition a full bump JSON object (see bumps/README.md), or null to reset to the plain default background.
   *  Safe to set repeatedly while playing (the editor does, on every edit):
   *  only sources that actually changed are reloaded, and playback continues
   *  from the current composition time. */
  set definition(definition) {
    this._definition = definition || null;
    this._applyBackground(this._definition?.background || null);
    this._applyStyle(this._definition?.style || null);
    this._applySources();
    this._renderStatic();
    this._sync();
  }

  get definition() { return this._definition; }

  /** @param {Array<{title:string, startsAt:number, subtitle?:string}>} list caller-supplied real upcoming shows -- never invented here. */
  set upcoming(list) {
    this._upcoming = Array.isArray(list) ? list : [];
    this._renderStatic();
  }

  get upcoming() { return this._upcoming; }

  /** @param {{name?:string, logo?:string}|null} channel optional branding. */
  set channel(channel) {
    this._channel = channel || null;
    this._renderStatic();
  }

  get channel() { return this._channel; }

  /** Broadcast/local clock function (seconds since epoch). Defaults to the local wall clock. */
  set clockNow(fn) {
    this._clockNow = typeof fn === "function" ? fn : (() => Date.now() / 1000);
  }

  get clockNow() { return this._clockNow; }

  /** What happens when real elapsed time passes the composition length --
   *  see compositionTime(). "continue" (default, live playback), "loop",
   *  or "stop" (pauses at the end and fires `bump-ended`; the editor). */
  set endBehavior(mode) {
    this._endBehavior = END_BEHAVIORS.includes(mode) ? mode : "continue";
  }

  get endBehavior() { return this._endBehavior; }

  /** Editor monitor level (0-1) applied on top of every layer's own volume.
   *  Preview-only: live playback never sets it, and it is never saved. */
  set masterVolume(v) {
    this._masterVolume = clampVolume(v, 1);
    this._applyVolumes();
  }

  get masterVolume() { return this._masterVolume; }

  /** Editor-only layer visibility ("text", "voice", "music", "background"),
   *  the timeline's eye toggles. Hidden audio layers are silenced and a
   *  hidden background falls back to the plain default backdrop; timing is
   *  unaffected. Live playback never sets this. */
  set hiddenLayers(list) {
    this._hiddenLayers = new Set(Array.isArray(list) || list instanceof Set ? list : []);
    const q = (sel) => this._root.querySelector(sel);
    const hideBg = this._hiddenLayers.has("background");
    for (const sel of [".bgvideo", ".bgimage", ".bgcolor"]) q(sel).style.visibility = hideBg ? "hidden" : "";
    this._applyVolumes();
    this._sync();
  }

  get hiddenLayers() { return [...this._hiddenLayers]; }

  /** Current composition time in seconds (see the timing header above). */
  get currentTime() { return compositionTime(this._clock.elapsed, this._definition, this._endBehavior); }

  /** Effective composition length: `duration`, else DEFAULT_BUMP_DURATION. */
  get duration() { return effectiveDuration(this._definition); }

  get playing() { return this._clock.playing; }

  /** Real lengths of the loaded media (seconds), or null while unknown. */
  get mediaDurations() {
    const d = (el) => (!el.hidden && el.getAttribute("src") && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    const q = (sel) => this._root.querySelector(sel);
    return { video: d(q(".bgvideo")), audio: this._bgAudioEls().map(d), announcement: d(q(".announcement")) };
  }

  _applyStyle(style) {
    const vars = { accent: "--bp-accent", accentWarm: "--bp-accent-warm", bg: "--bp-bg", bg2: "--bp-bg-2", fg: "--bp-fg", muted: "--bp-muted" };
    for (const [key, cssVar] of Object.entries(vars)) {
      const value = style?.[key];
      if (value) this.style.setProperty(cssVar, value);
      else this.style.removeProperty(cssVar);
    }
  }

  _applyBackground(background) {
    const q = (sel) => this._root.querySelector(sel);
    const video = q(".bgvideo");
    const image = q(".bgimage");
    const color = q(".bgcolor");
    const type = background?.type || null;

    video.hidden = type !== "video";
    image.hidden = type !== "image";
    color.hidden = type !== "color" && type !== null;

    if (type === "video" && background.url) {
      const url = this._resolveUrl(background.url);
      if (video.src !== url) video.src = url;
    } else if (video.hasAttribute("src")) {
      video.pause();
      video.removeAttribute("src");
    }

    if (type === "image" && background.url) {
      const url = this._resolveUrl(background.url);
      if (image.src !== url) image.src = url;
    } else {
      image.removeAttribute("src");
    }

    color.style.background = type === "color" ? (background.color || "") : "";
  }

  /** Points the audio/announcement elements at the definition's files --
   *  only touching an element whose url actually changed, so editing a
   *  volume or label never restarts audio that's already playing. */
  _applySources() {
    const setSrc = (el, path) => {
      if (path) {
        el.hidden = false;
        const url = this._resolveUrl(path);
        if (el.src !== url) el.src = url;
      } else {
        el.hidden = true;
        if (el.hasAttribute("src")) { el.pause(); el.removeAttribute("src"); }
      }
    };
    const layers = this._definition?.audio || [];
    this._bgAudioEls().forEach((el, i) => setSrc(el, layers[i]?.url || null));
    setSrc(this._root.querySelector(".announcement"), this._definition?.announcement?.url || null);
  }

  /** Bump JSON stores repo-root-relative paths (e.g. "media/video/bg05.mp4")
   *  -- resolved here against this document's own base, same convention
   *  every other media reference in this project already uses (plain
   *  static files, never a PHP streaming endpoint -- see bumps/README.md). */
  _resolveUrl(path) {
    const rel = String(path || "").replace(/^\/+/, "");
    if (!rel) return "";
    // Resolve against the repo root (this module lives in channels/), NOT
    // the hosting page -- the admin UI is at scheduler/ and live channels
    // under channels/, so a page-relative "media/..." 404s on both. Also
    // makes the result absolute, matching what el.src reads back, so the
    // `el.src !== url` checks don't reload media on every edit.
    return new URL(rel, REPO_ROOT_URL).href;
  }

  _wireMedia() {
    if (this._wired) return;
    this._wired = true;
    const q = (sel) => this._root.querySelector(sel);
    for (const el of [q(".bgvideo"), ...this._bgAudioEls(), q(".announcement")]) {
      el.addEventListener("loadedmetadata", this._onMediaMeta);
    }
    const ann = q(".announcement");
    for (const type of ["playing", "pause", "ended"]) ann.addEventListener(type, this._onAnnouncementChange);
  }

  _bgAudioEls() {
    return [this._root.querySelector(".bgaudio0"), this._root.querySelector(".bgaudio1")];
  }

  /** Ducks the audio layers to `volume * duckTo` while the announcement is
   *  actually audible, restores them otherwise. */
  _applyVolumes() {
    const layers = this._definition?.audio || [];
    const ann = this._root.querySelector(".announcement");
    const ducked = this._clock.playing && !ann.hidden && !ann.paused && !ann.ended && !this._hiddenLayers?.has("voice");
    const duckTo = this._definition?.announcement?.duckTo ?? 0.3;
    const master = this._masterVolume ?? 1;
    const musicOff = this._hiddenLayers?.has("music");
    this._bgAudioEls().forEach((el, i) => {
      if (el.hidden) return;
      const v = ducked ? duckedVolume(layers[i]?.volume, duckTo) : clampVolume(layers[i]?.volume);
      el.volume = musicOff ? 0 : v * master;
    });
    ann.volume = this._hiddenLayers?.has("voice") ? 0 : master;
  }

  /** Starts playback at composition time `offset` (default 0 -- from the
   *  top, the original behavior). Call this directly from a user gesture's
   *  own call stack when `muted` is false -- same autoplay-policy posture
   *  as BroadcastPlayer/ContinuityRenderer elsewhere in this project; a
   *  refused unmuted autoplay is tolerated silently either way. Live
   *  playback passes the clock-derived offset into the scheduled window. */
  play({ muted = this._muted, offset = 0 } = {}) {
    this.setMuted(muted);
    this._applySources();
    this._clock.play(offset);
    this._sync({ force: true }); // synchronous: the media .play() calls stay inside the caller's gesture
    if (!this._raf && typeof requestAnimationFrame !== "undefined") this._raf = requestAnimationFrame(this._frame);
    this._emitState();
  }

  /** Freezes at the current composition time (play({offset}) resumes). */
  pause() {
    this._clock.pause();
    this._pauseAll();
    this._emitState();
  }

  /** Moves to composition time `t`, keeping the current play/pause state. */
  seek(t) {
    const max = this._endBehavior === "stop" ? this.duration : Infinity;
    this._clock.seek(Math.min(Math.max(0, Number(t) || 0), max));
    this._sync({ force: true });
    this._emitTime();
  }

  /** Pauses everything and rewinds to 0 without tearing down sources -- a
   *  subsequent play() restarts cleanly from the top either way. */
  stop() {
    this._clock.pause();
    this._clock.seek(0);
    this._pauseAll();
    this._sync({ force: true });
    this._emitState();
  }

  _pauseAll() {
    const q = (sel) => this._root.querySelector(sel);
    q(".bgvideo").pause?.();
    this._bgAudioEls().forEach((el) => el.pause?.());
    q(".announcement").pause?.();
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this._applyVolumes();
  }

  setMuted(muted) {
    this._muted = !!muted;
    const q = (sel) => this._root.querySelector(sel);
    q(".bgvideo").muted = true; // background video is always visual-only here -- its own audio track, if any, never competes with the audio layers below
    this._bgAudioEls().forEach((el) => { el.muted = this._muted; });
    q(".announcement").muted = this._muted;
  }

  isMuted() { return this._muted; }

  /**
   * Reconciles every layer with the current composition time -- the ONLY
   * place media is started, stopped, or seeked once playback is running.
   * Idempotent and cheap; called per animation frame while playing, from
   * the 1s safety-net interval, and after any definition/seek change.
   */
  _sync({ force = false } = {}) {
    if (!this._wired) return;
    const q = (sel) => this._root.querySelector(sel);
    const def = this._definition;

    if (this._endBehavior === "stop" && this._clock.playing && this._clock.elapsed >= this.duration) {
      this._clock.pause();
      this._clock.seek(this.duration);
      this._pauseAll();
      this._emitState();
      this.dispatchEvent(new CustomEvent("bump-ended"));
    }

    const playing = this._clock.playing;
    const t = this.currentTime;
    const ann = q(".announcement");
    const annDur = Number.isFinite(ann.duration) && ann.duration > 0 ? ann.duration : null;
    const state = layerStateAt(def, t, { announcementDuration: annDur });

    q(".wrap").classList.toggle("text-off", !state.textVisible || this._hiddenLayers.has("text"));

    const video = q(".bgvideo");
    if (!video.hidden && video.getAttribute("src")) this._drive(video, t, true, playing, force);

    const layers = def?.audio || [];
    this._bgAudioEls().forEach((el, i) => {
      if (layers[i] && el.getAttribute("src")) this._drive(el, t, true, playing, force);
    });

    if (state.announcement && ann.getAttribute("src")) {
      if (state.announcement.active) {
        this._drive(ann, state.announcement.offset, false, playing, force);
      } else {
        if (!ann.paused) ann.pause();
        if (force && ann.readyState >= 1) {
          try { ann.currentTime = state.announcement.before ? 0 : (annDur ?? 0); } catch { /* not seekable yet */ }
        }
      }
    }
    this._applyVolumes();
  }

  /** Puts one media element where composition time says it should be. */
  _drive(el, target, loop, playing, force) {
    force = this._forceSeek.delete(el) || force;
    const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
    if (!loop && dur !== null && target >= dur) { // one-shot clip already finished at this point in the composition
      if (!el.paused) el.pause();
      return;
    }
    if (el.readyState >= 1) {
      const pos = mediaPosition(target, dur, loop);
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const recentlySeeked = now - (this._lastSeekAt.get(el) || 0) < 1000;
      if (force || (!el.seeking && !recentlySeeked && needsResync(el.currentTime, pos, { loopLength: loop ? dur : null }))) {
        try { el.currentTime = pos; this._lastSeekAt.set(el, now); } catch { /* not seekable yet -- loadedmetadata re-forces */ }
      }
    } else {
      this._forceSeek.add(el); // seek once metadata arrives (see _onMediaMeta)
    }
    if (playing && el.paused) el.play?.()?.catch?.(() => {});
    else if (!playing && !el.paused) el.pause();
  }

  _emitTime() {
    this.dispatchEvent(new CustomEvent("bump-time", { detail: { time: this.currentTime, duration: this.duration, playing: this._clock.playing } }));
  }

  _emitState() {
    this.dispatchEvent(new CustomEvent("bump-state", { detail: { playing: this._clock.playing, time: this.currentTime } }));
  }

  _renderStatic() {
    const q = (sel) => this._root.querySelector(sel);
    const ch = this._channel;
    const logo = q(".brand img");
    logo.hidden = !ch?.logo;
    if (ch?.logo) logo.src = ch.logo;
    q(".brand .name").textContent = ch?.name || "";
    q(".eyebrow").textContent = this._definition?.upcoming?.label || "Coming Up";

    const count = this._definition?.upcoming?.count ?? 3;
    const shows = normalizeUpcoming(this._upcoming, count);
    const [first, ...rest] = shows;

    const hero = q(".hero");
    hero.hidden = !first;
    if (first) {
      q(".hero .title").textContent = first.title;
      q(".hero .start").textContent = timeFormat.format(new Date(first.startsAt * 1000));
    }

    q(".list").replaceChildren(...rest.map((show) => {
      const li = document.createElement("li");
      const time = Object.assign(document.createElement("time"), {
        dateTime: new Date(show.startsAt * 1000).toISOString(),
        textContent: timeFormat.format(new Date(show.startsAt * 1000)),
      });
      const title = Object.assign(document.createElement("span"), { className: "t", textContent: show.title, title: show.title });
      li.append(time, title);
      return li;
    }));

    q(".empty").hidden = shows.length > 0;
    this._tick();
  }

  /** Recomputes the hero countdown from the current clock reading, same
   *  "never an incrementing counter" determinism rule as continuity-
   *  card.js's _tick() -- see that file's header for why. */
  _tick() {
    const count = this._root.querySelector(".hero .count");
    const [first] = normalizeUpcoming(this._upcoming, this._definition?.upcoming?.count ?? 3);
    if (!first) { if (count) count.hidden = true; return; }
    const remaining = first.startsAt - this._clockNow();
    count.hidden = false;
    count.textContent = formatCountdown(remaining);
  }
}

if (typeof customElements !== "undefined" && !customElements.get("cr-bump")) {
  customElements.define("cr-bump", BumpPlayer);
}
