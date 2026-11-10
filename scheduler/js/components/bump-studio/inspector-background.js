// Inspector: Background -- video (thumbnail browser), image (only when the
// media endpoint lists any), or a solid color. Only real files from the
// media listing are ever offered.

import { escapeHtml } from "../../utils.js";
import { makeThumb, icons } from "./studio-ui.js";
import { h, setValue, searchBoxHtml } from "./inspector-common.js";

export class BackgroundSection {
  constructor({ store }) {
    this.store = store;
    this.query = "";
    this.lastUrl = { video: "", image: "" }; // remembered across type switches
    this.wantsPlayback = true; // shows the real video length
  }

  key() { return `bg:${this.store.state.selectedId}:${this.store.state.draft.background?.type}`; }

  mount(container) {
    const s = this.store;
    const media = s.state.media;
    const bg = s.state.draft.background || { type: "color" };
    const hasImages = !!(media.image?.length || bg.type === "image");
    const types = [["video", "Video", icons.play, true], ["image", "Image", icons.image, hasImages], ["color", "Color", icons.swatch, true]];
    this.el = h(`
      <div>
        <style>
          .cur{ display:grid; grid-template-columns:96px minmax(0,1fr); gap:10px; align-items:center; margin:12px 0; }
          .cur .thumb{ aspect-ratio:16/9; }
          .cur .fn{ font-weight:600; font-size:13px; word-break:break-all; }
          .typeseg{ display:grid; grid-template-columns:repeat(3,1fr); width:100%; margin-bottom:14px; }
          .typeseg button{ display:flex; align-items:center; justify-content:center; gap:6px; padding:8px 0; font-size:13px; }
          .typeseg button svg{ width:15px; height:15px; }
          .typeseg button[aria-pressed="true"]{ background:var(--accent); color:#fff; }
          .h4{ font-size:13px; font-weight:700; margin:14px 0 8px; }
          .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(92px,1fr)); gap:8px; margin-top:8px; }
          .tile{ position:relative; padding:0; border:1px solid var(--border); background:var(--bg-elevated); border-radius:var(--radius-sm); overflow:hidden; text-align:left; }
          .tile[aria-pressed="true"]{ border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
          .tile .thumb{ aspect-ratio:16/9; border-radius:0; }
          .tile .cap{ display:flex; justify-content:space-between; gap:4px; padding:4px 6px; font-size:11px; color:var(--text-muted); }
          .tile .cap .n{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--text); }
          .tile .ok{ position:absolute; top:5px; right:5px; width:18px; height:18px; border-radius:50%; background:var(--accent); color:#fff; display:none; align-items:center; justify-content:center; }
          .tile .ok svg{ width:11px; height:11px; }
          .tile[aria-pressed="true"] .ok{ display:flex; }
          .selrow{ display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; }
          .selrow input{ font-size:13px; }
          .selrow button{ padding:0 10px; }
          .selrow button svg{ width:14px; height:14px; }
          .chk{ display:flex; align-items:center; gap:8px; font-size:13px; }
          .chk input{ width:auto; accent-color:var(--accent); }
          .color-row{ display:flex; gap:8px; align-items:center; margin-top:12px; }
          .color-row input[type=color]{ width:52px; height:36px; padding:2px; }
          .color-row input[type=text]{ font-family:var(--mono); }
        </style>
        <div class="seg typeseg" role="group" aria-label="Background type">
          ${types.map(([t, l, ic, ok]) => `<button data-type="${t}" aria-pressed="${bg.type === t}" ${ok ? "" : 'disabled title="No still images in media/images/ yet"'}>${ic}${l}</button>`).join("")}
        </div>
        <div class="body"></div>
      </div>`);
    container.append(this.el);
    this.el.querySelector(".seg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-type]");
      if (!b) return;
      const type = b.dataset.type;
      s.updateDraft((d) => {
        const prev = d.background || {};
        if (prev.type === "video" || prev.type === "image") this.lastUrl[prev.type] = prev.url || "";
        if (prev.type === "color") this.lastColor = prev.color;
        d.background = type === "color" ? { type, color: this.lastColor || "#14213d" } : { type, url: this.lastUrl[type] || "" };
      }, "inspector");
    });
    const body = this.el.querySelector(".body");
    if (bg.type === "color") this._mountColor(body);
    else this._mountFiles(body, bg.type, bg.type === "image" ? media.image || [] : media.video || []);
    this.update();
  }

  _mountColor(body) {
    body.append(h(`<div class="color-row">
      <input type="color" class="c" aria-label="Background color">
      <input type="text" class="hex" maxlength="40" aria-label="Background color value" spellcheck="false">
    </div>`));
    const set = (v) => this.store.updateDraft((d) => { d.background = { type: "color", color: v }; }, "inspector");
    body.querySelector(".c").addEventListener("input", (e) => set(e.target.value));
    body.querySelector(".hex").addEventListener("change", (e) => { if (e.target.value.trim()) set(e.target.value.trim()); });
  }

  _mountFiles(body, type, files) {
    const noun = type === "image" ? "image" : "video";
    body.append(h(`<div>
      <div class="h4" style="margin-top:0">Select ${type === "image" ? "Image" : "Video"}</div>
      ${files.length ? searchBoxHtml("Search media...") : ""}
      <div class="grid" role="group" aria-label="${noun}s"></div>
      ${files.length ? "" : `<div class="empty-state"><p>No ${noun} files found under media/${type === "image" ? "images" : "video"}/.</p></div>`}
      <div class="h4">Selected</div>
      <div class="selrow"><input class="selname" readonly aria-label="Selected ${noun}"><button class="selplay" aria-label="Play preview" title="Play the preview">${icons.play}</button></div>
      <div class="small muted meta" style="margin-top:6px"></div>
      ${type === "video" ? `<div class="h4">Playback</div>
      <label class="chk" title="Background video always loops to fill the bump (a player behavior, not a saved setting)"><input type="checkbox" checked disabled> Loop (always on)</label>` : ""}
    </div>`));
    const grid = body.querySelector(".grid");
    for (const f of files) {
      const tile = h(`<button class="tile" data-url="${escapeHtml(f.url)}" aria-pressed="false" title="${escapeHtml(f.name)}">
        <span class="ok">${icons.check}</span><span class="cap"><span class="n">${escapeHtml(f.name)}</span><span class="d tnum"></span></span></button>`);
      const thumb = makeThumb(type, f.url);
      tile.prepend(thumb);
      thumb.addEventListener("thumb-duration", (e) => {
        const d = e.detail;
        if (Number.isFinite(d)) tile.querySelector(".d").textContent = `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, "0")}`;
      });
      grid.append(tile);
    }
    grid.addEventListener("click", (e) => {
      const t = e.target.closest("[data-url]");
      if (t) this.store.updateDraft((d) => { d.background = { type, url: t.dataset.url }; }, "inspector");
    });
    body.querySelector(".q")?.addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      grid.querySelectorAll(".tile").forEach((t) => { t.hidden = !!q && !t.dataset.url.toLowerCase().includes(q); });
    });
    body.querySelector(".selplay").addEventListener("click", () => this.store.togglePlay());
  }

  update() {
    const bg = this.store.state.draft.background || {};
    if (bg.type === "color") {
      const c = /^#[0-9a-f]{6}$/i.test(bg.color || "") ? bg.color : "#14213d";
      setValue(this.el.querySelector(".c"), c);
      setValue(this.el.querySelector(".hex"), bg.color || "");
      return;
    }
    this.el.querySelectorAll(".tile").forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.url === bg.url)));
    const name = this.el.querySelector(".selname");
    if (!name) return;
    name.value = bg.url ? bg.url.split("/").pop() : `No ${bg.type} selected`;
    const len = this.store.state.playback.durations?.video;
    this.el.querySelector(".meta").textContent = bg.url
      ? (bg.type === "video" ? (len ? `${len.toFixed(1)}s clip, loops to fill the bump` : "Loops to fill the bump") : "Still image")
      : "Pick one above.";
    const playing = this.store.state.playback.playing;
    const btn = this.el.querySelector(".selplay");
    btn.innerHTML = playing ? icons.pause : icons.play;
    btn.setAttribute("aria-label", playing ? "Pause preview" : "Play preview");
  }
}
