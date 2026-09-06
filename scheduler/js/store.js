// ChannelFlow application state — a plain EventTarget-based store.
// Components subscribe with store.addEventListener('change', handler)
// and re-render. No framework, no virtual DOM: just events + DOM writes.

import {
  uid, DAY_SECONDS, todayKey, dateKey, nowUTCSeconds,
  unionCoverage, countOverlaps, toast, fmtHMS, secToClock,
} from "./utils.js";

const STORAGE_KEY = "channelflow:v1";
const ASSET_BASE = "../"; // sample mp4s live one directory up from /scheduler/

function sampleMedia() {
  return [
    { id: "media-live-mab", title: "Live at The Mab", type: "live", duration: null,
      sizeBytes: null, url: null, thumbTone: "live", thumbText: "MAB" },
    { id: "media-punk", title: "Punk Rock Archives", type: "video", duration: null,
      sizeBytes: 6524725, url: `${ASSET_BASE}video-003.mp4`, thumbTone: "video", thumbText: "PUNK" },
    { id: "media-venue", title: "Venue Spotlight", type: "video", duration: null,
      sizeBytes: 9749933, url: `${ASSET_BASE}video-002.mp4`, thumbTone: "video", thumbText: "VENUE" },
    { id: "media-ident", title: "Station Ident", type: "graphic", duration: 30,
      sizeBytes: 662383, url: `${ASSET_BASE}video-004.mp4`, thumbTone: "graphic", thumbText: "MABUHAY TV" },
    { id: "media-comingup", title: "Coming Up Next", type: "graphic", duration: 15,
      sizeBytes: 0, url: null, thumbTone: "graphic", thumbText: "COMING UP NEXT" },
    { id: "media-morning", title: "Morning Replay", type: "video", duration: null,
      sizeBytes: 38902529, url: `${ASSET_BASE}video-001.mp4`, thumbTone: "video", thumbText: "REPLAY" },
  ];
}

function block(partial) {
  return {
    id: uid("block"),
    title: "Untitled segment",
    type: "video",       // video | live | graphic | audio
    start: 0,
    end: 3600,
    source: "Video File",
    fallback: "",
    url: null,
    autoStart: true,
    recordStream: false,
    allowOverrun: false,
    usesFallback: false,
    transitionIn: { type: "cut", duration: 0 },
    transitionOut: { type: "cut", duration: 0 },
    notes: "",
    ...partial,
  };
}

function sampleSchedule() {
  return {
    tracks: [
      {
        id: "program", kind: "program", label: "PROGRAM", sublabel: "(main output)",
        blocks: [
          block({ id: "p-morning1", title: "Morning Replay", type: "video", start: 0, end: 28800,
            source: "Video File", url: `${ASSET_BASE}video-001.mp4` }),
          block({ id: "p-venue1", title: "Venue Spotlight", type: "video", start: 28800, end: 50400,
            source: "Video File", url: `${ASSET_BASE}video-002.mp4` }),
          block({ id: "p-live", title: "Live at The Mab", type: "live", start: 50400, end: 59400,
            source: "RTMP Live Input 1", fallback: "Punk Rock Archives", recordStream: true }),
          block({ id: "p-punk1", title: "Punk Rock Archives", type: "video", start: 59400, end: 63000,
            source: "Video File", url: `${ASSET_BASE}video-003.mp4` }),
          block({ id: "p-ident1", title: "Station Ident", type: "graphic", start: 63000, end: 63030,
            source: "Graphic", url: `${ASSET_BASE}video-004.mp4` }),
          block({ id: "p-comingup1", title: "Coming Up Next", type: "graphic", start: 63030, end: 63045,
            source: "Graphic" }),
          block({ id: "p-venue2", title: "Venue Spotlight", type: "video", start: 63045, end: 67680,
            source: "Video File", url: `${ASSET_BASE}video-002.mp4` }),
          // intentional 12-minute gap: 18:48:00 -> 19:00:00
          block({ id: "p-venue3", title: "Venue Spotlight", type: "video", start: 68400, end: 70200,
            source: "Video File", url: `${ASSET_BASE}video-002.mp4`, usesFallback: true }),
          block({ id: "p-ident2", title: "Station Ident", type: "graphic", start: 70200, end: 70230,
            source: "Graphic", url: `${ASSET_BASE}video-004.mp4` }),
          block({ id: "p-comingup2", title: "Coming Up Next", type: "graphic", start: 70230, end: 70245,
            source: "Graphic" }),
          block({ id: "p-morning2", title: "Morning Replay", type: "video", start: 70245, end: 86400,
            source: "Video File", url: `${ASSET_BASE}video-001.mp4` }),
        ],
      },
      {
        id: "graphics", kind: "graphics", label: "GRAPHICS", sublabel: "(overlays)",
        blocks: [
          block({ id: "g-lowerthirds", title: "Lower Thirds", type: "graphic", start: 28800, end: 50400,
            source: "Graphic" }),
          block({ id: "g-livebug", title: "Live Bug", type: "graphic", start: 50400, end: 59400,
            source: "Graphic" }),
          block({ id: "g-nextup", title: "Next Up", type: "graphic", start: 70245, end: 86400,
            source: "Graphic" }),
        ],
      },
      {
        id: "live", kind: "live", label: "LIVE INPUT", sublabel: "(sources)",
        blocks: [
          block({ id: "l-rtmp1", title: "RTMP Live Input 1", type: "live", start: 50400, end: 59400,
            source: "RTMP Live Input 1" }),
        ],
      },
    ],
  };
}

