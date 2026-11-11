// cf-channel-admin — channel/catalog/programming management view
// (phase 6, admin UI), plus the AI continuity announcer's own admin
// section (Pass 2 of channels/announcer/README.md).
//
// Lists every channels/*/meta.json (scanned server-side by
// server/channel-admin.php -- this component never hardcodes channel
// ids), lets an editor edit which series a channel's catalog.json
// references and edit/add/remove programming.json's recurring blocks,
// and can preview (--dry-run) or run channels/publish.php.
//
// The "Continuity announcer" section (server/announcer-admin.php) is a
// separate, independently-loaded concern bolted onto the same per-channel
// card: it edits channels/<id>/announcer.json (voice, style/tone, which
// announcement types, writer/TTS provider), lists/plays/regenerates the
// channel's current channels/<id>/announcements.json entries, and can
// preview a Kokoro voice or enqueue the backlog of missing announcements.
// A failure loading or saving announcer data never blocks the catalog/
// programming sections above it -- the two concerns are fetched and
// rendered independently.
//
// No access control: see docs/admin-ui.md. Anyone who can load this page
// can change channel programming and announcer config and trigger a real
// publish or a real `claude`+Kokoro generation run from here.

import { baseComponentCSS, escapeHtml, toast } from "../utils.js";
import { channelAdminApi, seriesAdminApi, announcerAdminApi } from "../admin-api.js";
import { TOPICS, subscribe } from "../../../js/bus.js";

const FREQUENCIES = ["daily", "weekly", "monthly"];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const PACKING_MODES = ["sequential", "best_fit", "hybrid"];
const ON_UNFIT_POLICIES = ["defer", "skip_for_block", "allow_overrun"];
const BOUNDARY_MODES = ["hard", "soft", "elastic"];

const ANNOUNCEMENT_TYPES = ["coming_up_next", "now_showing", "still_ahead", "channel_id", "lineup_preview", "return_from_break"];
const SUPPRESS_MODES = ["short", "suppress", "normal"];
const WRITER_PROVIDERS = ["claude-cli", "template", "mock"];

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

// ---------- Continuity announcer section ----------

const DEFAULT_ANNOUNCER_CONFIG = {
  enabled: false,
  voice: "af_heart",
  speed: 1.0,
  language: "en-us",
  style: "Clear, friendly broadcast announcer",
  tone: "Neutral, warm, professional",
  targetDuration: 12,
  types: ["coming_up_next"],
  consecutiveSameSeries: "short",
  writer: { provider: "claude-cli", model: "sonnet" },
  tts: { provider: "kokoro-http", endpoint: "http://127.0.0.1:8178" },
};

function announcerRowHtml(entry) {
  const statusPill = entry.status === "ready" ? "" : " muted";
  return `
    <div class="an-row" data-transition="${escapeHtml(entry.transitionId || "")}" data-hash="${escapeHtml(entry.scriptHash || "")}">
      <div class="an-row-top">
        <span class="pill${statusPill}">${escapeHtml(entry.type || "")}</span>
        <span class="muted">${escapeHtml(entry.transitionId || "")}</span>
        <span class="muted">${entry.duration ? `${Number(entry.duration).toFixed(1)}s` : ""}</span>
        <span class="muted">${escapeHtml(entry.status || "unknown")}</span>
        <span class="spacer"></span>
        <button class="an-edit-btn ghost" data-hash="${escapeHtml(entry.scriptHash || "")}">Edit</button>
        <button class="an-regen-btn ghost" data-transition="${escapeHtml(entry.transitionId || "")}">Regenerate</button>
      </div>
      <div class="an-row-text">${escapeHtml(entry.text || "")}</div>
      ${entry.audio ? `<audio controls preload="none" src="${escapeHtml(entry.audio)}"></audio>` : `<span class="muted">No audio yet.</span>`}
    </div>
  `;
}

