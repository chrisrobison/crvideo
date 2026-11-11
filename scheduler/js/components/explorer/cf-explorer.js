// <cf-explorer> -- CRVideo Explorer's shell: toolbar (mode, search, time
// travel), breadcrumbs, the Finder-style browser, the Inspector and the
// splitter between them. It is a read-only browser/inspector: see
// docs/explorer.md. All state lives in explorer-store.js; this element only
// draws it and forwards input.

import { explorerStore as store } from "./explorer-store.js";
import { TOPICS, subscribe } from "../../../../js/bus.js";
import { routeCrumbs } from "./explorer-route.js";
import { esc, explorerCSS, icons, fmtDateTime, toInputs, fromInputs, tzName, titleCase } from "./explorer-ui.js";
import { renderSearchView, docKey } from "./explorer-search.js";
import "./explorer-browser.js";
import "./explorer-inspector.js";
import { stopPreview } from "./explorer-media.js";

const WIDTH_KEY = "explorer.inspectorWidth";
const MIN_W = 340;

class CfExplorer extends HTMLElement {
  constructor() {
    super();
    this._raf = 0;
    this._pick = null;
    this._invalidDismissed = false;
  }

  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>${explorerCSS}${STYLE}</style>
      <div class="bar" role="toolbar" aria-label="Explorer controls">
        <div class="seg" role="tablist" aria-label="Explorer mode">
          <button role="tab" data-mode="programs">Programs</button>
          <button role="tab" data-mode="production">Production</button>
        </div>
        <label class="search" aria-label="Search content, shows, episodes, bumps and voiceovers">
          ${icons.search}<input type="search" class="q" placeholder="Search content, shows, episodes…" autocomplete="off" spellcheck="false">
          <kbd>⌘K</kbd>
        </label>
        <div class="tt" role="group" aria-label="Time travel">
          <span class="tt-badge" hidden>TIME TRAVEL</span>
          <button class="step" data-step="-3600" aria-label="Back one hour" title="−1 hour">−1h</button>
          <input type="date" class="d" aria-label="Date">
          <input type="time" class="tm" step="1" aria-label="Time">
          <button class="step" data-step="3600" aria-label="Forward one hour" title="+1 hour">+1h</button>
          <button class="primary jump">Jump</button>
          <button class="now" title="Follow the live clock">Now</button>
          <span class="tz" title="Times are shown in your browser's time zone"></span>
        </div>
      </div>
      <nav class="crumbs" aria-label="Breadcrumbs"></nav>
      <div class="invalid" hidden></div>
      <div class="main">
        <div class="left"><explorer-browser></explorer-browser><div class="search-pane" hidden></div></div>
        <div class="split" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize inspector" title="Drag to resize the inspector"></div>
        <explorer-inspector></explorer-inspector>
      </div>`;
    const root = this.shadowRoot;
    this.$ = (s) => root.querySelector(s);
    this.browser = this.$("explorer-browser");
    this.inspector = this.$("explorer-inspector");
    this.browser.store = store;
    this.inspector.store = store;
    this.$(".tz").textContent = tzName();
    this._restoreWidth();
    this._wire();

    this._off = store.init();
    // Previews must never keep playing behind another view (or a hidden tab).
    this._busCtl = new AbortController();
    subscribe(TOPICS.APP_VIEW_STATE, ({ data }) => { if (data?.view !== "explorer") { stopPreview(); this.inspector.closeDock?.(true); } }, { retained: true, signal: this._busCtl.signal });
    this._onHidden = () => { if (document.hidden) stopPreview(); };
    document.addEventListener("visibilitychange", this._onHidden);
    this._unsub = store.subscribe(() => this._schedule());
    this._tick = setInterval(() => { if (store.active && store.route.t === null) this._schedule(); }, 30000);
    this._onKey = (e) => {
      if (!store.active) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); this.$(".q").focus(); this.$(".q").select(); }
    };
    document.addEventListener("keydown", this._onKey);
    this._render();
  }

  disconnectedCallback() {
    this._off?.(); this._unsub?.(); clearInterval(this._tick); this._busCtl?.abort(); stopPreview();
    document.removeEventListener("visibilitychange", this._onHidden);
    document.removeEventListener("keydown", this._onKey);
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  // ---------- wiring ----------

  _wire() {
    const $ = this.$;
    $(".seg").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) store.setMode(b.dataset.mode); });

    const q = $(".q");
    let timer = 0;
    q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => store.setQuery(q.value), 220); });
    q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { clearTimeout(timer); store.setQuery(q.value); }
      if (e.key === "Escape") { if (q.value || store.route.q) { q.value = ""; clearTimeout(timer); store.setQuery(""); } q.blur(); }
    });

    const jump = () => {
      const t = fromInputs($(".d").value, $(".tm").value);
      if (t !== null) store.setTime(t);
    };
    $(".jump").addEventListener("click", jump);
    for (const el of [$(".d"), $(".tm")]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") jump(); });
    $(".now").addEventListener("click", () => store.setTime(null));
    $(".tt").addEventListener("click", (e) => {
      const s = e.target.closest("[data-step]");
      if (s) store.setTime(store.effectiveT() + Number(s.dataset.step));
    });

    $(".crumbs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-route]");
      if (b) store.open(JSON.parse(b.dataset.route));
    });
    $(".invalid").addEventListener("click", (e) => { if (e.target.closest("button")) { this._invalidDismissed = true; this._render(); } });

    // search pane
    const sp = $(".search-pane");
    sp.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el) return;
      if (el.dataset.act === "search-scope") store.go({ scope: el.dataset.id }, { replace: true });
      if (el.dataset.act === "search-pick") { this._pick = store.searchDocs().find((d) => docKey(d) === el.dataset.key) || null; this._pickKey = el.dataset.key; this.inspector.pick = this._pick; this._render(); }
    });
    sp.addEventListener("dblclick", (e) => { const el = e.target.closest("[data-open]"); if (el) store.open(JSON.parse(el.dataset.open)); });
    sp.addEventListener("keydown", (e) => { if (e.key === "Enter") { const el = e.target.closest("[data-open]"); if (el) { e.preventDefault(); store.open(JSON.parse(el.dataset.open)); } } });

    this.shadowRoot.addEventListener("explorer-focus-col", (e) => this.browser.focusColumn(e.detail.id));

    // splitter
    const split = $(".split");
    const main = $(".main");
    split.addEventListener("pointerdown", (e) => {
      split.setPointerCapture(e.pointerId);
      const move = (ev) => { const r = main.getBoundingClientRect(); this._setWidth(r.right - ev.clientX); };
      const up = () => { split.removeEventListener("pointermove", move); split.removeEventListener("pointerup", up); this._saveWidth(); };
      split.addEventListener("pointermove", move);
      split.addEventListener("pointerup", up);
    });
    split.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      this._setWidth(this._width() + (e.key === "ArrowLeft" ? 24 : -24));
      this._saveWidth();
    });
  }

  _width() { return this.$(".inspector-host-width")?.offsetWidth || this.inspector.getBoundingClientRect().width; }
  _setWidth(px) {
    const max = Math.max(MIN_W, this.$(".main").getBoundingClientRect().width - 320);
    const w = Math.round(Math.min(max, Math.max(MIN_W, px)));
    this.$(".main").style.setProperty("--insp-w", `${w}px`);
    this.$(".split").setAttribute("aria-valuenow", String(w));
  }
  _saveWidth() { try { localStorage.setItem(WIDTH_KEY, String(Math.round(this.inspector.getBoundingClientRect().width))); } catch { /* optional */ } }
  _restoreWidth() { try { const w = Number(localStorage.getItem(WIDTH_KEY)); if (w >= MIN_W) this.$(".main").style.setProperty("--insp-w", `${w}px`); } catch { /* optional */ } }

  // ---------- drawing ----------

  _crumbLabel(c) {
    const r = store.route;
    switch (c.type) {
      case "root": return { label: "Explorer", route: { mode: "programs" } };
      case "search": return { label: `Search: “${c.q}”`, route: null };
      case "production": return { label: "Production", route: { mode: "production" } };
      case "category": return { label: titleCase(c.cat), route: { mode: "production", cat: c.cat } };
      case "asset": return { label: c.asset.kind === "bump" ? (store.data.bumps?.find((b) => b.id === c.asset.id)?.name || c.asset.id) : c.asset.kind === "announcement" ? "Voiceover" : c.asset.path.split("/").pop(), route: null };
      case "channel": return { label: store.channel(c.id)?.name || c.id, route: { channel: c.id } };
      case "series": return { label: store.seriesRow(c.id)?.title || c.id, route: { channel: r.channel, series: c.id } };
      case "episode": return { label: store.seriesDetail()?.episodes.find((e) => e.id === c.id)?.title || c.id, route: { channel: r.channel, series: r.series, episode: c.id } };
      case "airing": return { label: fmtDateTime(c.at), route: null };
      default: return { label: "", route: null };
    }
  }

  _render() {
    if (!this.shadowRoot) return;
    const r = store.route;
    const $ = this.$;
    $(".seg").querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === r.mode)));

    // time controls: don't fight the user while they are typing in them
    const t = store.effectiveT();
    const active = this.shadowRoot.activeElement;
    if (!active || !active.matches(".d,.tm")) { const v = toInputs(t); $(".d").value = v.date; $(".tm").value = v.time; }
    const traveling = r.t !== null;
    $(".tt-badge").hidden = !traveling;
    $(".now").disabled = !traveling;
    $(".tt").dataset.on = String(traveling);
    if (!active || !active.matches(".q")) $(".q").value = r.q;

    const crumbs = routeCrumbs(r);
    $(".crumbs").innerHTML = crumbs.map((c, i) => {
      const { label, route } = this._crumbLabel(c);
      const last = i === crumbs.length - 1;
      return `${i ? `<span class="sep">${icons.chevron}</span>` : ""}${route && !last ? `<button data-route="${esc(JSON.stringify(route))}">${esc(label)}</button>` : `<span class="cur" ${last ? 'aria-current="page"' : ""}>${esc(label)}</span>`}`;
    }).join("") + (traveling ? `<span class="sep">${icons.chevron}</span><span class="cur tt-c">${esc(fmtDateTime(r.t, true))}</span>` : "");

    const inv = $(".invalid");
    if (store.invalid.length && !this._invalidDismissed) { inv.hidden = false; inv.innerHTML = `Ignored invalid link parameter${store.invalid.length > 1 ? "s" : ""}: <code>${esc(store.invalid.join(", "))}</code> <button>Dismiss</button>`; }
    else inv.hidden = true;

    const searching = !!r.q;
    this.browser.hidden = searching;
    const sp = $(".search-pane");
    sp.hidden = !searching;
    if (searching) {
      const keep = sp.querySelector(".results")?.scrollTop || 0;
      sp.innerHTML = renderSearchView(store, this._pickKey);
      const res = sp.querySelector(".results"); if (res) res.scrollTop = keep;
      if (this._pick && !store.searchDocs().some((d) => docKey(d) === docKeyOf(this._pick))) this._pick = null;
    } else {
      this.browser.render();
      this._pick = null; this._pickKey = null;
    }
    this.inspector.render();
  }
}

const docKeyOf = (d) => docKey(d);

const STYLE = `
  :host{ display:flex; flex-direction:column; height:100%; min-height:0; background:var(--bg); }
  .bar{ display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; padding:10px 16px; border-bottom:1px solid var(--border-soft); background:var(--bg-elevated); }
  .seg{ display:inline-flex; background:var(--panel); border:1px solid var(--border); border-radius:var(--radius-sm); padding:2px; gap:2px; }
  .seg button{ border:0; background:transparent; padding:5px 12px; font-size:12.5px; color:var(--text-muted); border-radius:4px; }
  .seg button[aria-selected="true"]{ background:var(--accent-soft); color:#cfe0ff; }
  .search{ position:relative; flex:1 1 280px; max-width:520px; min-width:200px; display:block; }
  .search svg{ position:absolute; left:10px; top:50%; transform:translateY(-50%); color:var(--text-faint); }
  .search input{ padding-left:32px; padding-right:44px; }
  .search kbd{ position:absolute; right:8px; top:50%; transform:translateY(-50%); font:11px var(--mono); color:var(--text-faint); border:1px solid var(--border); border-radius:4px; padding:0 5px; }
  .tt{ display:flex; align-items:center; gap:6px; margin-left:auto; flex-wrap:wrap; }
  .tt input{ width:auto; padding:6px 8px; color-scheme:dark; } .tt button{ padding:6px 9px; }
  .tt-badge{ font-size:10.5px; font-weight:800; letter-spacing:.1em; color:#fbbf24; background:var(--warn-soft); border-radius:4px; padding:3px 7px; }
  .tz{ font-size:11.5px; color:var(--text-faint); }
  .crumbs{ display:flex; align-items:center; flex-wrap:wrap; gap:2px 4px; padding:9px 16px; font-size:13px; min-height:38px; }
  .crumbs button{ background:transparent; border:0; padding:2px 4px; color:var(--text-muted); border-radius:4px; } .crumbs button:hover{ color:var(--text); background:var(--panel-2); }
  .crumbs .sep{ color:var(--text-faint); display:flex; } .crumbs .cur{ font-weight:700; padding:2px 4px; } .crumbs .tt-c{ color:#fbbf24; }
  .invalid{ margin:0 16px 8px; padding:6px 10px; font-size:12px; background:var(--warn-soft); border:1px solid rgba(245,165,36,.35); border-radius:var(--radius-sm); color:#ffd28f; }
  .invalid button{ margin-left:8px; padding:1px 8px; font-size:11px; }
  .main{ --insp-w:clamp(380px, 34vw, 560px); flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 10px var(--insp-w); padding:0 16px 14px; }
  .left{ min-width:0; min-height:0; position:relative; } explorer-browser{ height:100%; } explorer-inspector{ min-width:0; }
  .split{ cursor:col-resize; position:relative; touch-action:none; } .split::after{ content:""; position:absolute; left:4px; top:12px; bottom:12px; width:2px; border-radius:2px; background:var(--border); }
  .split:hover::after, .split:focus-visible::after{ background:var(--accent); }
  .search-pane{ height:100%; overflow:hidden; }
  .search-layout{ display:grid; grid-template-columns:200px minmax(0,1fr); gap:10px; height:100%; }
  .scopes, .results{ background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); overflow-y:auto; min-height:0; }
  .scopes{ padding:8px 4px; } .scopes h3, .rg h3{ font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted); margin:6px 10px 8px; display:flex; align-items:center; gap:6px; }
  .scope{ display:flex; width:100%; justify-content:space-between; align-items:center; background:transparent; border:1px solid transparent; border-radius:6px; padding:6px 10px; font-size:13px; }
  .scope[aria-pressed="true"]{ background:var(--accent-soft); border-color:var(--accent-dim); } .scope i{ font-style:normal; color:var(--text-muted); font-size:12px; }
  .results-head{ padding:12px 14px; border-bottom:1px solid var(--border-soft); font-size:13px; }
  .rg{ padding:6px 8px 10px; } .rg h3 i{ font-style:normal; background:var(--panel-3); border-radius:999px; padding:0 7px; font-size:11px; } .rg h3 .cell-link{ margin-left:auto; font-size:12px; text-transform:none; letter-spacing:0; }
  .res{ display:flex; align-items:center; gap:10px; width:100%; text-align:left; background:transparent; border:1px solid transparent; border-radius:8px; padding:7px 8px; }
  .res:hover{ background:var(--panel-2); } .res[aria-pressed="true"]{ background:var(--accent-soft); border-color:var(--accent-dim); }
  .res .grow{ flex:1; min-width:0; } .res .t{ display:block; font-weight:650; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .res .s{ display:block; font-size:11.5px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .res .r{ color:var(--text-faint); display:flex; }
  .cell-link{ background:transparent; border:0; padding:0; color:var(--accent); cursor:pointer; }

  @media (max-width: 1000px){
    :host{ overflow-y:auto; display:block; }
    .main{ display:flex; flex-direction:column; gap:10px; min-height:0; }
    .left{ height:48vh; min-height:300px; } .split{ display:none; } explorer-inspector{ height:auto; min-height:70vh; }
    .search-layout{ grid-template-columns:1fr; } .scopes{ display:flex; overflow-x:auto; } .scopes h3, .scopes .note{ display:none; } .scope{ white-space:nowrap; width:auto; gap:6px; }
  }
`;

customElements.define("cf-explorer", CfExplorer);
