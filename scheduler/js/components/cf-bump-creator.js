// cf-bump-creator — the "Bumps" admin view (see bumps/README.md).
//
// Lists every bumps/*.json (server/bump-admin.php), lets an editor build
// one from what actually exists under media/ (a real video, 0-2 real
// background-audio files, an optional already-rendered announcement clip
// from a channel's own announcements.json) and a few presentation knobs
// (how many upcoming shows to list, the eyebrow label, accent colors),
// and previews it LIVE with <cr-bump> (channels/bump-player.js) -- either
// against hand-typed sample rows or a real channel's real current lineup,
// read straight from channels/broadcast.js (read-only; this view never
// writes anything into a channel).
//
// A bottom "Scheduling" panel is a SEPARATE concern: which channel(s)
// actually show a bump live, and when (clock-anchored -- "every hour, on
// the hour, for 12s" -- see channels/player-adapters.js's "bump
// scheduling" header for why this is driven by the player's own wall
// clock rather than published into any schedule.json). Saved to each
// channel's own channels/<id>/bump-schedule.json via the same
// server/bump-admin.php endpoint's save_schedule/schedules actions.
//
// No access control: see docs/admin-ui.md. Anyone who can load this page
// can create/edit/delete any bump and change what any channel schedules.

import { baseComponentCSS, escapeHtml, toast } from "../utils.js";
import { bumpAdminApi } from "../admin-api.js";
import "../../../channels/bump-player.js";

const BG_TYPES = ["video", "color"]; // "image" exists in the schema/backend for later; nothing under media/ to pick from yet, so it's not offered here
const AUDIO_SOURCES = ["music", "ambience"];
const SCHEDULE_PERIODS = { hour: "Every hour", halfHour: "Every half hour", day: "Every day" };

function emptyBump() {
  return {
    name: "",
    description: "",
    background: { type: "video", url: "" },
    audio: [],
    announcement: null,
    upcoming: { count: 3, label: "Coming Up" },
    style: {},
  };
}

function audioOptionsHtml(media, selectedUrl) {
  const groups = [
    { label: "Music", items: media.music },
    { label: "Ambience", items: media.ambience },
  ];
  return groups.map((g) => `
    <optgroup label="${escapeHtml(g.label)}">
      ${g.items.map((f) => `<option value="${escapeHtml(f.url)}" ${f.url === selectedUrl ? "selected" : ""}>${escapeHtml(f.name)}</option>`).join("")}
    </optgroup>
  `).join("");
}

function sourceForUrl(media, url) {
  if (media.music.some((f) => f.url === url)) return "music";
  if (media.ambience.some((f) => f.url === url)) return "ambience";
  return "custom";
}

function audioLayerRowHtml(layer, media) {
  return `
    <div class="audio-row">
      <select class="al-url">
        <option value="">— choose a track —</option>
        ${audioOptionsHtml(media, layer.url || "")}
      </select>
      <label class="al-volume-label">Vol
        <input class="al-volume" type="range" min="0" max="1" step="0.05" value="${Number(layer.volume ?? 0.6)}">
      </label>
      <button class="al-remove ghost icon-btn" title="Remove layer">✕</button>
    </div>
  `;
}

function readAudioLayerRow(row, media) {
  const url = row.querySelector(".al-url").value;
  if (!url) return null;
  return { source: sourceForUrl(media, url), url, volume: Number(row.querySelector(".al-volume").value) || 0.6 };
}

