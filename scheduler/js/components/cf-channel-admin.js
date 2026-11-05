// cf-channel-admin — channel/catalog/programming management view
// (phase 6, admin UI).
//
// Lists every channels/*/meta.json (scanned server-side by
// server/channel-admin.php -- this component never hardcodes channel
// ids), lets an editor edit which series a channel's catalog.json
// references and edit/add/remove programming.json's recurring blocks,
// and can preview (--dry-run) or run channels/publish.php.
//
// No access control: see docs/admin-ui.md. Anyone who can load this page
// can change channel programming and trigger a real publish from here.

import { baseComponentCSS, escapeHtml, toast } from "../utils.js";
import { channelAdminApi, seriesAdminApi } from "../admin-api.js";

const FREQUENCIES = ["daily", "weekly", "monthly"];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const PACKING_MODES = ["sequential", "best_fit", "hybrid"];
const ON_UNFIT_POLICIES = ["defer", "skip_for_block", "allow_overrun"];
const BOUNDARY_MODES = ["hard", "soft", "elastic"];

function blockRowHtml(block, allSeriesIds) {
  const rec = block.recurrence || {};
  const freq = rec.frequency || "daily";
  const packing = block.packing || {};
  const packingEnabled = packing.enabled === true;
  const boundary = block.boundary || {};
  const boundaryMode = boundary.mode || "hard";
  return `
    <div class="block-row">
      <div class="block-grid">
        <label class="field">Block id<div class="field-value"><input class="b-id" value="${escapeHtml(block.id || "")}" placeholder="e.g. technology-hour"></div></label>
        <label class="field">Series<div class="field-value"><select class="b-series">
          ${allSeriesIds.map((id) => `<option value="${escapeHtml(id)}" ${id === block.series_id ? "selected" : ""}>${escapeHtml(id)}</option>`).join("")}
        </select></div></label>
        <label class="field">Frequency<div class="field-value"><select class="b-freq">
          ${FREQUENCIES.map((f) => `<option value="${f}" ${f === freq ? "selected" : ""}>${f}</option>`).join("")}
        </select></div></label>
        <label class="field">Time (HH:MM)<div class="field-value"><input class="b-time" value="${escapeHtml(rec.time || "13:00")}" placeholder="13:00"></div></label>
        <label class="field">Timezone<div class="field-value"><input class="b-tz" value="${escapeHtml(rec.timezone || "UTC")}" placeholder="America/Los_Angeles"></div></label>
        <label class="field b-weekday-field ${freq === "weekly" ? "" : "hidden"}">Weekday<div class="field-value"><select class="b-weekday">
          ${WEEKDAYS.map((w) => `<option value="${w}" ${w === rec.weekday ? "selected" : ""}>${w}</option>`).join("")}
        </select></div></label>
        <label class="field b-dom-field ${freq === "monthly" ? "" : "hidden"}">Day of month<div class="field-value"><input class="b-dom" type="number" min="1" max="31" value="${rec.day_of_month || 1}"></div></label>
        <label class="field">Duration (seconds)<div class="field-value"><input class="b-duration" type="number" min="1" value="${block.duration || 1800}"></div></label>
        <label class="field">Rotation anchor date<div class="field-value"><input class="b-anchor" type="date" value="${escapeHtml(block.rotation?.anchor_date || "")}"></div></label>
        <label class="field"><div class="field-value"><label class="loop-label"><input type="checkbox" class="b-loop" ${block.rotation?.loop !== false ? "checked" : ""}> Loop back to episode 1</label></div></label>
        <div class="field remove-field"><button class="remove-block-btn danger">Remove block</button></div>
      </div>

      <details class="advanced-group">
        <summary>Multi-episode packing ${packingEnabled ? `<span class="pill">on · ${escapeHtml(packing.mode || "sequential")}</span>` : `<span class="pill muted">off</span>`}</summary>
        <div class="advanced-body">
          <label class="field"><div class="field-value"><label class="loop-label"><input type="checkbox" class="b-packing-enabled" ${packingEnabled ? "checked" : ""}> Fill this block with as many complete episodes as fit (instead of just one)</label></div></label>
          <div class="packing-fields ${packingEnabled ? "" : "hidden"}">
            <div class="block-grid">
              <label class="field">Mode<div class="field-value"><select class="b-packing-mode">
                ${PACKING_MODES.map((m) => `<option value="${m}" ${m === (packing.mode || "sequential") ? "selected" : ""}>${m}</option>`).join("")}
              </select></div></label>
              <label class="field">If an episode doesn't fit<div class="field-value"><select class="b-packing-onunfit">
                ${ON_UNFIT_POLICIES.map((p) => `<option value="${p}" ${p === (packing.on_unfit || "defer") ? "selected" : ""}>${p}</option>`).join("")}
              </select></div></label>
              <label class="field">Leave at least this much time (seconds)<div class="field-value"><input class="b-packing-minremain" type="number" min="0" value="${packing.minimum_remaining ?? 0}"></div></label>
              <label class="field">Safety margin (seconds)<div class="field-value"><input class="b-packing-margin" type="number" min="0" value="${packing.safety_margin ?? 0}"></div></label>
              <label class="field"><div class="field-value"><label class="loop-label"><input type="checkbox" class="b-packing-repeat" ${packing.allow_repeat_within_block ? "checked" : ""}> Allow the same episode twice in one occurrence</label></div></label>
            </div>
            <p class="hint-note">"sequential" keeps episodes in order (best for a structured show); "best_fit" ignores order to minimize unused time; "hybrid" prefers order but fills gaps from elsewhere when needed. "defer" (recommended) just waits for a bigger slot rather than guessing.</p>
          </div>
        </div>
      </details>

      <details class="advanced-group">
        <summary>Start time boundary <span class="pill ${boundaryMode === "hard" ? "muted" : ""}">${escapeHtml(boundaryMode)}</span></summary>
        <div class="advanced-body">
          <div class="block-grid">
            <label class="field">Mode<div class="field-value"><select class="b-boundary-mode">
              ${BOUNDARY_MODES.map((m) => `<option value="${m}" ${m === boundaryMode ? "selected" : ""}>${m}</option>`).join("")}
            </select></div></label>
            <label class="field b-boundary-delay-field ${boundaryMode === "hard" ? "hidden" : ""}">Max delay (seconds)<div class="field-value"><input class="b-boundary-delay" type="number" min="0" value="${boundary.max_delay ?? 300}"></div></label>
          </div>
          <p class="hint-note">"hard" (recommended for anything time-sensitive) never starts late. "soft"/"elastic" may start up to the max delay late if the previous program runs over -- never silently, always shown in the preview below.</p>
        </div>
      </details>
    </div>
  `;
}

