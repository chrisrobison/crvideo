import { baseComponentCSS, escapeHtml, fmtHMS } from "../utils.js";

/** <cf-media-item> — set `.item = {...}` to populate. Draggable onto the timeline. */
class CfMediaItem extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.draggable = true;
      this.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/x-cf-media", this._item.id);
        e.dataTransfer.effectAllowed = "copy";
      });
      this._render();
    }
    if (this._item) this._sync();
  }

  set item(value) { this._item = value; if (this.shadowRoot) this._sync(); }
  get item() { return this._item; }

  _sync() {
    const it = this._item;
    const root = this.shadowRoot;
    root.querySelector(".title").textContent = it.title;
    root.querySelector(".duration").textContent =
      it.type === "live" ? "LIVE SOURCE" : Number.isFinite(it.duration) ? fmtHMS(it.duration) : "—:—:—";
    const badge = root.querySelector(".badge");
    badge.textContent = it.type.toUpperCase();
    badge.dataset.tone = it.type;
    root.querySelector(".thumb").dataset.tone = it.type;
    root.querySelector(".thumb-text").textContent = escapeHtml(it.thumbText || it.title.slice(0, 3).toUpperCase());
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        :host{ display:block; cursor:grab; }
        :host(:active){ cursor:grabbing; }
        .card{ display:flex; gap:10px; align-items:center; padding:8px; border-radius:var(--radius-sm);
          border:1px solid transparent; }
        :host(:hover) .card{ background:var(--panel-2); border-color:var(--border); }
        .thumb{ width:56px; height:40px; border-radius:6px; flex-shrink:0; display:flex; align-items:center;
          justify-content:center; overflow:hidden; background:linear-gradient(135deg,var(--video-a),var(--video-b));
          position:relative; }
        .thumb[data-tone="live"]{ background:linear-gradient(135deg,var(--live-a),var(--live-b)); }
        .thumb[data-tone="graphic"]{ background:var(--graphic); border:1px solid var(--border); }
        .thumb[data-tone="audio"]{ background:linear-gradient(135deg,#6d28d9,#a855f7); }
        .thumb-text{ font-size:8px; font-weight:800; letter-spacing:.03em; color:rgba(255,255,255,.85);
          text-align:center; padding:0 2px; line-height:1.1; }
        .grip{ margin-left:auto; color:var(--text-faint); font-size:14px; letter-spacing:2px; padding-left:6px; }
        .info{ min-width:0; flex:1; }
        .title{ font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .meta{ display:flex; align-items:center; gap:6px; margin-top:4px; }
        .duration{ font-size:11px; color:var(--text-muted); font-variant-numeric:tabular-nums; }
      </style>
      <div class="card">
        <div class="thumb"><span class="thumb-text"></span></div>
        <div class="info">
          <div class="title"></div>
          <div class="meta"><span class="duration"></span><span class="badge"></span></div>
        </div>
        <div class="grip">⋮⋮</div>
      </div>
    `;
  }
}
customElements.define("cf-media-item", CfMediaItem);
