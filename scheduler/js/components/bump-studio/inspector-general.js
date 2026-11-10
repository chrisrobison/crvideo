// Inspector: "Bump" -- name, description, composition duration, and where
// the saved bump is scheduled (read-only; editing happens in Schedule).

import { escapeHtml } from "../../utils.js";
import { h, setValue } from "./inspector-common.js";
import { bumpDuration, bumpTiming, effectiveDuration, scheduleFit, DEFAULT_BUMP_DURATION, MIN_DURATION, MAX_DURATION } from "./bump-model.js";

const EVERY = { hour: "every hour", halfHour: "every half hour", day: "every day" };
const FIT = {
  exact: ["good", "matches"],
  cut: ["warn", "window is shorter: bump is cut short"],
  loop: ["warn", "window is longer: bump loops"],
  open: ["", "length set by the rule"],
};

function offsetLabel(every, offset) {
  const o = Math.round(Number(offset) || 0);
  if (every === "day") {
    const hh = String(Math.floor(o / 3600)).padStart(2, "0");
    const mm = String(Math.floor((o % 3600) / 60)).padStart(2, "0");
    return `at ${hh}:${mm} UTC`;
  }
  const m = Math.floor(o / 60);
  const s = o % 60;
  return `at :${String(m).padStart(2, "0")}${s ? `:${String(s).padStart(2, "0")}` : ""}`;
}

export class GeneralSection {
  constructor({ store }) { this.store = store; }

  key() { return `general:${this.store.state.selectedId}`; }

  mount(container) {
    const s = this.store;
    this.el = h(`
      <div>
        <style>
          .refs{ list-style:none; margin:6px 0 0; padding:0; font-size:12px; }
          .refs li{ padding:6px 0; border-bottom:1px solid var(--border-soft); }
          .refs .fit{ font-size:11px; }
          .refs .fit.warn{ color:var(--warn); } .refs .fit.good{ color:var(--good); }
          textarea{ resize:vertical; min-height:54px; }
          .meta{ font-size:11px; color:var(--text-faint); margin-top:14px; line-height:1.6; }
        </style>
        <div class="field-row"><label for="g-name">Name</label><input id="g-name" maxlength="120"></div>
        <div class="field-row" style="align-items:start"><label for="g-desc">Notes</label><textarea id="g-desc" maxlength="300" placeholder="Optional"></textarea></div>
        <div class="field-row"><label for="g-dur">Duration</label>
          <div class="inline"><input id="g-dur" class="num" type="number" min="${MIN_DURATION}" max="${MAX_DURATION}" step="0.5"><span class="small muted">s</span><span class="small faint g-durnote"></span><button class="g-clear ghost small" title="Remove the saved duration: the bump goes back to schema v1 and its voice/text timing is dropped">Clear</button></div>
        </div>
        <div class="eyebrow" style="margin-top:18px">Scheduled on</div>
        <ul class="refs"></ul>
        <button class="open-sched ghost small" style="margin-top:8px">Open Schedule</button>
        <div class="meta"></div>
      </div>`);
    container.append(this.el);
    const q = (sel) => this.el.querySelector(sel);
    q("#g-name").addEventListener("input", (e) => s.updateDraft((d) => { d.name = e.target.value; }, "inspector"));
    q("#g-desc").addEventListener("input", (e) => s.updateDraft((d) => { d.description = e.target.value; }, "inspector"));
    q("#g-dur").addEventListener("change", (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v > 0) s.updateDraft((d) => { d.duration = v; }, "inspector");
    });
    q(".g-clear").addEventListener("click", () => {
      const t = bumpTiming(s.state.draft);
      const hasTiming = t.announcementStart > 0 || t.upcomingStart > 0 || Number.isFinite(t.upcomingEnd);
      if (hasTiming && !window.confirm("Clearing the duration also drops the voice/text timing. Continue?")) return;
      s.updateDraft((d) => { delete d.duration; }, "inspector");
    });
    q(".open-sched").addEventListener("click", () => s.setWorkspace("schedule"));
    this.update();
  }

  update() {
    const s = this.store;
    const d = s.state.draft;
    const q = (sel) => this.el.querySelector(sel);
    setValue(q("#g-name"), d.name);
    setValue(q("#g-desc"), d.description);
    setValue(q("#g-dur"), effectiveDuration(d));
    q(".g-durnote").textContent = bumpDuration(d) ? "" : `default ${DEFAULT_BUMP_DURATION}s, not saved`;
    q(".g-clear").hidden = !bumpDuration(d);

    const saved = s.selectedBump;
    const refs = saved ? s.referencesTo(saved.id) : [];
    q(".refs").innerHTML = refs.length
      ? refs.flatMap((c) => c.rules.map((r) => {
        const [tone, text] = FIT[scheduleFit(r.durationSeconds, d)];
        return `<li><strong>${escapeHtml(c.name)}</strong>${c.enabled ? "" : ' <span class="faint">(disabled)</span>'}<br>
          <span class="muted">${EVERY[r.every] || r.every} ${offsetLabel(r.every, r.offsetSeconds)}, ${Number(r.durationSeconds)}s</span>
          · <span class="fit ${tone}">${text}</span></li>`;
      })).join("")
      : `<li class="muted">${saved ? "Not scheduled on any channel." : "Save the bump first, then schedule it."}</li>`;
    q(".meta").innerHTML = saved
      ? `id <code>${escapeHtml(saved.id)}</code> · schema v${bumpDuration(d) ? 2 : 1} on save${saved.updatedAt ? ` · saved ${escapeHtml(new Date(saved.updatedAt).toLocaleString())}` : ""}`
      : "New bump, not saved yet.";
  }
}
