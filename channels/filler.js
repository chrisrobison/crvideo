// Filler: what the player shows and plays when nothing else is on air, so a
// channel never has dead air.
//
// "Dead air" is any stretch where BroadcastPlayer would otherwise sit on the
// silent static slate: a gap the schedule leaves uncovered, a file that ends
// before its slot does, a video that failed to load (while it retries or
// after it gives up), or a provider with no adapter. During those, and
// quietly under continuity cards, the player rotates through:
//
//   - a scene: a looping video with its music/ambience beds, borrowed from
//     the existing bump library (filler/scenes.json -> bumps/<id>.json,
//     rendered by <cr-bump>), and
//   - a line: a proverb or "imponderable" question (filler/quotes.json,
//     built by filler/build-quotes.php from cdr2.com's quote files), faded
//     in over the picture.
//
// Everything is a pure function of the broadcast clock and the channel id,
// like the schedule itself, so every viewer of a channel sees and hears the
// same scene and line at the same moment and nothing needs server state.

import { hashSeed } from "./continuity-card.js";

export const SCENE_SECONDS = 300; // how long one scene (video + beds) stays up
export const LINE_SECONDS = 14; // how long one line stays up
export const BED_VOLUME = 0.25; // music under a continuity card, which has its own voice-over and no picture to carry the mood

// ---------- pure, unit-testable helpers ----------

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

/** A step coprime with `n`, near the golden ratio so consecutive picks land
 *  far apart; stepping by it visits every index once per `n` steps. */
function strideFor(n) {
  let s = Math.max(1, Math.round(n * 0.618));
  while (gcd(s, n) !== 1) s++;
  return s;
}

/** The index chosen for time slot `slot`: a per-channel shuffled walk of the
 *  list, so a channel never repeats an entry until it has shown all of them,
 *  and two channels are out of step with each other. Returns -1 for `n` 0. */
export function pickIndex(n, slot, channelId = "") {
  if (!(n > 0)) return -1;
  const start = hashSeed(`filler:${channelId}`) % n;
  return (start + (slot % n) * strideFor(n)) % n;
}

/** Interleaves proverbs and imponderables (one of each in turn) into one
 *  deck of `{text, author?, kind}`, dropping malformed entries. */
export function buildDeck(doc) {
  const take = (list, kind) => (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e.text === "string" && e.text.trim())
    .map((e) => ({ text: e.text.trim(), ...(e.author ? { author: String(e.author) } : {}), kind }));
  const quotes = take(doc?.quotes, "quote");
  const questions = take(doc?.imponderables, "imponderable");
  const deck = [];
  for (let i = 0; i < Math.max(quotes.length, questions.length); i++) {
    if (i < questions.length) deck.push(questions[i]);
    if (i < quotes.length) deck.push(quotes[i]);
  }
  return deck;
}

/** The line to show at broadcast time `t` (seconds), or null for an empty deck. */
export function pickLine(deck, t, channelId = "") {
  const i = pickIndex(deck?.length ?? 0, Math.floor(t / LINE_SECONDS), channelId);
  return i < 0 ? null : deck[i];
}

/** The scene (a full bump definition) to show at time `t`, or null. */
export function pickScene(scenes, t, channelId = "") {
  const i = pickIndex(scenes?.length ?? 0, Math.floor(t / SCENE_SECONDS), channelId);
  return i < 0 ? null : scenes[i];
}

/** A bump definition reduced to its picture and sound: no voice-over (it
 *  belongs to a particular program change), no upcoming-show text (the
 *  player's own slate card shows the real lineup), no channel branding. */
export function toFillerDefinition(def) {
  return {
    ...def,
    announcement: null,
    // `end: 0` closes cr-bump's text layer from the first frame.
    upcoming: { count: 0, start: 0, end: 0 },
  };
}

/** Where a scene's music/ambience bed for a continuity card comes from: the
 *  scene's first "music" layer, else its first layer of any kind. */
