// <bump-inspector> -- Compose's right column. Shows controls for exactly
// one layer at a time (Bump / Background / Music / Voice / Text), chosen by
// the tabs here or by clicking a timeline track.
//
// Each section (inspector-*.js) implements a tiny interface:
//   mount(container)  build its DOM once
//   update()          refresh values in place (never steals focus)
//   key()             a "structure" signature; when it changes the section
//                     is rebuilt (e.g. a music layer was added)
//   destroy()         optional cleanup
// so typing in a field never re-renders the field you're typing in, and
// drags on the timeline update the inspector's numbers live.

import { studioStore as store, LAYERS } from "./bump-studio-store.js";
import { studioCSS, icons, mediaUrl } from "./studio-ui.js";
import { fileLabel, findAnnouncement } from "./bump-model.js";
import { GeneralSection } from "./inspector-general.js";
import { BackgroundSection } from "./inspector-background.js";
import { MusicSection } from "./inspector-music.js";
import { AnnouncerSection } from "./inspector-announcer.js";
import { TextSection } from "./inspector-text.js";

const SECTIONS = { bump: GeneralSection, background: BackgroundSection, music: MusicSection, announcer: AnnouncerSection, text: TextSection };
const TAB_LABELS = { bump: "Bump", background: "Background", music: "Music", announcer: "Voice", text: "Text" };
const TAB_ICONS = { bump: icons.sliders, background: icons.film, music: icons.music, announcer: icons.mic, text: icons.text };

/** One shared <audio> for auditioning a file from any section. */
class Audition {
  constructor() {
    this.el = new Audio();
    this.el.preload = "none";
    this.url = null;
    this.onchange = () => {};
    this.el.addEventListener("ended", () => this.stop());
  }

  toggle(path, volume = 1) {
    if (this.url === path && !this.el.paused) { this.stop(); return; }
    store.pause(); // never audition over the running preview
    this.url = path;
    this.el.src = mediaUrl(path);
    this.el.volume = Math.min(1, Math.max(0, Number(volume) || 1));
    this.el.play().catch(() => {});
    this.onchange();
  }

  isPlaying(path) { return this.url === path && !this.el.paused; }

  stop() {
    this.el.pause();
    this.url = null;
    this.onchange();
  }
}

