// channels/continuity-card.js
//
// <cr-continuity-card>: a dependency-free Web Component (shadow DOM, plain
// CSS, no build step, no prerecorded assets) that renders a "Coming Up Next"
// broadcast continuity card.
//
// It decides nothing about scheduling: it displays the `.program` and
// `.channel` it's given and formats a countdown from `.program.startsAt`
// against `.clockNow` (defaults to `() => Date.now() / 1000`; callers pass
// the drift-corrected broadcast clock, broadcast.js's `now()`). The compiler
// decides the card's start/duration and the program that follows.
//
// Determinism: every render recomputes the countdown from the absolute
// instant `.program.startsAt` and the current clock, accumulating nothing
// across ticks. A reload mid-card, a suspended background tab, or two
// viewers at the same instant therefore all show the correct countdown
// (a `visibilitychange` listener forces one extra render when the tab
// becomes visible again). The component holds no viewer-specific state.
//
// Theming: every color is a CSS custom property on :host with a neutral
// default. A channel's identity is layered on by the page, from the
// channel's meta.json theme (see docs/series-and-channels.md); never
// hardcoded here.
//
// Bumper presentation (optional `.theme`/`.template`, from
// `channels/<id>/theme.json`; see loadTheme()): a channel can replace the
// default info card with its own background (a looping ambient video or a
// built-in canvas animation, see CANVAS_GENERATORS) and content (the up-next
// info or a themed "quote" card). The bumper for an occurrence is chosen
// from `theme.bumpers` (weighted) by pickWeightedIndex(), seeded by the
// occurrence's absolute `startsAt` -- never Math.random() -- so two viewers
// at the same instant see the same bumper. With no `.theme` the plain
// generic card renders.

const TEMPLATE = `
<style>
:host {
  --cc-bg: #0a0d14;
  --cc-bg-2: #141a26;
  --cc-fg: #f4f6fb;
  --cc-muted: #9aa5b8;
  --cc-accent: #4dd8e6;
  --cc-accent-warm: #ffb454;
  --cc-radius: 14px;
  display: block;
  font: 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--cc-fg);
  background: radial-gradient(circle at 25% 20%, var(--cc-bg-2), var(--cc-bg) 70%);
  border-radius: var(--cc-radius);
  overflow: hidden;
  position: relative;
}
.wrap {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: clamp(16px, 4vw, 48px);
  align-items: center;
  padding: clamp(20px, 5vh, 56px) clamp(20px, 5vw, 72px);
  min-height: 100%;
  box-sizing: border-box;
}
.thumb {
  width: clamp(120px, 24vw, 280px);
  aspect-ratio: 16/9;
  border-radius: 10px;
  background: var(--cc-bg-2);
  object-fit: cover;
  box-shadow: 0 10px 30px rgba(0,0,0,.4);
}
.thumb[hidden] { display: none; }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: clamp(10px, 3vh, 22px); }
.brand img { height: clamp(22px, 4vh, 36px); display: block; }
.brand img[hidden] { display: none; }
.brand .name { color: var(--cc-muted); font-weight: 700; letter-spacing: .02em; }
.eyebrow {
  color: var(--cc-accent);
  font-weight: 800;
  letter-spacing: .16em;
  text-transform: uppercase;
  font-size: clamp(12px, 1.3vw, 16px);
  margin-bottom: 8px;
}
.title {
  font-size: clamp(22px, 3.6vw, 48px);
  font-weight: 800;
  line-height: 1.08;
  margin: 0 0 10px;
  text-wrap: balance;
}
.desc {
  color: var(--cc-muted);
  font-size: clamp(13px, 1.4vw, 18px);
  max-height: 3.2em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.when {
  margin-top: clamp(10px, 2.4vh, 20px);
  font-variant-numeric: tabular-nums;
  font-size: clamp(14px, 1.6vw, 20px);
  display: flex;
  align-items: baseline;
  gap: .6em;
  flex-wrap: wrap;
}
.when .count {
  color: var(--cc-accent-warm);
  font-weight: 800;
  animation: cc-pulse 1.6s ease-in-out infinite;
}
@keyframes cc-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .55 } }
.bar {
  position: absolute; left: 0; bottom: 0; height: 3px; width: 100%;
  background: linear-gradient(90deg, var(--cc-accent), var(--cc-accent-warm));
  transform-origin: left center;
  transition: transform .3s linear;
}
@media (max-width: 640px) {
  .wrap { grid-template-columns: 1fr; text-align: center; }
  .brand { justify-content: center; }
  .thumb { width: 100%; max-width: 320px; margin: 0 auto; }
}

/* Bumper background layers, stacked behind .wrap, one visible at a time. A
   video/canvas background gets a dark scrim so text stays legible; the plain
   default (no layer) keeps the radial-gradient look with no scrim. */
.bgvideo, .bgcanvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.bgvideo[hidden], .bgcanvas[hidden] { display: none; }
.scrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(5,6,10,.55), rgba(5,6,10,.82)); }
.scrim[hidden] { display: none; }
.wrap, .quote { position: relative; z-index: 1; }

/* "overlay": the player draws a filler scene (video, audio, rotating lines)
   behind this card, so the card is just its text on a light scrim. */
:host([overlay]) { background: none !important; }
:host([overlay]) .bgvideo, :host([overlay]) .bgcanvas { display: none; }
:host([overlay]) .scrim { display: block; background: linear-gradient(180deg, rgba(5,6,10,.35), rgba(5,6,10,.12) 55%, rgba(5,6,10,.35)); }

/* Quote content, an alternative to the default "Coming Up Next" block.
   Reuses .wrap's grid padding so either fills the card identically. */
.quote {
  display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  gap: clamp(10px, 2.4vh, 20px); height: 100%; box-sizing: border-box;
  padding: clamp(20px, 5vh, 56px) clamp(20px, 5vw, 72px);
}
.quote[hidden] { display: none; }
.quote .eyebrow { margin-bottom: 0; }
.quote blockquote { margin: 0; max-width: 46ch; font-size: clamp(20px, 3.2vw, 40px); font-weight: 700; line-height: 1.25; text-wrap: balance; }
.quote .attribution { color: var(--cc-muted); font-size: clamp(13px, 1.4vw, 18px); }
</style>
<video class="bgvideo" hidden muted loop playsinline></video>
<canvas class="bgcanvas" hidden></canvas>
<audio class="va" hidden preload="none"></audio>
<div class="scrim" hidden></div>
<div class="wrap">
  <div class="info">
    <div class="brand"><img part="logo" hidden><span class="name"></span></div>
    <div class="eyebrow">Coming Up Next</div>
    <div class="title"></div>
    <div class="desc" hidden></div>
    <div class="when">
      <span class="start"></span>
      <span class="count" hidden></span>
    </div>
  </div>
  <img class="thumb" hidden alt="">
</div>
<div class="quote" hidden>
  <div class="eyebrow"></div>
  <blockquote></blockquote>
  <div class="attribution"></div>
</div>
<div class="bar" hidden></div>
`;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function formatCountdown(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s <= 0) return "starting now";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `starts in ${m}:${String(r).padStart(2, "0")}` : `starts in ${r}s`;
}

