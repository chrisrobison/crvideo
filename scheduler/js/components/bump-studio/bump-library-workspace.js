// <bump-library-workspace> -- the Library tab: a management view of every
// saved bump (search, filters, list/grid), with a detail panel holding the
// tab's ONE <cr-bump> preview (channels/bump-player.js -- reused, never a
// second renderer; the definition is swapped by property assignment).
//
// Selection here is local to the Library (browsing never touches Compose's
// draft or trips its unsaved-changes guard). Double-click / Enter / "Open
// in Compose" publishes the `studio.compose.open` bus command (handled by
// store.openInCompose(), which does guard unsaved edits); "used by"
// channel chips publish `studio.schedule.open`. Rename / Duplicate /
// Delete go through the store's existing actions. Deleting a scheduled bump lists the
// affected channels and never edits their schedules (the backend doesn't
// either -- rules pointing at a deleted bump stay until removed in
// Schedule, and the player skips them).

import { escapeHtml, toast } from "../../utils.js";
import { studioStore as store, changeOf } from "./bump-studio-store.js";
import { TOPICS, publish, subscribe } from "../../../../js/bus.js";
import { studioCSS, icons, makeThumb, mediaUrl } from "./studio-ui.js";
import {
  fileLabel, bumpDuration, effectiveDuration, findAnnouncement, announcementTypeLabel, STYLE_DEFAULTS,
} from "./bump-model.js";
import { RECURRENCE_LABELS, formatOffset, formatDuration, channelInitials } from "./schedule-model.js";
import "../../../../channels/bump-player.js";

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  grid: svg(`<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>`),
  list: svg(`<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>`),
  link: svg(`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`),
  copy: svg(`<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>`),
  open: svg(`<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>`),
  warn: svg(`<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.01"/>`),
  palette: svg(`<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16" cy="10" r="1.2" fill="currentColor"/>`),
  clock: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`),
};
const VIEW_KEY = "bump-studio.library.view";
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const ext = (url) => (String(url || "").split("/").pop() || "");
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function readView() {
  try { return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list"; } catch { return "list"; }
}
function writeView(v) {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable: per-session only */ }
}

class BumpLibraryWorkspace extends HTMLElement {
  constructor() {
    super();
    this._q = "";
    this._filters = { bg: "", ann: "", ch: "" };
    this._sort = { key: "name", dir: 1 };
    this._view = readView();
    this._selected = null;
    this._renaming = null;
    this._menu = null; // {id, anchor}
    this._thumbs = new Map();
    this._bgDur = new Map(); // video url -> seconds (learned from thumbnails / the preview)
    this._muted = true;
  }

  connectedCallback() {
    if (this.shadowRoot) { this._listen(); return; }
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ${studioCSS}
        :host{ display:block; }
        .layout{ display:grid; grid-template-columns:minmax(0,1fr) 400px; gap:16px; padding:16px; align-items:start; }
        .panel{ background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); }
        .lib{ padding:16px 18px 18px; min-width:0; }
        .head{ display:flex; align-items:center; gap:12px; margin-bottom:14px; }
        .head h2{ margin:0; font-size:22px; }
        .count{ font-size:12.5px; padding:3px 10px; border-radius:999px; background:var(--panel-3); color:var(--text-muted); white-space:nowrap; }
        .new{ display:inline-flex; align-items:center; gap:8px; padding:9px 18px; }
        .new svg{ width:16px; height:16px; }
        .filters{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
        .filters .search{ flex:1 1 220px; min-width:180px; }
        .filters select{ width:auto; flex:0 1 auto; max-width:200px; }
        .seg button{ padding:6px 9px; display:flex; }
        .seg svg{ width:17px; height:17px; }
        table{ width:100%; border-collapse:collapse; font-size:13.5px; }
        th{ text-align:left; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted); font-weight:700; padding:8px 8px; border-bottom:1px solid var(--border); white-space:nowrap; }
        th button{ border:0; background:transparent; padding:0; font:inherit; color:inherit; letter-spacing:inherit; text-transform:inherit; display:inline-flex; gap:4px; align-items:center; }
        th button:hover{ color:var(--text); }
        td{ padding:8px 8px; border-bottom:1px solid var(--border-soft); vertical-align:middle; }
        tbody tr{ cursor:pointer; }
        tbody tr:hover td{ background:rgba(255,255,255,.02); }
        tbody tr[aria-selected="true"] td{ background:var(--accent-soft); }
        tbody tr[aria-selected="true"] td:first-child{ box-shadow:inset 2px 0 0 var(--accent); }
        tbody tr:focus-visible{ outline:2px solid var(--accent); outline-offset:-2px; }
        .pv{ position:relative; width:128px; aspect-ratio:16/9; border-radius:6px; overflow:hidden; background:var(--panel-3); }
        .pv .thumb, .pv .swatch{ position:absolute; inset:0; width:100%; height:100%; border-radius:0; }
        .dur{ position:absolute; right:5px; bottom:5px; font-size:11px; font-weight:700; padding:1px 6px; border-radius:4px; background:rgba(0,0,0,.72); color:#fff; font-variant-numeric:tabular-nums; }
        .dur.def{ color:#c8cfdc; font-weight:500; }
        .nm b{ display:block; font-size:14.5px; }
        .nm .desc{ font-size:12.5px; color:var(--text-muted); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; max-width:260px; }
        .nm input{ padding:5px 8px; font-size:14px; }
        .bg{ display:flex; gap:8px; align-items:flex-start; }
        .bg svg{ width:18px; height:18px; color:var(--text-muted); margin-top:1px; }
        .bg .fn{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:150px; }
        .bg .sub, .ann .sub{ font-size:12px; color:var(--text-muted); white-space:nowrap; }
        .chip-sw{ display:inline-block; width:12px; height:12px; border-radius:3px; vertical-align:-1px; margin-right:5px; border:1px solid rgba(255,255,255,.2); }
        .apill{ display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:6px; font-size:12.5px; font-weight:600; border:1px solid; white-space:nowrap; max-width:200px; overflow:hidden; text-overflow:ellipsis; }
        .apill svg{ width:14px; height:14px; }
        .apill.on{ color:#9ff0bd; background:var(--good-soft); border-color:rgba(34,197,94,.45); }
        .apill.none{ color:#ffd28f; background:var(--warn-soft); border-color:rgba(245,165,36,.45); }
        .ann .sub{ display:block; margin-top:3px; max-width:210px; overflow:hidden; text-overflow:ellipsis; }
        .cnt{ display:inline-flex; align-items:center; gap:6px; font-variant-numeric:tabular-nums; }
        .cnt svg{ width:16px; height:16px; color:var(--text-muted); }
        .cnt.zero{ color:var(--text-faint); }
        .mod{ font-size:12.5px; white-space:nowrap; }
        .mod span{ display:block; color:var(--text-muted); }
        .kebab{ border:0; background:transparent; padding:6px; border-radius:6px; color:var(--text-muted); display:flex; }
        .kebab:hover{ background:var(--panel-3); color:var(--text); }
        .kebab svg{ width:18px; height:18px; transform:rotate(90deg); }
        .grid{ display:grid; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); gap:12px; }
        .tile{ position:relative; padding:0; overflow:hidden; cursor:pointer; background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:var(--radius-sm); }
        .tile[aria-selected="true"]{ border-color:var(--accent); box-shadow:0 0 0 1px var(--accent-dim); }
        .tile:focus-visible{ outline:2px solid var(--accent); outline-offset:1px; }
        .tile .pv{ width:100%; border-radius:0; }
        .tile .body{ padding:9px 10px 10px; }
        .tile .body b{ display:block; font-size:14px; padding-right:28px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .tile .meta{ display:flex; align-items:center; gap:10px; margin-top:6px; font-size:12px; color:var(--text-muted); flex-wrap:wrap; }
        .tile .meta .apill{ padding:1px 7px; font-size:11.5px; max-width:120px; }
        .tile .kebab{ position:absolute; right:4px; bottom:6px; }
        .menu{ position:fixed; z-index:50; min-width:180px; background:var(--panel-2); border:1px solid var(--border); border-radius:var(--radius-sm); box-shadow:0 12px 32px rgba(0,0,0,.5); padding:4px; }
        .menu button{ display:flex; width:100%; align-items:center; gap:10px; border:0; background:transparent; padding:8px 10px; text-align:left; border-radius:4px; }
        .menu button:hover, .menu button:focus-visible{ background:var(--panel-3); outline:none; }
        .menu button svg{ width:16px; height:16px; color:var(--text-muted); }
        .menu .danger{ color:#ff8f8f; }
        .menu .danger svg{ color:#ff8f8f; }
        .menu hr{ border:0; border-top:1px solid var(--border-soft); margin:4px 0; }
        .detail{ position:sticky; top:16px; padding:16px; display:flex; flex-direction:column; gap:14px; max-height:calc(100vh - 140px); overflow:auto; }
        .detail .dh{ display:flex; align-items:center; gap:8px; }
        .detail .dh h2{ margin:0; font-size:18px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .stage{ position:relative; width:100%; aspect-ratio:16/9; background:#000; border-radius:var(--radius-sm); overflow:hidden; box-shadow:0 0 0 1px var(--border); }
        .stage:fullscreen{ border-radius:0; }
        /* <cr-bump> sizes its text in vw (it's built for a full-screen
           TV), so it renders here at a virtual 1280x720 and is scaled to
           the stage -- proportions match what viewers see. */
        cr-bump{ position:absolute; left:0; top:0; width:1280px; height:720px; transform-origin:0 0; transform:scale(var(--s, .3)); }
        .hud{ position:absolute; left:0; right:0; bottom:0; z-index:2; padding:20px 10px 8px; background:linear-gradient(transparent, rgba(0,0,0,.75)); display:flex; align-items:center; gap:10px; color:#fff; }
        .hud button{ border:0; background:transparent; padding:2px; color:#fff; display:flex; }
        .hud svg{ width:20px; height:20px; }
        .hud .t{ font-size:12.5px; font-variant-numeric:tabular-nums; flex:1; }
        .facts{ display:grid; grid-template-columns:22px 110px minmax(0,1fr); gap:9px 8px; align-items:center; font-size:13px; margin:0; }
        .facts svg{ width:17px; height:17px; color:var(--text-muted); }
        .facts dt{ color:var(--text-muted); }
        .facts dd{ margin:0; min-width:0; overflow-wrap:anywhere; }
        .desc-block{ font-size:13px; color:var(--text-muted); margin:0; }
        .open{ display:inline-flex; align-items:center; justify-content:center; gap:8px; }
        .open svg{ width:16px; height:16px; }
        .used h3{ margin:0 0 8px; font-size:15px; padding-top:12px; border-top:1px solid var(--border-soft); }
        .used ul{ list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
        .used li button{ width:100%; display:grid; grid-template-columns:30px minmax(0,1fr) auto; gap:10px; align-items:center; text-align:left; padding:6px 10px; background:var(--bg-elevated); border:1px solid var(--border-soft); }
        .used li button:hover{ border-color:#3a4256; }
        .used .lg{ width:30px; height:30px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:800; color:#fff; background:var(--panel-3); overflow:hidden; }
        .used .lg img{ width:100%; height:100%; object-fit:contain; padding:3px; background:rgba(0,0,0,.25); }
        .used .cn{ font-weight:600; font-size:13.5px; }
        .used .cr{ font-size:11.5px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .st{ font-size:11.5px; font-weight:700; padding:2px 8px; border-radius:5px; }
        .st.active{ color:#9ff0bd; background:var(--good-soft); }
        .st.off{ color:var(--text-muted); background:var(--panel-3); }
        .detail .placeholder{ color:var(--text-muted); text-align:center; padding:40px 10px; }
        dialog{ background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:var(--radius); padding:18px 20px; max-width:480px; width:calc(100% - 32px); box-shadow:0 20px 50px rgba(0,0,0,.6); }
        dialog::backdrop{ background:rgba(0,0,0,.55); }
        dialog h3{ margin:0 0 8px; font-size:17px; }
        dialog p{ margin:0 0 10px; font-size:13.5px; color:var(--text-muted); }
        dialog ul{ margin:0 0 12px; padding:0; list-style:none; display:flex; flex-direction:column; gap:4px; }
        dialog li{ display:flex; justify-content:space-between; gap:10px; font-size:13.5px; padding:6px 10px; background:var(--bg-elevated); border-radius:5px; }
        dialog .warnbox{ display:flex; gap:8px; padding:8px 10px; border-radius:6px; background:var(--warn-soft); color:#ffd9a0; font-size:13px; margin-bottom:12px; }
        dialog .warnbox svg{ width:16px; height:16px; margin-top:1px; }
        dialog .acts{ display:flex; justify-content:flex-end; gap:8px; }
        button.danger-solid{ background:var(--live); border-color:var(--live); color:#fff; font-weight:600; }
        @media (max-width: 1100px){
          .layout{ grid-template-columns:1fr; }
          .detail{ position:static; max-height:none; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); align-items:start; }
          .detail .dh, .detail .used, .detail .desc-block{ grid-column:1 / -1; }
        }
        @media (max-width: 1000px){
          .layout{ padding:12px; }
          .col-bg, .col-audio{ display:none; }
          .pv{ width:104px; }
        }
        @media (max-width: 700px){
          .detail{ display:flex; }
          .col-ann, .col-mod{ display:none; }
        }
      </style>
      <div class="layout">
        <section class="panel lib" aria-labelledby="lib-h">
          <div class="head">
            <h2 id="lib-h">Bump Library</h2>
            <span class="count"></span>
            <span class="spacer"></span>
            <button class="new primary">${icons.plus}<span>New bump</span></button>
          </div>
          <div class="filters">
            <label class="search"><span class="sr-only">Search bumps</span>${icons.search}<input type="search" class="q" placeholder="Search bumps…"></label>
            <select class="f-bg" aria-label="Filter by background">
              <option value="">All backgrounds</option><option value="video">Video</option><option value="image">Image</option><option value="color">Solid color</option>
            </select>
            <select class="f-ann" aria-label="Filter by announcement">
              <option value="">All announcements</option><option value="yes">With announcement</option><option value="no">No announcement</option>
            </select>
            <select class="f-ch" aria-label="Filter by channel"></select>
            <div class="seg" role="group" aria-label="View">
              <button class="v-grid" aria-pressed="false" aria-label="Grid view" title="Grid view">${ICON.grid}</button>
              <button class="v-list" aria-pressed="false" aria-label="List view" title="List view">${ICON.list}</button>
            </div>
          </div>
          <div class="results"></div>
        </section>
        <aside class="panel detail" aria-label="Bump details">
          <div class="dh"><h2 class="d-name">&nbsp;</h2><button class="kebab d-menu" aria-label="Bump actions" aria-haspopup="menu">${icons.more}</button></div>
          <div class="stage">
            <cr-bump></cr-bump>
            <div class="hud">
              <button class="d-play" aria-label="Play preview">${icons.play}</button>
              <span class="t"><span class="d-cur">0:00</span> / <span class="d-dur">0:15</span></span>
              <button class="d-mute" aria-label="Unmute preview" aria-pressed="true">${icons.mute}</button>
              <button class="d-fs" aria-label="Fullscreen" title="Fullscreen">${icons.fullscreen}</button>
            </div>
          </div>
          <div class="d-body"></div>
          <div class="used"></div>
        </aside>
      </div>
      <div class="menu" role="menu" hidden></div>
      <dialog class="del-dlg" aria-labelledby="del-h"></dialog>
    `;
    const root = this.shadowRoot;
    const q = (s) => root.querySelector(s);
    q(".q").addEventListener("input", (e) => { this._q = e.target.value.trim().toLowerCase(); this._renderResults(); });
    q(".f-bg").addEventListener("change", (e) => { this._filters.bg = e.target.value; this._renderResults(); });
    q(".f-ann").addEventListener("change", (e) => { this._filters.ann = e.target.value; this._renderResults(); });
    q(".f-ch").addEventListener("change", (e) => { this._filters.ch = e.target.value; this._renderResults(); });
    q(".v-grid").addEventListener("click", () => this._setView("grid"));
    q(".v-list").addEventListener("click", () => this._setView("list"));
    q(".new").addEventListener("click", () => { if (store.newBump()) store.setWorkspace("compose"); });

    const results = q(".results");
    results.addEventListener("click", (e) => {
      if (e.target.closest(".nm input")) return;
      const kebab = e.target.closest(".kebab");
      const item = e.target.closest("[data-id]");
      if (e.target.closest("th button[data-sort]")) { this._toggleSort(e.target.closest("th button").dataset.sort); return; }
      if (e.target.closest(".clear")) { this._clearFilters(); return; }
      if (e.target.closest(".first")) { if (store.newBump()) store.setWorkspace("compose"); return; }
      if (!item) return;
      this._select(item.dataset.id);
      if (kebab) this._openMenu(item.dataset.id, kebab);
    });
    results.addEventListener("dblclick", (e) => {
      const item = e.target.closest("[data-id]");
      if (item && !e.target.closest(".kebab, .nm input")) publish(TOPICS.STUDIO_COMPOSE_OPEN, { id: item.dataset.id });
    });
    results.addEventListener("keydown", (e) => {
      const item = e.target.closest("[data-id]");
      if (!item || e.target.closest("input")) return;
      if (e.key === "Enter") { e.preventDefault(); publish(TOPICS.STUDIO_COMPOSE_OPEN, { id: item.dataset.id }); }
      else if (e.key === " ") { e.preventDefault(); this._select(item.dataset.id); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const items = [...results.querySelectorAll("[data-id]")];
        const i = items.indexOf(item) + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1);
        if (items[i]) { e.preventDefault(); items[i].focus(); this._select(items[i].dataset.id); }
      } else if (e.key === "Delete") { this._confirmDelete(item.dataset.id); }
      else if (e.key === "F2") { this._startRename(item.dataset.id); }
    });

    q(".d-menu").addEventListener("click", (e) => { if (this._selected) this._openMenu(this._selected, e.currentTarget); });
    const menu = q(".menu");
    menu.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (b) this._act(b.dataset.act, this._menu?.id);
    });
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(root.activeElement);
      if (e.key === "Escape") { const a = this._menu?.anchor; this._closeMenu(); a?.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === "Tab") this._closeMenu();
    });
    this._onDocDown = (e) => { if (this._menu && !e.composedPath().includes(menu)) this._closeMenu(); };
    this._onScroll = () => this._closeMenu();
    this.addEventListener("scroll", this._onScroll, { passive: true });

    // ---- the single preview player ----
    this._el = q("cr-bump");
    const stage = q(".stage");
    new ResizeObserver(() => { if (stage.clientWidth) stage.style.setProperty("--s", String(stage.clientWidth / 1280)); }).observe(stage);
    this._el.endBehavior = "stop";
    this._el.setMuted(true);
    q(".d-play").addEventListener("click", () => this._togglePlay());
    q(".d-mute").addEventListener("click", () => {
      this._muted = !this._muted;
      this._el.setMuted(this._muted);
      this._renderHud();
    });
    q(".d-fs").addEventListener("click", () => {
      const stage = q(".stage");
      if (document.fullscreenElement) document.exitFullscreen?.();
      else stage.requestFullscreen?.().catch(() => {});
    });
    const hud = () => this._renderHud();
    this._el.addEventListener("bump-time", hud);
    this._el.addEventListener("bump-state", hud);
    this._el.addEventListener("bump-ended", hud);
    this._el.addEventListener("bump-media", (e) => {
      const bump = this._bump(this._selected);
      if (bump?.background?.type === "video" && e.detail?.video) { this._bgDur.set(bump.background.url, e.detail.video); this._fillBgDur(); }
    });

    this._onChange = ({ keys: k }) => {
      if (k.has("workspace") && store.state.workspace !== "library") { this._el.stop(); this._closeMenu(); this._renderHud(); }
      if (["bumps", "schedules", "status", "media"].some((x) => k.has(x))) this._renderAll();
      else if (k.has("preview") && this._selected) this._el.upcoming = store.state.preview.upcoming;
    };
    this._listen();
    this._renderAll();
  }

  _listen() {
    this._subs = new AbortController();
    const signal = this._subs.signal;
    document.addEventListener("pointerdown", this._onDocDown, { capture: true, signal });
    subscribe(TOPICS.STUDIO_CHANGED, (msg) => this._onChange(changeOf(msg)), { signal });
  }

  disconnectedCallback() {
    this._subs?.abort();
  }

  // ---------- data ----------

  _bump(id) { return store.state.bumps.find((b) => b.id === id) || null; }

  _visible() {
    const { bg, ann, ch } = this._filters;
    const q = this._q;
    const rows = store.state.bumps.filter((b) => {
      if (q && ![b.name, b.id, b.description, b.background?.url, b.upcoming?.label].some((v) => String(v || "").toLowerCase().includes(q))) return false;
      if (bg && (b.background?.type || "color") !== bg) return false;
      if (ann === "yes" && !b.announcement) return false;
      if (ann === "no" && b.announcement) return false;
      if (ch) {
        const refs = store.referencesTo(b.id);
        if (ch === "__any" && !refs.length) return false;
        if (ch === "__none" && refs.length) return false;
        if (!ch.startsWith("__") && !refs.some((c) => c.id === ch)) return false;
      }
      return true;
    });
    const { key, dir } = this._sort;
    const val = (b) => {
      if (key === "modified") return Date.parse(b.modifiedAt || b.updatedAt || "") || 0;
      if (key === "channels") return store.referencesTo(b.id).length;
      return String(b.name || b.id).toLowerCase();
    };
    return rows.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }

  _filtersActive() { return !!(this._q || this._filters.bg || this._filters.ann || this._filters.ch); }

  _clearFilters() {
    this._q = "";
    this._filters = { bg: "", ann: "", ch: "" };
    const root = this.shadowRoot;
    root.querySelector(".q").value = "";
    for (const s of [".f-bg", ".f-ann", ".f-ch"]) root.querySelector(s).value = "";
    this._renderResults();
  }

  _toggleSort(key) {
    if (this._sort.key === key) this._sort.dir *= -1;
    else this._sort = { key, dir: key === "name" ? 1 : -1 };
    this._renderResults();
  }

  _setView(v) {
    this._view = v;
    writeView(v);
    this._renderResults();
  }

  _select(id) {
    if (id === this._selected) return;
    this._selected = id;
    this.shadowRoot.querySelectorAll(".results [data-id]").forEach((el) => {
      const on = el.dataset.id === id;
      el.setAttribute("aria-selected", String(on));
      el.tabIndex = on ? 0 : -1;
    });
    this._renderDetail();
  }

  // ---------- rendering ----------

  _renderAll() {
    const root = this.shadowRoot;
    const ready = store.state.status === "ready";
    root.querySelector(".layout").hidden = !ready; // the shell shows loading/error
    if (!ready) return;
    const chSel = root.querySelector(".f-ch");
    const cur = this._filters.ch;
    chSel.innerHTML = `<option value="">All channels</option><option value="__any">Scheduled anywhere</option><option value="__none">Not scheduled</option>`
      + `<optgroup label="Scheduled on">${store.state.schedules.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("")}</optgroup>`;
    chSel.value = cur;
    if (chSel.value !== cur) this._filters.ch = "";
    if (!this._selected || !this._bump(this._selected)) this._selected = store.state.selectedId && this._bump(store.state.selectedId) ? store.state.selectedId : store.state.bumps[0]?.id || null;
    this._renderResults();
    this._renderDetail();
  }

  _thumb(b) {
    const bg = b.background || {};
    if (bg.type === "color" || !bg.url) {
      const d = document.createElement("div");
      d.className = "swatch";
      d.style.background = bg.color || "#14213d";
      return d;
    }
    const key = `${b.id}:${bg.type}:${bg.url}`;
    if (!this._thumbs.has(key)) {
      const t = makeThumb(bg.type, bg.url, { hoverPlay: false });
      t.addEventListener("thumb-duration", (e) => { if (e.detail) { this._bgDur.set(bg.url, e.detail); this._fillBgDur(); } });
      this._thumbs.set(key, t);
    }
    return this._thumbs.get(key);
  }

  _fillBgDur() {
    this.shadowRoot.querySelectorAll("[data-bgdur]").forEach((el) => {
      const d = this._bgDur.get(el.dataset.bgdur);
      if (d) el.textContent = ` • ${mmss(d)}`;
    });
  }

  _durBadge(b) {
    const own = bumpDuration(b);
    return own
      ? `<span class="dur" title="Composition length">${mmss(own)}</span>`
      : `<span class="dur def" title="No fixed length: previewed at ${effectiveDuration(b)}s; on air the schedule rule sets the length">${mmss(effectiveDuration(b))}</span>`;
  }

  _bgHtml(b) {
    const bg = b.background || {};
    if (bg.type === "color" || !bg.url) {
      return `<div class="bg">${ICON.palette}<div><div class="fn"><span class="chip-sw" style="background:${escapeHtml(bg.color || "#14213d")}"></span>${escapeHtml(bg.color || "#14213d")}</div><div class="sub">Solid color</div></div></div>`;
    }
    const d = this._bgDur.get(bg.url);
    return `<div class="bg">${bg.type === "image" ? icons.image : icons.film}<div>
      <div class="fn" title="${escapeHtml(bg.url)}">${escapeHtml(ext(bg.url))}</div>
      <div class="sub">${bg.type === "image" ? "Image" : "Video"}${bg.type === "video" ? `<span data-bgdur="${escapeHtml(bg.url)}">${d ? ` • ${mmss(d)}` : ""}</span>` : ""}</div></div></div>`;
  }

  _annInfo(b) {
    if (!b.announcement) return null;
    const found = findAnnouncement(store.state.media, b.announcement);
    return {
      source: found?.channel?.name || b.announcement.channelId || "Announcement",
      type: found?.clip ? announcementTypeLabel(found.clip.type) : "",
      text: found?.clip?.text || "",
      missing: !found?.clip,
    };
  }

  _annHtml(b, { compact = false } = {}) {
    const a = this._annInfo(b);
    if (!a) return `<span class="apill none">${icons.mic}None</span>`;
    const pill = `<span class="apill on" title="${escapeHtml(a.text || a.source)}">${icons.mic}${escapeHtml(a.source)}</span>`;
    if (compact) return pill;
    const sub = [a.type, a.text ? `“${trunc(a.text, 34)}”` : a.missing ? "clip not in the current announcement list" : ""].filter(Boolean).join(" • ");
    return `${pill}${sub ? `<span class="sub" title="${escapeHtml(a.text)}">${escapeHtml(sub)}</span>` : ""}`;
  }

  _modHtml(b) {
    const iso = b.modifiedAt || b.updatedAt;
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return `<span class="faint">—</span>`;
    return `<div class="mod" title="${escapeHtml(d.toString())}">${escapeHtml(d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }))}<span>${escapeHtml(d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</span></div>`;
  }

  _nameHtml(b) {
    if (this._renaming === b.id) return `<input class="rename" value="${escapeHtml(b.name || "")}" maxlength="120" aria-label="New name">`;
    return `<b>${escapeHtml(b.name || b.id)}</b>${b.description ? `<span class="desc">${escapeHtml(b.description)}</span>` : ""}`;
  }

  _renderResults() {
    const root = this.shadowRoot;
    const all = store.state.bumps;
    const rows = this._visible();
    root.querySelector(".count").textContent = this._filtersActive() ? `${rows.length} of ${all.length} bumps` : `${all.length} bump${all.length === 1 ? "" : "s"}`;
    root.querySelector(".v-grid").setAttribute("aria-pressed", String(this._view === "grid"));
    root.querySelector(".v-list").setAttribute("aria-pressed", String(this._view === "list"));
    const box = root.querySelector(".results");
    if (!all.length) {
      box.innerHTML = `<div class="empty-state"><p>No bumps yet.</p><p class="small">A bump pairs a background with music, an announcement and the upcoming lineup.</p><button class="first primary">Create your first bump</button></div>`;
      return;
    }
    if (!rows.length) {
      box.innerHTML = `<div class="empty-state"><p>No bumps match these filters.</p><button class="clear">Clear filters</button></div>`;
      return;
    }
    const sel = this._selected;
    const arrow = (k) => (this._sort.key === k ? (this._sort.dir > 0 ? " ↑" : " ↓") : "");
    const ariaSort = (k) => (this._sort.key === k ? (this._sort.dir > 0 ? "ascending" : "descending") : "none");
    if (this._view === "list") {
      box.innerHTML = `<table role="grid" aria-label="Bumps">
        <thead><tr>
          <th>Preview</th>
          <th aria-sort="${ariaSort("name")}"><button data-sort="name">Name${arrow("name")}</button></th>
          <th class="col-bg">Background</th>
          <th class="col-ann">Announcement</th>
          <th class="col-audio">Audio</th>
          <th aria-sort="${ariaSort("channels")}"><button data-sort="channels">Channels${arrow("channels")}</button></th>
          <th class="col-mod" aria-sort="${ariaSort("modified")}"><button data-sort="modified">Modified${arrow("modified")}</button></th>
          <th><span class="sr-only">Actions</span></th>
        </tr></thead><tbody></tbody></table>`;
      const tbody = box.querySelector("tbody");
      for (const b of rows) {
        const refs = store.referencesTo(b.id);
        const n = (b.audio || []).length;
        const tr = document.createElement("tr");
        tr.dataset.id = b.id;
        tr.setAttribute("aria-selected", String(b.id === sel));
        tr.tabIndex = b.id === sel ? 0 : -1;
        tr.title = "Double-click to open in Compose";
        tr.innerHTML = `
          <td><div class="pv">${this._durBadge(b)}</div></td>
          <td class="nm">${this._nameHtml(b)}</td>
          <td class="col-bg">${this._bgHtml(b)}</td>
          <td class="col-ann ann">${this._annHtml(b)}</td>
          <td class="col-audio"><span class="cnt ${n ? "" : "zero"}" title="${escapeHtml((b.audio || []).map((l) => ext(l.url)).join(", ") || "No audio layers")}">${icons.layers}${n}</span></td>
          <td><span class="cnt ${refs.length ? "" : "zero"}" title="${escapeHtml(refs.map((c) => c.name).join(", ") || "Not scheduled")}">${ICON.link}${refs.length}</span></td>
          <td class="col-mod">${this._modHtml(b)}</td>
          <td><button class="kebab" aria-label="Actions for ${escapeHtml(b.name || b.id)}" aria-haspopup="menu">${icons.more}</button></td>`;
        tr.querySelector(".pv").prepend(this._thumb(b));
        tbody.append(tr);
      }
    } else {
      box.innerHTML = `<div class="grid" role="listbox" aria-label="Bumps"></div>`;
      const grid = box.querySelector(".grid");
      for (const b of rows) {
        const refs = store.referencesTo(b.id);
        const card = document.createElement("div");
        card.className = "tile";
        card.dataset.id = b.id;
        card.setAttribute("role", "option");
        card.setAttribute("aria-selected", String(b.id === sel));
        card.tabIndex = b.id === sel ? 0 : -1;
        card.title = "Double-click to open in Compose";
        card.innerHTML = `
          <div class="pv">${this._durBadge(b)}</div>
          <div class="body"><div class="nm">${this._renaming === b.id ? this._nameHtml(b) : `<b>${escapeHtml(b.name || b.id)}</b>`}</div>
            <div class="meta">${this._annHtml(b, { compact: true })}
              <span class="cnt ${(b.audio || []).length ? "" : "zero"}">${icons.layers}${(b.audio || []).length}</span>
              <span class="cnt ${refs.length ? "" : "zero"}" title="${escapeHtml(refs.map((c) => c.name).join(", ") || "Not scheduled")}">${ICON.link}${refs.length}</span></div>
          </div>
          <button class="kebab" aria-label="Actions for ${escapeHtml(b.name || b.id)}" aria-haspopup="menu">${icons.more}</button>`;
        card.querySelector(".pv").prepend(this._thumb(b));
        grid.append(card);
      }
    }
    if (!rows.some((b) => b.id === sel)) box.querySelector("[data-id]")?.setAttribute("tabindex", "0");
    const input = box.querySelector("input.rename");
    if (input) {
      input.focus();
      input.select();
      const id = this._renaming;
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        this._renaming = null;
        if (commit) this._commitRename(id, input.value);
        else this._renderResults();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") { e.preventDefault(); finish(false); }
        e.stopPropagation();
      });
      input.addEventListener("blur", () => finish(true));
    }
  }

  _renderDetail() {
    const root = this.shadowRoot;
    const b = this._bump(this._selected);
    const body = root.querySelector(".d-body");
    const used = root.querySelector(".used");
    root.querySelector(".stage").hidden = !b;
    root.querySelector(".d-menu").hidden = !b;
    if (!b) {
      root.querySelector(".d-name").textContent = "No bump selected";
      body.innerHTML = `<div class="placeholder">${store.state.bumps.length ? "Select a bump to preview it." : "Nothing to preview yet."}</div>`;
      used.innerHTML = "";
      this._el.stop();
      this._shownId = null;
      return;
    }
    root.querySelector(".d-name").textContent = b.name || b.id;
    if (this._shownId !== b.id || this._shownAt !== b.updatedAt) {
      // Same element, new definition: no re-creation.
      this._el.stop();
      this._el.definition = b;
      this._el.upcoming = store.state.preview.upcoming;
      this._el.channel = null;
      this._shownId = b.id;
      this._shownAt = b.updatedAt;
    }
    this._renderHud();
    const bg = b.background || {};
    const bgText = bg.type === "color" || !bg.url
      ? `<span class="chip-sw" style="background:${escapeHtml(bg.color || "#14213d")}"></span>Solid color ${escapeHtml(bg.color || "")}`
      : `${escapeHtml(ext(bg.url))} (${bg.type}${bg.type === "video" ? `<span data-bgdur="${escapeHtml(bg.url)}">${this._bgDur.get(bg.url) ? ` • ${mmss(this._bgDur.get(bg.url))}` : ""}</span>` : ""})`;
    const layers = b.audio || [];
    const own = bumpDuration(b);
    const accent = b.style?.accent;
    const up = b.upcoming || {};
    body.innerHTML = `
      ${b.description ? `<p class="desc-block">${escapeHtml(b.description)}</p>` : ""}
      <dl class="facts">
        ${icons.film}<dt>Background</dt><dd>${bgText}</dd>
        ${ICON.clock}<dt>Duration</dt><dd>${own ? formatDuration(own) : `No fixed length <span class="faint">(previews at ${formatDuration(effectiveDuration(b))})</span>`}</dd>
        ${icons.music}<dt>Audio layers</dt><dd>${layers.length ? `${layers.length} (${layers.map((l) => escapeHtml(ext(l.url))).join(", ")})` : `<span class="faint">None</span>`}</dd>
        ${icons.mic}<dt>Announcement</dt><dd>${this._annHtml(b, { compact: true })}</dd>
        ${icons.text}<dt>Text overlay</dt><dd>${up.count > 0 ? `${escapeHtml(up.label || "Coming Up")} <span class="faint">· ${up.count} show${up.count === 1 ? "" : "s"}</span>` : `<span class="faint">Off</span>`}</dd>
        ${ICON.palette}<dt>Accent color</dt><dd><span class="chip-sw" style="background:${escapeHtml(accent || STYLE_DEFAULTS.accent)}"></span>${escapeHtml((accent || STYLE_DEFAULTS.accent).toUpperCase())}${accent ? "" : ` <span class="faint">(default)</span>`}</dd>
      </dl>
      <button class="open primary" style="width:100%; margin-top:12px">${ICON.open}<span>Open in Compose</span></button>`;
    body.querySelector(".open").addEventListener("click", () => publish(TOPICS.STUDIO_COMPOSE_OPEN, { id: b.id }));
    const refs = store.referencesTo(b.id);
    used.innerHTML = `<h3>Used by channels (${refs.length})</h3>${refs.length ? `<ul>${refs.map((c) => {
      const meta = store.state.schedules.find((s) => s.id === c.id) || {};
      const lg = meta.logo ? `<span class="lg"><img src="${escapeHtml(mediaUrl(meta.logo))}" alt=""></span>` : `<span class="lg" style="background:${escapeHtml(meta.accent || "var(--panel-3)")}">${escapeHtml(channelInitials(c.name))}</span>`;
      const rules = c.rules.map((r) => `${RECURRENCE_LABELS[r.every] || r.every} ${formatOffset(r.every, r.offsetSeconds).short}`).join("; ");
      return `<li><button data-ch="${escapeHtml(c.id)}" title="Show ${escapeHtml(c.name)}'s schedule">${lg}<span><span class="cn">${escapeHtml(c.name)}</span><span class="cr" style="display:block">${escapeHtml(rules)}</span></span>
        <span class="st ${c.enabled ? "active" : "off"}">${c.enabled ? "Active" : "Disabled"}</span></button></li>`;
    }).join("")}</ul>` : `<p class="small muted" style="margin:0">Not scheduled on any channel.</p>`}`;
    used.querySelectorAll("button[data-ch]").forEach((btn) => btn.addEventListener("click", () => publish(TOPICS.STUDIO_SCHEDULE_OPEN, { channelId: btn.dataset.ch })));
  }

  _renderHud() {
    const root = this.shadowRoot;
    const el = this._el;
    const playing = el.playing;
    const play = root.querySelector(".d-play");
    play.innerHTML = playing ? icons.pause : icons.play;
    play.setAttribute("aria-label", playing ? "Pause preview" : "Play preview");
    root.querySelector(".d-cur").textContent = mmss(Math.min(el.currentTime || 0, el.duration || 0));
    root.querySelector(".d-dur").textContent = mmss(el.duration || 0);
    const mute = root.querySelector(".d-mute");
    mute.innerHTML = this._muted ? icons.mute : icons.volume;
    mute.setAttribute("aria-pressed", String(this._muted));
    mute.setAttribute("aria-label", this._muted ? "Unmute preview" : "Mute preview");
  }

  _togglePlay() {
    const el = this._el;
    if (!this._bump(this._selected)) return;
    if (el.playing) { el.pause(); return; }
    store.pause(); // never two previews audible at once
    const t = el.currentTime;
    el.play({ muted: this._muted, offset: t >= el.duration - 0.05 ? 0 : t });
  }

  // ---------- menu / actions ----------

  _openMenu(id, anchor) {
    const menu = this.shadowRoot.querySelector(".menu");
    if (this._menu?.id === id && this._menu.anchor === anchor) { this._closeMenu(); return; }
    this._menu = { id, anchor };
    const refs = store.referencesTo(id);
    menu.innerHTML = `
      <button role="menuitem" data-act="open">${ICON.open}Open in Compose</button>
      <button role="menuitem" data-act="rename">${icons.edit}Rename…</button>
      <button role="menuitem" data-act="duplicate">${ICON.copy}Duplicate</button>
      <hr>
      <button role="menuitem" data-act="delete" class="danger">${icons.trash}Delete…${refs.length ? ` <span class="faint small">(${refs.length} ch)</span>` : ""}</button>`;
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw));
    const top = r.bottom + 4 + mh > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    anchor.setAttribute("aria-expanded", "true");
    menu.querySelector("button").focus();
  }

  _closeMenu() {
    if (!this._menu) return;
    this._menu.anchor?.setAttribute("aria-expanded", "false");
    this._menu = null;
    this.shadowRoot.querySelector(".menu").hidden = true;
  }

  async _act(act, id) {
    this._closeMenu();
    const bump = this._bump(id);
    if (!bump) return;
    if (act === "open") publish(TOPICS.STUDIO_COMPOSE_OPEN, { id });
    else if (act === "rename") this._startRename(id);
    else if (act === "duplicate") {
      try {
        const copy = await store.duplicate(id);
        if (copy) { this._selected = copy.id; this._renderAll(); toast(`Created "${copy.name}".`, "good"); }
      } catch (e) { toast(e.message, "danger"); }
    } else if (act === "delete") this._confirmDelete(id);
  }

  _startRename(id) {
    this._renaming = id;
    this._select(id);
    this._renderResults();
  }

  async _commitRename(id, value) {
    try {
      const saved = await store.rename(id, value);
      if (saved) toast("Renamed.", "good");
    } catch (e) { toast(e.message, "danger"); }
    this._renderAll();
    this.shadowRoot.querySelector(`.results [data-id="${CSS.escape(id)}"]`)?.focus();
  }

  _confirmDelete(id) {
    const bump = this._bump(id);
    if (!bump) return;
    const refs = store.referencesTo(id);
    const dlg = this.shadowRoot.querySelector(".del-dlg");
    const name = escapeHtml(bump.name || id);
    dlg.innerHTML = `
      <h3 id="del-h">Delete “${name}”?</h3>
      <p>This removes bumps/${escapeHtml(id)}.json. It cannot be undone.</p>
      ${refs.length ? `
        <div class="warnbox">${ICON.warn}<span>This bump is scheduled on ${refs.length} channel${refs.length === 1 ? "" : "s"}. Their rules are <b>not</b> removed: until you edit them in Schedule, those channels skip that slot on air, and their schedules can't be saved again until the rule is changed or removed.</span></div>
        <ul>${refs.map((c) => `<li><span>${escapeHtml(c.name)} <span class="faint small">· ${c.rules.length} rule${c.rules.length === 1 ? "" : "s"}</span></span><span class="st ${c.enabled ? "active" : "off"}">${c.enabled ? "Active" : "Disabled"}</span></li>`).join("")}</ul>` : ""}
      ${id === store.state.selectedId && store.isDirty ? `<p>It is also open in Compose with unsaved changes, which will be discarded.</p>` : ""}
      <div class="acts"><button class="cancel" value="cancel">Cancel</button><button class="ok danger-solid">${refs.length ? "Delete anyway" : "Delete"}</button></div>`;
    dlg.querySelector(".cancel").addEventListener("click", () => dlg.close());
    dlg.querySelector(".ok").addEventListener("click", async () => {
      dlg.close();
      try {
        await store.remove(id);
        if (this._selected === id) this._selected = null;
        this._renderAll();
        toast(`Deleted "${bump.name || id}".`, "good");
      } catch (e) { toast(e.message, "danger"); }
    });
    dlg.showModal();
    dlg.querySelector(".cancel").focus();
  }
}

customElements.define("bump-library-workspace", BumpLibraryWorkspace);
