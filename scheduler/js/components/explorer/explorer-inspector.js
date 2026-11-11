// explorer-inspector.js -- <explorer-inspector>: the shared contextual
// Inspector. It picks an entity renderer from the store's route, renders
// HTML, and handles the in-place interactions (previews, jumps). It
// owns the read-only preview lifecycle: one preview at a time, stopped
// when the inspected entity changes (stages whose `data-persist` key is
// unchanged are carried across re-renders so a background data load never
// kills a playing preview).

import * as M from "./explorer-model.js";
import { mediaUrl, getBumperTheme } from "./explorer-api.js";
import { esc, explorerCSS, section, emptyNote, icons, kv, plural, fmtDuration } from "./explorer-ui.js";
import { runAction } from "./explorer-actions.js";
import { renderChannel } from "./explorer-channel.js";
import { renderSeries } from "./explorer-series.js";
import { renderEpisode, episodePlayability } from "./explorer-episode.js";
import { renderAiring, resolveAiringView } from "./explorer-airing.js";
import { renderBump, renderAnnouncement, renderMedia, previewChannelFor } from "./explorer-asset.js";
import { renderPick } from "./explorer-search.js";
import { previewVideo, previewBump, previewAudio, previewContinuity, stopPreview, activePreviewKey, virtualClock } from "./explorer-media.js";
import { audioPeaks, waveformUrl } from "../bump-studio/media-peaks.js";
import { findAnnouncementAudio } from "../../../../channels/broadcast.js";

export function entityOf(store, pick) {
  const r = store.route;
  if (r.q) return { type: "pick", key: `pick:${pick ? `${pick.type}|${pick.id}` : ""}` };
  if (r.mode === "production") {
    if (r.asset) return { type: "asset", asset: r.asset, key: `asset:${JSON.stringify(r.asset)}` };
    return { type: "production", key: "production" };
  }
  if (r.airing !== null) return { type: "airing", key: `airing:${r.channel}:${r.airing}` };
  if (r.episode) return { type: "episode", key: `episode:${r.series}:${r.episode}` };
  if (r.series) return { type: "series", key: `series:${r.series}` };
  if (r.channel) return { type: "channel", key: `channel:${r.channel}` };
  return { type: "overview", key: "overview" };
}

function renderOverview(store) {
  const d = store.data;
  const eps = [...(d.seriesIndex?.values() || [])].reduce((n, s) => n + s.episode_count, 0);
  const cov = store.scheduleCoverage();
  return `
    <div class="sec"><div class="eyebrow-line">CRVIDEO EXPLORER</div><h2 class="ep-title">Browse what's on, and why</h2>
      <p class="desc">Pick a channel to see what it carries and what is scheduled, a show for its episodes, an episode for its airings, an airing for its continuity. Use <b>Production</b> for bumps and voiceovers, and Search to find anything.</p></div>
    ${section("In this library", `
      ${kv("Channels", d.channels ? String(d.channels.length) : "…")}
      ${kv("Series", d.seriesIndex ? String(d.seriesIndex.size) : "…")}
      ${kv("Episodes", d.seriesIndex ? eps.toLocaleString() : "…")}
      ${kv("Published schedules", `${cov.loaded} of ${cov.total} loaded${cov.failed ? `, ${cov.failed} unavailable` : ""}`)}`)}
    ${section("What the labels mean", `
      <p class="note"><b>Configured</b> = defined in the repository. <b>Published</b> = a compiled schedule exists. <b>Scheduled</b> = the published schedule says it should be playing at that time.
      Explorer never says “on air” or “live”: CRVideo has no player telemetry, so <b>confirmed playing</b> is not something it can know.</p>`)}`;
}

