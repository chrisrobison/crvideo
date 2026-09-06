import { store } from "../store.js";
import { baseComponentCSS, fmtBytes } from "../utils.js";
import "./cf-media-item.js";

const FILTERS = ["All", "Video", "Audio", "Graphics", "Live"];

class CfMediaLibrary extends HTMLElement {
  constructor() {
    super();
    this._filter = "All";
    this._query = "";
    this._collapsed = false;
  }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._render();
      this._wire();
      this._onChange = (e) => {
        if (["media", "media-duration", "media-thumbnail"].includes(e.detail.reason)) this._renderList();
      };
      store.addEventListener("change", this._onChange);
    }
    this._renderList();
  }

  disconnectedCallback() { store.removeEventListener("change", this._onChange); }

  _wire() {
    const root = this.shadowRoot;
    root.querySelector(".search").addEventListener("input", (e) => { this._query = e.target.value.toLowerCase(); this._renderList(); });
    root.querySelector(".tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-filter]");
      if (!btn) return;
      this._filter = btn.dataset.filter;
      root.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
      this._renderList();
    });
    root.querySelector(".collapse-btn").addEventListener("click", () => {
      this._collapsed = !this._collapsed;
      root.querySelector(".body").classList.toggle("hidden", this._collapsed);
      root.querySelector(".collapse-btn").textContent = this._collapsed ? "⌄" : "⌃";
    });

    const fileInput = root.querySelector(".file-input");
    const dropzone = root.querySelector(".dropzone");
    dropzone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      [...fileInput.files].forEach((f) => store.addMediaFile(f));
      fileInput.value = "";
    });
    dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag");
      [...(e.dataTransfer.files || [])].forEach((f) => store.addMediaFile(f));
    });
  }

  _matchesFilter(item) {
    if (this._filter === "All") return true;
    if (this._filter === "Video") return item.type === "video";
    if (this._filter === "Audio") return item.type === "audio";
    if (this._filter === "Graphics") return item.type === "graphic";
    if (this._filter === "Live") return item.type === "live";
    return true;
  }

  _renderList() {
    const root = this.shadowRoot;
    const list = root.querySelector(".list");
    const items = store.media.filter((m) => this._matchesFilter(m) && m.title.toLowerCase().includes(this._query));
    list.innerHTML = "";
    for (const item of items) {
      const el = document.createElement("cf-media-item");
      el.item = item;
      list.appendChild(el);
    }
    if (!items.length) {
      list.innerHTML = `<div class="empty muted">No media matches.</div>`;
    }
    const totalBytes = store.media.reduce((sum, m) => sum + (m.sizeBytes || 0), 0);
    root.querySelector(".footer-count").textContent = `${store.media.length} item${store.media.length === 1 ? "" : "s"}`;
    root.querySelector(".footer-size").textContent = fmtBytes(totalBytes);
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        :host{ display:flex; flex-direction:column; height:100%; background:var(--panel); border:1px solid var(--border);
          border-radius:var(--radius); overflow:hidden; }
        .head{ display:flex; align-items:center; gap:8px; padding:14px 14px 10px; font-weight:800; font-size:12px;
          letter-spacing:.05em; }
        .head svg{ color:var(--text-muted); }
        .collapse-btn{ margin-left:auto; background:transparent; border:none; padding:2px 6px; font-size:14px; }
        .body{ display:flex; flex-direction:column; min-height:0; flex:1; }
        .search-wrap{ padding:0 14px 10px; }
        .tabs{ display:flex; gap:4px; padding:0 14px 10px; flex-wrap:wrap; }
        .tabs button{ padding:5px 10px; font-size:11px; font-weight:700; border-radius:999px; background:var(--panel-2); }
        .tabs button.active{ background:var(--accent); border-color:var(--accent); color:#fff; }
        .list{ flex:1; overflow-y:auto; padding:2px 8px 8px; display:flex; flex-direction:column; gap:2px; }
        .empty{ padding:16px; text-align:center; font-size:12px; }
        .dropzone{ margin:10px 14px 14px; border:1.5px dashed var(--border); border-radius:var(--radius);
          padding:18px 10px; text-align:center; color:var(--text-muted); font-size:12px; cursor:pointer; }
        .dropzone.drag{ border-color:var(--accent); color:var(--text); background:var(--accent-soft); }
        .dropzone svg{ margin:0 auto 6px; color:var(--text-faint); }
        .footer{ display:flex; align-items:center; justify-content:space-between; padding:10px 14px;
          border-top:1px solid var(--border); font-size:11px; color:var(--text-muted); }
      </style>
      <div class="head">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M3 9h18" stroke="currentColor" stroke-width="1.6"/></svg>
        MEDIA LIBRARY
        <button class="collapse-btn">⌃</button>
      </div>
      <div class="body">
        <div class="search-wrap"><input class="search" type="search" placeholder="Search media..."></div>
        <div class="tabs">${FILTERS.map((f, i) => `<button data-filter="${f}" class="${i === 0 ? "active" : ""}">${f.toUpperCase()}</button>`).join("")}</div>
        <div class="list"></div>
        <div class="dropzone">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 16V4m0 0L7 9m5-5l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          Drag &amp; drop media here<br>or click to browse
          <input class="file-input" type="file" accept="video/*,audio/*,image/*" multiple hidden>
        </div>
        <div class="footer"><span class="footer-count"></span><span class="footer-size"></span></div>
      </div>
    `;
  }
}
customElements.define("cf-media-library", CfMediaLibrary);
