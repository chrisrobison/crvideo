import { baseComponentCSS } from "../utils.js";

const ICONS = {
  play: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".15"/><path d="M10 8.5l6 3.5-6 3.5v-7z" fill="currentColor"/></svg>`,
  warn: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3l10 18H2L12 3z" fill="currentColor" opacity=".18"/><path d="M12 9v5m0 3h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  alert: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".18"/><path d="M12 7v6m0 4h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  live: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".18"/><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M7 7a7 7 0 000 10M17 7a7 7 0 010 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
};

/** <cf-stat-card icon="play" tone="accent" label="Scheduled" value="23h 42m"></cf-stat-card> */
class CfStatCard extends HTMLElement {
  static get observedAttributes() { return ["icon", "tone", "label", "value"]; }
  connectedCallback() { if (!this.shadowRoot) { this.attachShadow({ mode: "open" }); this._render(); } this._sync(); }
  attributeChangedCallback() { if (this.shadowRoot) this._sync(); }

  _sync() {
    const root = this.shadowRoot;
    root.querySelector(".icon").innerHTML = ICONS[this.getAttribute("icon")] || ICONS.play;
    root.querySelector(".icon").dataset.tone = this.getAttribute("tone") || "accent";
    root.querySelector(".label").textContent = this.getAttribute("label") || "";
    root.querySelector(".value").textContent = this.getAttribute("value") || "—";
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        :host{ display:block; }
        .card{ display:flex; align-items:center; gap:14px; background:var(--panel); border:1px solid var(--border);
          border-radius:var(--radius); padding:16px 18px; height:100%; }
        .icon{ width:44px; height:44px; border-radius:10px; display:flex; align-items:center; justify-content:center;
          background:var(--panel-3); flex-shrink:0; }
        .icon[data-tone="accent"]{ background:var(--accent-soft); color:var(--accent); }
        .icon[data-tone="warn"]{ background:var(--warn-soft); color:var(--warn); }
        .icon[data-tone="danger"]{ background:var(--live-soft); color:var(--live); }
        .icon[data-tone="live"]{ background:var(--purple-soft); color:var(--cyan); }
        .label{ color:var(--text-muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
        .value{ font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; margin-top:2px; }
      </style>
      <div class="card">
        <div class="icon"></div>
        <div><div class="label"></div><div class="value"></div></div>
      </div>
    `;
  }
}
customElements.define("cf-stat-card", CfStatCard);