function readBlockRow(row) {
  const freq = row.querySelector(".b-freq").value;
  const recurrence = { frequency: freq, time: row.querySelector(".b-time").value.trim(), timezone: row.querySelector(".b-tz").value.trim() };
  if (freq === "weekly") recurrence.weekday = row.querySelector(".b-weekday").value;
  if (freq === "monthly") recurrence.day_of_month = Number(row.querySelector(".b-dom").value) || 1;

  const block = {
    id: row.querySelector(".b-id").value.trim(),
    type: "series",
    series_id: row.querySelector(".b-series").value,
    recurrence,
    duration: Number(row.querySelector(".b-duration").value) || 0,
    rotation: { mode: "sequential", loop: row.querySelector(".b-loop").checked, anchor_date: row.querySelector(".b-anchor").value },
  };

  const packingEnabled = row.querySelector(".b-packing-enabled").checked;
  if (packingEnabled) {
    block.packing = {
      enabled: true,
      mode: row.querySelector(".b-packing-mode").value,
      on_unfit: row.querySelector(".b-packing-onunfit").value,
      minimum_remaining: Number(row.querySelector(".b-packing-minremain").value) || 0,
      safety_margin: Number(row.querySelector(".b-packing-margin").value) || 0,
      allow_repeat_within_block: row.querySelector(".b-packing-repeat").checked,
    };
  }

  const boundaryMode = row.querySelector(".b-boundary-mode").value;
  if (boundaryMode !== "hard") {
    block.boundary = { mode: boundaryMode, max_delay: Number(row.querySelector(".b-boundary-delay").value) || 0 };
  } else {
    block.boundary = { mode: "hard" };
  }

  return block;
}

function wireBlockRow(row) {
  const freqSelect = row.querySelector(".b-freq");
  const sync = () => {
    row.querySelector(".b-weekday-field").classList.toggle("hidden", freqSelect.value !== "weekly");
    row.querySelector(".b-dom-field").classList.toggle("hidden", freqSelect.value !== "monthly");
  };
  freqSelect.addEventListener("change", sync);

  const packingEnabledInput = row.querySelector(".b-packing-enabled");
  packingEnabledInput.addEventListener("change", () => {
    row.querySelector(".packing-fields").classList.toggle("hidden", !packingEnabledInput.checked);
  });

  const boundaryModeSelect = row.querySelector(".b-boundary-mode");
  boundaryModeSelect.addEventListener("change", () => {
    row.querySelector(".b-boundary-delay-field").classList.toggle("hidden", boundaryModeSelect.value === "hard");
  });

  row.querySelector(".remove-block-btn").addEventListener("click", () => row.remove());
}

