// explorer-relationships.js -- "what is connected to this?" as a structured
// list. Every relationship is derived from an actual reference (a catalog
// ref, a programming block's series_id, a schedule item's program_id, a bump
// rule's bumpId, an announcement's transitionId / audio file). Nothing is
// inferred from similar titles. Used by the search view's inspector and
// available for any entity.

import * as M from "./explorer-model.js";
import { esc, section, emptyNote, icons, fmtDateTime, fmtDuration, plural, titleCase } from "./explorer-ui.js";
import { ruleText } from "./explorer-channel.js";

const row = (attrs, title, sub = "", right = "") => `
  <button class="linkrow" ${attrs}>
    <span class="grow"><span class="t">${esc(title)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ""}</span>${right ? `<span class="r">${right}</span>` : ""}
  </button>`;
const group = (title, items, total = items.length, { limit = 6 } = {}) =>
  section(title, items.length ? items.slice(0, limit).join("") + (total > limit ? `<p class="empty">+ ${total - limit} more</p>` : "") : emptyNote("None found in the loaded data."), { count: total });

const channelRow = (c, sub) => row(`data-act="nav-channel" data-id="${esc(c.id ?? c.channelId)}"`, c.name ?? c.channelName, sub);

/** @param {{type:string}} ref  one of: channel{id} series{id} episode{series,id} airing{channel,start} bump{id} announcement{channel,id} media{path} */
export function renderRelationships(store, ref) {
  const d = store.data;
  const idx = store.indexes();
  const t = store.effectiveT();
  const out = [];

  if (ref.type === "channel") {
    const c = store.channel(ref.id);
    if (!c) return emptyNote("Unknown channel.");
    const series = store.seriesOfChannel(ref.id);
    out.push(group("Series carried", series.map((s) => row(`data-act="nav-series" data-id="${esc(s.id)}" data-channel="${esc(ref.id)}"`, s.row?.title || s.id, `${s.row ? plural(s.row.episode_count, "episode") : ""}${s.blocks.length ? ` · ${plural(s.blocks.length, "block")}` : " · catalog only"}`))));
    out.push(group("Programming blocks", (c.programming_blocks || []).map((b) => row(`data-act="open-programming" data-channel="${esc(ref.id)}" data-block="${esc(b.id)}"`, b.title || b.id, b.series_id))));
    const rules = d.bumpSchedule.get(ref.id)?.rules || [];
    out.push(group("Bumps scheduled", rules.map((r) => row(`data-act="nav-asset" data-asset="bump:${esc(r.bumpId)}"`, r.bumpId, ruleText(r)))));
    const sv = store.scheduleView(ref.id);
    out.push(group("Upcoming airings", sv ? M.channelAirings(sv, t, t + 12 * 3600, { limit: 6 }).map((a) => row(`data-act="nav-airing" data-channel="${esc(ref.id)}" data-start="${a.startsAt}"`, a.title, fmtDateTime(a.startsAt))) : []));
    const anns = d.announcements.get(ref.id) || [];
    out.push(group("Announcements", anns.slice(0, 6).map((a) => row(`data-act="nav-asset" data-asset="announcement:${esc(ref.id)}:${esc(a.id)}"`, a.text || a.id, titleCase(a.type))), anns.length));
  } else if (ref.type === "series") {
    const row0 = store.seriesRow(ref.id);
    if (!row0) return emptyNote("Unknown series.");
    const carriers = store.carriersOf(ref.id);
    out.push(group("Carried by", carriers.map((c) => channelRow(c, `${c.inCatalog ? "in catalog" : "programmed only"} · ${plural(c.blocks.length, "block")}`))));
    const eps = store.seriesDetail(ref.id)?.episodes;
    out.push(group("Episodes", (eps || []).slice(0, 6).map((e) => row(`data-act="nav-episode" data-series="${esc(ref.id)}" data-id="${esc(e.id)}"`, e.title, e.duration ? fmtDuration(e.duration) : "")), row0.episode_count));
    out.push(group("Programming blocks", carriers.flatMap((c) => c.blocks.map((b) => row(`data-act="open-programming" data-channel="${esc(c.channelId)}" data-block="${esc(b.id)}"`, b.title || b.id, c.channelName)))));
    const up = carriers.flatMap((c) => M.seriesAirings(store.scheduleView(c.channelId), ref.id, { from: t, limit: 4 }).map((a) => ({ ...a, cn: c.channelName }))).sort((a, b) => a.startsAt - b.startsAt);
    out.push(group("Upcoming airings", up.map((a) => row(`data-act="nav-airing" data-channel="${esc(a.channelId)}" data-start="${a.startsAt}"`, a.title, `${a.cn} · ${fmtDateTime(a.startsAt)}`))));
    const rel = [];
    for (const c of carriers) {
      const sv = store.scheduleView(c.channelId);
      for (const a of d.announcements.get(c.channelId) || []) if (sv && a.toProgramId && sv.programs.get(a.toProgramId)?.seriesId === ref.id) rel.push(row(`data-act="nav-asset" data-asset="announcement:${esc(c.channelId)}:${esc(a.id)}"`, a.text || a.id, c.channelName));
    }
    out.push(group("Related continuity", rel));
  } else if (ref.type === "episode") {
    const s = store.seriesRow(ref.series);
    out.push(group("Series", s ? [row(`data-act="nav-series" data-id="${esc(s.id)}"`, s.title, plural(s.episode_count, "episode"))] : []));
    const carriers = store.carriersOf(ref.series);
    out.push(group("Carried by", carriers.map((c) => channelRow(c, c.inCatalog ? "in catalog" : "programmed only"))));
    const airs = store.airingsOfEpisode(ref.series, ref.id);
    out.push(group("Airings", airs.map((a) => row(`data-act="nav-airing" data-channel="${esc(a.channelId)}" data-start="${a.startsAt}"`, fmtDateTime(a.startsAt), store.channel(a.channelId)?.name || a.channelId)), airs.length));
    out.push(group("Programming blocks", carriers.flatMap((c) => c.blocks.map((b) => row(`data-act="open-programming" data-channel="${esc(c.channelId)}" data-block="${esc(b.id)}"`, b.title || b.id, c.channelName)))));
  } else if (ref.type === "airing") {
    const sv = store.scheduleView(ref.channel);
    const ctx = sv ? M.airingContext(sv, ref.start, d.announcements.get(ref.channel) || []) : null;
    const c = store.channel(ref.channel);
    out.push(group("Channel", c ? [channelRow(c)] : []));
    if (ctx?.airing.seriesId) out.push(group("Series & episode", [row(`data-act="nav-series" data-id="${esc(ctx.airing.seriesId)}" data-channel="${esc(ref.channel)}"`, ctx.program?.seriesTitle || ctx.airing.seriesId), row(`data-act="nav-episode" data-series="${esc(ctx.airing.seriesId)}" data-id="${esc(ctx.airing.id)}" data-channel="${esc(ref.channel)}"`, ctx.airing.title)]));
    const anns = (ctx?.segments || []).filter((s) => s.announcement).map((s) => row(`data-act="nav-asset" data-asset="announcement:${esc(ref.channel)}:${esc(s.announcement.record.id)}"`, s.announcement.record.text, s.announcement.state));
    out.push(group("Continuity announcements", anns));
    const ov = ctx ? M.bumpOverlays(d.bumpSchedule.get(ref.channel), ctx.airing.startsAt, ctx.airing.endsAt) : [];
    out.push(group("Bump overlays during this airing", ov.map((o) => row(`data-act="nav-asset" data-asset="bump:${esc(o.bumpId)}"`, o.bumpId, fmtDateTime(o.startsAt, true)))));
  } else if (ref.type === "bump") {
    const usage = idx.bumpUsage.get(ref.id) || [];
    out.push(group("Used by channels", usage.map((u) => row(`data-act="nav-channel" data-id="${esc(u.channelId)}"`, u.channelName, ruleText(u.rule)))));
    const b = (d.bumps || []).find((x) => x.id === ref.id);
    const media = [];
    if (b?.background?.url) media.push(row(`data-act="nav-asset" data-asset="media:${esc(M.normalizeMediaPath(b.background.url))}"`, b.background.url.split("/").pop(), "background"));
    for (const a of b?.audio || []) if (a.url) media.push(row(`data-act="nav-asset" data-asset="media:${esc(M.normalizeMediaPath(a.url))}"`, a.url.split("/").pop(), a.source || "audio"));
    out.push(group("Media used", media));
    const ann = b?.announcement?.url ? Object.entries(d.allAnnouncements || {}).flatMap(([cid, l]) => l.filter((a) => M.normalizeMediaPath(a.audio) === M.normalizeMediaPath(b.announcement.url)).map((a) => row(`data-act="nav-asset" data-asset="announcement:${esc(cid)}:${esc(a.id)}"`, a.text || a.id, cid))) : [];
    out.push(group("Announcement clip", ann));
  } else if (ref.type === "announcement") {
    const rec = idx.announcements.byKey.get(`${ref.channel}:${ref.id}`);
    const c = store.channel(ref.channel);
    out.push(group("Channel", c ? [channelRow(c)] : []));
    const sv = store.scheduleView(ref.channel);
    const tr = rec && sv ? M.announcementTransition(sv, rec) : null;
    const a = tr && sv ? M.findAiring(sv, tr.continuity.endsAt) : null;
    out.push(group("Leads into airing", a ? [row(`data-act="nav-airing" data-channel="${esc(ref.channel)}" data-start="${a.entry.startsAt}"`, a.entry.title, fmtDateTime(a.entry.startsAt))] : []));
    out.push(group("Used by bumps", rec ? M.bumpsUsingAnnouncement(d.bumps || [], rec).map((b) => row(`data-act="nav-asset" data-asset="bump:${esc(b.id)}"`, b.name || b.id)) : []));
  } else if (ref.type === "media") {
    const uses = idx.mediaUsage.get(M.normalizeMediaPath(ref.path)) || [];
    out.push(group("Used by bumps", uses.map((u) => row(`data-act="nav-asset" data-asset="bump:${esc(u.bumpId)}"`, u.bumpId, u.role))));
    const ch = new Map();
    for (const u of uses) for (const cu of idx.bumpUsage.get(u.bumpId) || []) ch.set(cu.channelId, cu.channelName);
    out.push(group("Reaches channels", [...ch].map(([id, name]) => channelRow({ id, name }))));
  }
  return out.join("");
}