function announcerSectionHtml(channelId, announcer) {
  const hasJson = !!announcer?.hasAnnouncerJson;
  const cfg = { ...DEFAULT_ANNOUNCER_CONFIG, ...(announcer?.config || {}) };
  const writer = { ...DEFAULT_ANNOUNCER_CONFIG.writer, ...(cfg.writer || {}) };
  const types = Array.isArray(cfg.types) && cfg.types.length ? cfg.types : DEFAULT_ANNOUNCER_CONFIG.types;
  const announcements = Array.isArray(announcer?.announcements) ? announcer.announcements : [];
  const queue = announcer?.queue || { pending: 0, running: 0, done: 0, error: 0 };
  const queueBusy = queue.pending > 0 || queue.running > 0;

  return `
    <section class="announcer-section" data-channel="${escapeHtml(channelId)}">
      <h2>Continuity announcer</h2>
      ${!hasJson ? `<p class="hint-note">Not configured yet for this channel -- nothing is generated until you save a config below (the single opt-in gate).</p>` : ""}
      <div class="block-grid">
        <label class="field"><div class="field-value"><label class="loop-label"><input type="checkbox" class="an-enabled" ${cfg.enabled ? "checked" : ""}> Enabled</label></div></label>
        <label class="field">Voice<div class="field-value"><input class="an-voice" value="${escapeHtml(cfg.voice)}" list="an-voices-${escapeHtml(channelId)}"><datalist id="an-voices-${escapeHtml(channelId)}"></datalist></div></label>
        <label class="field">Speed<div class="field-value"><input class="an-speed" type="number" step="0.1" min="0.5" max="2.0" value="${cfg.speed}"></div></label>
        <label class="field">Language<div class="field-value"><input class="an-language" value="${escapeHtml(cfg.language)}"></div></label>
        <label class="field">Target duration (s)<div class="field-value"><input class="an-duration" type="number" min="5" max="60" value="${cfg.targetDuration}"></div></label>
        <label class="field">Consecutive same-series<div class="field-value"><select class="an-suppress">
          ${SUPPRESS_MODES.map((m) => `<option value="${m}" ${m === cfg.consecutiveSameSeries ? "selected" : ""}>${m}</option>`).join("")}
        </select></div></label>
        <label class="field">Writer provider<div class="field-value"><select class="an-writer-provider">
          ${WRITER_PROVIDERS.map((p) => `<option value="${p}" ${p === writer.provider ? "selected" : ""}>${p}</option>`).join("")}
        </select></div></label>
        <label class="field">Writer model<div class="field-value"><input class="an-writer-model" value="${escapeHtml(writer.model || "")}"></div></label>
      </div>
      <label class="field">Style<div class="field-value"><input class="an-style" value="${escapeHtml(cfg.style)}"></div></label>
      <label class="field">Tone<div class="field-value"><input class="an-tone" value="${escapeHtml(cfg.tone)}"></div></label>
      <div class="field">Announcement types<div class="field-value">
        <div class="series-checklist">
          ${ANNOUNCEMENT_TYPES.map((t) => `
            <label class="series-check"><input type="checkbox" class="an-type-input" value="${t}" ${types.includes(t) ? "checked" : ""}> ${t}</label>
          `).join("")}
        </div>
      </div></div>
      <div class="row an-toolbar" style="gap:8px; flex-wrap:wrap; align-items:center;">
        <button class="an-voices-btn ghost">Load voices from Kokoro</button>
        <button class="an-preview-btn ghost">Preview voice</button>
        <button class="an-save-btn primary">Save announcer config</button>
        <button class="an-generate-btn" ${hasJson ? "" : "disabled"}>Generate missing (queue)</button>
        <span class="pill ${queueBusy ? "" : "muted"}">queue: ${queue.pending} pending · ${queue.running} running · ${queue.error} error</span>
      </div>
      <audio class="an-preview-audio" controls hidden></audio>
      <pre class="an-output hidden"></pre>

      <h2 style="margin-top:16px;">Announcements (${announcements.length})</h2>
      <div class="an-list">
        ${announcements.map(announcerRowHtml).join("") || `<span class="muted">No announcements generated yet.</span>`}
      </div>
    </section>
  `;
}

