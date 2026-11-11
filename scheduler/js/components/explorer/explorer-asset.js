// explorer-asset.js -- inspectors for production assets: bumps, announcement
// clips and raw media files. Bumps render through the existing <cr-bump>
// (see explorer-media.js); nothing here regenerates narration or edits an asset.

import * as M from "./explorer-model.js";
import { mediaUrl } from "./explorer-api.js";
import { esc, pill, kv, section, emptyNote, btn, icons, fmtDateTime, fmtDuration, fmtBytes, notRecorded, titleCase } from "./explorer-ui.js";
import { ruleText } from "./explorer-channel.js";
import { effectiveDuration, bumpDuration } from "../../../../channels/bump-player.js";

const mediaLink = (path, label) => {
  const url = mediaUrl(path);
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label || path.split("/").pop())} ↗</a>` : esc(path);
};
const assetBtn = (ref, label) => `<button class="cell-link" data-act="nav-asset" data-asset="${esc(ref)}">${esc(label)}</button>`;

/** The announcement record (if any) whose audio file a bump embeds. */
function announcementByUrl(store, url) {
  const key = M.normalizeMediaPath(url);
  if (!key || !store.data.allAnnouncements) return null;
  for (const [channelId, list] of Object.entries(store.data.allAnnouncements)) {
    const rec = list.find((a) => M.normalizeMediaPath(a.audio) === key);
    if (rec) return { ...rec, channelId };
  }
  return null;
}

/** The channel whose published schedule feeds a bump's preview "upcoming" list: the selected one if it uses
 *  the bump, else the first channel with a rule for it. null if none (the list is then empty, never invented). */
export function previewChannelFor(store, bumpId) {
  const usage = store.indexes().bumpUsage.get(bumpId) || [];
  const pick = usage.find((u) => u.channelId === store.route.channel) || usage[0];
  return pick ? store.channel(pick.channelId) : null;
}

export function renderBump(store, id) {
  const bump = (store.data.bumps || []).find((b) => b.id === id);
  if (!bump) return store.data.bumps ? `<div class="sec"><p class="note bad">No bump with id <code>${esc(id)}</code>.</p></div>` : `<div class="sec"><p class="empty">Loading bump…</p></div>`;
  const idx = store.indexes();
  const usage = idx.bumpUsage.get(id) || [];
  const t = store.effectiveT();
  const ann = bump.announcement?.url ? announcementByUrl(store, bump.announcement.url) : null;
  const duration = bumpDuration(bump);
  const previewCh = previewChannelFor(store, id);
  const accent = bump.style?.accent || "var(--accent)";

  const stage = `
    <div class="stage" data-persist="bump:${esc(id)}" style="--stage-accent:${esc(accent)}">
      <div class="host" data-host>
        <div class="bump-poster"><b>${esc(bump.name || id)}</b><span>${esc(bump.upcoming?.label || "")}</span></div>
        <button class="bigplay" data-act="preview-bump" aria-label="Preview bump" title="Preview with the existing bump renderer (sound after this click)">${icons.play}</button>
      </div>
      <div class="stage-msg" data-msg aria-live="polite"></div>
    </div>`;

  const layers = (bump.audio || []).map((a) => `
      ${kv(titleCase(a.source || "audio") + " layer", `${mediaLink(a.url)} <span class="faint">vol ${Math.round((a.volume ?? 1) * 100)}%</span> ${assetBtn(`media:${M.normalizeMediaPath(a.url)}`, "inspect")}`)}`).join("");
  const bg = bump.background
    ? bump.background.url ? kv("Background", `${esc(titleCase(bump.background.type))} · ${mediaLink(bump.background.url)} ${assetBtn(`media:${M.normalizeMediaPath(bump.background.url)}`, "inspect")}`)
      : kv("Background", `${esc(titleCase(bump.background.type))}${bump.background.color ? ` · <i class="sw" style="background:${esc(bump.background.color)}"></i>${esc(bump.background.color)}` : ""}`)
    : kv("Background", notRecorded);

  const details = section("Composition", `
    ${bg}
    ${layers || kv("Music / ambience", notRecorded)}
    ${kv("Announcement clip", bump.announcement?.url ? `${mediaLink(bump.announcement.url)}${bump.announcement.channelId ? ` <span class="faint">from ${esc(bump.announcement.channelId)}</span>` : ""}${ann ? ` ${assetBtn(`announcement:${ann.channelId}:${ann.id}`, "inspect")}` : ""}` : "None")}
    ${kv("Upcoming overlay", bump.upcoming ? `${esc(bump.upcoming.label || "Up next")} · ${esc(bump.upcoming.count)} shows` : "Not configured")}
    ${kv("Duration", duration ? esc(fmtDuration(duration)) : `<span class="faint">Not set (schema v1) — the schedule rule decides how long it runs; previews use ${effectiveDuration(bump)}s</span>`)}
    ${bump.updatedAt ? kv("Updated", esc(fmtDateTime(Date.parse(bump.updatedAt) / 1000))) : ""}
  `);

  const script = ann?.text ? section("Spoken script", `<p class="script">${esc(ann.text)}</p>
      <div class="faint" style="margin-top:6px">${esc(titleCase(ann.type))} · ${esc(ann.voice || "voice not recorded")} · ${ann.duration ? esc(fmtDuration(ann.duration)) : "duration not recorded"}</div>`)
    : bump.announcement?.url ? section("Spoken script", emptyNote("The clip's script isn't available (no matching announcement record is loaded).")) : "";

  const used = usage.length ? usage.map((u) => `
      <div class="linkrow" style="cursor:default">
        <span class="grow"><button class="cell-link" data-act="nav-channel" data-id="${esc(u.channelId)}"><span class="t">${esc(u.channelName)}</span></button>
        <span class="s">${esc(ruleText(u.rule))}${u.enabled ? "" : " · channel's bump scheduling is OFF"}</span></div>
        <button class="cell-link" data-act="open-bump-schedule" data-channel="${esc(u.channelId)}">Rule in Bump Studio</button>
      </div>`).join("") : emptyNote(store.data.bumpSchedules ? "No channel's bump schedule references this bump." : "Loading schedules…");

  const upNote = previewCh ? `Preview “up next” uses ${esc(previewCh.name)}'s real published schedule from the selected time.` : "No channel schedules this bump, so the preview shows no upcoming list (it is never invented).";

  return `
    <div class="sec"><div class="eyebrow-line">BUMP / INTERSTITIAL</div><h2 class="ep-title">${esc(bump.name || id)}</h2>
      <div class="sub"><code>${esc(id)}</code>${bump.description ? ` · ${esc(bump.description)}` : ""}</div></div>
    ${stage}
    <div class="sec" style="padding-top:0"><p class="note">${upNote}</p></div>
    ${details}
    ${script}
    ${section("Used by channels (schedule rules)", used, { count: usage.length, id: "usage" })}
    <div class="actions">
      ${btn("open-bump-studio", "Open in Bump Studio", { id, primary: true, icon: icons.bump })}
      ${ann?.audio ? btn("preview-announcement", "Preview Voiceover", { attrs: `data-url="${esc(ann.audio)}"`, icon: icons.voice }) : ""}
      ${btn("scroll-sec", "View Schedule Usage", { id: "usage", icon: icons.calendar })}
    </div>`;
}

