// explorer-store.js -- Explorer's state: the current route (semantic ids
// only), the read-only data loaded so far, browser-history sync, and the bus
// surface (docs/bus-topics.md, "Explorer"). It owns NO authoritative data:
// every cache is something an existing endpoint/file already owns, and
// everything derived (indexes, search docs, airings) is rebuilt from those.
//
// `createExplorerStore({api, win})` takes its collaborators so the store is
// unit-testable under Node with a fake API and a fake window.

import { TOPICS, publishState, publish, subscribe } from "../../../../js/bus.js";
import * as realApi from "./explorer-api.js";
import * as M from "./explorer-model.js";
import { parseRoute, serializeRoute, emptyRoute, assetRefToString } from "./explorer-route.js";
import { now as broadcastNow } from "../../../../channels/broadcast.js";

const isExplorerSearch = (search) => new URLSearchParams(String(search || "").replace(/^\?/, "")).get("view") === "explorer";

/** Drop combinations that cannot be resolved (an airing without a channel, an episode without a series). */
export function sanitizeRoute(r) {
  const out = { ...emptyRoute(), ...r, invalid: [] };
  if (out.airing !== null && !out.channel) out.airing = null;
  if (out.episode && !out.series) out.episode = null;
  if (out.mode !== "production") { out.cat = null; out.asset = null; }
  if (out.q === "") out.scope = "all";
  return out;
}

export function createExplorerStore({ api = realApi, win = typeof window !== "undefined" ? window : null, clock = broadcastNow } = {}) {
  return new ExplorerStore(api, win, clock);
}

class ExplorerStore {
  constructor(api, win, clock) {
    this.api = api;
    this.win = win;
    this.clock = clock;
    this.route = emptyRoute();
    this.invalid = []; // link parameters that were ignored when the URL was last read (shown once, never trusted)
    this.active = false; // the Explorer view is visible
    this.listeners = new Set();
    this.seq = 0;
    this.data = {
      channels: null, seriesIndex: null, carriers: null,
      seriesDetail: new Map(), schedules: new Map(), scheduleErrors: new Map(),
      announcements: new Map(), bumpSchedule: new Map(), continuity: new Map(), announcer: new Map(),
      bumps: null, bumpSchedules: null, media: null, allAnnouncements: null, episodeIndex: null,
    };
    this.errors = new Map(); // key -> message, for the sections that failed to load
    this.loading = new Set();
    this._searchCache = null;
    this._preloading = false;
  }

  // ---------- lifecycle ----------

