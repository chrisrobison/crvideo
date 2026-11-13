// cf-series-admin — the SERIES tab: "Series Review".
//
// A three-pane workspace (series library | episodes of the selected series |
// episode details with an Approve/Reject decision), matching the ChannelFlow
// revamp mockups. Data and writes are unchanged from the previous
// single-column version: every series/*/series.json is listed server-side by
// server/series-admin.php (this component never hardcodes series ids), an
// editor changes an episode's editorial status and content rights through
// `save_episode`, and can trigger a youtube-import.php refresh or a
// brand-new import.
//
// Episode descriptions are not part of series-admin's (6 MB) list payload, so
// they are lazily loaded per series from the read-only explorer-admin.php
// projection when a series is opened.
//
// No access control: see docs/admin-ui.md. Anyone who can load this page
// can approve/reject episodes and trigger real API calls from here.

import { baseComponentCSS, escapeHtml, toast } from "../utils.js";
import { seriesAdminApi, explorerAdminApi } from "../admin-api.js";
import { TOPICS, subscribe } from "../../../js/bus.js";
import { icon, uiKitCSS, thumbHtml, wireMenus } from "./ui-kit.js";

const STATUS_VALUES = ["candidate", "approved", "rejected", "disabled"];
const STATUS_LABEL = { candidate: "Candidate", approved: "Approved", rejected: "Rejected", disabled: "Disabled" };
const RIGHTS_VALUES = ["unverified", "creator_permission", "licensed", "public_domain", "restricted"];
const PAGE_SIZE = 10;

