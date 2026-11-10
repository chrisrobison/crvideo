// Inspector: Voice -- attach ONE already-generated announcement clip.
// Never generates scripts or synthesizes audio; production belongs to the
// announcer pipeline (PROGRAMMING -> Continuity announcer).

import { escapeHtml } from "../../utils.js";
import { icons } from "./studio-ui.js";
import { h, setValue, searchBoxHtml, pct, pickerCSS } from "./inspector-common.js";
import { viewState } from "../../view.js";
import { findAnnouncement, announcementTypeLabel, bumpTiming, ensureDuration, effectiveDuration, roundTime } from "./bump-model.js";

export class AnnouncerSection {
  constructor({ store, audition, inspector }) {
    this.store = store;
    this.audition = audition;
    this.inspector = inspector;
    this.channelFilter = "";
    this.query = "";
    this.wantsPlayback = true; // real clip length
  }

  key() {
    const d = this.store.state.draft;
    return `voice:${this.store.state.selectedId}:${d.announcement?.url ? "on" : "off"}:${this.store.state.media.channels.length}`;
  }

  mount(container) {
    const s = this.store;
    const channels = (s.state.media.channels || []).filter((c) => c.announcements?.length);
    const ann = s.state.draft.announcement;
    this.el = h(`
      <div>
        <style>${pickerCSS}
          .clip .script{ font-size:13px; line-height:1.45; margin:8px 0; color:var(--text); }
          .clip .from{ font-size:11px; color:var(--text-muted); }
          .clip .acts{ display:flex; gap:6px; margin-top:8px; }
          .clip .acts button{ padding:4px 8px; font-size:12px; }
          .filters{ display:grid; grid-template-columns:minmax(0,1fr); gap:6px; margin-top:12px; }
          .filters select{ padding:6px 8px; font-size:12px; }
        </style>
        <div class="sec-h"><h3>Announcement</h3><span class="small faint">plays once</span></div>
        <div class="current"></div>
        <div class="picker"></div>
      </div>`);
    container.append(this.el);

    if (ann?.url) {
      const cur = h(`
        <div class="card clip">
          <div class="inline"><button class="aud" aria-label="Play this announcement" aria-pressed="false">${icons.play}</button><span class="badge" data-tone="audio"></span><span class="from"></span></div>
          <div class="script"></div>
          <div class="field-row"><label for="a-start">Starts at</label><div class="inline"><input id="a-start" class="num" type="number" min="0" step="0.1"><span class="small muted">s</span><span class="small faint a-len"></span></div></div>
          <div class="field-row"><label for="a-duck">Duck music to</label><div class="inline" style="gap:8px"><input id="a-duck" type="range" min="0" max="1" step="0.05" style="padding:0;accent-color:var(--accent)"><span class="tnum small a-duckv" style="width:36px"></span></div></div>
          <div class="acts"><button class="remove ghost">Remove</button></div>
        </div>`);
      this.el.querySelector(".current").append(cur);
      cur.querySelector(".aud").addEventListener("click", () => this.audition.toggle(s.state.draft.announcement.url, 1));
      cur.querySelector("#a-start").addEventListener("change", (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) s.updateDraft((d) => { ensureDuration(d); d.announcement.start = roundTime(Math.max(0, v)); }, "inspector");
        this.update();
      });
      cur.querySelector("#a-duck").addEventListener("input", (e) => s.updateDraft((d) => { d.announcement.duckTo = Number(e.target.value); }, "inspector"));
      cur.querySelector(".remove").addEventListener("click", () => s.updateDraft((d) => { d.announcement = null; }, "inspector"));
    }

