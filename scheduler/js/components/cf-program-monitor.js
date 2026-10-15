import { store } from "../store.js";
import { baseComponentCSS, escapeHtml } from "../utils.js";

const BAR_COUNT = 22;

/** The block actually on air right now (ignores selection) -- used to decide
 *  whether the sync-player preview below applies, separately from which
 *  block the monitor is displaying. */
function liveNowBlock() {
  if (!store.isToday()) return null;
  const now = store.nowSeconds();
  const schedule = store.getActiveSchedule();
  const program = schedule.tracks.find((t) => t.kind === "program");
  return program.blocks.find((b) => now >= b.start && now < b.end) || null;
}

function displayedBlock() {
  const selected = store.getSelected();
  if (selected) return selected.block;
  return liveNowBlock();
}

class CfProgramMonitor extends HTMLElement {
  constructor() {
    super();
    this._viewers = 1247;
    this._levelL = 0;
    this._levelR = 0;
    this._lastBlockId = null;
  }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._render();
      this._onChange = (e) => { if (e.detail.reason !== "tick") this._renderScreen(); };
      store.addEventListener("change", this._onChange);
      this.shadowRoot.querySelector(".fullscreen-btn").addEventListener("click", () => {
        const stage = this.shadowRoot.querySelector(".stage");
        if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
      });
      this._meterLoop = setInterval(() => this._tickMeters(), 160);
      this._viewerLoop = setInterval(() => this._tickViewers(), 2500);
    }
    this._renderScreen();
  }

  disconnectedCallback() {
    store.removeEventListener("change", this._onChange);
    clearInterval(this._meterLoop);
    clearInterval(this._viewerLoop);
  }

  _isLiveish() {
    const b = displayedBlock();
    if (!b) return false;
    if (b.type === "live") return true;
    return (b.type === "video" || b.type === "audio") && this._lastMode !== "placeholder";
  }

  _tickMeters() {
    const active = this._isLiveish();
    const target = active ? 8 + Math.random() * (BAR_COUNT - 8) : Math.random() * 2;
    this._levelL += (target - this._levelL) * 0.5 + (Math.random() - 0.5);
    this._levelR += ((target + (Math.random() - 0.5) * 3) - this._levelR) * 0.5;
    this._paintMeter(".meter-l", this._levelL);
    this._paintMeter(".meter-r", this._levelR);
  }

  _paintMeter(sel, level) {
    const bars = this.shadowRoot.querySelectorAll(`${sel} .bar`);
    const lit = Math.max(0, Math.min(BAR_COUNT, Math.round(level)));
    bars.forEach((bar, i) => bar.classList.toggle("lit", i < lit));
  }

  _tickViewers() {
    if (!this._isLiveish()) return;
    this._viewers = Math.max(0, this._viewers + Math.round((Math.random() - 0.45) * 14));
    this.shadowRoot.querySelector(".viewers").textContent = this._viewers.toLocaleString();
  }

  _render() {
    const barsHtml = (cls) => `<div class="bar-row ${cls}">${Array.from({ length: BAR_COUNT })
      .map(() => `<span class="bar"></span>`).join("")}</div>`;
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        :host{ display:block; background:var(--panel); border:1px solid var(--border); border-radius:var(--radius);
          padding:14px; margin-top:16px; }
        .head{ display:flex; align-items:center; gap:8px; font-weight:800; font-size:12px; letter-spacing:.05em;
          margin-bottom:10px; }
        .head svg{ color:var(--text-muted); }
        .live-pill{ margin-left:auto; background:var(--live); color:#fff; font-size:10px; font-weight:800; padding:2px 8px;
          border-radius:999px; }
        .live-pill.off{ background:var(--panel-3); color:var(--text-faint); }
        .fullscreen-btn{ background:transparent; border:none; padding:2px 4px; color:var(--text-muted); }
        .stage{ position:relative; aspect-ratio:16/9; background:#000; border-radius:8px; overflow:hidden;
          display:flex; align-items:center; justify-content:center; }
        .stage video{ width:100%; height:100%; object-fit:contain; background:#000; }
        .stage iframe{ width:100%; height:100%; border:0; }
        .placeholder{ text-align:center; color:#aab2c5; padding:20px; }
        .placeholder .icon{ font-size:28px; margin-bottom:6px; }
        .placeholder .name{ font-weight:700; font-size:13px; color:#fff; }
        .placeholder .hint{ font-size:11px; color:var(--text-faint); margin-top:4px; }
        .footer{ display:flex; align-items:center; gap:16px; margin-top:12px; }
        .meters{ flex:1; display:flex; flex-direction:column; gap:4px; }
        .meter-line{ display:flex; align-items:center; gap:6px; font-size:10px; color:var(--text-faint); }
        .bar-row{ display:flex; gap:2px; flex:1; }
        .bar{ flex:1; height:8px; border-radius:1px; background:var(--panel-3); }
        .bar-row .bar:nth-child(-n+16).lit{ background:var(--good); }
        .bar-row .bar:nth-child(n+17):nth-child(-n+19).lit{ background:var(--warn); }
        .bar-row .bar:nth-child(n+20).lit{ background:var(--live); }
        .stat-col{ text-align:right; }
        .viewers-row{ display:flex; align-items:center; gap:5px; justify-content:flex-end; font-size:13px; font-weight:700; }
        .res-row{ display:flex; align-items:center; gap:5px; justify-content:flex-end; font-size:11px; color:var(--text-muted); margin-top:3px; }
      </style>
      <div class="head">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M17 10l4-2v8l-4-2" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        PROGRAM MONITOR
        <span class="live-pill off">OFF AIR</span>
        <button class="fullscreen-btn" title="Fullscreen">⛶</button>
      </div>
      <div class="stage"></div>
      <div class="footer">
        <div class="meters">
          <div class="meter-line">L${barsHtml("meter-l")}</div>
          <div class="meter-line">R${barsHtml("meter-r")}</div>
        </div>
        <div class="stat-col">
          <div class="viewers-row">👁 <span class="viewers">0</span></div>
          <div class="res-row"><span class="res">—</span> ⚙</div>
        </div>
      </div>
    `;
  }

  _renderScreen() {
    const root = this.shadowRoot;
    const b = displayedBlock();
    const stage = root.querySelector(".stage");
    const pill = root.querySelector(".live-pill");

    pill.textContent = b && b.type === "live" ? "LIVE" : "OFF AIR";
    pill.classList.toggle("off", !(b && b.type === "live"));
    root.querySelector(".viewers").textContent = this._viewers.toLocaleString();
    root.querySelector(".res").textContent = b
      ? (b.type === "live" ? "1080p60 · RTMP" : b.type === "graphic" ? "Graphic overlay" : "1080p · File")
      : "—";

    if (!b) {
      stage.innerHTML = `<div class="placeholder"><div class="icon">📡</div><div class="name">No signal</div></div>`;
      this._video = null;
      this._lastBlockId = null;
      this._lastMode = null;
      return;
    }

    // Streaming a Drive file straight from the browser (via an OAuth bearer
    // token) is a dead end here: Drive's media/thumbnail endpoints don't
    // allow the Authorization header in their CORS preflight, so it just
    // fails with ERR_FAILED. sync-player.html (the real on-air player)
    // sidesteps that entirely -- it only ever plays files server/download-
    // cache.php has already fetched and cached locally -- so for the block
    // that's actually live right now, embed that real player instead of
    // trying (and failing) to mint our own Drive preview URL.
    const nowBlock = liveNowBlock();
    const isLiveNow = !!nowBlock && nowBlock.id === b.id;
    const mode = b.url && (b.type === "video" || b.type === "audio") ? "video"
      : b.driveFileId && (b.type === "video" || b.type === "audio") && isLiveNow ? "sync"
      : "placeholder";

    if (b.id === this._lastBlockId && mode === this._lastMode) return; // already showing this
    this._lastBlockId = b.id;
    this._lastMode = mode;

    if (mode === "video") {
      stage.innerHTML = `<video muted playsinline autoplay loop></video>`;
      this._video = stage.querySelector("video");
      this._video.src = b.url;
      this._video.play().catch(() => {});
    } else if (mode === "sync") {
      stage.innerHTML = `<iframe class="sync-frame" src="../sync-player.html" allow="autoplay" title="Live preview"></iframe>`;
      this._video = null;
    } else {
      const icon = b.type === "live" ? "🔴" : b.type === "graphic" ? "🎛️" : "🎬";
      const hint = b.driveFileId && (b.type === "video" || b.type === "audio")
        ? `<div class="hint">Drive-only clip — preview shows here once it's on air</div>` : "";
      stage.innerHTML = `<div class="placeholder"><div class="icon">${icon}</div><div class="name">${escapeHtml(b.title)}</div>${hint}</div>`;
      this._video = null;
    }
  }
}
customElements.define("cf-program-monitor", CfProgramMonitor);