export function renderAnnouncement(store, channelId, id) {
  const idx = store.indexes().announcements;
  const rec = idx.byKey.get(`${channelId}:${id}`);
  if (!rec) return store.data.allAnnouncements || store.data.announcements.has(channelId) ? `<div class="sec"><p class="note bad">No announcement <code>${esc(id)}</code> on channel <code>${esc(channelId)}</code>.</p></div>` : `<div class="sec"><p class="empty">Loading announcement…</p></div>`;
  const ch = store.channel(channelId);
  const sv = store.scheduleView(channelId);
  const tr = sv ? M.announcementTransition(sv, rec) : null;
  const bumps = M.bumpsUsingAnnouncement(store.data.bumps || [], rec);
  const url = rec.audio ? mediaUrl(rec.audio) : null;
  const airing = tr && sv ? M.findAiring(sv, tr.continuity.endsAt) : null;

  const transition = tr ? `
      ${kv("Transition", `<code>${esc(rec.transitionId)}</code>`)}
      ${kv("Continuity slot", `${esc(fmtDateTime(tr.continuity.startsAt, true))} · ${esc(fmtDuration(tr.continuity.endsAt - tr.continuity.startsAt))}`)}
      ${kv("Leads into", airing ? `<button class="cell-link" data-act="nav-airing" data-channel="${esc(channelId)}" data-start="${airing.entry.startsAt}">${esc(airing.entry.title)}</button> <span class="faint">${esc(fmtDateTime(airing.entry.startsAt))}</span>` : tr.programTitle ? esc(tr.programTitle) : notRecorded)}`
    : `${kv("Transition", rec.transitionId ? `<code>${esc(rec.transitionId)}</code>` : "Channel-level (not tied to one program)")}
       ${rec.transitionId ? `<p class="note">Not found in the published window${sv ? "" : " (schedule not loaded)"} — it may belong to a past or future schedule.</p>` : ""}`;

  return `
    <div class="sec"><div class="eyebrow-line">ANNOUNCEMENT · VOICEOVER</div><h2 class="ep-title">${esc(titleCase(rec.type))}</h2>
      <div class="sub"><button class="cell-link" data-act="nav-channel" data-id="${esc(channelId)}">${esc(ch?.name || channelId)}</button> · <code>${esc(rec.id)}</code></div></div>
    <div class="sec">
      <div class="audio-card" data-persist="announcement:${esc(channelId)}:${esc(rec.id)}">
        <div data-host class="audio-host">${url ? `<button class="bigplay sm" data-act="preview-announcement" data-url="${esc(rec.audio)}" aria-label="Play voiceover">${icons.play}</button>` : `<span class="faint">No audio file${rec.status && rec.status !== "ready" ? ` (${esc(rec.status)})` : ""}.</span>`}
          ${url ? `<div class="wave" role="img" aria-label="Waveform" data-wave="${esc(M.normalizeMediaPath(rec.audio))}" hidden></div>` : ""}</div>
        <div class="stage-msg" data-msg aria-live="polite"></div>
      </div>
    </div>
    ${section("Script", rec.text ? `<p class="script">${esc(rec.text)}</p><div class="chips" style="margin-top:8px"><button class="chip" data-act="copy-text" data-text="${esc(rec.text)}">Copy script</button></div>` : emptyNote("No script recorded."))}
    ${section("Details", `
      ${kv("Status", pill(titleCase(rec.status || "unknown"), rec.status === "ready" ? "good" : "warn"))}
      ${kv("Voice", rec.voice ? esc(rec.voice) : notRecorded)}
      ${kv("Duration", rec.duration ? esc(fmtDuration(rec.duration, { ms: true })) : notRecorded)}
      ${kv("Audio file", rec.audio ? mediaLink(rec.audio) : notRecorded)}
      ${kv("Target episode", rec.toEpisodeId ? `<code>${esc(rec.toEpisodeId)}</code>` : notRecorded)}`)}
    ${section("Associated transition", transition)}
    ${section("Used by bumps", bumps.length ? bumps.map((b) => `<button class="linkrow" data-act="nav-asset" data-asset="bump:${esc(b.id)}"><span class="grow"><span class="t">${esc(b.name || b.id)}</span></span></button>`).join("") : emptyNote("No bump embeds this clip."), { count: bumps.length })}
    <div class="actions">
      ${url ? btn("preview-announcement", "Preview Voiceover", { primary: true, attrs: `data-url="${esc(rec.audio)}"`, icon: icons.voice }) : ""}
      ${airing ? btn("nav-airing", "Open Airing", { attrs: `data-channel="${esc(channelId)}" data-start="${airing.entry.startsAt}"`, icon: icons.clock }) : ""}
      ${btn("open-programming", "Announcer Controls (Programming)", { attrs: `data-channel="${esc(channelId)}"`, icon: icons.calendar })}
    </div>
    <p class="note" style="margin:0 14px 14px">Explorer plays the existing clip only. It never regenerates narration.</p>`;
}

