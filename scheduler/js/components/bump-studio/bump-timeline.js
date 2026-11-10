// <bump-timeline> -- the lightweight multitrack timeline under the preview
// (Timeline Editor Amendment; visual design per the "Bump Editor" mockup).
// It visualizes and edits the small schema_version-2 timing model only:
// announcement.start and upcoming.start/end (duration lives in the preview
// controls' stepper). Plain DOM + pointer events, no libraries.
//
// Shares playback with the preview through the store: the playhead follows
// store.state.playback.time; ruler/lane clicks and playhead drags call
// store.seek(). Clicking a track selects its inspector layer. Eye toggles
// hide/silence a layer in the preview only (store.toggleHidden).
//
// Visuals come from the real media (media-peaks.js): looping music shows its
// waveform repeated at its own length (seams = loop points), the voice clip
// is a one-shot block of its real length with its waveform, and a looping
// background video shows a filmstrip repeated per pass.

import { escapeHtml, toast } from "../../utils.js";
import { studioStore as store, changeOf, PLAYBACK_CHANGE } from "./bump-studio-store.js";
import { TOPICS, subscribe } from "../../../../js/bus.js";
import { studioCSS, icons, rafThrottle, mediaUrl } from "./studio-ui.js";
import { audioPeaks, waveformUrl, filmstrip } from "./media-peaks.js";
import {
  effectiveDuration, bumpTiming, ensureDuration, fileLabel, findAnnouncement, announcementTypeLabel,
  fmtTime, roundTime, MIN_TEXT_SPAN,
} from "./bump-model.js";

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60];
const ZOOM_MAX = 8;
const HIDE_KEY = { text: "text", announcer: "voice", music: "music", background: "background" };
const eye = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const eyeOff = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;

class BumpTimeline extends HTMLElement {
  constructor() {
    super();
    this._zoom = 1;
    this._drag = null;
    this._visuals = new Map(); // media path -> CSS background-image (waveform / filmstrip), once computed
    this._commit = rafThrottle((mutate) => store.updateDraft(mutate, "timeline"));
  }

