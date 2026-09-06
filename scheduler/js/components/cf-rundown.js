import { store } from "../store.js";
import { baseComponentCSS, escapeHtml, secToClock, fmtHMS } from "../utils.js";

const COLLAPSED_COUNT = 6;

const STATUS_LABEL = { ON_AIR: "ON AIR", READY: "READY", FALLBACK: "FALLBACK SET", ATTENTION: "ATTENTION" };
const STATUS_TONE = { ON_AIR: "live", READY: "graphic", FALLBACK: "warn", ATTENTION: "warn" };

class CfRundown extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._render();
      this._onChange = (e) => { if (e.detail.reason !== "tick" || true) this._renderRows(); };
      store.addEventListener("change", this._onChange);
      this.shadowRoot.querySelector(".show-all").addEventListener("click", () => {
        store.rundownShowAll = !store.rundownShowAll;
        this._renderRows();
      });
    }
    this._renderRows();
  }

  disconnectedCallback() { store.removeEventListener("change", this._onChange); }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        :host{ display:block; background:var(--panel); border:1px solid var(--border); border-radius:var(--radius);
          overflow:hidden; }
        .head{ display:flex; align-items:center; gap:8px; padding:14px 16px; font-weight:800; font-size:12px;
          letter-spacing:.05em; border-bottom:1px solid var(--border); }
        .head svg{ color:var(--text-muted); }
        table{ width:100%; border-collapse:collapse; }
        th{ text-align:left; padding:8px 16px; font-size:11px; text-transform:uppercase; letter-spacing:.04em;
          color:var(--text-muted); border-bottom:1px solid var(--border); }
        td{ padding:10px 16px; border-bottom:1px solid var(--border-soft); font-size:13px; vertical-align:middle; }
        tr.on-air td{ background:rgba(239,68,68,.08); }
        tr.attention td{ background:rgba(245,165,36,.06); }
        tr:hover td{ background-color:rgba(255,255,255,.02); }
        .onair-cell{ display:flex; align-items:center; gap:6px; color:var(--live); font-weight:800; font-size:11px; }
        .dot{ width:7px; height:7px; border-radius:50%; background:var(--live); animation:pulse 1.4s infinite; }
        @keyframes pulse{ 0%,100%{ opacity:1; } 50%{ opacity:.3; } }
        .play-btn{ background:transparent; border:none; color:var(--text-muted); font-size:13px; padding:2px 4px; }
        .play-btn:hover{ color:var(--text); }
        .status{ padding:3px 10px; border-radius:999px; font-size:10px; font-weight:800; letter-spacing:.03em; }
        .status[data-tone="live"]{ background:var(--live); color:#fff; }
        .status[data-tone="graphic"]{ background:var(--good-soft); color:#8fe3ac; }
        .status[data-tone="warn"]{ background:var(--warn-soft); color:#ffd28f; }
        .gap-title{ color:var(--warn); font-weight:600; }
        button.show-all{ margin-left:auto; }
      </style>
      <div class="head">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M3 10h18M8 4v16" stroke="currentColor" stroke-width="1.6"/></svg>
        UPCOMING RUNDOWN
        <button class="show-all">Show All Day</button>
      </div>
      <table>
        <thead><tr><th>On Air</th><th>Start</th><th>Program</th><th>Source</th><th>Duration</th><th>Status</th></tr></thead>
        <tbody></tbody>
      </table>
    `;
  }

  _renderRows() {
    const root = this.shadowRoot;
    const rows = store.computeRundown();
    const now = store.nowSeconds();
    const isToday = store.isToday();
    let visible = rows;
    if (!store.rundownShowAll) {
      const fromIdx = isToday ? rows.findIndex((r) => r.end > now) : 0;
      visible = rows.slice(Math.max(0, fromIdx), Math.max(0, fromIdx) + COLLAPSED_COUNT);
    }
    root.querySelector(".show-all").textContent = store.rundownShowAll ? "Show Less" : "Show All Day";

    root.querySelector("tbody").innerHTML = visible.map((r) => {
      const isGap = r.kind === "gap";
      const rowClass = r.status === "ON_AIR" ? "on-air" : r.status === "ATTENTION" ? "attention" : "";
      const onAirCell = r.status === "ON_AIR"
        ? `<div class="onair-cell"><span class="dot"></span>ON AIR</div>`
        : isGap
          ? `<span class="muted">⚠</span>`
          : `<button class="play-btn" data-select="${escapeHtml(r.id)}">▶</button>`;
      return `
        <tr class="${rowClass}">
          <td>${onAirCell}</td>
          <td>${secToClock(r.start)}</td>
          <td>${isGap ? `<span class="gap-title">${escapeHtml(r.title)}</span>` : escapeHtml(r.title)}</td>
          <td class="muted">${isGap ? "–" : escapeHtml(r.source || "—")}</td>
          <td class="muted">${isGap ? "---" : fmtHMS(r.duration)}</td>
          <td><span class="status" data-tone="${STATUS_TONE[r.status]}">${STATUS_LABEL[r.status]}</span></td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="6" class="muted" style="text-align:center;padding:24px;">Nothing scheduled.</td></tr>`;

    root.querySelectorAll("[data-select]").forEach((btn) => {
      btn.addEventListener("click", () => store.selectBlock(btn.dataset.select));
    });
  }
}
customElements.define("cf-rundown", CfRundown);
