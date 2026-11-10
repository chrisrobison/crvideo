// bump-studio-store.js -- the single in-memory state for the Bump Studio.
//
// Four deliberately separate kinds of state (see the redesign brief's
// "State management"):
//
//   1. SAVED   state.bumps / state.saved      what's on disk (server/bump-admin.php)
//   2. DRAFT   state.draft                    the one editable copy of the selected bump
//   3. PREVIEW state.preview / state.playback preview-only data, NEVER saved
//   4. SCHEDULE state.schedules               channels/<id>/bump-schedule.json
//
// Nothing here writes to disk except save()/rename()/duplicate()/remove()/
// saveSchedule() -- all explicit user actions. Editing a draft therefore
// never changes what any channel airs until Save.
//
// Components subscribe to one "change" event; `detail.keys` names which
// slices changed ("bumps", "selection", "draft", "layer", "workspace",
// "preview", "playback", "schedules", "media", "status", "saving") and
// `detail.source` names who caused it, so a component can skip re-rendering
// in response to its own edit (keeping focus/caret/drag state intact).

import { bumpAdminApi } from "../../admin-api.js";
import {
  emptyDraft, draftFromBump, toPayload, draftsEqual, validateDraft, clampTiming,
  referencesTo, uniqueName,
} from "./bump-model.js";

export const LAYERS = ["bump", "background", "music", "announcer", "text"];
export const WORKSPACES = ["compose", "schedule", "library"];

const DEFAULT_SAMPLE = [
  { title: "Sample Show One", inMinutes: 2 },
  { title: "Sample Show Two", inMinutes: 32 },
  { title: "Sample Show Three", inMinutes: 62 },
  { title: "Sample Show Four", inMinutes: 92 },
  { title: "Sample Show Five", inMinutes: 122 },
  { title: "Sample Show Six", inMinutes: 152 },
];

const clone = (v) => JSON.parse(JSON.stringify(v));

class BumpStudioStore extends EventTarget {
  constructor() {
    super();
    this.state = {
      status: "idle", // "idle" | "loading" | "ready" | "error"
      error: null,
      saving: false,
      bumps: [],
      media: { video: [], image: [], music: [], ambience: [], channels: [] },
      schedules: [],
      selectedId: null, // id of the saved bump being edited; null with a draft => a new, never-saved bump
      saved: null, // draft-shaped snapshot of the selected bump as saved (null for a new bump)
      draft: null,
      layer: "background",
      workspace: "compose",
      preview: {
        source: "sample", // "sample" | a channel id
        sample: clone(DEFAULT_SAMPLE),
        upcoming: [],
        channel: null, // {name, logo} branding when previewing a real channel
        loading: false,
        error: null,
        hiddenLayers: [], // timeline eye toggles: "text" | "voice" | "music" | "background"
      },
      playback: { time: 0, duration: 0, playing: false, muted: false, loop: false, volume: 1, durations: { video: null, audio: [null, null], announcement: null } },
    };
    this.player = null; // the preview's <cr-bump>, registered by bump-preview.js
    this._broadcast = null;
    this._channelCache = new Map();
    this._refreshSampleUpcoming();
  }

  // ---------- events ----------

  emit(keys, source = null) {
    this.dispatchEvent(new CustomEvent("change", { detail: { keys: new Set([].concat(keys)), source } }));
  }

  // ---------- derived ----------

  get isNew() { return this.state.draft !== null && this.state.selectedId === null; }

  get isDirty() {
    const { draft, saved } = this.state;
    if (!draft) return false;
    return !draftsEqual(draft, saved || emptyDraft()); // a new bump counts as dirty once it differs from the blank template
  }

  /** Save is meaningful for any edit, and for a brand-new bump at all. */
  get canSave() { return !!this.state.draft && (this.isNew || this.isDirty); }

  get selectedBump() {
    return this.state.bumps.find((b) => b.id === this.state.selectedId) || null;
  }

  referencesTo(bumpId) { return referencesTo(this.state.schedules, bumpId); }

  // ---------- loading ----------

  async load() {
    this.state.status = "loading";
    this.state.error = null;
    this.emit("status");
    try {
      const [bumps, media, schedules] = await Promise.all([bumpAdminApi.list(), bumpAdminApi.media(), bumpAdminApi.schedules()]);
      this.state.bumps = bumps;
      this.state.media = { video: [], image: [], music: [], ambience: [], channels: [], ...media };
      this.state.schedules = schedules;
      this.state.status = "ready";
      if (this.state.selectedId && !this.selectedBump) this.state.selectedId = null;
      if (!this.state.draft) {
        const first = bumps[0];
        if (first) this._loadSelection(first.id);
        else this._loadNew();
      }
      this.emit(["status", "bumps", "media", "schedules", "selection", "draft"]);
    } catch (e) {
      this.state.status = "error";
      this.state.error = e.message;
      this.emit("status");
    }
  }

  // ---------- selection / unsaved-changes guard ----------

