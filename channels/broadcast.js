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
//
// catalog.json (optional per channel) enriches schedule items with year/
// creator/description for display, and may also reference externally
// maintained series.json files (see catalog-resolver.js and series/*). That
// resolution logic lives in its own module so it can be reused outside the
// browser later; loadCatalog() below is just the thin, cached wrapper the
// guide and player already called.

import { fetchJson, resolveCatalog } from "./catalog-resolver.js";
import {
  Html5PlayerAdapter, YouTubePlayerAdapter, ContinuityRenderer, resolveProvider, computeBackoffMs, computeDriftCorrection,
} from "./player-adapters.js";

export const CHANNEL_ID = /^[a-z0-9][a-z0-9-]*$/;
const CHANNELS_URL = new URL("./", import.meta.url);

export { fetchJson };

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
 *  blocks longer than the slot.
 *
 *  Each item's provider is read from its own structured "source" field
 *  (the same {"provider": ..., "video_id": ...} shape series.json's
 *  episodes already use -- see player-adapters.js's resolveProvider()),
 *  not guessed from a URL. An item with no "source" at all but a
 *  media_url is the pre-existing, still fully supported, implicit "html5"
 *  convention every ia-import-produced schedule.json already uses. */
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
      // A "continuity" item (Phase 4/5/6) is never driven through a PlayerAdapter --
      // it has no provider and is rendered, not played -- but it IS a real,
      // compiler-decided occurrence, not an undefined/empty gap.
      entries.push(mapScheduleItem(item, start, end));
    }
    blockStart += length;
  }
  if (!entries.length || !(blockStart > 0)) throw new Error("Schedule has nothing to air.");
  entries.sort((a, b) => a.start - b.start);
  return { entries, cycle: blockStart, anchor };
}

/**
 * Phase 4 of docs/guide-update.md: the GUIDE-facing projection of a
 * published schedule.json, as opposed to buildTimeline()'s PLAYBACK-facing
 * one above. Same raw input, same per-item absolute-cycle-position math
 * (an item's `program_id`, if any, never changes where or how long it
 * airs) -- the only difference is what counts as one "entry":
 *
 *   - An item carrying a `program_id` that resolves against this
 *     schedule's top-level `programs` collection (Phase 3) is folded into
 *     that program's single guide entry, as one of its ordered
 *     `episodes`, instead of becoming its own entry. This is what turns
 *     five packed videos (or a packed video plus its trailing
 *     continuity filler -- Phase 7) into one "Electronics Lab" cell.
 *   - Any item with no resolvable `program_id` -- every item in a legacy,
 *     non-programming.json schedule (Phase 8, e.g. Film Day at School),
 *     or a genuine inter-program station break in a programming.json-
 *     sourced one -- passes through as its own entry, byte-for-byte the
 *     same shape buildTimeline() would have produced for it. This is the
 *     legacy/standalone-short-program fallback: nothing is ever grouped
 *     by guessing from titles or adjacency, only from this explicit
 *     reference.
 *
 * A program entry's own start/end are its EFFECTIVE presentation window
 * (schedule.json programs[].start/end -- already shifted by any boundary
 * delay; see BoundaryResolver), not a derived min/max over its episodes,
 * so Phase 7's "two EPG cells never overlap" holds even when a block's
 * own episodes under-fill it.
 *
 * Returned entries share buildTimeline()'s {start,end,playable,...} shape
 * (plus `episodes` on a program entry), so the existing locate()/
 * airings() functions below work completely unchanged over either
 * timeline. This function never reads anything playback-specific and
 * never mutates its input -- the player keeps using buildTimeline()'s
 * timeline, completely unaffected by whatever the guide does with this one.
 */
