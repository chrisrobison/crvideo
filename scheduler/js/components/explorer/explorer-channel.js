// explorer-channel.js -- the Channel inspector. Everything shown is read from
// the channel's own files / the published schedule. Status wording follows
// docs/explorer.md: "configured", "published", "scheduled" and "confirmed
// playing" are different things and only the first three can be known here.

import * as M from "./explorer-model.js";
import { esc, thumb, pill, kv, section, emptyNote, btn, icons, fmtDateTime, fmtTime, fmtDuration, fmtDate, notRecorded, plural, titleCase } from "./explorer-ui.js";

export const channelTitleBits = (store, c) => ({ title: c.name, sub: c.number != null ? `Channel ${c.number}` : "Channel" });

export function renderChannel(store) {
  const c = store.channel();
  if (!c) return unknown(store);
  const id = c.id;
  const sv = store.scheduleView(id);
  const schedErr = store.data.scheduleErrors.get(id);
  const t = store.effectiveT();
  const live = store.timeMode() === "live";
  const accent = c.theme?.accent || "var(--accent)";
  const status = M.channelStatus(sv, store.clock());
  const bs = store.data.bumpSchedule.get(id);
  const cont = store.data.continuity.get(id);
  const ann = store.data.announcements.get(id) || [];
  const anCfg = store.data.announcer.get(id);

  const statusTone = { "scheduled-now": "info", continuity: "info", gap: "warn", "out-of-range": "warn", unavailable: "bad" }[status.code] || "muted";
  const hero = `
    <div class="hero" style="--hero:${esc(accent)}">
      ${thumb(c.logoUrl, c.name, { cls: "sq" })}
      <div class="grow">
        <h2>${esc(c.name)}</h2>
        <div class="sub">${c.number != null ? `Channel ${esc(c.number)} · ` : ""}<code>${esc(c.id)}</code></div>
      </div>
    </div>
    ${c.description ? `<p class="desc">${esc(c.description)}</p>` : ""}`;

  const statusBlock = section("Status", `
    <div class="chips" style="margin-bottom:8px">
      ${pill("Configured", "good", "channels/" + c.id + "/meta.json exists")}
      ${sv ? pill(sv.looping ? "Looping schedule" : "Schedule published", "good") : schedErr ? pill("Schedule unavailable", "bad", schedErr) : pill("Loading schedule…", "muted")}
      ${sv ? pill(status.label, statusTone) : ""}
    </div>
    ${sv ? `<p class="note">${esc(status.label)}${status.detail ? ` — ${esc(status.detail)}` : ""}. This is derived from the published schedule and your clock;
      CRVideo has no player telemetry, so whether anyone is actually watching or the player is healthy is <b>not known</b> here.</p>` : schedErr ? `<p class="note bad">${esc(schedErr)}</p>` : ""}
  `);

  // What the schedule says at the selected instant.
  const at = sv ? M.locateAt(sv, t) : null;
  const atBlock = section(live ? "Scheduled now" : "At selected time", sv ? atHtml(store, c, sv, at, t, live) : emptyNote("Schedule not loaded."));

  // Upcoming
  let upcoming = emptyNote("No schedule loaded.");
  if (sv) {
    const list = M.channelAirings(sv, t, t + 12 * 3600, { limit: 12 }).filter((a) => a.startsAt > t - 1 || a.endsAt > t).slice(0, 8);
    upcoming = list.length ? list.map((a) => `
      <button class="linkrow" data-act="nav-airing" data-channel="${esc(id)}" data-start="${a.startsAt}">
        <span class="grow"><span class="t">${esc(a.title)}</span><span class="s">${esc(fmtDateTime(a.startsAt))} · ${fmtDuration(a.duration)}</span></span>
        <span class="r">${icons.chevron}</span>
      </button>`).join("") : emptyNote("Nothing published in the next 12 hours (or the selected time is outside the published window).");
  }

  // Catalog
  const series = store.seriesOfChannel(id).sort((a, b) => (a.row?.title || a.id).localeCompare(b.row?.title || b.id));
  const catalog = series.length ? `<div class="chips">${series.map((s) => `<button class="chip" data-act="nav-series" data-id="${esc(s.id)}" data-channel="${esc(id)}">${icons.series}${esc(s.row?.title || s.id)}</button>`).join("")}</div>`
    : emptyNote("This channel's catalog references no series (it may be a legacy channel with catalog items only).");

  // Coverage
  const coverage = sv ? `
    ${sv.window ? kv("Published window", `${esc(fmtDateTime(sv.window.start))} → ${esc(fmtDateTime(sv.window.end))}`) : kv("Published window", `${esc("Not declared — a looping schedule of " + fmtDuration(sv.cycle))}`)}
    ${kv("Programs", String(sv.programs.size))}
    ${kv("Generated", sv.generatedAt ? esc(fmtDateTime(Date.parse(sv.generatedAt) / 1000)) : notRecorded)}
    ${kv("Programming blocks", String((c.programming_blocks || []).length))}` : emptyNote("Schedule not loaded.");

  // Continuity resources
  const stationIds = cont?.station_ids?.length || 0;
  const filler = cont?.filler?.length || 0;
  const cards = cont?.cards || [];
  const annReady = ann.filter((a) => a.status === "ready").length;
  const continuity = (cont || ann.length) ? `
    ${kv("Continuity cards", cards.length ? esc(cards.map((x) => x.template || x.id).join(", ")) : notRecorded)}
    ${kv("Station IDs", String(stationIds))}
    ${kv("Filler items", String(filler))}
    ${kv("Announcements", ann.length ? `${annReady} ready of ${ann.length}` : notRecorded)}`
    : emptyNote("No continuity.json or announcements for this channel.");

  const announcer = anCfg ? `
    ${kv("Announcer", anCfg.enabled ? pill("Enabled", "good") : pill("Disabled", "muted"))}
    ${kv("Voice", esc(anCfg.voice || "—"))}
    ${kv("Types", esc((anCfg.types || []).map(titleCase).join(", ") || "—"))}
    ${kv("Auto-generation", anCfg.automaticGeneration ? "On" : "Off")}
    <p class="note">Existing configuration only. Explorer never generates or regenerates narration.</p>` : emptyNote("No announcer.json: the AI announcer is off for this channel.");

  const bumpDefs = new Map((store.data.bumps || []).map((b) => [b.id, b]));
  const rules = bs?.rules || [];
  const bumpRules = rules.length ? `
    <p class="note" style="margin-bottom:8px">Clock-triggered overlays${bs.enabled ? "" : " — <b>disabled</b> for this channel"}: they draw over the program and do not move it.</p>
    ${rules.map((r) => `
      <button class="linkrow" data-act="nav-asset" data-asset="bump:${esc(r.bumpId)}">
        <span class="grow"><span class="t">${esc(bumpDefs.get(r.bumpId)?.name || r.bumpId)}</span>
        <span class="s">${esc(ruleText(r))}</span></span>
        ${bumpDefs.has(r.bumpId) ? "" : pill("missing definition", "bad")}
      </button>`).join("")}` : emptyNote(bs ? "No bump rules configured." : "Bump rules not loaded.");

  const art = `
    <div class="chips">
      ${c.logoUrl ? `<a class="chip" href="${esc(c.logoUrl)}" target="_blank" rel="noopener">${icons.image}Logo</a>` : ""}
      ${c.theme ? Object.entries(c.theme).filter(([, v]) => /^#[0-9a-f]{3,8}$/i.test(v)).map(([k, v]) => `<span class="chip" style="cursor:default"><i class="sw" style="background:${esc(v)}"></i>${esc(k)}</span>`).join("") : ""}
    </div>
    ${!c.logoUrl && !c.theme ? emptyNote("No logo or theme recorded.") : ""}`;

  return `
    ${hero}
    ${statusBlock}
    ${atBlock}
    ${section("Upcoming", upcoming)}
    ${section("Program catalog", catalog, { count: series.length })}
    ${section("Published schedule coverage", coverage, { id: "coverage" })}
    ${section("Continuity resources", continuity, { id: "continuity" })}
    ${section("Announcer configuration", announcer)}
    ${section("Bump scheduling rules", bumpRules, { count: rules.length, id: "bumps" })}
    ${section("Artwork & theme", art)}
    <div class="actions">
      ${btn("open-programming", "Open in Programming", { primary: true, attrs: `data-channel="${esc(id)}"`, icon: icons.calendar })}
      ${btn("watch-channel", "Preview Channel", { attrs: `data-channel="${esc(id)}"`, icon: icons.play })}
      ${btn("view-schedule", "View Published Schedule", { attrs: `data-channel="${esc(id)}"`, icon: icons.clock })}
      ${btn("scroll-sec", "Inspect Continuity", { id: "continuity", icon: icons.bump })}
      ${btn("open-bump-schedule", "Open Bump Rules in Bump Studio", { attrs: `data-channel="${esc(id)}"`, icon: icons.bump })}
    </div>`;
}

