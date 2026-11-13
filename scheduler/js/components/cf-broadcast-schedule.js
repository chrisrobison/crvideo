// cf-broadcast-schedule — the SCHEDULE tab: "Broadcast Schedule".
//
// The RESOLVED schedule of a channel (channels/<id>/schedule.json, written by
// channels/publish.php): the actual episodes, continuity bumps and filler on
// the clock, in Day / Week / Rundown form, with a "Scheduled Item" inspector,
// and a published-vs-proposed comparison:
//
//   Published  = the live schedule.json (read directly, read-only).
//   Proposed   = "Compile Preview": server/channel-admin.php `preview_schedule`
//                runs the real publish.php against a throwaway copy of the
//                channel's SAVED programming and returns the schedule it would
//                write. Nothing live changes.
//   Publish    = the existing `publish` action (real run), only offered once a
//                preview has been compiled, with the exact window the preview
//                used.
//   History    = Published vs the previous publish (schedule.json.bak).
//
// All times are epoch milliseconds internally (anchor + relative seconds);
// the timezone selector only changes how they are bucketed into days and
// printed. The original Drive/live-playlist scheduler is untouched and lives
// at ?view=legacy-schedule.

import { baseComponentCSS, escapeHtml, toast, appMediaUrl } from "../utils.js";
import { channelAdminApi, scheduleFileApi } from "../admin-api.js";
import { TOPICS, publish, subscribe } from "../../../js/bus.js";
import { icon, uiKitCSS, thumbHtml, swatchStyle } from "./ui-kit.js";

const DAY_MS = 86400000;
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEK_HOUR_PX = 40;

// ---------- timezone-aware helpers (Intl only; no library) ----------

const dtfCache = new Map();
function dtf(tz, opts, key) {
  const k = `${tz}|${key}`;
  if (!dtfCache.has(k)) dtfCache.set(k, new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }));
  return dtfCache.get(k);
}

