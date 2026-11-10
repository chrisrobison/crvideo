// <bump-library-workspace> -- the Library tab.
//
// PHASE A: a minimal, functional overview table (search, channel usage,
// open-in-Compose). Duplicate/rename/delete live in Compose's list context
// menu for now. Placeholder for the Library redesign (thumbnails, filters,
// last-modified sort, guarded delete showing affected channels).
//
// Store API to build on: store.state.bumps, store.referencesTo(id),
// store.openInCompose(id), store.duplicate(id), store.rename(id, name),
// store.remove(id), and the "bumps"/"schedules" change keys.

import { escapeHtml } from "../../utils.js";
import { studioStore as store } from "./bump-studio-store.js";
import { studioCSS, icons } from "./studio-ui.js";
import { fileLabel } from "./bump-model.js";

class BumpLibraryWorkspace extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ${studioCSS}
        :host{ display:block; }
        .wrap{ max-width:1200px; margin:0 auto; padding:16px 20px 32px; }
        .top{ display:flex; gap:10px; align-items:center; margin-bottom:12px; }
        .top .search{ width:280px; }
        table{ width:100%; border-collapse:collapse; font-size:13px; }
        th{ text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); font-weight:700; padding:6px 10px; border-bottom:1px solid var(--border); }
        td{ padding:8px 10px; border-bottom:1px solid var(--border-soft); vertical-align:middle; }
        tbody tr{ cursor:pointer; }
        tbody tr:hover{ background:var(--panel); }
        tbody tr:focus-visible{ outline:2px solid var(--accent); outline-offset:-2px; }
        .sw{ display:inline-block; width:12px; height:12px; border-radius:3px; vertical-align:middle; margin-right:6px; }
        .voice svg{ width:14px; height:14px; color:#cbb3ff; }
      </style>
      <div class="wrap">
        <div class="top">
          <label class="search"><span class="sr-only">Search bumps</span>${icons.search}<input type="search" placeholder="Search bumps"></label>
          <span class="count small muted"></span>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Background</th><th>Voice</th><th>Music</th><th>Length</th><th>Channels</th><th>Updated</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    `;
    this._q = "";
    this.shadowRoot.querySelector("input").addEventListener("input", (e) => { this._q = e.target.value.trim().toLowerCase(); this._render(); });
    const tbody = this.shadowRoot.querySelector("tbody");
    tbody.addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) store.openInCompose(tr.dataset.id); });
    tbody.addEventListener("keydown", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr && e.key === "Enter") store.openInCompose(tr.dataset.id);
    });
    this._onChange = ({ detail }) => { if (["bumps", "schedules", "status"].some((k) => detail.keys.has(k))) this._render(); };
    store.addEventListener("change", this._onChange);
    this._render();
  }

  disconnectedCallback() { store.removeEventListener("change", this._onChange); }

  _render() {
    const rows = store.state.bumps.filter((b) => !this._q || String(b.name || b.id).toLowerCase().includes(this._q));
    this.shadowRoot.querySelector(".count").textContent = `${rows.length} of ${store.state.bumps.length}`;
    this.shadowRoot.querySelector("tbody").innerHTML = rows.map((b) => {
      const bg = b.background || {};
      const refs = store.referencesTo(b.id);
      return `<tr data-id="${escapeHtml(b.id)}" tabindex="0" title="Open in Compose">
        <td><strong>${escapeHtml(b.name || b.id)}</strong></td>
        <td>${bg.type === "color" ? `<span class="sw" style="background:${escapeHtml(bg.color)}"></span>${escapeHtml(bg.color)}` : `${escapeHtml(bg.type)} · ${escapeHtml(fileLabel(bg.url))}`}</td>
        <td class="voice">${b.announcement ? icons.mic : `<span class="faint">—</span>`}</td>
        <td>${(b.audio || []).length}</td>
        <td>${b.duration ? `${Number(b.duration)}s` : `<span class="faint">rule</span>`}</td>
        <td title="${escapeHtml(refs.map((c) => c.name).join(", "))}">${refs.length || `<span class="faint">0</span>`}</td>
        <td class="small muted">${b.updatedAt ? escapeHtml(new Date(b.updatedAt).toLocaleDateString()) : ""}</td>
      </tr>`;
    }).join("");
  }
}

customElements.define("bump-library-workspace", BumpLibraryWorkspace);
