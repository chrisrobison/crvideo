import { store } from "../store.js";
import {
  baseComponentCSS, escapeHtml, secToTimeValue, timeValueToSec, fmtHMS, parseHMSToSec, toast,
} from "../utils.js";
import "./cf-toggle.js";

const TABS = ["details", "transitions", "advanced"];

class CfDetailsPanel extends HTMLElement {
  constructor() {
    super();
    this._tab = "details";
  }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._render();
      this._onChange = (e) => { if (e.detail.reason !== "tick") this._renderBody(); };
      store.addEventListener("change", this._onChange);
    }
    this._renderBody();
  }

  disconnectedCallback() { store.removeEventListener("change", this._onChange); }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        :host{ display:block; background:var(--panel); border:1px solid var(--border); border-radius:var(--radius);
          overflow:hidden; }
        .tabs{ display:flex; border-bottom:1px solid var(--border); }
        .tabs button{ flex:1; background:transparent; border:none; border-radius:0; padding:12px 8px; font-size:11px;
          font-weight:800; letter-spacing:.05em; color:var(--text-muted); border-bottom:2px solid transparent; }
        .tabs button.active{ color:var(--text); border-bottom-color:var(--accent); }
        .body{ padding:16px; max-height:70vh; overflow-y:auto; }
        .empty{ padding:40px 16px; text-align:center; color:var(--text-muted); font-size:13px; }
        .header-row{ display:flex; gap:12px; margin-bottom:16px; }
        .thumb{ width:70px; height:52px; border-radius:8px; flex-shrink:0; background:linear-gradient(135deg,var(--video-a),var(--video-b));
          display:flex; align-items:center; justify-content:center; color:#fff; font-size:9px; font-weight:800; text-align:center; }
        .thumb[data-type="live"]{ background:linear-gradient(135deg,var(--live-a),var(--live-b)); }
        .thumb[data-type="graphic"]{ background:var(--graphic); border:1px solid var(--border); color:var(--text-muted); }
        .title-block{ min-width:0; flex:1; }
        .title-row{ display:flex; align-items:center; gap:6px; }
        .title-text{ font-size:16px; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .title-input{ font-size:15px; font-weight:800; padding:4px 6px; }
        .edit-btn{ background:transparent; border:none; padding:2px; color:var(--text-muted); }
        .meta-row{ display:flex; align-items:center; gap:8px; margin-top:6px; }
        .grid2{ display:grid; grid-template-columns:1fr 1fr; gap:0 12px; }
        textarea.notes{ min-height:70px; resize:vertical; font:inherit; }
        .actions-row{ display:flex; gap:8px; margin-top:6px; }
        pre.json{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm);
          padding:10px; font:11px/1.5 var(--mono); white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; }
        .id-field{ font:11px var(--mono); color:var(--text-muted); }
      </style>
      <div class="tabs">
        ${TABS.map((t) => `<button data-tab="${t}" class="${t === this._tab ? "active" : ""}">${t.toUpperCase()}</button>`).join("")}
      </div>
      <div class="body"></div>
    `;
    this.shadowRoot.querySelector(".tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tab]");
      if (!btn) return;
      this._tab = btn.dataset.tab;
      this.shadowRoot.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === this._tab));
      this._renderBody();
    });
  }

  _sourceOptions(track, current) {
    const opts = new Set();
    if (current) opts.add(current);
    if (track.kind === "live") { opts.add("RTMP Live Input 1"); opts.add("RTMP Live Input 2"); }
    else { store.media.filter((m) => m.type !== "live").forEach((m) => opts.add(m.title)); opts.add("Video File"); }
    return [...opts];
  }

  _fallbackOptions(current) {
    const opts = new Set([""]);
    if (current) opts.add(current);
    store.media.filter((m) => m.type === "video").forEach((m) => opts.add(m.title));
    return [...opts];
  }

  _renderBody() {
    const root = this.shadowRoot;
    const body = root.querySelector(".body");
    const found = store.getSelected();
    if (!found) {
      body.innerHTML = `<div class="empty">Select a segment on the timeline to view and edit its details.</div>`;
      return;
    }
    const { track, block: b } = found;

    if (this._tab === "details") {
      body.innerHTML = `
        <div class="header-row">
          <div class="thumb" data-type="${b.type}">${escapeHtml(b.type.toUpperCase())}</div>
          <div class="title-block">
            <div class="title-row">
              <span class="title-text"></span>
              <button class="edit-btn" title="Rename">✎</button>
            </div>
            <div class="meta-row">
              <span class="badge" data-tone="${b.type}">${b.type.toUpperCase()}</span>
              <span class="muted">${fmtHMS(b.end - b.start)}</span>
            </div>
          </div>
        </div>

        <div class="grid2">
          <label class="field">Start<div class="field-value"><input type="time" step="1" class="start-input"></div></label>
          <label class="field">End<div class="field-value"><input type="time" step="1" class="end-input"></div></label>
        </div>
        <label class="field">Duration<div class="field-value"><input type="text" class="duration-input" placeholder="HH:MM:SS"></div></label>
        <label class="field">Source<div class="field-value"><select class="source-input"></select></div></label>
        <label class="field">Fallback<div class="field-value"><select class="fallback-input"></select></div></label>

        <cf-toggle class="autostart-toggle" label="Auto start" description="Start automatically at scheduled time" ${b.autoStart ? "checked" : ""}></cf-toggle>
        <cf-toggle class="record-toggle" label="Record stream" description="Save live stream to media library" ${b.recordStream ? "checked" : ""}></cf-toggle>
        <cf-toggle class="overrun-toggle" label="Allow overrun" description="Keep on air if it runs long" ${b.allowOverrun ? "checked" : ""}></cf-toggle>
      `;
      body.querySelector(".title-text").textContent = b.title;
      body.querySelector(".start-input").value = secToTimeValue(b.start);
      body.querySelector(".end-input").value = secToTimeValue(b.end);
      body.querySelector(".duration-input").value = fmtHMS(b.end - b.start);

      const sourceSel = body.querySelector(".source-input");
      sourceSel.innerHTML = this._sourceOptions(track, b.source).map((s) =>
        `<option value="${escapeHtml(s)}" ${s === b.source ? "selected" : ""}>${escapeHtml(s)}</option>`).join("");

      const fallbackSel = body.querySelector(".fallback-input");
      fallbackSel.innerHTML = this._fallbackOptions(b.fallback).map((s) =>
        `<option value="${escapeHtml(s)}" ${s === b.fallback ? "selected" : ""}>${s ? escapeHtml(s) : "None"}</option>`).join("");

      body.querySelector(".edit-btn").addEventListener("click", () => {
        const span = body.querySelector(".title-text");
        const input = document.createElement("input");
        input.className = "title-input";
        input.value = b.title;
        span.replaceWith(input);
        input.focus();
        input.select();
        const commit = () => {
          const val = input.value.trim() || b.title;
          store.updateBlock(b.id, { title: val });
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
        input.addEventListener("blur", commit, { once: true });
      });

      body.querySelector(".start-input").addEventListener("change", (e) => {
        const sec = timeValueToSec(e.target.value);
        if (sec == null || sec >= b.end) { toast("Start must be before end.", "danger"); this._renderBody(); return; }
        store.updateBlock(b.id, { start: sec });
      });
      body.querySelector(".end-input").addEventListener("change", (e) => {
        const sec = timeValueToSec(e.target.value);
        if (sec == null || sec <= b.start) { toast("End must be after start.", "danger"); this._renderBody(); return; }
        store.updateBlock(b.id, { end: sec });
      });
      body.querySelector(".duration-input").addEventListener("change", (e) => {
        const dur = parseHMSToSec(e.target.value);
        if (!Number.isFinite(dur) || dur <= 0) { toast("Enter duration as HH:MM:SS.", "danger"); this._renderBody(); return; }
        store.updateBlock(b.id, { end: b.start + dur });
      });
      sourceSel.addEventListener("change", (e) => store.updateBlock(b.id, { source: e.target.value }));
      fallbackSel.addEventListener("change", (e) => store.updateBlock(b.id, { fallback: e.target.value }));
      body.querySelector(".autostart-toggle").addEventListener("change", (e) => store.updateBlock(b.id, { autoStart: e.detail.checked }));
      body.querySelector(".record-toggle").addEventListener("change", (e) => store.updateBlock(b.id, { recordStream: e.detail.checked }));
      body.querySelector(".overrun-toggle").addEventListener("change", (e) => store.updateBlock(b.id, { allowOverrun: e.detail.checked }));
    }

    if (this._tab === "transitions") {
      const ti = b.transitionIn || { type: "cut", duration: 0 };
      const to = b.transitionOut || { type: "cut", duration: 0 };
      body.innerHTML = `
        <label class="field">Transition in<div class="field-value">
          <select class="ti-type"><option value="cut">Cut</option><option value="fade">Fade</option><option value="wipe">Wipe</option></select>
        </div></label>
        <label class="field">In duration (seconds)<div class="field-value"><input type="number" min="0" step="0.5" class="ti-duration"></div></label>
        <label class="field">Transition out<div class="field-value">
          <select class="to-type"><option value="cut">Cut</option><option value="fade">Fade</option><option value="wipe">Wipe</option></select>
        </div></label>
        <label class="field">Out duration (seconds)<div class="field-value"><input type="number" min="0" step="0.5" class="to-duration"></div></label>
      `;
      body.querySelector(".ti-type").value = ti.type;
      body.querySelector(".ti-duration").value = ti.duration;
      body.querySelector(".to-type").value = to.type;
      body.querySelector(".to-duration").value = to.duration;
      const commitIn = () => store.updateBlock(b.id, { transitionIn: {
        type: body.querySelector(".ti-type").value, duration: Number(body.querySelector(".ti-duration").value) || 0 } });
      const commitOut = () => store.updateBlock(b.id, { transitionOut: {
        type: body.querySelector(".to-type").value, duration: Number(body.querySelector(".to-duration").value) || 0 } });
      body.querySelector(".ti-type").addEventListener("change", commitIn);
      body.querySelector(".ti-duration").addEventListener("change", commitIn);
      body.querySelector(".to-type").addEventListener("change", commitOut);
      body.querySelector(".to-duration").addEventListener("change", commitOut);
    }

    if (this._tab === "advanced") {
      body.innerHTML = `
        <label class="field">Segment ID<div class="field-value id-field">${escapeHtml(b.id)}</div></label>
        <label class="field">Track<div class="field-value id-field">${escapeHtml(track.label)}</div></label>
        <label class="field">Notes<div class="field-value"><textarea class="notes"></textarea></div></label>
        <div class="actions-row">
          <button class="duplicate-btn">Duplicate</button>
          <button class="delete-btn danger">Delete segment</button>
        </div>
        <label class="field" style="margin-top:16px;">Raw JSON<div class="field-value"><pre class="json"></pre></div></label>
      `;
      body.querySelector(".notes").value = b.notes || "";
      body.querySelector(".json").textContent = JSON.stringify(b, null, 2);
      body.querySelector(".notes").addEventListener("change", (e) => store.updateBlock(b.id, { notes: e.target.value }));
      body.querySelector(".duplicate-btn").addEventListener("click", () => {
        const copy = store.duplicateBlock(b.id);
        if (copy) { store.selectBlock(copy.id); toast("Segment duplicated.", "good"); }
      });
      body.querySelector(".delete-btn").addEventListener("click", () => {
        store.removeBlock(b.id);
        toast("Segment deleted.", "warn");
      });
    }
  }
}
customElements.define("cf-details-panel", CfDetailsPanel);
