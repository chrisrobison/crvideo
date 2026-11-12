// explorer-series.js -- the Series / Show inspector. A series is reusable:
// nothing here stores channel-specific state in it. Per-channel rotation and
// airings come from each carrying channel's own programming + published schedule.

import * as M from "./explorer-model.js";
import { esc, thumb, pill, kv, section, emptyNote, btn, icons, fmtDateTime, fmtDuration, notRecorded, plural, titleCase, EDITORIAL_TONE, RIGHTS_LABEL, RIGHTS_TONE } from "./explorer-ui.js";

export function recurrenceText(rec) {
  if (!rec) return "—";
  const at = `${rec.time || "?"} ${rec.timezone || ""}`.trim();
  if (rec.frequency === "daily") return `Daily ${at}`;
  if (rec.frequency === "weekly") return `${titleCase(rec.weekday)}s ${at}`;
  if (rec.frequency === "monthly") return `Monthly, day ${rec.day_of_month} ${at}`;
  return String(rec.frequency || "—");
}

export function renderSeries(store) {
  const id = store.route.series;
  const row = store.seriesRow(id);
  const detail = store.seriesDetail(id);
  if (!row && store.data.seriesIndex) return `<div class="sec"><p class="note bad">No series with id <code>${esc(id)}</code> exists.</p></div>`;
  if (!row) return `<div class="sec"><p class="empty">Loading series…</p></div>`;

  const t = store.effectiveT();
  const carriers = store.carriersOf(id);
  const eps = detail?.episodes || null;

  const statusCounts = row.status_counts || {};
  const editorial = Object.keys(statusCounts).length
    ? Object.entries(statusCounts).map(([k, n]) => pill(`${n} ${k}`, EDITORIAL_TONE[k] || "muted")).join(" ") : notRecorded;
  let rights = notRecorded;
  if (eps) {
    const rc = {};
    for (const e of eps) rc[e.rights?.status || "unrecorded"] = (rc[e.rights?.status || "unrecorded"] || 0) + 1;
    rights = Object.entries(rc).map(([k, n]) => pill(`${n} ${RIGHTS_LABEL[k] || k}`, RIGHTS_TONE[k] || "muted")).join(" ");
  }

  const art = row.thumbnail_url || row.logo_url;
  const hero = `
    <div class="hero">
      ${thumb(art, row.title, { cls: "sq" })}
      <div class="grow"><h2>${esc(row.title)}</h2><div class="sub">Series (reusable) · <code>${esc(id)}</code></div></div>
    </div>
    ${(detail?.description || row.description) ? `<p class="desc">${esc(detail?.description || row.description)}</p>` : `<p class="desc">${notRecorded}</p>`}`;

  const meta = section("Metadata", `
    ${kv("Creator", row.creator ? esc(row.creator) : notRecorded)}
    ${kv("Year", row.year ? esc(row.year) : notRecorded)}
    ${kv("Episodes", `${row.episode_count}${eps ? "" : ""}`)}
    ${kv("Editorial status", editorial)}
    ${kv("Rights", eps ? rights : `<span class="faint">Loading…</span>`)}
    ${kv("Source / platform", detail ? `${esc(titleCase(detail.source?.provider || "unknown"))}${detail.source?.channel_url ? ` · <a href="${esc(detail.source.channel_url)}" target="_blank" rel="noopener noreferrer">source channel ↗</a>` : ""}` : esc(titleCase(row.source_provider || "unknown")))}
    ${kv("Category / tags", `<span class="faint">Not recorded — series.json has no category or tag fields.</span>`)}
  `);

  // Carried by (distinct per-channel state)
  const carried = carriers.length ? carriers.map((c) => {
    const sv = store.scheduleView(c.channelId);
    const rot = sv ? M.publishedRotation(sv, id) : null;
    const state = c.blocks.length ? pill(`${plural(c.blocks.length, "programming block")}`, "info") : pill("Catalog only — no programming block", "muted");
    return `
      <button class="linkrow" data-act="nav-channel" data-id="${esc(c.channelId)}">
        <span class="grow"><span class="t">${esc(c.channelName)}</span>
        <span class="s">${c.inCatalog ? "In catalog" : "Programmed but not in catalog"} · ${rot ? `${plural(rot.airingCount, "published airing")}` : sv === null && !store.data.scheduleErrors.has(c.channelId) ? "schedule loading…" : "schedule unavailable"}</span></span>
        ${state}
      </button>`;
  }).join("") : emptyNote("No channel's catalog or programming references this series.");

  const blocks = carriers.flatMap((c) => c.blocks.map((b) => ({ c, b })));
  const blockTable = blocks.length ? `
    <table class="mini"><thead><tr><th>Channel</th><th>Block</th><th>When</th><th>Slot</th></tr></thead><tbody>
      ${blocks.map(({ c, b }) => `<tr>
        <td><button class="cell" data-act="nav-channel" data-id="${esc(c.channelId)}">${esc(c.channelName)}</button></td>
        <td><button class="cell" data-act="open-programming" data-channel="${esc(c.channelId)}" data-block="${esc(b.id)}" title="Open this block in Programming">${esc(b.title || b.id)}</button></td>
        <td>${esc(recurrenceText(b.recurrence))}</td>
        <td>${esc(fmtDuration(b.duration))}${b.packing?.enabled ? " · packed" : ""}</td></tr>`).join("")}
    </tbody></table>` : emptyNote("No programming block airs this series on any channel.");

  // Upcoming airings across carrying channels
  const up = [];
  for (const c of carriers) up.push(...M.seriesAirings(store.scheduleView(c.channelId), id, { from: t, limit: 6 }).map((a) => ({ ...a, channelName: c.channelName })));
  up.sort((a, b) => a.startsAt - b.startsAt);
  const loadingSched = carriers.some((c) => !store.scheduleView(c.channelId) && !store.data.scheduleErrors.has(c.channelId));
  const upcoming = up.length ? up.slice(0, 8).map((a) => `
      <button class="linkrow" data-act="nav-airing" data-channel="${esc(a.channelId)}" data-start="${a.startsAt}">
        <span class="grow"><span class="t">${esc(a.title)}</span><span class="s">${esc(a.channelName)} · ${esc(fmtDateTime(a.startsAt))}</span></span>
        <span class="r">${icons.chevron}</span></button>`).join("")
    : emptyNote(loadingSched ? "Loading schedules…" : "No airings of this series in the published schedules after the selected time.");

  // Rotation: per channel, from the published schedule only
  const rotations = carriers.map((c) => ({ c, rot: M.publishedRotation(store.scheduleView(c.channelId), id) })).filter((x) => x.rot && x.rot.airingCount);
  const epById = new Map((eps || []).map((e) => [e.id, e]));
  const rotation = rotations.length ? rotations.map(({ c, rot }) => `
      <div style="margin-bottom:10px">
        <div style="font-weight:600;font-size:12.5px;margin-bottom:4px">${esc(c.channelName)}</div>
        <div class="muted" style="font-size:12px;margin-bottom:6px">${plural(rot.episodeOrder.length, "distinct episode")} in ${plural(rot.airingCount, "published airing")}, first ${esc(fmtDateTime(rot.firstAiring))}
          ${rot.episodeSets.length ? ` · compiler episode set v${esc(rot.episodeSets[0].version)} (${rot.episodeSets[0].episode_count} eligible)` : ""}</div>
        <div class="strip">${rot.episodeOrder.slice(0, 12).map((eid) => `<button class="strip-item" data-act="nav-episode" data-series="${esc(id)}" data-id="${esc(eid)}" data-channel="${esc(c.channelId)}" title="${esc(epById.get(eid)?.title || eid)}">${thumb(epById.get(eid)?.thumbnail_url, epById.get(eid)?.title || eid)}<span>${esc(epById.get(eid)?.title || eid)}</span></button>`).join("")}</div>
      </div>`).join("")
    : emptyNote(loadingSched ? "Loading schedules…" : "No published rotation: no channel has scheduled this series in its current window.");
  const rotNote = detail?.rotation?.mode ? `<p class="note">series.json's own default hint is “${esc(detail.rotation.mode)}${detail.rotation.loop ? ", loop" : ""}”. Actual rotation is per channel (above) and is not stored in the series.</p>` : "";

  // Related continuity: announcements whose target program belongs to this series' blocks
  const related = [];
  for (const c of carriers) {
    const sv = store.scheduleView(c.channelId);
    const anns = store.data.announcements.get(c.channelId) || [];
    if (!sv) continue;
    for (const a of anns) {
      const prog = a.toProgramId ? sv.programs.get(a.toProgramId) : null;
      if (prog?.seriesId === id) related.push({ a, c });
    }
  }
  const relatedHtml = related.length ? `${related.slice(0, 5).map(({ a, c }) => `
      <button class="linkrow" data-act="nav-asset" data-asset="announcement:${esc(c.channelId)}:${esc(a.id)}">
        <span class="grow"><span class="t">${esc(a.text || a.id)}</span><span class="s">${esc(c.channelName)} · ${esc(titleCase(a.type))}</span></span></button>`).join("")}
      ${related.length > 5 ? `<p class="empty">+ ${related.length - 5} more</p>` : ""}`
    : emptyNote("No announcement that leads into this series is loaded. (Announcements load per channel; select a carrying channel to include its.)");

  const primaryChannel = store.route.channel && carriers.some((c) => c.channelId === store.route.channel) ? store.route.channel : carriers[0]?.channelId;
  return `
    ${hero}
    ${meta}
    ${section("Carried by", carried, { count: carriers.length })}
    ${section("Programming blocks", blockTable, { count: blocks.length })}
    ${section("Upcoming airings", upcoming)}
    ${section("Episode rotation (published)", rotation + rotNote)}
    ${section("Related continuity", relatedHtml)}
    <div class="actions">
      ${btn("open-series-review", "Open in Series Review", { attrs: `data-series="${esc(id)}"`, icon: icons.series, primary: true })}
      ${primaryChannel ? btn("open-programming", "Open in Programming", { attrs: `data-channel="${esc(primaryChannel)}"`, icon: icons.calendar }) : ""}
      ${btn("focus-col", "View All Episodes", { id: "episodes", icon: icons.episode })}
      ${btn("focus-col", "View Upcoming Airings", { id: "airings", icon: icons.clock })}
    </div>`;
}
