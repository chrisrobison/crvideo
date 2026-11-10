// <bump-schedule-workspace> -- the Schedule tab: ONE channel's bump
// scheduling rules at a time.
//
// Data and persistence are unchanged from the old per-channel form: rules
// are {bumpId, every, offsetSeconds, durationSeconds}, and Save calls
// store.saveSchedule() -> bump-admin.php save_schedule, a full replace of
// channels/<id>/bump-schedule.json. Everything readable here (offsets,
// next occurrences, overlaps, duration fit) comes from schedule-model.js,
// which derives windows from the player's own bumpRuleWindow().
//
// State: the selected channel's schedule is edited as a LOCAL working copy
// (this._draft) -- entirely separate from Compose's bump draft. Switching
// channels, or reloading, with unsaved schedule edits asks first. Nothing
// is written until "Save Channel Schedule"; rules are never changed
// automatically (duration mismatches and overlaps are only flagged).

import { escapeHtml, toast } from "../../utils.js";
import { studioStore as store } from "./bump-studio-store.js";
import { studioCSS, icons, makeThumb, mediaUrl } from "./studio-ui.js";
import { effectiveDuration, bumpDuration } from "./bump-model.js";
import {
  RECURRENCES, RECURRENCE_LABELS, BUMP_RULE_PERIODS, formatOffset, offsetToInput, parseOffsetInput,
  nextOccurrence, describeNext, formatDuration, findOverlaps, fitWarning, rulesEqual, channelInitials,
} from "./schedule-model.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const nowSec = () => Date.now() / 1000;
const warnIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.01"/></svg>`;
const clockIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
const OFFSET_PRESETS = { hour: ["00:00", "15:00", "30:00", "45:00"], halfHour: ["00:00", "00:10", "15:00"], day: [] };
const OFFSET_LABELS = { hour: "Offset (past hour)", halfHour: "Offset (past :00 / :30)", day: "Time of day (local)" };

