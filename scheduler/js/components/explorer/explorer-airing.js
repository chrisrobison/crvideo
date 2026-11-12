// explorer-airing.js -- the Airing Inspector with Time Travel. An airing is a
// scheduled occurrence identified by (channel, start); it is rendered from the
// published schedule only. Two different mechanisms are kept apart:
//   * published continuity items occupy scheduled time (they are real items in the
//     schedule), shown on the program timeline;
//   * clock-triggered bump rules draw OVER the program and never shift it, shown
//     as a separate overlay layer.

import * as M from "./explorer-model.js";
import { esc, pill, kv, section, emptyNote, btn, icons, fmtDateTime, fmtTime, fmtDuration, notRecorded, titleCase } from "./explorer-ui.js";
import { episodePlayability, stageHtml } from "./explorer-episode.js";
import { ruleText } from "./explorer-channel.js";

export function resolveAiringView(store) {
  const { channel, airing } = store.route;
  const sv = store.scheduleView(channel);
  const anns = store.data.announcements.get(channel) || [];
  const ctx = sv ? M.airingContext(sv, airing, anns) : null;
  return { sv, ctx, anns };
}

export function renderAiring(store) {
  const { channel: channelId, airing: start } = store.route;
  const c = store.channel();
  const { sv, ctx } = resolveAiringView(store);
  if (!sv) {
    const err = store.data.scheduleErrors.get(channelId);
    return `<div class="sec"><p class="${err ? "note bad" : "empty"}">${err ? esc(err) : "Loading the published schedule…"}</p></div>`;
  }
  if (!ctx) {
    return `<div class="sec"><p class="note bad"><b>Airing not found.</b> No playable airing starts at ${esc(fmtDateTime(start, true))} on
      ${esc(c?.name || channelId)} in its published schedule${sv.window ? ` (${esc(fmtDateTime(sv.window.start))} → ${esc(fmtDateTime(sv.window.end))})` : ""}.
      Explorer does not guess at unpublished airings.</p></div>`;
  }

  const a = ctx.airing;
  const t = store.effectiveT();
  const inside = t >= a.startsAt && t < a.endsAt;
  const bs = store.data.bumpSchedule.get(channelId);
  const bumpDefs = new Map((store.data.bumps || []).map((b) => [b.id, b]));
  const detail = a.seriesId ? store.seriesDetail(a.seriesId) : null;
  const ep = detail?.episodes.find((e) => e.id === a.id) || null;
  const seriesTitle = ctx.program?.seriesTitle || detail?.title || null;
  const play = ep ? episodePlayability(ep) : a.provider === "youtube" && a.videoId ? { ok: true, source: { provider: "youtube", videoId: a.videoId } } : a.mediaUrl ? { ok: true, source: { provider: "html5", mediaUrl: a.mediaUrl } } : { ok: false, reason: "No playable source." };

  const mode = store.timeMode();
  const label = mode === "travel" ? "Time travel" : "Airing start";
  const head = `
    <div class="sec">
      <div class="eyebrow-line">INSPECTING AIRING · ${esc(label.toUpperCase())}</div>
      <h2 class="ep-title">${esc(a.title)}</h2>
      <div class="sub">${a.seriesId ? `<button class="cell-link" data-act="nav-series" data-id="${esc(a.seriesId)}" data-channel="${esc(channelId)}">${esc(seriesTitle || a.seriesId)}</button> · ` : ""}
        <button class="cell-link" data-act="nav-channel" data-id="${esc(channelId)}">${esc(c?.name || channelId)}</button>
        ${a.seriesId ? ` · <button class="cell-link" data-act="nav-episode" data-series="${esc(a.seriesId)}" data-id="${esc(a.id)}" data-channel="${esc(channelId)}">episode details</button>` : ""}</div>
    </div>`;

  const offsetHtml = inside
    ? `<b class="big tnum">+${esc(fmtDuration(t - a.startsAt, { ms: true }))}</b><span class="faint">of ${esc(fmtDuration(a.duration, { ms: true }))}</span>`
    : t < a.startsAt
      ? `<b class="big">Not started</b><span class="faint">${esc(fmtDuration(a.startsAt - t))} before this airing</span>`
      : `<b class="big">Ended</b><span class="faint">${esc(fmtDuration(t - a.endsAt))} after it ended</span>`;
  const triple = `
    <div class="sec triple">
      <div><span class="lbl">${icons.calendar} Airing window</span><b class="big tnum">${esc(fmtTime(a.startsAt, true))} – ${esc(fmtTime(a.endsAt, true))}</b><span class="faint">${esc(fmtDuration(a.duration))} · ${esc(fmtDateTime(a.startsAt).split(",")[0])}</span></div>
      <div><span class="lbl">${icons.clock} Offset at ${mode === "travel" ? "selected time" : "airing start"}</span>${offsetHtml}</div>
      <div><span class="lbl">${icons.clock} ${esc(label)}</span><b class="big tnum">${esc(fmtTime(t, true))}</b><span class="faint">${mode === "travel" ? esc(fmtDateTime(t).split(",").slice(0, 2).join(",")) : "Pick a time with Jump to inspect another instant"}</span></div>
    </div>`;

  // --- timeline ---
  const { from, to } = ctx;
  const span = Math.max(1, to - from);
  const pct = (x) => `${(((x - from) / span) * 100).toFixed(3)}%`;
  const wpct = (s, e) => `${(((e - s) / span) * 100).toFixed(3)}%`;
  const overlays = bs ? M.bumpOverlays(bs, from, to) : [];
  const seg = ctx.segments.map((s) => `
      <div class="seg" data-kind="${s.role === "program" ? "video" : s.kind}" data-role="${s.role}" data-sel="${s.selected}" style="left:${pct(s.startsAt)};width:${wpct(s.startsAt, s.endsAt)}"
        title="${esc((s.kind === "continuity" ? "Continuity: " : "") + (s.title || s.template || s.kind))} · ${esc(fmtTime(s.startsAt, true))}–${esc(fmtTime(s.endsAt, true))}">
        <span>${esc(s.kind === "continuity" ? "Continuity" : s.kind === "gap" ? "Gap" : s.title || "")}</span>
      </div>`).join("");
  const ov = overlays.map((o) => `
      <div class="ov" data-shadowed="${o.shadowed}" style="left:${pct(Math.max(o.startsAt, from))};width:${wpct(Math.max(o.startsAt, from), Math.min(o.endsAt, to))}"
        title="Bump overlay: ${esc(bumpDefs.get(o.bumpId)?.name || o.bumpId)} ${esc(fmtTime(o.startsAt, true))}–${esc(fmtTime(o.endsAt, true))}${o.shadowed ? " (an earlier rule wins here)" : ""}"></div>`).join("");
  const markerFrac = (t - from) / span;
  const marker = t >= from && t <= to ? `<div class="marker${markerFrac > 0.8 ? " end" : ""}" style="left:${pct(t)}"><span>${inside ? "+" + esc(fmtDuration(t - a.startsAt)) : esc(fmtTime(t, true))}</span></div>` : "";
  const timeline = section("Continuity timeline", `
    <div class="tl" role="img" aria-label="Timeline of published items around this airing">
      <div class="tl-track">${seg}${marker}</div>
      <div class="tl-axis"><span>${esc(fmtTime(from, true))}</span><span>${esc(fmtTime(to, true))}</span></div>
      <div class="tl-label">Clock-triggered bump overlays <span class="faint">(separate layer — they cover the program, they don't move it)</span></div>
      <div class="tl-track tl-ov">${ov}${marker.replace('<span>', '<span hidden>')}</div>
      ${!overlays.length ? `<div class="faint tl-none">${bs?.enabled ? "No bump rule opens a window during this span." : bs ? "Bump scheduling is disabled for this channel." : "Bump rules not loaded."}</div>` : ""}
    </div>
    <p class="note">${ctx.segments.some((s) => s.kind === "continuity") ? "Continuity items shown are real published items in this channel's schedule." : "This program has no published continuity items of its own; none are assumed."}</p>`);

  // --- surrounding events ---
  const roleLabel = { previous: "Previous", continuity: "Continuity", program: "Program", next: "Next" };
  const events = section("Surrounding events", `
    <table class="mini"><thead><tr><th></th><th>Time</th><th>Item</th><th>Dur</th><th></th></tr></thead><tbody>
      ${ctx.segments.map((s) => {
        const an = s.announcement;
        const isAiring = s.kind === "video";
        return `<tr data-sel="${s.selected}">
          <td>${pill(roleLabel[s.role] || s.role, s.selected ? "info" : s.kind === "continuity" ? "purple" : "muted")}</td>
          <td class="tnum">${esc(fmtTime(s.startsAt, true))}–${esc(fmtTime(s.endsAt, true))}</td>
          <td>${isAiring && !s.selected ? `<button class="cell" data-act="nav-airing" data-channel="${esc(channelId)}" data-start="${s.startsAt}">${esc(s.title)}</button>`
            : s.kind === "continuity" ? `Continuity card${s.template ? ` <span class="faint">(${esc(s.template)})</span>` : ""}`
            : s.kind === "gap" ? `<span class="faint">Nothing scheduled</span>` : esc(s.title)}</td>
          <td class="tnum">${esc(fmtDuration(s.duration))}</td>
          <td>${an?.state === "ready" ? `<button class="cell" data-act="preview-announcement" data-url="${esc(an.record.audio)}" title="${esc(an.record.text)}">${icons.voice} VO</button>` : an ? pill(an.state === "stale" ? "VO stale" : "VO pending", "warn", "A record exists but the player would not play it") : ""}</td>
        </tr>`;
      }).join("")}
    </tbody></table>`);

  // --- matching bump rules ---
  const ruleRows = overlays.length ? `<table class="mini"><thead><tr><th>Bump</th><th>Opens</th><th>For</th><th>Rule</th></tr></thead><tbody>${overlays.slice(0, 12).map((o) => `
      <tr><td><button class="cell" data-act="nav-asset" data-asset="bump:${esc(o.bumpId)}">${esc(bumpDefs.get(o.bumpId)?.name || o.bumpId)}</button>${o.shadowed ? ` ${pill("shadowed", "warn", "An earlier rule's window is open at this moment; the player shows that one")}` : ""}</td>
      <td class="tnum">${esc(fmtTime(o.startsAt, true))}</td><td>${o.endsAt - o.startsAt}s</td><td class="faint">${esc(ruleText(o.rule))}</td></tr>`).join("")}</tbody></table>${overlays.length > 12 ? `<p class="empty">+ ${overlays.length - 12} more windows</p>` : ""}`
    : emptyNote(bs?.enabled ? "No bump rule opens during this airing." : "No bump overlays apply (bump scheduling is off or not configured).");

  // --- announcements ---
  const annList = ctx.segments.filter((s) => s.announcement).map((s) => s.announcement);
  const annHtml = annList.length ? annList.map((x) => `
      <div class="ann">
        <button data-act="preview-announcement" data-url="${esc(x.record.audio || "")}" ${x.state === "ready" ? "" : "disabled"} aria-label="Play announcement">${icons.play}</button>
        <div class="grow"><div class="script-s">${esc(x.record.text)}</div>
          <div class="faint">${esc(titleCase(x.record.type))} · ${esc(x.record.voice || "voice not recorded")} · ${x.record.duration ? esc(fmtDuration(x.record.duration)) : "duration not recorded"} · ${x.state === "ready" ? "ready" : esc(x.state)}</div></div>
        <button class="cell-link" data-act="nav-asset" data-asset="announcement:${esc(channelId)}:${esc(x.record.id)}">Inspect</button>
      </div>`).join("") : emptyNote("No announcement is attached to this airing's published continuity.");

  // --- timing (all from the published schedule) ---
  const lead = ctx.segments.filter((s) => s.role === "continuity" && s.startsAt < a.startsAt).reduce((n, s) => n + s.duration, 0);
  const trail = ctx.segments.filter((s) => s.role === "continuity" && s.startsAt > a.startsAt).reduce((n, s) => n + s.duration, 0);
  const p = ctx.program;
  const timing = section("Timing (published schedule)", `
    ${kv("Airing duration", esc(fmtDuration(a.duration, { ms: true })))}
    ${p ? kv("Program occurrence", `<code>${esc(p.occurrenceId)}</code>`) : kv("Program occurrence", notRecorded)}
    ${p ? kv("Occurrence window", `${esc(fmtTime(p.startsAt, true))} – ${esc(fmtTime(p.endsAt, true))} (${esc(fmtDuration(p.endsAt - p.startsAt))}, ${esc(p.boundaryMode)} boundary)`) : ""}
    ${kv("Published continuity", `${esc(fmtDuration(lead))} before · ${esc(fmtDuration(trail))} after`)}
    <p class="note">Planned timing only. CRVideo has no playback telemetry, so “actual” start, drift and sync status are <b>not</b> shown.</p>`);

  // --- assets ---
  const assetRows = [];
  assetRows.push(`<tr><td>${esc(a.provider === "youtube" ? "YouTube video " + (a.videoId || "") : a.mediaUrl || a.provider || "source")}</td><td>Main program</td><td class="tnum">${esc(fmtDuration(a.duration))}</td></tr>`);
  for (const x of annList) if (x.record.audio) assetRows.push(`<tr><td>${esc(x.record.audio.split("/").pop())}</td><td>Announcement</td><td class="tnum">${x.record.duration ? esc(fmtDuration(x.record.duration)) : "—"}</td></tr>`);
  for (const bid of [...new Set(overlays.map((o) => o.bumpId))]) assetRows.push(`<tr><td><button class="cell" data-act="nav-asset" data-asset="bump:${esc(bid)}">${esc(bumpDefs.get(bid)?.name || bid)}</button></td><td>Bump overlay</td><td class="tnum">${bumpDefs.get(bid)?.duration ? esc(fmtDuration(bumpDefs.get(bid).duration)) : "—"}</td></tr>`);
  const assets = section("Assets for this airing", `<table class="mini"><thead><tr><th>Asset</th><th>Role</th><th>Dur</th></tr></thead><tbody>${assetRows.join("")}</tbody></table>
    <p class="note">Availability of these files is not checked here.</p>`, { count: assetRows.length });

  const prev = M.adjacentAiring(sv, a.startsAt, -1);
  const next = M.adjacentAiring(sv, a.startsAt, 1);
  const offsetLabel = inside ? `Preview From ${fmtDuration(t - a.startsAt)}` : "Preview From Start";

  return `
    ${head}
    ${stageHtml(`airing:${channelId}:${a.startsAt}`, ep?.thumbnail_url || a.thumbnailUrl, play, "preview-airing")}
    ${triple}
    ${timeline}
    ${events}
    ${section("Matching bump rules", ruleRows, { count: overlays.length })}
    ${section("Announcements", annHtml)}
    ${timing}
    ${assets}
    <div class="actions">
      ${btn("jump-airing", "Previous Airing", { id: prev ? String(prev.startsAt) : "", attrs: prev ? "" : "disabled", icon: icons.rewind })}
      ${btn("jump-airing", "Next Airing", { id: next ? String(next.startsAt) : "", attrs: next ? "" : "disabled", icon: icons.forward })}
      ${play.ok ? btn("preview-airing", offsetLabel, { primary: true, icon: icons.play }) : ""}
      ${btn("preview-at-time", "Preview Channel At Time", { icon: icons.channel })}
      ${btn("open-programming", "Open in Programming", { attrs: `data-channel="${esc(channelId)}"${p ? ` data-block="${esc(sv.programs.get(p.occurrenceId)?.blockId || "")}"` : ""}`, icon: icons.calendar })}
    </div>`;
}
