import { baseComponentCSS } from "../utils.js";

/**
 * <cf-toggle label="Auto start" description="Start automatically at scheduled time" checked></cf-toggle>
 * Fires a `change` CustomEvent with detail:{checked} when toggled.
 */
class CfToggle extends HTMLElement {
  static get observedAttributes() { return ["checked", "label", "description", "disabled"]; }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._render();
      this.shadowRoot.querySelector(".switch").addEventListener("click", () => {
        if (this.hasAttribute("disabled")) return;
        this.checked = !this.checked;
        this.dispatchEvent(new CustomEvent("change", { detail: { checked: this.checked }, bubbles: true }));
      });
      this.shadowRoot.querySelector(".switch").addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); this.shadowRoot.querySelector(".switch").click(); }
      });
    } else {
      this._sync();
    }
  }

  attributeChangedCallback() { if (this.shadowRoot) this._sync(); }

  get checked() { return this.hasAttribute("checked"); }
  set checked(v) { v ? this.setAttribute("checked", "") : this.removeAttribute("checked"); }

  _sync() {
    const root = this.shadowRoot;
    root.querySelector(".switch").setAttribute("aria-checked", String(this.checked));
    root.querySelector(".label").textContent = this.getAttribute("label") || "";
    const desc = this.getAttribute("description") || "";
    const descEl = root.querySelector(".desc");
    descEl.textContent = desc;
    descEl.classList.toggle("hidden", !desc);
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        .row{ display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:12px 0;
          border-bottom:1px solid var(--border-soft); }
        :host(:last-child) .row{ border-bottom:none; }
        .text{ min-width:0; }
        .label{ font-weight:600; font-size:13px; }
        .desc{ color:var(--text-muted); font-size:12px; margin-top:2px; }
        .switch{
          flex-shrink:0; width:40px; height:22px; border-radius:999px; background:var(--panel-3);
          border:1px solid var(--border); position:relative; cursor:pointer; padding:0;
        }
        .switch::after{
          content:""; position:absolute; top:1px; left:1px; width:18px; height:18px; border-radius:50%;
          background:#aab2c5; transition:transform .15s ease, background .15s ease;
        }
        .switch[aria-checked="true"]{ background:var(--good); border-color:var(--good); }
        .switch[aria-checked="true"]::after{ transform:translateX(18px); background:#fff; }
      </style>
      <div class="row">
        <div class="text"><div class="label"></div><div class="desc muted"></div></div>
        <button class="switch" type="button" role="switch" aria-checked="false"></button>
      </div>
    `;
    this._sync();
  }
}
customElements.define("cf-toggle", CfToggle);