/** A single full-day filler block so a brand new channel/date is never dead air. */
function defaultSchedule(fillerTitle = "Morning Replay") {
  return {
    tracks: [
      { id: "program", kind: "program", label: "PROGRAM", sublabel: "(main output)",
        blocks: [block({ id: uid("p"), title: fillerTitle, type: "video", start: 0, end: 86400,
          source: "Video File", url: `${ASSET_BASE}video-001.mp4` })] },
      { id: "graphics", kind: "graphics", label: "GRAPHICS", sublabel: "(overlays)", blocks: [] },
      { id: "live", kind: "live", label: "LIVE INPUT", sublabel: "(sources)", blocks: [] },
    ],
  };
}

class Store extends EventTarget {
  constructor() {
    super();
    this.channels = [
      { id: "mabuhay", name: "Mabuhay TV" },
      { id: "cinema", name: "Classic Cinema" },
      { id: "music", name: "Music Rotation" },
    ];
    this.activeChannelId = "mabuhay";
    this.activeDate = todayKey();
    this.schedules = {}; // key: `${channelId}:${date}` -> schedule
    this.media = sampleMedia();
    this.selectedBlockId = null;
    this.rundownShowAll = false;
    this.publishedAt = null;

    this._load();
    this._probeDurations();
    this._tick = this._tick.bind(this);
    setInterval(this._tick, 1000);
  }

