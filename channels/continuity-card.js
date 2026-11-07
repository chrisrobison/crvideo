// channels/continuity-card.js
//
// <cr-continuity-card>: a reusable, dependency-free Web Component that
// renders a "Coming Up Next" broadcast continuity card (Phase 5 of docs/
// series-and-channels.md). Native custom element, shadow DOM, plain CSS
// -- no React, no build step, no video-rendering framework, no
// prerecorded asset of any kind.
//
// What it decides: nothing about scheduling. It only ever displays
// whatever `.program` and `.channel` it's given and formats a countdown
// from `.program.startsAt` against its own clock function (`.clockNow`,
// defaulting to `() => Date.now() / 1000`, overridden by callers to the
// project's drift-corrected broadcast clock -- see broadcast.js's
// `now()`). The compiler decided this card's own exact start/duration
// and which program follows; this component never invents or guesses
// either one, and never seeks/plays/loads any media.
//
// Determinism/robustness this component is responsible for:
//   - A page refresh mid-card must show the same program and the
//     correct remaining countdown. Guaranteed by construction: every
//     render recomputes the countdown from the ABSOLUTE instant
//     `.program.startsAt` and the current clock reading -- nothing is
//     ever accumulated/incremented across ticks, so there is no drift
//     to correct and no state to lose on reload.
//   - A background tab whose timers get suspended: the same "always
//     recompute from absolute instants" property means a late or
//     delayed tick is simply a late correct answer, never a wrong one;
//     the `visibilitychange` listener forces one extra render the
//     instant the tab becomes visible again, so the countdown never sits
//     on stale text while the user is actually looking at it.
//   - Two viewers opening the same channel at the same instant see the
//     same program and the same countdown (subject to ordinary clock
//     skew/render latency) because both compute it the same way from
//     the same compiled schedule -- this component has no viewer-
//     specific state of any kind.
//
// Theming: every color is a CSS custom property on :host with a neutral
// default (an unbranded dark slate). A specific channel's identity (e.g.
// Science & Engineering's dark background + cyan highlights + warm
// accent) is layered on by the PAGE that uses this component, reading
// the channel's own meta.json theme (see docs/series-and-channels.md) --
// never hardcoded in here, so a brand-new channel with no theme
// configured still gets a perfectly reasonable, generic-looking card.
//
// Bumper presentation (optional `.theme`/`.template`, backed by a new
// per-channel `channels/<id>/theme.json` -- see broadcast.js's
// loadTheme()): a channel can go beyond the default "Coming Up Next"
// info card with its own background (a looping ambient video, or one of
// a small set of built-in canvas animations -- see CANVAS_GENERATORS
// below) and content (the default up-next info, or a themed "quote"
// card -- e.g. an SNL-"Deep Thoughts"-style deck of short lines). Which
// one actually renders for THIS occurrence is picked deterministically
// from `theme.bumpers` (weighted) via pickWeightedIndex() below, seeded
// by the occurrence's own absolute `startsAt` -- never Math.random() --
// which is what keeps this consistent with every other piece of this
// project's determinism contract: two viewers who tune in to the same
// occurrence at the same instant must see the exact same bumper, not
// independently-random ones. No `.theme` at all (the default, and every
// channel published before this existed) renders exactly the plain
// generic card this component has always rendered.

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

/* Bumper background layers (Phase: theme.json) -- stacked behind .wrap,
   always inset:0, exactly one visible at a time. A video/canvas
   background gets a dark scrim behind the content so text stays legible
   regardless of what's playing underneath; the plain default (no
   background layer at all) keeps the existing radial-gradient look with
   no scrim, byte-for-byte unchanged. */
.bgvideo, .bgcanvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.bgvideo[hidden], .bgcanvas[hidden] { display: none; }
.scrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(5,6,10,.55), rgba(5,6,10,.82)); }
.scrim[hidden] { display: none; }
.wrap, .quote { position: relative; z-index: 1; }

