// cf-channel-admin — the PROGRAMMING tab: "Programming — Visual Grid".
//
// Edits a channel's recurring programming template (channels/<id>/
// programming.json) on a week grid, matching the ChannelFlow revamp mockups:
//
//   left   : channel picker + "Shows & Series" (the channel's catalog.json
//            series; + manages the catalog)
//   center : the weekly grid. Every block is drawn where its recurrence puts
//            it (daily -> every column, weekly -> its weekday, monthly -> the
//            day of month, for the week on screen)
//   right  : the selected block's editor (Block Settings / Content / Metadata)
//
// Same server contract as before (server/channel-admin.php): `save_catalog`
// rewrites the series refs, `save_programming` writes ALL of a channel's
// blocks at once, `publish` runs channels/publish.php (dry-run or real). Edits
// are local until "Save Changes". Unlike the old per-field form, a block is
// edited by overlaying fields onto the original object, so fields this UI has
// no control for (title, description, ...) survive a save.
//
// The AI continuity announcer (server/announcer-admin.php) and Publish live
// in dialogs opened from the "..." menu; their behaviour is unchanged.
//
// A block's recurrence supports ONE weekday (`weekly`) -- see
// channels/publish/src/Recurrence.php -- so the Days chips are exclusive in
// Weekly mode and all-on (disabled) in Daily mode.
//
// No access control: see docs/admin-ui.md. Anyone who can load this page
// can change channel programming and announcer config and trigger a real
// publish or a real `claude`+Kokoro generation run from here.

import { baseComponentCSS, escapeHtml, toast, appMediaUrl } from "../utils.js";
import { channelAdminApi, seriesAdminApi, announcerAdminApi } from "../admin-api.js";
import { TOPICS, publish, subscribe } from "../../../js/bus.js";
import { icon, uiKitCSS, thumbHtml, swatchStyle, wireMenus } from "./ui-kit.js";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PACKING_MODES = [["sequential", "Sequential (keep order)"], ["best_fit", "Best fit (minimize gaps)"], ["hybrid", "Hybrid (order, then fill)"]];
const ON_UNFIT_POLICIES = [["defer", "Defer to a bigger slot"], ["skip_for_block", "Skip for this block"], ["allow_overrun", "Allow overrun"]];
const BOUNDARY_MODES = [["hard", "Hard (never starts late)"], ["soft", "Soft (prefer to fit, may use filler)"], ["elastic", "Elastic (may start late)"]];
const DURATIONS = [900, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400];
const HOUR_PX = 46;

const ANNOUNCEMENT_TYPES = ["coming_up_next", "now_showing", "still_ahead", "channel_id", "lineup_preview", "return_from_break"];
const SUPPRESS_MODES = ["short", "suppress", "normal"];
const WRITER_PROVIDERS = ["claude-cli", "template", "mock"];

// ---------- Continuity announcer section ----------

const DEFAULT_ANNOUNCER_CONFIG = {
  enabled: false,
  voice: "af_heart",
  speed: 1.0,
  language: "en-us",
  style: "Clear, friendly broadcast announcer",
  tone: "Neutral, warm, professional",
  targetDuration: 12,
  types: ["coming_up_next"],
  consecutiveSameSeries: "short",
  writer: { provider: "claude-cli", model: "sonnet" },
  tts: { provider: "kokoro-http", endpoint: "http://127.0.0.1:8178" },
};

function announcerRowHtml(entry) {
  const statusPill = entry.status === "ready" ? "" : " muted";
  return `
    <div class="an-row" data-transition="${escapeHtml(entry.transitionId || "")}" data-hash="${escapeHtml(entry.scriptHash || "")}">
      <div class="an-row-top">
        <span class="pill${statusPill}">${escapeHtml(entry.type || "")}</span>
        <span class="muted">${escapeHtml(entry.transitionId || "")}</span>
        <span class="muted">${entry.duration ? `${Number(entry.duration).toFixed(1)}s` : ""}</span>
        <span class="muted">${escapeHtml(entry.status || "unknown")}</span>
        <span class="spacer"></span>
        <button class="an-edit-btn ghost" data-hash="${escapeHtml(entry.scriptHash || "")}">Edit</button>
        <button class="an-regen-btn ghost" data-transition="${escapeHtml(entry.transitionId || "")}">Regenerate</button>
      </div>
      <div class="an-row-text">${escapeHtml(entry.text || "")}</div>
      ${entry.audio ? `<audio controls preload="none" src="${escapeHtml(appMediaUrl(entry.audio))}"></audio>` : `<span class="muted">No audio yet.</span>`}
    </div>
  `;
}

function announcerSectionHtml(channelId, announcer) {
  const hasJson = !!announcer?.hasAnnouncerJson;
  const cfg = { ...DEFAULT_ANNOUNCER_CONFIG, ...(announcer?.config || {}) };
  const writer = { ...DEFAULT_ANNOUNCER_CONFIG.writer, ...(cfg.writer || {}) };
  const types = Array.isArray(cfg.types) && cfg.types.length ? cfg.types : DEFAULT_ANNOUNCER_CONFIG.types;
  const announcements = Array.isArray(announcer?.announcements) ? announcer.announcements : [];
  const queue = announcer?.queue || { pending: 0, running: 0, done: 0, error: 0 };
  const queueBusy = queue.pending > 0 || queue.running > 0;

  return `
    <section class="announcer-section" data-channel="${escapeHtml(channelId)}">
      <h2>Continuity announcer</h2>
      ${!hasJson ? `<p class="hint-note">Not configured yet for this channel -- nothing is generated until you save a config below (the single opt-in gate).</p>` : ""}
      <div class="block-grid">
        <label class="field"><div class="field-value"><label class="loop-label"><input type="checkbox" class="an-enabled" ${cfg.enabled ? "checked" : ""}> Enabled</label></div></label>
        <label class="field">Voice<div class="field-value"><input class="an-voice" value="${escapeHtml(cfg.voice)}" list="an-voices-${escapeHtml(channelId)}"><datalist id="an-voices-${escapeHtml(channelId)}"></datalist></div></label>
        <label class="field">Speed<div class="field-value"><input class="an-speed" type="number" step="0.1" min="0.5" max="2.0" value="${cfg.speed}"></div></label>
        <label class="field">Language<div class="field-value"><input class="an-language" value="${escapeHtml(cfg.language)}"></div></label>
        <label class="field">Target duration (s)<div class="field-value"><input class="an-duration" type="number" min="5" max="60" value="${cfg.targetDuration}"></div></label>
        <label class="field">Consecutive same-series<div class="field-value"><select class="an-suppress">
          ${SUPPRESS_MODES.map((m) => `<option value="${m}" ${m === cfg.consecutiveSameSeries ? "selected" : ""}>${m}</option>`).join("")}
        </select></div></label>
        <label class="field">Writer provider<div class="field-value"><select class="an-writer-provider">
          ${WRITER_PROVIDERS.map((p) => `<option value="${p}" ${p === writer.provider ? "selected" : ""}>${p}</option>`).join("")}
        </select></div></label>
        <label class="field">Writer model<div class="field-value"><input class="an-writer-model" value="${escapeHtml(writer.model || "")}"></div></label>
      </div>
      <label class="field">Style<div class="field-value"><input class="an-style" value="${escapeHtml(cfg.style)}"></div></label>
      <label class="field">Tone<div class="field-value"><input class="an-tone" value="${escapeHtml(cfg.tone)}"></div></label>
      <div class="field">Announcement types<div class="field-value">
        <div class="series-checklist">
          ${ANNOUNCEMENT_TYPES.map((t) => `
            <label class="series-check"><input type="checkbox" class="an-type-input" value="${t}" ${types.includes(t) ? "checked" : ""}> ${t}</label>
          `).join("")}
        </div>
      </div></div>
      <div class="row an-toolbar" style="gap:8px; flex-wrap:wrap; align-items:center;">
        <button class="an-voices-btn ghost">Load voices from Kokoro</button>
        <button class="an-preview-btn ghost">Preview voice</button>
        <button class="an-save-btn primary">Save announcer config</button>
        <button class="an-generate-btn" ${hasJson ? "" : "disabled"}>Generate missing (queue)</button>
        <span class="pill ${queueBusy ? "" : "muted"}">queue: ${queue.pending} pending · ${queue.running} running · ${queue.error} error</span>
      </div>
      <audio class="an-preview-audio" controls hidden></audio>
      <pre class="an-output hidden"></pre>

      <h2 style="margin-top:16px;">Announcements (${announcements.length})</h2>
      <div class="an-list">
        ${announcements.map(announcerRowHtml).join("") || `<span class="muted">No announcements generated yet.</span>`}
      </div>
    </section>
  `;
}