    const picker = this.el.querySelector(".picker");
    if (!channels.length) {
      picker.append(h(`<div class="empty-state">
        <p>No generated announcements are available yet.</p>
        <p class="small faint">Announcements are written and voiced by the announcer pipeline, not here.</p>
        <button class="go ghost small">Open Programming → Continuity announcer</button></div>`));
      picker.querySelector(".go").addEventListener("click", () => viewState.setView("programming"));
    } else {
      const total = channels.reduce((n, c) => n + c.announcements.length, 0);
      picker.append(h(`<div>
        <div class="eyebrow" style="margin-top:16px">${ann?.url ? "Replace with" : "Choose a clip"}</div>
        <div class="filters">
          <select class="ch" aria-label="Filter by channel"><option value="">All channels (${total})</option>
            ${channels.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${c.announcements.length})</option>`).join("")}
          </select>
          ${searchBoxHtml("Search script text")}
        </div>
        <ul class="pick" role="listbox" aria-label="Announcements"></ul>
      </div>`));
      const sel = picker.querySelector(".ch");
      sel.value = this.channelFilter;
      sel.addEventListener("change", (e) => { this.channelFilter = e.target.value; this._renderList(); });
      const q = picker.querySelector(".q");
      q.value = this.query;
      q.addEventListener("input", (e) => { this.query = e.target.value.trim().toLowerCase(); this._renderList(); });
      const list = picker.querySelector(".pick");
      list.addEventListener("click", (e) => {
        const aud = e.target.closest("[data-aud]");
        if (aud) { e.stopPropagation(); this.audition.toggle(aud.dataset.aud, 1); return; }
        const li = e.target.closest("li[data-url]");
        if (li) this._choose(li);
      });
      list.addEventListener("keydown", (e) => {
        const li = e.target.closest("li[data-url]");
        if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); this._choose(li); }
      });
      this._renderList();
    }
    this.update();
  }

  _choose(li) {
    const ch = this.store.state.media.channels.find((c) => c.id === li.dataset.ch);
    const clip = ch?.announcements.find((a) => a.url === li.dataset.url);
    if (!clip) return;
    this.store.updateDraft((d) => {
      const prev = d.announcement || {};
      d.announcement = { url: clip.url.replace(/^\/+/, ""), channelId: ch.id, duckTo: prev.duckTo ?? 0.3 };
      if (clip.transitionId) d.announcement.transitionId = clip.transitionId;
      if (Number.isFinite(prev.start)) d.announcement.start = prev.start;
    }, "inspector");
  }

  _renderList() {
    const list = this.el.querySelector(".pick");
    if (!list) return;
    const cur = String(this.store.state.draft.announcement?.url || "").replace(/^\/+/, "");
    const rows = [];
    for (const ch of this.store.state.media.channels) {
      if (this.channelFilter && ch.id !== this.channelFilter) continue;
      for (const a of ch.announcements || []) {
        if (this.query && !`${a.text} ${a.type} ${ch.name}`.toLowerCase().includes(this.query)) continue;
        rows.push(`<li role="option" tabindex="0" data-ch="${escapeHtml(ch.id)}" data-url="${escapeHtml(a.url)}" aria-selected="${String(a.url).replace(/^\/+/, "") === cur}">
          <button class="aud" data-aud="${escapeHtml(a.url)}" aria-label="Play" aria-pressed="false" tabindex="-1">${icons.play}</button>
          <div class="main"><div class="sub">${escapeHtml(a.text || "(no script text)")}</div>
          <div class="small faint">${escapeHtml(ch.name)} · ${escapeHtml(announcementTypeLabel(a.type))}</div></div></li>`);
        if (rows.length >= 200) break;
      }
    }
    list.innerHTML = rows.join("") || `<li class="grp" role="presentation">No matching announcements.</li>`;
    this._syncAudButtons();
  }

  _syncAudButtons() {
    this.el.querySelectorAll("[data-aud]").forEach((b) => {
      const on = this.audition.isPlaying(b.dataset.aud);
      b.setAttribute("aria-pressed", String(on));
      b.innerHTML = on ? icons.stop : icons.play;
    });
  }

  update() {
    const s = this.store.state;
    const ann = s.draft.announcement;
    const cur = this.el.querySelector(".clip");
    if (cur && ann?.url) {
      const found = findAnnouncement(s.media, ann);
      cur.querySelector(".badge").textContent = announcementTypeLabel(found?.clip?.type);
      cur.querySelector(".from").textContent = found?.channel ? `from ${found.channel.name}` : "";
      cur.querySelector(".script").textContent = found?.clip?.text || "Script text unavailable (the clip is no longer listed in its channel's announcements).";
      const t = bumpTiming(s.draft);
      setValue(cur.querySelector("#a-start"), t.announcementStart);
      cur.querySelector("#a-start").max = String(effectiveDuration(s.draft) - 0.1);
      const len = s.playback.durations?.announcement;
      const D = effectiveDuration(s.draft);
      const over = len && t.announcementStart + len > D + 0.01;
      cur.querySelector(".a-len").textContent = len ? `clip ${len.toFixed(1)}s${over ? " · cut at end" : ""}` : "";
      cur.querySelector(".a-len").style.color = over ? "var(--warn)" : "";
      setValue(cur.querySelector("#a-duck"), ann.duckTo ?? 0.3);
      cur.querySelector(".a-duckv").textContent = pct(ann.duckTo ?? 0.3);
      const aud = cur.querySelector(".aud");
      const on = this.audition.isPlaying(ann.url);
      aud.setAttribute("aria-pressed", String(on));
      aud.innerHTML = on ? icons.stop : icons.play;
    }
    const want = String(ann?.url || "").replace(/^\/+/, "");
    this.el.querySelectorAll(".pick li[data-url]").forEach((li) => li.setAttribute("aria-selected", String(String(li.dataset.url).replace(/^\/+/, "") === want)));
    this._syncAudButtons();
  }
}