function renderProduction(store) {
  const d = store.data;
  return `
    <div class="sec"><div class="eyebrow-line">PRODUCTION ASSETS</div><h2 class="ep-title">Bumps, voiceovers and media</h2>
      <p class="desc">Choose a library, then an asset, to preview it and see which channels and schedule rules use it.</p></div>
    ${section("What's here", `
      ${kv("Bumps", d.bumps ? String(d.bumps.length) : "…")}
      ${kv("Voiceovers", d.allAnnouncements ? String(Object.values(d.allAnnouncements).reduce((n, l) => n + l.length, 0)) : "…")}
      ${kv("Music", d.media ? String(d.media.music?.length ?? 0) : "…")}
      ${kv("Ambience", d.media ? String(d.media.ambience?.length ?? 0) : "…")}
      ${kv("Background videos", d.media ? String(d.media.video?.length ?? 0) : "…")}`)}`;
}

class ExplorerInspector extends HTMLElement {
  constructor() {
    super();
    this._key = null;
    this._pick = null;
  }

  set store(s) { this._store = s; this.render(); }
  set pick(doc) { this._pick = doc; this.render(); }

  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${explorerCSS}${STYLE}</style>
      <div class="dock" hidden><span class="dock-l"></span><div class="dock-host"></div><button data-act="dock-close" aria-label="Stop and close player">✕</button></div>
      <div class="body" tabindex="-1" aria-live="polite"></div>`;
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    this.shadowRoot.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.shadowRoot.querySelector(".dock").hidden) this._closeDock();
      if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("[data-toggle-clamp]")) { e.preventDefault(); e.target.classList.toggle("open"); }
    });
    this.render();
  }

  disconnectedCallback() { stopPreview(); }

  render() {
    const store = this._store;
    const root = this.shadowRoot;
    if (!store || !root) return;
    const body = root.querySelector(".body");
    const ent = entityOf(store, this._pick);
    const changed = ent.key !== this._key;
    const scroll = body.scrollTop;
    this._key = ent.key;

    let html;
    try {
      html = ({
        pick: () => renderPick(store, this._pick),
        asset: () => ent.asset.kind === "bump" ? renderBump(store, ent.asset.id) : ent.asset.kind === "announcement" ? renderAnnouncement(store, ent.asset.channelId, ent.asset.id) : renderMedia(store, ent.asset.path),
        production: () => renderProduction(store),
        airing: () => renderAiring(store),
        episode: () => renderEpisode(store),
        series: () => renderSeries(store),
        channel: () => renderChannel(store),
        overview: () => renderOverview(store),
      })[ent.type]();
    } catch (err) {
      console.error("explorer inspector render failed", err);
      html = `<div class="sec"><p class="note bad">This panel could not be drawn: ${esc(err.message)}</p></div>`;
    }

    // Carry persisted stages (a playing preview) across a same-entity re-render.
    const old = new Map([...body.querySelectorAll("[data-persist]")].map((e) => [e.dataset.persist, e]));
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const nextKeys = new Set();
    tpl.content.querySelectorAll("[data-persist]").forEach((n) => {
      nextKeys.add(n.dataset.persist);
      const prev = old.get(n.dataset.persist);
      if (prev && activePreviewKey() === n.dataset.persist) n.replaceWith(prev);
    });
    if (changed || (activePreviewKey() && !nextKeys.has(activePreviewKey()) && !String(activePreviewKey()).startsWith("dock:"))) stopPreview(), this._closeDock(true);
    body.replaceChildren(tpl.content);
    body.scrollTop = changed ? 0 : scroll;
    this._wireWaves();
  }

  async _wireWaves() {
    for (const el of this.shadowRoot.querySelectorAll("[data-wave]")) {
      if (el.dataset.done) continue;
      el.dataset.done = "1";
      // waveformUrl() returns a CSS `url("data:...")` value: a background image, not an <img> src.
      audioPeaks(el.dataset.wave).then((peaks) => { el.style.backgroundImage = waveformUrl(peaks, "rgba(147,197,253,.85)"); el.hidden = false; }).catch(() => {});
    }
  }

  // ---- interactions ----

  _onClick(e) {
    const clamp = e.target.closest("[data-toggle-clamp]");
    if (clamp) { clamp.classList.toggle("open"); return; }
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const store = this._store;
    switch (el.dataset.act) {
      case "preview-episode": return void this._previewEpisode(el);
      case "preview-airing": return void this._previewAiring(el);
      case "preview-at-time": return void this._previewAtTime();
      case "preview-bump": return void this._previewBump(el);
      case "preview-announcement": return void this._playDock(el.dataset.url, el.title || "Voiceover");
      case "preview-media-audio": return void this._playDock(el.dataset.url, el.dataset.url.split("/").pop());
      case "dock-close": return void this._closeDock();
      case "scroll-sec": this.shadowRoot.querySelector(`[data-sec="${CSS.escape(el.dataset.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }); return;
      case "view-schedule":
        store.go({ series: null, episode: null, airing: null, channel: el.dataset.channel });
        this.dispatchEvent(new CustomEvent("explorer-focus-col", { detail: { id: "schedule" }, bubbles: true, composed: true }));
        return;
      case "focus-col":
        if (el.dataset.id === "airings" && store.route.episode) store.go({ episode: null, airing: null });
        this.dispatchEvent(new CustomEvent("explorer-focus-col", { detail: { id: el.dataset.id }, bubbles: true, composed: true }));
        return;
      case "jump-airing": if (el.dataset.id) store.selectAiring(store.route.channel, Number(el.dataset.id)); return;
      case "copy-text": navigator.clipboard?.writeText(el.dataset.text || "").then(() => { el.textContent = "Copied"; }, () => {}); return;
      case "search-open": store.open(JSON.parse(el.dataset.open)); return;
      default: runAction(store, el);
    }
  }

  _stage(el) {
    const stage = el.closest(".stage") || this.shadowRoot.querySelector(".stage");
    return { stage, host: stage?.querySelector("[data-host]"), msg: stage?.querySelector("[data-msg]"), key: stage?.dataset.persist };
  }

  _say(msg, text, tone = "") { if (msg) { msg.textContent = text; msg.dataset.tone = tone; } }

  async _previewEpisode(el) {
    const s = this._store;
    const { host, msg, key } = this._stage(el);
    const ep = s.seriesDetail()?.episodes.find((e) => e.id === s.route.episode);
    const play = ep && episodePlayability(ep);
    if (!host || !play?.ok) return this._say(msg, play?.reason || "Nothing to preview.", "bad");
    this._say(msg, "Loading preview… (this plays the episode itself, not a scheduled airing)");
    const r = await previewVideo(host, key, play.source, 0, { onState: (st, m) => this._say(msg, stateText(st, m), st === "error" ? "bad" : "") });
    if (!r.ok) this._say(msg, r.message, "bad");
  }

  async _previewAiring(el) {
    const s = this._store;
    const { host, msg, key } = this._stage(el);
    const { ctx } = resolveAiringView(s);
    if (!host || !ctx) return;
    const a = ctx.airing;
    const t = s.effectiveT();
    const offset = t >= a.startsAt && t < a.endsAt ? Math.min(t - a.startsAt, Math.max(0, a.duration - 1)) : 0;
    this._say(msg, offset ? `Loading this airing from +${fmtDuration(offset)}…` : "Loading this airing from the start…");
    const r = await previewVideo(host, key, { provider: a.provider, videoId: a.videoId, mediaUrl: a.mediaUrl }, offset, { onState: (st, m) => this._say(msg, stateText(st, m), st === "error" ? "bad" : "") });
    if (!r.ok) this._say(msg, r.message, "bad");
  }

  /** The selected channel at the selected instant: a bump overlay if a rule has one open, else the scheduled program/continuity. Read-only; nothing real is touched. */
  async _previewAtTime() {
    const s = this._store;
    const { host, msg, key } = this._stage(this.shadowRoot.querySelector(".stage") || this.shadowRoot);
    const channelId = s.route.channel;
    const sv = s.scheduleView(channelId);
    const ch = s.channel(channelId);
    if (!host || !sv) return;
    const t = s.effectiveT();
    const at = M.locateAt(sv, t);
    if (at.state !== "ok") return this._say(msg, "That time is outside the published schedule, so there is nothing to preview (Explorer does not invent airings).", "bad");
    const clock = virtualClock(t);
    const info = { name: ch?.name, logo: ch?.logoUrl, theme: ch?.theme };
    const upcoming = M.channelAirings(sv, t, t + 12 * 3600, { limit: 8 }).filter((a) => a.startsAt > t).map((a) => ({ title: a.title, startsAt: a.startsAt }));
    const bs = s.data.bumpSchedule.get(channelId);
    const active = M.activeBumpAt(bs, t);
    const def = active && (s.data.bumps || []).find((b) => b.id === active.bumpId);
    if (def) {
      previewBump(host, key, { definition: def, upcoming, channel: info, offset: t - active.startsAt, clockNow: clock, muted: false });
      return this._say(msg, `Bump overlay “${def.name || def.id}” at +${fmtDuration(t - active.startsAt)}. It would cover the program underneath, which keeps its own timing.`);
    }
    const e = at.entry;
    if (e.kind === "video") {
      this._say(msg, `Program at ${new Date(t * 1000).toLocaleTimeString()}, from +${fmtDuration(at.offset)}…`);
      const r = await previewVideo(host, key, { provider: e.provider, videoId: e.videoId, mediaUrl: e.mediaUrl }, at.offset, { onState: (st, m) => this._say(msg, stateText(st, m), st === "error" ? "bad" : "") });
      if (!r.ok) this._say(msg, r.message, "bad");
    } else if (e.kind === "continuity") {
      const next = M.channelAirings(sv, e.endsAt, e.endsAt + 3600, { limit: 1 })[0];
      const anns = s.data.announcements.get(channelId) || [];
      const audio = findAnnouncementAudio(anns, { id: e.id, nextProgramId: e.nextProgramId });
      const theme = await getBumperTheme(channelId).catch(() => null);
      previewContinuity(host, key, {
        channel: info, clockNow: clock, cardSpan: { startsAt: e.startsAt, endsAt: e.endsAt }, template: e.template, bumperTheme: theme,
        program: next ? { title: next.title, description: next.description, thumbnailUrl: next.thumbnailUrl, startsAt: next.startsAt } : null,
        audioUrl: audio ? mediaUrl(audio) : null,
      });
      this._say(msg, "Published continuity card, rendered by the channel's own card component.");
    } else {
      this._say(msg, "Nothing is scheduled at that instant (a gap).", "bad");
    }
  }

  _previewBump(el) {
    const s = this._store;
    const { host, msg, key } = this._stage(el);
    const asset = s.route.asset;
    const def = (s.data.bumps || []).find((b) => b.id === asset?.id);
    if (!host || !def) return;
    const t = s.effectiveT();
    const ch = previewChannelFor(s, def.id);
    const sv = ch && s.scheduleView(ch.id);
    const upcoming = sv ? M.channelAirings(sv, t, t + 12 * 3600, { limit: 8 }).filter((a) => a.startsAt > t).map((a) => ({ title: a.title, startsAt: a.startsAt })) : [];
    previewBump(host, key, { definition: def, upcoming, channel: ch ? { name: ch.name, logo: ch.logoUrl, theme: ch.theme } : null, clockNow: virtualClock(t), muted: false, loop: true });
    this._say(msg, "Previewing with the existing bump renderer (looping). Nothing is saved or aired.");
  }

  _playDock(path, label) {
    const url = mediaUrl(path);
    const dock = this.shadowRoot.querySelector(".dock");
    if (!url) { dock.hidden = false; dock.querySelector(".dock-l").textContent = "That audio location is not approved."; return; }
    dock.hidden = false;
    dock.querySelector(".dock-l").textContent = label.length > 70 ? `${label.slice(0, 70)}…` : label;
    const audio = previewAudio(dock.querySelector(".dock-host"), `dock:${path}`, url);
    audio.addEventListener("error", () => { dock.querySelector(".dock-l").textContent = "The audio file could not be played."; });
  }

  closeDock(quiet = false) { this._closeDock(quiet); }

  _closeDock(quiet = false) {
    const dock = this.shadowRoot?.querySelector(".dock");
    if (!dock || dock.hidden) return;
    if (String(activePreviewKey() || "").startsWith("dock:")) stopPreview();
    dock.hidden = true;
    if (!quiet) this.dispatchEvent(new CustomEvent("explorer-dock-closed", { bubbles: true, composed: true }));
  }
}