// ---------- time helpers ----------

const pad2 = (n) => String(n).padStart(2, "0");

function parseHM(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** "13:05" -> "1:05 PM"; withSuffix=false -> "1:05". */
function fmt12(min, withSuffix = true) {
  const m = ((min % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const h = h24 % 12 || 12;
  return `${h}:${pad2(m % 60)}${withSuffix ? (h24 < 12 ? " AM" : " PM") : ""}`;
}

function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"}`;
  if (m > 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m} min`;
}

function fmtShort(sec) {
  const m = Math.round(sec / 60);
  return m % 60 === 0 ? `${m / 60}h` : m > 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
}

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthDay = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;

function tzLabel(tz) {
  try {
    const short = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value;
    return short ? `${tz} (${short})` : tz;
  } catch { return tz; }
}

/** Which weekday columns (0=Mon..6=Sun) a block airs on, for the displayed week's dates. */
function blockDays(block, weekDates) {
  const rec = block.recurrence || {};
  if (rec.frequency === "weekly") {
    const i = WEEKDAYS.indexOf(String(rec.weekday || "").toLowerCase());
    return i >= 0 ? [i] : [];
  }
  if (rec.frequency === "monthly") {
    const dom = Number(rec.day_of_month) || 1;
    return weekDates.map((d, i) => (d.getDate() === dom ? i : -1)).filter((i) => i >= 0);
  }
  return [0, 1, 2, 3, 4, 5, 6];
}

function recurrenceSummary(block) {
  const rec = block.recurrence || {};
  if (rec.frequency === "weekly") return `${DAY_ABBR[Math.max(0, WEEKDAYS.indexOf(String(rec.weekday || "").toLowerCase()))]} (weekly)`;
  if (rec.frequency === "monthly") return `Day ${rec.day_of_month || 1} (monthly)`;
  return "Mon – Sun (daily)";
}

let uidSeq = 0;
const stripLocal = (b) => { const { _uid, _new, ...rest } = b; return rest; };

function blankBlock(seriesId, seriesTitle, weekdayIdx, startMin, tz) {
  const idBase = String(seriesId || "block").replace(/[^a-z0-9-]/g, "-");
  return {
    _uid: ++uidSeq, _new: true,
    id: `${idBase}-${Math.random().toString(36).slice(2, 6)}`,
    title: seriesTitle || "",
    type: "series",
    series_id: seriesId || "",
    recurrence: weekdayIdx == null
      ? { frequency: "daily", time: `${pad2(Math.floor(startMin / 60))}:${pad2(startMin % 60)}`, timezone: tz }
      : { frequency: "weekly", weekday: WEEKDAYS[weekdayIdx], time: `${pad2(Math.floor(startMin / 60))}:${pad2(startMin % 60)}`, timezone: tz },
    duration: 3600,
    rotation: { mode: "sequential", loop: true, anchor_date: new Date().toISOString().slice(0, 10) },
    boundary: { mode: "hard" },
  };
}

class CfChannelAdmin extends HTMLElement {
  constructor() {
    super();
    this._channels = [];
    this._series = []; // full series-admin list (id,title,thumbnail_url,episode_count,episodes[])
    this._seriesById = new Map();
    this._loading = true;
    this._error = null;
    this._chId = null;
    this._blocks = []; // working copy (with _uid/_new)
    this._saved = new Map(); // _uid -> JSON string of the last-saved block
    this._selUid = null;
    this._tab = "settings";
    this._weekOffset = 0;
    this._chip = "all";
    this._showSearch = "";
    this._focusSeries = null;
    // Fetched independently of channels: an announcer failure never blocks programming.
    this._announcer = new Map();
    this._announcerError = null;
  }

  connectedCallback() {
    this._ctl = new AbortController();
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._render();
    }
    // Explorer hand-off: reveal a channel (and programming block). Pure navigation.
    subscribe(TOPICS.PROGRAMMING_CHANNEL_OPEN, ({ data }) => {
      if (typeof data?.channelId !== "string") return;
      this._pendingFocus = { channelId: data.channelId, blockId: typeof data.blockId === "string" ? data.blockId : null };
      this._applyFocus();
    }, { signal: this._ctl.signal });
    if (!this._channels.length) this.reload();
  }

  disconnectedCallback() { this._ctl?.abort(); }

  _applyFocus() {
    const f = this._pendingFocus;
    if (!f || !this._channels.length) return;
    const c = this._channels.find((x) => x.id === f.channelId);
    if (!c) return;
    this._pendingFocus = null;
    if (c.id !== this._chId) this._loadChannel(c.id);
    const b = f.blockId ? this._blocks.find((x) => x.id === f.blockId) : null;
    if (b) { this._selUid = b._uid; this._tab = "settings"; }
    this._renderAll();
    this._scrollToSelected();
  }

  async reload() {
    this._loading = true;
    this._error = null;
    this._renderAll();
    try {
      const [channels, series] = await Promise.all([channelAdminApi.list(), seriesAdminApi.list()]);
      this._channels = channels;
      this._series = series;
      this._seriesById = new Map(series.map((s) => [s.id, s]));
      const keep = this._chId && channels.some((c) => c.id === this._chId) ? this._chId : (channels.find((c) => c.programming_blocks.length) || channels[0])?.id;
      const prevId = this._blocks.find((b) => b._uid === this._selUid)?.id;
      if (keep) this._loadChannel(keep, prevId);
    } catch (e) {
      this._error = e.message;
    }
    this._loading = false;
    this._renderAll();
    this._scrollToSelected();
    this._applyFocus();
    this._reloadAnnouncer();
  }

  async _reloadAnnouncer() {
    this._announcerError = null;
    try {
      const list = await announcerAdminApi.list();
      this._announcer = new Map(list.map((a) => [a.id, a]));
    } catch (e) {
      this._announcerError = e.message;
    }
    const dlg = this.shadowRoot.querySelector(".announcer-dlg");
    if (dlg?.open) this._renderAnnouncerDialog();
  }

  _channel() { return this._channels.find((c) => c.id === this._chId) || null; }
  _sel() { return this._blocks.find((b) => b._uid === this._selUid) || null; }
  _isDirty(b) { return b._new || this._saved.get(b._uid) !== JSON.stringify(stripLocal(b)); }
  _anyDirty() {
    const c = this._channel();
    if (!c) return false;
    const live = new Set(this._blocks.map((b) => b._uid));
    return this._blocks.some((b) => this._isDirty(b)) || [...this._saved.keys()].some((u) => !live.has(u));
  }

  _loadChannel(id, prevBlockId = null) {
    const c = this._channels.find((x) => x.id === id);
    this._chId = id;
    this._blocks = (c?.programming_blocks || []).map((b) => ({ ...JSON.parse(JSON.stringify(b)), _uid: ++uidSeq }));
    this._saved = new Map(this._blocks.map((b) => [b._uid, JSON.stringify(stripLocal(b))]));
    const keep = prevBlockId ? this._blocks.find((b) => b.id === prevBlockId) : null;
    this._selUid = (keep || this._blocks[0])?._uid ?? null;
    this._focusSeries = null;
    this._weekOffset = 0;
  }

  _weekDates() {
    const mon = mondayOf(new Date());
    mon.setDate(mon.getDate() + this._weekOffset * 7);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
  }

  _catalogSeries() {
    const c = this._channel();
    if (!c) return [];
    return c.series_refs.map((r) => r.series_id).filter(Boolean).map((id) => this._seriesById.get(id) || { id, title: id, episode_count: 0, episodes: [], missing: true });
  }

  _seriesTitle(id) { return this._seriesById.get(id)?.title || id || "Untitled"; }

  // ---------- skeleton ----------

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        ${uiKitCSS}
        .workspace{ grid-template-columns:340px minmax(0,1fr) 470px; }
        .field-label{ font-size:13px; font-weight:600; margin:0 0 6px; display:block; }
        .left-top{ padding:14px 16px 12px; }
        .left-top .field-label{ color:var(--text); }
        .ch-select{ position:relative; }
        .ch-select .lead{ position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--text-muted); pointer-events:none; display:flex; }
        .ch-select select{ padding:10px 30px 10px 38px; font-weight:600; }
        .shows-head{ display:flex; align-items:center; gap:8px; padding:6px 16px 10px; border-top:1px solid var(--border-soft); padding-top:14px; }
        .shows-head h2{ margin:0; font-size:20px; font-weight:750; flex:1; letter-spacing:-.01em; }
        .shows-tools{ padding:0 16px 12px; display:flex; flex-direction:column; gap:10px; }
        .show{ display:flex; align-items:center; gap:12px; padding:9px 10px; margin:2px 8px; border-radius:11px; cursor:pointer; border:1px solid transparent; }
        .show:hover{ background:rgba(74,127,216,.07); }
        .show.on{ background:rgba(74,127,216,.2); border-color:var(--accent-line); }
        .show .thumb{ width:64px; height:44px; }
        .show .meta{ flex:1; min-width:0; }
        .show .t{ font-weight:650; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .show .s{ font-size:12.5px; color:var(--text-muted); margin-bottom:3px; }
        .show .pill{ font-size:11px; padding:1px 8px; }
        .show .icon{ background:transparent; border:0; width:28px; height:28px; color:var(--text-muted); }
        .show .menu{ align-self:flex-start; }

        .grid-head{ display:flex; align-items:center; gap:12px; padding:14px 16px; }
        .ch-ico{ width:42px; height:42px; border-radius:11px; display:grid; place-items:center; background:var(--panel-3); color:var(--text-muted); border:1px solid var(--border); }
        .grid-head h2{ margin:0; font-size:20px; font-weight:750; }
        .grid-head .sub{ color:var(--text-muted); font-size:12.5px; }
        .grid-head .week{ display:flex; align-items:center; gap:8px; margin-left:auto; }
        .week .cur{ min-width:128px; background:var(--panel-2); border:1px solid var(--border); }
        .unsaved{ font-size:12px; color:#f6c27d; display:flex; align-items:center; gap:6px; white-space:nowrap; margin-left:auto; }
        .unsaved + .week{ margin-left:0; }
        .grid-head > div:nth-child(2){ min-width:0; }
        .grid-scroll{ flex:1; min-height:0; overflow:auto; position:relative; border-top:1px solid var(--border-soft); }
        .grid{ display:grid; grid-template-columns:64px repeat(7, minmax(92px,1fr)); min-width:760px; }
        .grid .corner,.grid .dayhead{ position:sticky; top:0; z-index:4; background:linear-gradient(180deg,#171c38,#141933); height:50px; display:flex; flex-direction:column; align-items:center; justify-content:center; border-bottom:1px solid var(--border); font-size:12px; color:var(--text-muted); border-left:1px solid var(--border-soft); }
        .grid .dayhead b{ color:var(--text); font-size:13px; letter-spacing:.04em; }
        .grid .dayhead.today b{ color:var(--accent-hi); }
        .grid .corner{ border-left:0; }
        .times{ position:relative; }
        .times span{ position:absolute; right:10px; transform:translateY(-50%); font-size:11.5px; color:var(--text-muted); white-space:nowrap; }
        .daycol{ position:relative; border-left:1px solid var(--border-soft); cursor:cell;
          background-image:repeating-linear-gradient(to bottom, transparent 0, transparent calc(${HOUR_PX}px - 1px), rgba(255,255,255,.045) calc(${HOUR_PX}px - 1px), rgba(255,255,255,.045) ${HOUR_PX}px); }
        .blk{ position:absolute; border:1px solid; border-radius:8px; padding:3px 6px; overflow:hidden; cursor:pointer; text-align:center; line-height:1.18;
          display:flex; flex-direction:column; justify-content:center; box-shadow:0 1px 0 rgba(255,255,255,.06) inset; }
        .blk b{ font-size:12.5px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .blk span{ font-size:11.5px; opacity:.9; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .blk.sel{ outline:2px solid #fff; outline-offset:-1px; box-shadow:0 0 0 3px rgba(111,155,232,.55); z-index:3; }
        .blk.dim{ opacity:.28; }
        .blk.dirty::after{ content:""; position:absolute; top:4px; right:4px; width:7px; height:7px; border-radius:50%; background:#facc15; }
        .nowline{ position:absolute; left:0; right:0; height:2px; background:var(--live); z-index:2; pointer-events:none; }

        .editor-head{ padding:14px 16px 10px; }
        .editor-head h2{ margin:0; font-size:17px; }
        .blk-card{ display:flex; gap:14px; align-items:center; margin:0 14px 12px; padding:10px; border:1px solid var(--border); border-radius:12px; background:rgba(10,13,28,.45); }
        .blk-card .thumb{ width:116px; height:68px; border-radius:9px; }
        .blk-card .nm{ font-size:16px; font-weight:700; }
        .blk-card .tm{ font-size:13px; color:var(--text-muted); margin-top:2px; }
        .blk-card .open{ margin-left:auto; align-self:flex-start; background:transparent; border:0; color:var(--text-muted); padding:4px; }
        .editor-tabs{ margin:0 14px 10px; }
        .tabs.editor-tabs button{ white-space:nowrap; padding:7px 6px; min-width:0; }
        .frow .inline > input[type=time]{ flex:0 0 132px; }
        .editor-body{ flex:1; min-height:0; overflow:auto; padding:0 14px 10px; }
        .sect{ border:1px solid var(--border); border-radius:12px; margin-bottom:10px; background:rgba(10,13,28,.35); }
        .sect > h3{ margin:0; display:flex; align-items:center; gap:9px; padding:11px 14px; font-size:14.5px; font-weight:700; }
        .sect > h3 svg{ color:var(--text-muted); }
        .sect .rows{ padding:0 14px 12px; display:flex; flex-direction:column; gap:10px; }
        .frow{ display:grid; grid-template-columns:118px 1fr; gap:10px; align-items:center; }
        .frow > label{ font-size:13px; color:var(--text-muted); }
        .frow .inline{ display:flex; gap:10px; align-items:center; }
        .frow .inline > *{ flex:1; min-width:0; }
        .days{ display:flex; gap:6px; flex-wrap:wrap; }
        .daychip{ display:flex; align-items:center; gap:5px; font-size:12px; color:var(--text); cursor:pointer; }
        .daychip input{ width:15px; height:15px; }
        .daychip.off{ opacity:.6; cursor:default; }
        .check{ display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer; }
        .hint-note{ font-size:11.5px; color:var(--text-muted); margin:2px 0 0; line-height:1.5; }
        .editor-foot{ display:flex; gap:6px; padding:12px 10px 14px; border-top:1px solid var(--border-soft); }
        .editor-foot .spacer{ flex:1; }
        .editor-foot button{ padding:8px 9px; font-size:12px; white-space:nowrap; gap:5px; }
        .editor-foot .save{ flex:0 0 auto; }
        .content-grid{ display:flex; flex-direction:column; gap:10px; padding:2px 0; }
        .ep-mini{ display:flex; gap:10px; align-items:center; padding:6px 0; border-bottom:1px solid var(--border-soft); font-size:12.5px; }
        .ep-mini .thumb{ width:64px; height:36px; border-radius:6px; }

        /* announcer + catalog dialogs reuse the old building blocks */
        .block-grid{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px 14px; align-items:end; }
        .block-grid label.field{ margin-bottom:0; }
        .loop-label{ display:flex; align-items:center; gap:6px; font-size:12px; text-transform:none; letter-spacing:0; color:var(--text); }
        .series-checklist{ display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
        .series-check{ display:flex; align-items:center; gap:6px; background:var(--panel-2); border:1px solid var(--border); border-radius:999px; padding:5px 10px; font-size:12px; }
        .pill.muted{ background:var(--panel-2); color:var(--text-muted); }
        .warn-note{ font-size:12px; color:var(--warn); }
        .announcer-section h2{ font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); margin:0 0 10px; }
        .an-output{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px; font:11px/1.5 var(--mono); white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; margin-top:10px; }
        .an-preview-audio{ margin-top:8px; display:block; width:100%; max-width:360px; }
        .an-preview-audio[hidden]{ display:none; }
        .an-list{ display:flex; flex-direction:column; gap:8px; margin-top:8px; }
        .an-row{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px 12px; }
        .an-row-top{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .an-row-top .spacer{ flex:1; }
        .an-row-text{ font-size:13px; margin:8px 0; line-height:1.4; }
        .an-row-text textarea{ width:100%; font:inherit; min-height:60px; }
        .an-row audio{ width:100%; max-width:420px; display:block; }
        .cat-list{ max-height:50vh; overflow:auto; display:flex; flex-direction:column; gap:4px; margin:10px 0; }
        .cat-item{ display:flex; align-items:center; gap:10px; padding:6px 8px; border-radius:9px; cursor:pointer; }
        .cat-item:hover{ background:var(--panel-3); }
        .cat-item .thumb{ width:48px; height:32px; border-radius:6px; }
        .pub-row{ display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
        .pub-row label.field{ margin:0; }
        .actions-row{ display:flex; gap:8px; margin-top:14px; }
      </style>
      <div class="page-head">
        <div class="head-ico">${icon("calendar", 32)}</div>
        <div><h1>Programming — Visual Grid</h1><p>Create and manage recurring programming for each channel.</p></div>
      </div>
      <div class="workspace">
        <section class="panel left"></section>
        <section class="panel center"></section>
        <section class="panel editor"></section>
      </div>
      <dialog class="catalog-dlg"></dialog>
      <dialog class="publish-dlg"></dialog>
      <dialog class="announcer-dlg" style="width:min(860px,95vw)"></dialog>
    `;
  }

  _renderAll() {
    this._renderLeft();
    this._renderCenter();
    this._renderEditor();
  }

  // ---------- left: channel + shows ----------

  _renderLeft() {
    const left = this.shadowRoot.querySelector(".left");
    if (this._loading) { left.innerHTML = `<div class="empty">Loading…</div>`; return; }
    if (this._error) { left.innerHTML = `<div class="error">Could not load channels: ${escapeHtml(this._error)}</div>`; return; }
    if (!this._channels.length) { left.innerHTML = `<div class="empty">No channels found under channels/*/meta.json yet.</div>`; return; }
    const c = this._channel();
    const usedSeries = new Set(this._blocks.map((b) => b.series_id));
    const all = this._catalogSeries();
    const q = this._showSearch.trim().toLowerCase();
    const cnt = (s) => { const r = { approved: 0, candidate: 0 }; for (const e of s.episodes || []) if (e.status in r) r[e.status]++; return r; };
    const shown = all.filter((s) => {
      const k = cnt(s);
      if (this._chip === "scheduled" && !usedSeries.has(s.id)) return false;
      if (this._chip === "approved" && !k.approved) return false;
      if (this._chip === "candidate" && !k.candidate) return false;
      return !q || s.title.toLowerCase().includes(q);
    });
    const totalEps = all.reduce((n, s) => n + (s.episode_count || 0), 0);
    left.innerHTML = `
      <div class="left-top">
        <label class="field-label">Channel</label>
        <div class="ch-select"><span class="lead">${icon("calendar", 17)}</span>
          <select class="ch-pick">${this._channels.map((x) => `<option value="${escapeHtml(x.id)}" ${x.id === this._chId ? "selected" : ""}>${escapeHtml(x.name)}</option>`).join("")}</select>
        </div>
      </div>
      <div class="shows-head"><h2>Shows &amp; Series</h2><button class="icon add-series" title="Manage channel catalog" aria-label="Manage channel catalog">${icon("plus", 18)}</button></div>
      <div class="shows-tools">
        <div class="search">${icon("search", 17)}<input class="show-search" placeholder="Search shows..." value="${escapeHtml(this._showSearch)}"></div>
        <div class="chip-row">${[["all", "All"], ["scheduled", "Scheduled"], ["approved", "Approved"], ["candidate", "Candidate"]].map(([k, l]) => `<button class="chip ${this._chip === k ? "on" : ""}" data-chip="${k}">${l}</button>`).join("")}</div>
      </div>
      <div class="panel-body shows-list">
        ${shown.map((s) => {
          const k = cnt(s);
          return `<div class="show ${this._focusSeries === s.id ? "on" : ""}" data-id="${escapeHtml(s.id)}">
            ${thumbHtml(s.thumbnail_url)}
            <div class="meta"><div class="t">${escapeHtml(s.title)}</div><div class="s">${s.episode_count || 0} episodes</div>
              ${s.missing ? `<span class="pill" data-tone="bad">${icon("alert", 12)} Missing</span>`
                : k.approved ? `<span class="pill" data-tone="approved">${icon("check", 12)} Approved</span>`
                : `<span class="pill" data-tone="candidate">${icon("alert", 12)} Candidate</span>`}
            </div>
            <div class="menu"><button class="icon" aria-label="Show actions">${icon("more", 18)}</button>
              <div class="menu-pop"><button data-act="add-block">${icon("plus", 15)} Add block</button><button data-act="remove">${icon("trash", 15)} Remove from catalog</button></div></div>
          </div>`;
        }).join("") || `<div class="empty">${all.length ? "No shows match." : "This channel's catalog is empty. Use + to add series."}</div>`}
      </div>
      <div class="panel-foot" style="color:var(--text-muted);font-size:13px">${all.length} series • ${totalEps} episodes</div>`;
    const root = this.shadowRoot;
    left.querySelector(".ch-pick").addEventListener("change", (e) => {
      if (this._anyDirty() && !confirm("Discard unsaved programming changes for this channel?")) { e.target.value = this._chId; return; }
      this._loadChannel(e.target.value);
      this._renderAll();
      this._scrollToSelected();
    });
    left.querySelector(".show-search").addEventListener("input", (e) => { this._showSearch = e.target.value; const pos = e.target.selectionStart; this._renderLeft(); const i = root.querySelector(".show-search"); i.focus(); i.setSelectionRange(pos, pos); });
    left.querySelector(".chip-row").addEventListener("click", (e) => { const b = e.target.closest("[data-chip]"); if (b) { this._chip = b.dataset.chip; this._renderLeft(); } });
    left.querySelector(".add-series").addEventListener("click", () => this._openCatalog());
    wireMenus(left, this._ctl.signal);
    left.querySelector(".shows-list").addEventListener("click", (e) => {
      const row = e.target.closest(".show");
      if (!row) return;
      const id = row.dataset.id;
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "add-block") { this._addBlock(id); return; }
      if (act === "remove") { this._removeFromCatalog(id); return; }
      if (e.target.closest(".menu")) return;
      this._focusSeries = this._focusSeries === id ? null : id;
      this._renderLeft();
      this._renderGrid();
    });
  }

  // ---------- center: grid ----------

  _renderCenter() {
    const center = this.shadowRoot.querySelector(".center");
    const c = this._channel();
    if (!c) { center.innerHTML = `<div class="empty">${this._loading ? "Loading…" : "No channel selected."}</div>`; return; }
    const dates = this._weekDates();
    const tz = this._blocks[0]?.recurrence?.timezone || "UTC";
    center.innerHTML = `
      <div class="grid-head">
        <div class="ch-ico">${icon("calendar", 22)}</div>
        <div><h2>${escapeHtml(c.name)}</h2><div class="sub">Weekly programming template • ${escapeHtml(tzLabel(tz))}</div></div>
        <span class="unsaved hidden">${icon("alert", 14)} Unsaved changes</span>
        <div class="week">
          <button class="icon prev-week" aria-label="Previous week">${icon("left", 17)}</button>
          <button class="cur this-week">${icon("calendar", 15)} <span>${this._weekOffset === 0 ? "This Week" : `${monthDay(dates[0])} – ${monthDay(dates[6])}`}</span></button>
          <button class="icon next-week" aria-label="Next week">${icon("right", 17)}</button>
          <div class="menu grid-menu"><button class="icon" aria-label="More">${icon("more", 18)}</button>
            <div class="menu-pop">
              <button data-act="add">${icon("plus", 15)} Add block</button>
              <button data-act="publish">${icon("cloudUp", 15)} Preview &amp; publish…</button>
              <button data-act="announcer">${icon("megaphone", 15)} Continuity announcer…</button>
              <hr>
              <button data-act="discard">${icon("undo", 15)} Discard unsaved changes</button>
              <button data-act="reload">${icon("repeat", 15)} Reload from server</button>
            </div></div>
        </div>
      </div>
      <div class="grid-scroll"></div>`;
    center.querySelector(".prev-week").addEventListener("click", () => { this._weekOffset--; this._renderCenter(); });
    center.querySelector(".next-week").addEventListener("click", () => { this._weekOffset++; this._renderCenter(); });
    center.querySelector(".this-week").addEventListener("click", () => { this._weekOffset = 0; this._renderCenter(); });
    wireMenus(center, this._ctl.signal);
    center.querySelector(".grid-menu .menu-pop").addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "add") this._addBlock(this._focusSeries || this._sel()?.series_id || this._catalogSeries()[0]?.id);
      if (act === "publish") this._openPublish();
      if (act === "announcer") this._openAnnouncer();
      if (act === "discard") { if (this._anyDirty() && confirm("Discard all unsaved programming changes?")) { this._loadChannel(this._chId, this._sel()?.id); this._renderAll(); } }
      if (act === "reload") this.reload();
    });
    this._renderGrid();
  }

  _renderGrid() {
    const scroll = this.shadowRoot.querySelector(".grid-scroll");
    if (!scroll) return;
    const prevTop = scroll.scrollTop;
    const dates = this._weekDates();
    const todayStr = new Date().toDateString();
    const colBlocks = Array.from({ length: 7 }, () => []);
    for (const b of this._blocks) for (const d of blockDays(b, dates)) colBlocks[d].push(b);

    const cols = colBlocks.map((list, d) => {
      const items = list.map((b) => ({ b, s: parseHM(b.recurrence?.time), e: Math.min(1440, parseHM(b.recurrence?.time) + Math.max(5, Math.round((b.duration || 1800) / 60))) }))
        .sort((x, y) => x.s - y.s || y.e - x.e);
      // Greedy lane assignment so overlapping blocks sit side by side.
      const laneEnd = [];
      for (const it of items) {
        let l = laneEnd.findIndex((end) => end <= it.s);
        if (l < 0) { l = laneEnd.length; laneEnd.push(0); }
        laneEnd[l] = it.e; it.lane = l;
      }
      // lanes in each overlap cluster
      for (const it of items) {
        const overlapping = items.filter((o) => o.s < it.e && o.e > it.s);
        it.lanes = Math.max(...overlapping.map((o) => o.lane)) + 1;
      }
      return items.map((it) => {
        const b = it.b;
        const top = (it.s / 60) * HOUR_PX, h = Math.max(20, ((it.e - it.s) / 60) * HOUR_PX - 2);
        const w = 100 / it.lanes;
        const title = b.title || this._seriesTitle(b.series_id);
        const dim = this._focusSeries && b.series_id !== this._focusSeries;
        const label = `${fmt12(parseHM(b.recurrence?.time), false)} – ${fmt12(parseHM(b.recurrence?.time) + Math.round((b.duration || 0) / 60), false)}`;
        return `<div class="blk ${b._uid === this._selUid ? "sel" : ""} ${dim ? "dim" : ""} ${this._isDirty(b) ? "dirty" : ""}" data-uid="${b._uid}"
          style="${swatchStyle(b.series_id)};top:${top + 1}px;height:${h}px;left:calc(${it.lane * w}% + 2px);width:calc(${w}% - 4px)" title="${escapeHtml(title)} · ${escapeHtml(label)}">
          <b>${escapeHtml(title)}</b>${h >= 34 ? `<span>${label}</span>` : ""}</div>`;
      }).join("");
    });

    scroll.innerHTML = `
      <div class="grid">
        <div class="corner"></div>
        ${dates.map((d, i) => `<div class="dayhead ${d.toDateString() === todayStr ? "today" : ""}"><b>${DAY_ABBR[i].toUpperCase()}</b><span>${monthDay(d)}</span></div>`).join("")}
        <div class="times" style="height:${24 * HOUR_PX}px">${Array.from({ length: 24 }, (_, h) => h ? `<span style="top:${h * HOUR_PX}px">${fmt12(h * 60)}</span>` : "").join("")}</div>
        ${cols.map((html, i) => `<div class="daycol" data-day="${i}" style="height:${24 * HOUR_PX}px">${html}${dates[i].toDateString() === todayStr ? `<div class="nowline" style="top:${(new Date().getHours() * 60 + new Date().getMinutes()) / 60 * HOUR_PX}px"></div>` : ""}</div>`).join("")}
      </div>`;
    scroll.scrollTop = prevTop;
    scroll.querySelectorAll(".daycol").forEach((col) => col.addEventListener("click", (e) => {
      const blk = e.target.closest(".blk");
      if (blk) { this._selUid = Number(blk.dataset.uid); this._renderGrid(); this._renderEditor(); return; }
      const rect = col.getBoundingClientRect();
      const min = Math.max(0, Math.min(1380, Math.floor(((e.clientY - rect.top) / HOUR_PX) * 4) * 15));
      const sid = this._focusSeries || this._sel()?.series_id || this._catalogSeries()[0]?.id;
      if (!sid) { toast("Add a series to this channel's catalog first (+ in Shows & Series).", "warn"); return; }
      this._addBlock(sid, Number(col.dataset.day), min);
    }));
  }

  _scrollToSelected() {
    const scroll = this.shadowRoot.querySelector(".grid-scroll");
    if (!scroll) return;
    const b = this._sel() || this._blocks[0];
    const min = b ? parseHM(b.recurrence?.time) : 8 * 60;
    scroll.scrollTop = Math.max(0, (min / 60) * HOUR_PX - 90);
  }

  // ---------- right: block editor ----------

  _renderEditor() {
    const panel = this.shadowRoot.querySelector(".editor");
    const b = this._sel();
    const c = this._channel();
    const unsaved = this.shadowRoot.querySelector(".unsaved");
    unsaved?.classList.toggle("hidden", !this._anyDirty());
    if (!c) { panel.innerHTML = ""; return; }
    if (!b) {
      panel.innerHTML = `<div class="panel-head"><h2>${icon("calendar", 18)} Programming Block</h2></div>
        <div class="empty">${this._blocks.length ? "Select a block in the grid to edit it." : "This channel has no programming yet."}<br><br>
        <button class="primary add-first">${icon("plus", 15)} Add a block</button></div>`;
      panel.querySelector(".add-first")?.addEventListener("click", () => this._addBlock(this._focusSeries || this._catalogSeries()[0]?.id));
      return;
    }
    const s = this._seriesById.get(b.series_id);
    const startMin = parseHM(b.recurrence?.time);
    const endMin = startMin + Math.round((b.duration || 0) / 60);
    panel.innerHTML = `
      <div class="panel-head editor-head"><h2>${icon("calendar", 18)} Programming Block</h2></div>
      <div class="blk-card">
        ${thumbHtml(s?.thumbnail_url)}
        <div><div class="nm">${escapeHtml(b.title || this._seriesTitle(b.series_id))}</div>
          <div class="tm">${fmt12(startMin)} – ${fmt12(endMin)} (${fmtShort(b.duration || 0)})</div>
          <div class="tm">${escapeHtml(recurrenceSummary(b))}</div></div>
        <button class="open" title="Open series in Series Review" aria-label="Open series">${icon("external", 17)}</button>
      </div>
      <div class="tabs pill-tabs editor-tabs">
        ${[["settings", "Block Settings"], ["content", "Content"], ["meta", "Metadata"]].map(([k, l]) => `<button data-tab="${k}" class="${this._tab === k ? "on" : ""}">${l}</button>`).join("")}
      </div>
      <div class="editor-body">${this._tab === "settings" ? this._settingsHtml(b) : this._tab === "content" ? this._contentHtml(b) : this._metaHtml(b)}</div>
      <div class="editor-foot">
        <button class="outline del">${icon("trash", 15)} Delete</button>
        <button class="outline dup">${icon("copy", 15)} Duplicate</button>
        <span class="spacer"></span>
        <button class="outline rev" ${this._isDirty(b) ? "" : "disabled"}>${icon("undo", 15)} Revert</button>
        <button class="primary save" ${this._anyDirty() ? "" : "disabled"}>${icon("check", 15)} Save Changes</button>
      </div>`;
    panel.querySelector(".open").addEventListener("click", () => {
      publish(TOPICS.APP_VIEW_OPEN, { view: "series" });
      publish(TOPICS.SERIES_REVIEW_OPEN, { seriesId: b.series_id });
    });
    panel.querySelector(".editor-tabs").addEventListener("click", (e) => {
      const t = e.target.closest("[data-tab]");
      if (t) { this._tab = t.dataset.tab; this._renderEditor(); }
    });
    panel.querySelector(".del").addEventListener("click", () => this._deleteBlock(b));
    panel.querySelector(".dup").addEventListener("click", () => this._duplicateBlock(b));
    panel.querySelector(".rev").addEventListener("click", () => this._revertBlock(b));
    panel.querySelector(".save").addEventListener("click", () => this._save());
    this._wireEditorFields(panel, b);
  }

  _settingsHtml(b) {
    const rec = b.recurrence || {};
    const freq = rec.frequency || "daily";
    const wd = WEEKDAYS.indexOf(String(rec.weekday || "").toLowerCase());
    const packing = b.packing || {};
    const pOn = packing.enabled === true;
    const boundary = b.boundary || {};
    const bMode = boundary.mode || "hard";
    const dur = Number(b.duration) || 0;
    const durOpts = DURATIONS.includes(dur) ? DURATIONS : [...DURATIONS, dur].sort((x, y) => x - y);
    return `
      <div class="sect"><h3>${icon("repeat", 17)} Recurrence</h3><div class="rows">
        <div class="frow"><label>Pattern</label><select data-f="freq">${[["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]].map(([v, l]) => `<option value="${v}" ${v === freq ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        ${freq === "monthly"
          ? `<div class="frow"><label>Day of month</label><input type="number" min="1" max="31" data-f="dom" value="${rec.day_of_month || 1}"></div>`
          : `<div class="frow"><label>Days</label><div class="days">${DAY_ABBR.map((d, i) => `<label class="daychip ${freq === "daily" ? "off" : ""}"><input type="${freq === "daily" ? "checkbox" : "radio"}" name="wd" data-f="wd" value="${i}" ${freq === "daily" || i === wd ? "checked" : ""} ${freq === "daily" ? "disabled" : ""}>${d}</label>`).join("")}</div></div>
             ${freq === "weekly" ? `<div class="hint-note" style="margin-left:128px">A block repeats on one weekday. For several days, use Daily or duplicate the block.</div>` : ""}`}
      </div></div>
      <div class="sect"><h3>${icon("clock", 17)} Duration &amp; Timing</h3><div class="rows">
        <div class="frow"><label>Start Time</label><div class="inline"><input type="time" data-f="time" value="${escapeHtml(rec.time || "00:00")}"><select data-f="duration">${durOpts.map((d) => `<option value="${d}" ${d === dur ? "selected" : ""}>${fmtDuration(d)}${DURATIONS.includes(d) ? "" : " (custom)"}</option>`).join("")}</select></div></div>
        <div class="frow"><label>Timezone</label><input data-f="tz" value="${escapeHtml(rec.timezone || "UTC")}" placeholder="America/Los_Angeles"></div>
      </div></div>
      <div class="sect"><h3>${icon("play", 17)} Episode Rotation</h3><div class="rows">
        <div class="frow"><label>Rotation Mode</label><select data-f="rot-mode" disabled><option>Sequential (in order)</option></select></div>
        <div class="frow"><label>Anchor date</label><input type="date" data-f="anchor" value="${escapeHtml(b.rotation?.anchor_date || "")}"></div>
        <label class="check" style="margin-left:128px"><input type="checkbox" data-f="loop" ${b.rotation?.loop !== false ? "checked" : ""}> Loop when reaching the end</label>
      </div></div>
      <div class="sect"><h3>${icon("layers", 17)} Packing &amp; Fit</h3><div class="rows">
        <div class="frow"><label>Packing Mode</label><select data-f="pack-mode"><option value="" ${pOn ? "" : "selected"}>Single episode (no packing)</option>${PACKING_MODES.map(([v, l]) => `<option value="${v}" ${pOn && (packing.mode || "sequential") === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        ${pOn ? `
        <div class="frow"><label>On Unfit</label><select data-f="pack-unfit">${ON_UNFIT_POLICIES.map(([v, l]) => `<option value="${v}" ${(packing.on_unfit || "defer") === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="frow"><label>Keep free (s)</label><div class="inline"><input type="number" min="0" data-f="pack-min" value="${packing.minimum_remaining ?? 0}" title="Leave at least this much time"><input type="number" min="0" data-f="pack-margin" value="${packing.safety_margin ?? 0}" title="Safety margin (seconds)"></div></div>
        <label class="check" style="margin-left:128px"><input type="checkbox" data-f="pack-repeat" ${packing.allow_repeat_within_block ? "checked" : ""}> Allow the same episode twice in one airing</label>
        <div class="hint-note" style="margin-left:128px">Keep free = minimum remaining · safety margin. “Defer” waits for a bigger slot rather than guessing.</div>` : ""}
      </div></div>
      <div class="sect"><h3>${icon("swap", 17)} Boundary Behavior</h3><div class="rows">
        <div class="frow"><label>Boundary</label><select data-f="b-mode">${BOUNDARY_MODES.map(([v, l]) => `<option value="${v}" ${v === bMode ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        ${bMode !== "hard" ? `<div class="frow"><label>Max delay (s)</label><input type="number" min="0" data-f="b-delay" value="${boundary.max_delay ?? 300}"></div>` : ""}
      </div></div>`;
  }

  _contentHtml(b) {
    const s = this._seriesById.get(b.series_id);
    const eps = s?.episodes || [];
    const k = { approved: 0, candidate: 0, rejected: 0 };
    for (const e of eps) if (e.status in k) k[e.status]++;
    const approved = eps.filter((e) => e.status === "approved").slice(0, 8);
    return `
      <div class="sect"><h3>${icon("film", 17)} Series</h3><div class="rows">
        <div class="frow"><label>Series</label><select data-f="series">${(this._catalogSeries().some((x) => x.id === b.series_id) ? [] : [{ id: b.series_id, title: b.series_id }]).concat(this._catalogSeries()).map((x) => `<option value="${escapeHtml(x.id)}" ${x.id === b.series_id ? "selected" : ""}>${escapeHtml(x.title)}</option>`).join("")}</select></div>
        <div class="hint-note">Only series in this channel's catalog can be scheduled. Use + in Shows &amp; Series to add more.</div>
        <div class="chip-row"><span class="pill" data-tone="approved">${k.approved} approved</span><span class="pill" data-tone="candidate">${k.candidate} candidate</span><span class="pill" data-tone="rejected">${k.rejected} rejected</span></div>
        ${k.approved === 0 ? `<div class="warn-note">No approved episodes — this block will compile to nothing until some are approved in Series Review.</div>` : ""}
      </div></div>
      <div class="sect"><h3>${icon("list", 17)} Next in rotation</h3><div class="rows">
        ${approved.map((e) => `<div class="ep-mini">${thumbHtml(e.thumbnail_url)}<span>${escapeHtml(e.title)}</span></div>`).join("") || `<span class="hint-note">Nothing approved yet.</span>`}
      </div></div>`;
  }

  _metaHtml(b) {
    return `
      <div class="sect"><h3>${icon("info", 17)} Metadata</h3><div class="rows">
        <div class="frow"><label>Block id</label><input data-f="id" value="${escapeHtml(b.id || "")}"></div>
        <div class="frow"><label>Title</label><input data-f="title" value="${escapeHtml(b.title || "")}" placeholder="${escapeHtml(this._seriesTitle(b.series_id))}"></div>
        <div class="frow" style="align-items:start"><label>Description</label><textarea data-f="desc" rows="4">${escapeHtml(b.description || "")}</textarea></div>
        <div class="hint-note">The id is the block's stable key (used in schedule occurrence ids and rotation state) — change it only for new blocks.</div>
      </div></div>`;
  }

  _wireEditorFields(panel, b) {
    const body = panel.querySelector(".editor-body");
    const refreshAll = (full) => {
      this._renderGrid();
      if (full) this._renderEditor(); else this._refreshEditorChrome();
    };
    body.addEventListener("input", (e) => {
      if (e.target.matches("[data-f]") && e.target.tagName !== "SELECT" && e.target.type !== "checkbox" && e.target.type !== "radio") this._applyField(b, e.target, refreshAll);
    });
    body.addEventListener("change", (e) => {
      if (e.target.matches("[data-f]")) this._applyField(b, e.target, refreshAll);
    });
  }

  /** Lightweight refresh while typing: don't rebuild inputs (keeps focus), just the summary/footer. */
  _refreshEditorChrome() {
    const panel = this.shadowRoot.querySelector(".editor");
    const b = this._sel();
    if (!b || !panel) return;
    const startMin = parseHM(b.recurrence?.time);
    panel.querySelector(".blk-card .nm").textContent = b.title || this._seriesTitle(b.series_id);
    const tms = panel.querySelectorAll(".blk-card .tm");
    tms[0].textContent = `${fmt12(startMin)} – ${fmt12(startMin + Math.round((b.duration || 0) / 60))} (${fmtShort(b.duration || 0)})`;
    tms[1].textContent = recurrenceSummary(b);
    panel.querySelector(".rev").disabled = !this._isDirty(b);
    panel.querySelector(".save").disabled = !this._anyDirty();
    this.shadowRoot.querySelector(".unsaved")?.classList.toggle("hidden", !this._anyDirty());
  }

  _applyField(b, el, refresh) {
    const f = el.dataset.f;
    const rec = (b.recurrence = b.recurrence || {});
    let full = false;
    switch (f) {
      case "freq":
        rec.frequency = el.value;
        if (el.value === "weekly" && !rec.weekday) rec.weekday = "monday";
        if (el.value === "monthly" && !rec.day_of_month) rec.day_of_month = 1;
        if (el.value !== "weekly") delete rec.weekday;
        if (el.value !== "monthly") delete rec.day_of_month;
        full = true; break;
      case "wd": rec.weekday = WEEKDAYS[Number(el.value)]; break;
      case "dom": rec.day_of_month = Math.min(31, Math.max(1, Number(el.value) || 1)); break;
      case "time": if (el.value) rec.time = el.value; break;
      case "tz": rec.timezone = el.value.trim(); break;
      case "duration": b.duration = Number(el.value) || 0; break;
      case "anchor": b.rotation = { ...(b.rotation || { mode: "sequential" }), anchor_date: el.value }; break;
      case "loop": b.rotation = { ...(b.rotation || { mode: "sequential" }), loop: el.checked }; break;
      case "pack-mode":
        if (!el.value) b.packing = { ...(b.packing || {}), enabled: false };
        else b.packing = { on_unfit: "defer", minimum_remaining: 0, ...(b.packing || {}), enabled: true, mode: el.value };
        full = true; break;
      case "pack-unfit": b.packing = { ...b.packing, on_unfit: el.value }; break;
      case "pack-min": b.packing = { ...b.packing, minimum_remaining: Math.max(0, Number(el.value) || 0) }; break;
      case "pack-margin": b.packing = { ...b.packing, safety_margin: Math.max(0, Number(el.value) || 0) }; break;
      case "pack-repeat": b.packing = { ...b.packing, allow_repeat_within_block: el.checked }; break;
      case "b-mode":
        b.boundary = el.value === "hard" ? { mode: "hard" } : { mode: el.value, max_delay: b.boundary?.max_delay ?? 300 };
        full = true; break;
      case "b-delay": b.boundary = { ...b.boundary, max_delay: Math.max(0, Number(el.value) || 0) }; break;
      case "series": {
        const oldTitle = this._seriesTitle(b.series_id);
        b.series_id = el.value;
        if (!b.title || b.title === oldTitle) b.title = this._seriesTitle(el.value);
        full = true; break;
      }
      case "id": b.id = el.value.trim(); break;
      case "title": b.title = el.value; break;
      case "desc": b.description = el.value; break;
      default: return;
    }
    // Drop packing sub-keys when the policy is off so the saved block stays minimal.
    if (b.packing && b.packing.enabled === false) b.packing = { enabled: false };
    refresh(full);
  }

  // ---------- block operations ----------

  _addBlock(seriesId, weekdayIdx = null, startMin = 12 * 60) {
    if (!seriesId) { toast("Add a series to this channel's catalog first (+ in Shows & Series).", "warn"); return; }
    const tz = this._blocks[0]?.recurrence?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const nb = blankBlock(seriesId, this._seriesTitle(seriesId), weekdayIdx, startMin, tz);
    this._blocks.push(nb);
    this._selUid = nb._uid;
    this._tab = "settings";
    this._renderLeft();
    this._renderGrid();
    this._renderEditor();
  }

  _duplicateBlock(b) {
    const copy = { ...JSON.parse(JSON.stringify(stripLocal(b))), _uid: ++uidSeq, _new: true };
    let n = 2;
    const base = String(b.id || "block").replace(/-copy(-\d+)?$/, "");
    while (this._blocks.some((x) => x.id === `${base}-copy${n > 2 ? `-${n}` : ""}`)) n++;
    copy.id = `${base}-copy${n > 2 ? `-${n}` : ""}`;
    // Offset by the block's duration so the copy is visible rather than stacked.
    const t = parseHM(b.recurrence?.time) + Math.round((b.duration || 0) / 60);
    if (t < 1440) copy.recurrence.time = `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
    this._blocks.push(copy);
    this._selUid = copy._uid;
    this._renderGrid();
    this._renderEditor();
  }

  _deleteBlock(b) {
    if (!confirm(`Remove block "${b.title || b.id}" from the grid? (Not saved until you press Save Changes.)`)) return;
    this._blocks = this._blocks.filter((x) => x._uid !== b._uid);
    this._selUid = this._blocks[0]?._uid ?? null;
    this._renderLeft();
    this._renderGrid();
    this._renderEditor();
  }

  _revertBlock(b) {
    if (b._new) { this._blocks = this._blocks.filter((x) => x._uid !== b._uid); this._selUid = this._blocks[0]?._uid ?? null; }
    else {
      const orig = JSON.parse(this._saved.get(b._uid));
      const i = this._blocks.findIndex((x) => x._uid === b._uid);
      this._blocks[i] = { ...orig, _uid: b._uid };
    }
    this._renderLeft();
    this._renderGrid();
    this._renderEditor();
  }

  _validate() {
    const ids = new Set();
    for (const b of this._blocks) {
      if (!b.id) return `A block has no id (Metadata tab).`;
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(b.id)) return `Block id "${b.id}" may only contain letters, digits and dashes.`;
      if (ids.has(b.id)) return `Two blocks share the id "${b.id}".`;
      ids.add(b.id);
      if (!b.series_id) return `Block "${b.id}" has no series.`;
      if (!(b.duration > 0)) return `Block "${b.id}" needs a duration.`;
      if (!/^\d{1,2}:\d{2}$/.test(b.recurrence?.time || "")) return `Block "${b.id}" needs a start time.`;
      if (!b.recurrence?.timezone) return `Block "${b.id}" needs a timezone.`;
      if (!b.rotation?.anchor_date) return `Block "${b.id}" needs a rotation anchor date (Block Settings).`;
    }
    return null;
  }

  async _save() {
    const c = this._channel();
    if (!c) return;
    const problem = this._validate();
    if (problem) { toast(problem, "danger"); return; }
    const keepId = this._sel()?.id;
    try {
      await channelAdminApi.saveProgramming(c.id, this._blocks.map(stripLocal));
      toast(`Saved programming for ${c.name}.`, "good");
      const fresh = await channelAdminApi.list();
      this._channels = fresh;
      this._loadChannel(c.id, keepId);
      this._renderAll();
    } catch (e) {
      toast(e.message, "danger");
    }
  }

  // ---------- catalog dialog ----------

  _openCatalog() {
    const c = this._channel();
    if (!c) return;
    const dlg = this.shadowRoot.querySelector(".catalog-dlg");
    const selected = new Set(c.series_refs.map((r) => r.series_id).filter(Boolean));
    const dangling = c.series_refs.some((r) => r.series_id && !r.known);
    dlg.innerHTML = `
      <div class="dlg-head"><h2>Channel catalog — ${escapeHtml(c.name)}</h2><button class="icon close" aria-label="Close">${icon("x", 17)}</button></div>
      <div class="dlg-body">
        <p class="hint-note">Series ticked here can be scheduled on this channel. Saving rewrites catalog.json's series list.</p>
        ${dangling ? `<p class="warn-note">One or more existing refs point at a series id that no longer exists on disk -- saving will drop it.</p>` : ""}
        <div class="search">${icon("search", 17)}<input class="cat-search" placeholder="Search all series…"></div>
        <div class="cat-list">${this._series.map((s) => `
          <label class="cat-item" data-t="${escapeHtml(s.title.toLowerCase())}"><input type="checkbox" value="${escapeHtml(s.id)}" ${selected.has(s.id) ? "checked" : ""}>${thumbHtml(s.thumbnail_url)}<span>${escapeHtml(s.title)} <span class="muted">· ${s.episode_count} ep</span></span></label>`).join("")}</div>
        <div class="actions-row" style="justify-content:flex-end"><button class="cancel">Cancel</button><button class="primary save-cat">Save catalog</button></div>
      </div>`;
    dlg.querySelector(".close").addEventListener("click", () => dlg.close());
    dlg.querySelector(".cancel").addEventListener("click", () => dlg.close());
    dlg.querySelector(".cat-search").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      dlg.querySelectorAll(".cat-item").forEach((i) => { i.style.display = !q || i.dataset.t.includes(q) ? "" : "none"; });
    });
    dlg.querySelector(".save-cat").addEventListener("click", async () => {
      const ids = [...dlg.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);
      await this._saveCatalog(ids);
      dlg.close();
    });
    dlg.showModal();
  }

  async _saveCatalog(ids) {
    const c = this._channel();
    try {
      await channelAdminApi.saveCatalog(c.id, ids);
      toast(`Saved catalog for ${c.id}.`, "good");
      const dirtyBlocks = this._blocks;
      const saved = this._saved;
      const fresh = await channelAdminApi.list();
      this._channels = fresh;
      // Refreshing the catalog must not throw away unsaved grid edits.
      this._blocks = dirtyBlocks;
      this._saved = saved;
      this._renderAll();
    } catch (e) {
      toast(e.message, "danger");
    }
  }

  async _removeFromCatalog(id) {
    const c = this._channel();
    const used = this._blocks.filter((b) => b.series_id === id).length;
    if (!confirm(`Remove "${this._seriesTitle(id)}" from ${c.name}'s catalog?${used ? ` ${used} programming block${used === 1 ? " still uses" : "s still use"} it and will compile to nothing.` : ""}`)) return;
    await this._saveCatalog(c.series_refs.map((r) => r.series_id).filter((x) => x && x !== id));
  }

  // ---------- publish dialog ----------

  _openPublish() {
    const c = this._channel();
    if (!c) return;
    const dlg = this.shadowRoot.querySelector(".publish-dlg");
    dlg.innerHTML = `
      <div class="dlg-head"><h2>Preview &amp; publish — ${escapeHtml(c.name)}</h2><button class="icon close" aria-label="Close">${icon("x", 17)}</button></div>
      <div class="dlg-body">
        ${this._anyDirty() ? `<p class="warn-note">You have unsaved grid changes. Publishing compiles the <b>saved</b> programming — save first.</p>` : ""}
        ${!c.has_programming ? `<p class="warn-note">This channel has no programming.json yet -- save at least one block first.</p>` : ""}
        <div class="pub-row">
          <label class="field">Days<div class="field-value"><input type="number" class="pub-days" min="1" max="365" value="14"></div></label>
          <label class="field">Window start<div class="field-value"><input type="date" class="pub-start"></div></label>
          <label class="field">Window timezone<div class="field-value"><input class="pub-tz" value="${escapeHtml(this._blocks[0]?.recurrence?.timezone || "UTC")}"></div></label>
        </div>
        <div class="actions-row"><button class="pub-preview-btn">${icon("eye", 15)} Preview (dry run)</button><button class="pub-run-btn primary">${icon("cloudUp", 15)} Publish for real</button></div>
        <pre class="output publish-output hidden"></pre>
      </div>`;
    dlg.querySelector(".close").addEventListener("click", () => dlg.close());
    const run = async (dryRun) => {
      if (!dryRun && !confirm(`Publish ${c.name}? This overwrites its schedule.json.`)) return;
      const out = dlg.querySelector(".publish-output");
      out.classList.remove("hidden");
      out.textContent = "Running…";
      try {
        const opts = { dry_run: dryRun, days: Number(dlg.querySelector(".pub-days").value) || 14, window_timezone: dlg.querySelector(".pub-tz").value.trim() || "UTC" };
        const start = dlg.querySelector(".pub-start").value;
        if (start) opts.window_start = start;
        const result = await channelAdminApi.publish(c.id, opts);
        out.textContent = `exit code: ${result.exitCode}\n\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`;
        toast(result.exitCode === 0 ? (dryRun ? "Publish preview complete." : "Published.") : "Publish reported an error -- see output.", result.exitCode === 0 ? "good" : "danger");
      } catch (e) {
        out.textContent = e.message;
        toast(e.message, "danger");
      }
    };
    dlg.querySelector(".pub-preview-btn").addEventListener("click", () => run(true));
    dlg.querySelector(".pub-run-btn").addEventListener("click", () => run(false));
    dlg.showModal();
  }

  // ---------- continuity announcer dialog ----------

  _openAnnouncer() {
    this._renderAnnouncerDialog();
    this.shadowRoot.querySelector(".announcer-dlg").showModal();
  }

  _renderAnnouncerDialog() {
    const c = this._channel();
    const dlg = this.shadowRoot.querySelector(".announcer-dlg");
    if (!c) return;
    dlg.innerHTML = `
      <div class="dlg-head"><h2>Continuity announcer — ${escapeHtml(c.name)}</h2><button class="icon close" aria-label="Close">${icon("x", 17)}</button></div>
      <div class="dlg-body">${this._announcerError && !this._announcer.has(c.id) ? `<div class="error">Could not load continuity announcer data: ${escapeHtml(this._announcerError)}</div>` : announcerSectionHtml(c.id, this._announcer.get(c.id))}</div>`;
    dlg.querySelector(".close").addEventListener("click", () => dlg.close());
    const section = dlg.querySelector(".announcer-section");
    if (section) this._wireAnnouncerSection(section, c);
  }

  _readAnnouncerConfig(section) {
    const q = (sel) => section.querySelector(sel);
    const types = Array.from(section.querySelectorAll(".an-type-input:checked")).map((i) => i.value);
    return {
      enabled: q(".an-enabled").checked,
      voice: q(".an-voice").value.trim(),
      speed: Number(q(".an-speed").value) || 1.0,
      language: q(".an-language").value.trim(),
      style: q(".an-style").value,
      tone: q(".an-tone").value,
      targetDuration: Number(q(".an-duration").value) || 12,
      types,
      consecutiveSameSeries: q(".an-suppress").value,
      writer: { provider: q(".an-writer-provider").value, model: q(".an-writer-model").value.trim() || "sonnet" },
      // Deliberately no `tts` key here -- it's a deployment-level setting
      // (which Kokoro server/provider), not edited from this UI; omitting
      // it tells server/announcer-admin.php to leave whatever this
      // channel's announcer.json already has for it completely untouched
      // (see that file's save_config/announcer_admin_normalize_config()).
    };
  }

  _wireAnnouncerSection(section, c) {
    const channelId = c.id;
    const output = section.querySelector(".an-output");
    const showOutput = (text) => {
      output.classList.remove("hidden");
      output.textContent = text;
    };

    section.querySelector(".an-save-btn").addEventListener("click", async () => {
      try {
        const config = this._readAnnouncerConfig(section);
        await announcerAdminApi.saveConfig(channelId, config);
        toast(`Saved continuity announcer config for ${channelId}.`, "good");
        this._reloadAnnouncer();
      } catch (e) {
        toast(e.message, "danger");
      }
    });

    section.querySelector(".an-voices-btn").addEventListener("click", async () => {
      try {
        const { voices, error } = await announcerAdminApi.voices(channelId);
        const datalist = section.querySelector(`#an-voices-${cssEscape(channelId)}`) || section.querySelector("datalist");
        datalist.innerHTML = voices.map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
        if (voices.length) toast(`Loaded ${voices.length} voice(s) from Kokoro.`, "good");
        else toast(error ? `Could not reach Kokoro: ${error}` : "Kokoro reported no voices.", "danger");
      } catch (e) {
        toast(e.message, "danger");
      }
    });

    section.querySelector(".an-preview-btn").addEventListener("click", async () => {
      const voice = section.querySelector(".an-voice").value.trim();
      if (!voice) { toast("Enter a voice first.", "danger"); return; }
      try {
        const { url } = await announcerAdminApi.previewVoice(channelId, voice);
        const audio = section.querySelector(".an-preview-audio");
        audio.hidden = false;
        audio.src = appMediaUrl(url);
        audio.play?.().catch(() => { /* autoplay refused -- the visible controls still let the editor hit play */ });
      } catch (e) {
        toast(e.message, "danger");
      }
    });

    section.querySelector(".an-generate-btn").addEventListener("click", async () => {
      showOutput("Enqueuing…");
      try {
        const result = await announcerAdminApi.generateQueue(channelId);
        showOutput(`exit code: ${result.exitCode}\n\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`);
        toast("Missing announcements enqueued -- run announce-worker.php to process them.", "good");
      } catch (e) {
        showOutput(e.message);
        toast(e.message, "danger");
      }
    });

    section.querySelectorAll(".an-regen-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const transitionId = btn.dataset.transition;
        if (!transitionId) return;
        showOutput(`Regenerating ${transitionId}…`);
        btn.disabled = true;
        try {
          const result = await announcerAdminApi.regenerate(channelId, transitionId, { force: true });
          showOutput(`exit code: ${result.exitCode}\n\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`);
          toast(result.exitCode === 0 ? `Regenerated ${transitionId}.` : `Regeneration reported an error for ${transitionId}.`, result.exitCode === 0 ? "good" : "danger");
          this._reloadAnnouncer();
        } catch (e) {
          showOutput(e.message);
          toast(e.message, "danger");
        } finally {
          btn.disabled = false;
        }
      });
    });

    section.querySelectorAll(".an-edit-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".an-row");
        const textEl = row.querySelector(".an-row-text");
        const hash = btn.dataset.hash;
        if (!hash) { toast("This entry has no script hash to approve against.", "danger"); return; }
        if (row.querySelector(".an-edit-save")) return; // already editing
        const original = textEl.textContent;
        textEl.innerHTML = `<textarea class="an-edit-input">${escapeHtml(original)}</textarea>`;
        btn.textContent = "Cancel";
        const saveBtn = document.createElement("button");
        saveBtn.className = "an-edit-save ghost";
        saveBtn.textContent = "Approve";
        btn.after(saveBtn);

        const cancel = () => {
          textEl.textContent = original;
          btn.textContent = "Edit";
          saveBtn.remove();
          btn.removeEventListener("click", cancelHandler);
        };
        const cancelHandler = () => cancel();
        btn.addEventListener("click", cancelHandler, { once: true });

        saveBtn.addEventListener("click", async () => {
          const text = row.querySelector(".an-edit-input").value.trim();
          if (!text) { toast("Text cannot be empty.", "danger"); return; }
          try {
            await announcerAdminApi.approveScript(channelId, hash, text);
            toast("Approved -- this wording will not be overwritten by routine regeneration.", "good");
            this._reloadAnnouncer();
          } catch (e) {
            toast(e.message, "danger");
          }
        });
      });
    });
  }
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

customElements.define("cf-channel-admin", CfChannelAdmin);
