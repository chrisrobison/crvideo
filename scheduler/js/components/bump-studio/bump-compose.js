// <bump-compose> -- the Compose workspace: bump list | preview + timeline | inspector.
// Pure layout; each column is its own component bound to the shared store.

import { studioStore as store } from "./bump-studio-store.js";
import { studioCSS } from "./studio-ui.js";
import "./bump-list.js";
import "./bump-preview.js";
import "./bump-timeline.js";
import "./bump-inspector.js";

class BumpCompose extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ${studioCSS}
        :host{ display:block; height:100%; }
        .grid{
          display:grid; height:100%; min-height:0; gap:12px; padding:12px;
          grid-template-columns: 300px minmax(0,1fr) 340px;
          grid-template-areas: "list center inspector";
        }
        .col{ min-height:0; min-width:0; }
        .panel{ background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); overflow:hidden; }
        .list{ grid-area:list; }
        .center{ grid-area:center; display:flex; flex-direction:column; gap:12px; overflow:auto; }
        .inspector{ grid-area:inspector; }
        bump-list, bump-inspector{ height:100%; }
        bump-timeline{ flex:none; }
        @media (max-width: 1280px){
          .grid{ grid-template-columns: 250px minmax(0,1fr) 300px; gap:10px; padding:10px; }
        }
        @media (max-width: 1100px){
          .grid{ grid-template-columns: 230px minmax(0,1fr); grid-template-areas: "list center" "list inspector"; grid-template-rows: auto auto; height:auto; min-height:100%; }
          :host{ overflow:auto; }
          .center{ overflow:visible; }
          bump-inspector{ height:auto; }
        }
        @media (max-width: 760px){
          .grid{ grid-template-columns: minmax(0,1fr); grid-template-areas: "center" "inspector" "list"; }
          bump-list{ height:auto; max-height:60vh; }
        }
      </style>
      <div class="grid">
        <div class="col list panel"><bump-list></bump-list></div>
        <div class="col center">
          <bump-preview></bump-preview>
          <bump-timeline></bump-timeline>
        </div>
        <div class="col inspector panel"><bump-inspector></bump-inspector></div>
      </div>
    `;
    // Space toggles preview playback anywhere in Compose except while typing.
    this.addEventListener("keydown", (e) => {
      if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.composedPath()[0];
      if (t instanceof HTMLElement && (t.matches("input, select, textarea, button, [contenteditable], [role='slider']"))) return;
      e.preventDefault();
      store.togglePlay();
    });
  }
}

customElements.define("bump-compose", BumpCompose);
