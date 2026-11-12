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
// catalog.json (optional per channel) enriches schedule items with display
// metadata and may reference external series.json files; see
// catalog-resolver.js.

import { fetchJson, resolveCatalog } from "./catalog-resolver.js";
import {
  Html5PlayerAdapter, YouTubePlayerAdapter, ContinuityRenderer, BumpRenderer,
  resolveProvider, computeBackoffMs, computeDriftCorrection, locateActiveBump,
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

// ---------- title display ----------

// Tokens treated as acronyms: left as-is even inside a shouted run.
const TITLE_CASE_ACRONYMS = new Set([
  "dw", "us", "uk", "usa", "un", "eu", "uae", "rok", "nyc", "la", "tv",
  "rv", "atv", "diy", "fbi", "cia", "nasa", "gps", "atm", "suv", "ok",
]);

const TITLE_CASE_MINOR_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into",
  "nor", "of", "on", "onto", "or", "over", "so", "the", "to", "up", "vs",
  "via", "with", "yet",
]);

const isAllCapsCore = (tok) => {
  const core = tok.replace(/[^A-Za-z]/g, "");
  return core.length >= 2 && core === core.toUpperCase();
};

/** Turns YouTube-style ALL-CAPS "SHOUTING" into normal title case, one
 *  word at a time, so it only ever touches text that was actually
 *  all-caps -- an already mixed-case title (or the mixed-case part of a
 *  partly-shouted one, e.g. a parenthetical) passes through byte-for-byte.
 *  A token is rewritten only when it's part of a run of 2+ consecutive
 *  all-caps tokens, or is a single isolated all-caps token of 5+ letters;
 *  a short isolated all-caps token (DW, US, ROK, ...) is almost always an
 *  acronym, not shouting, so it's left alone, and a few common acronyms
 *  are protected even inside a shouted run. Minor words (the, of, in...)
 *  are lowercased unless they open the title, matching normal title-case
 *  style. Opt in per channel via meta.json's "fixAllCapsTitles": true --
 *  see loadChannel() -- never applied unconditionally. */
export function fixShoutingTitle(title) {
  if (!title) return title;
  const tokens = title.split(" ");
  const flags = tokens.map(isAllCapsCore);
  const n = tokens.length;
  return tokens.map((tok, i) => {
    const bare = tok.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
    if (!flags[i] || TITLE_CASE_ACRONYMS.has(bare)) return tok;
    let run = 1;
    for (let j = i - 1; j >= 0 && flags[j]; j--) run++;
    for (let j = i + 1; j < n && flags[j]; j++) run++;
    const coreLen = tok.replace(/[^A-Za-z]/g, "").length;
    if (run < 2 && coreLen < 5) return tok;
    const lower = tok.toLowerCase();
    if (i > 0 && TITLE_CASE_MINOR_WORDS.has(bare)) return lower;
    return lower.replace(/[a-z]/, (c) => c.toUpperCase());
  }).join(" ");
}

// ---------- timeline ----------

const mod = (a, n) => ((a % n) + n) % n;

/** Flatten ia-import's blocks into one sorted list of entries with start/end
 *  in seconds from the start of the cycle. Block offsets are accumulated here
 *  rather than read from `relative_start`, which doesn't account for overflow
 *  blocks longer than the slot. Provider comes from each item's structured
 *  "source" field (see resolveProvider()); an item with only a media_url is
 *  implicitly "html5". */
export function buildTimeline(schedule, anchor = 0, formatTitle = null) {
  const entries = [];
  let blockStart = 0;
  for (const block of schedule.blocks || []) {
    const length = Number(block.duration);
    if (!(length > 0)) continue;
    for (const item of block.items || []) {
      const start = blockStart + Number(item.start);
      const end = start + Number(item.duration);
      if (!(end > start)) continue;
      entries.push(mapScheduleItem(item, start, end, formatTitle));
    }
    blockStart += length;
  }
  if (!entries.length || !(blockStart > 0)) throw new Error("Schedule has nothing to air.");
  entries.sort((a, b) => a.start - b.start);
  return { entries, cycle: blockStart, anchor };
}