  /** Asks before discarding unsaved edits. Returns true when it's OK to proceed. */
  confirmDiscard(action = "continue") {
    if (!this.isDirty) return true;
    const name = this.state.draft?.name || "this bump";
    return window.confirm(`"${name}" has unsaved changes. Discard them and ${action}?`);
  }

  select(id, { force = false } = {}) {
    if (id === this.state.selectedId && this.state.draft) return true;
    if (!force && !this.confirmDiscard("switch bumps")) return false;
    this._loadSelection(id);
    this.emit(["selection", "draft"]);
    return true;
  }

  newBump() {
    if (!this.confirmDiscard("start a new bump")) return false;
    this._loadNew();
    this.emit(["selection", "draft"]);
    return true;
  }

  revert() {
    if (!this.state.draft) return;
    if (this.state.saved) this.state.draft = clone(this.state.saved);
    else this.state.draft = emptyDraft();
    this.emit("draft", "revert");
  }

  _loadSelection(id) {
    const bump = this.state.bumps.find((b) => b.id === id);
    if (!bump) return;
    this.state.selectedId = id;
    this.state.saved = draftFromBump(bump);
    this.state.draft = clone(this.state.saved);
  }

  _loadNew() {
    this.state.selectedId = null;
    this.state.saved = null;
    this.state.draft = emptyDraft();
    this.state.layer = "background";
  }

  // ---------- draft editing (never touches disk) ----------

  /** Applies `mutate(draftCopy)` and publishes the result. `source` lets
   *  the editing component ignore its own echo. */
  updateDraft(mutate, source = null) {
    if (!this.state.draft) return;
    const next = clone(this.state.draft);
    mutate(next);
    clampTiming(next);
    this.state.draft = next;
    this.emit("draft", source);
  }

  setLayer(layer) {
    if (!LAYERS.includes(layer) || layer === this.state.layer) return;
    this.state.layer = layer;
    this.emit("layer");
  }

  setWorkspace(ws) {
    if (!WORKSPACES.includes(ws) || ws === this.state.workspace) return;
    this.state.workspace = ws;
    this.emit("workspace");
  }

  /** Library -> Compose with a bump loaded (guards unsaved edits). */
  openInCompose(id) {
    if (!this.select(id)) return false;
    this.setWorkspace("compose");
    return true;
  }

  // ---------- persistence (explicit actions only) ----------

  async save() {
    const { draft } = this.state;
    if (!draft || this.state.saving) return null;
    const problem = validateDraft(draft);
    if (problem) throw new Error(problem);
    this.state.saving = true;
    this.emit("saving");
    try {
      const payload = toPayload(draft);
      const saved = this.state.selectedId
        ? await bumpAdminApi.update(this.state.selectedId, payload)
        : await bumpAdminApi.create(payload);
      this._upsertBump(saved);
      this.state.selectedId = saved.id;
      this.state.saved = draftFromBump(saved);
      this.state.draft = clone(this.state.saved);
      this.emit(["bumps", "selection", "draft"], "save");
      return saved;
    } finally {
      this.state.saving = false;
      this.emit("saving");
    }
  }

  /** Renames a saved bump immediately (id stays stable). Only the name of
   *  the SAVED definition changes -- any other unsaved draft edits stay
   *  unsaved, so a rename never publishes half-finished work. */
  async rename(id, name) {
    const bump = this.state.bumps.find((b) => b.id === id);
    const clean = String(name || "").trim();
    if (!bump || !clean || clean === bump.name) return null;
    const payload = toPayload({ ...draftFromBump(bump), name: clean });
    const saved = await bumpAdminApi.update(id, payload);
    this._upsertBump(saved);
    const keys = ["bumps"];
    if (id === this.state.selectedId) {
      this.state.saved = draftFromBump(saved);
      this.state.draft = { ...this.state.draft, name: clean };
      keys.push("draft");
    }
    this.emit(keys, "rename");
    return saved;
  }

  /** Copies a SAVED bump through the existing create action (new id and
   *  timestamps come from the server) and opens the copy. */
  async duplicate(id) {
    const bump = this.state.bumps.find((b) => b.id === id);
    if (!bump) return null;
    if (!this.confirmDiscard("open the copy")) return null;
    const payload = toPayload({ ...draftFromBump(bump), name: uniqueName(bump.name || bump.id, this.state.bumps) });
    const saved = await bumpAdminApi.create(payload);
    this._upsertBump(saved);
    this._loadSelection(saved.id);
    this.emit(["bumps", "selection", "draft"], "duplicate");
    return saved;
  }

  /** Deletes a bump after the caller has confirmed (see bump-list.js, which
   *  shows the channels referencing it). Schedule rules are never edited
   *  here -- removing a referenced bump is the caller's explicit choice. */
  async remove(id) {
    await bumpAdminApi.delete(id);
    this.state.bumps = this.state.bumps.filter((b) => b.id !== id);
    const keys = ["bumps"];
    if (id === this.state.selectedId) {
      const next = this.state.bumps[0];
      if (next) this._loadSelection(next.id);
      else this._loadNew();
      keys.push("selection", "draft");
    }
    this.emit(keys, "remove");
  }

