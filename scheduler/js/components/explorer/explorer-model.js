// explorer-model.js -- Explorer's pure relationship, time-travel and search
// logic. No DOM, no fetch: every function takes already-loaded data and
// returns derived views. Derived indexes here are cheap to rebuild and are
// NEVER authoritative (docs/explorer.md) -- the repository files are.
//
// Schedule math is not reimplemented: buildTimeline / buildEpgTimeline /
// locate come from channels/broadcast.js, bump windows from
// channels/player-adapters.js (bumpRuleWindow), announcement staleness from
// findAnnouncementAudio. This module only composes them.

import {
  buildTimeline, buildEpgTimeline, locate, fixShoutingTitle, findAnnouncementAudio,
} from "../../../../channels/broadcast.js";
import { bumpRuleWindow, BUMP_RULE_PERIODS } from "../../../../channels/player-adapters.js";

// ---------------------------------------------------------------------------
// Published schedule view (one per channel)
// ---------------------------------------------------------------------------

function isoSeconds(v) {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** The compiler's published horizon, in epoch seconds, or null when the
 *  schedule declares none (a legacy looping schedule). */
export function publishedWindow(schedule) {
  const w = schedule?._publish?.window;
  const start = isoSeconds(w?.start);
  const end = isoSeconds(w?.end);
  return start !== null && end !== null && end > start ? { start, end } : null;
}

/**
 * @param {{id:string, meta:object, schedule:object}} input raw meta.json + schedule.json
 * @returns a ScheduleView (playback timeline + EPG timeline + lookup maps),
 *          or throws if the schedule has nothing to air (same as broadcast.js).
 */
export function buildScheduleView({ id, meta, schedule }) {
  const anchorRaw = meta?.anchor ? Date.parse(meta.anchor) / 1000 : 0;
  const anchor = Number.isFinite(anchorRaw) ? anchorRaw : 0;
  const formatTitle = meta?.fixAllCapsTitles ? fixShoutingTitle : null;
  const tl = buildTimeline(schedule, anchor, formatTitle);
  const epg = buildEpgTimeline(schedule, anchor, formatTitle);

  // entry.start (cycle-relative) -> the program occurrence that contains it,
  // from the compiler's explicit program_id grouping (never title guessing).
  const programByEntryStart = new Map();
  const programs = new Map();
  for (const e of epg.entries) {
    if (e.type !== "program") continue;
    programs.set(e.id, e);
    for (const ep of e.episodes) programByEntryStart.set(ep.start, e);
  }
  const publish = schedule?._publish || null;
  return {
    channelId: id,
    anchor,
    cycle: tl.cycle,
    window: publishedWindow(schedule),
    looping: publishedWindow(schedule) === null,
    tl, epg, programs, programByEntryStart,
    generatedAt: publish?.generated_at ?? null,
    episodeSets: Array.isArray(publish?.episode_sets) ? publish.episode_sets : [],
  };
}

export function inWindow(sv, t) {
  return !sv.window || (t >= sv.window.start && t < sv.window.end);
}

const kindOf = (e) => (e.type === "continuity" ? "continuity" : e.type === "gap" ? "gap" : "video");

function publicEntry(sv, e) {
  const program = sv.programByEntryStart.get(e.start) ?? null;
  return {
    kind: kindOf(e),
    id: e.id, title: e.title, description: e.description ?? null,
    startsAt: e.startsAt, endsAt: e.endsAt,
    duration: e.endsAt - e.startsAt,
    provider: e.provider ?? null, videoId: e.videoId ?? null,
    mediaUrl: e.mediaUrl ?? null, sourceUrl: e.sourceUrl ?? null,
    thumbnailUrl: e.thumbnailUrl ?? null,
    template: e.template ?? null, nextProgramId: e.nextProgramId ?? null,
    playable: !!e.playable,
    occurrenceId: program?.id ?? null,
    seriesId: program?.seriesId ?? null,
  };
}

/**
 * What the channel's PUBLISHED schedule says at instant `t` (epoch seconds).
 * Outside the published horizon the answer is explicitly `out-of-range`; we
 * never return the player's looped repeat as if it were published.
 */
export function locateAt(sv, t) {
  if (!sv) return { state: "no-schedule", t };
  if (!inWindow(sv, t)) return { state: "out-of-range", t, window: sv.window };
  const raw = locate(sv.tl, t);
  const entry = publicEntry(sv, raw);
  const before = raw.startsAt - 0.001;
  const previous = inWindow(sv, before) ? publicEntry(sv, locate(sv.tl, before)) : null;
  const next = inWindow(sv, raw.endsAt) ? publicEntry(sv, locate(sv.tl, raw.endsAt)) : null;
  const offset = t - entry.startsAt;
  const program = sv.programByEntryStart.get(raw.start) ?? null;
  const cycleStart = raw.startsAt - raw.start; // absolute start of the cycle containing t
  return {
    state: "ok", t, window: sv.window, looping: sv.looping,
    entry, previous, next,
    offset, remaining: entry.endsAt - t,
    program: program && {
      occurrenceId: program.id, blockId: program.blockId, title: program.title,
      seriesId: program.seriesId, seriesTitle: program.seriesTitle,
      boundaryMode: program.boundaryMode,
      startsAt: cycleStart + program.start,
      endsAt: cycleStart + program.end,
    },
  };
}

/** The airing (a playable video occurrence) that STARTS exactly at `startsAt`, else null. */
export function findAiring(sv, startsAt) {
  if (!sv || !Number.isFinite(startsAt) || !inWindow(sv, startsAt)) return null;
  const at = locateAt(sv, startsAt + 0.001);
  if (at.state !== "ok" || at.entry.kind !== "video" || at.entry.startsAt !== startsAt) return null;
  return at;
}

/** The nearest playable airing before (dir < 0) or after (dir > 0) the one starting at `startsAt`,
 *  skipping published continuity items and gaps; null at the edge of the published window. */
export function adjacentAiring(sv, startsAt, dir) {
  const here = findAiring(sv, startsAt);
  if (!here) return null;
  let probe = dir > 0 ? here.entry.endsAt : here.entry.startsAt - 0.001;
  for (let i = 0; i < 100; i++) {
    const at = locateAt(sv, probe);
    if (at.state !== "ok") return null;
    if (at.entry.kind === "video") return at.entry;
    probe = dir > 0 ? at.entry.endsAt : at.entry.startsAt - 0.001;
  }
  return null;
}

/**
 * Everything surrounding an airing, as actual published occurrences:
 * the previous scheduled item, the program's own items in order (any
 * published continuity lead-in/filler plus the episodes), and the next item.
 * A segment exists only because the schedule has an item there.
 */
export function airingContext(sv, startsAt, announcements = []) {
  const at = findAiring(sv, startsAt);
  if (!at) return null;

  const segments = [];
  const seen = new Set();
  const push = (e, role) => {
    const key = `${e.startsAt}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push({ ...e, role, selected: e.startsAt === at.entry.startsAt, announcement: null });
  };

  // Walk the program's own items in published order.
  if (at.program) {
    let cursor = locateAt(sv, at.program.startsAt + 0.001);
    let guard = 0;
    while (cursor.state === "ok" && guard++ < 200) {
      if (cursor.entry.occurrenceId !== at.program.occurrenceId) break;
      push(cursor.entry, cursor.entry.kind === "continuity" ? "continuity" : "program");
      if (!cursor.next) break;
      cursor = locateAt(sv, cursor.next.startsAt + 0.001);
    }
  } else {
    push(at.entry, "program");
  }
  // The neighbours just OUTSIDE the program (or the lone airing): whatever
  // the schedule really has before and after it, including a gap.
  const firstStart = Math.min(...segments.map((s) => s.startsAt));
  const lastEnd = Math.max(...segments.map((s) => s.endsAt));
  const previous = inWindow(sv, firstStart - 0.001) ? locateAt(sv, firstStart - 0.001) : null;
  const next = inWindow(sv, lastEnd) ? locateAt(sv, lastEnd) : null;
  if (previous?.state === "ok") push(previous.entry, "previous");
  if (next?.state === "ok") push(next.entry, "next");
  segments.sort((a, b) => a.startsAt - b.startsAt);

  for (const s of segments) {
    if (s.kind === "continuity") s.announcement = continuityAnnouncement(announcements, s);
  }
  return {
    airing: at.entry, program: at.program,
    previous: previous?.state === "ok" ? previous.entry : null,
    next: next?.state === "ok" ? next.entry : null,
    segments,
    from: segments[0].startsAt,
    to: segments[segments.length - 1].endsAt,
  };
}

/** The announcement record for a published continuity item, with an honest
 *  state: `ready` (usable audio, via the player's own matching + staleness
 *  rule), `stale`/`pending` (a record exists but the player would NOT play
 *  it), or null (no record). */
export function continuityAnnouncement(announcements, item) {
  if (!Array.isArray(announcements) || !item) return null;
  const rec = announcements.find((a) => a && a.transitionId === item.id && a.type === "coming_up_next");
  if (!rec) return null;
  const audio = findAnnouncementAudio(announcements, { id: item.id, nextProgramId: item.nextProgramId });
  const playable = audio !== null && audio === rec.audio;
  return { record: rec, state: playable ? "ready" : (rec.status === "ready" ? "stale" : "pending") };
}

// ---------------------------------------------------------------------------
// Episode / series airings across channels
// ---------------------------------------------------------------------------

/**
 * Published airings of one episode on one channel, ascending. `seriesId`
 * (optional) rejects a same-id item that the compiler attributed to a
 * different series. Only the published horizon is listed -- never the
 * player's wrapped repeats.
 */
export function episodeAirings(sv, episodeId, seriesId = null) {
  if (!sv) return [];
  const out = [];
  for (const e of sv.tl.entries) {
    if (e.type === "continuity" || e.type === "gap" || e.id !== episodeId) continue;
    const startsAt = sv.anchor + e.start;
    if (!inWindow(sv, startsAt)) continue;
    const program = sv.programByEntryStart.get(e.start) ?? null;
    if (seriesId && program?.seriesId && program.seriesId !== seriesId) continue;
    out.push({
      channelId: sv.channelId, episodeId, startsAt, endsAt: sv.anchor + e.end,
      duration: e.end - e.start, title: e.title,
      occurrenceId: program?.id ?? null, seriesId: program?.seriesId ?? null,
    });
  }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}

/** Published airings (videos) of a series on a channel, ascending, optionally from `from`. */
export function seriesAirings(sv, seriesId, { from = -Infinity, limit = Infinity } = {}) {
  if (!sv) return [];
  const out = [];
  for (const p of sv.programs.values()) {
    if (p.seriesId !== seriesId) continue;
    for (const e of p.episodes) {
      if (e.type === "continuity" || e.type === "gap") continue;
      const startsAt = sv.anchor + e.start;
      if (!inWindow(sv, startsAt) || startsAt + (e.end - e.start) <= from) continue;
      out.push({
        channelId: sv.channelId, episodeId: e.id, startsAt, endsAt: sv.anchor + e.end,
        duration: e.end - e.start, title: e.title, occurrenceId: p.id, seriesId,
      });
    }
  }
  out.sort((a, b) => a.startsAt - b.startsAt);
  return out.slice(0, limit);
}

/** Published playable airings on a channel in [from, to), ascending (the channel-level "schedule" column). */
export function channelAirings(sv, from, to, { limit = 500 } = {}) {
  if (!sv) return [];
  const lo = sv.window ? Math.max(from, sv.window.start) : from;
  const hi = sv.window ? Math.min(to, sv.window.end) : to;
  const out = [];
  let cursor = lo;
  let guard = 0;
  while (cursor < hi && out.length < limit && guard++ < limit * 4) {
    const at = locateAt(sv, cursor);
    if (at.state !== "ok") break;
    if (at.entry.kind === "video") out.push(at.entry);
    cursor = at.entry.endsAt;
  }
  return out;
}

/** Which episodes of a series were actually scheduled on this channel, in first-airing order, plus the
 *  compiler's own episode_sets record. This is the channel's published rotation, not series.json's hint. */
export function publishedRotation(sv, seriesId) {
  if (!sv) return null;
  const airs = seriesAirings(sv, seriesId);
  const order = [];
  const seen = new Set();
  for (const a of airs) if (!seen.has(a.episodeId)) { seen.add(a.episodeId); order.push(a.episodeId); }
  return {
    channelId: sv.channelId,
    airingCount: airs.length,
    firstAiring: airs[0]?.startsAt ?? null,
    lastAiring: airs[airs.length - 1]?.startsAt ?? null,
    episodeOrder: order,
    episodeSets: sv.episodeSets.filter((s) => s.series_id === seriesId),
  };
}

/** A truthful channel status derived ONLY from the published schedule and a clock. Never "on air". */
export function channelStatus(sv, now) {
  if (!sv) return { code: "unavailable", label: "Schedule unavailable", detail: "No published schedule could be loaded." };
  if (!inWindow(sv, now)) {
    const upcoming = sv.window && now < sv.window.start;
    return {
      code: "out-of-range",
      label: upcoming ? "Schedule not yet started" : "Outside published window",
      detail: upcoming ? "The published schedule begins later." : "The published schedule ends before now.",
    };
  }
  const at = locateAt(sv, now);
  if (at.state === "ok" && at.entry.kind === "video") {
    return { code: "scheduled-now", label: "Scheduled now", detail: at.entry.title, entry: at.entry };
  }
  if (at.state === "ok" && at.entry.kind === "continuity") {
    return { code: "continuity", label: "Scheduled: station break", detail: at.entry.template || "continuity", entry: at.entry };
  }
  return { code: "gap", label: "Nothing scheduled right now", detail: "A gap in the published schedule.", entry: at.entry };
}

// ---------------------------------------------------------------------------
// Bump rules (clock-triggered overlays -- a different mechanism from published continuity)
// ---------------------------------------------------------------------------

/** Every window one rule opens that intersects [from, to), using bumpRuleWindow's own arithmetic. */
export function bumpRuleWindowsBetween(rule, from, to, limit = 500) {
  const period = BUMP_RULE_PERIODS[rule?.every];
  if (!period || !rule?.bumpId || !(to > from)) return [];
  const offset = Math.max(0, Math.min(period - 1, Number(rule.offsetSeconds) || 0));
  const duration = Math.max(0, Number(rule.durationSeconds) || 0);
  if (duration <= 0) return [];
  const out = [];
  let k = Math.floor((from - offset - duration) / period);
  for (; out.length < limit; k++) {
    const startsAt = k * period + offset;
    if (startsAt >= to) break;
    const endsAt = startsAt + duration;
    if (endsAt <= from) continue;
    // Confirm with the player's own function so this can't drift from it.
    if (bumpRuleWindow(rule, startsAt)?.bumpId !== rule.bumpId) continue;
    out.push({ bumpId: rule.bumpId, startsAt, endsAt });
  }
  return out;
}

/**
 * Clock-triggered bump overlays over [from, to) for one channel's rule list.
 * Rules are first-match-wins in the player (locateActiveBump); a window
 * that starts while an earlier rule's window is open is flagged `shadowed`.
 * Overlays never move or extend the underlying airing.
 */
export function bumpOverlays(bumpSchedule, from, to) {
  if (!bumpSchedule?.enabled) return [];
  const rules = Array.isArray(bumpSchedule.rules) ? bumpSchedule.rules : [];
  const all = [];
  rules.forEach((rule, ruleIndex) => {
    for (const w of bumpRuleWindowsBetween(rule, from, to)) all.push({ ...w, ruleIndex, rule });
  });
  all.sort((a, b) => a.startsAt - b.startsAt || a.ruleIndex - b.ruleIndex);
  for (const w of all) {
    w.shadowed = all.some((o) => o.ruleIndex < w.ruleIndex && o.startsAt <= w.startsAt && o.endsAt > w.startsAt);
  }
  return all;
}

/** The bump the player would show at instant t for this schedule (the first matching rule), or null. */
export function activeBumpAt(bumpSchedule, t) {
  if (!bumpSchedule?.enabled) return null;
  for (const [ruleIndex, rule] of (bumpSchedule.rules || []).entries()) {
    const w = bumpRuleWindow(rule, t);
    if (w) return { ...w, ruleIndex, rule };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reverse-reference indexes (derived, rebuilt on demand)
// ---------------------------------------------------------------------------

/** channel-admin's list -> seriesId -> carriers (catalog membership + programming blocks that air it). */
export function indexSeriesCarriers(channels) {
  const map = new Map();
  const slot = (seriesId, channel) => {
    if (!map.has(seriesId)) map.set(seriesId, new Map());
    const per = map.get(seriesId);
    if (!per.has(channel.id)) per.set(channel.id, { channelId: channel.id, channelName: channel.name, inCatalog: false, blocks: [] });
    return per.get(channel.id);
  };
  for (const ch of channels || []) {
    for (const ref of ch.series_refs || []) {
      if (ref.series_id) slot(ref.series_id, ch).inCatalog = true;
    }
    for (const b of ch.programming_blocks || []) {
      if (b?.series_id) slot(b.series_id, ch).blocks.push(b);
    }
  }
  const out = new Map();
  for (const [sid, per] of map) out.set(sid, [...per.values()]);
  return out;
}

/** bump-admin schedules -> bumpId -> rules that use it. */
export function indexBumpUsage(schedules) {
  const map = new Map();
  for (const ch of schedules || []) {
    (ch.rules || []).forEach((rule, ruleIndex) => {
      if (!rule?.bumpId) return;
      if (!map.has(rule.bumpId)) map.set(rule.bumpId, []);
      map.get(rule.bumpId).push({ channelId: ch.id, channelName: ch.name, enabled: !!ch.enabled, ruleIndex, rule });
    });
  }
  return map;
}

export const normalizeMediaPath = (p) => String(p || "").replace(/^\/+/, "").split("?")[0];

/** Bump definitions -> normalized media path -> [{bumpId, role}] (background / music / ambience / custom / announcement). */
export function indexMediaUsage(bumps) {
  const map = new Map();
  const add = (path, bumpId, role) => {
    const k = normalizeMediaPath(path);
    if (!k) return;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ bumpId, role });
  };
  for (const b of bumps || []) {
    if (b?.background?.url) add(b.background.url, b.id, "background");
    for (const a of b?.audio || []) if (a?.url) add(a.url, b.id, a.source || "custom");
    if (b?.announcement?.url) add(b.announcement.url, b.id, "announcement");
  }
  return map;
}

/** announcements.json records, keyed `${channelId}:${id}`, plus transition lookup per channel. */
export function indexAnnouncements(byChannel) {
  const byKey = new Map();
  const byTransition = new Map();
  for (const [channelId, list] of Object.entries(byChannel || {})) {
    for (const rec of Array.isArray(list) ? list : []) {
      if (!rec?.id) continue;
      byKey.set(`${channelId}:${rec.id}`, { ...rec, channelId });
      if (rec.transitionId) byTransition.set(`${channelId}:${rec.transitionId}`, { ...rec, channelId });
    }
  }
  return { byKey, byTransition };
}

/** Bumps whose embedded announcement clip is this announcement's audio file. */
export function bumpsUsingAnnouncement(bumps, announcement) {
  const audio = normalizeMediaPath(announcement?.audio);
  if (!audio) return [];
  return (bumps || []).filter((b) => normalizeMediaPath(b?.announcement?.url) === audio);
}

/** The airing (if any, in the loaded schedule) that a "coming up next" announcement leads into: the
 *  continuity item matching transitionId, and the program it announces. Null if not in the window. */
export function announcementTransition(sv, announcement) {
  if (!sv || !announcement?.transitionId) return null;
  for (const e of sv.tl.entries) {
    if (e.type !== "continuity" || e.id !== announcement.transitionId) continue;
    const startsAt = sv.anchor + e.start;
    if (!inWindow(sv, startsAt)) continue;
    const program = sv.programByEntryStart.get(e.start) ?? null;
    return {
      continuity: { id: e.id, startsAt, endsAt: sv.anchor + e.end, template: e.template },
      occurrenceId: program?.id ?? null,
      programTitle: program?.title ?? null,
      nextEpisodeId: e.nextProgramId ?? null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Search (client-side, metadata only)
// ---------------------------------------------------------------------------

export const normalizeText = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** @param {Array<{type:string,id:string,title:string,sub?:string,extra?:string,ref:object}>} docs */
export function buildSearchIndex(docs) {
  return docs.map((d) => ({ ...d, _t: normalizeText(d.title), _s: normalizeText(`${d.sub || ""} ${d.extra || ""}`) }));
}

/**
 * Tokenised AND search. Score: exact title > title prefix > word-start in
 * title > substring in title > match only in subtitle/extra. Returns
 * results grouped by type (each capped) plus per-type totals for the scope
 * filters; `scope` limits which groups are returned.
 */
export function searchIndex(index, query, { scope = "all", perGroup = 8 } = {}) {
  const tokens = normalizeText(query).split(" ").filter(Boolean);
  const counts = {};
  if (!tokens.length) return { tokens, counts, groups: [], total: 0 };
  const hits = [];
  for (const d of index) {
    let score = 0;
    let ok = true;
    for (const tok of tokens) {
      let s = 0;
      if (d._t === tok) s = 100;
      else if (d._t.startsWith(tok)) s = 60;
      else if (d._t.includes(` ${tok}`)) s = 40;
      else if (d._t.includes(tok)) s = 20;
      else if (d._s.includes(tok)) s = 5;
      if (!s) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    counts[d.type] = (counts[d.type] || 0) + 1;
    if (scope === "all" || scope === pluralScope(d.type)) hits.push({ doc: d, score });
  }
  hits.sort((a, b) => b.score - a.score || a.doc._t.localeCompare(b.doc._t));
  const order = ["channel", "series", "episode", "airing", "bump", "announcement", "media"];
  const groups = [];
  for (const type of order) {
    const items = hits.filter((h) => h.doc.type === type);
    if (!items.length) continue;
    groups.push({ type, total: items.length, items: items.slice(0, scope === "all" ? perGroup : 100).map((h) => h.doc) });
  }
  return { tokens, counts, groups, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

export function pluralScope(type) {
  return type === "media" ? "media" : `${type}s`;
}