/**
 * The GUIDE-facing projection of a published schedule.json (buildTimeline()
 * is the playback-facing one). Same input and cycle-position math; the
 * difference is what counts as one entry:
 *
 *   - An item whose `program_id` resolves in the schedule's top-level
 *     `programs` is folded into that program's single entry as one of its
 *     ordered `episodes` (e.g. five packed videos plus trailing continuity
 *     filler become one "Electronics Lab" cell).
 *   - Any other item (a schedule without programs, or a station break
 *     between programs) passes through as its own entry, identical to what
 *     buildTimeline() produces. Nothing is grouped by title or adjacency.
 *
 * A program entry's start/end are its effective presentation window
 * (programs[].start/end, already shifted by any boundary delay; see
 * BoundaryResolver), not min/max over its episodes, so two EPG cells never
 * overlap even when a block's episodes under-fill it.
 *
 * Entries share buildTimeline()'s shape (plus `episodes` on programs), so
 * locate()/airings() work over either timeline. Never mutates its input.
 */
export function buildEpgTimeline(schedule, anchor = 0, formatTitle = null) {
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
      const mapped = mapScheduleItem(item, start, end, formatTitle);
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
    const rawTitle = p.title || episodes[0].title || occurrenceId;
    entries.push({
      type: "program",
      id: occurrenceId,
      blockId: p.block_id,
      title: formatTitle ? formatTitle(rawTitle) : rawTitle,
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

/** An episode's absolute (wall-clock) start/end, given the program-level
 *  airing (from locate()/airings() over an EPG timeline) it belongs to. */
export function episodeAiringTimes(programAiring, episode) {
  const offset = programAiring.startsAt - programAiring.start;
  return { startsAt: episode.start + offset, endsAt: episode.end + offset };
}

/** Maps one raw schedule item (already placed at absolute cycle-relative
 *  start/end) into the common entry shape both buildTimeline() and
 *  buildEpgTimeline() use. Shared so the two projections can never drift
 *  apart on what a "video"/"continuity"/"gap" item means. */
function mapScheduleItem(item, start, end, formatTitle = null) {
  const { provider, videoId } = resolveProvider(item);
  const isContinuity = item.type === "continuity";
  const playable = item.type !== "gap" && !isContinuity && provider !== null;
  const rawTitle = item.title || (playable ? item.id : null);
  return {
    type: item.type,
    id: item.id ?? null,
    title: formatTitle && rawTitle ? formatTitle(rawTitle) : rawTitle,
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
  // Opt-in per channel: meta.json's "fixAllCapsTitles" runs titles through
  // fixShoutingTitle(), for imports whose source titles are inconsistently
  // all-caps.
  const formatTitle = meta.fixAllCapsTitles ? fixShoutingTitle : null;
  return {
    id,
    number: Number.isFinite(meta.number) ? meta.number : null,
    name: meta.name || schedule.channel || id,
    description: meta.description || "",
    logo: meta.logo ? new URL(meta.logo, base).href : null,
    // Optional continuity-card color tokens ({bg,bg2,fg,muted,accent,accentWarm});
    // passed through unvalidated (see continuity-card.js :host defaults).
    theme: (meta.theme && typeof meta.theme === "object") ? meta.theme : null,
    catalogUrl: new URL(meta.catalog || "catalog.json", base).href,
    // Bumper theme (channels/<id>/theme.json): the weighted background/content
    // treatments a continuity card picks from. Distinct from `theme` above.
    // Lazily fetched; see loadTheme().
    themeUrl: new URL(meta.bumperTheme || "theme.json", base).href,
    // AI announcer manifest (channels/<id>/announcements.json). Lazily
    // fetched; see loadAnnouncements().
    announcementsUrl: new URL(meta.announcements || "announcements.json", base).href,
    // Clock-anchored bump rules (channels/<id>/bump-schedule.json), resolved
    // and driven client-side; see player-adapters.js's "bump scheduling"
    // header. Lazily fetched.
    bumpScheduleUrl: new URL(meta.bumpSchedule || "bump-schedule.json", base).href,
    timeline: buildTimeline(schedule, Number.isFinite(anchor) ? anchor : 0, formatTitle),
    // Guide-only projection (see buildEpgTimeline()); BroadcastPlayer never reads it.
    epgTimeline: buildEpgTimeline(schedule, Number.isFinite(anchor) ? anchor : 0, formatTitle),
  };
}

const catalogs = new Map();

/** A channel's catalog.json as a Map of item id -> item (year, creator,
 *  description...), with any referenced series merged in under
 *  "<seriesId>:<episodeId>" keys (see catalog-resolver.js). Resolves to an
 *  empty Map if the catalog is missing. */
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

const themes = new Map();

/** A channel's optional theme.json (see continuity-card.js), cached per
 *  channel. Resolves to `null` -- never throws -- when missing or malformed. */
export function loadTheme(channel) {
  if (!themes.has(channel.themeUrl)) {
    themes.set(channel.themeUrl, fetchJson(channel.themeUrl).catch(() => null));
  }
  return themes.get(channel.themeUrl);
}

const announcementManifests = new Map();

/** A channel's optional announcements.json (the announcer's manifest; see
 *  channels/announcer/README.md), cached per channel. Resolves to `[]` --
 *  never throws -- when missing, malformed or empty. */
export function loadAnnouncements(channel) {
  if (!announcementManifests.has(channel.announcementsUrl)) {
    announcementManifests.set(
      channel.announcementsUrl,
      fetchJson(channel.announcementsUrl)
        .then((doc) => (Array.isArray(doc?.announcements) ? doc.announcements : []))
        .catch(() => []),
    );
  }
  return announcementManifests.get(channel.announcementsUrl);
}

const bumpSchedules = new Map();

/** A channel's optional bump-schedule.json (see player-adapters.js's "bump
 *  scheduling" header), cached per channel. Resolves to
 *  `{enabled:false, rules:[]}` -- never throws -- when missing, malformed or
 *  disabled. */
export function loadBumpSchedule(channel) {
  if (!bumpSchedules.has(channel.bumpScheduleUrl)) {
    bumpSchedules.set(channel.bumpScheduleUrl, fetchJson(channel.bumpScheduleUrl)
      .then((doc) => ({
        enabled: doc?.enabled === true,
        rules: Array.isArray(doc?.rules) ? doc.rules : [],
      }))
      .catch(() => ({ enabled: false, rules: [] })));
  }
  return bumpSchedules.get(channel.bumpScheduleUrl);
}

const bumpDefinitions = new Map();

/** One bump's definition (global bumps/<id>.json, see bumps/README.md),
 *  cached by id. Resolves to `null` -- never throws -- for an unknown or
 *  malformed id; that rule's window is then skipped. */
export function loadBumpDefinition(id) {
  if (!bumpDefinitions.has(id)) {
    bumpDefinitions.set(id, fetchJson(new URL(`../bumps/${id}.json`, CHANNELS_URL)).catch(() => null));
  }
  return bumpDefinitions.get(id);
}

/** Resolves the bumpIds referenced by `rules` into `{[id]: definition}`;
 *  ids that fail to resolve are omitted. */
export async function loadBumpDefinitionsFor(rules) {
  const ids = [...new Set((rules || []).map((r) => r?.bumpId).filter(Boolean))];
  const defs = await Promise.all(ids.map((id) => loadBumpDefinition(id)));
  const out = {};
  ids.forEach((id, i) => { if (defs[i]) out[id] = defs[i]; });
  return out;
}

/**
 * Picks the "coming up next" narration URL for a continuity airing from a
 * channel's announcements array. Matches on transitionId, the continuity
 * item's own `id` (see AnnouncementContextBuilder.php).
 *
 * If both sides know the next episode and they disagree, the audio is stale
 * (the schedule changed after generation) and is discarded rather than
 * narrating the wrong program. This mirrors AnnouncerPipeline::checkStale()
 * using data already on hand. Returns null when nothing is usable (a silent
 * card).
 */
export function findAnnouncementAudio(announcements, airing) {
  if (!Array.isArray(announcements) || !airing) return null;
  const match = announcements.find(
    (a) => a && a.transitionId === airing.id && a.type === "coming_up_next" && a.status === "ready" && a.audio,
  );
  if (!match) return null;
  if (airing.nextProgramId != null && match.toEpisodeId != null && airing.nextProgramId !== match.toEpisodeId) {
    return null; // stale -- the schedule's actual upcoming episode no longer matches what this was generated for
  }
  return match.audio;
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
 * Keeps playback on the live point of a channel across providers (HTML5
 * <video> via Html5PlayerAdapter, YouTube IFrame via YouTubePlayerAdapter;
 * see player-adapters.js). Starts muted (browsers only allow muted autoplay
 * without a gesture), never stays paused, follows the wall clock from
 * program to program, and re-seeks if buffering lets it fall behind.
 *
 * `video` is the <video> element for HTML5 playback. `youtubeContainer`, if
 * given, is an empty element the YouTube iframe mounts into; without it a
 * YouTube program is treated as failed (a station break for the rest of its
 * slot). `continuityContainer` and `bumpContainer` likewise opt in to
 * continuity cards and bumps.
 *
 * onAiring(airing) fires when the program changes; onState(state, airing)
 * reports "loading" | "playing" | "buffering" | "slate" (gap, file ended
 * early, or no adapter for the provider) | "error" (retrying, up to a bound)
 * | "blocked" (autoplay refused; call resume() from a click) | "continuity"
 * | "bump".
 */
export class BroadcastPlayer {
  constructor(video, { youtubeContainer = null, continuityContainer = null, bumpContainer = null, onAiring = () => {}, onState = () => {} } = {}) {
    Object.assign(this, { video, youtubeContainer, continuityContainer, bumpContainer, onAiring, onState });
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
    this.activeBump = null; // {bumpId, startsAt, endsAt} while a bump is drawn over the program; see tick()

    const onStateChange = (state) => {
      if (state === "playing") { this.failures = 0; this.retriesExhausted = false; }
      this.setState(state === "ended" ? "slate" : state);
    };
    const onError = (err) => this.fail(err);
    this.adapters = {
      html5: new Html5PlayerAdapter(video, { onStateChange, onError }),
      youtube: youtubeContainer ? new YouTubePlayerAdapter(youtubeContainer, { onStateChange, onError }) : null,
    };
    // Continuity cards and bumps are opt-in: built only when the page passes
    // a container. Without one, a continuity airing falls back to the slate
    // and bumps never show.
    this.continuityRenderer = continuityContainer ? new ContinuityRenderer(continuityContainer) : null;
    this.bumpRenderer = bumpContainer ? new BumpRenderer(bumpContainer) : null;

    this.tick = this.tick.bind(this);
  }

  /** `channelMeta` (name, logo, theme...) is handed to the continuity card. */
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

  /** Mute/unmute, preserved across program and provider transitions where
   *  the provider permits programmatic control. */
  setMuted(muted) {
    this.muted = muted;
    this.activeAdapter?.setMuted(muted);
    // Narration and bumps are channel audio too: the viewer's choice follows them.
    this.continuityRenderer?.setMuted(muted);
    this.bumpRenderer?.setMuted(muted);
  }

  /** Patches fields onto the current channelMeta in place, for data that
   *  finished loading after setTimeline() (see player-view.js's tune()).
   *  Unlike calling setTimeline() again, this never interrupts what's
   *  playing; the next tick() or continuity card sees the new data. */
  updateChannelMeta(patch) {
    this.channelMeta = { ...(this.channelMeta || {}), ...patch };
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

    // Bumps are checked first: a bump is a clock-guaranteed interruption, so
    // it wins any overlap (including a scheduled continuity card) without a
    // tie-break. `this.airing` and the adapter position are untouched while
    // its window is open; see _enterBump()/_exitBump().
    const bumpWindow = this.bumpRenderer ? locateActiveBump(this.channelMeta?.bumpSchedule, now()) : null;
    if (bumpWindow) {
      if (!this.activeBump || this.activeBump.startsAt !== bumpWindow.startsAt || this.activeBump.bumpId !== bumpWindow.bumpId) {
        this._enterBump(bumpWindow);
      }
      return;
    }
    if (this.activeBump) this._exitBump();

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

  /** Draws a clock-anchored bump over whatever is airing without touching
   *  `this.airing`: an overlay, never a pause (see player-adapters.js's "bump
   *  scheduling" header). No-op if the bump's definition hasn't resolved yet
   *  (see loadBumpDefinitionsFor()). */
  _enterBump(window) {
    const definition = this.channelMeta?.bumpDefinitions?.[window.bumpId];
    if (!definition) return;
    this.activeBump = window;
    if (this.activeAdapter) this.activeAdapter.pause();
    this.video.hidden = true;
    if (this.youtubeContainer) this.youtubeContainer.hidden = true;
    this.continuityRenderer?.hide();
    const upcoming = airings(this.timeline, now(), now() + 12 * 3600)
      .filter((a) => a.playable)
      .slice(0, 6)
      .map((a) => ({ title: a.title, startsAt: a.startsAt }));
    // Start at the clock-derived point into the window (>0 for a viewer who tunes in mid-bump).
    this.bumpRenderer.show(definition, upcoming, this.channelMeta, now, this.muted, now() - window.startsAt);
    this.setState("bump");
  }

  /** Reverses _enterBump(). Real time kept advancing under the bump, so this
   *  is not a plain resume:
   *  - An html5/youtube program was active: resume in place with a hard
   *    reseek to the live point. A full switchTo()/load() would force an
   *    unnecessary rebuffer of a video that was only paused.
   *  - A continuity card or slate was showing (`activeAdapter` is null):
   *    clear `this.airing` so the next tick() runs switchTo() fresh. */
  _exitBump() {
    this.activeBump = null;
    this.bumpRenderer?.hide();
    if (this.activeAdapter) {
      this.video.hidden = this.activeProvider !== "html5";
      if (this.youtubeContainer) this.youtubeContainer.hidden = this.activeProvider !== "youtube";
      this.activeAdapter.play();
      this.activeAdapter.seek(Math.max(0, now() - (this.airing?.startsAt ?? now())));
      this.lastDriftCheck = 0; // re-check drift on the next tick
    } else {
      this.airing = null;
    }
  }

  switchTo(airing) {
    this.airing = airing;
    this.failures = 0;
    this.retriesExhausted = false;
    this.onAiring(airing);

    // A continuity occurrence is rendered, never played through an adapter,
    // so it's handled before the playable branching. The active adapter is
    // paused and hidden first (including the YouTube iframe, which must
    // never be drawn behind anything else).
    if (airing.type === "continuity" && this.continuityRenderer) {
      if (this.activeAdapter) this.activeAdapter.pause();
      this.activeProvider = null;
      this.activeAdapter = null;
      this.video.hidden = true;
      if (this.youtubeContainer) this.youtubeContainer.hidden = true;
      const next = nextProgram(this.timeline, airing.startsAt);
      const audioUrl = findAnnouncementAudio(this.channelMeta?.announcements, airing);
      this.continuityRenderer.show(
        this.channelMeta,
        next ? { title: next.title, description: next.description, thumbnailUrl: next.thumbnailUrl, startsAt: next.startsAt } : null,
        now,
        { startsAt: airing.startsAt, endsAt: airing.endsAt },
        airing.template,
        this.channelMeta?.bumperTheme ?? null,
        audioUrl,
      );
      this.continuityRenderer.setMuted(this.muted);
      this.setState("continuity");
      return;
    }
    this.continuityRenderer?.hide();

    const adapter = airing.playable ? (airing.provider === "youtube" ? this.adapters.youtube : this.adapters.html5) : null;
    // Pause, never destroy: the YouTube iframe is reused via loadVideoById() for the next YouTube program.
    if (this.activeAdapter && this.activeAdapter !== adapter) this.activeAdapter.pause();

    if (adapter) {
      this.activeProvider = airing.provider;
      this.activeAdapter = adapter;
      this.video.hidden = airing.provider !== "html5";
      if (this.youtubeContainer) this.youtubeContainer.hidden = airing.provider !== "youtube";
      this.activeAdapter.setMuted(this.muted);
      this.load();
    } else {
      // A station break, or a provider this page has no adapter for. Both show the slate and aren't retried.
      this.activeAdapter?.pause();
      this.activeProvider = null;
      this.activeAdapter = null;
      this.video.hidden = true;
      if (this.youtubeContainer) this.youtubeContainer.hidden = true;
      this.setState("slate");
    }
  }

  /** Fully tears down both adapters (including the YouTube iframe) and
   *  stops the polling loop. */
  destroy() {
    clearInterval(this.timer);
    this.adapters.html5.destroy();
    this.adapters.youtube?.destroy();
    this.continuityRenderer?.destroy();
    this.bumpRenderer?.destroy();
  }

  load() {
    this.setState("loading");
    this.lastDriftCheck = Date.now();
    const offset = now() - this.airing.startsAt;
    const source = this.activeProvider === "youtube" ? this.airing.videoId : this.airing.mediaUrl;
    this.activeAdapter.load(source, Math.max(0, offset));
  }

  /** A playback failure from the active adapter. Retries are bounded with
   *  exponential backoff; a `fatal` error (e.g. video removed or not
   *  embeddable) skips straight to exhausted. Once exhausted, the program
   *  sits in "error" (shown as a slate) until the schedule's clock moves on. */
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