function announcementChannelOptionsHtml(media, selectedId) {
  return `<option value="">— no announcement —</option>` + media.channels
    .filter((c) => c.announcements.length)
    .map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === selectedId ? "selected" : ""}>${escapeHtml(c.name)} (${c.announcements.length})</option>`)
    .join("");
}

function announcementClipOptionsHtml(channel, selectedTransitionId) {
  if (!channel) return "";
  return channel.announcements.map((a) => `
    <option value="${escapeHtml(a.transitionId || "")}" ${a.transitionId === selectedTransitionId ? "selected" : ""}>
      ${escapeHtml(a.type || "")} — ${escapeHtml(a.text)}
    </option>
  `).join("");
}

function bumpRowHtml(bump, isActive) {
  return `
    <div class="bump-row ${isActive ? "active" : ""}" data-id="${escapeHtml(bump.id)}">
      <div class="bump-row-main">
        <div class="bump-row-name">${escapeHtml(bump.name || bump.id)}</div>
        <div class="bump-row-meta">
          <span class="badge" data-tone="${bump.background?.type === "video" ? "video" : "graphic"}">${escapeHtml(bump.background?.type || "—")}</span>
          ${bump.announcement ? `<span class="badge" data-tone="audio">voice</span>` : ""}
        </div>
      </div>
      <button class="bump-delete-btn ghost icon-btn" title="Delete">✕</button>
    </div>
  `;
}

function scheduleRuleRowHtml(rule, bumps) {
  return `
    <div class="sched-rule-row">
      <select class="sr-bump">
        <option value="">— choose a bump —</option>
        ${bumps.map((b) => `<option value="${escapeHtml(b.id)}" ${b.id === rule.bumpId ? "selected" : ""}>${escapeHtml(b.name || b.id)}</option>`).join("")}
      </select>
      <select class="sr-every">
        ${Object.entries(SCHEDULE_PERIODS).map(([k, label]) => `<option value="${k}" ${k === rule.every ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
      </select>
      <label class="sr-field">Offset (s)<input class="sr-offset" type="number" min="0" value="${rule.offsetSeconds ?? 0}"></label>
      <label class="sr-field">Duration (s)<input class="sr-duration" type="number" min="1" value="${rule.durationSeconds ?? 12}"></label>
      <button class="sr-remove ghost icon-btn" title="Remove rule">✕</button>
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
  return `
    <details class="sched-channel" data-channel="${escapeHtml(channel.id)}" ${channel.enabled && channel.rules.length ? "open" : ""}>
      <summary>
        <span class="sched-channel-name">${escapeHtml(channel.name)}</span>
        <span class="badge ${channel.enabled && channel.rules.length ? "" : "muted"}" data-tone="${channel.enabled && channel.rules.length ? "live" : ""}">
          ${channel.enabled && channel.rules.length ? `${channel.rules.length} rule${channel.rules.length === 1 ? "" : "s"} live` : "off"}
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
        ${!bumps.length ? `<p class="hint-note">Build at least one bump above before scheduling it.</p>` : ""}
      </div>
    </details>
  `;
}

const SAMPLE_UPCOMING = [
  { title: "Sample Show One", startsAt: Math.floor(Date.now() / 1000) + 5 * 60 },
  { title: "Sample Show Two", startsAt: Math.floor(Date.now() / 1000) + 35 * 60 },
  { title: "Sample Show Three", startsAt: Math.floor(Date.now() / 1000) + 65 * 60 },
];

class CfBumpCreator extends HTMLElement {
  constructor() {
    super();
    this._bumps = [];
    this._media = { video: [], music: [], ambience: [], channels: [] };
    this._schedules = [];
    this._loading = true;
    this._error = null;
    this._editingId = null; // null => unsaved new bump
    this._draft = emptyBump();
    this._previewMode = "sample"; // "sample" | a channel id
    this._broadcastModule = null; // lazily imported -- see _previewWithChannel()
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
      const [bumps, media, schedules] = await Promise.all([bumpAdminApi.list(), bumpAdminApi.media(), bumpAdminApi.schedules()]);
      this._bumps = bumps;
      this._media = media;
      this._schedules = schedules;
    } catch (e) {
      this._error = e.message;
    }
    this._loading = false;
    this._renderBody();
  }

  _selectBump(id) {
    const bump = this._bumps.find((b) => b.id === id);
    if (!bump) return;
    this._editingId = id;
    this._draft = {
      name: bump.name || "",
      description: bump.description || "",
      background: bump.background || { type: "video", url: "" },
      audio: Array.isArray(bump.audio) ? bump.audio : [],
      announcement: bump.announcement || null,
      upcoming: bump.upcoming || { count: 3, label: "Coming Up" },
      style: bump.style || {},
    };
    this._renderBody();
  }

  _newBump() {
    this._editingId = null;
    this._draft = emptyBump();
    this._renderBody();
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        :host{ display:block; }
        .toolbar{ display:flex; align-items:center; gap:10px; margin-bottom:14px; }
        .toolbar h1{ font-size:16px; margin:0; flex:1; }
        .layout{ display:grid; grid-template-columns: 260px minmax(0,1fr) 360px; gap:16px; align-items:start; }
        @media (max-width:1300px){ .layout{ grid-template-columns: 1fr; } }
        .panel{ background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:14px; }
        .bump-list{ display:flex; flex-direction:column; gap:6px; max-height:70vh; overflow-y:auto; }
        .bump-row{ display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:var(--radius-sm);
          background:var(--bg-elevated); border:1px solid var(--border); cursor:pointer; }
        .bump-row:hover{ border-color:#48536a; }
        .bump-row.active{ border-color:var(--accent); background:var(--panel-2); }
        .bump-row-main{ flex:1; min-width:0; }
        .bump-row-name{ font-weight:700; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .bump-row-meta{ display:flex; gap:6px; margin-top:4px; }
        .empty{ padding:30px; text-align:center; color:var(--text-muted); }
        .error{ color:#ffb4b4; padding:12px 16px; background:var(--live-soft); border-radius:var(--radius-sm); margin-bottom:12px; }
        section h2{ font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); margin:0 0 10px; }
        .editor-grid{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px 14px; }
        .editor section{ margin-bottom:18px; }
        .bg-type-row{ display:flex; gap:10px; margin-bottom:10px; }
        .bg-type-row label{ display:flex; align-items:center; gap:4px; font-size:12px; color:var(--text-muted); text-transform:none; letter-spacing:0; }
        .audio-row{ display:flex; align-items:center; gap:8px; margin-bottom:8px; }
        .audio-row select{ flex:1; }
        .al-volume-label{ display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text-muted); white-space:nowrap; }
        .al-volume{ width:90px; }
        .announce-row{ display:flex; gap:10px; margin-bottom:8px; }
        .announce-row select{ flex:1; }
        .color-row{ display:flex; gap:10px; align-items:center; }
        .color-row input[type="color"]{ width:48px; padding:2px; height:36px; }
        .stepper-row{ display:flex; gap:10px; align-items:center; }
        .stepper-row input[type="number"]{ width:80px; }
        .toolbar-row{ display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; }
        .preview-box{ position:relative; width:100%; aspect-ratio:16/9; border-radius:var(--radius-sm); overflow:hidden;
          background:#000; border:1px solid var(--border); }
        .preview-box cr-bump{ width:100%; height:100%; }
        .preview-controls{ display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
        .sample-rows{ display:flex; flex-direction:column; gap:6px; margin-top:10px; }
        .sample-rows .sample-row{ display:flex; gap:6px; }
        .sample-rows input[type="text"]{ flex:1; }
        .sample-rows input[type="time"]{ width:110px; }
        .hint-note{ font-size:11px; color:var(--text-muted); margin:6px 0 0; line-height:1.5; }
        .scheduling{ margin-top:16px; }
        .sched-channel{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm); margin-bottom:10px; overflow:hidden; }
        .sched-channel summary{ list-style:none; cursor:pointer; display:flex; align-items:center; gap:10px; padding:10px 14px; }
        .sched-channel summary::-webkit-details-marker{ display:none; }
        .sched-channel[open] summary{ border-bottom:1px solid var(--border); }
        .sched-channel-name{ font-weight:700; font-size:13px; }
        .sched-channel-body{ padding:14px; }
        .loop-label{ display:flex; align-items:center; gap:6px; font-size:13px; margin-bottom:10px; }
        .sched-rules{ display:flex; flex-direction:column; gap:8px; }
        .sched-rule-row{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .sched-rule-row select{ flex:1; min-width:140px; }
        .sr-field{ display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text-muted); text-transform:none; letter-spacing:0; white-space:nowrap; }
        .sr-field input{ width:70px; }
      </style>
      <div class="toolbar">
        <h1>Bumps</h1>
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
    if (this._error) { body.innerHTML = `<div class="error">Could not load bumps: ${escapeHtml(this._error)}</div>`; return; }

    body.innerHTML = `
      <div class="layout">
        <div class="panel">
          <button class="new-bump-btn primary" style="width:100%; margin-bottom:10px;">+ New bump</button>
          <div class="bump-list">
            ${this._bumps.map((b) => bumpRowHtml(b, b.id === this._editingId)).join("") || `<div class="hint-note">No bumps yet -- build one on the right.</div>`}
          </div>
        </div>
        <div class="panel editor"></div>
        <div class="panel preview"></div>
      </div>
      <div class="panel scheduling">
        <h2>Scheduling</h2>
        <p class="hint-note">Which channel(s) actually show a bump live, and when -- clock-anchored (e.g. "every hour, on the hour, for 12s"), independent of the schedule's own programming. See bumps/README.md.</p>
        <div class="sched-channels">
          ${this._schedules.map((c) => scheduleChannelHtml(c, this._bumps)).join("") || `<div class="hint-note">No channels found.</div>`}
        </div>
      </div>
    `;

    body.querySelector(".new-bump-btn").addEventListener("click", () => this._newBump());
    body.querySelectorAll(".bump-row").forEach((row) => {
      row.querySelector(".bump-row-main").addEventListener("click", () => this._selectBump(row.dataset.id));
      row.querySelector(".bump-delete-btn").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${row.querySelector(".bump-row-name").textContent}"?`)) return;
        try {
          await bumpAdminApi.delete(row.dataset.id);
          if (this._editingId === row.dataset.id) this._newBump();
          toast("Bump deleted.", "good");
          this.reload();
        } catch (err) {
          toast(err.message, "danger");
        }
      });
    });

    this._renderEditor(body.querySelector(".editor"));
    this._renderPreview(body.querySelector(".preview"));
    this._wireScheduling(body.querySelector(".sched-channels"));
  }

  // ---------- scheduling ----------

  _wireScheduling(el) {
    if (!el) return;
    el.querySelectorAll(".sched-channel").forEach((channelEl) => {
      const channelId = channelEl.dataset.channel;

      channelEl.querySelector(".sched-add-rule-btn").addEventListener("click", () => {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = scheduleRuleRowHtml({ every: "hour", offsetSeconds: 0, durationSeconds: 12 }, this._bumps);
        const row = wrapper.firstElementChild;
        channelEl.querySelector(".sched-rules").appendChild(row);
        this._wireScheduleRuleRow(row);
      });

      channelEl.querySelectorAll(".sched-rule-row").forEach((row) => this._wireScheduleRuleRow(row));

      channelEl.querySelector(".sched-save-btn").addEventListener("click", async () => {
        const enabled = channelEl.querySelector(".sched-enabled").checked;
        const rules = Array.from(channelEl.querySelectorAll(".sched-rule-row")).map(readScheduleRuleRow).filter(Boolean);
        try {
          await bumpAdminApi.saveSchedule(channelId, enabled, rules);
          toast(`Saved schedule for ${channelId}.`, "good");
          this.reload();
        } catch (err) {
          toast(err.message, "danger");
        }
      });
    });
  }

  _wireScheduleRuleRow(row) {
    row.querySelector(".sr-remove").addEventListener("click", () => row.remove());
  }

  // ---------- editor ----------

  _renderEditor(el) {
    const d = this._draft;
    const media = this._media;
    const bg = d.background || { type: "video", url: "" };
    const announcementChannel = media.channels.find((c) => c.id === d.announcement?.channelId) || null;

    el.innerHTML = `
      <h2>${this._editingId ? "Edit bump" : "New bump"}</h2>
      <section>
        <label class="field">Name<div class="field-value"><input class="d-name" value="${escapeHtml(d.name)}" placeholder="e.g. Forest Interlude"></div></label>
        <label class="field">Description (optional)<div class="field-value"><input class="d-description" value="${escapeHtml(d.description)}"></div></label>
      </section>

      <section>
        <h2>Background</h2>
        <div class="bg-type-row">
          ${BG_TYPES.map((t) => `<label><input type="radio" name="bg-type" class="bg-type-input" value="${t}" ${bg.type === t ? "checked" : ""}> ${t}</label>`).join("")}
        </div>
        <div class="bg-video-field ${bg.type === "video" ? "" : "hidden"}">
          <select class="bg-url">
            <option value="">— choose a video —</option>
            ${media.video.map((f) => `<option value="${escapeHtml(f.url)}" ${f.url === bg.url ? "selected" : ""}>${escapeHtml(f.name)}</option>`).join("")}
          </select>
          ${!media.video.length ? `<p class="hint-note">No files found under media/video/.</p>` : ""}
        </div>
        <div class="bg-color-field color-row ${bg.type === "color" ? "" : "hidden"}">
          <input type="color" class="bg-color" value="${escapeHtml(bg.color || "#0a0d14")}">
          <span class="muted">Used until a video is picked (or deliberately, for a plain-color bump).</span>
        </div>
      </section>

      <section>
        <h2>Background audio (up to 2 layers)</h2>
        <div class="audio-editor">
          ${d.audio.map((layer) => audioLayerRowHtml(layer, media)).join("")}
        </div>
        <button class="add-audio-btn ghost" ${d.audio.length >= 2 ? "disabled" : ""}>+ Add audio layer</button>
      </section>

      <section>
        <h2>Announcement (optional)</h2>
        <div class="announce-row">
          <select class="ann-channel">${announcementChannelOptionsHtml(media, d.announcement?.channelId)}</select>
          <select class="ann-clip" ${announcementChannel ? "" : "disabled"}>
            ${announcementClipOptionsHtml(announcementChannel, d.announcement?.transitionId)}
          </select>
        </div>
        <label class="field">Duck background audio to<div class="field-value">
          <input class="ann-duck" type="range" min="0" max="1" step="0.05" value="${d.announcement?.duckTo ?? 0.3}">
        </div></label>
      </section>

      <section>
        <h2>Upcoming shows</h2>
        <div class="stepper-row">
          <label class="field">How many to list<div class="field-value"><input class="up-count" type="number" min="0" max="6" value="${d.upcoming?.count ?? 3}"></div></label>
          <label class="field">Eyebrow label<div class="field-value"><input class="up-label" value="${escapeHtml(d.upcoming?.label ?? "Coming Up")}"></div></label>
        </div>
      </section>

      <section>
        <h2>Accent colors (optional)</h2>
        <div class="color-row">
          <input type="color" class="style-accent" value="${escapeHtml(d.style?.accent || "#4dd8e6")}">
          <input type="color" class="style-accent-warm" value="${escapeHtml(d.style?.accentWarm || "#ffb454")}">
        </div>
      </section>

      <div class="toolbar-row">
        <button class="save-btn primary">${this._editingId ? "Save changes" : "Create bump"}</button>
      </div>
    `;

    this._wireEditor(el);
    this._pushDraftToPreview();
  }

  _wireEditor(el) {
    const onAnyChange = () => { this._readDraftFromForm(el); this._pushDraftToPreview(); };
    el.querySelectorAll("input, select").forEach((input) => {
      input.addEventListener("input", onAnyChange);
      input.addEventListener("change", onAnyChange);
    });

    el.querySelectorAll(".bg-type-input").forEach((radio) => {
      radio.addEventListener("change", () => {
        el.querySelector(".bg-video-field").classList.toggle("hidden", radio.value !== "video" || !radio.checked);
        el.querySelector(".bg-color-field").classList.toggle("hidden", radio.value !== "color" || !radio.checked);
      });
    });

    el.querySelector(".add-audio-btn").addEventListener("click", () => {
      this._readDraftFromForm(el);
      if (this._draft.audio.length >= 2) return;
      this._draft.audio.push({ source: "music", url: "", volume: 0.6 });
      this._renderEditor(el);
    });

    el.querySelectorAll(".al-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".audio-row");
        const index = Array.from(el.querySelectorAll(".audio-row")).indexOf(row);
        this._readDraftFromForm(el);
        this._draft.audio.splice(index, 1);
        this._renderEditor(el);
      });
    });

    el.querySelector(".ann-channel").addEventListener("change", (e) => {
      const channel = this._media.channels.find((c) => c.id === e.target.value) || null;
      this._draft.announcement = channel ? { channelId: channel.id, transitionId: null, url: null, duckTo: 0.3 } : null;
      this._renderEditor(el);
    });

    el.querySelector(".save-btn").addEventListener("click", () => this._save());
  }

  /** Reads every form field back into this._draft -- called before any
   *  action that needs the FULL current draft (save, add/remove an audio
   *  row, re-rendering after a structural change) rather than keeping two
   *  sources of truth in sync field-by-field. */
  _readDraftFromForm(el) {
    const q = (sel) => el.querySelector(sel);
    const bgType = el.querySelector(".bg-type-input:checked")?.value || "video";
    const background = bgType === "color"
      ? { type: "color", color: q(".bg-color").value }
      : { type: "video", url: q(".bg-url").value };

    const audio = Array.from(el.querySelectorAll(".audio-row"))
      .map((row) => readAudioLayerRow(row, this._media))
      .filter(Boolean);

    const annChannelId = q(".ann-channel").value || null;
    const annClip = q(".ann-clip").value || null;
    const channel = this._media.channels.find((c) => c.id === annChannelId) || null;
    const clip = channel?.announcements.find((a) => a.transitionId === annClip) || null;
    const announcement = channel && clip
      ? { channelId: channel.id, transitionId: clip.transitionId, url: clip.url, duckTo: Number(q(".ann-duck").value) || 0.3 }
      : null;

    this._draft = {
      name: q(".d-name").value,
      description: q(".d-description").value,
      background,
      audio,
      announcement,
      upcoming: { count: Number(q(".up-count").value) || 0, label: q(".up-label").value || "Coming Up" },
      style: { accent: q(".style-accent").value, accentWarm: q(".style-accent-warm").value },
    };
  }

  async _save() {
    const el = this.shadowRoot.querySelector(".editor");
    this._readDraftFromForm(el);
    if (!this._draft.name.trim()) { toast("Name the bump first.", "danger"); return; }
    if (this._draft.background.type === "video" && !this._draft.background.url) {
      toast("Pick a background video (or switch to a plain color).", "danger");
      return;
    }
    try {
      const saved = this._editingId
        ? await bumpAdminApi.update(this._editingId, this._draft)
        : await bumpAdminApi.create(this._draft);
      toast(this._editingId ? "Saved." : "Bump created.", "good");
      this._editingId = saved.id;
      await this.reload();
      this._selectBump(saved.id);
    } catch (e) {
      toast(e.message, "danger");
    }
  }

  // ---------- preview ----------

  _renderPreview(el) {
    el.innerHTML = `
      <h2>Live preview</h2>
      <div class="preview-box"><cr-bump></cr-bump></div>
      <div class="preview-controls">
        <button class="preview-play-btn primary">▶ Preview (sound on)</button>
        <button class="preview-stop-btn ghost">■ Stop</button>
      </div>
      <label class="field" style="margin-top:12px;">Preview upcoming shows from<div class="field-value">
        <select class="preview-mode">
          <option value="sample">Hand-typed sample rows</option>
          ${this._media.channels.map((c) => `<option value="${escapeHtml(c.id)}" ${this._previewMode === c.id ? "selected" : ""}>${escapeHtml(c.name)} (real current lineup)</option>`).join("")}
        </select>
      </div></label>
      <div class="sample-rows ${this._previewMode === "sample" ? "" : "hidden"}">
        ${SAMPLE_UPCOMING.map((s, i) => `
          <div class="sample-row">
            <input type="text" class="sample-title" data-i="${i}" value="${escapeHtml(s.title)}">
            <input type="time" class="sample-time" data-i="${i}" value="${new Date(s.startsAt * 1000).toTimeString().slice(0, 5)}">
          </div>
        `).join("")}
      </div>
      <p class="hint-note">Preview only -- nothing here is saved, and picking a real channel never changes what that channel is actually playing.</p>
    `;

    el.querySelector(".preview-mode").value = this._previewMode;
    el.querySelector(".preview-mode").addEventListener("change", (e) => {
      this._previewMode = e.target.value;
      el.querySelector(".sample-rows").classList.toggle("hidden", this._previewMode !== "sample");
      this._pushPreviewUpcoming();
    });
    el.querySelectorAll(".sample-title, .sample-time").forEach((input) => {
      input.addEventListener("input", () => this._pushPreviewUpcoming());
    });

    el.querySelector(".preview-play-btn").addEventListener("click", () => {
      el.querySelector("cr-bump").play({ muted: false });
    });
    el.querySelector(".preview-stop-btn").addEventListener("click", () => {
      el.querySelector("cr-bump").stop();
    });

    // _renderEditor() already pushed the draft, but before this <cr-bump>
    // existed (it targeted the previous render's element) -- push again now.
    this._pushDraftToPreview();
    this._pushPreviewUpcoming();
  }

  _pushDraftToPreview() {
    const bumpEl = this.shadowRoot.querySelector(".preview cr-bump");
    if (bumpEl) bumpEl.definition = this._draft;
  }

  _readSampleUpcoming() {
    const el = this.shadowRoot.querySelector(".preview");
    const titles = el.querySelectorAll(".sample-title");
    const times = el.querySelectorAll(".sample-time");
    const now = new Date();
    return Array.from(titles).map((titleInput, i) => {
      const [h, m] = (times[i].value || "00:00").split(":").map(Number);
      const d = new Date(now);
      d.setHours(h || 0, m || 0, 0, 0);
      if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1); // a sample time earlier than now just means "tomorrow" for preview purposes
      return { title: titleInput.value || "Untitled", startsAt: Math.floor(d.getTime() / 1000) };
    }).filter((s) => s.title);
  }

  async _pushPreviewUpcoming() {
    const bumpEl = this.shadowRoot.querySelector(".preview cr-bump");
    if (!bumpEl) return;
    if (this._previewMode === "sample") {
      bumpEl.upcoming = this._readSampleUpcoming();
      bumpEl.channel = null;
      return;
    }
    try {
      const { upcoming, channel } = await this._loadRealChannelUpcoming(this._previewMode);
      bumpEl.upcoming = upcoming;
      bumpEl.channel = channel;
    } catch (e) {
      toast(`Could not load that channel's real lineup: ${e.message}`, "danger");
    }
  }

  /** Reads a real channel's REAL current/upcoming lineup, read-only --
   *  reuses channels/broadcast.js exactly as the live channel guide does
   *  (channels/index.html), never reimplementing any of its scheduling
   *  math here. Lazily imported so a page that never opens this preview
   *  mode never pays for it. */
  async _loadRealChannelUpcoming(channelId) {
    this._broadcastModule ??= await import("../../../channels/broadcast.js");
    const { loadChannel, airings, now } = this._broadcastModule;
    const channel = await loadChannel(channelId);
    const t = now();
    const upcoming = airings(channel.timeline, t, t + 12 * 3600)
      .filter((a) => a.playable && a.startsAt > t)
      .slice(0, 6)
      .map((a) => ({ title: a.title, startsAt: a.startsAt }));
    return { upcoming, channel: { name: channel.name, logo: channel.logo } };
  }
}

customElements.define("cf-bump-creator", CfBumpCreator);