/** m:ss, or h:mm:ss from an hour up -- the compact form the mockups use. */
function fmtHMS(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

function counts(s) {
  const c = { approved: 0, candidate: 0, rejected: 0, disabled: 0 };
  for (const ep of s.episodes) c[ep.status] = (c[ep.status] || 0) + 1;
  return c;
}

/** Library dot: amber = something still to review, green = fully reviewed with approvals, grey = nothing approved. */
function seriesDot(s) {
  const c = counts(s);
  if (c.candidate > 0) return "warn";
  if (c.approved > 0) return "good";
  return "off";
}

function epLabel(ep, i) {
  const n = ep.episode_number ?? i + 1;
  return `Ep. ${String(n).padStart(2, "0")}`;
}

/** An embeddable player URL for an episode, or null when the source has none. */
function embedUrl(ep) {
  const url = ep.source?.url || "";
  let m = url.match(/[?&]v=([\w-]{6,})/) || url.match(/youtu\.be\/([\w-]{6,})/);
  if (m && ep.source?.provider === "youtube") return `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1&rel=0`;
  m = url.match(/archive\.org\/details\/([^/?#]+)/);
  if (m) return `https://archive.org/embed/${m[1]}`;
  return null;
}

class CfSeriesAdmin extends HTMLElement {
  constructor() {
    super();
    this._series = [];
    this._loading = true;
    this._error = null;
    this._busy = new Set();
    this._output = new Map(); // series id -> last CLI output text
    this._descs = new Map(); // series id -> Map(episode id -> description)
    this._selSeries = null;
    this._selEp = null;
    this._chip = "all";
    this._libSearch = "";
    this._epSearch = "";
    this._epStatus = "all";
    this._epSort = "number";
    this._sortDir = 1;
    this._tab = "episodes";
    this._page = 0;
    this._checked = new Set();
    this._playing = false;
  }

  connectedCallback() {
    this._ctl = new AbortController();
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._render();
    }
    // Explorer hand-off: reveal a series/episode. Pure navigation -- never edits anything.
    subscribe(TOPICS.SERIES_REVIEW_OPEN, ({ data }) => {
      if (typeof data?.seriesId !== "string") return;
      this._pendingFocus = { seriesId: data.seriesId, episodeId: typeof data.episodeId === "string" ? data.episodeId : null };
      this._applyFocus();
    }, { signal: this._ctl.signal });
    if (!this._series.length) this.reload();
  }

  disconnectedCallback() { this._ctl?.abort(); }

  _applyFocus() {
    const f = this._pendingFocus;
    if (!f || !this._series.length) return;
    const s = this._series.find((x) => x.id === f.seriesId);
    if (!s) return;
    this._pendingFocus = null;
    this._chip = "all"; this._libSearch = ""; this._epSearch = ""; this._epStatus = "all"; this._tab = "episodes";
    this._selectSeries(s.id, { keepPage: true });
    if (f.episodeId) {
      const list = this._filteredEpisodes(s);
      const idx = list.findIndex((e) => e.id === f.episodeId);
      if (idx >= 0) { this._page = Math.floor(idx / PAGE_SIZE); this._selEp = f.episodeId; }
    }
    this._renderAll();
    this.shadowRoot.querySelector(`.series-row[data-id="${cssEscape(s.id)}"]`)?.scrollIntoView({ block: "nearest" });
    this.shadowRoot.querySelector(`.ep-row[data-ep="${cssEscape(f.episodeId || "")}"]`)?.scrollIntoView({ block: "nearest" });
  }

  async reload() {
    this._loading = true;
    this._error = null;
    this._renderAll();
    try {
      this._series = await seriesAdminApi.list();
      if (!this._selSeries || !this._series.some((s) => s.id === this._selSeries)) {
        const first = this._series.find((s) => counts(s).candidate > 0) || this._series[0];
        if (first) this._selectSeries(first.id);
      } else {
        this._loadDescs(this._selSeries);
      }
    } catch (e) {
      this._error = e.message;
    }
    this._loading = false;
    this._renderAll();
    this._applyFocus();
  }

  _selectSeries(id, { keepPage = false } = {}) {
    this._selSeries = id;
    if (!keepPage) this._page = 0;
    this._checked.clear();
    this._playing = false;
    const s = this._current();
    const list = s ? this._filteredEpisodes(s) : [];
    this._selEp = list[0]?.id ?? null;
    if (s) this._loadDescs(id);
  }

  async _loadDescs(id) {
    if (this._descs.has(id)) return;
    this._descs.set(id, new Map());
    try {
      const full = await explorerAdminApi.series(id);
      this._descs.set(id, new Map((full.episodes || []).map((e) => [e.id, e.description || ""])));
      if (this._selSeries === id) { this._renderEpisodes(); this._renderDetail(); }
    } catch { /* descriptions are optional garnish; the review works without them */ }
  }

  _current() { return this._series.find((s) => s.id === this._selSeries) || null; }

  _filteredEpisodes(s) {
    const q = this._epSearch.trim().toLowerCase();
    let list = s.episodes.map((e, i) => ({ e, i }));
    if (this._epStatus !== "all") list = list.filter(({ e }) => e.status === this._epStatus);
    if (q) list = list.filter(({ e }) => e.title.toLowerCase().includes(q));
    const dir = this._sortDir;
    const cmp = {
      number: (a, b) => ((a.e.episode_number ?? a.i) - (b.e.episode_number ?? b.i)) * dir,
      published: (a, b) => String(b.e.published_at || "").localeCompare(String(a.e.published_at || "")) * dir,
      duration: (a, b) => ((a.e.duration || 0) - (b.e.duration || 0)) * dir,
      title: (a, b) => a.e.title.localeCompare(b.e.title) * dir,
    }[this._epSort];
    list.sort(cmp);
    return list.map(({ e, i }) => Object.assign(e, { _idx: i }));
  }

  // ---------- skeleton ----------

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        ${uiKitCSS}
        .workspace{ grid-template-columns:330px minmax(0,1fr) 400px; }
        .lib-tools{ padding:0 14px 12px; display:flex; flex-direction:column; gap:10px; }
        .series-row{ display:flex; align-items:center; gap:12px; padding:9px 14px; cursor:pointer; border-bottom:1px solid var(--border-soft); }
        .series-row:hover{ background:rgba(74,127,216,.07); }
        .series-row.on{ background:rgba(74,127,216,.22); box-shadow:inset 0 0 0 1px var(--accent-line); border-radius:11px; margin:2px 8px; padding:9px 8px; border-bottom-color:transparent; }
        .series-row .thumb{ width:52px; height:52px; border-radius:9px; }
        .series-row .meta{ flex:1; min-width:0; }
        .series-row .t{ font-weight:650; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .series-row .s{ color:var(--text-muted); font-size:12.5px; }
        .dot{ width:9px; height:9px; border-radius:50%; flex-shrink:0; }
        .dot.good{ background:var(--good); box-shadow:0 0 7px rgba(34,197,94,.7); }
        .dot.warn{ background:#facc15; box-shadow:0 0 7px rgba(250,204,21,.6); }
        .dot.off{ background:var(--text-faint); }
        .series-head{ display:flex; gap:14px; align-items:center; padding:16px 18px 12px; }
        .series-head .thumb{ width:58px; height:58px; border-radius:10px; }
        .series-head h2{ margin:0; font-size:22px; font-weight:750; letter-spacing:-.01em; }
        .series-head .stats{ margin-top:3px; color:var(--text-muted); font-size:13px; display:flex; gap:8px; flex-wrap:wrap; }
        .series-head .stats i{ font-style:normal; opacity:.5; }
        .ep-tools{ display:flex; gap:10px; padding:12px 14px; }
        .ep-tools .search{ flex:1; }
        .ep-tools select{ width:auto; min-width:140px; }
        .sortdir{ width:34px; padding:0; }
        .ep-list{ flex:1; min-height:0; overflow:auto; padding:0 10px 6px; }
        .ep-row{ display:flex; align-items:center; gap:12px; padding:9px 10px; border-radius:11px; cursor:pointer; border:1px solid transparent; border-bottom-color:var(--border-soft); }
        .ep-row:hover{ background:rgba(74,127,216,.07); }
        .ep-row.on{ background:rgba(74,127,216,.2); border-color:var(--accent-line); }
        .ep-thumb{ position:relative; width:100px; height:56px; flex-shrink:0; }
        .ep-thumb .thumb{ width:100%; height:100%; }
        .ep-thumb .dur{ position:absolute; left:5px; bottom:4px; font-size:11px; font-weight:700; background:rgba(0,0,0,.72); padding:1px 5px; border-radius:4px; }
        .ep-main{ flex:1; min-width:0; }
        .ep-title{ font-size:14.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .ep-title b{ color:var(--text-muted); font-weight:600; margin-right:10px; }
        .ep-desc{ color:var(--text-muted); font-size:12.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
        .ep-row .pill{ min-width:92px; justify-content:center; }
        .row-menu button.icon{ background:transparent; border:0; width:30px; height:30px; color:var(--text-muted); }
        .bulk{ gap:10px; }
        .bulk .count{ color:var(--text-muted); font-size:13px; display:flex; align-items:center; gap:9px; }
        .pager{ margin-left:auto; display:flex; align-items:center; gap:8px; color:var(--text-muted); font-size:13px; }
        .pager button{ width:30px; height:30px; padding:0; }
        .detail-body{ padding:0 16px 16px; display:flex; flex-direction:column; gap:12px; }
        .detail-body > *{ flex-shrink:0; }
        .kv svg{ display:inline-block; vertical-align:-2px; }
        .player{ position:relative; aspect-ratio:16/9; border-radius:12px; overflow:hidden; background:#05070f; border:1px solid var(--border); }
        .player .thumb{ width:100%; height:100%; border-radius:0; }
        .player iframe{ width:100%; height:100%; border:0; }
        .player .big-play{ position:absolute; inset:0; display:grid; place-items:center; background:linear-gradient(180deg, transparent 55%, rgba(0,0,0,.55)); cursor:pointer; border:0; border-radius:0; }
        .player .big-play span{ width:62px; height:62px; border-radius:50%; display:grid; place-items:center; background:rgba(15,18,40,.72); border:2px solid rgba(255,255,255,.85); }
        .player .big-play:hover span{ background:var(--accent); }
        .player .bar{ position:absolute; left:0; right:0; bottom:0; display:flex; align-items:center; gap:10px; padding:8px 12px; font-size:12px; font-variant-numeric:tabular-nums; pointer-events:none; }
        .detail h3{ margin:4px 0 0; font-size:20px; font-weight:750; letter-spacing:-.01em; }
        .detail .kv{ margin-top:2px; }
        .desc{ border-top:1px solid var(--border-soft); padding-top:10px; }
        .desc h4, .rights h4{ margin:0 0 6px; font-size:14px; font-weight:700; }
        .desc p{ margin:0; color:#d6dbef; font-size:13.5px; line-height:1.5; max-height:150px; overflow:auto; white-space:pre-wrap; }
        details.rights{ border-top:1px solid var(--border-soft); padding-top:10px; }
        details.rights summary{ cursor:pointer; list-style:none; display:flex; align-items:center; gap:8px; font-size:14px; font-weight:700; }
        details.rights summary::-webkit-details-marker{ display:none; }
        details.rights[open] summary .chev{ transform:rotate(180deg); }
        details.rights .fields{ display:grid; grid-template-columns:1fr 1fr auto; gap:8px; align-items:end; margin-top:10px; }
        .rights label{ font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; display:flex; flex-direction:column; gap:5px; }
        .decision{ border-top:1px solid var(--border-soft); margin:0 16px; padding:12px 0; display:flex; align-items:center; gap:12px; flex-shrink:0; }
        .decision h4{ margin:0; font-size:15px; }
        .decision-btns{ display:grid; grid-template-columns:1fr 1fr; gap:12px; padding:0 16px 16px; flex-shrink:0; }
        .desc p{ max-height:110px !important; }
        .decision-btns button{ padding:12px; font-size:15px; }
        .decision-btns .primary{ box-shadow:0 6px 20px rgba(74,127,216,.4); }
        .tab-pane{ padding:16px 18px; overflow:auto; flex:1; min-height:0; }
        .stat-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:16px; }
        .stat{ background:rgba(10,13,28,.55); border:1px solid var(--border); border-radius:11px; padding:12px; }
        .stat b{ display:block; font-size:22px; }
        .stat span{ color:var(--text-muted); font-size:12px; }
        .actions-row{ display:flex; gap:8px; flex-wrap:wrap; margin:12px 0; align-items:center; }
        .import-form{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
        .import-form .wide{ grid-column:1/-1; }
        .import-form label.field{ margin:0; }
        .hint{ color:var(--text-muted); font-size:12px; }
      </style>
      <div class="page-head">
        <div class="head-ico">${icon("clapper", 34)}</div>
        <div><h1>Series Review</h1><p>Import, review, and manage series and episodes</p></div>
        <div class="spacer"></div>
        <button class="primary import-btn">${icon("upload", 17)} Import Series…</button>
      </div>
      <div class="workspace">
        <section class="panel lib">
          <div class="panel-head"><h2>Series Library <span class="count lib-count"></span></h2><span style="flex:1"></span>
            <button class="outline sm new-btn">${icon("plus", 15)} New</button></div>
          <div class="lib-tools">
            <div class="search">${icon("search", 17)}<input class="lib-search" placeholder="Search series..."></div>
            <div class="chip-row lib-chips"></div>
          </div>
          <div class="panel-body lib-list"></div>
        </section>
        <section class="panel center"></section>
        <section class="panel detail"></section>
      </div>
      <dialog class="import-dlg">
        <div class="dlg-head"><h2>Import new series</h2><button class="icon close-import" aria-label="Close">${icon("x", 17)}</button></div>
        <div class="dlg-body">
          <div class="import-form">
            <label class="field">New series id<div class="field-value"><input class="new-id" placeholder="e.g. my-new-show"></div></label>
            <label class="field">Source kind<div class="field-value">
              <select class="source-kind"><option value="channel">Channel @handle</option><option value="channel_id">Channel UC… id</option><option value="playlist">Playlist id</option></select>
            </div></label>
            <label class="field wide">Source value<div class="field-value"><input class="source-value" placeholder="@SomeChannel"></div></label>
            <label class="field wide">Title override (optional)<div class="field-value"><input class="title-override"></div></label>
          </div>
          <div class="actions-row">
            <button class="preview-import-btn">Preview (dry run)</button>
            <button class="run-import-btn primary">Import for real</button>
          </div>
          <p class="hint">Needs YOUTUBE_API_KEY (or youtube-import/config.local.php) configured for the web server process.</p>
          <pre class="output import-output hidden"></pre>
        </div>
      </dialog>
    `;
    const root = this.shadowRoot;
    root.querySelector(".lib-search").addEventListener("input", (e) => { this._libSearch = e.target.value; this._renderLibrary(); });
    root.querySelector(".lib-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-chip]");
      if (b) { this._chip = b.dataset.chip; this._renderLibrary(); }
    });
    root.querySelector(".lib-list").addEventListener("click", (e) => {
      const row = e.target.closest(".series-row");
      if (!row) return;
      this._selectSeries(row.dataset.id);
      this._tab = "episodes";
      this._renderAll();
    });
    const dlg = root.querySelector(".import-dlg");
    const openImport = () => dlg.showModal();
    root.querySelector(".import-btn").addEventListener("click", openImport);
    root.querySelector(".new-btn").addEventListener("click", openImport);
    root.querySelector(".close-import").addEventListener("click", () => dlg.close());
    root.querySelector(".preview-import-btn").addEventListener("click", () => this._runImport(true));
    root.querySelector(".run-import-btn").addEventListener("click", () => this._runImport(false));
  }

  async _runImport(dryRun) {
    const form = this.shadowRoot.querySelector(".import-dlg");
    const newId = form.querySelector(".new-id").value.trim();
    const kind = form.querySelector(".source-kind").value;
    const value = form.querySelector(".source-value").value.trim();
    const title = form.querySelector(".title-override").value.trim();
    if (!newId || !value) { toast("Series id and source value are required.", "danger"); return; }
    const payload = { series_id: newId, dry_run: dryRun, [kind]: value };
    if (title) payload.title = title;
    const out = form.querySelector(".import-output");
    out.classList.remove("hidden");
    out.textContent = "Running…";
    try {
      const result = await seriesAdminApi.newImport(payload);
      out.textContent = `exit code: ${result.exitCode}\n\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`;
      if (result.exitCode === 0) {
        toast(dryRun ? "Preview succeeded -- nothing written yet." : "Import complete.", "good");
        if (!dryRun) this.reload();
      } else {
        toast("Import reported an error -- see output below.", "danger");
      }
    } catch (e) {
      out.textContent = e.message;
      toast(e.message, "danger");
    }
  }

  // ---------- renderers ----------

  _renderAll() {
    this._renderLibrary();
    this._renderCenter();
    this._renderDetail();
  }

  _renderLibrary() {
    const root = this.shadowRoot;
    const all = this._series;
    root.querySelector(".lib-count").textContent = all.length ? `(${all.length})` : "";
    const needs = all.filter((s) => counts(s).candidate > 0).length;
    const chips = [
      ["all", "All", null],
      ["needs", "Needs Review", needs],
      ["approved", "Approved", null],
      ["rejected", "Rejected", null],
    ];
    root.querySelector(".lib-chips").innerHTML = chips.map(([k, label, n]) =>
      `<button class="chip ${this._chip === k ? "on" : ""}" data-chip="${k}">${label}${n != null ? `<span class="n">${n}</span>` : ""}</button>`).join("");
    const list = root.querySelector(".lib-list");
    if (this._loading) { list.innerHTML = `<div class="empty">Loading…</div>`; return; }
    if (this._error) { list.innerHTML = `<div class="error">Could not load series: ${escapeHtml(this._error)}</div>`; return; }
    const q = this._libSearch.trim().toLowerCase();
    const shown = all.filter((s) => {
      const c = counts(s);
      if (this._chip === "needs" && !c.candidate) return false;
      if (this._chip === "approved" && !(c.approved && !c.candidate)) return false;
      if (this._chip === "rejected" && !c.rejected) return false;
      return !q || s.title.toLowerCase().includes(q) || s.id.includes(q);
    });
    if (!shown.length) { list.innerHTML = `<div class="empty">${all.length ? "No series match." : "No series found under series/*/series.json yet."}</div>`; return; }
    list.innerHTML = shown.map((s) => `
      <div class="series-row ${s.id === this._selSeries ? "on" : ""}" data-id="${escapeHtml(s.id)}">
        ${thumbHtml(s.thumbnail_url)}
        <div class="meta"><div class="t">${escapeHtml(s.title)}</div><div class="s">${s.episode_count} episode${s.episode_count === 1 ? "" : "s"}</div></div>
        ${s.id === this._selSeries ? `<span style="color:var(--text-muted)">${icon("right", 16)}</span>` : `<span class="dot ${seriesDot(s)}" title="${seriesDot(s) === "warn" ? "Has candidates to review" : seriesDot(s) === "good" ? "Reviewed" : "Nothing approved"}"></span>`}
      </div>`).join("");
  }

  _renderCenter() {
    const root = this.shadowRoot;
    const center = root.querySelector(".center");
    const s = this._current();
    if (!s) { center.innerHTML = `<div class="empty">${this._loading ? "Loading…" : "Select a series."}</div>`; return; }
    const c = counts(s);
    center.innerHTML = `
      <div class="series-head">
        ${thumbHtml(s.thumbnail_url)}
        <div style="flex:1;min-width:0">
          <h2>${escapeHtml(s.title)}</h2>
          <div class="stats"><span>${s.episode_count} episodes</span><i>•</i><span>${c.approved} approved</span><i>•</i><span>${c.candidate} candidates</span>${c.rejected ? `<i>•</i><span>${c.rejected} rejected</span>` : ""}${c.disabled ? `<i>•</i><span>${c.disabled} disabled</span>` : ""}</div>
        </div>
        <div class="menu head-menu"><button class="icon" aria-label="Series actions">${icon("more", 18)}</button>
          <div class="menu-pop">
            <button data-act="refresh-preview">${icon("eye", 16)} Preview refresh</button>
            <button data-act="refresh-run">${icon("repeat", 16)} Run refresh</button>
            ${s.source?.channel_url ? `<hr><button data-act="open-source">${icon("external", 16)} Open source channel</button>` : ""}
          </div></div>
      </div>
      <div class="tabs line-tabs">
        <button data-tab="episodes" class="${this._tab === "episodes" ? "on" : ""}">${icon("list", 16)} Episodes</button>
        <button data-tab="details" class="${this._tab === "details" ? "on" : ""}">${icon("info", 16)} Series Details</button>
        <button data-tab="history" class="${this._tab === "history" ? "on" : ""}">${icon("history", 16)} Import History</button>
      </div>
      <div class="ep-pane" style="display:${this._tab === "episodes" ? "flex" : "none"};flex-direction:column;flex:1;min-height:0">
        <div class="ep-tools">
          <div class="search">${icon("search", 17)}<input class="ep-search" placeholder="Search episodes..." value="${escapeHtml(this._epSearch)}"></div>
          <select class="ep-status">
            <option value="all">All Statuses</option>
            ${STATUS_VALUES.map((v) => `<option value="${v}" ${this._epStatus === v ? "selected" : ""}>${STATUS_LABEL[v]}</option>`).join("")}
          </select>
          <select class="ep-sort">
            ${[["number", "Episode #"], ["published", "Published"], ["duration", "Duration"], ["title", "Title"]].map(([k, l]) => `<option value="${k}" ${this._epSort === k ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          <button class="icon sortdir" title="Reverse order">${icon(this._sortDir > 0 ? "up" : "down", 16)}</button>
        </div>
        <div class="ep-list"></div>
        <div class="panel-foot bulk"></div>
      </div>
      <div class="tab-pane details-pane" style="display:${this._tab === "details" ? "block" : "none"}"></div>
      <div class="tab-pane history-pane" style="display:${this._tab === "history" ? "block" : "none"}"></div>
    `;
    wireMenus(center, this._ctl.signal);
    center.querySelector(".tabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab]");
      if (b) { this._tab = b.dataset.tab; this._renderCenter(); }
    });
    center.querySelector(".head-menu .menu-pop").addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "refresh-preview") this._runRefresh(s.id, true);
      if (act === "refresh-run") this._runRefresh(s.id, false);
      if (act === "open-source") window.open(s.source.channel_url, "_blank", "noopener");
    });
    center.querySelector(".ep-search").addEventListener("input", (e) => { this._epSearch = e.target.value; this._page = 0; this._renderEpisodes(); });
    center.querySelector(".ep-status").addEventListener("change", (e) => { this._epStatus = e.target.value; this._page = 0; this._renderEpisodes(); });
    center.querySelector(".ep-sort").addEventListener("change", (e) => { this._epSort = e.target.value; this._page = 0; this._renderEpisodes(); });
    center.querySelector(".sortdir").addEventListener("click", (e) => {
      this._sortDir *= -1;
      e.currentTarget.innerHTML = icon(this._sortDir > 0 ? "up" : "down", 16);
      this._renderEpisodes();
    });
    center.querySelector(".ep-list").addEventListener("click", (e) => this._onEpListClick(e));
    center.querySelector(".bulk").addEventListener("click", (e) => this._onBulkClick(e));
    this._renderEpisodes();
    this._renderDetailsPane();
    this._renderHistoryPane();
  }

  _renderEpisodes() {
    const root = this.shadowRoot;
    const s = this._current();
    const listEl = root.querySelector(".ep-list");
    if (!s || !listEl) return;
    const list = this._filteredEpisodes(s);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    this._page = Math.min(this._page, pages - 1);
    const slice = list.slice(this._page * PAGE_SIZE, this._page * PAGE_SIZE + PAGE_SIZE);
    const descs = this._descs.get(s.id);
    listEl.innerHTML = slice.length ? slice.map((ep) => {
      const desc = descs?.get(ep.id)?.replace(/\s+/g, " ").trim() || "";
      return `
      <div class="ep-row ${ep.id === this._selEp ? "on" : ""}" data-ep="${escapeHtml(ep.id)}">
        <input type="checkbox" class="ep-check" ${this._checked.has(ep.id) ? "checked" : ""} aria-label="Select episode">
        <div class="ep-thumb">${thumbHtml(ep.thumbnail_url)}${ep.duration ? `<span class="dur">${fmtHMS(ep.duration)}</span>` : ""}</div>
        <div class="ep-main">
          <div class="ep-title"><b>${epLabel(ep, ep._idx)}</b>${escapeHtml(ep.title)}</div>
          <div class="ep-desc">${escapeHtml(desc || ep.rights?.notes || `${fmtDate(ep.published_at)} · ${ep.source?.provider || "unknown"}`)}</div>
        </div>
        ${ep.source?.availability && ep.source.availability !== "available" ? `<span class="pill" data-tone="warn" title="Source availability">${escapeHtml(ep.source.availability)}</span>` : ""}
        <span class="pill" data-tone="${ep.status}">${STATUS_LABEL[ep.status] || escapeHtml(ep.status)}</span>
        <div class="menu row-menu"><button class="icon" aria-label="Episode actions">${icon("more", 18)}</button>
          <div class="menu-pop">${STATUS_VALUES.filter((v) => v !== ep.status).map((v) => `<button data-set="${v}">${v === "approved" ? icon("check", 15) : v === "rejected" ? icon("x", 15) : v === "disabled" ? icon("alert", 15) : icon("undo", 15)} ${v === "candidate" ? "Reset to candidate" : STATUS_LABEL[v]}</button>`).join("")}</div>
        </div>
      </div>`;
    }).join("") : `<div class="empty">No episodes match.</div>`;
    wireMenus(listEl, this._ctl.signal);

    const nChecked = this._checked.size;
    const pageAll = slice.length > 0 && slice.every((e) => this._checked.has(e.id));
    root.querySelector(".bulk").innerHTML = `
      <div class="count"><input type="checkbox" class="check-all" ${pageAll ? "checked" : ""} aria-label="Select page"> <span>${nChecked} selected</span></div>
      <button class="sm good" data-bulk="approved" ${nChecked ? "" : "disabled"}>Approve</button>
      <button class="sm bad" data-bulk="rejected" ${nChecked ? "" : "disabled"}>Reject</button>
      <div class="menu"><button class="sm" ${nChecked ? "" : "disabled"}>More Actions ${icon("down", 14)}</button>
        <div class="menu-pop" style="bottom:calc(100% + 6px);top:auto;right:auto;left:0">
          <button data-bulk="disabled">${icon("alert", 15)} Disable</button>
          <button data-bulk="candidate">${icon("undo", 15)} Reset to candidate</button>
          <hr><button data-bulk-clear>${icon("x", 15)} Clear selection</button>
        </div></div>
      <div class="pager">
        <span>${list.length ? `${this._page * PAGE_SIZE + 1}–${Math.min(list.length, (this._page + 1) * PAGE_SIZE)} of ${list.length}` : "0 of 0"}</span>
        <button class="icon prev" ${this._page === 0 ? "disabled" : ""}>${icon("left", 15)}</button>
        <button class="icon next" ${this._page >= pages - 1 ? "disabled" : ""}>${icon("right", 15)}</button>
      </div>`;
    wireMenus(root.querySelector(".bulk"), this._ctl.signal);
    // Keep a valid selection for the detail pane.
    if (!list.some((e) => e.id === this._selEp)) {
      this._selEp = slice[0]?.id ?? null;
      this._playing = false;
      this._renderDetail();
    }
  }

  _onEpListClick(e) {
    const s = this._current();
    const row = e.target.closest(".ep-row");
    if (!row || !s) return;
    const id = row.dataset.ep;
    const setBtn = e.target.closest("[data-set]");
    if (setBtn) { this._setStatus(s, [id], setBtn.dataset.set); return; }
    if (e.target.closest(".row-menu")) return;
    if (e.target.classList.contains("ep-check")) {
      if (e.target.checked) this._checked.add(id); else this._checked.delete(id);
      this._renderEpisodes();
      return;
    }
    if (this._selEp !== id) { this._selEp = id; this._playing = false; }
    this._renderEpisodes();
    this._renderDetail();
  }

  _onBulkClick(e) {
    const s = this._current();
    if (!s) return;
    if (e.target.classList.contains("check-all")) {
      const list = this._filteredEpisodes(s).slice(this._page * PAGE_SIZE, this._page * PAGE_SIZE + PAGE_SIZE);
      for (const ep of list) { if (e.target.checked) this._checked.add(ep.id); else this._checked.delete(ep.id); }
      this._renderEpisodes();
      return;
    }
    if (e.target.closest(".prev")) { this._page = Math.max(0, this._page - 1); this._renderEpisodes(); return; }
    if (e.target.closest(".next")) { this._page += 1; this._renderEpisodes(); return; }
    if (e.target.closest("[data-bulk-clear]")) { this._checked.clear(); this._renderEpisodes(); return; }
    const b = e.target.closest("[data-bulk]");
    if (b && this._checked.size) this._setStatus(s, [...this._checked], b.dataset.bulk);
  }

  _renderDetailsPane() {
    const pane = this.shadowRoot.querySelector(".details-pane");
    const s = this._current();
    if (!pane || !s) return;
    const c = counts(s);
    const dates = s.episodes.map((e) => e.published_at).filter(Boolean).sort();
    pane.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><b>${s.episode_count}</b><span>Episodes</span></div>
        <div class="stat"><b style="color:#8fe3ac">${c.approved}</b><span>Approved</span></div>
        <div class="stat"><b style="color:#f6c27d">${c.candidate}</b><span>Candidates</span></div>
        <div class="stat"><b style="color:#ffa6a6">${c.rejected + c.disabled}</b><span>Rejected / disabled</span></div>
      </div>
      <div class="kv">
        <div>Series id</div><div>${escapeHtml(s.id)}</div>
        <div>Provider</div><div>${escapeHtml(s.source?.provider || "unknown")}</div>
        <div>Source</div><div>${s.source?.channel_url ? `<a href="${escapeHtml(s.source.channel_url)}" target="_blank" rel="noopener">${escapeHtml(s.source.channel_url)}</a>` : "—"}</div>
        ${s.source?.playlist_id ? `<div>Playlist</div><div>${escapeHtml(s.source.playlist_id)}</div>` : ""}
        <div>Published range</div><div>${dates.length ? `${fmtDate(dates[0])} → ${fmtDate(dates[dates.length - 1])}` : "—"}</div>
        <div>Description</div><div>${escapeHtml(s.description || "—")}</div>
      </div>
      <div class="actions-row">
        <button class="preview-refresh-btn" ${this._busy.has(s.id) ? "disabled" : ""}>${icon("eye", 15)} Preview refresh</button>
        <button class="run-refresh-btn primary" ${this._busy.has(s.id) ? "disabled" : ""}>${icon("repeat", 15)} Run refresh</button>
      </div>
      <p class="hint">Refresh re-fetches from this series' own recorded YouTube source; it never writes status or rights.</p>`;
    pane.querySelector(".preview-refresh-btn").addEventListener("click", () => this._runRefresh(s.id, true));
    pane.querySelector(".run-refresh-btn").addEventListener("click", () => this._runRefresh(s.id, false));
  }

  _renderHistoryPane() {
    const pane = this.shadowRoot.querySelector(".history-pane");
    const s = this._current();
    if (!pane || !s) return;
    const out = this._output.get(s.id);
    pane.innerHTML = out
      ? `<div class="hint">Most recent refresh run from this browser session:</div><pre class="output">${escapeHtml(out)}</pre>`
      : `<div class="empty">No refresh has been run for this series in this session.<br><span class="hint">Use ⋯ → Preview refresh / Run refresh. Output appears here.</span></div>`;
  }

  _renderDetail() {
    const root = this.shadowRoot;
    const panel = root.querySelector(".detail");
    const s = this._current();
    const list = s ? this._filteredEpisodes(s) : [];
    const idx = list.findIndex((e) => e.id === this._selEp);
    const ep = idx >= 0 ? list[idx] : null;
    if (!s || !ep) {
      panel.innerHTML = `<div class="panel-head"><h2><span style="color:var(--accent-hi)">${icon("play", 18)}</span> Episode Details</h2></div><div class="empty">Select an episode.</div>`;
      return;
    }
    const desc = this._descs.get(s.id)?.get(ep.id) || "";
    const embed = this._playing ? embedUrl(ep) : null;
    const rights = ep.rights?.status || "unverified";
    const pendingTone = ep.status === "candidate" ? "Review pending" : STATUS_LABEL[ep.status] || ep.status;
    panel.innerHTML = `
      <div class="panel-head"><h2><span style="color:var(--accent-hi)">${icon("play", 18)}</span> Episode Details</h2><span style="flex:1"></span>
        <button class="icon sm prev-ep" ${idx <= 0 ? "disabled" : ""} aria-label="Previous episode">${icon("left", 16)}</button>
        <button class="icon sm next-ep" ${idx >= list.length - 1 ? "disabled" : ""} aria-label="Next episode">${icon("right", 16)}</button></div>
      <div class="panel-body detail-body">
        <div class="player">
          ${embed ? `<iframe src="${escapeHtml(embed)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`
            : `${thumbHtml(ep.thumbnail_url)}
              <button class="big-play" aria-label="Play">${`<span>${icon("play", 26)}</span>`}</button>
              <div class="bar"><span>0:00 / ${ep.duration ? fmtHMS(ep.duration) : "—"}</span><span style="flex:1"></span>${icon("volume", 16)}${icon("external", 16)}</div>`}
        </div>
        <h3>${epLabel(ep, ep._idx)} – ${escapeHtml(ep.title)}</h3>
        <div class="kv">
          <div>Series</div><div>${escapeHtml(s.title)}</div>
          <div>Duration</div><div>${ep.duration ? fmtHMS(ep.duration) : "unknown"}</div>
          <div>Source</div><div>${escapeHtml(ep.source?.provider || "unknown")} ${ep.source?.url ? `<a href="${escapeHtml(ep.source.url)}" target="_blank" rel="noopener" title="Open source">${icon("external", 14)}</a>` : ""}</div>
          <div>Aired</div><div>${fmtDate(ep.published_at)}</div>
        </div>
        ${desc ? `<div class="desc"><h4>Description</h4><p>${escapeHtml(desc)}</p></div>` : ""}
        <details class="rights">
          <summary>Content rights <span class="pill" data-tone="neutral">${escapeHtml(rights)}</span><span style="flex:1"></span><span class="chev" style="color:var(--text-muted)">${icon("down", 16)}</span></summary>
          <div class="fields">
            <label class="field" style="margin:0">Status<div class="field-value"><select class="rights-select">${RIGHTS_VALUES.map((v) => `<option value="${v}" ${v === rights ? "selected" : ""}>${v}</option>`).join("")}</select></div></label>
            <label class="field" style="margin:0">Notes<div class="field-value"><input class="rights-notes" value="${escapeHtml(ep.rights?.notes || "")}"></div></label>
            <button class="save-rights sm">Save</button>
          </div>
        </details>
      </div>
      <div class="decision"><h4>Editorial Decision</h4>
        <span class="pill" data-tone="${ep.status}">${escapeHtml(pendingTone)}</span>
        <span title="Approving makes an episode eligible for scheduling; rejected episodes are never scheduled." style="color:var(--text-muted)">${icon("info", 16)}</span></div>
      <div class="decision-btns">
        <button class="outline reject-btn">${icon("x", 17)} Reject</button>
        <button class="primary approve-btn">${icon("check", 17)} Approve</button>
      </div>`;
    panel.querySelector(".prev-ep").addEventListener("click", () => this._stepEp(-1));
    panel.querySelector(".next-ep").addEventListener("click", () => this._stepEp(1));
    panel.querySelector(".big-play")?.addEventListener("click", () => {
      if (embedUrl(ep)) { this._playing = true; this._renderDetail(); }
      else if (ep.source?.url) window.open(ep.source.url, "_blank", "noopener");
    });
    panel.querySelector(".approve-btn").addEventListener("click", () => this._setStatus(s, [ep.id], "approved"));
    panel.querySelector(".reject-btn").addEventListener("click", () => this._setStatus(s, [ep.id], "rejected"));
    panel.querySelector(".save-rights").addEventListener("click", () => this._saveRights(s, ep, panel));
  }

  _stepEp(delta) {
    const s = this._current();
    if (!s) return;
    const list = this._filteredEpisodes(s);
    const idx = list.findIndex((e) => e.id === this._selEp);
    const next = list[idx + delta];
    if (!next) return;
    this._selEp = next.id;
    this._playing = false;
    this._page = Math.floor((idx + delta) / PAGE_SIZE);
    this._renderEpisodes();
    this._renderDetail();
  }

  // ---------- writes (unchanged server contract) ----------

  async _persist(s, ep, status, rightsStatus, notes) {
    await seriesAdminApi.saveEpisode({ series_id: s.id, episode_id: ep.id, status, rights_status: rightsStatus, rights_notes: notes });
    ep.status = status;
    ep.rights = { status: rightsStatus, notes };
  }

  async _setStatus(s, ids, status) {
    const eps = ids.map((id) => s.episodes.find((e) => e.id === id)).filter(Boolean);
    let ok = 0;
    const failed = [];
    for (const ep of eps) {
      try {
        await this._persist(s, ep, status, ep.rights?.status || "unverified", ep.rights?.notes ?? null);
        ok++;
      } catch (e) {
        failed.push(e.message);
      }
    }
    for (const ep of eps) this._checked.delete(ep.id);
    if (ok) toast(`${ok} episode${ok === 1 ? "" : "s"} set to ${STATUS_LABEL[status].toLowerCase()}.`, "good");
    if (failed.length) toast(failed[0], "danger");
    // Auto-advance after a single decision in the detail pane so reviewing flows.
    if (ok === 1 && eps.length === 1 && this._selEp === eps[0].id && this._epStatus === "all" && (status === "approved" || status === "rejected")) this._stepEp(1);
    this._renderLibrary();
    this._renderCenterHead();
    this._renderEpisodes();
    this._renderDetail();
    this._renderDetailsPane();
  }

  _renderCenterHead() {
    const s = this._current();
    const stats = this.shadowRoot.querySelector(".series-head .stats");
    if (!s || !stats) return;
    const c = counts(s);
    stats.innerHTML = `<span>${s.episode_count} episodes</span><i>•</i><span>${c.approved} approved</span><i>•</i><span>${c.candidate} candidates</span>${c.rejected ? `<i>•</i><span>${c.rejected} rejected</span>` : ""}${c.disabled ? `<i>•</i><span>${c.disabled} disabled</span>` : ""}`;
  }

  async _saveRights(s, ep, panel) {
    const rights = panel.querySelector(".rights-select").value;
    const notes = panel.querySelector(".rights-notes").value.trim() || null;
    try {
      await this._persist(s, ep, ep.status, rights, notes);
      toast(`Saved rights for ${ep.id}.`, "good");
      this._renderEpisodes();
    } catch (e) {
      toast(e.message, "danger");
    }
  }

  async _runRefresh(seriesId, dryRun) {
    this._busy.add(seriesId);
    this._renderDetailsPane();
    try {
      toast(dryRun ? "Previewing refresh…" : "Refreshing from source…", "info");
      const result = await seriesAdminApi.refresh(seriesId, dryRun);
      this._output.set(seriesId, `exit code: ${result.exitCode}\n\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`);
      toast(result.exitCode === 0 ? (dryRun ? "Refresh preview complete." : "Refresh complete.") : "Refresh reported an error -- see Import History.", result.exitCode === 0 ? "good" : "danger");
    } catch (e) {
      this._output.set(seriesId, e.message);
      toast(e.message, "danger");
    }
    this._busy.delete(seriesId);
    this._tab = "history";
    if (!dryRun) await this.reload(); else this._renderCenter();
  }
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

customElements.define("cf-series-admin", CfSeriesAdmin);