export const ruleText = (r) => {
  const every = { hour: "every hour", halfHour: "every half hour", day: "every day" }[r.every] || `every ${r.every}`;
  const off = Number(r.offsetSeconds) || 0;
  return `${every}${off ? ` at +${fmtDuration(off)}` : " on the mark"} for ${r.durationSeconds}s`;
};

function atHtml(store, c, sv, at, t, live) {
  const head = `<p class="note" style="margin-bottom:8px">${live ? "Live clock" : "Time travel"}: ${esc(fmtDateTime(t, true))}</p>`;
  if (at.state === "out-of-range") {
    return `${head}<p class="note warn"><b>Out of range.</b> The published schedule covers ${esc(fmtDateTime(sv.window.start))} → ${esc(fmtDateTime(sv.window.end))}.
      Explorer does not invent airings outside it (the live player would loop the cycle; that is not a published schedule).</p>`;
  }
  const e = at.entry;
  if (e.kind === "gap") return `${head}<p class="note warn">Nothing is scheduled at this instant (a gap in the published schedule, ${esc(fmtTime(e.startsAt))} – ${esc(fmtTime(e.endsAt))}).</p>`;
  const bump = M.activeBumpAt(store.data.bumpSchedule.get(c.id), t);
  const overlay = bump ? `<p class="note" style="margin-top:6px">${icons.bump} A clock-triggered bump overlay would be on screen now: <button class="cell-link" data-act="nav-asset" data-asset="bump:${esc(bump.bumpId)}">${esc(bump.bumpId)}</button> (${esc(fmtTime(bump.startsAt, true))}–${esc(fmtTime(bump.endsAt, true))}). The program underneath keeps its own timing.</p>` : "";
  if (e.kind === "continuity") {
    return `${head}<div class="kv-wrap">${kv("Scheduled", "Station break / continuity card")}${kv("Template", esc(e.template || "—"))}${kv("Window", `${esc(fmtTime(e.startsAt, true))} – ${esc(fmtTime(e.endsAt, true))}`)}${kv("Offset", fmtDuration(at.offset, { ms: true }))}</div>${overlay}`;
  }
  return `${head}
    <button class="linkrow" data-act="nav-airing" data-channel="${esc(c.id)}" data-start="${e.startsAt}">
      <span class="grow"><span class="t">${esc(e.title)}</span><span class="s">${esc(at.program?.seriesTitle || "")} · ${esc(fmtTime(e.startsAt, true))} – ${esc(fmtTime(e.endsAt, true))}</span></span>
      <span class="r">${icons.chevron}</span>
    </button>
    ${kv("Offset into program", `+${esc(fmtDuration(at.offset, { ms: true }))} of ${esc(fmtDuration(e.duration))}`)}
    ${kv("Remaining", esc(fmtDuration(at.remaining)))}
    ${overlay}`;
}

function unknown(store) {
  return `<div class="sec"><p class="note bad">No channel with id <code>${esc(store.route.channel)}</code> exists${store.data.channels ? "" : " (channels are still loading)"}.</p></div>`;
}