const stateText = (state, message) => ({
  loading: "Loading…", buffering: "Buffering…", playing: "Playing (preview only)", ended: "Preview ended", blocked: "The browser or provider blocked autoplay — press play in the player.",
  error: message || "The provider could not play this video.",
})[state] || "";

const STYLE = `
  :host{ display:flex; flex-direction:column; min-height:0; height:100%; background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); overflow:hidden; }
  .body{ flex:1; min-height:0; overflow-y:auto; outline:0; }
  .dock{ display:flex; align-items:center; gap:10px; padding:8px 12px; background:var(--panel-3); border-bottom:1px solid var(--border); }
  .dock-l{ font-size:12px; color:var(--text-muted); max-width:34%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dock-host{ flex:1; min-width:0; } .dock-host audio{ width:100%; height:32px; }
  .hero{ display:flex; gap:12px; align-items:center; padding:14px; background:linear-gradient(120deg, color-mix(in srgb, var(--hero, var(--accent)) 24%, var(--panel)), var(--panel)); }
  .hero .grow{ flex:1; min-width:0; } h2{ margin:0; font-size:19px; line-height:1.2; }
  .sub{ color:var(--text-muted); font-size:12.5px; margin-top:3px; }
  .sub code, code{ font-family:var(--mono); font-size:11.5px; color:var(--text-muted); }
  .eyebrow-line{ font-size:10.5px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px; }
  .ep-title{ margin:0; font-size:20px; line-height:1.2; }
  .desc{ margin:0; padding:10px 14px; font-size:13px; line-height:1.5; color:#cfd6e4; }
  .sec .desc{ padding:0; }
  .desc.clamp{ display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; cursor:pointer; }
  .desc.clamp.open{ display:block; }
  .cell-link{ background:transparent; border:0; padding:0; color:var(--accent); cursor:pointer; font-size:inherit; text-align:left; }
  .cell-link:hover{ text-decoration:underline; }
  i.sw{ display:inline-block; width:11px; height:11px; border-radius:3px; border:1px solid rgba(255,255,255,.25); vertical-align:-1px; margin-right:5px; }
  .kv-wrap{ margin-bottom:4px; }

  .stage{ margin:0 14px 12px; }
  .stage .host{ position:relative; width:100%; aspect-ratio:16/9; background:#05070b; border-radius:8px; overflow:hidden; border:1px solid var(--border-soft); }
  .stage .host > img{ position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:.9; }
  .stage .player-box{ position:absolute; inset:0; } .stage .player-box iframe, .stage .player-box video{ width:100%; height:100%; border:0; }
  .bigplay{ position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:58px; height:58px; border-radius:50%; display:grid; place-items:center; padding:0; background:rgba(11,13,19,.7); border:2px solid rgba(255,255,255,.8); color:#fff; z-index:2; }
  .bigplay svg{ width:24px; height:24px; margin-left:3px; } .bigplay:hover{ background:var(--accent); border-color:var(--accent); }
  .bigplay.sm{ position:static; transform:none; width:40px; height:40px; flex:0 0 auto; } .bigplay.sm svg{ width:18px; height:18px; }
  .noplay{ position:absolute; inset:0; display:grid; place-items:center; text-align:center; padding:16px; font-size:12.5px; color:#cfd6e4; background:rgba(5,7,11,.7); }
  .stage-msg{ min-height:18px; font-size:12px; color:var(--text-muted); padding-top:6px; } .stage-msg[data-tone="bad"]{ color:#ffb4b4; }
  .bump-poster{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; padding-bottom:12%; gap:6px; background:radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--stage-accent) 40%, #05070b), #05070b 70%); text-align:center; padding:16px; }
  .bump-poster b{ font-size:22px; } .bump-poster span{ color:var(--text-muted); font-size:13px; }
  .audio-card{ margin:0; } .audio-host{ display:flex; align-items:center; gap:12px; background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:8px; padding:10px; min-height:60px; }
  .audio-host audio{ flex:1; min-width:0; } .wave{ flex:1; min-width:0; height:40px; background-size:100% 100%; background-repeat:no-repeat; opacity:.9; }
  .media-el{ width:100%; border-radius:8px; max-height:300px; background:#05070b; }

  .triple{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
  .triple > div{ background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:8px; padding:8px 10px; display:flex; flex-direction:column; gap:2px; min-width:0; }
  .triple .lbl{ display:flex; align-items:center; gap:5px; font-size:10.5px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; }
  .triple .big{ font-size:15px; font-weight:700; } .triple .faint{ font-size:11.5px; }
  .tl{ position:relative; padding-top:22px; } .tl-track{ position:relative; height:44px; background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:6px; overflow:visible; }
  .tl-track .seg{ position:absolute; top:3px; bottom:3px; border-radius:4px; background:var(--accent-dim); color:#fff; font-size:11px; overflow:hidden; display:flex; align-items:center; padding:0 6px; white-space:nowrap; border:1px solid rgba(255,255,255,.12); min-width:2px; }
  .tl-track .seg[data-kind="continuity"]{ background:#5b3fb5; } .tl-track .seg[data-kind="gap"]{ background:repeating-linear-gradient(45deg,#3a2f12,#3a2f12 6px,#2a2410 6px,#2a2410 12px); }
  .tl-track .seg[data-role="previous"], .tl-track .seg[data-role="next"]{ opacity:.55; } .tl-track .seg[data-sel="true"]{ background:var(--accent); outline:2px solid #fff; z-index:1; }
  .tl-track .seg span{ overflow:hidden; text-overflow:ellipsis; }
  .tl-axis{ display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted); margin-top:3px; font-variant-numeric:tabular-nums; }
  .tl-label{ font-size:11px; color:var(--text-muted); margin:10px 0 4px; } .tl-ov{ height:20px; }
  .tl-ov .ov{ position:absolute; top:3px; bottom:3px; background:#f59e0b; border-radius:3px; opacity:.9; min-width:3px; } .tl-ov .ov[data-shadowed="true"]{ background:repeating-linear-gradient(45deg,#f59e0b,#f59e0b 3px,#7a4d07 3px,#7a4d07 6px); opacity:.6; }
  .tl-none{ font-size:11.5px; margin-top:4px; }
  .marker{ position:absolute; top:-4px; bottom:-4px; width:2px; background:#fff; z-index:3; box-shadow:0 0 6px rgba(255,255,255,.7); }
  .marker span{ position:absolute; top:-18px; left:50%; transform:translateX(-50%); background:#fff; color:#0b0d13; font-size:10.5px; font-weight:800; padding:1px 5px; border-radius:4px; white-space:nowrap; }
  .marker.end span{ left:auto; right:-2px; transform:none; }
  table.mini tr[data-sel="true"]{ background:var(--accent-soft); }
  .ann{ display:flex; align-items:flex-start; gap:10px; padding:8px 0; border-bottom:1px solid var(--border-soft); } .ann:last-child{ border-bottom:0; }
  .ann > button{ padding:6px 8px; flex:0 0 auto; } .ann .grow{ flex:1; min-width:0; } .script-s{ font-size:13px; font-style:italic; }
  .strip{ display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; } .strip-item{ flex:0 0 96px; background:transparent; border:0; padding:0; text-align:left; font-size:11px; color:var(--text-muted); }
  .strip-item .thumb{ width:96px; height:54px; } .strip-item span:last-child{ display:block; margin-top:3px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
`;

customElements.define("explorer-inspector", ExplorerInspector);
