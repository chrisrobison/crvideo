// <bump-schedule-workspace> -- the Schedule tab.
//
// PHASE A: this is the pre-existing per-channel scheduling UI from the old
// cf-bump-creator.js, moved here as-is (same markup, same save semantics:
// one save_schedule call per channel, full replace of
// channels/<id>/bump-schedule.json) and bound to the shared studio store.
// It is a placeholder for the Schedule redesign (one channel at a time,
// readable recurrence, next-fire previews, duration-fit warnings via
// bump-model.js's scheduleFit()).
//
// Store API to build on: store.state.schedules ([{id, name, enabled, rules}]),
// store.state.bumps, store.saveSchedule(channelId, enabled, rules),
// store.reloadSchedules(), store.referencesTo(bumpId), store.openInCompose(id),
// and the "schedules"/"bumps" change keys.

import { escapeHtml, toast } from "../../utils.js";
import { studioStore as store } from "./bump-studio-store.js";
import { studioCSS } from "./studio-ui.js";

const SCHEDULE_PERIODS = { hour: "Every hour", halfHour: "Every half hour", day: "Every day" };

function scheduleRuleRowHtml(rule, bumps) {
  return `
    <div class="sched-rule-row">
      <select class="sr-bump" aria-label="Bump">
        <option value="">— choose a bump —</option>
        ${bumps.map((b) => `<option value="${escapeHtml(b.id)}" ${b.id === rule.bumpId ? "selected" : ""}>${escapeHtml(b.name || b.id)}</option>`).join("")}
      </select>
      <select class="sr-every" aria-label="Recurrence">
        ${Object.entries(SCHEDULE_PERIODS).map(([k, label]) => `<option value="${k}" ${k === rule.every ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
      </select>
      <label class="sr-field">Offset (s)<input class="sr-offset" type="number" min="0" value="${rule.offsetSeconds ?? 0}"></label>
      <label class="sr-field">Duration (s)<input class="sr-duration" type="number" min="1" value="${rule.durationSeconds ?? 12}"></label>
      <button class="sr-remove ghost icon-btn" title="Remove rule" aria-label="Remove rule">✕</button>
    </div>
  `;
}

function readScheduleRuleRow(row) {
  const bumpId = row.querySelector(".sr-bump").value;
  if (!bumpId) return null;
  return {
    bumpId,
    every: row.querySelector(".sr-every").value,
    offsetSeconds: Number(row.querySelector(".sr-offset").value) || 0,
    durationSeconds: Number(row.querySelector(".sr-duration").value) || 12,
  };
}

function scheduleChannelHtml(channel, bumps) {
  const live = channel.enabled && channel.rules.length;
  return `
    <details class="sched-channel" data-channel="${escapeHtml(channel.id)}" ${live ? "open" : ""}>
      <summary>
        <span class="sched-channel-name">${escapeHtml(channel.name)}</span>
        <span class="badge" data-tone="${live ? "live" : ""}">
          ${live ? `${channel.rules.length} rule${channel.rules.length === 1 ? "" : "s"} live` : "off"}
        </span>
        <span class="spacer"></span>
      </summary>
      <div class="sched-channel-body">
        <label class="loop-label"><input type="checkbox" class="sched-enabled" ${channel.enabled ? "checked" : ""}> Show scheduled bumps on this channel</label>
        <div class="sched-rules">
          ${channel.rules.map((r) => scheduleRuleRowHtml(r, bumps)).join("")}
        </div>
        <div class="row" style="gap:8px; margin-top:8px;">
          <button class="sched-add-rule-btn ghost" ${bumps.length ? "" : "disabled"}>+ Add rule</button>
          <button class="sched-save-btn primary">Save schedule</button>
        </div>
        ${!bumps.length ? `<p class="hint-note">Build at least one bump in Compose before scheduling it.</p>` : ""}
      </div>
    </details>
  `;
}

class BumpScheduleWorkspace extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ${studioCSS}
        :host{ display:block; }
        .wrap{ max-width:1100px; margin:0 auto; padding:16px 20px 32px; }
        h2{ font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); margin:0 0 6px; }
        .hint-note{ font-size:12px; color:var(--text-muted); margin:6px 0 14px; line-height:1.5; }
        .sched-channel{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm); margin-bottom:10px; overflow:hidden; }
        .sched-channel summary{ list-style:none; cursor:pointer; display:flex; align-items:center; gap:10px; padding:10px 14px; }
        .sched-channel summary::-webkit-details-marker{ display:none; }
        .sched-channel[open] summary{ border-bottom:1px solid var(--border); }
        .sched-channel-name{ font-weight:700; font-size:13px; }
        .sched-channel-body{ padding:14px; }
        .loop-label{ display:flex; align-items:center; gap:6px; font-size:13px; margin-bottom:10px; }
        .loop-label input{ width:auto; }
        .sched-rules{ display:flex; flex-direction:column; gap:8px; }
        .sched-rule-row{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .sched-rule-row select{ flex:1; min-width:140px; }
        .sr-field{ display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text-muted); white-space:nowrap; }
        .sr-field input{ width:70px; }
      </style>
      <div class="wrap">
        <h2>Scheduling</h2>
        <p class="hint-note">Which channel(s) actually show a bump live, and when: clock-anchored (e.g. "every hour, on the hour, for 12s"), independent of the channel's programming. A scheduled bump draws over the program and temporarily interrupts it; the broadcast timeline keeps running underneath. See bumps/README.md.</p>
        <div class="sched-channels"></div>
      </div>
    `;
    this._onChange = ({ detail }) => {
      // Re-render only when the underlying data changes -- never on draft
      // edits, so half-edited rule rows here survive Compose activity.
      if (detail.keys.has("schedules") || detail.keys.has("status") || detail.keys.has("bumps")) this._render();
    };
    store.addEventListener("change", this._onChange);
    this._render();
  }

  disconnectedCallback() {
    store.removeEventListener("change", this._onChange);
  }

  _render() {
    const el = this.shadowRoot.querySelector(".sched-channels");
    const { schedules, bumps, status } = store.state;
    if (status !== "ready") { el.innerHTML = ""; return; }
    el.innerHTML = schedules.map((c) => scheduleChannelHtml(c, bumps)).join("") || `<div class="hint-note">No channels found.</div>`;
    el.querySelectorAll(".sched-channel").forEach((channelEl) => {
      const channelId = channelEl.dataset.channel;
      channelEl.querySelector(".sched-add-rule-btn").addEventListener("click", () => {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = scheduleRuleRowHtml({ every: "hour", offsetSeconds: 0, durationSeconds: 12 }, store.state.bumps);
        const row = wrapper.firstElementChild;
        channelEl.querySelector(".sched-rules").appendChild(row);
        row.querySelector(".sr-remove").addEventListener("click", () => row.remove());
      });
      channelEl.querySelectorAll(".sched-rule-row").forEach((row) => row.querySelector(".sr-remove").addEventListener("click", () => row.remove()));
      channelEl.querySelector(".sched-save-btn").addEventListener("click", async () => {
        const enabled = channelEl.querySelector(".sched-enabled").checked;
        const rules = Array.from(channelEl.querySelectorAll(".sched-rule-row")).map(readScheduleRuleRow).filter(Boolean);
        try {
          await store.saveSchedule(channelId, enabled, rules);
          toast(`Saved schedule for ${channelId}.`, "good");
        } catch (err) {
          toast(err.message, "danger");
        }
      });
    });
  }
}

customElements.define("bump-schedule-workspace", BumpScheduleWorkspace);
