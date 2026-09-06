import { store } from "../store.js";
import { baseComponentCSS } from "../utils.js";
import { fmtHoursMinutes } from "../utils.js";
import "./cf-stat-card.js";

class CfStatBar extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = `
        <style>
          ${baseComponentCSS}
          .grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; }
          @media (max-width:1100px){ .grid{ grid-template-columns:repeat(2,1fr); } }
        </style>
        <div class="grid">
          <cf-stat-card icon="play" tone="accent" label="Scheduled"></cf-stat-card>
          <cf-stat-card icon="warn" tone="warn" label="Gaps"></cf-stat-card>
          <cf-stat-card icon="alert" tone="danger" label="Conflicts"></cf-stat-card>
          <cf-stat-card icon="live" tone="live" label="Live"></cf-stat-card>
        </div>
      `;
      this._onChange = () => this._render();
      store.addEventListener("change", this._onChange);
    }
    this._render();
  }

  disconnectedCallback() { store.removeEventListener("change", this._onChange); }

  _render() {
    const stats = store.computeStats();
    const cards = this.shadowRoot.querySelectorAll("cf-stat-card");
    cards[0].setAttribute("value", fmtHoursMinutes(stats.scheduledSec));
    cards[1].setAttribute("value", String(stats.gapCount));
    cards[2].setAttribute("value", String(stats.conflictCount));
    cards[3].setAttribute("value", fmtHoursMinutes(stats.liveSec));
  }
}
customElements.define("cf-stat-bar", CfStatBar);
