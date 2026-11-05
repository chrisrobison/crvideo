// cf-series-admin — episode review/approval view (phase 6, admin UI).
//
// Lists every series/*/series.json (scanned server-side by
// server/series-admin.php -- this component never hardcodes series ids),
// lets an editor change an episode's editorial status and content rights,
// and can trigger a youtube-import.php refresh or a brand-new import.
//
// No access control: see docs/admin-ui.md. Anyone who can load this page
// can approve/reject episodes and trigger real API calls from here.

import { baseComponentCSS, escapeHtml, fmtHMS, toast } from "../utils.js";
import { seriesAdminApi } from "../admin-api.js";

const STATUS_VALUES = ["candidate", "approved", "rejected", "disabled"];
const RIGHTS_VALUES = ["unverified", "creator_permission", "licensed", "public_domain", "restricted"];
const STATUS_TONE = { candidate: "warn", approved: "graphic", rejected: "live", disabled: "audio" };

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

class CfSeriesAdmin extends HTMLElement {
  constructor() {
    super();
    this._series = [];
    this._loading = true;
    this._error = null;
    this._busy = new Set(); // series ids currently running a subprocess action
    this._output = new Map(); // series id -> last CLI output text
    this._importOutput = null;
    this._importOpen = false;
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
      this._series = await seriesAdminApi.list();
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
        .import-form{ background:var(--panel); border:1px solid var(--border); border-radius:var(--radius);
          padding:16px; margin-bottom:16px; display:grid; grid-template-columns:repeat(4,1fr); gap:12px; align-items:end; }
        .import-form .wide{ grid-column:1 / -1; }
        .import-form .actions{ grid-column:1 / -1; display:flex; gap:8px; }
        .series-card{ background:var(--panel); border:1px solid var(--border); border-radius:var(--radius);
          margin-bottom:12px; overflow:hidden; }
        .series-card summary{ list-style:none; cursor:pointer; display:flex; align-items:center; gap:12px;
          padding:14px 16px; }
        .series-card summary::-webkit-details-marker{ display:none; }
        .series-card[open] summary{ border-bottom:1px solid var(--border); }
        .series-thumb{ width:64px; height:36px; border-radius:6px; object-fit:cover; background:var(--panel-3); flex-shrink:0; }
        .series-title{ font-weight:800; font-size:14px; }
        .series-card .spacer{ flex:1; }
        .series-body{ padding:14px 16px; }
        .series-actions{ display:flex; align-items:center; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
        table{ width:100%; border-collapse:collapse; }
        th{ text-align:left; padding:6px 8px; font-size:11px; text-transform:uppercase; letter-spacing:.04em;
          color:var(--text-muted); border-bottom:1px solid var(--border); }
        td{ padding:8px; border-bottom:1px solid var(--border-soft); font-size:12px; vertical-align:top; }
        .ep-thumb{ width:84px; height:47px; border-radius:6px; object-fit:cover; background:var(--panel-3); }
        .ep-title{ font-weight:700; font-size:13px; margin-bottom:3px; max-width:320px; }
        select, input.notes{ font-size:12px; padding:5px 6px; }
        .notes{ min-width:140px; }
        .row-actions{ display:flex; gap:6px; }
        pre.output{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm);
          padding:10px; font:11px/1.5 var(--mono); white-space:pre-wrap; word-break:break-word; max-height:260px;
          overflow:auto; margin-top:10px; }
        .empty{ padding:40px; text-align:center; color:var(--text-muted); }
        .error{ color:#ffb4b4; padding:12px 16px; background:var(--live-soft); border-radius:var(--radius-sm); margin-bottom:12px; }
      </style>
      <div class="toolbar">
        <h1>Series &amp; episode review</h1>
        <button class="reload-btn ghost">Reload</button>
        <button class="toggle-import-btn primary">+ Import new series…</button>
      </div>
      <div class="import-form hidden"></div>
      <div class="body"></div>
    `;
    this.shadowRoot.querySelector(".reload-btn").addEventListener("click", () => this.reload());
    this.shadowRoot.querySelector(".toggle-import-btn").addEventListener("click", () => {
      this._importOpen = !this._importOpen;
      this._renderImportForm();
    });
  }

  _renderImportForm() {
    const root = this.shadowRoot;
    const form = root.querySelector(".import-form");
    form.classList.toggle("hidden", !this._importOpen);
    if (!this._importOpen) return;
    form.innerHTML = `
      <label class="field">New series id<div class="field-value"><input class="new-id" placeholder="e.g. my-new-show"></div></label>
      <label class="field">Source kind<div class="field-value">
        <select class="source-kind"><option value="channel">Channel @handle</option><option value="channel_id">Channel UC… id</option><option value="playlist">Playlist id</option></select>
      </div></label>
      <label class="field wide">Source value<div class="field-value"><input class="source-value" placeholder="@SomeChannel"></div></label>
      <label class="field">Title override (optional)<div class="field-value"><input class="title-override"></div></label>
      <div class="actions">
        <button class="preview-import-btn">Preview (dry run)</button>
        <button class="run-import-btn primary">Import for real</button>
        <span class="muted">Needs YOUTUBE_API_KEY (or youtube-import/config.local.php) configured for the web server process.</span>
      </div>
      <pre class="import-output hidden wide"></pre>
    `;
    const run = async (dryRun) => {
      const newId = form.querySelector(".new-id").value.trim();
      const kind = form.querySelector(".source-kind").value;
      const value = form.querySelector(".source-value").value.trim();
      const title = form.querySelector(".title-override").value.trim();
      if (!newId || !value) { toast("Series id and source value are required.", "danger"); return; }
      const payload = { series_id: newId, dry_run: dryRun, [kind]: value };
      if (title) payload.title = title;
      const out = form.querySelector(".import-output");
      out.classList.remove("hidden");
      out.textContent = "Running…";
      try {
        const result = await seriesAdminApi.newImport(payload);
        out.textContent = `exit code: ${result.exitCode}\n\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`;
        if (result.exitCode === 0) {
          toast(dryRun ? "Preview succeeded -- nothing written yet." : "Import complete.", "good");
          if (!dryRun) this.reload();
        } else {
          toast("Import reported an error -- see output below.", "danger");
        }
      } catch (e) {
        out.textContent = e.message;
        toast(e.message, "danger");
      }
    };
    form.querySelector(".preview-import-btn").addEventListener("click", () => run(true));
    form.querySelector(".run-import-btn").addEventListener("click", () => run(false));
  }

  _renderBody() {
    const root = this.shadowRoot;
    const body = root.querySelector(".body");

    if (this._loading) {
      body.innerHTML = `<div class="empty">Loading…</div>`;
      return;
    }
    if (this._error) {
      body.innerHTML = `<div class="error">Could not load series: ${escapeHtml(this._error)}</div>`;
      return;
    }
    if (!this._series.length) {
      body.innerHTML = `<div class="empty">No series found under series/*/series.json yet.</div>`;
      return;
    }

    body.innerHTML = this._series.map((s) => this._seriesCardHtml(s)).join("");

    for (const s of this._series) {
      const card = body.querySelector(`details[data-series="${cssEscape(s.id)}"]`);
      if (!card) continue;
      this._wireSeriesCard(card, s);
    }
  }

  _seriesCardHtml(s) {
    const out = this._output.get(s.id);
    return `
      <details class="series-card" data-series="${escapeHtml(s.id)}">
        <summary>
          ${s.thumbnail_url ? `<img class="series-thumb" src="${escapeHtml(s.thumbnail_url)}" alt="">` : `<div class="series-thumb"></div>`}
          <span class="series-title">${escapeHtml(s.title)}</span>
          <span class="muted">${s.episode_count} episode${s.episode_count === 1 ? "" : "s"}</span>
          <span class="badge">${escapeHtml(s.source?.provider || "unknown")}</span>
          <span class="spacer"></span>
        </summary>
        <div class="series-body">
          <div class="series-actions">
            ${s.source?.channel_url ? `<a href="${escapeHtml(s.source.channel_url)}" target="_blank" rel="noopener">Source channel ↗</a>` : ""}
            <button class="preview-refresh-btn" ${this._busy.has(s.id) ? "disabled" : ""}>Preview refresh</button>
            <button class="run-refresh-btn" ${this._busy.has(s.id) ? "disabled" : ""}>Run refresh</button>
          </div>
          <table>
            <thead><tr><th>Episode</th><th>Status</th><th>Rights</th><th>Notes</th><th></th></tr></thead>
            <tbody>${s.episodes.map((ep) => this._episodeRowHtml(s.id, ep)).join("")}</tbody>
          </table>
          ${out ? `<pre class="output">${escapeHtml(out)}</pre>` : ""}
        </div>
      </details>
    `;
  }

  _episodeRowHtml(seriesId, ep) {
    return `
      <tr data-episode="${escapeHtml(ep.id)}">
        <td>
          <div class="row" style="gap:8px;">
            ${ep.thumbnail_url ? `<img class="ep-thumb" src="${escapeHtml(ep.thumbnail_url)}" alt="">` : ""}
            <div>
              <div class="ep-title">${escapeHtml(ep.title)}</div>
              <div class="muted">${ep.duration ? fmtHMS(ep.duration) : "unknown length"} · ${fmtDate(ep.published_at)}
                ${ep.source?.url ? ` · <a href="${escapeHtml(ep.source.url)}" target="_blank" rel="noopener">source ↗</a>` : ""}
                ${ep.source?.availability && ep.source.availability !== "available" ? ` · <span class="badge" data-tone="warn">${escapeHtml(ep.source.availability)}</span>` : ""}
              </div>
            </div>
          </div>
        </td>
        <td>
          <select class="status-select">
            ${STATUS_VALUES.map((v) => `<option value="${v}" ${v === ep.status ? "selected" : ""}>${v}</option>`).join("")}
          </select>
        </td>
        <td>
          <select class="rights-select">
            ${RIGHTS_VALUES.map((v) => `<option value="${v}" ${v === ep.rights.status ? "selected" : ""}>${v}</option>`).join("")}
          </select>
        </td>
        <td><input class="notes" value="${escapeHtml(ep.rights.notes || "")}"></td>
        <td><button class="save-episode-btn primary">Save</button></td>
      </tr>
    `;
  }

  _wireSeriesCard(card, s) {
    card.querySelector(".preview-refresh-btn")?.addEventListener("click", () => this._runRefresh(card, s.id, true));
    card.querySelector(".run-refresh-btn")?.addEventListener("click", () => this._runRefresh(card, s.id, false));
    card.querySelectorAll("tr[data-episode]").forEach((row) => {
      const episodeId = row.dataset.episode;
      row.querySelector(".save-episode-btn").addEventListener("click", async () => {
        const status = row.querySelector(".status-select").value;
        const rightsStatus = row.querySelector(".rights-select").value;
        const notes = row.querySelector(".notes").value.trim() || null;
        try {
          await seriesAdminApi.saveEpisode({ series_id: s.id, episode_id: episodeId, status, rights_status: rightsStatus, rights_notes: notes });
          toast(`Saved ${episodeId}.`, "good");
          const ep = s.episodes.find((e) => e.id === episodeId);
          if (ep) { ep.status = status; ep.rights = { status: rightsStatus, notes }; }
        } catch (e) {
          toast(e.message, "danger");
        }
      });
    });
  }

  async _runRefresh(card, seriesId, dryRun) {
    this._busy.add(seriesId);
    card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      const result = await seriesAdminApi.refresh(seriesId, dryRun);
      this._output.set(seriesId, `exit code: ${result.exitCode}\n\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`);
      if (result.exitCode === 0) {
        toast(dryRun ? "Refresh preview complete." : "Refresh complete.", "good");
      } else {
        toast("Refresh reported an error -- see output below.", "danger");
      }
    } catch (e) {
      this._output.set(seriesId, e.message);
      toast(e.message, "danger");
    }
    this._busy.delete(seriesId);
    if (!dryRun) {
      await this.reload();
    } else {
      this._renderBody();
    }
  }
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

customElements.define("cf-series-admin", CfSeriesAdmin);