export function bedUrlFor(scene) {
  const layers = Array.isArray(scene?.audio) ? scene.audio.filter((l) => l?.url) : [];
  return (layers.find((l) => l.source === "music") || layers[0])?.url ?? null;
}

// ---------- loading ----------

const FILLER_BASE = new URL("filler/", import.meta.url);
const BUMPS_BASE = new URL("../bumps/", import.meta.url);
let assets = null;

async function getJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** The deck and scenes, fetched once. Never rejects: whatever is missing
 *  comes back empty and the renderer degrades to what remains (a lone card
 *  with a line, or a scene with no lines). */
export function loadFiller() {
  assets ??= (async () => {
    const [quotes, sceneList] = await Promise.all([
      getJson(new URL("quotes.json", FILLER_BASE)).catch(() => null),
      getJson(new URL("scenes.json", FILLER_BASE)).catch(() => null),
    ]);
    const ids = Array.isArray(sceneList?.bumps) ? sceneList.bumps.filter((id) => typeof id === "string") : [];
    const defs = await Promise.all(ids.map((id) => getJson(new URL(`${id}.json`, BUMPS_BASE)).catch(() => null)));
    return { deck: buildDeck(quotes), scenes: defs.filter(Boolean).map(toFillerDefinition) };
  })();
  return assets;
}

// ---------- rendering ----------

const STYLE = `
.filler { position: absolute; inset: 0; background: #05070c; overflow: hidden; }
.filler cr-bump { position: absolute; inset: 0; }
.scrim { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse at center, rgba(0,0,0,.08), rgba(0,0,0,.5)), linear-gradient(to top, rgba(0,0,0,.6), transparent 45%); }
.line { position: absolute; left: 0; right: 0; bottom: clamp(24px, 9vh, 110px); padding: 0 clamp(16px, 8vw, 140px);
  display: flex; flex-direction: column; align-items: center; gap: .5em; text-align: center; color: #fff; pointer-events: none;
  text-shadow: 0 2px 14px rgba(0,0,0,.85); transition: opacity .7s ease; }
.line.off { opacity: 0; }
.line .kind { font: 800 clamp(10px, 1.2vw, 16px)/1 system-ui, sans-serif; letter-spacing: .22em; text-transform: uppercase; color: var(--filler-accent, #ffcc33); }
.line .text { margin: 0; max-width: 34ch; font: 700 clamp(18px, 3vw, 42px)/1.25 Georgia, "Times New Roman", serif; text-wrap: balance; }
.line .author { font: 500 clamp(12px, 1.5vw, 20px)/1.2 system-ui, sans-serif; opacity: .8; }
.line .author:empty { display: none; }
`;

const KIND_LABEL = { quote: "Words to live by", imponderable: "Ponder this" };

/**
 * Mounts/updates/hides the filler picture and its rotating line inside a
 * container the caller owns. Like ContinuityRenderer and BumpRenderer it
 * isn't a PlayerAdapter: the clock drives it, via its own 1 s timer while
 * shown (scene and line changes are slot boundaries of the broadcast clock).
 */
export class FillerRenderer {
  constructor(container) {
    this.container = container;
    this.root = null;
    this.bump = null;
    this.channelId = "";
    this.clockNow = () => Date.now() / 1000;
    this.muted = true;
    this.timer = 0;
    this.sceneKey = null;
    this.lineKey = null;
    this.visible = false;
    this.gen = 0; // bumped on every show()/hide(), so a load that resolves after a hide is dropped
  }

  _build() {
    if (this.root) return;
    this.root = document.createElement("div");
    this.root.className = "filler";
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.bump = document.createElement("cr-bump");
    const scrim = Object.assign(document.createElement("div"), { className: "scrim" });
    this.line = document.createElement("div");
    this.line.className = "line off";
    this.line.innerHTML = '<div class="kind"></div><p class="text"></p><div class="author"></div>';
    this.root.append(style, this.bump, scrim, this.line);
    this.container.appendChild(this.root);
  }

