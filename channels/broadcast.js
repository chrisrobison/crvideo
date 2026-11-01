// Broadcast clock + player shared by the channel guide (index.html) and the
// watch page (watch.html).
//
// A channel is a folder under channels/ holding a meta.json and an ia-import
// schedule.json (see channels.php). The schedule's blocks are laid end to end
// into one loop -- the "cycle" -- that repeats forever, anchored to wall-clock
// time. At any instant every viewer computes the same position in the loop,
// so tuning in joins whatever is already on, mid-program, like a broadcast.
// Nothing on the server keeps playback state.
//
// meta.json may set "anchor" (an ISO timestamp) to choose when the cycle's
// first block airs; by default the loop is anchored to the Unix epoch.

export const CHANNEL_ID = /^[a-z0-9][a-z0-9-]*$/;
const CHANNELS_URL = new URL("./", import.meta.url);

export async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

// ---------- clock ----------

let clockSkewMs = 0;

/** Correct for a viewer whose computer clock is wrong, using the server's
 *  Date header. It only has 1 s resolution, so small skews are left alone. */
export async function syncClock(url = new URL("channels.php", CHANNELS_URL)) {
  try {
    const sent = Date.now();
    const r = await fetch(url, { method: "HEAD", cache: "no-store" });
    const received = Date.now();
    const server = Date.parse(r.headers.get("Date") || "");
    if (!Number.isFinite(server)) return;
    const skew = server + 500 - (sent + received) / 2;
    if (Math.abs(skew) > 2000) clockSkewMs = skew;
  } catch { /* keep the local clock */ }
}

/** Broadcast time, in seconds since the Unix epoch. */
export const now = () => (Date.now() + clockSkewMs) / 1000;

// ---------- timeline ----------

const mod = (a, n) => ((a % n) + n) % n;

/** Flatten ia-import's blocks into one sorted list of entries with start/end
 *  in seconds from the start of the cycle. Block offsets are accumulated here
 *  rather than read from `relative_start`, which doesn't account for overflow
 *  blocks longer than the slot. */
export function buildTimeline(schedule, anchor = 0) {
  const entries = [];
  let blockStart = 0;
  for (const block of schedule.blocks || []) {
    const length = Number(block.duration);
    if (!(length > 0)) continue;
    for (const item of block.items || []) {
      const start = blockStart + Number(item.start);
      const end = start + Number(item.duration);
      if (!(end > start)) continue;
      const playable = item.type !== "gap" && !!item.media_url;
      entries.push({
        type: item.type,
        id: item.id ?? null,
        title: item.title || (playable ? item.id : null),
        mediaUrl: playable ? item.media_url : null,
        sourceUrl: item.source_url || null,
        start, end,
      });
    }
    blockStart += length;
  }
  if (!entries.length || !(blockStart > 0)) throw new Error("Schedule has nothing to air.");
  entries.sort((a, b) => a.start - b.start);
  return { entries, cycle: blockStart, anchor };
}

/** What is on at time t: the entry plus its absolute startsAt/endsAt. Time
 *  the schedule leaves uncovered comes back as a synthetic gap entry. */
export function locate(tl, t = now()) {
  const { entries } = tl;
  const pos = mod(t - tl.anchor, tl.cycle);
  const cycleStart = t - pos;
  let lo = 0, hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entries[mid].start <= pos) lo = mid; else hi = mid - 1;
  }
  let e = entries[lo];
  if (pos < e.start) {
    e = { type: "gap", id: null, title: null, mediaUrl: null, start: 0, end: e.start };
  } else if (pos >= e.end) {
    const next = entries[lo + 1];
    e = { type: "gap", id: null, title: null, mediaUrl: null, start: e.end, end: next ? next.start : tl.cycle };
  }
  return { ...e, startsAt: cycleStart + e.start, endsAt: cycleStart + e.end };
}

/** Every entry airing between `from` and `until`, wrapping around the cycle. */
export function airings(tl, from, until) {
  const { entries } = tl;
  const pos = mod(from - tl.anchor, tl.cycle);
  let cycleStart = from - pos;
  let i = entries.findIndex((e) => e.end > pos);
  if (i < 0) { i = 0; cycleStart += tl.cycle; }
  const out = [];
  while (out.length < 10000) {
    const e = entries[i];
    const startsAt = cycleStart + e.start;
    if (startsAt >= until) break;
    out.push({ ...e, startsAt, endsAt: cycleStart + e.end });
    if (++i === entries.length) { i = 0; cycleStart += tl.cycle; }
  }
  return out;
}

/** The next real program (not a gap) starting after t. */
export function nextProgram(tl, t = now()) {
  return airings(tl, t, t + tl.cycle).find((a) => a.startsAt > t && a.mediaUrl) || null;
}

// ---------- channels ----------

export async function listChannels() {
  const { channels } = await fetchJson(new URL("channels.php", CHANNELS_URL));
  return channels || [];
}

/** Load one channel. Pass `meta` when it's already in hand (channels.php
 *  returns each channel's meta.json) to skip refetching it. */
export async function loadChannel(id, meta = null) {
  if (!CHANNEL_ID.test(id || "")) throw new Error(`Bad channel id: ${id}`);
  const base = new URL(`${id}/`, CHANNELS_URL);
  meta ??= await fetchJson(new URL("meta.json", base));
  const schedule = await fetchJson(new URL(meta.schedule || "schedule.json", base));
  const anchor = meta.anchor ? Date.parse(meta.anchor) / 1000 : 0;
  return {
    id,
    number: Number.isFinite(meta.number) ? meta.number : null,
    name: meta.name || schedule.channel || id,
    description: meta.description || "",
    logo: meta.logo ? new URL(meta.logo, base).href : null,
    catalogUrl: new URL(meta.catalog || "catalog.json", base).href,
    timeline: buildTimeline(schedule, Number.isFinite(anchor) ? anchor : 0),
  };
}