  _upsertBump(saved) {
    const list = this.state.bumps.filter((b) => b.id !== saved.id);
    list.push(saved);
    list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
    this.state.bumps = list;
  }

  // ---------- channel schedules ----------

  async saveSchedule(channelId, enabled, rules) {
    const schedule = await bumpAdminApi.saveSchedule(channelId, enabled, rules);
    this.state.schedules = this.state.schedules.map((c) => (c.id === channelId ? { ...c, enabled: schedule.enabled, rules: schedule.rules } : c));
    this.emit("schedules");
    return schedule;
  }

  async reloadSchedules() {
    this.state.schedules = await bumpAdminApi.schedules();
    this.emit("schedules");
  }

  // ---------- preview-only data (never saved) ----------

  setSample(rows) {
    this.state.preview.sample = rows.map((r) => ({ title: String(r.title || ""), inMinutes: Math.max(0, Number(r.inMinutes) || 0) }));
    if (this.state.preview.source === "sample") this._refreshSampleUpcoming();
    this.emit("preview");
  }

  async setPreviewSource(source) {
    const p = this.state.preview;
    p.source = source || "sample";
    p.error = null;
    if (p.source === "sample") {
      this._refreshSampleUpcoming();
      this.emit("preview");
      return;
    }
    p.loading = true;
    this.emit("preview");
    try {
      const { upcoming, channel } = await this._loadRealChannelUpcoming(p.source);
      if (p.source !== source) return; // switched again while loading
      p.upcoming = upcoming;
      p.channel = channel;
    } catch (e) {
      p.error = e.message;
      p.upcoming = [];
      p.channel = null;
    }
    p.loading = false;
    this.emit("preview");
  }

  _refreshSampleUpcoming() {
    const now = Math.floor(Date.now() / 1000);
    const p = this.state.preview;
    p.upcoming = p.sample.filter((r) => r.title.trim()).map((r) => ({ title: r.title, startsAt: now + Math.round(r.inMinutes * 60) }));
    p.channel = null;
  }

  /** A real channel's real upcoming lineup, read-only, through the same
   *  channels/broadcast.js functions the live guide uses -- never
   *  reimplementing any scheduling math here. Cached for a minute. */
  async _loadRealChannelUpcoming(channelId) {
    const hit = this._channelCache.get(channelId);
    if (hit && Date.now() - hit.at < 60000) return hit.value;
    this._broadcast ??= await import("../../../../channels/broadcast.js");
    const { loadChannel, airings, now } = this._broadcast;
    const channel = await loadChannel(channelId);
    const t = now();
    const upcoming = airings(channel.timeline, t, t + 12 * 3600)
      .filter((a) => a.playable && a.startsAt > t)
      .slice(0, 6)
      .map((a) => ({ title: a.title, startsAt: a.startsAt }));
    const value = { upcoming, channel: { name: channel.name, logo: channel.logo } };
    this._channelCache.set(channelId, { at: Date.now(), value });
    return value;
  }

  // ---------- transport (shared by preview + timeline) ----------

  setPlayback(patch) {
    Object.assign(this.state.playback, patch);
    this.emit("playback");
  }

  /** Play from the playhead (or from 0 when parked at the end). Must be
   *  called from a user gesture -- audio autoplay policy. */
  play() {
    const p = this.player;
    if (!p) return;
    const t = p.currentTime;
    p.play({ muted: this.state.playback.muted, offset: t >= p.duration - 0.05 ? 0 : t });
  }

  pause() { this.player?.pause(); }

  togglePlay() { if (this.player?.playing) this.pause(); else this.play(); }

  stop() { this.player?.stop(); }

  seek(t) { this.player?.seek(t); }

  setMuted(muted) {
    this.state.playback.muted = !!muted;
    this.player?.setMuted(!!muted);
    this.emit("playback");
  }

  /** Preview monitor level (0-1); never saved. */
  setVolume(v) {
    this.state.playback.volume = Math.min(1, Math.max(0, Number(v) || 0));
    if (this.player) this.player.masterVolume = this.state.playback.volume;
    if (this.state.playback.volume > 0 && this.state.playback.muted) this.setMuted(false);
    this.emit("playback");
  }

  /** Timeline eye toggle -- hides/silences a layer in the PREVIEW only. */
  toggleHidden(layer) {
    const set = new Set(this.state.preview.hiddenLayers);
    if (set.has(layer)) set.delete(layer); else set.add(layer);
    this.state.preview.hiddenLayers = [...set];
    if (this.player) this.player.hiddenLayers = this.state.preview.hiddenLayers;
    this.emit("preview");
  }

  setLoop(loop) {
    this.state.playback.loop = !!loop;
    if (this.player) this.player.endBehavior = loop ? "loop" : "stop";
    this.emit("playback");
  }
}

export const studioStore = new BumpStudioStore();

// Reloading/closing the tab must not silently discard unsaved work.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (studioStore.isDirty) { e.preventDefault(); e.returnValue = ""; }
  });
}