  /** @param {string} channelId seeds this channel's walk through scenes and lines
   *  @param {() => number} clockNow broadcast clock, seconds since the epoch
   *  @param {boolean} muted */
  async show(channelId, clockNow, muted) {
    this.channelId = channelId || "";
    this.clockNow = clockNow;
    this.muted = muted;
    const gen = ++this.gen;
    this.visible = true;
    this._build();
    this.container.hidden = false;
    const { deck, scenes } = await loadFiller();
    if (gen !== this.gen) return;
    this.deck = deck;
    this.scenes = scenes;
    this.sceneKey = null;
    this.lineKey = null;
    clearInterval(this.timer);
    this.timer = setInterval(() => this._sync(), 1000);
    this._sync();
  }

  _sync() {
    if (!this.visible) return;
    const t = this.clockNow();
    const scene = pickScene(this.scenes, t, this.channelId);
    const sceneKey = scene ? Math.floor(t / SCENE_SECONDS) : null;
    if (scene && sceneKey !== this.sceneKey) {
      this.sceneKey = sceneKey;
      this.bump.clockNow = this.clockNow;
      this.bump.definition = scene;
      this.root.style.setProperty("--filler-accent", scene.style?.accent || "");
      // Same offset arithmetic as a scheduled bump: the clock decides where in the loop we are.
      this.bump.play({ muted: this.muted, offset: t % SCENE_SECONDS });
    }
    const lineSlot = Math.floor(t / LINE_SECONDS);
    if (lineSlot !== this.lineKey) {
      this.lineKey = lineSlot;
      this._showLine(pickLine(this.deck, t, this.channelId));
    }
  }

  _showLine(entry) {
    const el = this.line;
    el.classList.add("off");
    if (!entry) return;
    // Let the old line fade out before swapping the text under it.
    setTimeout(() => {
      if (!this.visible) return;
      el.querySelector(".kind").textContent = KIND_LABEL[entry.kind] || "";
      el.querySelector(".text").textContent = entry.text;
      el.querySelector(".author").textContent = entry.author ? `— ${entry.author}` : "";
      el.classList.remove("off");
    }, this.lineShown ? 700 : 0);
    this.lineShown = true;
  }

  setMuted(muted) {
    this.muted = muted;
    this.bump?.setMuted(muted);
  }

  hide() {
    this.gen++;
    this.visible = false;
    this.lineShown = false;
    clearInterval(this.timer);
    this.timer = 0;
    this.container.hidden = true;
    this.bump?.stop();
    this.line?.classList.add("off");
  }

  destroy() {
    this.hide();
    this.root?.remove();
    this.root = null;
    this.bump = null;
  }
}

/**
 * A quiet looping music bed for stretches that have a picture but no sound
 * of their own (continuity cards). One <audio> element, owned by the
 * player; start() picks this moment's scene from the same walk the full
 * filler uses.
 */
export class FillerBed {
  constructor() {
    this.audio = null;
    this.muted = true;
    this.gen = 0;
  }

  async start(channelId, clockNow, muted) {
    this.muted = muted;
    const gen = ++this.gen;
    const { scenes } = await loadFiller();
    if (gen !== this.gen) return;
    const url = bedUrlFor(pickScene(scenes, clockNow(), channelId));
    if (!url) return;
    const abs = new URL(`../${url}`, import.meta.url).href;
    this.audio ??= Object.assign(new Audio(), { loop: true, volume: BED_VOLUME });
    this.audio.muted = muted;
    if (this.audio.src !== abs) this.audio.src = abs;
    this.audio.play().catch(() => { /* autoplay refused: stays silent until the viewer engages, like every other channel sound */ });
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.audio) this.audio.muted = muted;
  }

  stop() {
    this.gen++;
    if (!this.audio) return;
    this.audio.pause();
    this.audio.removeAttribute("src");
  }

  destroy() {
    this.stop();
    this.audio = null;
  }
}