  /** Wire history + bus. Safe to call once; returns a disposer. */
  init() {
    const ctl = new AbortController();
    const signal = ctl.signal;
    if (this.win) {
      if (isExplorerSearch(this.win.location.search)) {
        const parsed = parseRoute(this.win.location.search);
        this.invalid = parsed.invalid;
        this.route = sanitizeRoute(parsed);
      }
      this.win.addEventListener("popstate", () => {
        if (!isExplorerSearch(this.win.location.search)) return; // another view's entry -- view.js handles it
        const parsed = parseRoute(this.win.location.search);
        this.invalid = parsed.invalid;
        this.route = sanitizeRoute(parsed);
        this._afterRouteChange();
      }, { signal });
    }
    subscribe(TOPICS.APP_VIEW_STATE, ({ data }) => {
      const active = data?.view === "explorer";
      if (active === this.active) return;
      this.active = active;
      if (active) { this._afterRouteChange(); }
    }, { retained: true, signal });
    subscribe(TOPICS.EXPLORER_OPEN, ({ data }) => this.open(data || {}), { signal });
    publishState(TOPICS.EXPLORER_ROUTE_STATE, this._busRoute());
    return () => ctl.abort();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch (e) { console.error("explorer listener failed", e); }
    }
  }

  _busRoute() {
    const { mode, channel, series, episode, airing, t, cat, asset, q } = this.route;
    return { mode, channel, series, episode, airing, t, cat, asset, q };
  }

  // ---------- navigation ----------

  /** Apply a partial route. `replace` swaps the current history entry instead of adding one. */
  go(patch, { replace = false } = {}) {
    const next = sanitizeRoute({ ...this.route, ...patch });
    if (serializeRoute(next) === serializeRoute(this.route)) return false;
    this.route = next;
    if (this.win) {
      const url = `${this.win.location.pathname}?${serializeRoute(next)}${this.win.location.hash}`;
      try {
        if (this.active && !replace) this.win.history.pushState({ explorer: true }, "", url);
        else this.win.history.replaceState({ explorer: true }, "", url);
      } catch { /* history unavailable (sandbox): navigation still works, just not deep-linkable */ }
    }
    this._afterRouteChange();
    return true;
  }

  /** The EXPLORER_OPEN command / search-result navigation: switch to Explorer, then select. */
  open(raw) {
    const incoming = parseRoute(new URLSearchParams(Object.entries(raw)
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
      .map(([k, v]) => [k, String(v)])
      .concat(raw.asset && typeof raw.asset === "object" ? [["asset", assetRefToString(raw.asset) || ""]] : [])));
    const wasActive = this.active;
    if (!wasActive) publish(TOPICS.APP_VIEW_OPEN, { view: "explorer" }); // view.js pushes its own history entry
    const { invalid, ...fields } = incoming;
    void invalid;
    const reset = { mode: "programs", channel: null, series: null, episode: null, airing: null, t: this.route.t, cat: null, asset: null, q: "", scope: "all" };
    this.go({ ...reset, ...fields }, { replace: !wasActive });
  }

  selectChannel(channel) { this.go({ mode: "programs", q: "", channel, series: null, episode: null, airing: null }); }
  selectSeries(series, channel = this.route.channel) { this.go({ mode: "programs", q: "", series, channel, episode: null, airing: null }); }
  selectEpisode(episode) { this.go({ episode, airing: null }); }

  selectAiring(channel, startsAt) {
    const patch = { channel, airing: startsAt, q: "", mode: "programs" };
    // Keep an explicit time-travel instant only if it still points inside this airing.
    const sv = this.data.schedules.get(channel);
    if (this.route.t !== null && sv) {
      const found = M.findAiring(sv, startsAt);
      if (!found || this.route.t < found.entry.startsAt || this.route.t >= found.entry.endsAt) patch.t = startsAt;
    }
    this.go(patch);
  }

  /** Time travel. `t` = epoch seconds, or null to follow the live clock. */
  setTime(t) {
    const patch = { t: t === null ? null : Math.floor(t) };
    // If an airing is selected, follow the clock into whatever the schedule has at that instant.
    if (t !== null && this.route.channel && this.route.airing !== null) {
      const sv = this.data.schedules.get(this.route.channel);
      const at = sv ? M.locateAt(sv, t) : null;
      patch.airing = at?.state === "ok" && at.entry.kind === "video" ? at.entry.startsAt : null;
    }
    this.go(patch);
  }

  setMode(mode) { this.go({ mode, q: "", channel: mode === "production" ? null : this.route.channel, series: null, episode: null, airing: null, cat: null, asset: null }); }
  setCategory(cat) { this.go({ mode: "production", cat, asset: null, q: "" }); }
  selectAsset(asset) { this.go({ mode: "production", q: "", asset, cat: this.route.cat ?? defaultCategoryFor(asset) }); }

  /** Typing replaces the history entry once a query exists; the first character / clearing push. */
  setQuery(q, scope = this.route.scope) {
    const had = !!this.route.q;
    this.go({ q: q.trim(), scope }, { replace: had && !!q.trim() });
  }

  /** Where the inspected instant comes from: the live clock, a time the operator chose, or (with an airing selected and no chosen time) that airing's start. */
  timeMode() {
    return this.route.t !== null ? "travel" : this.route.airing !== null ? "airing" : "live";
  }

  effectiveT() {
    return this.route.t ?? this.route.airing ?? this.clock();
  }

  // ---------- loading ----------

  _afterRouteChange() {
    publishState(TOPICS.EXPLORER_ROUTE_STATE, this._busRoute());
    this._emit();
    if (this.active) this.ensure();
  }

  /** Starts `start()` unless `key` is already loading (so a repeated request never repeats the API call). */
  _track(key, start, apply) {
    if (this.loading.has(key)) return Promise.resolve();
    this.loading.add(key);
    this.errors.delete(key);
    const done = Promise.resolve().then(start).then((v) => { apply(v); }, (e) => { this.errors.set(key, e?.message || String(e)); })
      .finally(() => { this.loading.delete(key); this._searchCache = null; this._emit(); });
    return done;
  }

  /** Loads whatever the current route needs. Idempotent; each completion re-renders. Loading can reveal more
   *  to load (e.g. channels -> the carriers of the selected series), so it repeats until a pass starts nothing. */
  async ensure() {
    for (let pass = 0; pass < 4; pass++) {
      const started = await this._ensurePass();
      if (!started) break;
    }
    if (this.data.channels && !this._preloading) this._preloadSchedules();
  }

  async _ensurePass() {
    const r = this.route;
    const d = this.data;
    const jobs = [];

    if (!d.channels) {
      jobs.push(this._track("channels", () => this.api.getChannels(), (v) => { d.channels = v; d.carriers = M.indexSeriesCarriers(v); }));
    }
    if (!d.seriesIndex) {
      jobs.push(this._track("series-index", () => this.api.getSeriesIndex(), (v) => { d.seriesIndex = new Map(v.map((s) => [s.id, s])); }));
    }
    if (r.channel) this._loadChannel(r.channel, jobs);
    if (r.series && !d.seriesDetail.has(r.series)) {
      jobs.push(this._track(`series:${r.series}`, () => this.api.getSeriesDetail(r.series), (v) => d.seriesDetail.set(r.series, v)));
    }
    if ((r.episode || (r.series && !r.channel)) && d.carriers) {
      // Airings of a series/episode across the channels that carry it -- bounded to those carriers.
      for (const c of d.carriers.get(r.series) || []) this._loadChannel(c.channelId, jobs, { light: true });
    }
    if (r.mode === "production" || r.q || r.asset) this._loadProduction(jobs);
    if (r.q) {
      if (!d.episodeIndex) jobs.push(this._track("episode-index", () => this.api.getEpisodeIndex(), (v) => { d.episodeIndex = v; }));
    }
    await Promise.all(jobs);
    return jobs.length > 0;
  }

  _loadChannel(id, jobs, { light = false } = {}) {
    const d = this.data;
    if (!d.schedules.has(id) && !d.scheduleErrors.has(id)) {
      jobs.push(this._track(`schedule:${id}`, () => this.api.getScheduleView(id), (v) => d.schedules.set(id, v))
        .then(() => { if (this.errors.has(`schedule:${id}`)) d.scheduleErrors.set(id, this.errors.get(`schedule:${id}`)); }));
    }
    if (light) return;
    if (!d.announcements.has(id)) jobs.push(this._track(`announcements:${id}`, () => this.api.getAnnouncements(id), (v) => d.announcements.set(id, v)));
    if (!d.bumpSchedule.has(id)) jobs.push(this._track(`bump-schedule:${id}`, () => this.api.getBumpScheduleFor(id), (v) => d.bumpSchedule.set(id, v)));
    if (!d.continuity.has(id)) jobs.push(this._track(`continuity:${id}`, () => this.api.getContinuity(id), (v) => d.continuity.set(id, v)));
    if (!d.announcer.has(id)) jobs.push(this._track(`announcer:${id}`, () => this.api.getAnnouncerConfig(id), (v) => d.announcer.set(id, v)));
    if (!d.bumps) jobs.push(this._track("bumps", () => this.api.getBumps(), (v) => { d.bumps = v; }));
    if (!d.bumpSchedules) jobs.push(this._track("bump-schedules", () => this.api.getBumpSchedules(), (v) => { d.bumpSchedules = v; }));
  }

  _loadProduction(jobs) {
    const d = this.data;
    if (!d.bumps) jobs.push(this._track("bumps", () => this.api.getBumps(), (v) => { d.bumps = v; }));
    if (!d.bumpSchedules) jobs.push(this._track("bump-schedules", () => this.api.getBumpSchedules(), (v) => { d.bumpSchedules = v; }));
    if (!d.media) jobs.push(this._track("media", () => this.api.getMedia(), (v) => { d.media = v; }));
    if (!d.allAnnouncements) jobs.push(this._track("all-announcements", () => this.api.getAllAnnouncements(), (v) => { d.allAnnouncements = v; }));
  }

  /** After the first paint, quietly load the remaining channel schedules one at a time (a bounded, ~10-file
   *  set) so every channel's status and the searchable airings are available. Never blocks the UI. */
  async _preloadSchedules() {
    this._preloading = true;
    for (const c of this.data.channels) {
      if (this.data.schedules.has(c.id) || this.data.scheduleErrors.has(c.id)) continue;
      await new Promise((r) => setTimeout(r, 50));
      const jobs = [];
      this._loadChannel(c.id, jobs, { light: true });
      await Promise.all(jobs);
    }
  }

  /** Explicit request: load everything search needs (production metadata + episode index). */
  ensureSearchData() {
    const jobs = [];
    this._loadProduction(jobs);
    if (!this.data.episodeIndex) jobs.push(this._track("episode-index", () => this.api.getEpisodeIndex(), (v) => { this.data.episodeIndex = v; }));
    return Promise.all(jobs);
  }

  // ---------- derived views (all synchronous, from what is loaded) ----------

  channel(id = this.route.channel) { return this.data.channels?.find((c) => c.id === id) ?? null; }
  scheduleView(id = this.route.channel) { return id ? this.data.schedules.get(id) ?? null : null; }
  seriesRow(id) { return this.data.seriesIndex?.get(id) ?? null; }
  seriesDetail(id = this.route.series) { return id ? this.data.seriesDetail.get(id) ?? null : null; }
  carriersOf(seriesId) { return this.data.carriers?.get(seriesId) ?? []; }

  /** Series carried by a channel, via its catalog refs and programming blocks (the actual references). */
  seriesOfChannel(channelId) {
    const ch = this.channel(channelId);
    if (!ch || !this.data.seriesIndex) return [];
    const ids = new Set();
    for (const ref of ch.series_refs || []) if (ref.series_id) ids.add(ref.series_id);
    for (const b of ch.programming_blocks || []) if (b?.series_id) ids.add(b.series_id);
    return [...ids].map((id) => ({ id, row: this.seriesRow(id), blocks: (ch.programming_blocks || []).filter((b) => b.series_id === id) }));
  }

  /** Published airings of an episode across every channel that carries its series (only loaded schedules). */
  airingsOfEpisode(seriesId, episodeId) {
    const out = [];
    for (const c of this.carriersOf(seriesId)) {
      out.push(...M.episodeAirings(this.scheduleView(c.channelId), episodeId, seriesId));
    }
    return out.sort((a, b) => a.startsAt - b.startsAt);
  }

  allProductionBumps() { return this.data.bumps || []; }

  indexes() {
    const d = this.data;
    return {
      bumpUsage: M.indexBumpUsage(d.bumpSchedules || []),
      mediaUsage: M.indexMediaUsage(d.bumps || []),
      announcements: M.indexAnnouncements(d.allAnnouncements || Object.fromEntries(d.announcements)),
    };
  }

  /** Search documents from loaded metadata only (never media bytes), memoised until something loads. */
  searchDocs() {
    if (this._searchCache) return this._searchCache;
    const d = this.data;
    const docs = [];
    for (const c of d.channels || []) docs.push({ type: "channel", id: c.id, title: c.name, sub: c.number != null ? `Channel ${c.number}` : "Channel", extra: c.description, thumb: c.logoUrl, ref: { channel: c.id } });
    const carrierNames = (sid) => this.carriersOf(sid).map((c) => c.channelName).join(" ");
    for (const s of d.seriesIndex?.values() || []) docs.push({ type: "series", id: s.id, title: s.title, sub: `${s.episode_count} episodes`, extra: `${s.creator || ""} ${carrierNames(s.id)}`, thumb: s.thumbnail_url, ref: { series: s.id } });
    for (const e of d.episodeIndex || []) {
      const s = d.seriesIndex?.get(e.s);
      docs.push({ type: "episode", id: `${e.s}/${e.id}`, title: e.t, sub: s?.title || e.s, extra: e.st || "", duration: e.d, ref: { series: e.s, episode: e.id } });
    }
    for (const sv of d.schedules.values()) {
      const ch = this.channel(sv.channelId);
      for (const e of sv.tl.entries) {
        if (e.type === "continuity" || e.type === "gap" || !e.title) continue;
        docs.push({ type: "airing", id: `${sv.channelId}@${sv.anchor + e.start}`, title: e.title, sub: ch?.name || sv.channelId, startsAt: sv.anchor + e.start, ref: { channel: sv.channelId, airing: sv.anchor + e.start } });
      }
    }
    const bumpUse = M.indexBumpUsage(d.bumpSchedules || []);
    for (const b of d.bumps || []) docs.push({ type: "bump", id: b.id, title: b.name || b.id, sub: b.description || "Bump", extra: (bumpUse.get(b.id) || []).map((u) => u.channelName).join(" "), ref: { asset: { kind: "bump", id: b.id } } });
    for (const [channelId, list] of Object.entries(d.allAnnouncements || {})) {
      const ch = this.channel(channelId);
      for (const a of list) docs.push({ type: "announcement", id: `${channelId}:${a.id}`, title: a.text || a.id, sub: `${ch?.name || channelId} · ${(a.type || "").replace(/_/g, " ")}`, ref: { asset: { kind: "announcement", channelId, id: a.id } } });
    }
    for (const cat of ["video", "music", "ambience", "image"]) {
      for (const m of d.media?.[cat] || []) docs.push({ type: "media", id: m.url, title: m.name, sub: cat, ref: { asset: { kind: "media", path: m.url } } });
    }
    this._searchCache = M.buildSearchIndex(docs);
    return this._searchCache;
  }

  search() {
    return M.searchIndex(this.searchDocs(), this.route.q, { scope: this.route.scope });
  }

  /** How many of the visible channels' schedules are loaded (so the UI can say what "airings" covers). */
  scheduleCoverage() {
    return { loaded: this.data.schedules.size, total: this.data.channels?.length ?? 0, failed: this.data.scheduleErrors.size };
  }
}

export function defaultCategoryFor(asset) {
  if (!asset) return null;
  if (asset.kind === "bump") return "bumps";
  if (asset.kind === "announcement") return "announcements";
  const m = /^media\/(video|music|ambience|image)\//.exec(asset.path || "");
  return m ? m[1] : "video";
}

// The page-wide instance (the web components share it).
export const explorerStore = createExplorerStore();