  connectedCallback() {
    if (this.shadowRoot) { this._listen(); return; }
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ${studioCSS}
        :host{ display:block; background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); user-select:none; -webkit-user-select:none; padding:6px 0 4px; }
        .tl{ display:grid; grid-template-columns:minmax(150px, 210px) minmax(0,1fr) 34px; }
        .gutter{ display:flex; align-items:center; gap:2px; padding:0 8px; height:28px; }
        .gutter button{ padding:3px 5px; border:0; background:transparent; color:var(--text-muted); }
        .gutter button:hover{ color:var(--text); }
        .gutter button svg{ width:14px; height:14px; }
        .heads, .menus{ display:flex; flex-direction:column; }
        .head{ height:var(--track-h); margin:3px 0 3px 8px; display:flex; align-items:center; gap:8px; padding:0 8px 0 4px; font-size:12px; color:var(--text-muted); cursor:pointer; border:1px solid transparent; border-radius:var(--radius-sm); min-width:0; }
        .head:hover{ background:var(--panel-2); }
        .head.sel{ border-color:var(--accent); background:var(--accent-soft); color:var(--text); }
        .head .ty{ font-weight:700; color:var(--text); white-space:nowrap; }
        .head .src{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
        .head svg{ width:15px; height:15px; flex:none; }
        .head .eye{ border:0; background:transparent; padding:3px; color:var(--text-muted); display:flex; }
        .head .eye[aria-pressed="false"]{ color:var(--text-faint); }
        .head.off .ty, .head.off .src{ opacity:.45; }
        .scroller{ overflow-x:auto; overflow-y:hidden; position:relative; }
        .content{ position:relative; min-width:100%; padding-right:6px; }
        .ruler{ position:relative; height:28px; cursor:col-resize; }
        .tick{ position:absolute; bottom:4px; width:1px; background:var(--border); height:5px; }
        .tick.major{ height:9px; background:#4a5470; }
        .tick span{ position:absolute; bottom:11px; transform:translateX(-50%); font:11px/1 var(--font); color:var(--text-muted); white-space:nowrap; font-variant-numeric:tabular-nums; }
        .tick.first span{ transform:none; }
        .tick.last span{ transform:translateX(-100%); }
        .lane{ position:relative; height:var(--track-h); margin:3px 0; cursor:pointer; }
        .clip{ position:absolute; top:0; bottom:0; border-radius:6px; display:flex; align-items:center; gap:6px; padding:0 9px; font-size:12px; font-weight:600; color:#fff; white-space:nowrap; overflow:hidden; background-color:var(--c); box-shadow: inset 0 0 0 1px rgba(255,255,255,.14); }
        .clip svg{ width:13px; height:13px; flex:none; }
        .clip .lbl{ overflow:hidden; text-overflow:ellipsis; position:relative; text-shadow:0 1px 2px rgba(0,0,0,.6); }
        .clip .kind{ margin-left:auto; font-size:10px; font-weight:700; padding:1px 5px; border-radius:4px; background:rgba(0,0,0,.35); position:relative; }
        .clip:focus-visible{ outline:2px solid #fff; outline-offset:1px; }
        .lane.sel .clip{ box-shadow: inset 0 0 0 1px rgba(255,255,255,.55), 0 0 0 1px var(--accent); }
        .lane.off .clip{ opacity:.35; }
        .clip.wave{ background-repeat:repeat-x; background-position:left center; }
        .clip.loop::after{ content:""; position:absolute; inset:0; pointer-events:none; background-image:linear-gradient(to right, rgba(255,255,255,.9) 0 1.5px, transparent 1.5px); background-size:var(--period, 100%) 100%; background-repeat:repeat-x; opacity:.55; }
        .clip.strip{ background-repeat:repeat-x; background-position:left center; }
        .clip.strip .lbl{ background:rgba(0,0,0,.45); padding:1px 6px; border-radius:4px; }
        .clip.oneshot{ cursor:grab; }
        .clip.oneshot.cut{ border-top-right-radius:0; border-bottom-right-radius:0; -webkit-mask: linear-gradient(to left, transparent 0 4px, #000 4px); mask: linear-gradient(to left, transparent 0 4px, #000 4px); }
        .clip.span{ cursor:grab; padding:0 14px; }
        .clip.dim{ opacity:.5; }
        .dragging .clip.oneshot, .dragging .clip.span{ cursor:grabbing; }
        .handle{ position:absolute; top:0; bottom:0; width:10px; cursor:ew-resize; display:flex; align-items:center; justify-content:center; z-index:1; }
        .handle::after{ content:""; width:3px; height:14px; border-radius:2px; background:rgba(255,255,255,.9); }
        .handle.s{ left:0; } .handle.e{ right:0; }
        .add{ position:absolute; left:0; top:0; bottom:0; display:flex; align-items:center; font-size:12px; color:var(--text-faint); border:1px dashed var(--border); border-radius:6px; padding:0 10px; background:transparent; }
        .add:hover{ color:var(--text); border-color:#48536a; }
        .menu-btn{ height:var(--track-h); margin:3px 0; border:0; background:transparent; color:var(--text-muted); padding:0; display:flex; align-items:center; justify-content:center; }
        .menu-btn:hover{ color:var(--text); }
        .menu-btn svg{ width:16px; height:16px; transform:rotate(90deg); }
        .menu-btn:disabled{ visibility:hidden; }
        .playhead{ position:absolute; top:0; bottom:0; width:0; pointer-events:none; z-index:3; }
        .playhead::before{ content:""; position:absolute; top:14px; bottom:0; left:-1px; width:2px; background:#fff; box-shadow:0 0 0 1px rgba(0,0,0,.25); }
        .knob{ position:absolute; top:9px; left:-7px; width:14px; height:14px; border-radius:50%; background:#fff; box-shadow:0 1px 4px rgba(0,0,0,.5); pointer-events:auto; cursor:ew-resize; }
        .tip{ position:absolute; transform:translate(-50%,-100%); background:#000; color:#fff; font:11px/1 var(--mono); padding:3px 5px; border-radius:3px; pointer-events:none; z-index:4; white-space:nowrap; }
        .menu{ position:fixed; z-index:50; min-width:180px; background:var(--panel-2); border:1px solid var(--border); border-radius:var(--radius-sm); box-shadow:0 10px 30px rgba(0,0,0,.45); padding:4px; }
        .menu button{ display:block; width:100%; text-align:left; border:0; background:transparent; padding:7px 10px; font-size:13px; }
        .menu button:hover, .menu button:focus-visible{ background:var(--panel-3); }
        .menu .danger-item{ color:#ffb4b4; }
        .legend{ display:flex; gap:14px; padding:4px 10px 2px 16px; font-size:11px; color:var(--text-faint); flex-wrap:wrap; }
      </style>
      <div class="tl">
        <div>
          <div class="gutter">
            <button class="zout" aria-label="Zoom out" title="Zoom out">${icons.zoomOut}</button>
            <button class="fit" aria-label="Zoom to fit" title="Zoom to fit">${icons.fit}</button>
            <button class="zin" aria-label="Zoom in" title="Zoom in">${icons.zoomIn}</button>
          </div>
          <div class="heads"></div>
        </div>
        <div class="scroller">
          <div class="content">
            <div class="ruler" aria-label="Time ruler: click or drag to seek"></div>
            <div class="lanes"></div>
            <div class="playhead"><div class="knob" role="slider" tabindex="0" aria-label="Playhead"></div></div>
          </div>
        </div>
        <div><div style="height:28px"></div><div class="menus"></div></div>
      </div>
      <div class="legend"><span>Thin seams mark loop points</span><span>Drag the voice clip or the text handles · arrow keys nudge (Shift = 1s)</span></div>
      <div class="menu" role="menu" hidden></div>
    `;
    const root = this.shadowRoot;
    this._scroller = root.querySelector(".scroller");
    this._content = root.querySelector(".content");

    root.querySelector(".fit").addEventListener("click", () => this._setZoom(1));
    root.querySelector(".zin").addEventListener("click", () => this._setZoom(this._zoom * 1.5));
    root.querySelector(".zout").addEventListener("click", () => this._setZoom(this._zoom / 1.5));
    this._scroller.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this._setZoom(this._zoom * (e.deltaY < 0 ? 1.25 : 0.8));
    }, { passive: false });

    root.querySelector(".ruler").addEventListener("pointerdown", (e) => this._startSeek(e));
    root.querySelector(".knob").addEventListener("pointerdown", (e) => this._startSeek(e));
    root.querySelector(".knob").addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 1 : 0.1;
      const t = store.state.playback.time;
      const map = { ArrowLeft: t - step, ArrowRight: t + step, Home: 0, End: this._duration() };
      if (e.key in map) { e.preventDefault(); store.seek(map[e.key]); }
    });
    root.querySelector(".lanes").addEventListener("pointerdown", (e) => this._onLaneDown(e));
    root.querySelector(".lanes").addEventListener("keydown", (e) => this._onClipKey(e));
    const heads = root.querySelector(".heads");
    heads.addEventListener("click", (e) => {
      const eyeBtn = e.target.closest(".eye");
      if (eyeBtn) { store.toggleHidden(eyeBtn.dataset.hide); return; }
      const h = e.target.closest("[data-layer]");
      if (h) store.setLayer(h.dataset.layer);
    });
    heads.addEventListener("keydown", (e) => {
      const h = e.target.closest(".head");
      if (h && e.target === h && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); store.setLayer(h.dataset.layer); }
    });
    root.querySelector(".menus").addEventListener("click", (e) => {
      const b = e.target.closest("[data-key]");
      if (b) this._openMenu(b);
    });
    const menu = root.querySelector(".menu");
    menu.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b) this._act(b.dataset.act, b.dataset.arg); });
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(e.composedPath()[0]);
      if (e.key === "Escape") this._closeMenu();
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    });
    this._onDocDown = (e) => { if (!e.composedPath().includes(menu)) this._closeMenu(); };

    new ResizeObserver(() => { this._renderRuler(); this._renderPlayhead(); }).observe(this._scroller);
    this._listen();
    this._render();
  }

  _listen() {
    this._subs = new AbortController();
    const signal = this._subs.signal;
    document.addEventListener("pointerdown", this._onDocDown, { signal });
    subscribe(TOPICS.STUDIO_CHANGED, (msg) => this._onChange(changeOf(msg)), { signal });
    store.transport.addEventListener("playback", () => this._onChange(PLAYBACK_CHANGE), { signal });
  }

  _onChange({ keys: k, source }) {
    if (k.has("playback")) this._renderPlayhead();
    if (this._drag && source === "timeline") return; // our own drag echo -- the DOM is already up to date
    if (k.has("draft") || k.has("selection") || k.has("media") || k.has("layer") || k.has("preview") || (k.has("playback") && this._durationsChanged())) this._render();
  }

  disconnectedCallback() {
    this._subs?.abort();
  }

  _duration() { return effectiveDuration(store.state.draft); }

  _durationsChanged() {
    const sig = JSON.stringify(store.state.playback.durations);
    if (sig === this._durSig) return false;
    this._durSig = sig;
    return true;
  }

  _setZoom(z) {
    const prev = this._zoom;
    this._zoom = Math.min(ZOOM_MAX, Math.max(1, z));
    if (prev === this._zoom) return;
    const frac = store.state.playback.time / this._duration();
    this._content.style.width = `${this._zoom * 100}%`;
    this._renderRuler();
    this._scroller.scrollLeft = Math.max(0, frac * this._content.offsetWidth - this._scroller.clientWidth / 2);
  }

  _pct(t) { return `${(Math.max(0, t) / this._duration()) * 100}%`; }

  _timeAt(clientX) {
    const r = this._content.getBoundingClientRect();
    const w = r.width - 6; // content padding-right
    return Math.min(this._duration(), Math.max(0, ((clientX - r.left) / w) * this._duration()));
  }

  /** Requests a waveform / filmstrip for `path`; re-renders when it lands. */
  _visual(kind, path) {
    const key = `${kind}:${path}`;
    if (this._visuals.has(key)) return this._visuals.get(key);
    this._visuals.set(key, null);
    const job = kind === "strip"
      ? filmstrip(path).then((r) => `url('${r.url}')`)
      : audioPeaks(path).then((p) => waveformUrl(p, kind === "wave-voice" ? "rgba(237,224,255,.8)" : "rgba(220,255,230,.8)"));
    job.then((css) => { this._visuals.set(key, css); if (!this._drag) this._render(); }).catch(() => {});
    return null;
  }

  _tracks() {
    const s = store.state;
    const d = s.draft;
    if (!d) return [];
    const D = this._duration();
    const t = bumpTiming(d);
    const durs = s.playback.durations || {};
    const tracks = [];

    const count = Number(d.upcoming?.count ?? 3);
    const textEnd = Number.isFinite(t.upcomingEnd) ? Math.min(t.upcomingEnd, D) : D;
    tracks.push({ key: "text", layer: "text", type: "Text", source: "Upcoming programs", icon: icons.text, clips: [{
      kind: "span", start: Math.min(t.upcomingStart, D), end: textEnd, color: "#2f5fc4",
      label: `${escapeHtml(d.upcoming?.label || "Coming Up")} · ${count ? `${count} show${count === 1 ? "" : "s"}` : "label only"}`,
    }] });

    if (d.announcement?.url) {
      const found = findAnnouncement(s.media, d.announcement);
      tracks.push({ key: "voice", layer: "announcer", type: "Voice", source: found?.channel ? `${found.channel.name} announcer` : "Announcer", icon: icons.mic, clips: [{
        kind: "oneshot", start: Math.min(t.announcementStart, D), len: durs.announcement, color: "#6d3fd1",
        wave: this._visual("wave-voice", d.announcement.url),
        label: escapeHtml(found?.clip ? announcementTypeLabel(found.clip.type) : fileLabel(d.announcement.url)),
      }] });
    } else {
      tracks.push({ key: "voice", layer: "announcer", type: "Voice", source: "None", icon: icons.mic, clips: [], add: "+ Add announcement" });
    }

    const layers = (d.audio || []).filter((l) => l?.url);
    if (layers.length) {
      layers.forEach((l, i) => tracks.push({ key: `music${i}`, index: i, layer: "music", type: layers.length > 1 ? `Music ${i + 1}` : "Music", source: fileLabel(l.url), icon: icons.music, clips: [{
        kind: "loop", period: durs.audio?.[i], color: l.source === "ambience" ? "#1f7a4a" : "#238b57",
        wave: this._visual("wave-music", l.url),
        label: `${escapeHtml(fileLabel(l.url))} · ${Math.round(Number(l.volume ?? 0.6) * 100)}%`,
      }] }));
    } else {
      tracks.push({ key: "music", layer: "music", type: "Music", source: "None", icon: icons.music, clips: [], add: "+ Add music" });
    }

    const bg = d.background || {};
    if (bg.type === "video") {
      tracks.push({ key: "bg", layer: "background", type: "Background", source: bg.url ? fileLabel(bg.url) : "No video", icon: icons.film, clips: [bg.url
        ? { kind: "loop", strip: true, period: durs.video, color: "#1b4f7a", wave: this._visual("strip", bg.url), label: escapeHtml(fileLabel(bg.url)) }
        : { kind: "still", color: "#3a4256", label: "No video picked" }] });
    } else if (bg.type === "image") {
      tracks.push({ key: "bg", layer: "background", type: "Background", source: bg.url ? fileLabel(bg.url) : "No image", icon: icons.image, clips: [{ kind: "still", image: bg.url, color: "#2a6f5a", label: escapeHtml(fileLabel(bg.url)) }] });
    } else {
      tracks.push({ key: "bg", layer: "background", type: "Background", source: bg.color || "Color", icon: icons.swatch, clips: [{ kind: "still", color: bg.color || "#14213d", label: escapeHtml(bg.color || "") }] });
    }
    return tracks;
  }

  _render() {
    const root = this.shadowRoot;
    const D = this._duration();
    this._content.style.width = `${this._zoom * 100}%`;
    const tracks = this._tracks();
    this._tracksCache = tracks;
    const layer = store.state.layer;
    const hidden = new Set(store.state.preview.hiddenLayers);

    root.querySelector(".heads").innerHTML = tracks.map((tr) => {
      const off = hidden.has(HIDE_KEY[tr.layer]);
      return `<div class="head ${tr.layer === layer ? "sel" : ""} ${off ? "off" : ""}" data-layer="${tr.layer}" tabindex="0" role="button" aria-label="${tr.type}: ${escapeHtml(tr.source)}. Open in inspector">
        <button class="eye" data-hide="${HIDE_KEY[tr.layer]}" aria-pressed="${!off}" aria-label="${off ? "Show" : "Hide"} ${tr.type} in preview" title="${off ? "Show" : "Hide"} in preview (not saved)">${off ? eyeOff : eye}</button>
        ${tr.icon}<span class="ty">${tr.type}</span><span class="src" title="${escapeHtml(tr.source)}">${escapeHtml(tr.source)}</span></div>`;
    }).join("");

    root.querySelector(".lanes").innerHTML = tracks.map((tr) => `
      <div class="lane ${tr.layer === layer ? "sel" : ""} ${hidden.has(HIDE_KEY[tr.layer]) ? "off" : ""}" data-layer="${tr.layer}" data-key="${tr.key}">
        ${tr.add ? `<button class="add" data-layer="${tr.layer}">${tr.add}</button>` : ""}
        ${tr.clips.map((c) => this._clipHtml(c, tr, D)).join("")}
      </div>`).join("");

    root.querySelector(".menus").innerHTML = tracks.map((tr) => `
      <button class="menu-btn" data-key="${tr.key}" aria-haspopup="menu" aria-label="${tr.type} track actions" ${this._menuItems(tr).length ? "" : "disabled"}>${icons.more}</button>`).join("");
    this._renderRuler();
    this._renderPlayhead();
  }

  _clipHtml(c, tr, D) {
    const style = [`--c:${c.color}`];
    let cls = `clip ${c.kind}`;
    let extra = "";
    let attrs = `data-layer="${tr.layer}"`;
    const periodPct = Number.isFinite(c.period) && c.period > 0 ? (c.period / D) * 100 : null;
    if (c.kind === "loop") {
      style.push("left:0", "width:100%");
      if (periodPct) style.push(`--period:${periodPct}%`);
      if (c.wave) {
        cls += c.strip ? " strip" : " wave";
        style.push(`background-image:${c.wave}`, `background-size:${periodPct ? `${periodPct}%` : (c.strip ? "auto" : "100%")} 100%`);
      }
      extra = `<span class="kind" title="Loops every ${periodPct ? c.period.toFixed(1) + "s" : "…"}">↻ ${periodPct ? c.period.toFixed(1) + "s" : "loop"}</span>`;
    } else if (c.kind === "still") {
      style.push("left:0", "width:100%");
      if (c.image) style.push(`background-image:url('${encodeURI(mediaUrl(c.image)).replace(/'/g, "%27")}')`, "background-size:auto 100%", "background-repeat:repeat-x");
      extra = `<span class="kind">still</span>`;
    } else if (c.kind === "oneshot") {
      const known = Number.isFinite(c.len) && c.len > 0;
      const len = known ? c.len : Math.min(3, D - c.start);
      const visible = Math.max(0.1, Math.min(len, D - c.start));
      if (len > D - c.start + 0.01) cls += " cut";
      if (!known) cls += " dim";
      style.push(`left:${(c.start / D) * 100}%`, `width:${(visible / D) * 100}%`);
      if (c.wave) { cls += " wave"; style.push(`background-image:${c.wave}`, `background-size:${(len / visible) * 100}% 100%`); }
      extra = `<span class="kind">1× ${known ? `${c.len.toFixed(1)}s` : "…"}</span>`;
      attrs += ` data-drag="voice" tabindex="0" role="slider" aria-label="Announcement start" aria-valuemin="0" aria-valuemax="${D}" aria-valuenow="${c.start}" aria-valuetext="${c.start.toFixed(1)} seconds" title="Plays once from ${c.start.toFixed(1)}s${known ? ` for ${c.len.toFixed(1)}s` : ""}${cls.includes("cut") ? " · cut off at the end of the bump" : ""}"`;
    } else if (c.kind === "span") {
      style.push(`left:${(c.start / D) * 100}%`, `width:${((c.end - c.start) / D) * 100}%`);
      extra = `<span class="handle s" data-drag="text-start" tabindex="0" role="slider" aria-label="Text start" aria-valuenow="${c.start}" aria-valuetext="${c.start.toFixed(1)} seconds"></span>
               <span class="handle e" data-drag="text-end" tabindex="0" role="slider" aria-label="Text end" aria-valuenow="${c.end}" aria-valuetext="${c.end.toFixed(1)} seconds"></span>`;
      attrs += ` data-drag="text-move" tabindex="0" title="On screen ${c.start.toFixed(1)}s – ${c.end.toFixed(1)}s"`;
    }
    return `<div class="${cls}" style="${style.join(";")}" ${attrs}>${tr.icon}<span class="lbl">${c.label}</span>${extra}</div>`;
  }

  _renderRuler() {
    const ruler = this.shadowRoot.querySelector(".ruler");
    const D = this._duration();
    const width = (this._content.offsetWidth || this._scroller.clientWidth || 600) - 6;
    const pps = width / D;
    const step = TICK_STEPS.find((s) => s * pps >= 60) || 60;
    const minor = step / (step >= 5 ? 5 : 2);
    const html = [];
    const n = Math.round(D / minor);
    for (let i = 0; i <= n; i++) {
      const t = Math.min(D, i * minor);
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6 || i === n;
      const showLabel = major && (i === n || (D - t) * pps >= 40);
      html.push(`<div class="tick ${major ? "major" : ""} ${i === 0 ? "first" : ""} ${i === n ? "last" : ""}" style="left:${(t / D) * 100}%">${showLabel ? `<span>${fmtClock(t)}</span>` : ""}</div>`);
    }
    ruler.innerHTML = html.join("");
  }

  _renderPlayhead() {
    const t = Math.min(store.state.playback.time || 0, this._duration());
    const ph = this.shadowRoot.querySelector(".playhead");
    const w = this._content.offsetWidth - 6;
    ph.style.left = `${(t / this._duration()) * w}px`;
    const knob = ph.querySelector(".knob");
    knob.setAttribute("aria-valuenow", t.toFixed(1));
    knob.setAttribute("aria-valuetext", fmtTime(t, { tenths: true }));
    if (store.state.playback.playing && this._zoom > 1 && !this._drag) {
      const x = (t / this._duration()) * w;
      const sl = this._scroller.scrollLeft;
      if (x < sl || x > sl + this._scroller.clientWidth - 30) this._scroller.scrollLeft = x - 30;
    }
  }

  // ---------- per-track ⋮ menu ----------

  _menuItems(tr) {
    const t = bumpTiming(store.state.draft);
    if (tr.layer === "text") return [["text-full", "Show for the whole bump", t.upcomingStart > 0 || Number.isFinite(t.upcomingEnd)], ["edit", "Edit text…", true]].filter((x) => x[2]);
    if (tr.layer === "announcer") return tr.clips.length ? [["voice-zero", "Move to start", t.announcementStart > 0], ["edit", "Choose a different clip…", true], ["voice-remove", "Remove announcement", true, "danger"]].filter((x) => x[2]) : [];
    if (tr.layer === "music") return tr.clips.length ? [["edit", "Change track / volume…", true], ["music-remove", "Remove this layer", true, "danger"]] : [];
    return [["edit", "Change background…", true]];
  }

  _openMenu(btn) {
    const tr = this._tracksCache.find((x) => x.key === btn.dataset.key);
    const items = tr ? this._menuItems(tr) : [];
    if (!items.length) return;
    const menu = this.shadowRoot.querySelector(".menu");
    this._menuTrack = tr;
    menu.innerHTML = items.map(([act, label, , tone]) => `<button role="menuitem" data-act="${act}" data-arg="${tr.index ?? ""}" class="${tone === "danger" ? "danger-item" : ""}">${label}</button>`).join("");
    menu.hidden = false;
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.right - 180, window.innerWidth - 190))}px`;
    menu.style.top = `${Math.min(r.bottom + 2, window.innerHeight - 140)}px`;
    menu.querySelector("button").focus();
  }

  _closeMenu() { this.shadowRoot.querySelector(".menu").hidden = true; }

  _act(act, arg) {
    this._closeMenu();
    const tr = this._menuTrack;
    if (act === "edit") store.setLayer(tr.layer);
    if (act === "text-full") store.updateDraft((d) => { if (d.upcoming) { delete d.upcoming.start; delete d.upcoming.end; } }, "timeline-menu");
    if (act === "voice-zero") store.updateDraft((d) => { if (d.announcement) d.announcement.start = 0; }, "timeline-menu");
    if (act === "voice-remove") { store.updateDraft((d) => { d.announcement = null; }, "timeline-menu"); toast("Announcement removed from the draft.", "info"); }
    if (act === "music-remove") store.updateDraft((d) => { d.audio.splice(Number(arg) || 0, 1); }, "timeline-menu");
  }

  // ---------- pointer interactions ----------

  _startSeek(e, target = e.currentTarget) {
    if (e.button !== 0) return;
    e.preventDefault();
    target.setPointerCapture(e.pointerId);
    store.seek(this._timeAt(e.clientX));
    const move = (ev) => store.seek(this._timeAt(ev.clientX));
    const up = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); target.removeEventListener("pointercancel", up); };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  _onLaneDown(e) {
    if (e.button !== 0) return;
    const add = e.target.closest(".add");
    if (add) { store.setLayer(add.dataset.layer); return; }
    const dragEl = e.target.closest("[data-drag]");
    const lane = e.target.closest(".lane");
    if (!lane) return;
    if (!dragEl) {
      store.setLayer(lane.dataset.layer);
      if (!e.target.closest(".clip")) this._startSeek(e, this.shadowRoot.querySelector(".lanes"));
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const mode = dragEl.dataset.drag;
    const t = bumpTiming(store.state.draft);
    const D = this._duration();
    this._drag = {
      mode, x0: e.clientX, moved: false, clip: dragEl.closest(".clip"), layer: lane.dataset.layer,
      start0: mode === "voice" ? t.announcementStart : t.upcomingStart,
      end0: Number.isFinite(t.upcomingEnd) ? Math.min(t.upcomingEnd, D) : D,
      len: Number(store.state.playback.durations?.announcement) || null,
    };
    dragEl.setPointerCapture(e.pointerId);
    this.shadowRoot.querySelector(".tl").classList.add("dragging");
    const move = (ev) => this._dragMove(ev);
    const up = () => {
      dragEl.removeEventListener("pointermove", move);
      dragEl.removeEventListener("pointerup", up);
      dragEl.removeEventListener("pointercancel", up);
      this._dragEnd();
    };
    dragEl.addEventListener("pointermove", move);
    dragEl.addEventListener("pointerup", up);
    dragEl.addEventListener("pointercancel", up);
  }

  _dragMove(ev) {
    const g = this._drag;
    if (!g) return;
    if (!g.moved && Math.abs(ev.clientX - g.x0) < 3) return;
    g.moved = true;
    const D = this._duration();
    const dt = ((ev.clientX - g.x0) / (this._content.getBoundingClientRect().width - 6)) * D;
    const snap = (v) => (ev.altKey ? Math.round(v * 100) / 100 : roundTime(v));
    let s = g.start0;
    let en = g.end0;
    if (g.mode === "voice") s = snap(Math.min(Math.max(0, g.start0 + dt), D - 0.1));
    else if (g.mode === "text-start") s = snap(Math.min(Math.max(0, g.start0 + dt), g.end0 - MIN_TEXT_SPAN));
    else if (g.mode === "text-end") en = snap(Math.max(Math.min(D, g.end0 + dt), g.start0 + MIN_TEXT_SPAN));
    else if (g.mode === "text-move") {
      const span = g.end0 - g.start0;
      s = snap(Math.min(Math.max(0, g.start0 + dt), D - span));
      en = roundTime(s + span);
    }
    const clip = g.clip;
    if (g.mode === "voice") {
      const len = g.len || Math.min(3, D - s);
      const visible = Math.max(0.1, Math.min(len, D - s));
      clip.style.left = `${(s / D) * 100}%`;
      clip.style.width = `${(visible / D) * 100}%`;
      if (clip.style.backgroundImage) clip.style.backgroundSize = `${(len / visible) * 100}% 100%`;
      clip.classList.toggle("cut", len > D - s + 0.01);
      clip.setAttribute("aria-valuenow", String(s));
      this._showTip(clip, `${s.toFixed(1)}s`);
      this._commit((d) => { ensureDuration(d); if (d.announcement) d.announcement.start = s; });
    } else {
      clip.style.left = `${(s / D) * 100}%`;
      clip.style.width = `${((en - s) / D) * 100}%`;
      this._showTip(clip, `${s.toFixed(1)}s – ${en.toFixed(1)}s`);
      this._commit((d) => { ensureDuration(d); d.upcoming = { ...(d.upcoming || {}), start: s, end: en }; });
    }
  }

  _dragEnd() {
    const g = this._drag;
    this._drag = null;
    this.shadowRoot.querySelector(".tl").classList.remove("dragging");
    this._hideTip();
    store.setLayer(g.layer);
    requestAnimationFrame(() => this._render()); // after the last throttled commit lands
  }

  _onClipKey(e) {
    const el = e.target.closest("[data-drag]");
    if (!el || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    e.stopPropagation();
    const step = (e.shiftKey ? 1 : 0.1) * (e.key === "ArrowLeft" ? -1 : 1);
    const t = bumpTiming(store.state.draft);
    const D = this._duration();
    const end = Number.isFinite(t.upcomingEnd) ? Math.min(t.upcomingEnd, D) : D;
    const mode = el.dataset.drag;
    store.updateDraft((d) => {
      ensureDuration(d);
      if (mode === "voice" && d.announcement) d.announcement.start = roundTime((t.announcementStart || 0) + step);
      if (mode === "text-start") d.upcoming = { ...d.upcoming, start: roundTime(t.upcomingStart + step), end };
      if (mode === "text-end") d.upcoming = { ...d.upcoming, start: t.upcomingStart, end: roundTime(end + step) };
      if (mode === "text-move") {
        const span = end - t.upcomingStart;
        const s = Math.min(Math.max(0, t.upcomingStart + step), D - span);
        d.upcoming = { ...d.upcoming, start: roundTime(s), end: roundTime(s + span) };
      }
    }, "timeline-key");
    this.shadowRoot.querySelector(`[data-drag="${mode}"]`)?.focus();
  }

  _showTip(clip, text) {
    let tip = this.shadowRoot.querySelector(".tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "tip";
      this._content.append(tip);
    }
    tip.textContent = text;
    tip.style.left = `${clip.offsetLeft + clip.offsetWidth / 2}px`;
    tip.style.top = `${clip.parentElement.offsetTop - 2}px`;
  }

  _hideTip() { this.shadowRoot.querySelector(".tip")?.remove(); }
}

/** 0 -> "0:00", 12.5 -> "0:12.5" */
function fmtClock(t) {
  const m = Math.floor(t / 60);
  const s = t % 60;
  const whole = Math.abs(s - Math.round(s)) < 1e-6;
  return `${m}:${whole ? String(Math.round(s)).padStart(2, "0") : s.toFixed(1).padStart(4, "0")}`;
}

customElements.define("bump-timeline", BumpTimeline);
