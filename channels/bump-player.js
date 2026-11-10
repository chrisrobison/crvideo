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
// note for why. The bump creator UI (scheduler/js/components/
// cf-bump-creator.js) feeds either hand-typed sample rows or a real
// channel's real current lineup (via channels/broadcast.js, read-only);
// a future live-playback integration would feed the real channel being
// interrupted.
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
<audio class="bgaudio0" hidden loop preload="none"></audio>
<audio class="bgaudio1" hidden loop preload="none"></audio>
<audio class="announcement" hidden preload="none"></audio>
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
    this._muted = true;
    this._onAnnouncementPlay = () => this._duck();
    this._onAnnouncementEnded = () => this._unduck();
  }

  connectedCallback() {
    this._wireAnnouncement();
    this._renderStatic();
    this._tick();
    this._timer = setInterval(() => this._tick(), 1000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this.stop();
  }

  /** @param {object|null} definition a full bump JSON object (see bumps/README.md), or null to reset to the plain default background. */
  set definition(definition) {
    this._definition = definition || null;
    this._applyBackground(this._definition?.background || null);
    this._applyStyle(this._definition?.style || null);
    this._renderStatic();
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
    } else {
      video.removeAttribute("src");
    }

    if (type === "image" && background.url) {
      image.src = this._resolveUrl(background.url);
    } else {
      image.removeAttribute("src");
    }

    color.style.background = type === "color" ? (background.color || "") : "";
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
    // `el.src !== url` checks below don't reload media on every edit.
    return new URL(rel, REPO_ROOT_URL).href;
  }

  _wireAnnouncement() {
    const audio = this._root.querySelector(".announcement");
    audio.addEventListener("play", this._onAnnouncementPlay);
    audio.addEventListener("ended", this._onAnnouncementEnded);
    audio.addEventListener("pause", this._onAnnouncementEnded);
  }

  _bgAudioEls() {
    return [this._root.querySelector(".bgaudio0"), this._root.querySelector(".bgaudio1")];
  }

  _duck() {
    const layers = this._definition?.audio || [];
    const duckTo = this._definition?.announcement?.duckTo ?? 0.3;
    this._bgAudioEls().forEach((el, i) => {
      if (el.hidden) return;
      el.volume = duckedVolume(layers[i]?.volume, duckTo);
    });
  }

  _unduck() {
    const layers = this._definition?.audio || [];
    this._bgAudioEls().forEach((el, i) => {
      if (el.hidden) return;
      el.volume = clampVolume(layers[i]?.volume);
    });
  }

  /** Starts (or restarts, from the top) background video/audio and the
   *  announcement clip, if any. Call this directly from a user gesture's
   *  own call stack when `muted` is false -- same autoplay-policy posture
   *  as BroadcastPlayer/ContinuityRenderer elsewhere in this project; a
   *  refused unmuted autoplay is tolerated silently either way. */
  play({ muted = this._muted } = {}) {
    this.setMuted(muted);
    const q = (sel) => this._root.querySelector(sel);
    const video = q(".bgvideo");
    if (!video.hidden) { video.currentTime = 0; video.play?.().catch(() => {}); }

    const layers = this._definition?.audio || [];
    this._bgAudioEls().forEach((el, i) => {
      const layer = layers[i];
      if (!layer) { el.hidden = true; el.removeAttribute("src"); return; }
      el.hidden = false;
      const url = this._resolveUrl(layer.url);
      if (el.src !== url) el.src = url;
      el.volume = clampVolume(layer.volume);
      el.currentTime = 0;
      el.play?.().catch(() => {});
    });

    const announcement = q(".announcement");
    const announcementDef = this._definition?.announcement;
    if (announcementDef?.url) {
      announcement.hidden = false;
      const url = this._resolveUrl(announcementDef.url);
      if (announcement.src !== url) announcement.src = url;
      announcement.currentTime = 0;
      announcement.play?.().catch(() => {});
    } else {
      announcement.hidden = true;
      announcement.removeAttribute("src");
    }
  }

  /** Pauses everything without tearing down sources -- a subsequent
   *  play() restarts cleanly from the top either way. */
  stop() {
    const q = (sel) => this._root.querySelector(sel);
    q(".bgvideo").pause?.();
    this._bgAudioEls().forEach((el) => el.pause?.());
    q(".announcement").pause?.();
    this._unduck();
  }

  setMuted(muted) {
    this._muted = !!muted;
    const q = (sel) => this._root.querySelector(sel);
    q(".bgvideo").muted = true; // background video is always visual-only here -- its own audio track, if any, never competes with the audio layers below
    this._bgAudioEls().forEach((el) => { el.muted = this._muted; });
    q(".announcement").muted = this._muted;
  }

  isMuted() { return this._muted; }

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