function tzParts(ms, tz) {
  const p = {};
  for (const x of dtf(tz, { hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" }, "parts").formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: WD.indexOf(p.weekday) };
}

/** Epoch ms of local y-m-d h:mi in `tz` (handles DST by one correction pass). */
function zonedEpoch(y, m, d, h, mi, tz) {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = tzParts(guess, tz);
    guess = want - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - guess);
  }
  return guess;
}

const dayStart = (ms, tz) => { const p = tzParts(ms, tz); return zonedEpoch(p.y, p.m, p.d, 0, 0, tz); };
const addDays = (dayStartMs, n, tz) => { const p = tzParts(dayStartMs + 12 * 3600000, tz); return zonedEpoch(p.y, p.m, p.d + n, 0, 0, tz); };
const weekIndex = (ms, tz) => { const p = tzParts(ms + 12 * 3600000, tz); return p.wd < 0 ? 0 : p.wd; };
const mondayOf = (ms, tz) => addDays(dayStart(ms, tz), -weekIndex(dayStart(ms, tz), tz), tz);

const fmtTime = (ms, tz) => dtf(tz, { hour: "numeric", minute: "2-digit" }, "time").format(new Date(ms));
const fmtDayLong = (ms, tz) => dtf(tz, { weekday: "short", month: "short", day: "numeric", year: "numeric" }, "dayLong").format(new Date(ms));
const fmtMD = (ms, tz) => dtf(tz, { month: "short", day: "numeric" }, "md").format(new Date(ms));
const fmtDayMD = (ms, tz) => dtf(tz, { weekday: "short", month: "short", day: "numeric" }, "dmd").format(new Date(ms));
const fmtStamp = (ms, tz) => `${fmtDayLong(ms, tz)} ${fmtTime(ms, tz)}`;
const ymd = (ms, tz) => { const p = tzParts(ms, tz); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; };

function tzName(tz) {
  try {
    const parts = dtf(tz, { timeZoneName: "longGeneric" }, "long").formatToParts(new Date());
    const long = parts.find((p) => p.type === "timeZoneName")?.value;
    const short = dtf(tz, { timeZoneName: "shortGeneric" }, "short").formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value;
    return long ? `${long}${short ? ` (${short})` : ""}` : tz;
  } catch { return tz; }
}
function tzShort(tz, ms) {
  try { return dtf(tz, { timeZoneName: "short" }, "abbr").formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value || tz; } catch { return tz; }
}

function fmtClock(sec) {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function agoLabel(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? "" : "s"} ago`;
  return `${Math.round(s / 3600)} hour${Math.round(s / 3600) === 1 ? "" : "s"} ago`;
}

// ---------- schedule model ----------

/** Thumbnail for a resolved item (YouTube id or Internet Archive identifier), when derivable. */
function itemThumb(it) {
  const src = it.source || {};
  const yt = src.video_id || (String(it.id || "").startsWith("yt-") ? String(it.id).slice(3) : "");
  if (yt && (src.provider === "youtube" || !src.provider)) return `https://i.ytimg.com/vi/${encodeURIComponent(yt)}/mqdefault.jpg`;
  const ia = src.identifier || (src.page_url || "").match(/archive\.org\/details\/([^/?#]+)/)?.[1];
  return ia ? `https://archive.org/services/img/${encodeURIComponent(ia)}` : "";
}

/** Flatten a schedule.json into absolute-time items and programs. */
function buildModel(sched, anchorMs) {
  const programs = (sched.programs || []).map((p) => ({
    id: p.occurrence_id, blockId: p.block_id, title: p.title || p.series_title || "Program", seriesId: p.series_id, seriesTitle: p.series_title || p.title,
    description: p.description, boundary: p.boundary_mode,
    startMs: anchorMs + (p.start ?? p.nominal_start ?? 0) * 1000, endMs: anchorMs + (p.end ?? p.nominal_end ?? 0) * 1000,
  })).sort((a, b) => a.startMs - b.startMs);
  const progById = new Map(programs.map((p) => [p.id, p]));
  const items = [];
  const byId = new Map();
  for (const b of sched.blocks || []) {
    const base = anchorMs + (b.relative_start || 0) * 1000;
    (b.items || []).forEach((it, i) => {
      const o = {
        key: `${b.block}:${i}`, type: it.type, id: it.id, raw: it,
        startMs: base + (it.start || 0) * 1000, durationSec: it.duration || 0,
        programId: it.program_id, program: progById.get(it.program_id) || null,
      };
      o.endMs = o.startMs + o.durationSec * 1000;
      items.push(o);
      if (it.type === "video" && !byId.has(it.id)) byId.set(it.id, o);
    });
  }
  items.sort((a, b) => a.startMs - b.startMs);
  for (const it of items) if (it.type === "continuity") it.nextItem = byId.get(it.raw.next_program_id) || null;
  const first = items[0]?.startMs ?? anchorMs;
  const last = items.length ? Math.max(...items.slice(-5).map((i) => i.endMs)) : anchorMs;
  const w = sched._publish?.window;
  return {
    raw: sched, programs, items, anchorMs,
    windowStart: w?.start ? Date.parse(w.start) : first,
    windowEnd: w?.end ? Date.parse(w.end) : last,
    generatedAt: sched._publish?.generated_at ? Date.parse(sched._publish.generated_at) : null,
  };
}

const kindOf = (it) => (it.type === "video" ? "program" : it.type === "continuity" ? "bump" : "filler");
const KIND_LABEL = { program: "Program", bump: "Channel Bump", filler: "Interstitial" };

function itemTitle(it) {
  if (it.type === "video") return it.program?.seriesTitle || it.raw.title || "Program";
  if (it.type === "continuity") return "Channel Bump";
  return it.raw.title || "Interstitial";
}
function itemSub(it) {
  if (it.type === "video") return it.raw.title && it.raw.title !== itemTitle(it) ? it.raw.title : "";
  if (it.type === "continuity") return it.nextItem ? `Up next: ${it.nextItem.raw.title || itemTitle(it.nextItem)}` : "Coming up…";
  return it.raw.template || "";
}

/** Programs of A vs B aligned by start time -> rows + counts, over their overlapping window. */
function compareModels(a, b) {
  const lo = Math.max(a.windowStart, b.windowStart), hi = Math.min(a.windowEnd, b.windowEnd);
  const firstEp = (m, p) => m.items.find((i) => i.programId === p.id && i.type === "video");
  const epSig = (m, p) => m.items.filter((i) => i.programId === p.id && i.type === "video").map((i) => i.id).join("|");
  const A = new Map(a.programs.filter((p) => p.startMs >= lo && p.startMs < hi).map((p) => [p.startMs, p]));
  const B = new Map(b.programs.filter((p) => p.startMs >= lo && p.startMs < hi).map((p) => [p.startMs, p]));
  const rows = [];
  let unchanged = 0;
  for (const t of [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x - y)) {
    const pa = A.get(t), pb = B.get(t);
    const same = pa && pb && pa.seriesId === pb.seriesId && pa.endMs === pb.endMs && epSig(a, pa) === epSig(b, pb);
    if (same) { unchanged++; continue; }
    rows.push({
      t, kind: !pa ? "added" : !pb ? "removed" : "changed",
      a: pa && { p: pa, ep: firstEp(a, pa) }, b: pb && { p: pb, ep: firstEp(b, pb) },
    });
  }
  return { rows, unchanged, lo, hi };
}

class CfBroadcastSchedule extends HTMLElement {
  constructor() {
    super();
    this._channels = [];
    this._chId = null;
    this._loading = true;
    this._error = null;
    this._pub = null; // model of live schedule.json
    this._prev = undefined; // model of schedule.json.bak (undefined = not loaded, null = none)
    this._prop = null; // model of the compiled preview
    this._propMeta = null; // { at, params }
    this._viewVer = "published";
    this._cmpMode = "preview";
    this._view = "day";
    this._tzMode = "channel";
    this._focus = Date.now();
    this._preset = "today";
    this._selKey = null;
    this._tab = "details";
    this._announcements = null;
    this._compiling = false;
    this._loadedAt = 0;
  }

  connectedCallback() {
    this._ctl = new AbortController();
    if (!this.shadowRoot) { this.attachShadow({ mode: "open" }); this._render(); }
    // Come back to a stale view -> refresh the live schedule (cheap static read).
    subscribe(TOPICS.APP_VIEW_STATE, ({ data }) => {
      if (data?.view === "schedule" && this._chId && Date.now() - this._loadedAt > 60000) this._loadChannel(this._chId, { keepProposal: true });
    }, { signal: this._ctl.signal });
    if (!this._channels.length) this._boot();
  }

  disconnectedCallback() { this._ctl?.abort(); }

  async _boot() {
    try {
      this._channels = (await channelAdminApi.list()).filter((c) => !c.hidden);
      const first = this._channels.find((c) => c.has_programming) || this._channels[0];
      if (first) await this._loadChannel(first.id);
      else this._loading = false;
    } catch (e) {
      this._error = e.message;
      this._loading = false;
    }
    this._renderAll();
  }

  _channel() { return this._channels.find((c) => c.id === this._chId) || null; }
  _model() { return this._viewVer === "proposed" && this._prop ? this._prop : this._pub; }

  /** IANA zone for the current mode. Channel zone = its first programming block's, else the browser's. */
  _tz() {
    if (this._tzMode === "UTC") return "UTC";
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    if (this._tzMode === "local") return local;
    return this._channel()?.programming_blocks?.[0]?.recurrence?.timezone || local;
  }

  async _loadChannel(id, { keepProposal = false } = {}) {
    this._chId = id;
    this._loading = true;
    this._error = null;
    this._renderAll();
    try {
      const [sched, meta] = await Promise.all([scheduleFileApi.schedule(id), scheduleFileApi.meta(id).catch(() => ({}))]);
      const anchor = Date.parse(meta?.anchor || "") || Date.parse(sched?._publish?.window?.start || "") || 0;
      this._pub = buildModel(sched, anchor);
      this._loadedAt = Date.now();
    } catch (e) {
      this._pub = null;
      this._error = e.message;
    }
    if (!keepProposal) { this._prop = null; this._propMeta = null; this._viewVer = "published"; this._cmpMode = "preview"; }
    this._prev = undefined;
    this._announcements = null;
    this._selKey = null;
    this._loading = false;
    // Land on today if the live window covers it; otherwise on the window's first day.
    const now = Date.now();
    if (this._pub && (now < this._pub.windowStart || now >= this._pub.windowEnd)) { this._focus = this._pub.windowStart; this._preset = "custom"; }
    else if (this._preset === "custom" && this._pub) this._preset = "today";
    this._renderAll();
    this._scrollNow();
  }

  // ---------- skeleton ----------

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        ${uiKitCSS}
        .workspace{ grid-template-columns:270px minmax(0,1fr) 420px; }
        .centercol{ display:flex; flex-direction:column; gap:14px; min-height:0; min-width:0; }
        .centercol > .panel{ flex:1 1 0; }
        .centercol > .panel.cmp{ flex:0 0 auto; max-height:44%; }
        .left-body{ padding:14px; display:flex; flex-direction:column; gap:6px; overflow:auto; flex:1; }
        .left-body h3{ margin:0 0 6px; font-size:14.5px; font-weight:700; display:flex; align-items:center; gap:8px; }
        .left-body .lbl{ font-size:13px; font-weight:650; margin-bottom:2px; }
        .navitem{ display:flex; justify-content:flex-start; align-items:center; gap:11px; padding:10px 12px; border-radius:10px; cursor:pointer; color:var(--text); font-size:14px; border:0; background:transparent; width:100%; text-align:left; font-weight:500; }
        .navitem svg{ color:var(--text-muted); }
        .navitem:hover{ background:rgba(255,255,255,.05); }
        .navitem.on{ background:rgba(74,127,216,.32); box-shadow:inset 0 0 0 1px var(--accent-line); }
        .navitem.on svg{ color:#fff; }
        .hr{ height:1px; background:var(--border-soft); margin:10px 0; }
        .ver{ display:flex; gap:11px; padding:9px 10px; border-radius:10px; cursor:pointer; align-items:flex-start; border:1px solid transparent; }
        .ver:hover{ background:rgba(255,255,255,.04); }
        .ver.on{ border-color:var(--accent-line); background:rgba(74,127,216,.14); }
        .ver.off{ opacity:.55; cursor:default; }
        .ver .dot{ width:10px; height:10px; border-radius:50%; margin-top:5px; flex-shrink:0; }
        .ver b{ font-size:14.5px; }
        .ver small{ display:block; color:var(--text-muted); font-size:12.5px; line-height:1.4; }
        .ver .pill{ margin-left:auto; font-size:11px; padding:1px 9px; }
        .bar{ display:flex; align-items:center; gap:10px; padding:12px 14px; border-bottom:1px solid var(--border-soft); flex-wrap:wrap; }
        .bar .icon{ width:34px; height:34px; }
        .rangepill{ display:flex; align-items:center; gap:9px; background:var(--panel-2); border:1px solid var(--border); border-radius:10px; padding:7px 14px; font-weight:600; font-size:14px; white-space:nowrap; }
        .bar .seg{ margin-left:auto; }
        .dayhead{ display:flex; align-items:center; gap:12px; padding:12px 18px 6px; }
        .dayhead h2{ margin:0; font-size:19px; font-weight:750; flex:1; }
        .tzsel{ width:auto; background-color:transparent; border:0; color:var(--text-muted); font-size:13px; padding-right:24px; }
        .daystrip{ display:flex; gap:6px; padding:2px 18px 8px; }
        .daystrip button{ flex:1; padding:5px 0; font-size:12px; background:transparent; border:1px solid var(--border-soft); color:var(--text-muted); flex-direction:column; gap:0; line-height:1.25; }
        .daystrip button.on{ background:var(--accent-soft); border-color:var(--accent-line); color:#fff; }
        .daystrip button.today b{ color:var(--accent-hi); }
        .sched-scroll{ flex:1; min-height:0; overflow:auto; padding:2px 14px 12px 8px; }
        .row{ display:grid; grid-template-columns:78px minmax(0,1fr); align-items:center; gap:10px; margin:5px 0; }
        .row .t{ text-align:right; color:var(--text-muted); font-size:13px; }
        .card{ display:flex; align-items:center; gap:12px; border:1px solid; border-radius:10px; padding:7px 14px 7px 8px; cursor:pointer; min-width:0; position:relative; }
        .card.program{ min-height:54px; }
        .card.bump,.card.filler{ min-height:40px; background:linear-gradient(90deg,#263a66,#1f2f55); border-color:#3f5f9c; color:#e3ecff; }
        .card.filler{ background:linear-gradient(90deg,#1d2a4d,#18233f); border-color:#344f86; }
        .card.sel{ outline:2px solid #fff; outline-offset:-1px; box-shadow:0 0 0 3px rgba(74,127,216,.5); }
        .card.past{ opacity:.55; }
        .card .thumb{ width:76px; height:44px; border-radius:6px; }
        .card .ico{ width:44px; height:28px; display:grid; place-items:center; flex-shrink:0; opacity:.9; }
        .card .tx{ flex:1; min-width:0; }
        .card .tx b{ display:block; font-size:15px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .card.bump .tx b,.card.filler .tx b{ font-size:13.5px; }
        .card .tx span:not(.onair){ display:block; font-size:12.5px; opacity:.85; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .card .dur{ font-variant-numeric:tabular-nums; font-size:13.5px; opacity:.95; }
        .onair{ font-size:10.5px; font-weight:800; letter-spacing:.06em; background:var(--live); color:#fff; padding:2px 7px; border-radius:6px; margin-right:6px; }
        .nowrow .t{ color:#ff9d9d; font-weight:700; }

        .weekwrap{ flex:1; min-height:0; overflow:auto; }
        .wgrid{ display:grid; grid-template-columns:62px repeat(7, minmax(88px,1fr)); min-width:720px; }
        .wgrid .corner,.wgrid .wh{ position:sticky; top:0; z-index:4; height:46px; background:linear-gradient(180deg,#171c38,#141933); border-bottom:1px solid var(--border); display:flex; flex-direction:column; align-items:center; justify-content:center; font-size:12px; color:var(--text-muted); border-left:1px solid var(--border-soft); }
        .wgrid .wh b{ color:var(--text); font-size:13px; }
        .wgrid .wh.today b{ color:var(--accent-hi); }
        .wgrid .corner{ border-left:0; }
        .wtimes{ position:relative; }
        .wtimes span{ position:absolute; right:8px; transform:translateY(-50%); font-size:11px; color:var(--text-muted); white-space:nowrap; }
        .wcol{ position:relative; border-left:1px solid var(--border-soft); background-image:repeating-linear-gradient(to bottom, transparent 0, transparent calc(${WEEK_HOUR_PX}px - 1px), rgba(255,255,255,.045) calc(${WEEK_HOUR_PX}px - 1px), rgba(255,255,255,.045) ${WEEK_HOUR_PX}px); }
        .wblk{ position:absolute; left:2px; right:2px; border:1px solid; border-radius:7px; padding:3px 6px; overflow:hidden; cursor:pointer; text-align:center; display:flex; flex-direction:column; justify-content:center; line-height:1.15; }
        .wblk b{ font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .wblk span{ font-size:11px; opacity:.9; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .wblk.sel{ outline:2px solid #fff; outline-offset:-1px; z-index:3; }
        .wnow{ position:absolute; left:0; right:0; height:2px; background:var(--live); z-index:2; pointer-events:none; }

        table.rd{ width:100%; border-collapse:collapse; font-size:13px; }
        table.rd th{ position:sticky; top:0; background:#151a35; text-align:left; padding:9px 12px; color:var(--text-muted); font-weight:600; font-size:12px; border-bottom:1px solid var(--border); z-index:2; }
        table.rd td{ padding:8px 12px; border-bottom:1px solid var(--border-soft); white-space:nowrap; max-width:340px; overflow:hidden; text-overflow:ellipsis; }
        table.rd tr{ cursor:pointer; }
        table.rd tr:hover td{ background:rgba(74,127,216,.08); }
        table.rd tr.sel td{ background:rgba(74,127,216,.22); }
        table.rd tr.past td{ opacity:.5; }
        table.rd tr.now td{ background:rgba(239,68,68,.12); }

        .insp-top{ display:flex; gap:14px; padding:0 16px 12px; }
        .insp-top .pic{ position:relative; width:46%; aspect-ratio:16/10; border-radius:11px; overflow:hidden; background:#05070f; border:1px solid var(--border); flex-shrink:0; cursor:pointer; }
        .insp-top .pic .thumb{ width:100%; height:100%; border-radius:0; }
        .insp-top .pic .play{ position:absolute; inset:0; display:grid; place-items:center; }
        .insp-top .pic .play span{ width:50px; height:50px; border-radius:50%; background:rgba(15,18,40,.72); border:2px solid rgba(255,255,255,.85); display:grid; place-items:center; }
        .insp-top .pic.bumpic{ display:grid; place-items:center; background:linear-gradient(135deg,#263a66,#1b2a4f); color:#b8cdf5; cursor:default; }
        .insp-top h3{ margin:0; font-size:20px; font-weight:750; }
        .insp-top .ep{ font-size:13.5px; color:var(--text-muted); margin-top:4px; }
        .insp-top .meta{ display:flex; align-items:center; gap:8px; margin-top:8px; color:var(--text-muted); font-size:13px; }
        .insp-top .pill{ margin-top:8px; }
        .insp-body{ padding:6px 16px 14px; overflow:auto; flex:1; min-height:0; }
        .insp-tabs{ margin:0 16px 4px; }
        .tabs.insp-tabs button{ padding:7px 2px; white-space:nowrap; font-size:12px; min-width:0; }
        .annrow{ background:rgba(10,13,28,.5); border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin-top:10px; font-size:13px; line-height:1.5; }
        .annrow audio{ width:100%; margin-top:8px; }

        .cmp-head{ display:flex; align-items:center; gap:12px; padding:12px 16px 6px; }
        .cmp-head h2{ margin:0; font-size:17px; font-weight:750; display:flex; align-items:center; gap:10px; }
        .cmp-head p{ margin:2px 0 0; color:var(--text-muted); font-size:13px; }
        .cmp-head .pills{ margin-left:auto; display:flex; gap:8px; }
        .cmp-table{ overflow:auto; max-height:136px; margin:6px 14px 0; border:1px solid var(--border); border-radius:10px; }
        .cmp-table table{ width:100%; border-collapse:collapse; font-size:13px; }
        .cmp-table th{ position:sticky; top:0; background:#171c38; text-align:left; padding:8px 12px; color:var(--text-muted); font-weight:600; z-index:2; }
        .cmp-table td{ padding:7px 12px; border-top:1px solid var(--border-soft); vertical-align:middle; }
        .cmp-table tr.changed td{ background:rgba(74,127,216,.2); }
        .cmp-table tr.added td{ background:rgba(34,197,94,.1); }
        .cmp-table tr.removed td{ background:rgba(239,68,68,.1); }
        .cmp-table .cell{ display:flex; gap:10px; align-items:center; min-width:0; }
        .cmp-table .cell .thumb{ width:44px; height:28px; border-radius:5px; }
        .cmp-table .cell b{ display:block; font-size:13px; }
        .cmp-table .cell span{ display:block; font-size:12px; color:var(--text-muted); max-width:240px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .cmp-foot{ display:flex; align-items:center; gap:10px; padding:12px 16px; color:var(--text-muted); font-size:13px; }
        .cmp-foot .spacer{ flex:1; }
        .dim{ color:var(--text-muted); }
      </style>
      <div class="page-head">
        <div class="head-ico">${icon("calendarPlay", 34)}</div>
        <div><h1>Broadcast Schedule</h1><p>Resolved schedule with actual episodes, continuity, and filler. Preview changes and publish to go live.</p></div>
      </div>
      <div class="workspace">
        <section class="panel left"></section>
        <div class="centercol">
          <section class="panel main"></section>
          <section class="panel cmp"></section>
        </div>
        <section class="panel insp"></section>
      </div>
      <dialog class="pub-dlg"></dialog>
    `;
  }

  _renderAll() {
    this._renderLeft();
    this._renderMain();
    this._renderCompare();
    this._renderInspector();
  }

  // ---------- left ----------

  _renderLeft() {
    const left = this.shadowRoot.querySelector(".left");
    if (!this._channels.length) { left.innerHTML = `<div class="empty">${this._error ? escapeHtml(this._error) : this._loading ? "Loading…" : "No channels."}</div>`; return; }
    const tz = this._tz();
    const m = this._pub;
    const todayStart = dayStart(Date.now(), tz);
    const wk = mondayOf(this._focus, tz);
    const thisWk = mondayOf(Date.now(), tz);
    const preset = this._preset === "custom" ? "custom" : wk === thisWk ? (this._view !== "week" && dayStart(this._focus, tz) === todayStart ? "today" : "week") : wk === addDays(thisWk, 7, tz) ? "next" : "custom";
    left.innerHTML = `
      <div class="left-body">
        <div class="lbl">Channel</div>
        <select class="ch-pick">${this._channels.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === this._chId ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select>
        <div style="height:6px"></div>
        ${[["today", "Today", "calendar"], ["week", "This Week", "calendar"], ["next", "Next Week", "calendar"], ["custom", "Custom Range", "calendar"]].map(([k, l, ic]) =>
          `<button class="navitem ${preset === k ? "on" : ""}" data-preset="${k}">${icon(ic, 18)} ${l}</button>`).join("")}
        ${preset === "custom" ? `<input type="date" class="custom-date" value="${ymd(this._focus, tz)}" style="margin:4px 0 0">` : ""}
        <div class="hr"></div>
        <h3>${icon("layers", 18)} Schedule Versions</h3>
        <div class="ver ${this._viewVer === "published" ? "on" : ""}" data-ver="published">
          <span class="dot" style="background:var(--good);box-shadow:0 0 8px var(--good)"></span>
          <div><b>Published</b><small>${m ? `Live schedule.json${m.generatedAt ? `<br>Generated ${escapeHtml(fmtStamp(m.generatedAt, tz))}` : ""}<br>${escapeHtml(fmtMD(m.windowStart, tz))} – ${escapeHtml(fmtMD(m.windowEnd - 1, tz))}` : "Not available"}</small></div>
        </div>
        <div class="ver ${this._viewVer === "proposed" ? "on" : ""} ${this._prop ? "" : "off"}" data-ver="proposed">
          <span class="dot" style="background:var(--accent-hi);box-shadow:0 0 8px var(--accent-hi)"></span>
          <div><b>Proposed</b><small>${this._prop ? `Compiled ${agoLabel(this._propMeta.at)}<br>${escapeHtml(fmtMD(this._prop.windowStart, tz))} – ${escapeHtml(fmtMD(this._prop.windowEnd - 1, tz))}` : "Not compiled yet.<br>Use Compile Preview."}</small></div>
          <span class="pill" data-tone="accent">Draft</span>
        </div>
        <div class="hr"></div>
        <h3>${icon("swap", 18)} Compare</h3>
        <button class="navitem ${this._cmpMode === "preview" ? "on" : ""}" data-cmp="preview">${icon("swap", 18)} Preview Changes</button>
        <button class="navitem ${this._cmpMode === "history" ? "on" : ""}" data-cmp="history">${icon("history", 18)} Change History</button>
      </div>`;
    left.querySelector(".ch-pick").addEventListener("change", (e) => this._loadChannel(e.target.value));
    left.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => this._setPreset(b.dataset.preset)));
    left.querySelector(".custom-date")?.addEventListener("change", (e) => {
      if (!e.target.value) return;
      const [y, mo, d] = e.target.value.split("-").map(Number);
      this._focus = zonedEpoch(y, mo, d, 12, 0, tz);
      this._preset = "custom";
      this._renderAll();
    });
    left.querySelectorAll("[data-ver]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.ver === "proposed" && !this._prop) return;
      this._viewVer = b.dataset.ver;
      this._selKey = null;
      this._renderAll();
    }));
    left.querySelectorAll("[data-cmp]").forEach((b) => b.addEventListener("click", async () => {
      this._cmpMode = b.dataset.cmp;
      if (this._cmpMode === "history" && this._prev === undefined) {
        try { const j = await scheduleFileApi.previousSchedule(this._chId); this._prev = j ? buildModel(j, Date.parse((await scheduleFileApi.meta(this._chId).catch(() => ({}))).anchor || "") || this._pub.anchorMs) : null; } catch { this._prev = null; }
      }
      this._renderLeft();
      this._renderCompare();
    }));
  }

  _setPreset(k) {
    const tz = this._tz();
    const now = Date.now();
    if (k === "today") { this._focus = now; this._view = this._view === "week" ? "day" : this._view; }
    if (k === "week") { this._focus = now; this._view = "week"; }
    if (k === "next") { this._focus = addDays(mondayOf(now, tz), 7, tz) + 12 * 3600000; this._view = "week"; }
    this._preset = k === "custom" ? "custom" : "auto";
    this._renderAll();
    this._scrollNow();
  }

  // ---------- main (day / week / rundown) ----------

  _renderMain() {
    const main = this.shadowRoot.querySelector(".main");
    const m = this._model();
    const tz = this._tz();
    if (this._loading) { main.innerHTML = `<div class="empty">Loading schedule…</div>`; return; }
    if (this._error) { main.innerHTML = `<div class="error">Could not load the schedule: ${escapeHtml(this._error)}<br><span class="dim">Has this channel been published? See Programming → Preview &amp; publish.</span></div>`; return; }
    const ds = dayStart(this._focus, tz);
    const wk = mondayOf(this._focus, tz);
    const wkEnd = addDays(wk, 6, tz);
    main.innerHTML = `
      <div class="bar">
        <button class="icon prev" aria-label="Previous">${icon("left", 17)}</button>
        <div class="rangepill">${icon("calendar", 17)} ${escapeHtml(fmtDayMD(wk, tz))} – ${escapeHtml(fmtDayLong(wkEnd, tz).replace(/^\w+, /, ""))}</div>
        <button class="icon next" aria-label="Next">${icon("right", 17)}</button>
        <div class="seg">${[["day", "Day"], ["week", "Week"], ["rundown", "Rundown"]].map(([k, l]) => `<button data-v="${k}" class="${this._view === k ? "on" : ""}">${l}</button>`).join("")}</div>
      </div>
      <div class="dayhead">
        <h2>${this._view === "week" ? `Week of ${escapeHtml(fmtDayLong(wk, tz))}` : escapeHtml(fmtDayLong(ds, tz))}</h2>
        <select class="tzsel" aria-label="Timezone">
          <option value="channel" ${this._tzMode === "channel" ? "selected" : ""}>Channel: ${escapeHtml(tzName(this._channelTz()))}</option>
          <option value="local" ${this._tzMode === "local" ? "selected" : ""}>My time: ${escapeHtml(tzName(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"))}</option>
          <option value="UTC" ${this._tzMode === "UTC" ? "selected" : ""}>UTC</option>
        </select>
      </div>
      ${this._view === "week" ? "" : `<div class="daystrip">${Array.from({ length: 7 }, (_, i) => { const d = addDays(wk, i, tz); return `<button data-day="${d}" class="${d === ds ? "on" : ""} ${d === dayStart(Date.now(), tz) ? "today" : ""}"><b>${WD[i]}</b><span>${escapeHtml(fmtMD(d + 3600000, tz))}</span></button>`; }).join("")}</div>`}
      <div class="body-slot" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>`;
    const bar = main;
    bar.querySelector(".prev").addEventListener("click", () => this._shift(-1));
    bar.querySelector(".next").addEventListener("click", () => this._shift(1));
    bar.querySelector(".seg").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) { this._view = b.dataset.v; this._renderLeft(); this._renderMain(); this._scrollNow(); } });
    bar.querySelector(".tzsel").addEventListener("change", (e) => { this._tzMode = e.target.value; this._renderAll(); this._scrollNow(); });
    bar.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", () => { this._focus = Number(b.dataset.day) + 3600000; this._preset = "auto"; this._renderLeft(); this._renderMain(); this._scrollNow(); }));
    const slot = main.querySelector(".body-slot");
    if (!m) { slot.innerHTML = `<div class="empty">Nothing to show.</div>`; return; }
    if (this._view === "week") this._renderWeek(slot, m, tz, wk);
    else if (this._view === "rundown") this._renderRundown(slot, m, tz, ds);
    else this._renderDay(slot, m, tz, ds);
  }

  _channelTz() { return this._channel()?.programming_blocks?.[0]?.recurrence?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }

  _shift(dir) {
    const tz = this._tz();
    const ds = dayStart(this._focus, tz);
    this._focus = addDays(ds, this._view === "week" ? dir * 7 : dir, tz) + 3600000;
    this._preset = "auto";
    this._renderLeft();
    this._renderMain();
    this._scrollNow();
  }

  _dayItems(m, ds, tz) {
    const de = addDays(ds, 1, tz);
    return m.items.filter((i) => i.startMs >= ds && i.startMs < de);
  }

  _emptyDay(m) {
    return `<div class="empty">No schedule for this day.<br><span class="dim">The ${this._viewVer} schedule covers ${escapeHtml(fmtDayLong(m.windowStart, this._tz()))} – ${escapeHtml(fmtDayLong(m.windowEnd - 1, this._tz()))}.</span></div>`;
  }

  _cardHtml(it, tz, now, nowIdx) {
    const kind = kindOf(it);
    const onair = it.startMs <= now && now < it.endMs;
    const past = it.endMs <= now;
    const sel = it.key === this._selKey;
    const title = itemTitle(it), sub = itemSub(it);
    const style = kind === "program" ? swatchStyle(it.program?.seriesId || it.id) : "";
    return `<div class="row ${onair ? "nowrow" : ""}" data-key="${it.key}">
      <div class="t">${escapeHtml(fmtTime(it.startMs, tz))}</div>
      <div class="card ${kind} ${sel ? "sel" : ""} ${past ? "past" : ""}" style="${style}">
        ${kind === "program" ? thumbHtml(itemThumb(it.raw)) : `<span class="ico">${icon(kind === "bump" ? "megaphone" : "clapper", 22)}</span>`}
        <div class="tx"><b>${onair ? `<span class="onair">ON AIR</span>` : ""}${escapeHtml(title)}</b>${sub ? `<span>${escapeHtml(sub)}</span>` : ""}</div>
        <span class="dur">${fmtClock(it.durationSec)}</span>
      </div></div>`;
  }

  _renderDay(slot, m, tz, ds) {
    const items = this._dayItems(m, ds, tz);
    const now = Date.now();
    slot.innerHTML = `<div class="sched-scroll">${items.length ? items.map((it) => this._cardHtml(it, tz, now)).join("") : this._emptyDay(m)}</div>`;
    slot.querySelector(".sched-scroll").addEventListener("click", (e) => {
      const r = e.target.closest(".row");
      if (r) this._select(r.dataset.key);
    });
  }

  _renderRundown(slot, m, tz, ds) {
    const items = this._dayItems(m, ds, tz);
    const now = Date.now();
    slot.innerHTML = items.length ? `<div class="sched-scroll" style="padding:0"><table class="rd">
      <thead><tr><th>Start</th><th>Item</th><th>Series</th><th>Type</th><th>Duration</th><th>Status</th></tr></thead>
      <tbody>${items.map((it) => {
        const onair = it.startMs <= now && now < it.endMs;
        const past = it.endMs <= now;
        return `<tr data-key="${it.key}" class="${it.key === this._selKey ? "sel" : ""} ${onair ? "now" : ""} ${past ? "past" : ""}">
          <td>${escapeHtml(fmtTime(it.startMs, tz))}</td><td>${escapeHtml(it.type === "video" ? it.raw.title || itemTitle(it) : itemTitle(it))}</td>
          <td class="dim">${escapeHtml(it.program?.seriesTitle || "—")}</td><td>${KIND_LABEL[kindOf(it)]}</td><td>${fmtClock(it.durationSec)}</td>
          <td>${onair ? `<span class="onair">ON AIR</span>` : past ? `<span class="dim">Aired</span>` : `<span class="pill" data-tone="approved">Scheduled</span>`}</td></tr>`;
      }).join("")}</tbody></table></div>` : `<div class="sched-scroll">${this._emptyDay(m)}</div>`;
    slot.querySelector("tbody")?.addEventListener("click", (e) => { const r = e.target.closest("tr"); if (r) this._select(r.dataset.key); });
  }

  _renderWeek(slot, m, tz, wk) {
    const now = Date.now();
    const days = Array.from({ length: 7 }, (_, i) => addDays(wk, i, tz));
    const todayDs = dayStart(now, tz);
    const cols = days.map((d) => {
      const de = addDays(d, 1, tz);
      return m.programs.filter((p) => p.endMs > d && p.startMs < de).map((p) => {
        const s = Math.max(p.startMs, d), e = Math.min(p.endMs, de);
        const top = ((s - d) / 3600000) * WEEK_HOUR_PX, h = Math.max(18, ((e - s) / 3600000) * WEEK_HOUR_PX - 2);
        const firstVid = m.items.find((i) => i.programId === p.id && i.type === "video");
        const key = firstVid?.key || "";
        return `<div class="wblk ${key && key === this._selKey ? "sel" : ""}" data-key="${key}" style="${swatchStyle(p.seriesId)};top:${top + 1}px;height:${h}px" title="${escapeHtml(p.title)} · ${escapeHtml(fmtTime(p.startMs, tz))} – ${escapeHtml(fmtTime(p.endMs, tz))}"><b>${escapeHtml(p.seriesTitle || p.title)}</b>${h >= 32 ? `<span>${escapeHtml(fmtTime(p.startMs, tz))} – ${escapeHtml(fmtTime(p.endMs, tz))}</span>` : ""}</div>`;
      }).join("");
    });
    slot.innerHTML = `<div class="weekwrap"><div class="wgrid">
      <div class="corner"></div>
      ${days.map((d, i) => `<div class="wh ${d === todayDs ? "today" : ""}"><b>${WD[i].toUpperCase()}</b><span>${escapeHtml(fmtMD(d + 3600000, tz))}</span></div>`).join("")}
      <div class="wtimes" style="height:${24 * WEEK_HOUR_PX}px">${Array.from({ length: 24 }, (_, h) => h ? `<span style="top:${h * WEEK_HOUR_PX}px">${h % 12 || 12}:00 ${h < 12 ? "AM" : "PM"}</span>` : "").join("")}</div>
      ${cols.map((html, i) => `<div class="wcol" style="height:${24 * WEEK_HOUR_PX}px">${html}${days[i] === todayDs ? `<div class="wnow" style="top:${((now - days[i]) / 3600000) * WEEK_HOUR_PX}px"></div>` : ""}</div>`).join("")}
    </div></div>`;
    slot.querySelector(".wgrid").addEventListener("click", (e) => { const b = e.target.closest(".wblk"); if (b?.dataset.key) this._select(b.dataset.key); });
  }

  _scrollNow() {
    requestAnimationFrame(() => {
      const root = this.shadowRoot;
      const el = root.querySelector(".nowrow") || root.querySelector(".card.sel")?.closest(".row");
      if (el) el.scrollIntoView({ block: "center" });
      else if (this._view === "week") {
        const w = root.querySelector(".weekwrap");
        if (w) w.scrollTop = Math.max(0, (tzParts(Date.now(), this._tz()).h - 2) * WEEK_HOUR_PX);
      }
    });
  }

  // ---------- selection / inspector ----------

  _select(key) {
    this._selKey = key;
    this._tab = "details";
    this._renderMain();
    this._renderInspector();
  }

  _sel() { return this._model()?.items.find((i) => i.key === this._selKey) || null; }

  _renderInspector() {
    const panel = this.shadowRoot.querySelector(".insp");
    const it = this._sel();
    const tz = this._tz();
    if (!it) {
      panel.innerHTML = `<div class="panel-head"><h2>${icon("calendar", 18)} Scheduled Item</h2></div><div class="empty">Select an item in the schedule to inspect it.</div>`;
      return;
    }
    const m = this._model();
    const kind = kindOf(it);
    const src = it.raw.source || {};
    const block = it.program ? this._channel()?.programming_blocks?.find((b) => b.id === it.program.blockId) : null;
    const url = src.page_url || it.raw.source_url || src.url || "";
    const title = itemTitle(it);
    const sub = it.type === "video" ? it.raw.title : itemSub(it);
    panel.innerHTML = `
      <div class="panel-head"><h2>${icon("calendar", 18)} Scheduled Item</h2></div>
      <div class="insp-top">
        ${kind === "program"
          ? `<div class="pic" data-open="${escapeHtml(url)}">${thumbHtml(itemThumb(it.raw))}${url ? `<div class="play"><span>${icon("play", 22)}</span></div>` : ""}</div>`
          : `<div class="pic bumpic">${icon(kind === "bump" ? "megaphone" : "clapper", 44)}</div>`}
        <div style="min-width:0">
          <h3>${escapeHtml(title)}</h3>
          ${sub ? `<div class="ep">${escapeHtml(sub)}</div>` : ""}
          <div class="meta">${icon("clock", 15)} ${fmtClock(it.durationSec)}</div>
          <span class="pill" data-tone="${kind === "program" ? "good" : "accent"}">${kind === "program" ? icon("check", 13) : ""} ${KIND_LABEL[kind]}</span>
        </div>
      </div>
      <div class="tabs pill-tabs insp-tabs">${[["details", "Details"], ["block", "Programming Block"], ["assets", "Assets"], ["continuity", "Continuity"]].map(([k, l]) => `<button data-tab="${k}" class="${this._tab === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="insp-body">${this._inspectorTab(it, m, tz, block, url)}</div>`;
    panel.querySelector(".pic[data-open]")?.addEventListener("click", (e) => { const u = e.currentTarget.dataset.open; if (u) window.open(u, "_blank", "noopener"); });
    panel.querySelector(".insp-tabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab]");
      if (!b) return;
      this._tab = b.dataset.tab;
      this._renderInspector();
      if (this._tab === "continuity" && !this._announcements) this._loadAnnouncements();
    });
    panel.querySelector("[data-open-series]")?.addEventListener("click", () => {
      publish(TOPICS.APP_VIEW_OPEN, { view: "series" });
      publish(TOPICS.SERIES_REVIEW_OPEN, { seriesId: it.program.seriesId, episodeId: it.id });
    });
    panel.querySelectorAll("[data-open-block]").forEach((b) => b.addEventListener("click", () => {
      publish(TOPICS.APP_VIEW_OPEN, { view: "programming" });
      publish(TOPICS.PROGRAMMING_CHANNEL_OPEN, { channelId: this._chId, blockId: it.program.blockId });
    }));
  }

  _inspectorTab(it, m, tz, block, url) {
    const src = it.raw.source || {};
    const kind = kindOf(it);
    if (this._tab === "block") {
      if (!it.program) return `<div class="empty">This item isn't part of a programming block.</div>`;
      const rec = block?.recurrence || {};
      return `<div class="kv">
        <div>Block</div><div>${escapeHtml(it.program.title)}</div>
        <div>Block id</div><div>${escapeHtml(it.program.blockId || "—")}</div>
        <div>Airs</div><div>${block ? `${escapeHtml(rec.frequency || "daily")} at ${escapeHtml(rec.time || "")} ${escapeHtml(rec.timezone || "")}${rec.weekday ? ` (${escapeHtml(rec.weekday)})` : ""}` : "<span class=dim>Block no longer in programming.json</span>"}</div>
        <div>Slot</div><div>${escapeHtml(fmtStamp(it.program.startMs, tz))} – ${escapeHtml(fmtTime(it.program.endMs, tz))}</div>
        <div>Duration</div><div>${block ? fmtClock(block.duration) : fmtClock((it.program.endMs - it.program.startMs) / 1000)}</div>
        <div>Packing</div><div>${block?.packing?.enabled ? escapeHtml(`${block.packing.mode || "sequential"} · on unfit: ${block.packing.on_unfit || "defer"}`) : "Single episode"}</div>
        <div>Boundary</div><div>${escapeHtml(it.program.boundary || block?.boundary?.mode || "hard")}</div>
      </div><div style="margin-top:12px"><button class="outline" data-open-block>${icon("external", 15)} Open in Programming</button></div>`;
    }
    if (this._tab === "assets") {
      const rows = [["Media URL", it.raw.media_url], ["Source page", url], ["Provider", src.provider], ["Identifier", src.video_id || src.identifier], ["Channel", src.channel_title], ["License", src.license], ["Format", src.format], ["Availability", src.availability]].filter(([, v]) => v);
      return rows.length ? `<div class="kv">${rows.map(([k, v]) => `<div>${k}</div><div>${/^https?:/.test(String(v)) ? `<a href="${escapeHtml(v)}" target="_blank" rel="noopener">${escapeHtml(v)}</a>` : escapeHtml(String(v))}</div>`).join("")}</div>`
        : `<div class="empty">${kind === "bump" ? "Bumps are rendered live from the channel's continuity theme — no media asset." : "No asset details recorded."}</div>`;
    }
    if (this._tab === "continuity") {
      if (!this._announcements) return `<div class="empty">Loading announcements…</div>`;
      const pid = it.programId;
      const nextProgId = it.type === "continuity" ? it.nextItem?.programId : null;
      const hits = this._announcements.filter((a) => a.toProgramId === pid || a.fromProgramId === pid || (nextProgId && a.toProgramId === nextProgId));
      return `${it.type === "continuity" ? `<div class="kv"><div>Template</div><div>${escapeHtml(it.raw.template || "—")}</div><div>Up next</div><div>${escapeHtml(it.nextItem?.raw.title || "—")}</div></div>` : ""}
        ${hits.length ? hits.map((a) => `<div class="annrow"><span class="pill" data-tone="${a.status === "ready" ? "good" : "neutral"}">${escapeHtml(a.type || "")}</span> <span class="dim">${escapeHtml(a.status || "")}${a.duration ? ` · ${Number(a.duration).toFixed(1)}s` : ""}</span><div style="margin-top:6px">${escapeHtml(a.text || "")}</div>${a.audio ? `<audio controls preload="none" src="${escapeHtml(appMediaUrl(a.audio))}"></audio>` : ""}</div>`).join("")
          : `<div class="empty">No AI announcement is attached to this slot.<br><span class="dim">Configure the announcer in Programming → ⋯ → Continuity announcer.</span></div>`}`;
    }
    // details
    return `<div class="kv">
      <div>Start Time</div><div>${escapeHtml(fmtStamp(it.startMs, tz))} (${escapeHtml(tzShort(tz, it.startMs))})</div>
      <div>End Time</div><div>${escapeHtml(fmtTime(it.endMs, tz))} (${escapeHtml(tzShort(tz, it.endMs))})</div>
      <div>Type</div><div>${KIND_LABEL[kind]}</div>
      ${it.program ? `<div>Series</div><div><button class="link" data-open-series>${escapeHtml(it.program.seriesTitle || it.program.title)}</button> ${icon("external", 13)}</div>` : ""}
      ${it.type === "video" ? `<div>Episode</div><div>${escapeHtml(it.raw.title || it.id)}</div>` : ""}
      ${url ? `<div>Source</div><div><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(src.provider || "source")} ${icon("external", 13)}</a></div>` : ""}
      <div>Duration</div><div>${fmtClock(it.durationSec)}</div>
      ${it.program ? `<div>Generated From</div><div><button class="link" data-open-block>${escapeHtml(it.program.blockId ? `Block: ${it.program.title}` : it.program.title)}</button> ${icon("external", 13)}<div class="dim" style="font-size:12px">${(() => { const b = this._channel()?.programming_blocks?.find((x) => x.id === it.program.blockId); return b ? `${escapeHtml(b.recurrence?.frequency || "")} · ${escapeHtml(b.recurrence?.time || "")} · ${b.packing?.enabled ? "packed" : "single episode"}` : ""; })()}</div></div>` : ""}
    </div>`;
  }

  async _loadAnnouncements() {
    try { this._announcements = await scheduleFileApi.announcements(this._chId); } catch { this._announcements = []; }
    if (this._tab === "continuity") this._renderInspector();
  }

  // ---------- compare ----------

  _compareSides() {
    if (this._cmpMode === "history") return this._prev ? { a: this._prev, b: this._pub, la: "Previous publish", lb: "Published (Live)", title: "Change History", sub: "What the last publish changed versus the schedule it replaced." } : null;
    return this._prop ? { a: this._pub, b: this._prop, la: "Published (Live)", lb: "Proposed (Preview)", title: "Schedule Changes (Preview)", sub: "Compare the published schedule with the proposed changes." } : null;
  }

  _cellHtml(side, tz) {
    if (!side) return `<span class="dim">— none —</span>`;
    return `<div class="cell">${thumbHtml(side.ep ? itemThumb(side.ep.raw) : "")}<div style="min-width:0"><b>${escapeHtml(side.p.seriesTitle || side.p.title)}</b><span>${escapeHtml(side.ep?.raw.title || "")}</span></div></div>`;
  }

  _renderCompare() {
    const panel = this.shadowRoot.querySelector(".cmp");
    const tz = this._tz();
    const sides = this._compareSides();
    const head = (title, sub, pills = "") => `<div class="cmp-head">${icon("swap", 24)}<div><h2>${title}</h2><p>${sub}</p></div><div class="pills">${pills}</div></div>`;
    const compiling = this._compiling;
    const foot = `<div class="cmp-foot">${icon("info", 17)} <span>No changes are applied until you publish the proposed schedule.</span><span class="spacer"></span>
      <button class="outline compile" ${compiling || !this._chId ? "disabled" : ""}>${icon("play", 15)} ${compiling ? "Compiling…" : "Compile Preview"}</button>
      <button class="primary publish" ${this._prop && !compiling ? "" : "disabled"} title="${this._prop ? "" : "Compile a preview first"}">${icon("cloudUp", 16)} Publish Schedule…</button></div>`;
    if (!sides) {
      const msg = this._cmpMode === "history"
        ? (this._prev === undefined ? "Loading previous publish…" : "There is no previous publish on record (schedule.json.bak) for this channel.")
        : "No proposed schedule yet. Compile a preview to see how the saved programming would change the live schedule.";
      panel.innerHTML = `${head(this._cmpMode === "history" ? "Change History" : "Schedule Changes (Preview)", this._cmpMode === "history" ? "Compare the previous publish with the live schedule." : "Compare the published schedule with the proposed changes.")}
        <div class="empty" style="padding:18px">${escapeHtml(msg)}</div>${foot}`;
    } else {
      const cmp = compareModels(sides.a, sides.b);
      const rows = cmp.rows.slice(0, 200);
      panel.innerHTML = `${head(sides.title, sides.sub, `<span class="pill" data-tone="accent">${cmp.rows.length} change${cmp.rows.length === 1 ? "" : "s"}</span><span class="pill">${cmp.unchanged} unchanged</span>`)}
        <div class="cmp-table">${rows.length ? `<table><thead><tr><th style="width:190px">Time</th><th>${sides.la}</th><th>${sides.lb}</th></tr></thead><tbody>
          ${rows.map((r) => `<tr class="${r.kind}"><td><span style="display:inline-flex;gap:9px;align-items:center">${icon(r.kind === "added" ? "plus" : r.kind === "removed" ? "x" : "swap", 15)}<span>${escapeHtml(fmtDayMD(r.t, tz))}<br><span class="dim">${escapeHtml(fmtTime(r.t, tz))} – ${escapeHtml(fmtTime((r.b || r.a).p.endMs, tz))}</span></span></span></td><td>${this._cellHtml(r.a, tz)}</td><td>${this._cellHtml(r.b, tz)}</td></tr>`).join("")}
        </tbody></table>` : `<div class="empty" style="padding:18px">No differences in the overlapping window (${escapeHtml(fmtMD(cmp.lo, tz))} – ${escapeHtml(fmtMD(cmp.hi - 1, tz))}).</div>`}</div>
        ${cmp.rows.length > rows.length ? `<div class="cmp-foot dim">Showing the first ${rows.length} of ${cmp.rows.length} changes.</div>` : ""}${foot}`;
    }
    panel.querySelector(".compile").addEventListener("click", () => this._compile());
    panel.querySelector(".publish").addEventListener("click", () => this._openPublish());
  }

  async _compile() {
    if (!this._chId || this._compiling) return;
    const tz = this._channelTz();
    const published = this._pub;
    const days = published ? Math.max(1, Math.round((published.windowEnd - published.windowStart) / DAY_MS)) : 14;
    const params = { days, window_start: ymd(Date.now(), tz), window_timezone: tz };
    this._compiling = true;
    this._renderCompare();
    try {
      const r = await channelAdminApi.previewSchedule(this._chId, params);
      if (r.exitCode !== 0 || !r.schedule) throw new Error((r.stderr || r.stdout || "Compile failed").trim().split("\n").slice(-3).join(" "));
      const meta = await scheduleFileApi.meta(this._chId).catch(() => ({}));
      this._prop = buildModel(r.schedule, Date.parse(r.schedule._publish?.window?.start || "") || Date.parse(meta.anchor || "") || published?.anchorMs || 0);
      this._propMeta = { at: Date.now(), params };
      this._cmpMode = "preview";
      const n = compareModels(this._pub, this._prop);
      toast(`Preview compiled: ${n.rows.length} change${n.rows.length === 1 ? "" : "s"}, ${n.unchanged} unchanged.`, "good");
    } catch (e) {
      toast(e.message, "danger");
    }
    this._compiling = false;
    this._renderLeft();
    this._renderCompare();
  }

  _openPublish() {
    if (!this._prop) return;
    const c = this._channel();
    const tz = this._tz();
    const n = compareModels(this._pub, this._prop);
    const p = this._propMeta.params;
    const dlg = this.shadowRoot.querySelector(".pub-dlg");
    dlg.style.width = "min(560px,94vw)";
    dlg.innerHTML = `
      <div class="dlg-head"><h2>Publish schedule — ${escapeHtml(c.name)}</h2><button class="icon close" aria-label="Close">${icon("x", 17)}</button></div>
      <div class="dlg-body">
        <p style="margin-top:0">This runs <code>channels/publish.php</code> for real and <b>overwrites the live <code>schedule.json</code></b> (the previous one is kept as <code>.bak</code>). Players pick up the new schedule on their next load.</p>
        <div class="kv">
          <div>Window</div><div>${escapeHtml(fmtMD(this._prop.windowStart, tz))} – ${escapeHtml(fmtMD(this._prop.windowEnd - 1, tz))} (${p.days} days from ${escapeHtml(p.window_start)}, ${escapeHtml(p.window_timezone)})</div>
          <div>Changes</div><div>${n.rows.length} changed program slot${n.rows.length === 1 ? "" : "s"}, ${n.unchanged} unchanged</div>
        </div>
        <div class="actions-row" style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button class="cancel">Cancel</button><button class="primary go">${icon("cloudUp", 16)} Publish now</button></div>
        <pre class="output hidden"></pre>
      </div>`;
    dlg.querySelector(".close").addEventListener("click", () => dlg.close());
    dlg.querySelector(".cancel").addEventListener("click", () => dlg.close());
    dlg.querySelector(".go").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const out = dlg.querySelector(".output");
      out.classList.remove("hidden");
      out.textContent = "Publishing…";
      try {
        const r = await channelAdminApi.publish(this._chId, { dry_run: false, days: p.days, window_start: p.window_start, window_timezone: p.window_timezone });
        out.textContent = `exit code: ${r.exitCode}\n\n${r.stdout.split("\n").slice(0, 12).join("\n")}${r.stderr ? `\n--- stderr ---\n${r.stderr.slice(0, 1500)}` : ""}`;
        if (r.exitCode === 0) {
          toast(`Published ${c.name}.`, "good");
          dlg.close();
          await this._loadChannel(this._chId);
        } else {
          toast("Publish reported an error -- see output.", "danger");
          btn.disabled = false;
        }
      } catch (err) {
        out.textContent = err.message;
        toast(err.message, "danger");
        btn.disabled = false;
      }
    });
    dlg.showModal();
  }
}

customElements.define("cf-broadcast-schedule", CfBroadcastSchedule);
