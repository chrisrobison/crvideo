// <bump-preview> -- the persistent 16:9 preview. Owns the ONE <cr-bump>
// (channels/bump-player.js -- no second renderer) for the life of the page
// and feeds it the current unsaved draft by property assignment, so edits
// update it in place: no re-creation, no restarted audio, no reset video.
//
// Upcoming-show data comes from preview-only store state: editable sample
// rows or a real channel's lineup (read-only, via channels/broadcast.js).
// None of it, nor the monitor volume / loop / eye toggles, is ever saved.
// The Duration stepper here edits the bump's real `duration` field.

import { escapeHtml } from "../../utils.js";
import { studioStore as store } from "./bump-studio-store.js";
import { studioCSS, icons } from "./studio-ui.js";
import { fmtTime, effectiveDuration, bumpDuration, DEFAULT_BUMP_DURATION, MIN_DURATION, MAX_DURATION } from "./bump-model.js";
import "../../../../channels/bump-player.js";

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
function parseDur(text) {
  const m = String(text).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN;
}

class BumpPreview extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ${studioCSS}
        :host{ display:block; }
        .frame{ width:100%; max-width:calc((100vh - 470px) * 16 / 9); min-width:min(100%, 440px); margin:0 auto; }
        .stage{ position:relative; width:100%; aspect-ratio:16/9; background:#000; border-radius:var(--radius); overflow:hidden; box-shadow:0 0 0 1px var(--border); }
        .stage:fullscreen{ border-radius:0; }
        cr-bump{ position:absolute; inset:0; width:100%; height:100%; }
        .tag{ position:absolute; top:10px; right:10px; z-index:2; font-size:10px; font-weight:800; letter-spacing:.12em; padding:2px 7px; border-radius:4px; background:rgba(0,0,0,.55); color:#cfd6e4; pointer-events:none; }
        .hud{ position:absolute; left:0; right:0; bottom:0; z-index:2; padding:22px 14px 10px; background:linear-gradient(transparent, rgba(0,0,0,.72)); display:grid; grid-template-columns:auto auto minmax(0,1fr) auto auto; align-items:center; gap:12px; color:#fff; transition:opacity .2s; }
        .stage:not(:hover):not(:focus-within) .hud.playing{ opacity:0; }
        .hud button{ border:0; background:transparent; padding:2px; color:#fff; display:flex; }
        .hud button svg{ width:20px; height:20px; }
        .hud .time{ font:13px/1 var(--font); font-variant-numeric:tabular-nums; white-space:nowrap; }
        .scrub{ position:relative; height:16px; cursor:pointer; touch-action:none; }
        .scrub::before{ content:""; position:absolute; left:0; right:0; top:7px; height:3px; border-radius:2px; background:rgba(255,255,255,.3); }
        .scrub .fill{ position:absolute; left:0; top:7px; height:3px; border-radius:2px; background:#fff; }
        .scrub .dot{ position:absolute; top:3px; width:11px; height:11px; margin-left:-5.5px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.5); }
        .scrub:focus-visible{ outline:2px solid var(--accent); outline-offset:2px; }
        .controls{ display:flex; align-items:center; gap:10px; margin-top:10px; flex-wrap:wrap; }
        .controls .play-btn{ padding:8px 14px; }
        .controls .play-btn svg, .controls .stop-btn svg{ width:14px; height:14px; }
        .vol{ display:flex; align-items:center; gap:6px; }
        .vol button{ border:0; background:transparent; padding:4px; color:var(--text-muted); display:flex; }
        .vol button svg{ width:18px; height:18px; }
        .vol input{ width:90px; padding:0; accent-color:var(--accent); }
        .dur{ display:flex; align-items:center; gap:6px; }
        .dur .lbl{ font-size:12px; color:var(--text-muted); }
        .stepper{ display:flex; align-items:stretch; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-elevated); overflow:hidden; }
        .stepper input{ width:56px; border:0; border-radius:0; background:transparent; text-align:center; padding:6px 4px; font-variant-numeric:tabular-nums; }
        .stepper .arrows{ display:flex; flex-direction:column; border-left:1px solid var(--border); }
        .stepper .arrows button{ border:0; border-radius:0; padding:0 6px; font-size:9px; line-height:1; flex:1; background:transparent; color:var(--text-muted); }
        .stepper .arrows button:hover{ color:var(--text); background:var(--panel-3); }
        .dur .def{ font-size:11px; color:var(--text-faint); }
        .loop{ display:flex; align-items:center; gap:6px; }
        .loop svg{ width:15px; height:15px; }
        .src{ display:flex; align-items:center; gap:6px; margin-left:auto; position:relative; }
        .src label{ font-size:12px; color:var(--text-muted); white-space:nowrap; }
        .src select{ width:auto; max-width:220px; padding:6px 8px; font-size:12px; }
        .src .edit-sample{ padding:6px 7px; }
        .src .edit-sample svg{ width:14px; height:14px; }
        .src .state{ font-size:11px; color:var(--text-faint); }
        .src .state.err{ color:#ffb4b4; }
        .pop{ position:absolute; z-index:40; right:0; top:calc(100% + 6px); width:340px; background:var(--panel-2); border:1px solid var(--border); border-radius:var(--radius); box-shadow:0 12px 32px rgba(0,0,0,.5); padding:12px; }
        .pop h3{ margin:0 0 4px; font-size:13px; }
        .pop p{ margin:0 0 10px; font-size:11px; color:var(--text-muted); }
        .pop .row{ display:grid; grid-template-columns:minmax(0,1fr) 64px 24px 28px; gap:6px; align-items:center; margin-bottom:6px; }
        .pop .row input{ padding:5px 8px; font-size:12px; }
        .pop .row span{ font-size:11px; color:var(--text-faint); }
        .pop .row button{ padding:4px; border:0; background:transparent; color:var(--text-muted); }
        .pop .row button svg{ width:14px; height:14px; }
        .pop .foot{ display:flex; justify-content:space-between; margin-top:8px; }
      </style>
      <div class="frame">
        <div class="stage">
          <cr-bump></cr-bump>
          <span class="tag">PREVIEW</span>
          <div class="hud">
            <button class="hud-play" aria-label="Play">${icons.play}</button>
            <span class="time"><span class="cur">0:00</span> / <span class="durt">0:15</span></span>
            <div class="scrub" role="slider" tabindex="0" aria-label="Preview position"><div class="fill"></div><div class="dot"></div></div>
            <button class="hud-mute" aria-label="Mute">${icons.volume}</button>
            <button class="fs" aria-label="Fullscreen" title="Fullscreen">${icons.fullscreen}</button>
          </div>
        </div>
        <div class="controls">
          <button class="play-btn primary icon-btn">${icons.play}<span>Play Preview</span></button>
          <button class="stop-btn icon-btn">${icons.stop}<span>Stop</span></button>
          <div class="vol"><button class="mute" aria-label="Mute" aria-pressed="false">${icons.volume}</button><input class="volume" type="range" min="0" max="1" step="0.05" aria-label="Preview volume"></div>
          <div class="dur"><span class="lbl" id="dur-lbl">Duration</span>
            <div class="stepper"><input class="dur-in" aria-labelledby="dur-lbl" inputmode="decimal"><div class="arrows"><button class="up" aria-label="Increase duration by 1 second" tabindex="-1">▲</button><button class="down" aria-label="Decrease duration by 1 second" tabindex="-1">▼</button></div></div>
            <span class="def" title="This bump has no saved duration (schema v1). The editor previews it at ${DEFAULT_BUMP_DURATION}s; on air, the schedule rule decides how long it runs.">default</span>
          </div>
          <button class="loop toggle icon-btn" aria-pressed="false" title="Loop the preview">${icons.loop}<span>Loop</span></button>
          <div class="src">
            <label for="src">Preview from:</label>
            <select id="src" title="Preview programming (preview only, never saved)"></select>
            <button class="edit-sample icon-btn" aria-label="Edit sample programming" title="Edit sample programming" aria-expanded="false">${icons.edit}</button>
            <span class="state" aria-live="polite"></span>
            <div class="pop" role="dialog" aria-label="Sample programming" hidden></div>
          </div>
        </div>
      </div>
    `;
    const root = this.shadowRoot;
    const q = (sel) => root.querySelector(sel);
    this._el = q("cr-bump");
    this._el.endBehavior = store.state.playback.loop ? "loop" : "stop";
    this._el.setMuted(store.state.playback.muted);
    this._el.masterVolume = store.state.playback.volume;
    store.player = this._el;

    q(".play-btn").addEventListener("click", () => store.togglePlay());
    q(".hud-play").addEventListener("click", () => store.togglePlay());
    q(".stop-btn").addEventListener("click", () => store.stop());
    const toggleMute = () => store.setMuted(!store.state.playback.muted);
    q(".mute").addEventListener("click", toggleMute);
    q(".hud-mute").addEventListener("click", toggleMute);
    q(".volume").addEventListener("input", (e) => store.setVolume(e.target.value));
    q(".loop").addEventListener("click", () => store.setLoop(!store.state.playback.loop));
    q(".fs").addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else q(".stage").requestFullscreen?.().catch(() => {});
    });

    const setDur = (v) => {
      if (!Number.isFinite(v)) { this._renderDuration(true); return; }
      store.updateDraft((d) => { d.duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, v)); }, "preview-duration");
    };
    q(".dur-in").addEventListener("change", (e) => setDur(parseDur(e.target.value)));
    q(".dur-in").addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); setDur(effectiveDuration(store.state.draft) + (e.key === "ArrowUp" ? 1 : -1)); }
    });
    q(".up").addEventListener("click", () => setDur(effectiveDuration(store.state.draft) + 1));
    q(".down").addEventListener("click", () => setDur(effectiveDuration(store.state.draft) - 1));

    const scrub = q(".scrub");
    const seekAt = (x) => {
      const r = scrub.getBoundingClientRect();
      store.seek(((x - r.left) / r.width) * this._el.duration);
    };
    scrub.addEventListener("pointerdown", (e) => {
      scrub.setPointerCapture(e.pointerId);
      seekAt(e.clientX);
      const move = (ev) => seekAt(ev.clientX);
      const up = () => { scrub.removeEventListener("pointermove", move); scrub.removeEventListener("pointerup", up); };
      scrub.addEventListener("pointermove", move);
      scrub.addEventListener("pointerup", up);
    });
    scrub.addEventListener("keydown", (e) => {
      const t = this._el.currentTime;
      const step = e.shiftKey ? 1 : 0.1;
      if (e.key === "ArrowLeft") { e.preventDefault(); store.seek(t - step); }
      if (e.key === "ArrowRight") { e.preventDefault(); store.seek(t + step); }
    });

    q("#src").addEventListener("change", (e) => store.setPreviewSource(e.target.value));
    q(".edit-sample").addEventListener("click", () => this._toggleSample());
    this._onDocDown = (e) => {
      if (!q(".pop").hidden && !e.composedPath().includes(q(".src"))) this._toggleSample(false);
    };
    document.addEventListener("pointerdown", this._onDocDown);

    const pushPlayback = () => store.setPlayback({ time: this._el.currentTime, duration: this._el.duration, playing: this._el.playing });
    this._el.addEventListener("bump-time", pushPlayback);
    this._el.addEventListener("bump-state", pushPlayback);
    this._el.addEventListener("bump-ended", pushPlayback);
    this._el.addEventListener("bump-media", (e) => store.setPlayback({ durations: e.detail }));

    this._onChange = ({ detail }) => this._update(detail);
    store.addEventListener("change", this._onChange);
    this._update({ keys: new Set(["selection", "draft", "preview", "playback", "media"]) });
  }

  disconnectedCallback() {
    store.removeEventListener("change", this._onChange);
    document.removeEventListener("pointerdown", this._onDocDown);
    if (store.player === this._el) store.player = null;
  }

  _renderDuration(force = false) {
    const d = store.state.draft;
    const input = this.shadowRoot.querySelector(".dur-in");
    if (force || this.shadowRoot.activeElement !== input) input.value = fmtDur(effectiveDuration(d));
    this.shadowRoot.querySelector(".dur .def").hidden = !!bumpDuration(d);
  }

  _update({ keys }) {
    const root = this.shadowRoot;
    const q = (sel) => root.querySelector(sel);
    const s = store.state;
    if (keys.has("selection")) this._el.stop(); // a different bump starts from 0
    if (keys.has("selection") || keys.has("draft")) {
      this._el.definition = s.draft;
      this._renderDuration();
      store.setPlayback({ time: this._el.currentTime, duration: this._el.duration, playing: this._el.playing, durations: this._el.mediaDurations });
    }
    if (keys.has("preview")) {
      this._el.upcoming = s.preview.upcoming;
      this._el.channel = s.preview.channel;
      this._el.hiddenLayers = s.preview.hiddenLayers;
      const state = q(".state");
      state.textContent = s.preview.loading ? "Loading…" : s.preview.error ? "Couldn't load" : "";
      state.title = s.preview.error || "";
      state.classList.toggle("err", !!s.preview.error);
      q(".edit-sample").hidden = s.preview.source !== "sample";
    }
    if (keys.has("media") || keys.has("preview")) this._renderSourceOptions();
    if (keys.has("playback")) {
      const p = s.playback;
      const dur = p.duration || this._el.duration;
      q(".cur").textContent = fmtTime(p.time).replace(/^0(\d)/, "$1");
      q(".durt").textContent = fmtDur(dur);
      const frac = Math.min(1, (p.time || 0) / dur);
      q(".scrub .fill").style.width = `${frac * 100}%`;
      q(".scrub .dot").style.left = `${frac * 100}%`;
      const scrub = q(".scrub");
      scrub.setAttribute("aria-valuenow", (p.time || 0).toFixed(1));
      scrub.setAttribute("aria-valuemax", String(dur));
      scrub.setAttribute("aria-valuetext", `${fmtTime(p.time)} of ${fmtDur(dur)}`);
      q(".hud").classList.toggle("playing", p.playing);
      const playIcon = p.playing ? icons.pause : icons.play;
      q(".hud-play").innerHTML = playIcon;
      q(".hud-play").setAttribute("aria-label", p.playing ? "Pause" : "Play");
      q(".play-btn").innerHTML = `${playIcon}<span>${p.playing ? "Pause" : "Play Preview"}</span>`;
      const muteIcon = p.muted || p.volume === 0 ? icons.mute : icons.volume;
      for (const b of [q(".mute"), q(".hud-mute")]) {
        b.innerHTML = muteIcon;
        b.setAttribute("aria-label", p.muted ? "Unmute" : "Mute");
      }
      q(".mute").setAttribute("aria-pressed", String(p.muted));
      const vol = q(".volume");
      if (root.activeElement !== vol) vol.value = String(p.muted ? 0 : p.volume);
      q(".loop").setAttribute("aria-pressed", String(p.loop));
    }
  }

  _renderSourceOptions() {
    const sel = this.shadowRoot.querySelector("#src");
    const s = store.state;
    const channels = s.media.channels || [];
    const sig = channels.map((c) => c.id).join(",");
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = `<option value="sample">Sample programming</option>
        <optgroup label="Real upcoming programs (read-only)">
          ${channels.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (Live)</option>`).join("")}
        </optgroup>`;
    }
    sel.value = s.preview.source;
  }

  _toggleSample(force) {
    const root = this.shadowRoot;
    const pop = root.querySelector(".pop");
    const open = force ?? pop.hidden;
    pop.hidden = !open;
    root.querySelector(".edit-sample").setAttribute("aria-expanded", String(open));
    if (open) this._renderSample();
  }

  _renderSample() {
    const pop = this.shadowRoot.querySelector(".pop");
    const rows = store.state.preview.sample;
    pop.innerHTML = `
      <h3>Sample programming</h3>
      <p>Preview only. Never saved with the bump.</p>
      ${rows.map((r, i) => `
        <div class="row" data-i="${i}">
          <input class="t" value="${escapeHtml(r.title)}" aria-label="Show ${i + 1} title" placeholder="Title">
          <input class="m num" type="number" min="0" max="1440" value="${r.inMinutes}" aria-label="Show ${i + 1} starts in minutes">
          <span>min</span>
          <button class="rm" aria-label="Remove show ${i + 1}">${icons.x}</button>
        </div>`).join("")}
      <div class="foot">
        <button class="add ghost small" ${rows.length >= 6 ? "disabled" : ""}>+ Add show</button>
        <button class="done small">Done</button>
      </div>`;
    const read = () => [...pop.querySelectorAll(".row")].map((row) => ({ title: row.querySelector(".t").value, inMinutes: Number(row.querySelector(".m").value) || 0 }));
    pop.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => store.setSample(read())));
    pop.querySelectorAll(".rm").forEach((b) => b.addEventListener("click", () => {
      const next = read();
      next.splice(Number(b.closest(".row").dataset.i), 1);
      store.setSample(next);
      this._renderSample();
    }));
    pop.querySelector(".add").addEventListener("click", () => {
      const next = read();
      const last = next[next.length - 1];
      next.push({ title: `Sample Show ${next.length + 1}`, inMinutes: (last?.inMinutes ?? 0) + 30 });
      store.setSample(next);
      this._renderSample();
    });
    pop.querySelector(".done").addEventListener("click", () => this._toggleSample(false));
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { this._toggleSample(false); this.shadowRoot.querySelector(".edit-sample").focus(); } });
  }
}

customElements.define("bump-preview", BumpPreview);
