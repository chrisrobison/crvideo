// channels/viewer/model.js
//
// Pure data/logic behind the viewer pages (channel.html, browse.html,
// show.html). No DOM, no fetch: callers hand in already-loaded channel
// records (broadcast.js's loadChannel()) and the show index
// (finder.php), so every rule here runs under `node --test`.
//
// "When does a show air?" is NEVER stored anywhere -- it is derived from each
// channel's published schedule through buildEpgTimeline()/airings(), the same
// code the guide draws, so these pages cannot disagree with what is on air.

import { airings, episodeAiringTimes } from "../broadcast.js";

/** How far ahead "next airing" looks: the published window is two weeks. */
export const HORIZON_SEC = 14 * 24 * 3600;

const HOUR = 3600;
const DAY = 86400;

// ---------- small display helpers ----------

/** Stable 0..n-1 bucket for a string, so a show always gets the same art tint. */
export function artIndex(seed, n = 6) {
  let h = 0;
  for (const ch of String(seed ?? "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % n;
}

const MONOGRAM_SKIP = new Set(["the", "a", "an", "of", "and", "&"]);

/** "Mark Rober" -> "MR", "Kurzgesagt" -> "K", "The Dodo" -> "D". */
export function monogram(title) {
  const words = String(title ?? "").split(/[\s_-]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  const meaningful = words.filter((w) => !MONOGRAM_SKIP.has(w.toLowerCase()));
  const use = meaningful.length ? meaningful : words;
  if (!use.length) return "?";
  const letters = use.length === 1 ? use[0][0] : use[0][0] + use[1][0];
  return letters.toUpperCase();
}

/** Local-midnight epoch seconds of the day containing `t`, shifted by `days`. */
export function dayStart(t, days = 0) {
  const d = new Date(t * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime() / 1000;
}

/** Whole calendar days from `nowSec`'s day to `t`'s day, in local time. */
export function dayDiff(t, nowSec) {
  return Math.round((dayStart(t) - dayStart(nowSec)) / DAY);
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export const timeLabel = (t) => timeFmt.format(new Date(t * 1000));

/** "Today 3:00 PM" / "Tomorrow 3:00 PM" / "Sat 3:00 PM" / "Nov 20, 3:00 PM". */
export function whenLabel(t, nowSec) {
  const diff = dayDiff(t, nowSec);
  const time = timeLabel(t);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff > 1 && diff < 7) return `${weekdayFmt.format(new Date(t * 1000))} ${time}`;
  return `${dateFmt.format(new Date(t * 1000))}, ${time}`;
}

/** "in 40 min" / "in 1 hr 40 min" / "in 2 days". */
export function untilLabel(seconds) {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `in ${m} min`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `in ${h} hr ${rest} min` : `in ${h} hr`;
  }
  const d = Math.round(m / (24 * 60));
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

/** "28:54" / "1:02:03" for an episode length in seconds; "" when unknown. */
export function durationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** "1 hr" / "30 min" / "1 hr 30 min" for a slot length in seconds. */
export function slotLabel(seconds) {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} hr ${rest} min` : `${h} hr`;
}

// ---------- the schedule index: who airs when ----------

/**
 * Every playable PROGRAM airing in [fromSec, untilSec) across `channels`,
 * grouped by series id and sorted by start time. The airing in progress at
 * `fromSec` is included (startsAt <= fromSec < endsAt).
 *
 * Programs without a seriesId (a channel whose schedule isn't built from
 * programming blocks, e.g. USTV) are not indexed -- they have no show page.
 *
 * @returns {Map<string, Array<{channelId:string, startsAt:number, endsAt:number, title:string, airing:object}>>}
 */
export function buildScheduleIndex(channels, fromSec, untilSec = fromSec + HORIZON_SEC) {
  const bySeries = new Map();
  for (const ch of channels) {
    if (!ch?.epgTimeline) continue;
    for (const a of airings(ch.epgTimeline, fromSec, untilSec)) {
      if (!a.playable || !a.seriesId) continue;
      let list = bySeries.get(a.seriesId);
      if (!list) bySeries.set(a.seriesId, (list = []));
      list.push({ channelId: ch.id, startsAt: a.startsAt, endsAt: a.endsAt, title: a.title, airing: a });
    }
  }
  for (const list of bySeries.values()) list.sort((x, y) => x.startsAt - y.startsAt);
  return bySeries;
}

/**
 * A show's air status at `nowSec`, from its schedule-index list (or []).
 *   onNow : the airing in progress, or null
 *   next  : the first airing that has not started yet, or null
 *   again : what follows `onNow` (the "again 10 PM" in the UI), or null
 *   upcoming : every not-yet-started airing, in order
 */
export function airStatus(list, nowSec) {
  const onNow = list?.find((x) => x.startsAt <= nowSec && nowSec < x.endsAt) || null;
  const upcoming = (list || []).filter((x) => x.startsAt > nowSec);
  return { onNow, next: upcoming[0] || null, again: onNow ? upcoming[0] || null : null, upcoming };
}

/** Shorthand status label parts for a card: {kind:"now"|"next"|"none", ...}. */
export function airSummary(status, nowSec) {
  if (status.onNow) {
    return { kind: "now", until: status.onNow.endsAt, again: status.again?.startsAt ?? null };
  }
  if (status.next) {
    return { kind: "next", at: status.next.startsAt, inSec: status.next.startsAt - nowSec };
  }
  return { kind: "none" };
}

// ---------- Browse: search, filter, sort ----------

const tokens = (q) => String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Relevance of `show` for query `q` (0 = no match). Every token must appear in
 * the title, creator, description or a carrying channel's name; title hits
 * score highest, and a title that STARTS with the query highest of all.
 */
export function searchScore(show, q, channelNames = []) {
  const ts = tokens(q);
  if (!ts.length) return 1;
  const title = String(show.title ?? "").toLowerCase();
  const creator = String(show.creator ?? "").toLowerCase();
  const desc = String(show.description ?? "").toLowerCase();
  const chans = channelNames.join(" ").toLowerCase();
  let score = 0;
  for (const t of ts) {
    let s = 0;
    if (title.includes(t)) s += title.startsWith(t) ? 12 : 8;
    if (creator.includes(t)) s += 4;
    if (chans.includes(t)) s += 3;
    if (desc.includes(t)) s += 1;
    if (!s) return 0;
    score += s;
  }
  return score;
}

export const AIRING_FILTERS = [
  ["any", "Airing: anytime"],
  ["now", "On now"],
  ["12h", "Next 12 hours"],
  ["today", "Today"],
  ["scheduled", "Scheduled (next 2 weeks)"],
  ["unscheduled", "Not currently scheduled"],
];

function matchesAiring(filter, status, nowSec) {
  switch (filter) {
    case "now": return !!status.onNow;
    case "12h": return !!status.onNow || (!!status.next && status.next.startsAt < nowSec + 12 * HOUR);
    case "today": return !!status.onNow || (!!status.next && dayDiff(status.next.startsAt, nowSec) === 0);
    case "scheduled": return !!status.onNow || !!status.next;
    case "unscheduled": return !status.onNow && !status.next;
    default: return true;
  }
}

/**
 * Filters and orders the show index for Browse.
 *
 * @param shows       finder.php's `shows`
 * @param statusOf    (show) => airStatus(...) for that show
 * @param opts        {q, channel, airing, channelNameOf(channelId), nowSec}
 *
 * Order: with a query, by relevance; otherwise on-now first, then soonest next
 * airing, then unscheduled shows A-Z.
 */
export function filterShows(shows, statusOf, opts = {}) {
  const { q = "", channel = "", airing = "any", channelNameOf = (id) => id, nowSec = 0 } = opts;
  const rows = [];
  for (const show of shows) {
    if (channel && !show.channels.includes(channel)) continue;
    const status = statusOf(show);
    if (!matchesAiring(airing, status, nowSec)) continue;
    const score = searchScore(show, q, show.channels.map(channelNameOf));
    if (!score) continue;
    rows.push({ show, status, score });
  }
  const rank = (r) => (r.status.onNow ? 0 : r.status.next ? 1 : 2);
  rows.sort((a, b) => {
    if (tokens(q).length && a.score !== b.score) return b.score - a.score;
    return rank(a) - rank(b)
      || (rank(a) === 1 ? a.status.next.startsAt - b.status.next.startsAt : 0)
      || String(a.show.title).localeCompare(String(b.show.title), undefined, { sensitivity: "base" });
  });
  return rows;
}

/** Column sort for Browse's list view. `key`: show|channel|next|episodes. */
export function sortRows(rows, key, dir = 1, channelNameOf = (id) => id) {
  const next = (r) => r.status.onNow ? -Infinity : r.status.next ? r.status.next.startsAt : Infinity;
  const val = {
    show: (r) => String(r.show.title).toLowerCase(),
    channel: (r) => String(channelNameOf(r.show.channels[0]) ?? "").toLowerCase(),
    next,
    episodes: (r) => r.show.episode_count ?? 0,
  }[key];
  if (!val) return rows;
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || String(a.show.title).localeCompare(String(b.show.title));
  });
}

// ---------- Channel page: one day's lineup ----------

/** Non-program stretches shorter than this are not worth a row in the lineup. */
const MIN_BREAK_SEC = 10 * 60;

/**
 * What a channel airs during [startSec, endSec), in order: every playable
 * program whose window overlaps it (one already running at `startSec` is
 * flagged `continued`; `episodeCount` counts the real videos packed into it),
 * plus a `{isBreak: true}` row for each run of back-to-back station
 * breaks/gaps of at least ten minutes, so a hole in the schedule shows up as
 * "Station break" instead of the lineup silently skipping an hour.
 */
export function dayLineup(channel, startSec, endSec) {
  const out = [];
  let gap = null;
  const flushGap = () => {
    if (gap && gap.endsAt - gap.startsAt >= MIN_BREAK_SEC) {
      out.push({ key: `break:${gap.startsAt}`, isBreak: true, title: "Station break", description: "", seriesId: null,
        startsAt: gap.startsAt, endsAt: gap.endsAt, continued: gap.startsAt < startSec, episodeCount: 0, airing: null });
    }
    gap = null;
  };
  for (const a of airings(channel.epgTimeline, startSec, endSec)) {
    if (a.endsAt <= startSec) continue;
    if (!a.playable) {
      if (gap && a.startsAt <= gap.endsAt) gap.endsAt = Math.max(gap.endsAt, a.endsAt);
      else { flushGap(); gap = { startsAt: a.startsAt, endsAt: a.endsAt }; }
      continue;
    }
    flushGap();
    const videos = Array.isArray(a.episodes) ? a.episodes.filter((e) => e.playable) : [];
    out.push({
      key: `${a.startsAt}:${a.id ?? a.title}`,
      isBreak: false,
      title: a.title,
      description: a.description || "",
      seriesId: a.seriesId || null,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      continued: a.startsAt < startSec,
      episodeCount: videos.length,
      airing: a,
    });
  }
  flushGap();
  return out;
}

/**
 * The entry on the air right now plus the next program, for the channel hero.
 * `now` may be a station break (not playable); `nowProgram` is then null and
 * the hero says what's coming instead.
 */
export function onAirNow(channel, nowSec) {
  const [current] = airings(channel.epgTimeline, nowSec, nowSec + 1);
  const programs = airings(channel.epgTimeline, nowSec, nowSec + 12 * HOUR).filter((a) => a.playable);
  const nowProgram = current?.playable ? current : null;
  const next = programs.find((a) => a.startsAt > nowSec) || null;
  let episode = null;
  if (nowProgram && Array.isArray(nowProgram.episodes)) {
    episode = nowProgram.episodes.find((e) => {
      if (!e.playable) return false;
      const t = episodeAiringTimes(nowProgram, e);
      return t.startsAt <= nowSec && nowSec < t.endsAt;
    }) || null;
  }
  return { current, nowProgram, next, episode };
}

// ---------- Show page: which episodes air when ----------

/**
 * Map of raw episode id -> the soonest scheduled airing of that episode at or
 * after `nowSec` ({startsAt, endsAt, channelId, onNow}), looking only at the
 * given show's program airings (from buildScheduleIndex()).
 */
export function episodeSchedule(showAirings, nowSec) {
  const out = new Map();
  for (const p of showAirings || []) {
    for (const ep of p.airing.episodes || []) {
      if (!ep.playable || !ep.id) continue;
      const t = episodeAiringTimes(p.airing, ep);
      if (t.endsAt <= nowSec) continue;
      const prev = out.get(ep.id);
      if (!prev || t.startsAt < prev.startsAt) {
        out.set(ep.id, { ...t, channelId: p.channelId, onNow: t.startsAt <= nowSec });
      }
    }
  }
  return out;
}
