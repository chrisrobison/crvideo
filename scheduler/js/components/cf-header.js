import { store } from "../store.js";
import { baseComponentCSS, escapeHtml, dateLabel, dateLabelFull, secToClock } from "../utils.js";

class CfHeader extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._render();
      this._onChange = (e) => {
        if (e.detail.reason === "tick") this._renderClock();
        else this._render();
      };
      store.addEventListener("change", this._onChange);
    }
    this._render();
  }

  disconnectedCallback() { store.removeEventListener("change", this._onChange); }

  _wire() {
    const root = this.shadowRoot;
    root.querySelector(".channel-select").addEventListener("change", (e) => store.setChannel(e.target.value));
    root.querySelector(".prev-day").addEventListener("click", () => store.shiftDate(-1));
    root.querySelector(".next-day").addEventListener("click", () => store.shiftDate(1));
    root.querySelector(".validate-btn").addEventListener("click", () => store.validate());
    root.querySelector(".publish-btn").addEventListener("click", () => store.publish());
  }

  _renderClock() {
    const root = this.shadowRoot;
    const now = new Date();
    root.querySelector(".clock-time").textContent = secToClock(
      now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds(), true);
    root.querySelector(".clock-date").textContent = `${dateLabelFull(
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`)}`;
  }

  _render() {
    const root = this.shadowRoot;
    const stats = store.computeStats();
    const onAirLive = stats.liveSec > 0 && (() => {
      const found = store.computeRundown().find((r) => r.status === "ON_AIR");
      return found && found.type === "live";
    })();

    if (!root.innerHTML) {
      root.innerHTML = `
        <style>
          ${baseComponentCSS}
          :host{ display:block; }
          header{ display:flex; align-items:center; gap:18px; padding:12px 20px; border-bottom:1px solid var(--border);
            background:var(--bg-elevated); flex-wrap:wrap; }
          .logo{ display:flex; align-items:center; gap:8px; font-weight:800; font-size:18px; letter-spacing:-.02em; }
          .logo svg{ color:var(--accent); }
          nav{ display:flex; gap:18px; margin-left:6px; }
          nav a{ font-size:12px; font-weight:700; letter-spacing:.05em; color:var(--text-muted); text-decoration:none;
            padding:4px 0; border-bottom:2px solid transparent; cursor:default; }
          nav a.active{ color:var(--text); border-bottom-color:var(--accent); }
          .channel-select{ min-width:150px; font-weight:600; }
          .date-nav{ display:flex; align-items:center; gap:6px; background:var(--panel-2); border:1px solid var(--border);
            border-radius:var(--radius-sm); padding:4px 6px; }
          .date-nav button{ background:transparent; border:none; padding:4px 6px; }
          .date-label{ font-weight:700; font-size:12px; letter-spacing:.03em; min-width:100px; text-align:center; }
          .live-badge{ display:flex; align-items:center; gap:6px; background:var(--live); color:#fff; font-weight:800;
            font-size:12px; letter-spacing:.04em; padding:6px 12px; border-radius:999px; }
          .live-badge .dot{ width:7px; height:7px; border-radius:50%; background:#fff; animation:pulse 1.4s infinite; }
          .live-badge.idle{ background:var(--panel-3); color:var(--text-faint); }
          .live-badge.idle .dot{ animation:none; background:var(--text-faint); }
          @keyframes pulse{ 0%,100%{ opacity:1; } 50%{ opacity:.35; } }
          .clock{ text-align:center; line-height:1.1; }
          .clock-time{ font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; }
          .clock-date{ font-size:10px; color:var(--text-muted); letter-spacing:.04em; }
          .spacer{ flex:1 1 auto; }
          .actions{ display:flex; gap:10px; }
        </style>
        <header>
          <div class="logo">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="14" rx="3" fill="currentColor" opacity=".2"/><path d="M9 8.5l6 3.5-6 3.5v-7z" fill="currentColor"/></svg>
            ChannelFlow
          </div>
          <nav>
            <a class="active">SCHEDULE</a><a>PLAYOUT</a><a>STREAM</a><a>TOGETHER</a>
          </nav>
          <select class="channel-select"></select>
          <div class="date-nav">
            <button class="prev-day" title="Previous day">◀</button>
            <span class="date-label"></span>
            <button class="next-day" title="Next day">▶</button>
          </div>
          <div class="live-badge"><span class="dot"></span><span class="label">LIVE</span></div>
          <div class="clock"><div class="clock-time"></div><div class="clock-date"></div></div>
          <div class="spacer"></div>
          <div class="actions">
            <button class="validate-btn">Validate Schedule</button>
            <button class="publish-btn primary">Publish</button>
          </div>
        </header>
      `;
      this._wire();
    }

    const select = root.querySelector(".channel-select");
    select.innerHTML = store.channels.map((c) =>
      `<option value="${escapeHtml(c.id)}" ${c.id === store.activeChannelId ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");

    root.querySelector(".date-label").textContent = dateLabel(store.activeDate);

    const liveBadge = root.querySelector(".live-badge");
    liveBadge.classList.toggle("idle", !onAirLive);
    liveBadge.querySelector(".label").textContent = onAirLive ? "LIVE" : "OFF AIR";

    this._renderClock();
  }
}
customElements.define("cf-header", CfHeader);