const catalogs = new Map();

/** A channel's catalog.json as a Map of item id -> item (year, creator,
 *  description...). Optional: resolves to an empty Map if it's missing. */
export function loadCatalog(channel) {
  if (!catalogs.has(channel.catalogUrl)) {
    catalogs.set(channel.catalogUrl, fetchJson(channel.catalogUrl)
      .then((c) => new Map((c.items || []).map((item) => [item.id, item])))
      .catch(() => new Map()));
  }
  return catalogs.get(channel.catalogUrl);
}

// ---------- formatting ----------

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export const clock = (t) => timeFormat.format(new Date(t * 1000));

export function minutesLeft(seconds) {
  const m = Math.max(1, Math.ceil(seconds / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

/** Internet Archive descriptions often contain HTML; reduce to plain text. */
export function plainText(html) {
  if (!html) return "";
  return (new DOMParser().parseFromString(String(html), "text/html").body.textContent || "")
    .replace(/\s+/g, " ").trim();
}

// ---------- player ----------

const DRIFT_TOLERANCE = 3; // seconds off the live point before re-seeking
const DRIFT_CHECK_MS = 5000;

/**
 * Keeps a <video> on the live point of a channel. It starts muted (browsers
 * always allow muted autoplay), never stays paused, follows the wall clock
 * from program to program, and re-seeks if buffering lets it fall behind.
 *
 * onAiring(airing) fires when the program changes; onState(state, airing)
 * reports "loading" | "playing" | "buffering" | "slate" (gap, or the file
 * ended before its slot did) | "error" (retrying) | "blocked" (the browser
 * refused even muted autoplay; call resume() from a click).
 */
export class BroadcastPlayer {
  constructor(video, { onAiring = () => {}, onState = () => {} } = {}) {
    Object.assign(this, { video, onAiring, onState });
    this.timeline = null;
    this.airing = null;
    this.state = null;
    this.failures = 0;
    this.retryAt = 0;
    this.lastDriftCheck = 0;

    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.controls = false;
    video.preload = "auto";
    video.disablePictureInPicture = true;

    video.addEventListener("loadedmetadata", () => this.seekToLive(0.5));
    video.addEventListener("playing", () => { this.failures = 0; this.setState("playing"); });
    video.addEventListener("waiting", () => this.setState("buffering"));
    video.addEventListener("ended", () => this.setState("slate"));
    video.addEventListener("error", () => this.fail());
    // A broadcast never pauses: whatever paused it (a media key, the OS),
    // pick right back up -- tick() then re-seeks to the live point.
    video.addEventListener("pause", () => {
      if (this.airing?.mediaUrl && !video.ended && this.state !== "error") this.play();
    });

    this.tick = this.tick.bind(this);
  }

  setTimeline(timeline) {
    this.timeline = timeline;
    this.airing = null;
    this.tick();
  }

  start() {
    clearInterval(this.timer);
    this.timer = setInterval(this.tick, 500);
    this.tick();
  }

  /** Call from a user gesture if state is "blocked". */
  resume() {
    if (this.state === "blocked") this.setState("loading");
    this.play();
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.onState(state, this.airing);
  }

  tick() {
    if (!this.timeline) return;
    const loc = locate(this.timeline);
    if (!this.airing || Math.abs(loc.startsAt - this.airing.startsAt) > 0.001) {
      this.switchTo(loc);
      return;
    }
    if (!this.airing.mediaUrl) return;
    if (this.state === "error") {
      if (Date.now() >= this.retryAt) this.load();
      return;
    }
    const v = this.video;
    if (v.paused && !v.ended && this.state !== "blocked") this.play();
    if (Date.now() - this.lastDriftCheck >= DRIFT_CHECK_MS) {
      this.lastDriftCheck = Date.now();
      this.seekToLive(DRIFT_TOLERANCE);
    }
  }

  switchTo(airing) {
    this.airing = airing;
    this.failures = 0;
    this.onAiring(airing);
    if (airing.mediaUrl) {
      this.load();
    } else {
      this.video.removeAttribute("src");
      this.video.load();
      this.setState("slate");
    }
  }

  load() {
    this.setState("loading");
    this.lastDriftCheck = Date.now();
    this.video.src = this.airing.mediaUrl;
    this.play();
  }

  seekToLive(tolerance) {
    const v = this.video;
    if (!this.airing?.mediaUrl || v.readyState < 1 || v.seeking) return;
    const target = now() - this.airing.startsAt;
    // The file can be a little shorter than its slot; once we're past its
    // end, let it end and hold the slate until the next program.
    if (Number.isFinite(v.duration) && target >= v.duration - 0.25) return;
    if (Math.abs(v.currentTime - target) > tolerance) v.currentTime = Math.max(0, target);
  }

  play() {
    const p = this.video.play();
    if (p) p.catch((err) => { if (err.name === "NotAllowedError") this.setState("blocked"); });
  }

  fail() {
    if (!this.video.getAttribute("src")) return;
    this.failures++;
    this.retryAt = Date.now() + Math.min(30000, 2000 * 2 ** (this.failures - 1));
    this.setState("error");
  }
}