class BumpScheduleWorkspace extends HTMLElement {
  constructor() {
    super();
    this._channelId = null;
    this._draft = null; // {enabled, rules} -- working copy of the selected channel's schedule
    this._editing = null; // {index (-1 = new), rule, original}
    this._query = "";
    this._saving = false;
    this._error = null;
    this._thumbs = new Map();
  }

  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ${studioCSS}
        :host{ display:block; }
        .layout{ display:grid; grid-template-columns:300px minmax(0,1fr); gap:16px; padding:16px; min-height:100%; align-items:start; }
        .panel{ background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); }
        aside.panel{ position:sticky; top:16px; display:flex; flex-direction:column; max-height:calc(100vh - 140px); min-height:0; }
        aside h2{ margin:0; padding:14px 14px 10px; font-size:17px; }
        aside .search{ margin:0 14px 10px; }
        .ch-list{ list-style:none; margin:0; padding:2px 8px 10px; overflow:auto; display:flex; flex-direction:column; gap:2px; }
        .ch-list li{ display:grid; grid-template-columns:40px minmax(0,1fr) auto; gap:10px; align-items:center; padding:7px 8px; border-radius:var(--radius-sm); border:1px solid transparent; cursor:pointer; }
        .ch-list li:hover{ background:var(--panel-2); }
        .ch-list li[aria-selected="true"]{ background:var(--accent-soft); border-color:var(--accent); }
        .ch-list li:focus-visible{ outline:2px solid var(--accent); outline-offset:-2px; }
        .badge-logo{ width:40px; height:40px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:13px; color:#fff; background:var(--panel-3); overflow:hidden; }
        .badge-logo img{ width:100%; height:100%; object-fit:contain; padding:5px; background:rgba(0,0,0,.25); }
        .ch-name{ font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .ch-meta{ font-size:12px; color:var(--text-muted); }
        .ch-meta .off{ color:var(--text-faint); }
        .ch-meta .unsaved{ color:var(--warn); }
        .main{ display:flex; flex-direction:column; gap:14px; min-width:0; }
        .toolbar{ display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
        .toolbar > label{ font-size:18px; font-weight:600; }
        .toolbar select{ width:auto; min-width:260px; max-width:420px; font-size:15px; padding:9px 12px; }
        .switch{ display:inline-flex; align-items:center; gap:10px; background:transparent; border:0; padding:4px; font-size:14px; }
        .switch .track{ width:44px; height:24px; border-radius:999px; background:var(--panel-3); border:1px solid var(--border); position:relative; transition:background .15s; flex-shrink:0; }
        .switch .track::after{ content:""; position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:50%; background:#cfd6e4; transition:transform .15s; }
        .switch[aria-checked="true"] .track{ background:var(--good); border-color:var(--good); }
        .switch[aria-checked="true"] .track::after{ transform:translateX(20px); background:#fff; }
        .pill{ display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:3px 10px; border-radius:999px; white-space:nowrap; border:1px solid; }
        .pill.unsaved{ color:var(--warn); border-color:rgba(245,165,36,.45); background:var(--warn-soft); }
        .pill.info{ color:#9dc3ff; border-color:var(--accent-dim); background:var(--accent-soft); }
        .banner{ display:flex; gap:14px; align-items:flex-start; padding:12px 16px; border-radius:var(--radius); border:1px solid rgba(245,165,36,.55); background:var(--warn-soft); }
        .banner svg{ width:26px; height:26px; color:var(--warn); margin-top:2px; }
        .banner strong{ display:block; color:#ffc35c; font-size:14px; }
        .banner span{ font-size:13px; color:var(--text); opacity:.9; }
        section.panel{ padding:14px 16px 16px; }
        section.panel > h2{ display:flex; align-items:center; gap:10px; margin:0 0 10px; font-size:17px; }
        .table-wrap{ overflow-x:auto; }
        table{ width:100%; border-collapse:collapse; font-size:14px; min-width:720px; }
        th{ text-align:left; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted); font-weight:700; padding:8px 10px; border-bottom:1px solid var(--border); }
        td{ padding:8px 10px; border-bottom:1px solid var(--border-soft); vertical-align:middle; }
        tr.editing td{ background:var(--accent-soft); }
        tr.disabled td:not(.acts){ opacity:.55; }
        .bump-cell{ display:flex; align-items:center; gap:12px; min-width:0; }
        .bump-cell .sw{ width:84px; height:48px; border-radius:5px; overflow:hidden; background:var(--panel-3); flex-shrink:0; }
        .bump-cell .sw .thumb{ width:100%; height:100%; border-radius:0; }
        .bump-cell b{ display:block; font-size:14px; }
        .bump-cell .sub{ font-size:12px; color:var(--text-muted); }
        .missing{ color:#ffb4b4; }
        .rec{ display:inline-flex; align-items:center; gap:8px; white-space:nowrap; }
        .rec svg{ width:16px; height:16px; color:var(--text-muted); }
        .next .when{ white-space:nowrap; }
        .next .cd{ font-size:12px; color:var(--text-muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
        .next .live{ color:var(--good); font-weight:600; }
        .flag{ display:inline-flex; align-items:center; gap:4px; margin-top:3px; font-size:11px; font-weight:700; padding:1px 7px; border-radius:999px; white-space:nowrap; }
        .flag.warn{ background:var(--warn-soft); color:#ffd28f; }
        .flag.info{ background:var(--panel-3); color:var(--text-muted); }
        .flag.error{ background:var(--live-soft); color:#ff9d9d; }
        .acts{ text-align:right; white-space:nowrap; }
        .acts button{ padding:6px 10px; }
        .acts .del{ color:#ff8f8f; }
        .acts svg{ width:15px; height:15px; }
        .notes{ list-style:none; margin:10px 0 0; padding:0; display:flex; flex-direction:column; gap:6px; }
        .notes li{ display:flex; gap:8px; align-items:flex-start; font-size:13px; padding:7px 10px; border-radius:var(--radius-sm); background:var(--warn-soft); color:#ffd9a0; }
        .notes svg{ width:16px; height:16px; margin-top:1px; }
        .notes li.error{ background:var(--live-soft); color:#ffb4b4; }
        .add{ margin-top:12px; display:inline-flex; align-items:center; gap:8px; padding:9px 16px; }
        .add svg{ width:16px; height:16px; }
        .empty-state{ border:1px dashed var(--border); border-radius:var(--radius-sm); }
        .ed-grid{ display:grid; grid-template-columns:minmax(220px,1.6fr) minmax(160px,1fr) minmax(160px,1fr) minmax(160px,1fr); gap:14px; padding-top:12px; border-top:1px solid var(--border-soft); }
        .ed-grid label.field{ margin:0; }
        .ed-grid .ctl{ margin-top:6px; display:flex; align-items:center; gap:8px; position:relative; font-size:14px; text-transform:none; letter-spacing:0; }
        .ed-grid select, .ed-grid input{ padding:9px 10px; }
        .ed-grid .ctl > svg{ position:absolute; left:10px; width:16px; height:16px; color:var(--text-muted); pointer-events:none; }
        .ed-grid .ctl.icon input{ padding-left:34px; }
        .ed-grid .bump-ctl .sw{ width:48px; height:30px; border-radius:4px; overflow:hidden; background:var(--panel-3); flex-shrink:0; }
        .ed-grid .bump-ctl .sw .thumb{ width:100%; height:100%; }
        .ed-grid .unit{ font-size:12px; color:var(--text-muted); text-transform:none; letter-spacing:0; }
        .ed-grid .hint{ margin-top:5px; font-size:11.5px; text-transform:none; letter-spacing:0; color:var(--text-muted); }
        .ed-grid .hint.bad{ color:#ffb4b4; }
        .match{ padding:2px 0; border:0; background:transparent; color:#9dc3ff; font-size:11.5px; text-transform:none; letter-spacing:0; text-decoration:underline; }
        .ed-msgs{ display:flex; flex-direction:column; gap:6px; margin-top:12px; }
        .msg{ display:flex; align-items:flex-start; gap:8px; font-size:13px; padding:7px 10px; border-radius:var(--radius-sm); }
        .msg svg{ width:16px; height:16px; margin-top:1px; }
        .msg.warn{ background:var(--warn-soft); color:#ffd9a0; }
        .msg.info{ background:var(--panel-2); color:var(--text-muted); }
        .msg.error{ background:var(--live-soft); color:#ffb4b4; }
        .msg.good{ background:var(--good-soft); color:#a6eabf; }
        .ed-foot{ display:flex; align-items:center; gap:10px; margin-top:14px; padding-top:12px; border-top:1px solid var(--border-soft); flex-wrap:wrap; }
        .ed-foot .nextp{ display:flex; align-items:center; gap:8px; font-size:14px; }
        .ed-foot .nextp svg{ width:18px; height:18px; color:var(--text-muted); }
        .ed-foot button{ padding:9px 18px; }
        .savebar{ display:flex; align-items:center; gap:10px; padding:10px 14px; border-radius:var(--radius); background:var(--panel-2); border:1px solid rgba(245,165,36,.45); flex-wrap:wrap; }
        .savebar .txt{ flex:1; font-size:13px; }
        .err-line{ color:#ffb4b4; font-size:13px; }
        @media (max-width: 1000px){
          .layout{ grid-template-columns:1fr; padding:12px; }
          aside.panel{ display:none; }
          .ed-grid{ grid-template-columns:1fr 1fr; }
          .toolbar select{ min-width:200px; flex:1; }
        }
        @media (max-width: 600px){
          .ed-grid{ grid-template-columns:1fr; }
        }
      </style>
      <div class="layout">
        <aside class="panel" aria-label="Channels">
          <h2>Channels</h2>
          <label class="search"><span class="sr-only">Search channels</span>${icons.search}<input type="search" class="ch-search" placeholder="Search channels…"></label>
          <ul class="ch-list" role="listbox" aria-label="Channels"></ul>
        </aside>
        <div class="main">
          <div class="toolbar">
            <label for="ch-select">Channel:</label>
            <select id="ch-select"></select>
            <button class="switch" role="switch" aria-checked="false"><span class="track"></span><span class="sw-label">Bump scheduling enabled</span></button>
            <span class="spacer"></span>
            <span class="pill unsaved" hidden>Unsaved changes</span>
          </div>
          <div class="banner" role="note">
            ${warnIcon}
            <div><strong>Scheduled bumps overlay and temporarily interrupt the underlying program.</strong>
            <span>When a bump plays, viewers see the bump instead of the program for the rule's duration. The program is not paused: it then resumes at the current time, as if it had kept playing underneath.</span></div>
          </div>
          <section class="panel rules" aria-labelledby="rules-h">
            <h2 id="rules-h">Scheduled bumps</h2>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Bump</th><th>Recurrence</th><th>Offset</th><th>Duration</th><th>Next occurrence</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody></tbody>
              </table>
            </div>
            <div class="empty-state rules-empty" hidden></div>
            <ul class="notes" aria-live="polite"></ul>
            <button class="add primary">${icons.plus}<span>Add scheduling rule</span></button>
          </section>
          <section class="panel editor" aria-labelledby="ed-h" hidden></section>
          <div class="savebar" hidden>
            <span class="txt"></span>
            <button class="discard ghost">Discard changes</button>
            <button class="save-all primary">Save Channel Schedule</button>
          </div>
        </div>
      </div>
    `;
    const root = this.shadowRoot;
    root.querySelector(".ch-search").addEventListener("input", (e) => { this._query = e.target.value.trim().toLowerCase(); this._renderChannels(); });
    const list = root.querySelector(".ch-list");
    list.addEventListener("click", (e) => { const li = e.target.closest("li[data-id]"); if (li) this._setChannel(li.dataset.id); });
    list.addEventListener("keydown", (e) => {
      const li = e.target.closest("li[data-id]");
      if (!li) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._setChannel(li.dataset.id); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        (e.key === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling)?.focus();
      }
    });
    root.querySelector("#ch-select").addEventListener("change", (e) => {
      if (!this._setChannel(e.target.value)) e.target.value = this._channelId || "";
    });
    root.querySelector(".switch").addEventListener("click", () => {
      if (!this._draft) return;
      this._draft.enabled = !this._draft.enabled;
      this._renderAll();
    });
    root.querySelector(".add").addEventListener("click", () => this._openEditor(-1));
    root.querySelector(".editor").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { this._closeEditor(); root.querySelector(".add").focus(); }
    });
    root.querySelector("tbody").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const i = Number(btn.closest("tr").dataset.index);
      if (btn.dataset.act === "edit") this._openEditor(i);
      else if (btn.dataset.act === "delete") this._deleteRule(i);
    });
    root.querySelector(".discard").addEventListener("click", () => {
      if (window.confirm("Discard unsaved changes to this channel's schedule?")) this._loadChannel(this._channelId);
    });
    root.querySelector(".save-all").addEventListener("click", () => this._save());

    this._onChange = ({ detail }) => {
      const k = detail.keys;
      if (k.has("scheduleFocus") && store.state.scheduleFocus) {
        const id = store.state.scheduleFocus;
        store.state.scheduleFocus = null;
        if (id !== this._channelId) this._setChannel(id);
      }
      if (k.has("status") || k.has("schedules")) {
        if (store.state.status !== "ready") { this._renderAll(); return; }
        const exists = store.state.schedules.some((c) => c.id === this._channelId);
        if (!exists) this._loadChannel(store.state.schedules[0]?.id || null);
        else if (!this._isDirty()) this._loadChannel(this._channelId, { keepEditor: true });
        else this._renderAll();
      } else if (k.has("bumps")) {
        this._renderAll();
      }
      if (k.has("workspace")) this._tick();
    };
    store.addEventListener("change", this._onChange);
    this._onUnload = (e) => { if (this._isDirty()) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", this._onUnload);
    this._timer = setInterval(() => this._tick(), 1000);
    if (store.state.status === "ready") this._loadChannel(store.state.schedules[0]?.id || null);
    else this._renderAll();
  }

  disconnectedCallback() {
    store.removeEventListener("change", this._onChange);
    window.removeEventListener("beforeunload", this._onUnload);
    clearInterval(this._timer);
  }

  // ---------- state ----------

  _saved() { return store.state.schedules.find((c) => c.id === this._channelId) || null; }

  _bump(id) { return store.state.bumps.find((b) => b.id === id) || null; }

  _editorChanged() {
    const ed = this._editing;
    return !!ed && (ed.index === -1 || !rulesEqual([ed.rule], [ed.original]));
  }

  _isDirty() {
    const saved = this._saved();
    if (!saved || !this._draft) return false;
    return this._draft.enabled !== !!saved.enabled || !rulesEqual(this._draft.rules, saved.rules) || this._editorChanged();
  }

  /** Switches the shown channel, asking before discarding unsaved edits. */
  _setChannel(id) {
    if (!id || id === this._channelId) return true;
    if (this._isDirty()) {
      const name = this._saved()?.name || this._channelId;
      if (!window.confirm(`"${name}" has unsaved schedule changes. Discard them and switch channels?`)) return false;
    }
    this._loadChannel(id);
    return true;
  }

  _loadChannel(id, { keepEditor = false } = {}) {
    this._channelId = id;
    const saved = this._saved();
    this._draft = saved ? { enabled: !!saved.enabled, rules: clone(saved.rules || []) } : null;
    if (!keepEditor) this._editing = null;
    this._error = null;
    this._renderAll();
  }

  // ---------- rule editing ----------

  _openEditor(index) {
    if (!this._draft) return;
    const bumps = store.state.bumps;
    let rule;
    if (index >= 0) rule = clone(this._draft.rules[index]);
    else {
      const b = bumps[0];
      rule = { bumpId: b?.id || "", every: "hour", offsetSeconds: 0, durationSeconds: Math.round(effectiveDuration(b)) };
    }
    this._editing = { index, rule, original: clone(rule), offsetText: offsetToInput(rule.every, rule.offsetSeconds), offsetBad: false };
    this._error = null;
    this._renderAll();
    const ed = this.shadowRoot.querySelector(".editor");
    ed.scrollIntoView({ block: "nearest", behavior: "smooth" });
    ed.querySelector(".ed-bump")?.focus();
  }

  _closeEditor() {
    this._editing = null;
    this._renderAll();
  }

  /** Validates the open editor; returns an error string or null. */
  _editorProblem() {
    const ed = this._editing;
    if (!ed) return null;
    const period = BUMP_RULE_PERIODS[ed.rule.every];
    if (!ed.rule.bumpId) return "Choose a bump.";
    if (ed.offsetBad) return ed.rule.every === "day" ? "Enter a time of day (HH:MM or HH:MM:SS)." : `Enter minutes:seconds between 00:00 and ${period === 1800 ? "29:59" : "59:59"}.`;
    const d = Number(ed.rule.durationSeconds);
    if (!Number.isFinite(d) || d <= 0) return "Duration must be at least 1 second.";
    if (d > period) return `Duration can be at most one full period (${formatDuration(period)}).`;
    return null;
  }

  /** Commits the open editor into the working copy (not to disk). */
  _applyEditor() {
    const problem = this._editorProblem();
    if (problem) { this._error = problem; this._renderEditor(); return false; }
    const ed = this._editing;
    const rule = { bumpId: ed.rule.bumpId, every: ed.rule.every, offsetSeconds: Number(ed.rule.offsetSeconds) || 0, durationSeconds: Number(ed.rule.durationSeconds) };
    if (ed.index >= 0) this._draft.rules[ed.index] = rule;
    else this._draft.rules.push(rule);
    this._editing = null;
    this._error = null;
    return true;
  }

  _deleteRule(i) {
    if (!this._draft) return;
    if (this._editing?.index === i) this._editing = null;
    else if (this._editing && this._editing.index > i) this._editing.index--;
    this._draft.rules.splice(i, 1);
    this._renderAll();
    this.shadowRoot.querySelector(".add").focus();
  }

  async _save() {
    if (!this._draft || this._saving) return;
    if (this._editing && !this._applyEditor()) return;
    const missing = this._draft.rules.filter((r) => !this._bump(r.bumpId));
    if (missing.length) {
      this._error = `Rules reference ${missing.length === 1 ? "a bump that no longer exists" : `${missing.length} bumps that no longer exist`} (${[...new Set(missing.map((r) => r.bumpId))].join(", ")}). Remove or edit ${missing.length === 1 ? "it" : "them"} before saving.`;
      this._renderAll();
      return;
    }
    this._saving = true;
    this._error = null;
    this._renderAll();
    const name = this._saved()?.name || this._channelId;
    try {
      await store.saveSchedule(this._channelId, this._draft.enabled, this._draft.rules);
      this._saving = false;
      this._loadChannel(this._channelId);
      toast(`Saved ${name}'s bump schedule.`, "good");
    } catch (e) {
      this._saving = false;
      this._error = `Could not save: ${e.message}`;
      this._renderAll();
      toast(e.message, "danger", 6000);
    }
  }

  // ---------- rendering ----------

  _thumb(bump, key) {
    const bg = bump?.background || {};
    if (!bump || bg.type === "color" || !bg.url) {
      const d = document.createElement("div");
      d.style.cssText = `width:100%;height:100%;background:${bump ? (bg.color || "#14213d") : "var(--panel-3)"}`;
      return d;
    }
    const k = `${key}:${bump.id}:${bg.type}:${bg.url}`;
    if (!this._thumbs.has(k)) this._thumbs.set(k, makeThumb(bg.type, bg.url, { hoverPlay: false }));
    return this._thumbs.get(k);
  }

  _renderAll() {
    const root = this.shadowRoot;
    const ready = store.state.status === "ready";
    root.querySelector(".layout").hidden = !ready; // the shell shows loading/error
    if (!ready) return;
    this._renderChannels();
    this._renderToolbar();
    this._renderRules();
    this._renderEditor();
    this._renderSavebar();
  }

  _renderChannels() {
    const root = this.shadowRoot;
    const list = root.querySelector(".ch-list");
    const q = this._query;
    const channels = store.state.schedules.filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q));
    const dirty = this._isDirty();
    list.innerHTML = channels.map((c) => {
      const sel = c.id === this._channelId;
      const n = (c.rules || []).length;
      const logo = c.logo
        ? `<span class="badge-logo"><img src="${escapeHtml(mediaUrl(c.logo))}" alt=""></span>`
        : `<span class="badge-logo" style="background:${escapeHtml(c.accent || "var(--panel-3)")}">${escapeHtml(channelInitials(c.name))}</span>`;
      return `<li role="option" data-id="${escapeHtml(c.id)}" aria-selected="${sel}" tabindex="${sel ? 0 : -1}">
        ${logo}
        <div><div class="ch-name">${escapeHtml(c.name)}</div>
        <div class="ch-meta">${n} bump rule${n === 1 ? "" : "s"}${c.enabled ? "" : ` · <span class="off">off</span>`}${sel && dirty ? ` · <span class="unsaved">unsaved</span>` : ""}</div></div>
        <span></span>
      </li>`;
    }).join("") || `<li class="empty-state" aria-disabled="true">No channels match.</li>`;
    if (!channels.some((c) => c.id === this._channelId)) list.querySelector("li[data-id]")?.setAttribute("tabindex", "0");
  }

  _renderToolbar() {
    const root = this.shadowRoot;
    const sel = root.querySelector("#ch-select");
    sel.innerHTML = store.state.schedules.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("");
    sel.value = this._channelId || "";
    sel.disabled = !store.state.schedules.length;
    const sw = root.querySelector(".switch");
    sw.disabled = !this._draft;
    sw.setAttribute("aria-checked", String(!!this._draft?.enabled));
    sw.querySelector(".sw-label").textContent = this._draft?.enabled ? "Bump scheduling enabled" : "Bump scheduling disabled";
    root.querySelector(".pill.unsaved").hidden = !this._isDirty();
  }

  _renderRules() {
    const root = this.shadowRoot;
    const tbody = root.querySelector("tbody");
    const empty = root.querySelector(".rules-empty");
    const notes = root.querySelector(".notes");
    const add = root.querySelector(".add");
    const bumps = store.state.bumps;
    add.disabled = !this._draft || !bumps.length || this._saving;
    add.hidden = !!this._editing && this._editing.index === -1;
    if (!this._draft) {
      tbody.innerHTML = "";
      root.querySelector("table").hidden = true;
      empty.hidden = false;
      empty.innerHTML = `<p>No channels found.</p>`;
      notes.innerHTML = "";
      return;
    }
    const rules = this._draft.rules;
    const overlaps = findOverlaps(rules);
    const overlapBy = new Map();
    for (const o of overlaps) for (const [x, y] of [[o.a, o.b], [o.b, o.a]]) overlapBy.set(x, [...(overlapBy.get(x) || []), y]);
    root.querySelector("table").hidden = !rules.length;
    empty.hidden = !!rules.length;
    empty.innerHTML = bumps.length
      ? `<p>No bumps are scheduled on this channel.</p><p class="small">Add a rule to show a bump every hour, half hour or day.</p>`
      : `<p>There are no bumps to schedule yet.</p><p class="small">Build one in Compose first.</p>`;
    tbody.textContent = "";
    rules.forEach((rule, i) => {
      const bump = this._bump(rule.bumpId);
      const fit = fitWarning(rule, bump);
      const off = formatOffset(rule.every, rule.offsetSeconds);
      const tr = document.createElement("tr");
      tr.dataset.index = String(i);
      if (this._editing?.index === i) tr.className = "editing";
      if (!this._draft.enabled) tr.classList.add("disabled");
      const own = bumpDuration(bump);
      const ov = overlapBy.get(i);
      tr.innerHTML = `
        <td><div class="bump-cell"><div class="sw"></div><div>
          ${bump ? `<b>${escapeHtml(bump.name || bump.id)}</b><span class="sub">${own ? `${formatDuration(own)} bump` : "No fixed length"}</span>`
            : `<b class="missing">Missing bump</b><span class="sub missing">${escapeHtml(rule.bumpId)}</span>`}
          ${ov ? `<div><span class="flag warn" title="Windows overlap; on air the earlier rule in this list plays">Overlaps rule ${ov.map((x) => x + 1).join(", ")}</span></div>` : ""}
        </div></div></td>
        <td><span class="rec">${icons.loop}${escapeHtml(RECURRENCE_LABELS[rule.every] || rule.every)}</span></td>
        <td title="${escapeHtml(off.long)}">${escapeHtml(off.short)}</td>
        <td><div>${escapeHtml(formatDuration(rule.durationSeconds))}</div>
          ${fit.level === "warn" ? `<span class="flag ${fit.level}" title="${escapeHtml(fit.message)}">${fit.fit === "cut" ? "Cut short" : fit.fit === "loop" ? "Loops" : "Open length"}</span>` : ""}</td>
        <td class="next"></td>
        <td class="acts">
          <button class="icon-btn" data-act="edit" aria-label="Edit rule ${i + 1}">${icons.edit}<span>Edit</span></button>
          <button class="icon-btn del" data-act="delete" aria-label="Delete rule ${i + 1}" title="Remove this rule (not saved until you save)">${icons.trash}</button>
        </td>`;
      tr.querySelector(".sw").append(this._thumb(bump, "row"));
      tbody.append(tr);
    });
    // Explanations, never automatic fixes.
    const items = [];
    for (const o of overlaps) {
      items.push([`warn`, `Rules ${o.a + 1} and ${o.b + 1} overlap for ${formatDuration(o.seconds)} (${escapeHtml(formatOffset(rules[o.a].every, rules[o.a].offsetSeconds).long.toLowerCase())} vs ${escapeHtml(formatOffset(rules[o.b].every, rules[o.b].offsetSeconds).long.toLowerCase())}). On air, rule ${o.a + 1} plays while both windows are open.`]);
    }
    rules.forEach((r, i) => {
      const fit = fitWarning(r, this._bump(r.bumpId));
      if (fit.level === "warn" || fit.level === "error") items.push([fit.level, `Rule ${i + 1}: ${escapeHtml(fit.message)}`]);
    });
    notes.innerHTML = items.map(([level, t]) => `<li class="${level}">${warnIcon}<span>${t}</span></li>`).join("");
    this._tick();
  }

  _renderEditor() {
    const root = this.shadowRoot;
    const panel = root.querySelector(".editor");
    const ed = this._editing;
    panel.hidden = !ed;
    if (!ed) { panel.innerHTML = ""; return; }
    const focused = this.shadowRoot.activeElement;
    const focusKey = focused?.dataset?.key;
    const caret = focused && "selectionStart" in focused ? focused.selectionStart : null;
    const rule = ed.rule;
    const bumps = store.state.bumps;
    const bump = this._bump(rule.bumpId);
    const period = BUMP_RULE_PERIODS[rule.every];
    const own = bumpDuration(bump);
    const problem = this._editorProblem();
    const fit = bump && !problem ? fitWarning(rule, bump) : null;
    // Overlaps as if this rule were applied.
    const trial = clone(this._draft.rules);
    const at = ed.index >= 0 ? ed.index : trial.length;
    trial[at] = rule;
    const ov = problem ? [] : findOverlaps(trial).filter((o) => o.a === at || o.b === at);
    const missingOpt = rule.bumpId && !bump ? `<option value="${escapeHtml(rule.bumpId)}" selected>Missing: ${escapeHtml(rule.bumpId)}</option>` : "";
    const offsetInput = rule.every === "day"
      ? `<input class="ed-offset" data-key="offset" type="time" step="1" value="${escapeHtml(ed.offsetText)}" aria-describedby="off-hint">`
      : `<input class="ed-offset" data-key="offset" inputmode="numeric" list="off-presets" value="${escapeHtml(ed.offsetText)}" placeholder="mm:ss" aria-describedby="off-hint">`;
    panel.innerHTML = `
      <h2 id="ed-h">Scheduling rule <span class="pill info">${ed.index >= 0 ? `Editing rule ${ed.index + 1}` : "New rule"}</span></h2>
      <div class="ed-grid">
        <label class="field">Bump
          <div class="ctl bump-ctl"><div class="sw"></div>
            <select class="ed-bump" data-key="bump">${missingOpt}${bumps.map((b) => `<option value="${escapeHtml(b.id)}" ${b.id === rule.bumpId ? "selected" : ""}>${escapeHtml(b.name || b.id)}</option>`).join("")}</select>
          </div>
          <div class="hint">${bump ? (own ? `Composition length ${formatDuration(own)}` : "No fixed length (runs for the rule's duration)") : "&nbsp;"}</div>
        </label>
        <label class="field">Recurrence
          <div class="ctl"><select class="ed-every" data-key="every">${RECURRENCES.map((r) => `<option value="${r.value}" ${r.value === rule.every ? "selected" : ""}>${r.label}</option>`).join("")}</select></div>
        </label>
        <label class="field">${OFFSET_LABELS[rule.every]}
          <div class="ctl icon">${clockIcon}${offsetInput}</div>
          <datalist id="off-presets">${(OFFSET_PRESETS[rule.every] || []).map((p) => `<option value="${p}"></option>`).join("")}</datalist>
          <div class="hint ${ed.offsetBad ? "bad" : ""}" id="off-hint">${ed.offsetBad ? "Not a valid offset" : escapeHtml(formatOffset(rule.every, rule.offsetSeconds).long)}</div>
        </label>
        <label class="field">Duration <span class="unit">(seconds)</span>
          <div class="ctl"><input class="ed-dur" data-key="dur" type="number" min="1" max="${period}" step="1" value="${escapeHtml(String(rule.durationSeconds))}"></div>
          <div class="hint">${own && Math.abs(own - Number(rule.durationSeconds)) >= 0.01 ? `<button type="button" class="match">Use the bump's length (${formatDuration(own)})</button>` : formatDuration(rule.durationSeconds)}</div>
        </label>
      </div>
      <div class="ed-msgs">
        ${fit && fit.level ? `<div class="msg ${fit.level}">${warnIcon}<span>${escapeHtml(fit.message)}</span></div>` : ""}
        ${fit && !fit.level ? `<div class="msg good">${icons.check}<span>${escapeHtml(fit.message)}</span></div>` : ""}
        ${ov.map((o) => { const other = o.a === at ? o.b : o.a; return `<div class="msg warn">${warnIcon}<span>Overlaps rule ${other + 1} for ${formatDuration(o.seconds)}. On air, rule ${Math.min(at, other) + 1} plays while both are open.</span></div>`; }).join("")}
        ${this._error ? `<div class="msg error" role="alert">${warnIcon}<span>${escapeHtml(this._error)}</span></div>` : ""}
      </div>
      <div class="ed-foot">
        <span class="nextp">${icons.calendar}<span class="nextp-txt"></span></span>
        <span class="spacer"></span>
        <button class="ed-cancel">Cancel</button>
        <button class="ed-apply ghost" title="Keep this rule in the list without saving yet">Apply</button>
        <button class="ed-save primary" ${this._saving ? "disabled" : ""}>${this._saving ? "Saving…" : "Save Channel Schedule"}</button>
      </div>`;
    panel.querySelector(".sw").append(this._thumb(bump, "ed"));
    const rerender = () => { this._renderEditor(); this._renderToolbar(); this._renderSavebar(); };
    panel.querySelector(".ed-bump").addEventListener("change", (e) => { rule.bumpId = e.target.value; this._error = null; rerender(); });
    panel.querySelector(".ed-every").addEventListener("change", (e) => {
      rule.every = e.target.value;
      const p = BUMP_RULE_PERIODS[rule.every];
      rule.offsetSeconds = (Number(rule.offsetSeconds) || 0) % p;
      if (Number(rule.durationSeconds) > p) rule.durationSeconds = p;
      ed.offsetText = offsetToInput(rule.every, rule.offsetSeconds);
      ed.offsetBad = false;
      rerender();
    });
    panel.querySelector(".ed-offset").addEventListener("change", (e) => {
      ed.offsetText = e.target.value;
      const v = parseOffsetInput(rule.every, e.target.value);
      ed.offsetBad = Number.isNaN(v);
      if (!ed.offsetBad) { rule.offsetSeconds = v; ed.offsetText = offsetToInput(rule.every, v); }
      this._error = null;
      rerender();
    });
    panel.querySelector(".ed-dur").addEventListener("input", (e) => {
      rule.durationSeconds = e.target.value === "" ? "" : Number(e.target.value);
      this._error = null;
      clearTimeout(this._durTimer);
      this._durTimer = setTimeout(rerender, 350); // keep typing uninterrupted
    });
    panel.querySelector(".ed-dur").addEventListener("change", rerender);
    panel.querySelector(".match")?.addEventListener("click", () => { rule.durationSeconds = own; rerender(); });
    panel.querySelector(".ed-cancel").addEventListener("click", () => this._closeEditor());
    panel.querySelector(".ed-apply").addEventListener("click", () => { if (this._applyEditor()) this._renderAll(); });
    panel.querySelector(".ed-save").addEventListener("click", () => this._save());
    if (focusKey) {
      const el = panel.querySelector(`[data-key="${focusKey}"]`);
      el?.focus();
      if (el && caret !== null && "setSelectionRange" in el && el.type !== "number" && el.type !== "time") try { el.setSelectionRange(caret, caret); } catch { /* not a text input */ }
    }
    this._tick();
  }

  _renderSavebar() {
    const root = this.shadowRoot;
    const bar = root.querySelector(".savebar");
    const showBar = !this._editing && (this._isDirty() || (this._error && !this._editing));
    bar.hidden = !showBar;
    if (!showBar) return;
    const name = this._saved()?.name || this._channelId;
    bar.querySelector(".txt").innerHTML = this._error
      ? `<span class="err-line">${escapeHtml(this._error)}</span>`
      : `Unsaved changes to <b>${escapeHtml(name)}</b>'s schedule. Nothing changes on air until you save.`;
    bar.querySelector(".save-all").disabled = this._saving;
    bar.querySelector(".save-all").textContent = this._saving ? "Saving…" : "Save Channel Schedule";
    bar.querySelector(".discard").disabled = this._saving;
  }

  /** Updates only the live countdown text (once a second, while visible). */
  _tick() {
    if (store.state.workspace !== "schedule" || !this._draft) return;
    const now = nowSec();
    const root = this.shadowRoot;
    root.querySelectorAll("tbody tr").forEach((tr) => {
      const rule = this._draft.rules[Number(tr.dataset.index)];
      const cell = tr.querySelector(".next");
      if (!rule || !cell) return;
      const d = describeNext(nextOccurrence(rule, now), now);
      const html = `<div class="when ${d.when === "On air now" ? "live" : ""}">${escapeHtml(d.when)}</div><div class="cd">${escapeHtml(d.countdown)}${this._draft.enabled ? "" : " · scheduling off"}</div>`;
      if (cell.innerHTML !== html) cell.innerHTML = html;
    });
    const nx = root.querySelector(".nextp-txt");
    if (nx && this._editing) {
      const occ = this._editorProblem() ? null : nextOccurrence(this._editing.rule, now);
      if (!occ) nx.textContent = "Next occurrence: —";
      else {
        const d = describeNext(occ, now);
        nx.textContent = `Next occurrence: ${d.when} (${d.countdown})${this._draft.enabled ? "" : " — scheduling is off for this channel"}`;
      }
    }
  }
}

customElements.define("bump-schedule-workspace", BumpScheduleWorkspace);