/* Quote content (an alternative to the default "Coming Up Next" info
   block -- e.g. an SNL-"Deep Thoughts"-style card). Reuses the same grid
   padding as .wrap so either one fills the card identically. */
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

// ---------- deterministic selection (never Math.random() -- see the
// header comment above: two viewers at the same occurrence must see the
// same bumper) ----------

/** 32-bit FNV-1a -- small, fast, good-enough distribution for picking
 *  among a handful of bumpers/quotes; not a cryptographic hash. Pure
 *  function of its input string, so the same seed always maps to the
 *  same number for every viewer and every re-render. */
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
 *  deterministically from `seed` -- the same seed+weights always
 *  returns the same index. Falls back to index 0 for an empty/all-zero
 *  list rather than throwing, so a misconfigured theme.json degrades to
 *  "always the first bumper" instead of crashing the card. */
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
// Each generator draws one frame into `ctx` (already sized to the
// canvas's device-pixel dimensions) given elapsed seconds `t`. Purely
// decorative/ambient -- never broadcast-synced, so it's fine for this to
// run off performance.now() rather than the project's drift-corrected
// clock. New ones can be added here without touching anything else.
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
      // Deterministic per-star layout (not animation-frame-random): derived
      // from the star's own index, so stars don't reshuffle every frame.
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

// Guards against evaluation in a non-browser environment (e.g. this
// project's `node --test` unit tests, which import player-adapters.js
// -- and therefore this file -- without a DOM). `typeof` never throws
// for an unresolvable identifier, unlike referencing it directly.
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
  }

  connectedCallback() {
    document.addEventListener("visibilitychange", this._onVisible);
    this._startTicking();
    this._renderStatic();
    this._renderBumper();
    this._tick();
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onVisible);
    clearInterval(this._timer);
    this._stopCanvas();
  }

  /** @param {{bumpers?:Array<{id?:string,template?:string,weight?:number,background?:object,content?:object}>, quoteDecks?:Record<string,string[]>}|null} theme
   *  parsed `channels/<id>/theme.json` (see broadcast.js's loadTheme()), or
   *  null for the default plain card -- exactly what every channel without
   *  one still gets. */
  set theme(theme) {
    this._theme = theme || null;
    this._renderBumper();
  }

  get theme() { return this._theme; }

  /** @param {?string} template this occurrence's continuity card "template"
   *  id (schedule.json's `cards[].template`, from continuity.json -- see
   *  ContinuityResolver.php). Used only to narrow `theme.bumpers` to ones
   *  that declare a matching `.template`; a bumper with no `.template` at
   *  all is eligible regardless. */
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

  /** Recomputes the countdown (and the progress bar, if the card's own
   *  span is known) from the current clock reading -- never from an
   *  incrementing counter, so a late/suspended tick or a fresh page
   *  load always lands on the correct remaining time. */
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

  /** Optional: the card occurrence's OWN span (not the next program's),
   *  used both to drive the shrinking progress bar AND (its `startsAt`)
   *  as the deterministic seed for which bumper/quote this occurrence
   *  shows -- see pickWeightedIndex()'s header. */
  setCardSpan(startsAt, endsAt) {
    this._cardStartsAt = startsAt;
    this._cardEndsAt = endsAt;
    this._tick();
    this._renderBumper();
  }

  /** The seed for this occurrence's deterministic bumper/quote pick: the
   *  card's own span start if known (every real publish calls
   *  setCardSpan()), else the upcoming program's start as a reasonable
   *  fallback for a caller that only ever sets `.program` (e.g. a test). */
  _seed() {
    return this._cardStartsAt ?? this._program?.startsAt ?? 0;
  }

  /** Picks and applies this occurrence's bumper (background + content)
   *  from `.theme`, deterministically from `_seed()`. No `.theme` at all
   *  renders exactly the plain default this component has always shown --
   *  background layers hidden, the original "Coming Up Next" info block
   *  shown, byte-for-byte the pre-existing look. */
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