export function buildEpgTimeline(schedule, anchor = 0) {
  const programsById = new Map();
  for (const p of schedule.programs || []) {
    if (p && typeof p.occurrence_id === "string") programsById.set(p.occurrence_id, p);
  }

  const episodesByProgram = new Map(); // occurrence_id -> ordered episode entries
  const entries = [];
  let blockStart = 0;
  for (const block of schedule.blocks || []) {
    const length = Number(block.duration);
    if (!(length > 0)) continue;
    for (const item of block.items || []) {
      const start = blockStart + Number(item.start);
      const end = start + Number(item.duration);
      if (!(end > start)) continue;
      const mapped = mapScheduleItem(item, start, end);
      const programId = typeof item.program_id === "string" ? item.program_id : null;
      if (programId !== null && programsById.has(programId)) {
        let episodes = episodesByProgram.get(programId);
        if (!episodes) episodesByProgram.set(programId, (episodes = []));
        episodes.push(mapped);
      } else {
        entries.push(mapped);
      }
    }
    blockStart += length;
  }

  for (const [occurrenceId, episodes] of episodesByProgram) {
    const p = programsById.get(occurrenceId);
    episodes.sort((a, b) => a.start - b.start);
    entries.push({
      type: "program",
      id: occurrenceId,
      blockId: p.block_id,
      title: p.title || episodes[0].title || occurrenceId,
      description: p.description || null,
      seriesId: p.series_id || null,
      seriesTitle: p.series_title || null,
      boundaryMode: p.boundary_mode || "hard",
      playable: true,
      episodes,
      start: p.start,
      end: p.end,
    });
  }

  if (!entries.length || !(blockStart > 0)) throw new Error("Schedule has nothing to air.");
  entries.sort((a, b) => a.start - b.start);
  return { entries, cycle: blockStart, anchor };
}

/** Phase 6: an episode's own absolute (wall-clock) start/end, given the
 *  program-level airing (as returned by locate()/airings() over an EPG
 *  timeline) it belongs to. Pure arithmetic from fields already on both
 *  objects (airing.start/.startsAt are the same cycle-relative/absolute
 *  pair every airing carries) -- no separate lookup, no re-deriving
 *  boundaries from anything other than the schedule's own data. */
export function episodeAiringTimes(programAiring, episode) {
  const offset = programAiring.startsAt - programAiring.start;
  return { startsAt: episode.start + offset, endsAt: episode.end + offset };
}

/** Maps one raw schedule item (already placed at absolute cycle-relative
 *  start/end) into the common entry shape both buildTimeline() and
 *  buildEpgTimeline() use. Shared so the two projections can never drift
 *  apart on what a "video"/"continuity"/"gap" item means. */
function mapScheduleItem(item, start, end) {
  const { provider, videoId } = resolveProvider(item);
  const isContinuity = item.type === "continuity";
  const playable = item.type !== "gap" && !isContinuity && provider !== null;
  return {
    type: item.type,
    id: item.id ?? null,
    title: item.title || (playable ? item.id : null),
    description: item.description || null,
    thumbnailUrl: item.thumbnail_url || null,
    template: item.template || null,
    nextProgramId: item.next_program_id ?? null,
    playable,
    provider,
    videoId,
    mediaUrl: item.media_url || null,
    sourceUrl: item.source_url || (item.source && item.source.url) || null,
    start, end,
  };
}

const GAP_ENTRY = {
  type: "gap", id: null, title: null, description: null, thumbnailUrl: null, template: null, nextProgramId: null,
  playable: false, provider: null, videoId: null, mediaUrl: null, sourceUrl: null,
};

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
    e = { ...GAP_ENTRY, start: 0, end: e.start };
  } else if (pos >= e.end) {
    const next = entries[lo + 1];
    e = { ...GAP_ENTRY, start: e.end, end: next ? next.start : tl.cycle };
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
  return airings(tl, t, t + tl.cycle).find((a) => a.startsAt > t && a.playable) || null;
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
    // Optional per-channel continuity-card theme (Phase 5): a plain
    // {bg,bg2,fg,muted,accent,accentWarm} map of CSS custom-property
    // values -- see continuity-card.js's :host defaults for the generic
    // fallback used when a channel sets none of this. Never interpreted
    // or validated here; it's just handed straight through to whatever
    // renders the card.
    theme: (meta.theme && typeof meta.theme === "object") ? meta.theme : null,
    catalogUrl: new URL(meta.catalog || "catalog.json", base).href,
    timeline: buildTimeline(schedule, Number.isFinite(anchor) ? anchor : 0),
    // Phase 4/5 of docs/guide-update.md: the guide's own program-level
    // projection of the same schedule -- see buildEpgTimeline()'s header.
    // Never read by BroadcastPlayer/watch.html; only the channel guide
    // (index.html) uses this field, so playback is completely unaffected
    // by anything built here.
    epgTimeline: buildEpgTimeline(schedule, Number.isFinite(anchor) ? anchor : 0),
  };
}

const catalogs = new Map();

/** A channel's catalog.json as a Map of item id -> item (year, creator,
 *  description...), with any series it references (see catalog-
 *  resolver.js) merged in under "<seriesId>:<episodeId>" keys. Optional:
 *  resolves to an empty Map if the catalog is missing. A catalog with no
 *  "series" array behaves exactly as before (legacy, flat-items-only). */
