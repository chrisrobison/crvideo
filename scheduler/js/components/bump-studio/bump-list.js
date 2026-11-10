// <bump-list> -- Compose's left column: searchable bump list with a
// per-item context menu (rename / duplicate / delete). Selection goes
// through the store, which guards unsaved edits.

import { escapeHtml, toast } from "../../utils.js";
import { studioStore as store, changeOf } from "./bump-studio-store.js";
import { TOPICS, subscribe } from "../../../../js/bus.js";
import { studioCSS, icons, makeThumb } from "./studio-ui.js";
import { DEFAULT_BUMP_DURATION } from "./bump-model.js";

class BumpList extends HTMLElement {
  constructor() {
    super();
    this._query = "";
    this._menuFor = null;
    this._renamingId = null;
    this._thumbs = new Map(); // reuse thumbnail nodes across re-renders (no reload/flicker)
  }

  connectedCallback() {
    if (this.shadowRoot) { this._listen(); return; }
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ${studioCSS}
        :host{ display:flex; flex-direction:column; min-height:0; }
        .title{ display:flex; align-items:center; justify-content:space-between; gap:8px; padding:14px 14px 10px; }
        .title h2{ margin:0; font-size:17px; }
        .title .new{ display:inline-flex; align-items:center; gap:6px; padding:7px 12px; }
        .title .new svg{ width:15px; height:15px; }
        .head{ padding:0 14px 10px; }
        ul{ list-style:none; margin:0; padding:2px 10px 12px; overflow:auto; flex:1; display:flex; flex-direction:column; gap:6px; }
        li{ display:grid; grid-template-columns:84px minmax(0,1fr) auto; align-items:center; gap:10px; padding:6px; border-radius:var(--radius-sm); cursor:pointer; border:1px solid var(--border-soft); background:var(--bg-elevated); }
        li:hover{ border-color:#3a4256; }
        li[aria-selected="true"]{ border-color:var(--accent); background:var(--accent-soft); box-shadow:0 0 0 1px var(--accent-dim); }
        li:focus-visible{ outline:2px solid var(--accent); outline-offset:1px; }
        .sw{ position:relative; width:84px; height:50px; border-radius:5px; overflow:hidden; background:var(--panel-3); }
        .sw .thumb{ width:100%; height:100%; border-radius:0; }
        .sw .pi{ position:absolute; left:5px; bottom:4px; width:16px; height:16px; border-radius:3px; background:rgba(0,0,0,.6); color:#fff; display:flex; align-items:center; justify-content:center; }
        .sw .pi svg{ width:9px; height:9px; }
        .info{ min-width:0; display:flex; flex-direction:column; gap:3px; }
        .name{ font-size:13px; font-weight:700; line-height:1.25; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
        .name .dot{ display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--warn); margin-left:6px; vertical-align:middle; }
        .meta{ display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-muted); white-space:nowrap; overflow:hidden; }
        @media (max-width: 1280px){
          li{ grid-template-columns:64px minmax(0,1fr) auto; gap:8px; }
          .sw{ width:64px; height:38px; }
        }
        .meta svg{ width:12px; height:12px; }
        .tp{ display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:700; letter-spacing:.04em; padding:1px 7px; border-radius:999px; }
        .tp::before{ content:""; width:5px; height:5px; border-radius:50%; background:currentColor; }
        .tp.video{ color:#8fe3ac; background:var(--good-soft); }
        .tp.image{ color:#9dc3ff; background:var(--accent-soft); }
        .tp.color{ color:var(--text-muted); background:var(--panel-3); }
        .meta .len{ font-variant-numeric:tabular-nums; }
        .meta .len.def{ color:var(--text-faint); }
        .meta .voice{ color:#cbb3ff; display:inline-flex; }
        .meta .onair{ color:var(--good); font-size:11px; }
        .more{ padding:4px 2px; border:0; background:transparent; color:var(--text-muted); align-self:start; }
        .more svg{ width:16px; height:16px; transform:rotate(90deg); }
        .rename{ padding:3px 6px; font-size:13px; }
        .menu{ position:fixed; z-index:50; min-width:150px; background:var(--panel-2); border:1px solid var(--border); border-radius:var(--radius-sm); box-shadow:0 10px 30px rgba(0,0,0,.45); padding:4px; }
        .menu button{ display:block; width:100%; text-align:left; border:0; background:transparent; padding:7px 10px; font-size:13px; }
        .menu button:hover, .menu button:focus-visible{ background:var(--panel-3); }
        .menu .danger-item{ color:#ffb4b4; }
        .none{ padding:16px 10px; font-size:12px; color:var(--text-muted); border:0 !important; background:transparent !important; }
      </style>
      <div class="title"><h2>Bumps</h2><button class="new primary">${icons.plus}<span>New Bump</span></button></div>
      <div class="head">
        <label class="search"><span class="sr-only">Search bumps</span>${icons.search}<input type="search" placeholder="Search bumps..."></label>
      </div>
      <ul role="listbox" aria-label="Bumps"></ul>
      <div class="menu" role="menu" hidden>
        <button role="menuitem" data-act="rename">Rename</button>
        <button role="menuitem" data-act="duplicate">Duplicate</button>
        <button role="menuitem" data-act="delete" class="danger-item">Delete…</button>
      </div>
    `;
    const root = this.shadowRoot;
    root.querySelector("input").addEventListener("input", (e) => { this._query = e.target.value.trim().toLowerCase(); this._renderList(); });
    root.querySelector(".new").addEventListener("click", () => store.newBump());
    const ul = root.querySelector("ul");
    ul.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-id]");
      if (!li || e.target.closest(".rename")) return;
      if (e.target.closest(".more")) { e.stopPropagation(); this._openMenu(li.dataset.id, e.target.closest(".more")); return; }
      if (li.dataset.id !== "__new") store.select(li.dataset.id);
    });
    ul.addEventListener("contextmenu", (e) => {
      const li = e.target.closest("li[data-id]");
      if (!li || li.dataset.id === "__new") return;
      e.preventDefault();
      this._openMenu(li.dataset.id, null, e.clientX, e.clientY);
    });
    ul.addEventListener("keydown", (e) => this._onListKey(e));
    root.querySelector(".menu").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (b) this._act(b.dataset.act, this._menuFor);
    });
    root.querySelector(".menu").addEventListener("keydown", (e) => {
      const items = [...root.querySelectorAll(".menu button")];
      const i = items.indexOf(e.composedPath()[0]);
      if (e.key === "Escape") { this._closeMenu(true); }
      else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    this._onDocDown = (e) => { if (!e.composedPath().includes(root.querySelector(".menu"))) this._closeMenu(); };
    this._listen();
    this._renderList();
  }

  _listen() {
    this._subs = new AbortController();
    const signal = this._subs.signal;
    document.addEventListener("pointerdown", this._onDocDown, { signal });
    subscribe(TOPICS.STUDIO_CHANGED, (msg) => {
      const k = changeOf(msg).keys;
      if (k.has("bumps") || k.has("selection") || k.has("schedules") || k.has("status")) this._renderList();
      else if (k.has("draft")) this._renderDirty();
    }, { signal });
  }

  disconnectedCallback() {
    this._subs?.abort();
  }

  _visibleBumps() {
    const q = this._query;
    return store.state.bumps.filter((b) => !q || String(b.name || b.id).toLowerCase().includes(q) || String(b.description || "").toLowerCase().includes(q));
  }

  _thumbFor(bump) {
    const bg = bump.background || {};
    if (bg.type === "color") {
      const d = document.createElement("div");
      d.style.cssText = `width:100%;height:100%;background:${bg.color || "#14213d"}`;
      return d;
    }
    const key = `${bump.id || "__new"}:${bg.type}:${bg.url}`; // per bump: a DOM node can only live in one card
    if (!this._thumbs.has(key)) this._thumbs.set(key, makeThumb(bg.type, bg.url, { hoverPlay: false }));
    return this._thumbs.get(key);
  }

  _renderList() {
    const ul = this.shadowRoot.querySelector("ul");
    const s = store.state;
    const items = this._visibleBumps();
    const frag = document.createDocumentFragment();
    if (store.isNew) {
      const li = document.createElement("li");
      li.dataset.id = "__new";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "true");
      li.tabIndex = 0;
      li.innerHTML = `<div class="sw"></div><div class="info"><div class="name">${escapeHtml(s.draft?.name || "Untitled bump")}<span class="dot" title="Not saved yet"></span></div><div class="meta">new · not saved</div></div><span></span>`;
      li.querySelector(".sw").append(this._thumbFor({ background: s.draft?.background || {} }));
      frag.append(li);
    }
    for (const b of items) {
      const selected = b.id === s.selectedId;
      const refs = store.referencesTo(b.id).filter((c) => c.enabled);
      const li = document.createElement("li");
      li.dataset.id = b.id;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(selected));
      li.tabIndex = selected || (!s.selectedId && b === items[0]) ? 0 : -1;
      const bgType = b.background?.type || "color";
      const len = Number(b.duration) || DEFAULT_BUMP_DURATION;
      li.innerHTML = `
        <div class="sw">${bgType === "video" ? `<span class="pi">${icons.play}</span>` : ""}</div>
        <div class="info">
          <div class="name"></div>
          <div class="meta">
            <span class="tp ${bgType}">${bgType.toUpperCase()}</span>
            <span class="len ${b.duration ? "" : "def"}" title="${b.duration ? "Composition length" : "No saved duration: previewed at the default; the schedule rule sets on-air length"}">${Math.floor(len / 60)}:${String(Math.round(len % 60)).padStart(2, "0")}</span>
            ${b.announcement ? `<span class="voice" title="Has an announcement">${icons.mic}</span>` : ""}
            ${refs.length ? `<span class="onair" title="Scheduled on ${escapeHtml(refs.map((c) => c.name).join(", "))}">● ${refs.length} ch</span>` : ""}
          </div>
        </div>
        <button class="more" aria-label="Actions for ${escapeHtml(b.name || b.id)}" aria-haspopup="menu">${icons.more}</button>`;
      const nameEl = li.querySelector(".name");
      if (this._renamingId === b.id) {
        const input = Object.assign(document.createElement("input"), { className: "rename", value: b.name || "", maxLength: 120 });
        input.setAttribute("aria-label", "New name");
        nameEl.append(input);
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") this._commitRename(b.id, input.value);
          if (e.key === "Escape") { this._renamingId = null; this._renderList(); }
        });
        input.addEventListener("blur", () => { if (this._renamingId === b.id) this._commitRename(b.id, input.value); });
        queueMicrotask(() => { input.focus(); input.select(); });
      } else {
        nameEl.textContent = b.name || b.id;
        nameEl.title = b.name || b.id;
        if (selected && store.isDirty) nameEl.insertAdjacentHTML("beforeend", `<span class="dot" title="Unsaved changes"></span>`);
      }
      li.querySelector(".sw").prepend(this._thumbFor(b));
      frag.append(li);
    }
    ul.replaceChildren(frag);
    if (!items.length && !store.isNew) {
      ul.innerHTML = `<li class="none" style="display:block;cursor:default">${s.bumps.length ? "No bumps match." : s.status === "ready" ? "No bumps yet. Click + to make one." : ""}</li>`;
    }
  }

  _renderDirty() {
    const s = store.state;
    if (store.isNew) {
      const name = this.shadowRoot.querySelector('li[data-id="__new"] .name');
      if (name) name.firstChild.textContent = s.draft?.name || "Untitled bump";
      return;
    }
    const nameEl = this.shadowRoot.querySelector(`li[aria-selected="true"] .name`);
    if (!nameEl || nameEl.querySelector("input")) return;
    nameEl.querySelector(".dot")?.remove();
    if (store.isDirty) nameEl.insertAdjacentHTML("beforeend", `<span class="dot" title="Unsaved changes"></span>`);
  }

  _onListKey(e) {
    const li = e.target.closest?.("li[data-id]");
    if (!li || e.target.closest(".rename")) return;
    const all = [...this.shadowRoot.querySelectorAll("li[data-id]")];
    const i = all.indexOf(li);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = all[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) { next.tabIndex = 0; li.tabIndex = -1; next.focus(); }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (li.dataset.id !== "__new") store.select(li.dataset.id);
    } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      if (li.dataset.id !== "__new") this._openMenu(li.dataset.id, li.querySelector(".more"));
    } else if (e.key === "F2" && li.dataset.id !== "__new") {
      this._act("rename", li.dataset.id);
    }
  }

  _openMenu(id, anchor, x, y) {
    const menu = this.shadowRoot.querySelector(".menu");
    this._menuFor = id;
    menu.hidden = false;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      x = r.left; y = r.bottom + 4;
    }
    const w = 160;
    menu.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 130)}px`;
    menu.querySelector("button").focus();
  }

  _closeMenu(refocus = false) {
    const menu = this.shadowRoot.querySelector(".menu");
    if (menu.hidden) return;
    menu.hidden = true;
    if (refocus && this._menuFor) this.shadowRoot.querySelector(`li[data-id="${CSS.escape(this._menuFor)}"]`)?.focus();
  }

  async _act(act, id) {
    this._closeMenu();
    const bump = store.state.bumps.find((b) => b.id === id);
    if (!bump) return;
    try {
      if (act === "rename") {
        this._renamingId = id;
        this._renderList();
      } else if (act === "duplicate") {
        const copy = await store.duplicate(id);
        if (copy) toast(`Created "${copy.name}".`, "good");
      } else if (act === "delete") {
        const refs = store.referencesTo(id);
        let msg = `Delete "${bump.name || id}"? This cannot be undone.`;
        if (refs.length) {
          msg += `\n\nIt is still referenced by ${refs.length} channel schedule${refs.length === 1 ? "" : "s"}:\n`
            + refs.map((c) => `  • ${c.name} (${c.rules.length} rule${c.rules.length === 1 ? "" : "s"}${c.enabled ? ", live" : ", disabled"})`).join("\n")
            + "\n\nThose rules are NOT removed. Until you remove them in Schedule, the channel skips that slot on air.";
        }
        if (!window.confirm(msg)) return;
        await store.remove(id);
        toast("Bump deleted.", "good");
      }
    } catch (e) {
      toast(e.message, "danger");
    }
  }

  async _commitRename(id, value) {
    this._renamingId = null;
    try {
      const saved = await store.rename(id, value);
      if (saved) toast("Renamed.", "good");
    } catch (e) {
      toast(e.message, "danger");
    }
    this._renderList();
  }
}

customElements.define("bump-list", BumpList);