class CfChannelAdmin extends HTMLElement {
  constructor() {
    super();
    this._channels = [];
    this._allSeriesIds = [];
    this._loading = true;
    this._error = null;
  }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._render();
    }
    this.reload();
  }

  async reload() {
    this._loading = true;
    this._error = null;
    this._renderBody();
    try {
      const [channels, series] = await Promise.all([channelAdminApi.list(), seriesAdminApi.list()]);
      this._channels = channels;
      this._allSeriesIds = series.map((s) => s.id);
    } catch (e) {
      this._error = e.message;
    }
    this._loading = false;
    this._renderBody();
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        :host{ display:block; }
        .toolbar{ display:flex; align-items:center; gap:10px; margin-bottom:14px; }
        .toolbar h1{ font-size:16px; margin:0; flex:1; }
        .channel-card{ background:var(--panel); border:1px solid var(--border); border-radius:var(--radius);
          margin-bottom:12px; overflow:hidden; }
        .channel-card summary{ list-style:none; cursor:pointer; display:flex; align-items:center; gap:10px; padding:14px 16px; }
        .channel-card summary::-webkit-details-marker{ display:none; }
        .channel-card[open] summary{ border-bottom:1px solid var(--border); }
        .channel-title{ font-weight:800; font-size:14px; }
        .channel-card .spacer{ flex:1; }
        .channel-body{ padding:16px; display:flex; flex-direction:column; gap:20px; }
        section h2{ font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); margin:0 0 10px; }
        .series-checklist{ display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
        .series-check{ display:flex; align-items:center; gap:6px; background:var(--panel-2); border:1px solid var(--border);
          border-radius:999px; padding:5px 10px; font-size:12px; }
        .series-check input{ width:auto; }
        .block-row{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm);
          padding:12px; margin-bottom:10px; }
        .block-grid{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px 14px; align-items:end; }
        .block-grid label.field{ margin-bottom:0; }
        .loop-label{ display:flex; align-items:center; gap:6px; font-size:12px; text-transform:none; letter-spacing:0; color:var(--text); }
        .remove-field{ display:flex; align-items:end; }
        .advanced-group{ margin-top:10px; border-top:1px solid var(--border); padding-top:10px; }
        .advanced-group summary{ cursor:pointer; font-size:12px; font-weight:700; color:var(--text-muted); list-style:none; display:flex; align-items:center; gap:8px; }
        .advanced-group summary::-webkit-details-marker{ display:none; }
        .advanced-body{ padding-top:10px; }
        .pill{ display:inline-block; font-size:10px; font-weight:800; letter-spacing:.04em; text-transform:uppercase;
          padding:2px 7px; border-radius:999px; background:var(--accent-soft, rgba(93,169,255,.18)); color:var(--accent, #5da9ff); }
        .pill.muted{ background:var(--panel-2); color:var(--text-muted); }
        .hint-note{ font-size:11px; color:var(--text-muted); margin:8px 0 0; line-height:1.5; }
        .publish-row{ display:flex; gap:12px; flex-wrap:wrap; align-items:end; margin-bottom:10px; }
        .publish-row .field{ margin-bottom:0; min-width:140px; }
        pre.output{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm);
          padding:10px; font:11px/1.5 var(--mono); white-space:pre-wrap; word-break:break-word; max-height:260px; overflow:auto; }
        .empty{ padding:40px; text-align:center; color:var(--text-muted); }
        .error{ color:#ffb4b4; padding:12px 16px; background:var(--live-soft); border-radius:var(--radius-sm); margin-bottom:12px; }
        .warn-note{ font-size:12px; color:var(--warn); }
      </style>
      <div class="toolbar">
        <h1>Channels &amp; programming</h1>
        <button class="reload-btn ghost">Reload</button>
      </div>
      <div class="body"></div>
    `;
    this.shadowRoot.querySelector(".reload-btn").addEventListener("click", () => this.reload());
  }

  _renderBody() {
    const root = this.shadowRoot;
    const body = root.querySelector(".body");

    if (this._loading) { body.innerHTML = `<div class="empty">Loading…</div>`; return; }
    if (this._error) { body.innerHTML = `<div class="error">Could not load channels: ${escapeHtml(this._error)}</div>`; return; }
    if (!this._channels.length) { body.innerHTML = `<div class="empty">No channels found under channels/*/meta.json yet.</div>`; return; }

    body.innerHTML = this._channels.map((c) => this._channelCardHtml(c)).join("");
    for (const c of this._channels) {
      const card = body.querySelector(`details[data-channel="${cssEscape(c.id)}"]`);
      if (card) this._wireChannelCard(card, c);
    }
  }

  _channelCardHtml(c) {
    const selectedIds = new Set(c.series_refs.map((r) => r.series_id).filter(Boolean));
    return `
      <details class="channel-card" data-channel="${escapeHtml(c.id)}">
        <summary>
          <span class="channel-title">${escapeHtml(c.name)}</span>
          <span class="muted">${c.number != null ? `#${c.number}` : "unnumbered"}${c.hidden ? " · hidden" : ""}</span>
          <span class="muted">${c.series_refs.length} series ref${c.series_refs.length === 1 ? "" : "s"} · ${c.programming_blocks.length} programming block${c.programming_blocks.length === 1 ? "" : "s"}</span>
          <span class="spacer"></span>
        </summary>
        <div class="channel-body">
          <section>
            <h2>Catalog series</h2>
            ${c.series_refs.some((r) => r.series_id && !r.known) ? `<p class="warn-note">One or more existing refs point at a series id that no longer exists on disk -- saving will drop it.</p>` : ""}
            <div class="series-checklist">
              ${this._allSeriesIds.map((id) => `
                <label class="series-check"><input type="checkbox" class="series-check-input" value="${escapeHtml(id)}" ${selectedIds.has(id) ? "checked" : ""}> ${escapeHtml(id)}</label>
              `).join("") || `<span class="muted">No series exist yet -- see the Series &amp; episode review tab.</span>`}
            </div>
            <button class="save-catalog-btn primary">Save catalog</button>
          </section>

          <section>
            <h2>Programming blocks</h2>
            <div class="blocks-editor">
              ${c.programming_blocks.map((b) => blockRowHtml(b, this._allSeriesIds)).join("")}
            </div>
            <div class="row" style="gap:8px;">
              <button class="add-block-btn">+ Add block</button>
              <button class="save-programming-btn primary">Save programming</button>
            </div>
          </section>

          <section>
            <h2>Publish</h2>
            ${!c.has_programming ? `<p class="warn-note">This channel has no programming.json yet -- save at least one block above first.</p>` : ""}
            <div class="publish-row">
              <label class="field">Days<div class="field-value"><input type="number" class="pub-days" min="1" max="365" value="14"></div></label>
              <label class="field">Window start<div class="field-value"><input type="date" class="pub-start"></div></label>
              <label class="field">Window timezone<div class="field-value"><input class="pub-tz" value="UTC"></div></label>
              <button class="pub-preview-btn">Preview (dry run)</button>
              <button class="pub-run-btn primary">Publish for real</button>
            </div>
            <pre class="publish-output hidden"></pre>
          </section>
        </div>
      </details>
    `;
  }

  _wireChannelCard(card, c) {
    card.querySelectorAll(".block-row").forEach(wireBlockRow);

    card.querySelector(".add-block-btn").addEventListener("click", () => {
      const editor = card.querySelector(".blocks-editor");
      const wrapper = document.createElement("div");
      wrapper.innerHTML = blockRowHtml({ recurrence: {}, rotation: {} }, this._allSeriesIds);
      const row = wrapper.firstElementChild;
      editor.appendChild(row);
      wireBlockRow(row);
    });

    card.querySelector(".save-catalog-btn").addEventListener("click", async () => {
      const seriesIds = Array.from(card.querySelectorAll(".series-check-input:checked")).map((i) => i.value);
      try {
        await channelAdminApi.saveCatalog(c.id, seriesIds);
        toast(`Saved catalog for ${c.id}.`, "good");
        this.reload();
      } catch (e) {
        toast(e.message, "danger");
      }
    });

    card.querySelector(".save-programming-btn").addEventListener("click", async () => {
      const blocks = Array.from(card.querySelectorAll(".block-row")).map(readBlockRow);
      try {
        await channelAdminApi.saveProgramming(c.id, blocks);
        toast(`Saved programming for ${c.id}.`, "good");
        this.reload();
      } catch (e) {
        toast(e.message, "danger");
      }
    });

    const runPublish = async (dryRun) => {
      const days = Number(card.querySelector(".pub-days").value) || 14;
      const windowStart = card.querySelector(".pub-start").value || null;
      const windowTimezone = card.querySelector(".pub-tz").value.trim() || "UTC";
      const out = card.querySelector(".publish-output");
      out.classList.remove("hidden");
      out.textContent = "Running…";
      try {
        const opts = { dry_run: dryRun, days, window_timezone: windowTimezone };
        if (windowStart) opts.window_start = windowStart;
        const result = await channelAdminApi.publish(c.id, opts);
        out.textContent = `exit code: ${result.exitCode}\n\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`;
        if (result.exitCode === 0) {
          toast(dryRun ? "Publish preview complete." : "Published.", "good");
        } else {
          toast("Publish reported an error -- see output below.", "danger");
        }
      } catch (e) {
        out.textContent = e.message;
        toast(e.message, "danger");
      }
    };
    card.querySelector(".pub-preview-btn").addEventListener("click", () => runPublish(true));
    card.querySelector(".pub-run-btn").addEventListener("click", () => runPublish(false));
  }
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

customElements.define("cf-channel-admin", CfChannelAdmin);
