import { store } from "../store.js";
import { baseComponentCSS, escapeHtml, dateLabel, dateLabelFull, secToClock, toast } from "../utils.js";
import * as drive from "../drive.js";
import { viewState } from "../view.js";
import { TOPICS, SCHEDULER_CHANGE_TOPICS, publish, subscribe } from "../../../js/bus.js";
import "./cf-toggle.js";
import { icon } from "./ui-kit.js";

class CfHeader extends HTMLElement {
  constructor() {
    super();
    this._profile = null;
  }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._render();
      this._onDocClick = (e) => {
        if (e.composedPath().includes(this)) return;
        this.shadowRoot.querySelectorAll(".drive-menu").forEach((details) => {
          if (details.open) details.open = false;
        });
      };
    }
    this._subs = new AbortController();
    const signal = this._subs.signal;
    subscribe(TOPICS.SCHEDULER_TICK, () => this._renderClock(), { signal });
    subscribe(SCHEDULER_CHANGE_TOPICS, () => this._render(), { signal });
    subscribe(TOPICS.DRIVE_AUTH_STATE, () => { this._profile = null; this._renderDriveBody(); this._render(); }, { signal });
    subscribe(TOPICS.APP_VIEW_STATE, () => this._renderNavActive(), { signal });
    document.addEventListener("click", this._onDocClick, { signal });
    document.addEventListener("click", () => this.shadowRoot.querySelector(".settings-menu")?.classList.remove("open"), { signal });
    this._render();
  }

  disconnectedCallback() {
    this._subs?.abort();
  }

  _wire() {
    const root = this.shadowRoot;
    root.querySelector(".channel-select").addEventListener("change", (e) => store.setChannel(e.target.value));
    root.querySelector(".prev-day").addEventListener("click", () => store.shiftDate(-1));
    root.querySelector(".next-day").addEventListener("click", () => store.shiftDate(1));
    root.querySelector(".validate-btn").addEventListener("click", () => store.validate());
    root.querySelector(".publish-btn").addEventListener("click", () => store.publish());
    root.querySelector(".drive-menu").addEventListener("toggle", (e) => {
      if (e.target.open) this._renderDriveBody();
    });
    root.querySelector(".live-menu").addEventListener("toggle", (e) => {
      if (e.target.open) this._renderLiveBody();
    });
    root.addEventListener("click", (e) => {
      const a = e.target.closest("[data-view]");
      if (!a) return;
      e.preventDefault();
      root.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
      publish(TOPICS.APP_VIEW_OPEN, { view: a.dataset.view });
    });
    root.querySelector(".settings-menu > button").addEventListener("click", (e) => {
      e.stopPropagation();
      root.querySelector(".settings-menu").classList.toggle("open");
    });
  }

  _renderNavActive() {
    const view = viewState.current;
    this.shadowRoot.querySelectorAll("nav a[data-view]").forEach((a) => {
      a.classList.toggle("active", a.dataset.view === view);
    });
    // The legacy Drive scheduler's own controls (channel/date/live/validate/
    // publish/Drive) are meaningless outside that view -- the revamped
    // screens carry their own. (.hidden is baseComponentCSS's
    // `display:none!important` utility class, so it reliably beats each
    // element's own `display:flex` rule regardless of CSS source order.)
    const legacy = view === "legacy-schedule";
    this.shadowRoot.querySelector(".legacy-bar")?.classList.toggle("hidden", !legacy);
  }

  _renderLiveBody() {
    const root = this.shadowRoot;
    const body = root.querySelector(".live-body");
    body.innerHTML = `
      <p class="hint">Reads/writes the recurring <code>playlist.json</code> that
        sync-player.html and the cache downloader actually use — independent of
        the Drive folder above, acting on ${escapeHtml(store.activeChannelId)}/${escapeHtml(store.activeDate)}'s program track.</p>
      <div class="drive-folder-row">
        <span class="muted">Publish token:</span>
        <strong>${store.hasPublishToken() ? "Saved" : "Not set"}</strong>
      </div>
      <button class="load-live-btn" style="width:100%;">Load live schedule</button>
      <button class="publish-live-btn primary" style="width:100%;">Publish to live channel</button>
      <button class="change-token-btn" style="width:100%;">Change publish token…</button>
    `;
    body.querySelector(".load-live-btn").addEventListener("click", () => store.loadLiveSchedule());
    body.querySelector(".publish-live-btn").addEventListener("click", () => store.publishLiveSchedule());
    body.querySelector(".change-token-btn").addEventListener("click", () => {
      store.promptPublishToken();
      this._renderLiveBody();
    });
  }

  async _renderDriveBody() {
    const root = this.shadowRoot;
    const body = root.querySelector(".drive-body");

    if (!drive.isConfigured()) {
      body.innerHTML = `
        <p class="muted">Google Drive isn't configured yet.</p>
        <p class="hint">Add a Client ID to <code>scheduler/js/drive-config.js</code> — see GOOGLE_DRIVE_SETUP.md.</p>
      `;
      return;
    }

    if (!drive.isConnected()) {
      body.innerHTML = `<button class="connect-btn primary" style="width:100%;">Connect Google Drive</button>`;
      body.querySelector(".connect-btn").addEventListener("click", async () => {
        try { await drive.connect(); } catch (e) { toast(e.message, "danger"); }
      });
      return;
    }

    if (!this._profile) this._profile = await drive.getProfile().catch(() => null);

    body.innerHTML = `
      <div class="drive-account">${escapeHtml(this._profile?.email || "Connected")}</div>
      <div class="drive-folder-row">
        <span class="muted">Folder:</span>
        <strong>${store.driveFolderName ? escapeHtml(store.driveFolderName) : "None chosen"}</strong>
      </div>
      <button class="choose-folder-btn" style="width:100%;">Choose folder…</button>
      <div class="drive-paste-row">
        <input class="folder-link-input" type="text" placeholder="…or paste a folder link">
        <button class="use-link-btn">Use</button>
      </div>
      <button class="refresh-btn" style="width:100%;" ${store.driveFolderId ? "" : "disabled"}>Refresh media from Drive</button>
      <div class="drive-divider"></div>
      <button class="save-btn" style="width:100%;" ${store.driveFolderId ? "" : "disabled"}>Save schedule to Drive</button>
      <button class="load-btn" style="width:100%;" ${store.driveFolderId ? "" : "disabled"}>Load schedule from Drive</button>
      <div class="drive-divider"></div>
      <div class="drive-section-title">Reels (auto-fill gaps)</div>
      <div class="drive-folder-row">
        <span class="muted">Folder:</span>
        <strong>${store.reelsFolderName ? escapeHtml(store.reelsFolderName) : "None chosen"}</strong>
      </div>
      <button class="choose-reels-btn" style="width:100%;">Choose folder…</button>
      <div class="drive-paste-row">
        <input class="reels-link-input" type="text" placeholder="…or paste a folder link">
        <button class="use-reels-link-btn">Use</button>
      </div>
      <cf-toggle class="autofill-toggle" label="Auto-fill gaps"
        description="Loop a reel into any dead air, automatically" ${store.autoFillReels ? "checked" : ""}></cf-toggle>
      <button class="fill-now-btn" style="width:100%;" ${store.reelsFolderId ? "" : "disabled"}>Fill gaps now</button>
      <div class="drive-divider"></div>
      <button class="disconnect-btn danger" style="width:100%;">Disconnect</button>
    `;
    body.querySelector(".choose-folder-btn").addEventListener("click", async () => {
      const picker = document.querySelector("cf-drive-folder-picker");
      const result = await picker.open();
      if (result) await store.setDriveFolder(result.id, result.name);
      this._renderDriveBody();
    });
    const linkInput = body.querySelector(".folder-link-input");
    const useLink = async () => {
      if (!linkInput.value.trim()) return;
      await store.setDriveFolderFromInput(linkInput.value.trim());
      this._renderDriveBody();
    };
    body.querySelector(".use-link-btn").addEventListener("click", useLink);
    linkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") useLink(); });
    body.querySelector(".refresh-btn").addEventListener("click", () => store.refreshDriveMedia());
    body.querySelector(".save-btn").addEventListener("click", () => store.saveScheduleToDrive());
    body.querySelector(".load-btn").addEventListener("click", () => store.loadScheduleFromDrive());

    body.querySelector(".choose-reels-btn").addEventListener("click", async () => {
      const picker = document.querySelector("cf-drive-folder-picker");
      const result = await picker.open();
      if (result) await store.setReelsFolder(result.id, result.name);
      this._renderDriveBody();
    });
    const reelsLinkInput = body.querySelector(".reels-link-input");
    const useReelsLink = async () => {
      if (!reelsLinkInput.value.trim()) return;
      await store.setReelsFolderFromInput(reelsLinkInput.value.trim());
      this._renderDriveBody();
    };
    body.querySelector(".use-reels-link-btn").addEventListener("click", useReelsLink);
    reelsLinkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") useReelsLink(); });
    body.querySelector(".autofill-toggle").addEventListener("change", (e) => store.setAutoFillReels(e.detail.checked));
    body.querySelector(".fill-now-btn").addEventListener("click", () => {
      const { filled } = store.fillGapsWithReels();
      if (!filled) toast("No gaps to fill (or no reels loaded yet).", "warn");
    });

    body.querySelector(".disconnect-btn").addEventListener("click", () => {
      drive.disconnect();
      this._profile = null;
      this._renderDriveBody();
    });
  }

  _renderClock() {
    const root = this.shadowRoot;
    const now = new Date();
    root.querySelector(".clock-time").textContent = secToClock(
      now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds(), true);
    root.querySelector(".clock-date").textContent = `${dateLabelFull(
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`)}`;
  }

  _render() {
    const root = this.shadowRoot;
    const stats = store.computeStats();
    const onAirLive = stats.liveSec > 0 && (() => {
      const found = store.computeRundown().find((r) => r.status === "ON_AIR");
      return found && found.type === "live";
    })();

    if (!root.innerHTML) {
      const navItems = [
        ["explorer", "Explorer", "monitor"],
        ["series", "Series", "film"],
        ["programming", "Programming", "grid"],
        ["schedule", "Schedule", "calendar"],
        ["bumps", "Bump Studio", "bolt"],
      ];
      root.innerHTML = `
        <style>
          ${baseComponentCSS}
          :host{ display:block; position:relative; z-index:30; }
          svg{ display:block; flex-shrink:0; }
          .bar{ display:flex; align-items:center; gap:16px; height:56px; padding:0 18px; border-bottom:1px solid var(--border);
            background:linear-gradient(180deg, rgba(16,20,42,.96), rgba(11,14,30,.96)); backdrop-filter:blur(8px); }
          .logo{ display:flex; align-items:center; gap:9px; font-weight:800; font-size:19px; letter-spacing:-.02em; padding-right:16px;
            border-right:1px solid var(--border); height:30px; }
          .logo svg{ color:var(--accent-hi); filter:drop-shadow(0 0 8px rgba(109,93,252,.55)); }
          nav{ display:flex; gap:4px; }
          nav a{ display:flex; align-items:center; gap:8px; font-size:14px; font-weight:600; color:var(--text-muted); text-decoration:none;
            padding:8px 14px; border-radius:10px; border:1px solid transparent; cursor:pointer; user-select:none; }
          nav a:hover{ color:var(--text); background:rgba(255,255,255,.04); }
          nav a.active{ color:#fff; background:linear-gradient(180deg, rgba(109,93,252,.55), rgba(88,72,224,.55)); border-color:var(--accent-line);
            box-shadow:0 0 0 1px rgba(109,93,252,.15), 0 4px 16px rgba(109,93,252,.28); }
          .spacer{ flex:1 1 auto; }
          .network{ display:flex; align-items:center; gap:9px; padding:8px 14px; border:1px solid var(--border); border-radius:10px;
            background:rgba(24,30,59,.7); font-weight:600; font-size:14px; }
          .network .dot{ width:9px; height:9px; border-radius:50%; background:var(--good); box-shadow:0 0 8px var(--good); }
          .gear{ width:36px; height:36px; padding:0; display:grid; place-items:center; background:transparent; border:1px solid transparent;
            color:var(--text-muted); border-radius:10px; }
          .gear:hover{ color:var(--text); background:rgba(255,255,255,.05); }
          .menu{ position:relative; }
          .menu-pop{ position:absolute; right:0; top:calc(100% + 8px); width:260px; background:var(--panel); border:1px solid var(--border);
            border-radius:12px; padding:6px; box-shadow:0 16px 40px rgba(0,0,0,.6); display:none; }
          .menu.open .menu-pop{ display:block; }
          .menu-pop a{ display:flex; gap:10px; align-items:flex-start; padding:9px 10px; border-radius:8px; color:var(--text); text-decoration:none; font-size:13px; cursor:pointer; }
          .menu-pop a:hover{ background:var(--panel-3); }
          .menu-pop a small{ display:block; color:var(--text-muted); font-size:11.5px; margin-top:1px; }
          .menu-pop a svg{ margin-top:2px; color:var(--text-muted); }

          /* Legacy Drive scheduler controls (only on ?view=legacy-schedule) */
          .legacy-bar{ display:flex; align-items:center; gap:14px; padding:10px 20px; border-bottom:1px solid var(--border);
            background:var(--bg-elevated); flex-wrap:wrap; }
          .legacy-tag{ display:flex; align-items:center; gap:8px; font-size:12px; color:var(--text-muted); }
          .legacy-tag a{ color:#8fb4ff; cursor:pointer; text-decoration:none; font-weight:600; display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
          .legacy-tag span{ white-space:nowrap; }
          .channel-select{ min-width:150px; font-weight:600; width:auto; }
          .date-nav{ display:flex; align-items:center; gap:6px; background:var(--panel-2); border:1px solid var(--border);
            border-radius:var(--radius-sm); padding:4px 6px; }
          .date-nav button{ background:transparent; border:none; padding:4px 6px; }
          .date-label{ font-weight:700; font-size:12px; letter-spacing:.03em; min-width:100px; text-align:center; }
          .live-badge{ display:flex; align-items:center; gap:6px; background:var(--live); color:#fff; font-weight:800;
            font-size:12px; letter-spacing:.04em; padding:6px 12px; border-radius:999px; }
          .live-badge .dot{ width:7px; height:7px; border-radius:50%; background:#fff; animation:pulse 1.4s infinite; }
          .live-badge.idle{ background:var(--panel-3); color:var(--text-faint); }
          .live-badge.idle .dot{ animation:none; background:var(--text-faint); }
          @keyframes pulse{ 0%,100%{ opacity:1; } 50%{ opacity:.35; } }
          .clock{ text-align:center; line-height:1.1; }
          .clock-time{ font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; }
          .clock-date{ font-size:10px; color:var(--text-muted); letter-spacing:.04em; }
          .actions{ display:flex; gap:10px; }
          .drive-menu{ position:relative; }
          .drive-menu summary{ list-style:none; cursor:pointer; display:flex; align-items:center; gap:6px;
            padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--panel-2);
            font-size:13px; font-weight:600; }
          .drive-menu summary::-webkit-details-marker{ display:none; }
          .drive-menu[open] summary{ border-color:var(--accent); }
          .drive-menu .dot{ width:7px; height:7px; border-radius:50%; background:var(--text-faint); }
          .drive-menu[data-connected="true"] .dot{ background:var(--good); }
          .drive-body{ position:absolute; top:calc(100% + 6px); right:0; width:290px; max-height:80vh; overflow-y:auto;
            background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:12px;
            box-shadow:0 14px 34px rgba(0,0,0,.5); z-index:60; display:flex; flex-direction:column; gap:8px; }
          .drive-body p{ margin:0; font-size:12px; }
          .drive-body .hint{ color:var(--text-faint); font-size:11px; }
          .drive-body code{ font:11px var(--mono); background:var(--bg-elevated); padding:1px 4px; border-radius:4px; }
          .drive-account{ font-size:12px; font-weight:700; word-break:break-all; }
          .drive-section-title{ font-size:11px; font-weight:800; letter-spacing:.04em; text-transform:uppercase;
            color:var(--text-muted); }
          .drive-folder-row{ font-size:12px; display:flex; flex-direction:column; gap:2px; }
          .drive-paste-row{ display:flex; gap:6px; }
          .drive-paste-row input{ flex:1; padding:6px 8px; font-size:12px; }
          .drive-paste-row button{ padding:6px 10px; font-size:12px; flex-shrink:0; }
          .drive-divider{ height:1px; background:var(--border-soft); margin:2px 0; }
          .drive-body cf-toggle{ margin:2px 0; }
        </style>
        <header>
          <div class="bar">
            <div class="logo">
              <svg width="30" height="30" viewBox="0 0 32 32" fill="none"><path d="M7 5.5 25.5 16 7 26.5z" fill="currentColor" opacity=".28"/><path d="M5 4.5 22 14.5 5 24.5z" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M12 15 27 24.6 12 28.4z" fill="#22d3ee" opacity=".9"/></svg>
              ChannelFlow
            </div>
            <nav>
              ${navItems.map(([v, label, ic]) => `<a data-view="${v}" class="${v === "schedule" ? "active" : ""}">${icon(ic, 19)}${label}</a>`).join("")}
            </nav>
            <div class="spacer"></div>
            <div class="network"><span class="dot"></span>CRVideo Network</div>
            <div class="menu settings-menu">
              <button class="gear" title="Tools" aria-label="Tools">${icon("settings", 20)}</button>
              <div class="menu-pop">
                <a data-view="legacy-schedule">${icon("drive", 17)}<span>Drive scheduler<small>Legacy media library, timeline and live playlist</small></span></a>
              </div>
            </div>
          </div>
          <div class="legacy-bar hidden">
            <div class="legacy-tag"><a data-view="schedule">${icon("left", 14)} Back to Schedule</a><span>· Legacy Drive scheduler</span></div>
            <select class="channel-select"></select>
            <div class="date-nav">
              <button class="prev-day" title="Previous day">◀</button>
              <span class="date-label"></span>
              <button class="next-day" title="Next day">▶</button>
            </div>
            <div class="live-badge"><span class="dot"></span><span class="label">LIVE</span></div>
            <div class="clock"><div class="clock-time"></div><div class="clock-date"></div></div>
            <div class="spacer"></div>
            <details class="drive-menu">
              <summary><span class="dot"></span>Drive</summary>
              <div class="drive-body"></div>
            </details>
            <details class="drive-menu live-menu">
              <summary><span class="dot"></span>Live</summary>
              <div class="drive-body live-body"></div>
            </details>
            <div class="actions">
              <button class="validate-btn">Validate Schedule</button>
              <button class="publish-btn primary">Publish</button>
            </div>
          </div>
        </header>
      `;
      this._wire();
      this._renderNavActive();
    }

    const select = root.querySelector(".channel-select");
    select.innerHTML = store.channels.map((c) =>
      `<option value="${escapeHtml(c.id)}" ${c.id === store.activeChannelId ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");

    root.querySelector(".date-label").textContent = dateLabel(store.activeDate);

    const liveBadge = root.querySelector(".live-badge");
    liveBadge.classList.toggle("idle", !onAirLive);
    liveBadge.querySelector(".label").textContent = onAirLive ? "LIVE" : "OFF AIR";

    root.querySelector(".drive-menu").dataset.connected = String(drive.isConnected());
    this._renderClock();
  }
}
customElements.define("cf-header", CfHeader);
