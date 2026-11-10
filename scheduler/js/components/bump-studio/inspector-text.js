// Inspector: Text -- the existing upcoming-programs overlay: how many
// shows (0-6), the eyebrow label, when it's on screen, accent colors, and
// (collapsed) the rest of the palette. Show titles are NEVER stored: the
// preview programming selector here is preview-only state.

import { escapeHtml } from "../../utils.js";
import { h, setValue } from "./inspector-common.js";
import { bumpTiming, effectiveDuration, ensureDuration, roundTime, STYLE_DEFAULTS, MAX_UPCOMING, MIN_TEXT_SPAN } from "./bump-model.js";

const MAIN_COLORS = [["accent", "Accent"], ["accentWarm", "Countdown"]];
const ADV_COLORS = [["fg", "Text"], ["muted", "Secondary"], ["bg", "Backdrop"], ["bg2", "Backdrop glow"]];

export class TextSection {
  constructor({ store }) { this.store = store; this.tab = "content"; }

  key() { return `text:${this.store.state.selectedId}:${this.store.state.media.channels.length}`; }

  mount(container) {
    const s = this.store;
    const colorRow = ([k, label]) => `
      <div class="field-row"><label for="c-${k}">${label}</label>
        <div class="inline"><input type="color" id="c-${k}" data-k="${k}" style="width:44px;height:30px;padding:2px">
        <span class="small faint cv" data-k="${k}"></span><button class="reset ghost small" data-k="${k}" aria-label="Reset ${label} to default">Reset</button></div></div>`;
    this.el = h(`
      <div>
        <style>
          .count{ display:grid; grid-template-columns:minmax(0,1fr) 30px; gap:8px; align-items:center; }
          .count input{ padding:0; accent-color:var(--accent); }
          .subtabs{ display:grid; grid-template-columns:repeat(3,1fr); margin-bottom:14px; width:100%; }
          .subtabs button{ padding:7px 0; font-size:13px; }
          .subtabs button[aria-selected="true"]{ background:var(--accent); color:#fff; }
          .note{ font-size:11px; color:var(--text-faint); margin:-4px 0 12px; }
          .h4{ font-size:13px; font-weight:700; margin:4px 0 10px; }
        </style>
        <div class="seg subtabs" role="tablist" aria-label="Text settings">
          <button role="tab" data-tab="content">Content</button><button role="tab" data-tab="style">Style</button><button role="tab" data-tab="timing">Timing</button>
        </div>
        <div class="pane" data-pane="content">
          <div class="h4">Upcoming programs</div>
          <div class="field-row"><label for="t-count">Shows</label><div class="count"><input id="t-count" type="range" min="0" max="${MAX_UPCOMING}" step="1"><span class="tnum t-countv"></span></div></div>
          <div class="field-row"><label for="t-label">Label</label><input id="t-label" maxlength="40" placeholder="Coming Up"></div>
          <div class="h4" style="margin-top:16px">Program to preview</div>
          <select id="t-src" aria-label="Program to preview" style="padding:7px 9px;font-size:13px"></select>
          <div class="note" style="margin-top:6px">Preview only. On air, titles come from the channel's live schedule; they are never stored in the bump.</div>
        </div>
        <div class="pane" data-pane="style">
          ${MAIN_COLORS.map(colorRow).join("")}
          <details class="adv"><summary>Advanced colors</summary>${ADV_COLORS.map(colorRow).join("")}</details>
        </div>
        <div class="pane" data-pane="timing">
          <div class="field-row"><label for="t-start">Appears at</label><div class="inline"><input id="t-start" class="num" type="number" min="0" step="0.1"><span class="small muted">s</span></div></div>
          <div class="field-row"><label for="t-end">Disappears at</label><div class="inline"><input id="t-end" class="num" type="number" min="0" step="0.1"><span class="small muted">s</span></div></div>
          <div class="field-row"><span class="lbl"></span><button class="full ghost small" style="justify-self:start">Whole bump</button></div>
          <div class="note">You can also drag the Text clip's handles on the timeline.</div>
        </div>
      </div>`);
    container.append(this.el);
    const q = (sel) => this.el.querySelector(sel);
    const showTab = (tab) => {
      this.tab = tab;
      this.el.querySelectorAll("[data-tab]").forEach((b) => { b.setAttribute("aria-selected", String(b.dataset.tab === tab)); b.tabIndex = b.dataset.tab === tab ? 0 : -1; });
      this.el.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    };
    q(".subtabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); });
    showTab(this.tab);
    q("#t-count").addEventListener("input", (e) => s.updateDraft((d) => { d.upcoming = { ...d.upcoming, count: Number(e.target.value) }; }, "inspector"));
    q("#t-label").addEventListener("input", (e) => s.updateDraft((d) => { d.upcoming = { ...d.upcoming, label: e.target.value }; }, "inspector"));
    const setSpan = () => {
      const D = effectiveDuration(s.state.draft);
      let a = Number(q("#t-start").value);
      let b = q("#t-end").value === "" ? D : Number(q("#t-end").value);
      if (!Number.isFinite(a)) a = 0;
      if (!Number.isFinite(b)) b = D;
      if (b - a < MIN_TEXT_SPAN) b = a + MIN_TEXT_SPAN;
      s.updateDraft((d) => { ensureDuration(d); d.upcoming = { ...d.upcoming, start: roundTime(a), end: roundTime(b) }; }, "inspector");
      this.update(true);
    };
    q("#t-start").addEventListener("change", setSpan);
    q("#t-end").addEventListener("change", setSpan);
    q(".full").addEventListener("click", () => s.updateDraft((d) => { if (d.upcoming) { delete d.upcoming.start; delete d.upcoming.end; } }, "inspector"));
    q("#t-src").addEventListener("change", (e) => s.setPreviewSource(e.target.value));
    this.el.querySelectorAll('input[type="color"]').forEach((inp) => inp.addEventListener("input", () => {
      s.updateDraft((d) => { d.style = { ...(d.style || {}), [inp.dataset.k]: inp.value }; }, "inspector");
      this.update();
    }));
    this.el.querySelectorAll(".reset").forEach((b) => b.addEventListener("click", () => {
      s.updateDraft((d) => { if (d.style) delete d.style[b.dataset.k]; }, "inspector");
    }));
    this.update();
  }

  update(force = false) {
    const s = this.store.state;
    const d = s.draft;
    const q = (sel) => this.el.querySelector(sel);
    const set = force ? (el, v) => { el.value = v; } : setValue;
    set(q("#t-count"), d.upcoming?.count ?? 3);
    q(".t-countv").textContent = String(d.upcoming?.count ?? 3);
    setValue(q("#t-label"), d.upcoming?.label ?? "Coming Up");
    const t = bumpTiming(d);
    const D = effectiveDuration(d);
    set(q("#t-start"), t.upcomingStart);
    set(q("#t-end"), Number.isFinite(t.upcomingEnd) ? Math.min(t.upcomingEnd, D) : D);
    q("#t-start").max = String(D);
    q("#t-end").max = String(D);
    q(".full").disabled = t.upcomingStart === 0 && !Number.isFinite(t.upcomingEnd);

    const sel = q("#t-src");
    const channels = s.media.channels || [];
    if (sel.options.length !== channels.length + 1) {
      sel.innerHTML = `<option value="sample">Sample programming</option>${channels.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (Live)</option>`).join("")}`;
    }
    sel.value = s.preview.source;

    for (const [k] of [...MAIN_COLORS, ...ADV_COLORS]) {
      const v = d.style?.[k];
      const valid = /^#[0-9a-f]{6}$/i.test(v || "");
      setValue(this.el.querySelector(`#c-${k}`), valid ? v : STYLE_DEFAULTS[k]);
      this.el.querySelector(`.cv[data-k="${k}"]`).textContent = v ? v : "default";
      this.el.querySelector(`.reset[data-k="${k}"]`).hidden = !v;
    }
  }
}