class CfChannelAdmin extends HTMLElement {
  constructor() {
    super();
    this._channels = [];
    this._allSeriesIds = [];
    this._loading = true;
    this._error = null;
    // Keyed by channel id -- fetched independently of _channels (a
    // failure here never blocks the catalog/programming sections above
    // it; see this file's header).
    this._announcer = new Map();
    this._announcerError = null;
  }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._render();
    }
    // Explorer hand-off: reveal a channel (and programming block). Pure
    // navigation -- opens a <details> and scrolls; never edits anything.
    subscribe(TOPICS.PROGRAMMING_CHANNEL_OPEN, ({ data }) => {
      if (typeof data?.channelId !== "string") return;
      this._pendingFocus = { channelId: data.channelId, blockId: typeof data.blockId === "string" ? data.blockId : null };
      this._applyFocus();
    });
    this.reload();
  }

  _applyFocus() {
    const f = this._pendingFocus;
    const body = this.shadowRoot?.querySelector(".body");
    if (!f || !body) return;
    const card = body.querySelector(`details[data-channel="${cssEscape(f.channelId)}"]`);
    if (!card) return;
    this._pendingFocus = null;
    card.open = true;
    const row = f.blockId ? [...card.querySelectorAll(".block-row")].find((r) => (r.dataset.block || r.querySelector(".b-id")?.value) === f.blockId) : null;
    (row || card).scrollIntoView({ block: "start", behavior: "smooth" });
    (row || card).animate?.([{ outline: "2px solid var(--accent)" }, { outline: "2px solid transparent" }], { duration: 1800 });
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
    this._reloadAnnouncer();
  }

  async _reloadAnnouncer() {
    this._announcerError = null;
    try {
      const list = await announcerAdminApi.list();
      this._announcer = new Map(list.map((a) => [a.id, a]));
    } catch (e) {
      this._announcerError = e.message;
    }
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
        .announcer-section .an-output{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm);
          padding:10px; font:11px/1.5 var(--mono); white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; margin-top:10px; }
        .an-preview-audio{ margin-top:8px; display:block; width:100%; max-width:360px; }
        .an-list{ display:flex; flex-direction:column; gap:8px; margin-top:8px; }
        .an-row{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px 12px; }
        .an-row-top{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .an-row-top .spacer{ flex:1; }
        .an-row-text{ font-size:13px; margin:8px 0; line-height:1.4; }
        .an-row-text textarea{ width:100%; box-sizing:border-box; font:inherit; min-height:60px; }
        .an-row audio{ width:100%; max-width:420px; display:block; }
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
    this._applyFocus();
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

          ${this._announcerError && !this._announcer.has(c.id) ? `<div class="error">Could not load continuity announcer data: ${escapeHtml(this._announcerError)}</div>` : announcerSectionHtml(c.id, this._announcer.get(c.id))}
        </div>
      </details>
    `;
  }

  _wireChannelCard(card, c) {
    card.querySelectorAll(".block-row").forEach(wireBlockRow);
    const announcerSection = card.querySelector(".announcer-section");
    if (announcerSection) this._wireAnnouncerSection(announcerSection, c);

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

  _readAnnouncerConfig(section) {
    const q = (sel) => section.querySelector(sel);
    const types = Array.from(section.querySelectorAll(".an-type-input:checked")).map((i) => i.value);
    return {
      enabled: q(".an-enabled").checked,
      voice: q(".an-voice").value.trim(),
      speed: Number(q(".an-speed").value) || 1.0,
      language: q(".an-language").value.trim(),
      style: q(".an-style").value,
      tone: q(".an-tone").value,
      targetDuration: Number(q(".an-duration").value) || 12,
      types,
      consecutiveSameSeries: q(".an-suppress").value,
      writer: { provider: q(".an-writer-provider").value, model: q(".an-writer-model").value.trim() || "sonnet" },
      // Deliberately no `tts` key here -- it's a deployment-level setting
      // (which Kokoro server/provider), not edited from this UI; omitting
      // it tells server/announcer-admin.php to leave whatever this
      // channel's announcer.json already has for it completely untouched
      // (see that file's save_config/announcer_admin_normalize_config()).
    };
  }

  _wireAnnouncerSection(section, c) {
    const channelId = c.id;
    const output = section.querySelector(".an-output");
    const showOutput = (text) => {
      output.classList.remove("hidden");
      output.textContent = text;
    };

    section.querySelector(".an-save-btn").addEventListener("click", async () => {
      try {
        const config = this._readAnnouncerConfig(section);
        await announcerAdminApi.saveConfig(channelId, config);
        toast(`Saved continuity announcer config for ${channelId}.`, "good");
        this._reloadAnnouncer();
      } catch (e) {
        toast(e.message, "danger");
      }
    });

    section.querySelector(".an-voices-btn").addEventListener("click", async () => {
      try {
        const { voices, error } = await announcerAdminApi.voices(channelId);
        const datalist = section.querySelector(`#an-voices-${cssEscape(channelId)}`) || section.querySelector("datalist");
        datalist.innerHTML = voices.map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
        if (voices.length) toast(`Loaded ${voices.length} voice(s) from Kokoro.`, "good");
        else toast(error ? `Could not reach Kokoro: ${error}` : "Kokoro reported no voices.", "danger");
      } catch (e) {
        toast(e.message, "danger");
      }
    });

    section.querySelector(".an-preview-btn").addEventListener("click", async () => {
      const voice = section.querySelector(".an-voice").value.trim();
      if (!voice) { toast("Enter a voice first.", "danger"); return; }
      try {
        const { url } = await announcerAdminApi.previewVoice(channelId, voice);
        const audio = section.querySelector(".an-preview-audio");
        audio.hidden = false;
        audio.src = url;
        audio.play?.().catch(() => { /* autoplay refused -- the visible controls still let the editor hit play */ });
      } catch (e) {
        toast(e.message, "danger");
      }
    });

    section.querySelector(".an-generate-btn").addEventListener("click", async () => {
      showOutput("Enqueuing…");
      try {
        const result = await announcerAdminApi.generateQueue(channelId);
        showOutput(`exit code: ${result.exitCode}\n\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`);
        toast("Missing announcements enqueued -- run announce-worker.php to process them.", "good");
      } catch (e) {
        showOutput(e.message);
        toast(e.message, "danger");
      }
    });

    section.querySelectorAll(".an-regen-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const transitionId = btn.dataset.transition;
        if (!transitionId) return;
        showOutput(`Regenerating ${transitionId}…`);
        btn.disabled = true;
        try {
          const result = await announcerAdminApi.regenerate(channelId, transitionId, { force: true });
          showOutput(`exit code: ${result.exitCode}\n\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`);
          toast(result.exitCode === 0 ? `Regenerated ${transitionId}.` : `Regeneration reported an error for ${transitionId}.`, result.exitCode === 0 ? "good" : "danger");
          this._reloadAnnouncer();
        } catch (e) {
          showOutput(e.message);
          toast(e.message, "danger");
        } finally {
          btn.disabled = false;
        }
      });
    });

    section.querySelectorAll(".an-edit-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".an-row");
        const textEl = row.querySelector(".an-row-text");
        const hash = btn.dataset.hash;
        if (!hash) { toast("This entry has no script hash to approve against.", "danger"); return; }
        if (row.querySelector(".an-edit-save")) return; // already editing
        const original = textEl.textContent;
        textEl.innerHTML = `<textarea class="an-edit-input">${escapeHtml(original)}</textarea>`;
        btn.textContent = "Cancel";
        const saveBtn = document.createElement("button");
        saveBtn.className = "an-edit-save ghost";
        saveBtn.textContent = "Approve";
        btn.after(saveBtn);

        const cancel = () => {
          textEl.textContent = original;
          btn.textContent = "Edit";
          saveBtn.remove();
          btn.removeEventListener("click", cancelHandler);
        };
        const cancelHandler = () => cancel();
        btn.addEventListener("click", cancelHandler, { once: true });

        saveBtn.addEventListener("click", async () => {
          const text = row.querySelector(".an-edit-input").value.trim();
          if (!text) { toast("Text cannot be empty.", "danger"); return; }
          try {
            await announcerAdminApi.approveScript(channelId, hash, text);
            toast("Approved -- this wording will not be overwritten by routine regeneration.", "good");
            this._reloadAnnouncer();
          } catch (e) {
            toast(e.message, "danger");
          }
        });
      });
    });
  }
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

customElements.define("cf-channel-admin", CfChannelAdmin);