export function loadCatalog(channel) {
  if (!catalogs.has(channel.catalogUrl)) {
    catalogs.set(channel.catalogUrl, resolveCatalog(channel.catalogUrl, { fetchJson })
      .then(({ items, errors }) => {
        if (errors.length) console.warn(`Catalog ${channel.catalogUrl}:`, errors);
        return items;
      })
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
const MAX_RETRIES_PER_PROGRAM = 5; // bounded: after this many failures, stop retrying until the schedule itself advances

/**
 * Keeps playback on the live point of a channel, across whichever
 * provider is currently scheduled (HTML5 <video> for Internet-Archive-
 * style direct files via Html5PlayerAdapter, or YouTube's IFrame API via
 * YouTubePlayerAdapter -- see player-adapters.js). It starts muted
 * (browsers only allow muted autoplay without a user gesture), never
 * stays paused, follows the wall clock from program to program, and
 * re-seeks if buffering lets it fall behind.
 *
 * `video` is the <video> element used for HTML5 playback, exactly as
 * before. `youtubeContainer`, if given, is a separate plain element (e.g.
 * an empty <div>) the YouTube iframe is mounted into when a scheduled
 * program's source.provider is "youtube"; its visibility is toggled
 * opposite the <video> element's as programs change. Without it, a
 * YouTube-provider program is treated the same as a failed program (see
 * MAX_RETRIES_PER_PROGRAM) -- shown as a station break for the rest of
 * its slot rather than crashing anything else on the page. This is how
 * index.html's small preview (no youtubeContainer) stays simple while
 * watch.html's full player (which passes one) can actually play it.
 *
 * onAiring(airing) fires when the program changes; onState(state, airing)
 * reports "loading" | "playing" | "buffering" | "slate" (gap, the file
 * ended before its slot did, or no adapter is available for this
 * program's provider) | "error" (retrying, up to a bound) | "blocked"
 * (autoplay was refused; call resume() from a click).
 */
export class BroadcastPlayer {
  constructor(video, { youtubeContainer = null, continuityContainer = null, onAiring = () => {}, onState = () => {} } = {}) {
    Object.assign(this, { video, youtubeContainer, continuityContainer, onAiring, onState });
    this.timeline = null;
    this.airing = null;
    this.state = null;
    this.activeProvider = null;
    this.activeAdapter = null;
    this.channelMeta = null;
    this.muted = true;
    this.failures = 0;
    this.retryAt = 0;
    this.retriesExhausted = false;
    this.lastDriftCheck = 0;

    const onStateChange = (state) => {
      if (state === "playing") { this.failures = 0; this.retriesExhausted = false; }
      this.setState(state === "ended" ? "slate" : state);
    };
    const onError = (err) => this.fail(err);
    this.adapters = {
      html5: new Html5PlayerAdapter(video, { onStateChange, onError }),
      youtube: youtubeContainer ? new YouTubePlayerAdapter(youtubeContainer, { onStateChange, onError }) : null,
    };
    // continuity (Phase 5/6): only built when a page actually passes a
    // container (watch.html's full player; index.html's small guide
    // preview doesn't) -- without one, a "continuity" airing falls back
    // to the ordinary station-break slate, same as an unsupported
    // provider already does.
    this.continuityRenderer = continuityContainer ? new ContinuityRenderer(continuityContainer) : null;

    this.tick = this.tick.bind(this);
  }

  /** Channel display info (name/logo) handed to the continuity card.
   *  Optional second argument to setTimeline() so existing callers
   *  (just `player.setTimeline(channel.timeline)`) keep working unchanged. */
  setTimeline(timeline, channelMeta = null) {
    this.timeline = timeline;
    this.channelMeta = channelMeta;
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
    this.activeAdapter?.play();
  }

  /** Mute/unmute, preserved across program and provider transitions
   *  (e.g. a viewer who unmuted stays unmuted moving from an Internet
   *  Archive film into a YouTube-sourced one) for as long as each
   *  provider permits programmatic control of it. */
  setMuted(muted) {
    this.muted = muted;
    this.activeAdapter?.setMuted(muted);
  }

  isMuted() {
    return this.activeAdapter ? this.activeAdapter.isMuted() : this.muted;
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
    if (!this.airing.playable) return;
    if (this.state === "error") {
      if (!this.retriesExhausted && Date.now() >= this.retryAt) this.load();
      return;
    }
    if (this.state !== "blocked" && this.state !== "loading") {
      if (Date.now() - this.lastDriftCheck >= DRIFT_CHECK_MS) {
        this.lastDriftCheck = Date.now();
        const target = computeDriftCorrection(
          this.activeAdapter?.getCurrentTime(), now() - this.airing.startsAt, DRIFT_TOLERANCE, this.activeAdapter?.getDuration(),
        );
        if (target !== null) this.activeAdapter.seek(target);
      }
    }
  }

  switchTo(airing) {
    this.airing = airing;
    this.failures = 0;
    this.retriesExhausted = false;
    this.onAiring(airing);

    // A continuity occurrence (Phase 4/5/6) is a dedicated third case, checked
    // before the ordinary playable/not-playable branching below: it is never
    // "played" through an adapter, just rendered. Whichever adapter was
    // active is paused and hidden first -- including the YouTube iframe,
    // which per its own required presentation is never drawn under/behind
    // anything else -- exactly the same "pause, never destroy" rule as any
    // other program transition.
    if (airing.type === "continuity" && this.continuityRenderer) {
      if (this.activeAdapter) this.activeAdapter.pause();
      this.activeProvider = null;
      this.activeAdapter = null;
      this.video.hidden = true;
      if (this.youtubeContainer) this.youtubeContainer.hidden = true;
      const next = nextProgram(this.timeline, airing.startsAt);
      this.continuityRenderer.show(
        this.channelMeta,
        next ? { title: next.title, description: next.description, thumbnailUrl: next.thumbnailUrl, startsAt: next.startsAt } : null,
        now,
        { startsAt: airing.startsAt, endsAt: airing.endsAt },
      );
      this.setState("continuity");
      return;
    }
    this.continuityRenderer?.hide();

    const adapter = airing.playable ? (airing.provider === "youtube" ? this.adapters.youtube : this.adapters.html5) : null;
    // Pause (never destroy) whichever adapter is being switched away from
    // -- the YouTube iframe in particular stays alive and is reused via
    // loadVideoById() the next time a YouTube program comes up, rather
    // than being torn down and recreated for every program transition.
    if (this.activeAdapter && this.activeAdapter !== adapter) this.activeAdapter.pause();

    if (adapter) {
      this.activeProvider = airing.provider;
      this.activeAdapter = adapter;
      this.video.hidden = airing.provider !== "html5";
      if (this.youtubeContainer) this.youtubeContainer.hidden = airing.provider !== "youtube";
      this.activeAdapter.setMuted(this.muted);
      this.load();
    } else {
      // Either a station break (no program scheduled) or a program whose
      // provider this page has no adapter for (e.g. a YouTube program on
      // a page that didn't pass a youtubeContainer) -- both show the same
      // slate; there's nothing to retry.
      this.activeProvider = null;
      this.activeAdapter = null;
      this.video.hidden = true;
      if (this.youtubeContainer) this.youtubeContainer.hidden = true;
      this.setState("slate");
    }
  }

  /** Fully tears down both adapters (including destroying the YouTube
   *  iframe, if one was ever created) and stops the polling loop. Neither
   *  index.html nor watch.html calls this today -- each creates one
   *  BroadcastPlayer for the page's lifetime -- but it's here for any
   *  future caller that needs to unmount a player outright. */
  destroy() {
    clearInterval(this.timer);
    this.adapters.html5.destroy();
    this.adapters.youtube?.destroy();
    this.continuityRenderer?.destroy();
  }

  load() {
    this.setState("loading");
    this.lastDriftCheck = Date.now();
    const offset = now() - this.airing.startsAt;
    const source = this.activeProvider === "youtube" ? this.airing.videoId : this.airing.mediaUrl;
    this.activeAdapter.load(source, Math.max(0, offset));
  }

  /** A playback failure from whichever adapter is active. Bounded
   *  retries with exponential backoff; a `fatal` error (e.g. YouTube
   *  reporting the video was removed or can't be embedded) skips
   *  straight to "no more retries" since trying again can't help.
   *  Once exhausted, this program just sits in "error" (shown as a
   *  station break) until the schedule's own clock moves on to the next
   *  one -- "falling back to approved programming" is that next program
   *  airing on time, same as any gap recovers today. */
  fail(err) {
    this.failures++;
    if (err?.fatal || this.failures > MAX_RETRIES_PER_PROGRAM) {
      this.retriesExhausted = true;
    } else {
      this.retryAt = Date.now() + computeBackoffMs(this.failures);
    }
    this.setState("error");
  }
}
