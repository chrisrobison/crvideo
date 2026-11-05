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
</style>
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
  }

  connectedCallback() {
    document.addEventListener("visibilitychange", this._onVisible);
    this._startTicking();
    this._renderStatic();
    this._tick();
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onVisible);
    clearInterval(this._timer);
  }

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
   *  used only to drive the shrinking progress bar. */
  setCardSpan(startsAt, endsAt) {
    this._cardStartsAt = startsAt;
    this._cardEndsAt = endsAt;
    this._tick();
  }
}

if (typeof customElements !== "undefined" && !customElements.get("cr-continuity-card")) {
  customElements.define("cr-continuity-card", ContinuityCard);
}

// ---------- pure, unit-testable helper ----------
export { formatCountdown };