export function mediaKind(path) {
  const m = /^media\/(video|music|ambience|image)\//.exec(path || "");
  if (m) return m[1];
  if (/\.(mp4|webm|mov)$/i.test(path)) return "video";
  if (/\.(mp3|wav|ogg|m4a)$/i.test(path)) return "music";
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) return "image";
  return "other";
}

export function renderMedia(store, path) {
  const file = store.data.media ? Object.values(store.data.media).flat().find((m) => m && m.url === path) : null;
  const kind = mediaKind(path);
  const url = mediaUrl(path);
  if (!url) return `<div class="sec"><p class="note bad">That media location is not an approved path.</p></div>`;
  const idx = store.indexes();
  const uses = idx.mediaUsage.get(M.normalizeMediaPath(path)) || [];
  const bumps = new Map((store.data.bumps || []).map((b) => [b.id, b]));
  const preview = kind === "video" ? `<video class="media-el" controls preload="metadata" src="${esc(url)}"></video>`
    : kind === "image" ? `<img class="media-el" src="${esc(url)}" alt="">`
    : kind === "music" || kind === "ambience" ? `<div data-persist="media:${esc(path)}"><div data-host class="audio-host"><button class="bigplay sm" data-act="preview-media-audio" data-url="${esc(path)}" aria-label="Play audio">${icons.play}</button><div class="wave" role="img" aria-label="Waveform" data-wave="${esc(path)}" hidden></div></div><div class="stage-msg" data-msg aria-live="polite"></div></div>`
    : `<p class="empty">No inline preview for this file type.</p>`;
  const channels = new Map();
  for (const u of uses) for (const cu of idx.bumpUsage.get(u.bumpId) || []) channels.set(cu.channelId, cu.channelName);
  return `
    <div class="sec"><div class="eyebrow-line">MEDIA ASSET · ${esc(kind.toUpperCase())}</div><h2 class="ep-title">${esc(path.split("/").pop())}</h2><div class="sub"><code>${esc(path)}</code></div></div>
    <div class="sec">${preview}</div>
    ${section("Details", `
      ${kv("Type", esc(titleCase(kind)))}
      ${kv("Size", file?.bytes != null ? esc(fmtBytes(file.bytes)) : notRecorded)}
      ${kv("File", mediaLink(path, "open file"))}
      <p class="note">Only repository metadata is shown (no duration/LUFS/codec analysis is performed).</p>`)}
    ${section("Used by bumps", uses.length ? uses.map((u) => `<button class="linkrow" data-act="nav-asset" data-asset="bump:${esc(u.bumpId)}"><span class="grow"><span class="t">${esc(bumps.get(u.bumpId)?.name || u.bumpId)}</span><span class="s">as ${esc(u.role)}</span></span></button>`).join("") : emptyNote(store.data.bumps ? "No bump references this file." : "Loading…"), { count: uses.length })}
    ${channels.size ? section("Reaches channels (via those bumps' schedule rules)", `<div class="chips">${[...channels].map(([id, name]) => `<button class="chip" data-act="nav-channel" data-id="${esc(id)}">${icons.channel}${esc(name)}</button>`).join("")}</div>`) : ""}`;
}
