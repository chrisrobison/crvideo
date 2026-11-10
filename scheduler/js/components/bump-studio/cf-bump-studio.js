// <cf-bump-studio> -- the BUMPS view: a workspace shell with
// Compose | Schedule | Library tabs over one shared store
// (bump-studio-store.js). All three workspaces stay mounted and are only
// hidden, so the selection, the unsaved draft, preview state and any
// half-edited schedule survive tab switches.
//
// No access control: see docs/admin-ui.md. Anyone who can load this page
// can create/edit/delete any bump and change what any channel schedules.

import { escapeHtml, toast } from "../../utils.js";
import { studioStore as store, WORKSPACES } from "./bump-studio-store.js";
import { studioCSS, icons } from "./studio-ui.js";
import { viewState } from "../../view.js";
import { TOPICS, subscribe } from "../../../../js/bus.js";
import "./bump-compose.js";
import "./bump-schedule-workspace.js";
import "./bump-library-workspace.js";

const LABELS = { compose: "Compose", schedule: "Schedule", library: "Library" };
const TAB_ICONS = { compose: icons.edit, schedule: icons.calendar, library: icons.layers };

class CfBumpStudio extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ${studioCSS}
        :host{ display:flex; flex-direction:column; height:100%; min-height:0; }
        header{ display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); align-items:center; gap:16px; padding:10px 16px; border-bottom:1px solid var(--border-soft); background:var(--bg-elevated); }
        .brand{ font-size:15px; font-weight:600; letter-spacing:.32em; color:var(--text); white-space:nowrap; }
        [role="tablist"]{ display:flex; gap:4px; background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); padding:3px; }
        [role="tab"]{ display:flex; align-items:center; gap:8px; background:transparent; border:0; border-bottom:2px solid transparent; border-radius:var(--radius-sm); padding:7px 16px; color:var(--text-muted); font-weight:600; }
        [role="tab"] svg{ width:16px; height:16px; }
        [role="tab"]:hover{ color:var(--text); }
        [role="tab"][aria-selected="true"]{ color:var(--text); background:var(--panel-3); border-bottom-color:var(--accent); }
        .doc{ display:flex; align-items:center; justify-content:flex-end; gap:8px; min-width:0; }
        .picker{ width:auto; min-width:150px; max-width:240px; padding:7px 10px; }
        .pill{ display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:4px 10px; border-radius:999px; white-space:nowrap; border:1px solid; }
        .pill::before{ content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }
        .pill.draft{ color:var(--warn); border-color:rgba(245,165,36,.45); background:var(--warn-soft); }
        .pill.saved{ color:var(--good); border-color:rgba(34,197,94,.4); background:var(--good-soft); }
        .save{ display:inline-flex; align-items:center; gap:6px; padding:7px 14px; }
        .save svg{ width:16px; height:16px; }
        main{ flex:1; min-height:0; position:relative; }
        main > *{ position:absolute; inset:0; }
        main > [hidden]{ display:none !important; }
        .status{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--text-muted); background:var(--bg); z-index:5; }
        .status .error{ color:#ffb4b4; background:var(--live-soft); padding:12px 16px; border-radius:var(--radius-sm); }
        bump-schedule-workspace, bump-library-workspace{ overflow:auto; }
        @media (max-width: 1100px){
          header{ grid-template-columns:1fr; justify-items:start; }
          .doc{ justify-content:flex-start; flex-wrap:wrap; }
        }
      </style>
      <header>
        <span class="brand">BUMP STUDIO</span>
        <div role="tablist" aria-label="Bump Studio workspaces">
          ${WORKSPACES.map((w) => `<button role="tab" id="tab-${w}" aria-controls="ws-${w}" data-ws="${w}">${TAB_ICONS[w]}<span>${LABELS[w]}</span></button>`).join("")}
        </div>
        <div class="doc">
          <label class="sr-only" for="picker">Bump being edited</label>
          <select id="picker" class="picker"></select>
          <span class="pill draft" hidden title="This draft has changes that are not saved. Nothing changes on air until you save.">Draft (unsaved)</span>
          <span class="pill saved" hidden>Saved</span>
          <button class="revert ghost" title="Discard unsaved changes">Revert</button>
          <button class="save primary" title="Save (Ctrl+S)">${icons.save}<span>Save</span></button>
        </div>
      </header>
      <main>
        <bump-compose id="ws-compose" role="tabpanel" aria-labelledby="tab-compose"></bump-compose>
        <bump-schedule-workspace id="ws-schedule" role="tabpanel" aria-labelledby="tab-schedule" hidden></bump-schedule-workspace>
        <bump-library-workspace id="ws-library" role="tabpanel" aria-labelledby="tab-library" hidden></bump-library-workspace>
        <div class="status" hidden></div>
      </main>
    `;
    const root = this.shadowRoot;
    root.querySelector('[role="tablist"]').addEventListener("click", (e) => {
      const tab = e.target.closest("[data-ws]");
      if (tab) store.setWorkspace(tab.dataset.ws);
    });
    root.querySelector('[role="tablist"]').addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const i = WORKSPACES.indexOf(store.state.workspace);
      const next = WORKSPACES[(i + (e.key === "ArrowRight" ? 1 : WORKSPACES.length - 1)) % WORKSPACES.length];
      store.setWorkspace(next);
      root.querySelector(`[data-ws="${next}"]`).focus();
    });
    root.querySelector(".save").addEventListener("click", () => this._save());
    root.querySelector("#picker").addEventListener("change", (e) => {
      const ok = e.target.value === "__new" ? store.newBump() : store.select(e.target.value);
      if (!ok) this._renderPicker(); // cancelled by the unsaved-changes guard
    });
    root.querySelector(".revert").addEventListener("click", () => {
      if (store.isDirty && window.confirm("Discard all unsaved changes to this bump?")) store.revert();
    });

    this._onKey = (e) => {
      if (viewState.current !== "bumps") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); this._save(); }
    };
    document.addEventListener("keydown", this._onKey);
    this._onChange = (e) => this._render(e.detail);
    store.addEventListener("change", this._onChange);
    this._render({ keys: new Set(["status", "workspace", "draft"]) });
    // Load lazily, the first time the BUMPS view is actually shown, so the
    // other scheduler views never pay for bump data or media metadata.
    // (retained: the current view arrives immediately.)
    let done = false;
    const off = subscribe(TOPICS.APP_VIEW_STATE, ({ data }) => {
      if (done || data?.view !== "bumps" || store.state.status !== "idle") return;
      done = true;
      queueMicrotask(() => off()); // a retained delivery can arrive before subscribe() has returned `off`
      store.load();
    }, { retained: true });
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this._onKey);
    store.removeEventListener("change", this._onChange);
  }

  async _save() {
    if (!store.canSave) return;
    try {
      const wasNew = store.isNew;
      await store.save();
      toast(wasNew ? "Bump created." : "Saved.", "good");
      const note = this.shadowRoot.querySelector(".pill.saved");
      note.hidden = false;
      clearTimeout(this._noteTimer);
      this._noteTimer = setTimeout(() => { note.hidden = true; }, 2500);
    } catch (e) {
      toast(e.message, "danger", 6000);
    }
  }

  _renderPicker() {
    const sel = this.shadowRoot.querySelector("#picker");
    const s = store.state;
    sel.innerHTML = (store.isNew ? `<option value="__new">${escapeHtml(s.draft?.name || "Untitled bump")} (new)</option>` : "")
      + s.bumps.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name || b.id)}</option>`).join("");
    sel.value = store.isNew ? "__new" : (s.selectedId || "");
  }

  _render({ keys }) {
    const root = this.shadowRoot;
    const s = store.state;
    if (keys.has("status")) {
      const status = root.querySelector(".status");
      status.hidden = s.status === "ready";
      status.innerHTML = s.status === "error"
        ? `<div class="error">Could not load bumps: ${escapeHtml(s.error)} <button class="retry ghost">Retry</button></div>`
        : `<div>Loading…</div>`;
      status.querySelector(".retry")?.addEventListener("click", () => store.load());
    }
    if (keys.has("workspace") || keys.has("status")) {
      for (const w of WORKSPACES) {
        root.querySelector(`[data-ws="${w}"]`).setAttribute("aria-selected", String(w === s.workspace));
        root.querySelector(`[data-ws="${w}"]`).tabIndex = w === s.workspace ? 0 : -1;
        root.getElementById(`ws-${w}`).hidden = w !== s.workspace;
      }
    }
    if (keys.has("workspace") || keys.has("status")) {
      // The bump picker / Save / Revert act on Compose's draft; elsewhere
      // they'd read as saving the schedule or library, so only the unsaved
      // pill stays visible (it still says a bump draft is pending).
      const compose = s.workspace === "compose";
      for (const sel of ["#picker", ".revert", ".save"]) root.querySelector(sel).hidden = !compose;
    }
    if (keys.has("bumps") || keys.has("selection") || keys.has("status")) this._renderPicker();
    if (keys.has("draft") || keys.has("selection") || keys.has("saving") || keys.has("status")) {
      root.querySelector(".pill.draft").hidden = !store.isDirty && !store.isNew;
      if (store.isDirty || store.isNew) root.querySelector(".pill.saved").hidden = true;
      root.querySelector(".save").disabled = !store.canSave || s.saving;
      root.querySelector(".save span").textContent = s.saving ? "Saving…" : store.isNew ? "Create" : "Save";
      root.querySelector(".revert").disabled = !store.isDirty || s.saving;
    }
  }
}

customElements.define("cf-bump-studio", CfBumpStudio);