class BumpInspector extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ${studioCSS}
        :host{ display:flex; flex-direction:column; min-height:0; background:var(--bg); }
        .tabs{ display:flex; gap:2px; padding:10px 10px 0; border-bottom:1px solid var(--border-soft); overflow-x:auto; }
        .tabs button{ display:flex; flex-direction:column; align-items:center; gap:3px; border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:var(--text-muted); font-size:11px; padding:6px 7px 7px; flex:1; min-width:52px; }
        .tabs button svg{ width:16px; height:16px; }
        .tabs button[aria-selected="true"]{ color:var(--text); border-bottom-color:var(--accent); }
        .lh{ display:flex; align-items:center; gap:12px; padding:14px 14px 4px; }
        .lh .ic{ width:40px; height:40px; border-radius:var(--radius-sm); background:var(--panel-3); display:flex; align-items:center; justify-content:center; flex:none; }
        .lh .ic svg{ width:20px; height:20px; }
        .lh .tt{ flex:1; min-width:0; }
        .lh .t1{ font-size:16px; font-weight:700; }
        .lh .t2{ font-size:12px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .lh .trash{ padding:7px; }
        .lh .trash svg{ width:16px; height:16px; }
        .body{ flex:1; overflow:auto; padding:12px 14px 24px; }
        h2{ font-size:14px; margin:0 0 12px; display:flex; align-items:center; gap:8px; }
      </style>
      <div class="tabs" role="tablist" aria-label="Layer">
        ${LAYERS.map((l) => `<button role="tab" data-layer="${l}" aria-controls="insp-body">${TAB_ICONS[l]}<span>${TAB_LABELS[l]}</span></button>`).join("")}
      </div>
      <div class="lh"><div class="ic"></div><div class="tt"><div class="t1"></div><div class="t2"></div></div><button class="trash ghost icon-btn" hidden></button></div>
      <div class="body" id="insp-body" role="tabpanel"></div>
    `;
    this._audition = new Audition();
    this._audition.onchange = () => this._section?.update();
    const tabs = this.shadowRoot.querySelector(".tabs");
    tabs.addEventListener("click", (e) => {
      const b = e.target.closest("[data-layer]");
      if (b) store.setLayer(b.dataset.layer);
    });
    tabs.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const i = LAYERS.indexOf(store.state.layer);
      const next = LAYERS[(i + (e.key === "ArrowRight" ? 1 : LAYERS.length - 1)) % LAYERS.length];
      store.setLayer(next);
      tabs.querySelector(`[data-layer="${next}"]`).focus();
    });
    this.shadowRoot.querySelector(".trash").addEventListener("click", () => {
      if (store.state.layer === "announcer") store.updateDraft((d) => { d.announcement = null; }, "inspector");
    });
    this._onChange = ({ detail }) => this._update(detail);
    store.addEventListener("change", this._onChange);
    this._mountSection();
  }

  disconnectedCallback() {
    store.removeEventListener("change", this._onChange);
    this._section?.destroy?.();
    this._audition.stop();
  }

  _mountSection() {
    const layer = store.state.layer;
    this.shadowRoot.querySelectorAll(".tabs [data-layer]").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.layer === layer));
      b.tabIndex = b.dataset.layer === layer ? 0 : -1;
    });
    this._section?.destroy?.();
    this._audition.stop();
    this._renderHeader();
    const body = this.shadowRoot.querySelector(".body");
    body.replaceChildren();
    if (!store.state.draft) return;
    const Section = SECTIONS[layer];
    this._section = new Section({ store, audition: this._audition, inspector: this });
    this._section.mount(body);
    this._sectionKey = this._section.key();
  }

  /** Rebuilds the current section in place (same instance, so its local UI
   *  state such as an open picker survives) when its structure changed;
   *  otherwise just refreshes values. */
  refresh() {
    if (!this._section) { this._mountSection(); return; }
    this._renderHeader();
    const key = this._section.key();
    if (key === this._sectionKey) { this._section.update(); return; }
    this._sectionKey = key;
    const body = this.shadowRoot.querySelector(".body");
    const scroll = body.scrollTop;
    this._section.destroy?.();
    body.replaceChildren();
    this._section.mount(body);
    body.scrollTop = scroll;
  }

  _renderHeader() {
    const root = this.shadowRoot;
    const s = store.state;
    const d = s.draft;
    const layer = s.layer;
    const titles = { bump: "Bump", background: "Background", music: "Music", announcer: "Voice", text: "Text Layer" };
    let sub = "";
    if (d) {
      if (layer === "bump") sub = s.selectedId ? s.selectedId : "New bump";
      if (layer === "background") sub = d.background?.type === "color" ? `Solid color ${d.background.color || ""}` : (d.background?.url ? fileLabel(d.background.url) : `No ${d.background?.type || "background"} selected`);
      if (layer === "music") sub = (d.audio || []).length ? d.audio.map((l) => fileLabel(l.url)).join(" + ") : "No music";
      if (layer === "announcer") { const f = findAnnouncement(s.media, d.announcement); sub = d.announcement?.url ? (f?.channel ? `${f.channel.name} announcer` : "Announcer clip") : "No announcement"; }
      if (layer === "text") sub = "Upcoming programs";
    }
    root.querySelector(".lh .ic").innerHTML = TAB_ICONS[layer];
    root.querySelector(".lh .t1").textContent = titles[layer];
    root.querySelector(".lh .t2").textContent = sub;
    const trash = root.querySelector(".lh .trash");
    trash.hidden = !(layer === "announcer" && d?.announcement?.url);
    trash.innerHTML = icons.trash;
    trash.setAttribute("aria-label", "Remove announcement");
    trash.title = "Remove announcement from the draft";
  }

  _update({ keys }) {
    if (keys.has("layer") || keys.has("selection") || keys.has("status")) { this._mountSection(); return; }
    if (keys.has("playback") && store.state.playback.playing && this._audition.url) this._audition.stop(); // preview started: stop auditioning
    if (keys.has("draft") || keys.has("media") || keys.has("schedules") || keys.has("bumps") || keys.has("preview") || keys.has("playback")) {
      if (keys.has("playback") && keys.size === 1 && this._section && !this._section.wantsPlayback) return;
      this.refresh();
    }
  }
}

customElements.define("bump-inspector", BumpInspector);
