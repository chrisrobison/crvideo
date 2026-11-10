// Inspector: Music / ambience -- up to two looping audio layers, each with
// a searchable track picker, a volume slider, and an audition button.

import { escapeHtml } from "../../utils.js";
import { icons } from "./studio-ui.js";
import { h, setValue, searchBoxHtml, pct, pickerCSS } from "./inspector-common.js";
import { fileLabel, audioSourceFor, MAX_AUDIO_LAYERS } from "./bump-model.js";

export class MusicSection {
  constructor({ store, audition, inspector }) {
    this.store = store;
    this.audition = audition;
    this.inspector = inspector;
    this.openPicker = null; // index of the layer whose picker is open
    this.wantsPlayback = true;
  }

  key() {
    const audio = this.store.state.draft.audio || [];
    return `music:${this.store.state.selectedId}:${audio.length}:${this.openPicker}`;
  }

  mount(container) {
    const audio = this.store.state.draft.audio || [];
    this.el = h(`
      <div>
        <style>${pickerCSS}
          .layer .top{ display:flex; align-items:center; gap:8px; }
          .layer .nm{ flex:1; min-width:0; font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .layer .src{ font-size:11px; color:var(--text-faint); }
          .layer .vol{ display:grid; grid-template-columns:auto minmax(0,1fr) 40px; gap:8px; align-items:center; margin-top:8px; font-size:12px; color:var(--text-muted); }
          .layer .vol input{ padding:0; accent-color:var(--accent); }
          .layer .acts{ display:flex; gap:6px; margin-top:8px; }
          .layer .acts button{ padding:4px 8px; font-size:12px; }
        </style>
        <div class="sec-h"><h3>Music &amp; ambience</h3><span class="small faint">${audio.length}/${MAX_AUDIO_LAYERS} layers · loop</span></div>
        <div class="layers"></div>
        <button class="add-layer ghost small" style="margin-top:10px" ${audio.length >= MAX_AUDIO_LAYERS ? "disabled" : ""}>+ Add layer</button>
        ${audio.length >= MAX_AUDIO_LAYERS ? `<div class="small faint" style="margin-top:6px">Two layers is the player's limit.</div>` : ""}
      </div>`);
    container.append(this.el);
    const layersEl = this.el.querySelector(".layers");
    if (!audio.length) layersEl.append(h(`<div class="empty-state"><p>No music on this bump.</p></div>`));
    audio.forEach((layer, i) => layersEl.append(this._layerCard(layer, i)));
    this.el.querySelector(".add-layer").addEventListener("click", () => {
      const media = this.store.state.media;
      const used = new Set(audio.map((l) => l.url));
      const first = [...(media.music || []), ...(media.ambience || [])].find((f) => !used.has(f.url));
      if (!first) return;
      this.openPicker = audio.length;
      this.store.updateDraft((d) => { d.audio = [...(d.audio || []), { source: audioSourceFor(media, first.url), url: first.url, volume: 0.6 }]; }, "inspector");
    });
    this.update();
  }

  _layerCard(layer, i) {
    const media = this.store.state.media;
    const card = h(`
      <div class="card layer" data-i="${i}">
        <div class="top">
          <button class="aud" aria-label="Audition this track" aria-pressed="false">${icons.play}</button>
          <div class="nm"></div><span class="src"></span>
        </div>
        <div class="vol"><label for="vol-${i}">Volume</label><input id="vol-${i}" type="range" min="0" max="1" step="0.05"><span class="tnum vv"></span></div>
        <div class="acts">
          <button class="change ghost" aria-expanded="${this.openPicker === i}">${this.openPicker === i ? "Close list" : "Change track"}</button>
          <button class="remove ghost" aria-label="Remove layer ${i + 1}">Remove</button>
        </div>
      </div>`);
    if (this.openPicker === i) {
      const picker = h(`<div style="margin-top:8px">${searchBoxHtml("Search music and ambience")}<ul class="pick" role="listbox" aria-label="Tracks"></ul></div>`);
      const list = picker.querySelector(".pick");
      const groups = [["Music", media.music || []], ["Ambience", media.ambience || []]];
      for (const [label, files] of groups) {
        if (!files.length) continue;
        list.append(h(`<li class="grp" role="presentation">${label}</li>`));
        for (const f of files) {
          list.append(h(`<li role="option" tabindex="0" data-url="${escapeHtml(f.url)}" aria-selected="${f.url === layer.url}">
            <button class="aud" data-aud="${escapeHtml(f.url)}" aria-label="Audition ${escapeHtml(f.name)}" aria-pressed="false" tabindex="-1">${icons.play}</button>
            <span class="main t">${escapeHtml(fileLabel(f.url))}</span></li>`));
        }
      }
      list.addEventListener("click", (e) => {
        const aud = e.target.closest("[data-aud]");
        if (aud) { e.stopPropagation(); this.audition.toggle(aud.dataset.aud, layer.volume); return; }
        const li = e.target.closest("li[data-url]");
        if (li) this._setLayer(i, { url: li.dataset.url, source: audioSourceFor(media, li.dataset.url) });
      });
      list.addEventListener("keydown", (e) => {
        const li = e.target.closest("li[data-url]");
        if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); this._setLayer(i, { url: li.dataset.url, source: audioSourceFor(media, li.dataset.url) }); }
      });
      picker.querySelector(".q").addEventListener("input", (e) => {
        const q = e.target.value.trim().toLowerCase();
        list.querySelectorAll("li[data-url]").forEach((li) => { li.hidden = !!q && !li.dataset.url.toLowerCase().includes(q); });
      });
      card.append(picker);
    }
    card.querySelector(".top .aud").addEventListener("click", () => {
      const l = this.store.state.draft.audio[i];
      if (l?.url) this.audition.toggle(l.url, l.volume);
    });
    card.querySelector("input[type=range]").addEventListener("input", (e) => this._setLayer(i, { volume: Number(e.target.value) }));
    card.querySelector(".change").addEventListener("click", () => {
      this.openPicker = this.openPicker === i ? null : i;
      this.inspector.refresh(); // structure key changed -> rebuild in place
    });
    card.querySelector(".remove").addEventListener("click", () => {
      this.openPicker = null;
      this.store.updateDraft((d) => { d.audio.splice(i, 1); }, "inspector");
    });
    return card;
  }

  _setLayer(i, patch) {
    this.store.updateDraft((d) => { d.audio[i] = { ...d.audio[i], ...patch }; }, "inspector");
  }

  update() {
    const audio = this.store.state.draft.audio || [];
    const durs = this.store.state.playback.durations?.audio || [];
    this.el.querySelectorAll(".layer").forEach((card) => {
      const i = Number(card.dataset.i);
      const l = audio[i];
      if (!l) return;
      card.querySelector(".nm").textContent = fileLabel(l.url);
      card.querySelector(".nm").title = l.url;
      card.querySelector(".src").textContent = `${l.source || "custom"}${durs[i] ? ` · ${durs[i].toFixed(1)}s loop` : ""}`;
      setValue(card.querySelector("input[type=range]"), l.volume ?? 0.6);
      card.querySelector(".vv").textContent = pct(l.volume ?? 0.6);
      const aud = card.querySelector(".top .aud");
      const on = this.audition.isPlaying(l.url);
      aud.setAttribute("aria-pressed", String(on));
      aud.innerHTML = on ? icons.stop : icons.play;
      card.querySelectorAll("li[data-url]").forEach((li) => li.setAttribute("aria-selected", String(li.dataset.url === l.url)));
    });
    this.el.querySelectorAll("[data-aud]").forEach((b) => {
      const on = this.audition.isPlaying(b.dataset.aud);
      b.setAttribute("aria-pressed", String(on));
      b.innerHTML = on ? icons.stop : icons.play;
    });
  }
}