// ---------- deterministic selection (never Math.random(); see header) ----------

/** 32-bit FNV-1a: small, fast, good-enough distribution for picking among a
 *  handful of bumpers/quotes; not cryptographic. Pure function of its input. */
export function hashSeed(seed) {
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Picks an index from `weights` (one non-negative number per item)
 *  deterministically from `seed`. Falls back to 0 for an empty/all-zero list
 *  so a misconfigured theme.json degrades to "always the first bumper"
 *  instead of crashing the card. */
export function pickWeightedIndex(weights, seed) {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (!(total > 0)) return 0;
  const target = (hashSeed(seed) % 1000003) / 1000003 * total;
  let cursor = 0;
  for (let i = 0; i < weights.length; i++) {
    cursor += Math.max(0, weights[i]);
    if (target < cursor) return i;
  }
  return weights.length - 1;
}

// ---------- built-in canvas bumper backgrounds ----------
// Each generator draws one frame into `ctx` (already sized to the canvas's
// device pixels) given elapsed seconds `t`. Purely decorative, not
// broadcast-synced, so it runs off performance.now(). New ones can be added
// here without touching anything else.
const CANVAS_GENERATORS = {
  waves(ctx, w, h, t) {
    ctx.clearRect(0, 0, w, h);
    const lines = 5;
    for (let i = 0; i < lines; i++) {
      const amp = h * 0.03 * (1 + i * 0.3);
      const speed = 0.4 + i * 0.08;
      const yBase = h * (0.35 + i * 0.1);
      ctx.beginPath();
      for (let x = 0; x <= w; x += Math.max(4, w / 120)) {
        const y = yBase + Math.sin(x * 0.01 + t * speed + i) * amp;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(120, 200, 255, ${0.12 + i * 0.05})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  },
  starfield(ctx, w, h, t) {
    ctx.fillStyle = "#05070c";
    ctx.fillRect(0, 0, w, h);
    const count = 140;
    for (let i = 0; i < count; i++) {
      // Layout derived from the star's own index so stars don't reshuffle every frame.
      const seed = hashSeed(`star:${i}`);
      const x = (seed % 1000) / 1000 * w;
      const y = ((seed >>> 10) % 1000) / 1000 * h;
      const twinkle = 0.4 + 0.6 * Math.abs(Math.sin(t * (0.6 + (i % 7) * 0.08) + i));
      const r = 0.6 + (i % 3) * 0.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${twinkle})`;
      ctx.fill();
    }
  },
};

// Guards against evaluation without a DOM (`node --test` imports this file
// via player-adapters.js). `typeof` doesn't throw for unresolvable identifiers.
const HTMLElementBase = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

export class ContinuityCard extends HTMLElementBase {
  static get observedAttributes() { return []; }

  constructor() {
    super();
    this._root = this.attachShadow({ mode: "open" });
    this._root.innerHTML = TEMPLATE;
    this._channel = null;
    this._program = null;
    this._clockNow = () => Date.now() / 1000;
    this._timer = 0;
    this._onVisible = () => this._tick();
    this._theme = null;
    this._template = null;
    this._cardStartsAt = null;
    this._cardEndsAt = null;
    this._canvasRaf = 0;
    this._audioUrl = null;
    this._muted = true;
  }

  connectedCallback() {
    document.addEventListener("visibilitychange", this._onVisible);
    this._startTicking();
    this._renderStatic();
    this._renderBumper();
    this._tick();
    this._syncAudio();
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onVisible);
    clearInterval(this._timer);
    this._stopCanvas();
    this._stopAudio();
  }

  /** @param {{bumpers?:Array<{id?:string,template?:string,weight?:number,background?:object,content?:object}>, quoteDecks?:Record<string,string[]>}|null} theme
   *  parsed `channels/<id>/theme.json` (see loadTheme()), or null for the
   *  default plain card. */
  set theme(theme) {
    this._theme = theme || null;
    this._renderBumper();
  }

  get theme() { return this._theme; }

  /** @param {?string} template this occurrence's continuity card "template"
   *  id (schedule.json `cards[].template`; see ContinuityResolver.php). Narrows
   *  `theme.bumpers` to those declaring a matching `.template`; a bumper with
   *  no `.template` is always eligible. */
  set template(template) {
    this._template = template || null;
    this._renderBumper();
  }

  get template() { return this._template; }

  /** @param {{name?:string, logo?:string}|null} channel */
  set channel(channel) {
    this._channel = channel || null;
    this._renderStatic();
  }

  get channel() { return this._channel; }

  /** @param {{title:string, description?:string, thumbnailUrl?:string, startsAt:number, endsAt?:number}|null} program */
  set program(program) {
    this._program = program || null;
    this._renderStatic();
    this._tick();
  }

  get program() { return this._program; }

  /** Broadcast clock function (seconds since epoch) -- see broadcast.js's `now()`. Defaults to the local wall clock. */
  set clockNow(fn) {
    this._clockNow = typeof fn === "function" ? fn : (() => Date.now() / 1000);
  }

  get clockNow() { return this._clockNow; }

  /** @param {?string} url this occurrence's announcer narration MP3 (see
   *  findAnnouncementAudio()), or null for a silent card.
   *  Always (re)starts playback from the top, even for an identical `url`:
   *  the broadcast cycle repeats, so the same cached MP3 legitimately airs
   *  again on the next lap, and ContinuityRenderer.show() sets this only once
   *  per new occurrence. */
  set audioUrl(url) {
    this._audioUrl = url || null;
    this._syncAudio();
  }

  get audioUrl() { return this._audioUrl; }

  /** Mirrors the player's mute state onto the narration track. */
  setMuted(muted) {
    this._muted = !!muted;
    const audio = this._root.querySelector(".va");
    if (audio) audio.muted = this._muted;
  }

  _syncAudio() {
    const audio = this._root.querySelector(".va");
    if (!audio) return;
    if (!this._audioUrl) {
      this._stopAudio();
      return;
    }
    audio.muted = this._muted;
    if (audio.src !== this._audioUrl) audio.src = this._audioUrl;
    audio.currentTime = 0;
    audio.play?.().catch(() => { /* autoplay refused -- same posture as the bumper background video; the card still renders fine silently */ });
  }

  _stopAudio() {
    const audio = this._root.querySelector(".va");
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
  }

  _startTicking() {
    clearInterval(this._timer);
    this._timer = setInterval(() => this._tick(), 1000);
  }

  _renderStatic() {
    const q = (sel) => this._root.querySelector(sel);
    const ch = this._channel;
    const logo = q(".brand img");
    logo.hidden = !ch?.logo;
    if (ch?.logo) logo.src = ch.logo;
    q(".brand .name").textContent = ch?.name || "";

    const p = this._program;
    q(".title").textContent = p?.title || "";
    const desc = q(".desc");
    desc.hidden = !p?.description;
    desc.textContent = p?.description || "";
    const thumb = q(".thumb");
    thumb.hidden = !p?.thumbnailUrl;
    if (p?.thumbnailUrl) thumb.src = p.thumbnailUrl;
    q(".start").textContent = p ? timeFormat.format(new Date(p.startsAt * 1000)) : "";
  }

  /** Recomputes the countdown (and progress bar, if the card's span is known)
   *  from the current clock reading, never from a counter, so a late tick or
   *  fresh load shows the correct remaining time. */
  _tick() {
    const p = this._program;
    const countEl = this._root.querySelector(".count");
    if (!p) { countEl.hidden = true; return; }
    const t = this._clockNow();
    const remaining = p.startsAt - t;
    countEl.hidden = false;
    countEl.textContent = formatCountdown(remaining);

    const bar = this._root.querySelector(".bar");
    if (this._cardStartsAt != null && this._cardEndsAt != null && this._cardEndsAt > this._cardStartsAt) {
      bar.hidden = false;
      const frac = Math.min(1, Math.max(0, (t - this._cardStartsAt) / (this._cardEndsAt - this._cardStartsAt)));
      bar.style.transform = `scaleX(${1 - frac})`;
    } else {
      bar.hidden = true;
    }
  }

  /** Optional: this card occurrence's OWN span (not the next program's).
   *  Drives the shrinking progress bar and, via `startsAt`, seeds the
   *  bumper/quote pick (see pickWeightedIndex()). */
  setCardSpan(startsAt, endsAt) {
    this._cardStartsAt = startsAt;
    this._cardEndsAt = endsAt;
    this._tick();
    this._renderBumper();
  }

  /** Seed for this occurrence's bumper/quote pick: the card's span start if
   *  known, else the upcoming program's start (for callers that only set
   *  `.program`, e.g. tests). */
  _seed() {
    return this._cardStartsAt ?? this._program?.startsAt ?? 0;
  }

  /** Picks and applies this occurrence's bumper (background + content) from
   *  `.theme`, deterministically from `_seed()`. With no `.theme`, background
   *  layers stay hidden and the plain "Coming Up Next" block shows. */
  _renderBumper() {
    const q = (sel) => this._root.querySelector(sel);
    const bumpers = (this._theme?.bumpers || []).filter((b) => !b.template || b.template === this._template);
    const bumper = bumpers.length
      ? bumpers[pickWeightedIndex(bumpers.map((b) => (b.weight ?? 1)), `bumper:${this._seed()}`)]
      : null;

    this._applyBackground(bumper?.background || null);
    this._applyContent(bumper?.content || null);
  }

  _applyBackground(background) {
    const q = (sel) => this._root.querySelector(sel);
    const video = q(".bgvideo");
    const canvas = q(".bgcanvas");
    const scrim = q(".scrim");
    this._stopCanvas();

    const type = background?.type || null;
    video.hidden = type !== "video-loop";
    canvas.hidden = type !== "canvas";
    scrim.hidden = type === null;

    if (type === "video-loop" && background.url) {
      if (video.src !== background.url) video.src = background.url;
      video.play?.().catch(() => { /* autoplay refused -- the static poster/scrim is still a fine background */ });
    } else {
      video.removeAttribute("src");
    }

    if (type === "canvas") {
      this._startCanvas(CANVAS_GENERATORS[background.generator] || CANVAS_GENERATORS.waves);
    }
  }

  _applyContent(content) {
    const q = (sel) => this._root.querySelector(sel);
    const isQuote = content?.type === "quote";
    q(".wrap").hidden = isQuote;
    const quoteEl = q(".quote");
    quoteEl.hidden = !isQuote;
    if (!isQuote) return;

    const deck = (this._theme?.quoteDecks?.[content.deck]) || [];
    const quote = deck.length ? deck[pickWeightedIndex(deck.map(() => 1), `quote:${this._seed()}`)] : "";
    quoteEl.querySelector(".eyebrow").textContent = content.label || "Deep Thoughts";
    quoteEl.querySelector("blockquote").textContent = quote;
    quoteEl.querySelector(".attribution").textContent = this._channel?.name || "";
  }

  _startCanvas(generator) {
    const canvas = this._root.querySelector(".bgcanvas");
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return;
    const start = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
    const frame = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const t = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000 - start;
      generator(ctx, w, h, t);
      this._canvasRaf = requestAnimationFrame(frame);
    };
    this._canvasRaf = requestAnimationFrame(frame);
  }

  _stopCanvas() {
    if (this._canvasRaf && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this._canvasRaf);
    this._canvasRaf = 0;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("cr-continuity-card")) {
  customElements.define("cr-continuity-card", ContinuityCard);
}

// ---------- pure, unit-testable helper ----------
export { formatCountdown };