  // ---------- persistence ----------
  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        this.schedules = saved.schedules || {};
        this.publishedAt = saved.publishedAt || null;
        if (saved.channels?.length) this.channels = saved.channels;
      }
    } catch (_) { /* ignore corrupt storage */ }
    const key = this._scheduleKey();
    if (!this.schedules[key]) this.schedules[key] = sampleSchedule();
  }

  persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schedules: this.schedules, publishedAt: this.publishedAt, channels: this.channels,
      }));
    } catch (_) { /* storage full/unavailable — keep working in memory */ }
  }

  _emit(reason) {
    this.dispatchEvent(new CustomEvent("change", { detail: { reason } }));
  }

  // ---------- probing real media durations ----------
  _probeDurations() {
    for (const item of this.media) {
      if (item.type !== "video" && item.type !== "audio") continue;
      if (!item.url) continue;
      const probe = document.createElement(item.type === "audio" ? "audio" : "video");
      probe.preload = "metadata";
      probe.src = item.url;
      probe.addEventListener("loadedmetadata", () => {
        item.duration = probe.duration;
        this._emit("media-duration");
      }, { once: true });
      probe.addEventListener("error", () => { /* keep duration unknown */ }, { once: true });
    }
  }

  // ---------- channel / date ----------
  _scheduleKey(channelId = this.activeChannelId, date = this.activeDate) {
    return `${channelId}:${date}`;
  }

  getActiveSchedule() {
    const key = this._scheduleKey();
    if (!this.schedules[key]) this.schedules[key] = defaultSchedule();
    return this.schedules[key];
  }

  setChannel(channelId) {
    if (channelId === this.activeChannelId) return;
    this.activeChannelId = channelId;
    this.getActiveSchedule();
    this.selectedBlockId = null;
    this.persist();
    this._emit("channel");
  }

  shiftDate(deltaDays) {
    const d = new Date(`${this.activeDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    this.activeDate = dateKey(d);
    this.getActiveSchedule();
    this.selectedBlockId = null;
    this.persist();
    this._emit("date");
  }

  isToday() { return this.activeDate === todayKey(); }
  nowSeconds() { return nowUTCSeconds(); }

  _tick() { this._emit("tick"); }

  // ---------- block CRUD ----------
  findBlock(blockId) {
    const schedule = this.getActiveSchedule();
    for (const track of schedule.tracks) {
      const block = track.blocks.find((b) => b.id === blockId);
      if (block) return { track, block };
    }
    return null;
  }

  getSelected() {
    return this.selectedBlockId ? this.findBlock(this.selectedBlockId) : null;
  }

  selectBlock(blockId) {
    this.selectedBlockId = blockId;
    this._emit("select");
  }

  addBlock(trackId, partial) {
    const schedule = this.getActiveSchedule();
    const track = schedule.tracks.find((t) => t.id === trackId);
    if (!track) return null;
    const newBlock = block(partial);
    track.blocks.push(newBlock);
    this.persist();
    this._emit("blocks");
    return newBlock;
  }

  updateBlock(blockId, patch) {
    const found = this.findBlock(blockId);
    if (!found) return;
    Object.assign(found.block, patch);
    if (found.block.end <= found.block.start) {
      found.block.end = found.block.start + 60; // never let a block collapse to zero/negative
    }
    this.persist();
    this._emit("blocks");
  }

  moveBlock(blockId, newStart) {
    const found = this.findBlock(blockId);
    if (!found) return;
    const duration = found.block.end - found.block.start;
    const start = Math.max(0, Math.min(DAY_SECONDS - duration, Math.round(newStart)));
    found.block.start = start;
    found.block.end = start + duration;
    this.persist();
    this._emit("blocks");
  }

  resizeBlock(blockId, edge, value) {
    const found = this.findBlock(blockId);
    if (!found) return;
    const b = found.block;
    if (edge === "start") b.start = Math.max(0, Math.min(b.end - 30, Math.round(value)));
    else b.end = Math.min(DAY_SECONDS, Math.max(b.start + 30, Math.round(value)));
    this.persist();
    this._emit("blocks");
  }

  duplicateBlock(blockId) {
    const found = this.findBlock(blockId);
    if (!found) return null;
    const duration = found.block.end - found.block.start;
    const start = Math.min(DAY_SECONDS - duration, found.block.end);
    const copy = block({ ...found.block, id: uid("block"), start, end: start + duration,
      title: `${found.block.title} copy` });
    found.track.blocks.push(copy);
    this.persist();
    this._emit("blocks");
    return copy;
  }

  removeBlock(blockId) {
    const schedule = this.getActiveSchedule();
    for (const track of schedule.tracks) {
      const idx = track.blocks.findIndex((b) => b.id === blockId);
      if (idx >= 0) {
        track.blocks.splice(idx, 1);
        if (this.selectedBlockId === blockId) this.selectedBlockId = null;
        this.persist();
        this._emit("blocks");
        return true;
      }
    }
    return false;
  }

  // ---------- media library ----------
  addMediaFile(file) {
    const url = URL.createObjectURL(file);
    const type = file.type.startsWith("audio/") ? "audio"
      : file.type.startsWith("image/") ? "graphic" : "video";
    const item = {
      id: uid("media"), title: file.name.replace(/\.[^.]+$/, ""), type,
      duration: type === "graphic" ? 15 : null,
      sizeBytes: file.size, url, thumbTone: type, thumbText: file.name.slice(0, 3).toUpperCase(),
    };
    this.media.push(item);
    this._emit("media");
    if (type === "video" || type === "audio") {
      const probe = document.createElement(type);
      probe.preload = "metadata";
      probe.src = url;
      probe.addEventListener("loadedmetadata", () => {
        item.duration = probe.duration;
        this._emit("media-duration");
      }, { once: true });
    }
    toast(`Added "${item.title}" to media library`, "good");
    return item;
  }

  // ---------- derived data: stats / gaps / conflicts / rundown ----------
  computeStats() {
    const schedule = this.getActiveSchedule();
    const program = schedule.tracks.find((t) => t.kind === "program");
    const programIntervals = program.blocks.map((b) => [b.start, b.end]);
    const { covered, gaps } = unionCoverage(programIntervals);

    let conflictCount = 0;
    for (const track of schedule.tracks) {
      conflictCount += countOverlaps(track.blocks).conflicts;
    }

    const liveIntervals = program.blocks.filter((b) => b.type === "live").map((b) => [b.start, b.end]);
    const liveSec = unionCoverage(liveIntervals).covered;

    return {
      scheduledSec: covered,
      gapSec: DAY_SECONDS - covered,
      gaps,
      gapCount: gaps.length,
      conflictCount,
      liveSec,
    };
  }

  computeRundown() {
    const schedule = this.getActiveSchedule();
    const program = schedule.tracks.find((t) => t.kind === "program");
    const blocks = [...program.blocks].sort((a, b) => a.start - b.start);
    const { gaps } = unionCoverage(blocks.map((b) => [b.start, b.end]));
    const now = this.nowSeconds();
    const isToday = this.isToday();

    const rows = [];
    for (const b of blocks) {
      const onAir = isToday && now >= b.start && now < b.end;
      rows.push({
        kind: "block", id: b.id, start: b.start, end: b.end,
        title: b.title, source: b.source, type: b.type,
        duration: b.end - b.start,
        status: onAir ? "ON_AIR" : b.usesFallback ? "FALLBACK" : "READY",
      });
    }
    for (const [s, e] of gaps) {
      if (e - s <= 0) continue;
      rows.push({
        kind: "gap", id: `gap-${s}-${e}`, start: s, end: e,
        title: `${Math.round((e - s) / 60)}-minute schedule gap at ${secToClock(s)}`,
        duration: e - s, status: "ATTENTION",
      });
    }
    rows.sort((a, b) => a.start - b.start);
    return rows;
  }

  // ---------- validation / publishing ----------
  validate() {
    const stats = this.computeStats();
    if (stats.conflictCount === 0 && stats.gapCount === 0) {
      toast("Schedule validated — no gaps or conflicts.", "good");
      return true;
    }
    const parts = [];
    if (stats.conflictCount) parts.push(`${stats.conflictCount} conflict${stats.conflictCount === 1 ? "" : "s"}`);
    if (stats.gapCount) parts.push(`${stats.gapCount} dead-air gap${stats.gapCount === 1 ? "" : "s"}`);
    toast(`Validation found ${parts.join(" and ")}.`, stats.conflictCount ? "danger" : "warn");
    return false;
  }

  /** Build a playlist.json-compatible payload (as consumed by sync-player.html)
   *  from the program track's file-backed blocks, anchored to the active date. */
  buildPlaylistExport() {
    const schedule = this.getActiveSchedule();
    const program = schedule.tracks.find((t) => t.kind === "program");
    const dayStart = new Date(`${this.activeDate}T00:00:00Z`).getTime();
    const entries = [];
    let skipped = 0;
    // Sample media is referenced as "../video-x.mp4" so it resolves correctly from
    // /scheduler/ during live preview; playlist.json ships one directory up
    // (alongside sync-player.html), so re-root that one hop for the export.
    const exportUrl = (url) => (url.startsWith(`${ASSET_BASE}`) ? url.slice(ASSET_BASE.length) : url);
    for (const b of [...program.blocks].sort((a, b) => a.start - b.start)) {
      if (!b.url) { skipped += 1; continue; }
      entries.push({
        id: b.id,
        title: b.title,
        start: new Date(dayStart + b.start * 1000).toISOString(),
        end: new Date(dayStart + b.end * 1000).toISOString(),
        url: exportUrl(b.url),
      });
    }
    return { version: 1, entries, skipped };
  }

  publish() {
    const stats = this.computeStats();
    this.publishedAt = new Date().toISOString();
    this.persist();
    const { entries, skipped } = this.buildPlaylistExport();
    const blob = new Blob([JSON.stringify({ version: 1, entries }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "playlist.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);

    let msg = `Published — playlist.json downloaded (${entries.length} segment${entries.length === 1 ? "" : "s"}).`;
    if (skipped) msg += ` ${skipped} live/graphic segment${skipped === 1 ? "" : "s"} without a file were skipped.`;
    toast(msg, stats.gapCount ? "warn" : "good");
    this._emit("publish");
  }
}

export const store = new Store();
