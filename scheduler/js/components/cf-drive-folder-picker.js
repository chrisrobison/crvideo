import { baseComponentCSS, escapeHtml } from "../utils.js";
import * as drive from "../drive.js";

/**
 * <cf-drive-folder-picker> — a <dialog>-based Drive folder browser.
 * Usage: const result = await picker.open();  // {id,name} or null if cancelled
 */
class CfDriveFolderPicker extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this._path = [{ id: "root", name: "My Drive" }];
    this._current = this._path[0];
    this._render();
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        dialog{ background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:var(--radius);
          padding:0; width:min(520px,90vw); }
        dialog::backdrop{ background:rgba(0,0,0,.6); }
        .head{ padding:16px; border-bottom:1px solid var(--border); font-weight:800; font-size:14px; }
        .crumbs{ padding:10px 16px; display:flex; gap:4px; flex-wrap:wrap; align-items:center; font-size:12px;
          color:var(--text-muted); border-bottom:1px solid var(--border-soft); }
        .crumbs button{ background:transparent; border:none; padding:2px 4px; color:var(--accent); font-size:12px; }
        .crumbs span{ color:var(--text-faint); }
        .list{ max-height:320px; min-height:120px; overflow-y:auto; padding:8px; }
        .folder-row{ display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:6px; cursor:pointer;
          font-size:13px; border:1px solid transparent; }
        .folder-row:hover{ background:var(--panel-2); }
        .folder-row.active{ background:var(--accent-soft); border-color:var(--accent); }
        .empty{ padding:24px; text-align:center; color:var(--text-muted); font-size:13px; }
        .hint{ padding:6px 16px 0; font-size:11px; color:var(--text-faint); }
        .foot{ display:flex; justify-content:flex-end; gap:8px; padding:14px 16px; border-top:1px solid var(--border); }
      </style>
      <dialog>
        <div class="head">Choose a Drive folder</div>
        <div class="crumbs"></div>
        <div class="hint">Click to select, double-click to open a folder</div>
        <div class="list"></div>
        <div class="foot">
          <button class="cancel-btn">Cancel</button>
          <button class="select-btn primary">Use this folder</button>
        </div>
      </dialog>
    `;
    this._dialog = this.shadowRoot.querySelector("dialog");
    this.shadowRoot.querySelector(".cancel-btn").addEventListener("click", () => this._settle(null));
    this.shadowRoot.querySelector(".select-btn").addEventListener("click", () => this._settle(this._current));
    this._dialog.addEventListener("cancel", () => this._settle(null));
  }

  open() {
    this._path = [{ id: "root", name: "My Drive" }];
    this._current = this._path[0];
    this._dialog.showModal();
    this._load();
    return new Promise((resolve) => { this._resolveFn = resolve; });
  }

  _settle(value) {
    this._dialog.close();
    if (this._resolveFn) { this._resolveFn(value); this._resolveFn = null; }
  }

  async _load() {
    const list = this.shadowRoot.querySelector(".list");
    list.innerHTML = `<div class="empty">Loading…</div>`;
    this._renderCrumbs();
    try {
      const files = await drive.listFolder(this._current.id);
      const folders = files.filter(drive.isFolder);
      list.innerHTML = folders.length
        ? folders.map((f) => `<div class="folder-row" data-id="${escapeHtml(f.id)}" data-name="${escapeHtml(f.name)}">📁 ${escapeHtml(f.name)}</div>`).join("")
        : `<div class="empty">No subfolders here — you can still use this folder.</div>`;
      list.querySelectorAll(".folder-row").forEach((row) => {
        row.addEventListener("click", () => {
          list.querySelectorAll(".folder-row").forEach((r) => r.classList.remove("active"));
          row.classList.add("active");
          this._current = { id: row.dataset.id, name: row.dataset.name };
        });
        row.addEventListener("dblclick", () => {
          this._path.push({ id: row.dataset.id, name: row.dataset.name });
          this._current = this._path[this._path.length - 1];
          this._load();
        });
      });
    } catch (e) {
      list.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    }
  }

  _renderCrumbs() {
    const crumbs = this.shadowRoot.querySelector(".crumbs");
    crumbs.innerHTML = this._path.map((p, i) =>
      `<button data-idx="${i}">${escapeHtml(p.name)}</button>${i < this._path.length - 1 ? "<span>/</span>" : ""}`).join("");
    crumbs.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        const idx = Number(b.dataset.idx);
        this._path = this._path.slice(0, idx + 1);
        this._current = this._path[this._path.length - 1];
        this._load();
      });
    });
  }
}
customElements.define("cf-drive-folder-picker", CfDriveFolderPicker);
