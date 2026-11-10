// schedule-model.js -- pure helpers for the Schedule workspace (no DOM, no
// fetch): readable offsets, next-occurrence previews, overlap detection and
// rule/bump duration-fit warnings.
//
// Recurrence semantics are NOT reimplemented here. Every window comes from
// channels/player-adapters.js's bumpRuleWindow()/BUMP_RULE_PERIODS -- the
// exact functions the live player uses -- so the preview can never disagree
// with what airs. Periods are anchored to the Unix epoch (UTC): "every
// hour" means the UTC hour boundary, and a daily offset is seconds after
// UTC midnight, which is why daily offsets are shown converted to local
// time.
//
// Rules keep their stored shape exactly ({bumpId, every, offsetSeconds,
// durationSeconds}); nothing here rewrites a rule.

import { bumpRuleWindow, BUMP_RULE_PERIODS } from "../../../../channels/player-adapters.js";
import { scheduleFit, bumpDuration, effectiveDuration } from "../../../../channels/bump-player.js";

export { BUMP_RULE_PERIODS };

export const RECURRENCES = [
  { value: "hour", label: "Every hour" },
  { value: "halfHour", label: "Every half hour" },
  { value: "day", label: "Every day" },
];
export const RECURRENCE_LABELS = Object.fromEntries(RECURRENCES.map((r) => [r.value, r.label]));

const pad2 = (n) => String(n).padStart(2, "0");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "15 sec", "1 min 30 sec", "2 min", "1 h 5 min". */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} sec`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return r ? `${m} min ${r} sec` : `${m} min`;
}

/** Clock-style ":MM" / ":MM:SS" for seconds into an hour. */
function minuteMark(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `:${pad2(m)}:${pad2(s)}` : `:${pad2(m)}`;
}

/** Local wall-clock time of a daily (UTC-midnight-anchored) offset on the
 *  day containing `refSeconds`. */
function dailyLocal(offset, { timeZone, locale, refSeconds = Date.now() / 1000 } = {}) {
  const midnight = Math.floor(refSeconds / 86400) * 86400;
  const at = new Date((midnight + offset) * 1000);
  const withSecs = Math.round(offset) % 60 !== 0;
  return new Intl.DateTimeFormat(locale || "en-US", {
    hour: "numeric", minute: "2-digit", ...(withSecs ? { second: "2-digit" } : {}), timeZone,
  }).format(at);
}

/**
 * Human-readable offset for a rule.
 *   hour     0 -> ":00"        1800 -> ":30"     10 -> "10 s after the hour"   1810 -> ":30:10"
 *   halfHour 0 -> ":00 & :30"  10 -> "10 s after the half hour"  300 -> ":05 & :35"
 *   day      43200 -> "12:00 PM" (local time of day; `long` adds the UTC time)
 * Returns {short, long}.
 */
export function formatOffset(every, offsetSeconds, opts = {}) {
  const period = BUMP_RULE_PERIODS[every];
  const off = Math.max(0, Number(offsetSeconds) || 0);
  if (!period) return { short: `${off}s`, long: `${off} s offset` };
  if (every === "day") {
    const local = dailyLocal(off, opts);
    const h = Math.floor(off / 3600);
    const m = Math.floor((off % 3600) / 60);
    const s = Math.round(off % 60);
    const utc = `${pad2(h)}:${pad2(m)}${s ? `:${pad2(s)}` : ""} UTC`;
    return { short: local, long: `Daily at ${local} (${utc})` };
  }
  if (every === "hour") {
    if (off === 0) return { short: ":00", long: "On the hour" };
    if (off < 60) return { short: `${Math.round(off)} s after the hour`, long: `${plural(Math.round(off), "second")} after the hour` };
    return { short: minuteMark(off), long: `${minuteMark(off)} past each hour` };
  }
  // halfHour: fires twice an hour, `off` seconds after :00 and after :30.
  if (off === 0) return { short: ":00 & :30", long: "On the hour and half hour" };
  if (off < 60) return { short: `${Math.round(off)} s after the half hour`, long: `${plural(Math.round(off), "second")} after each hour and half hour` };
  return { short: `${minuteMark(off)} & ${minuteMark(off + 1800)}`, long: `${minuteMark(off)} and ${minuteMark(off + 1800)} past each hour` };
}

/** Editable text for an offset ("mm:ss" for hour/halfHour, local "HH:MM:SS" for day). */
export function offsetToInput(every, offsetSeconds, opts = {}) {
  const off = Math.max(0, Math.round(Number(offsetSeconds) || 0));
  if (every === "day") {
    const midnight = Math.floor((opts.refSeconds ?? Date.now() / 1000) / 86400) * 86400;
    const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: opts.timeZone })
      .formatToParts(new Date((midnight + off) * 1000));
    const get = (t) => parts.find((p) => p.type === t)?.value || "00";
    return `${get("hour")}:${get("minute")}:${get("second")}`;
  }
  return `${pad2(Math.floor(off / 60))}:${pad2(off % 60)}`;
}

/** Minutes east of UTC for `timeZone` at instant `atSeconds`. */
function zoneOffsetMinutes(timeZone, atSeconds) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(atSeconds * 1000));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) / 1000;
  return Math.round((asUtc - Math.floor(atSeconds)) / 60);
}

/**
 * Parses offset text back to stored seconds, or NaN when invalid/out of range.
 *   hour/halfHour: "30", ":30", "30:10", "05:00" (minutes[:seconds] past the boundary)
 *   day: local "HH:MM" or "HH:MM:SS", converted to seconds after UTC midnight
 */
export function parseOffsetInput(every, text, opts = {}) {
  const period = BUMP_RULE_PERIODS[every];
  if (!period) return NaN;
  const t = String(text ?? "").trim();
  if (every === "day") {
    const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return NaN;
    const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
    if (h > 23 || mi > 59 || s > 59) return NaN;
    const local = h * 3600 + mi * 60 + s;
    const ref = opts.refSeconds ?? Date.now() / 1000;
    const shift = zoneOffsetMinutes(opts.timeZone, ref) * 60;
    return (((local - shift) % 86400) + 86400) % 86400;
  }
  const m = t.match(/^:?(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return NaN;
  const mi = Number(m[1]);
  const s = Number(m[2] || 0);
  if (s > 59) return NaN;
  const off = mi * 60 + s;
  return off < period ? off : NaN;
}

/**
 * The next window of `rule` at or after `now`, computed with the player's
 * own bumpRuleWindow(): {startsAt, endsAt, active} where `active` is true
 * when `now` is already inside a window (then startsAt is that window's
 * start). null for an unrecognized/incomplete rule.
 */
export function nextOccurrence(rule, now) {
  const period = BUMP_RULE_PERIODS[rule?.every];
  const duration = Math.max(0, Number(rule?.durationSeconds) || 0);
  if (!period || !rule?.bumpId || duration <= 0) return null;
  const live = bumpRuleWindow(rule, now);
  if (live) return { startsAt: live.startsAt, endsAt: live.endsAt, active: true };
  // A full-period probe always contains `now`, so it yields the current
  // period's anchor through the same function; the next start follows it.
  const probe = bumpRuleWindow({ ...rule, durationSeconds: period }, now);
  if (!probe) return null;
  const startsAt = probe.startsAt > now ? probe.startsAt : probe.startsAt + period;
  return { startsAt, endsAt: startsAt + duration, active: false };
}

/** "in 15 min 34 sec", "in 2 h 5 min", "in 8 sec". */
export function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `in ${s} sec`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `in ${h} h ${m} min`;
  return `in ${m} min ${r} sec`;
}

function dayKey(seconds, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(seconds * 1000));
}

/**
 * {when, countdown} for a next-occurrence card, e.g.
 *   {when: "Today at 4:00 PM", countdown: "in 15 min 34 sec"}
 * Pass the result of nextOccurrence(); an active window reads "On air now".
 */
export function describeNext(occ, now, { timeZone, locale = "en-US" } = {}) {
  if (!occ) return { when: "—", countdown: "" };
  if (occ.active) return { when: "On air now", countdown: `${formatDuration(occ.endsAt - now)} left` };
  const at = new Date(occ.startsAt * 1000);
  const withSecs = Math.round(occ.startsAt) % 60 !== 0;
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", ...(withSecs ? { second: "2-digit" } : {}), timeZone }).format(at);
  const today = dayKey(now, timeZone);
  const day = dayKey(occ.startsAt, timeZone);
  let label;
  if (day === today) label = "Today";
  else if (day === dayKey(now + 86400, timeZone)) label = "Tomorrow";
  else label = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone }).format(at);
  return { when: `${label} at ${time}`, countdown: formatCountdown(occ.startsAt - now) };
}

/**
 * Pairs of rules (by index) whose windows overlap anywhere. Windows are
 * enumerated with nextOccurrence() (i.e. bumpRuleWindow) across two days
 * from a day-aligned epoch instant -- every supported period divides a
 * day, so that covers every distinct overlap. Returns
 * [{a, b, at, seconds}] with a < b; `at` is an example overlap start (Unix
 * seconds) and `seconds` the overlap length there. Overlaps are reported,
 * never resolved: on air the player's first matching rule (lowest index)
 * wins (locateActiveBump).
 */
export function findOverlaps(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const windows = [];
  const span = 2 * 86400;
  list.forEach((rule, i) => {
    let t = 0;
    for (let guard = 0; guard < 400; guard++) { // 2 days of half-hours = 96 windows; the guard only stops malformed input
      const occ = nextOccurrence(rule, t);
      if (!occ || occ.startsAt >= span) break;
      windows.push({ i, start: occ.startsAt, end: occ.endsAt });
      t = occ.endsAt; // windows never exceed one period, so the next one starts at or after this
    }
  });
  windows.sort((x, y) => x.start - y.start || x.i - y.i);
  const found = new Map();
  const open = [];
  for (const w of windows) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].end <= w.start) open.splice(k, 1);
    for (const o of open) {
      if (o.i === w.i) continue;
      const a = Math.min(o.i, w.i);
      const b = Math.max(o.i, w.i);
      const key = `${a}:${b}`;
      if (!found.has(key)) found.set(key, { a, b, at: w.start, seconds: Math.min(o.end, w.end) - w.start });
    }
    open.push(w);
  }
  return [...found.values()].sort((x, y) => x.a - y.a || x.b - y.b);
}

/**
 * How a rule's window length relates to its bump's own composition length
 * (bump-player.js scheduleFit). Never changes the rule -- just explains.
 * Returns {fit, level, message} where fit is "exact"|"cut"|"loop"|"open"|"missing"
 * and level is null|"info"|"warn"|"error".
 */
export function fitWarning(rule, bump) {
  if (!bump) return { fit: "missing", level: "error", message: `Bump "${rule?.bumpId || "?"}" no longer exists. This rule can't be saved until you pick another bump or remove it.` };
  const ruleDur = Number(rule?.durationSeconds) || 0;
  const fit = scheduleFit(ruleDur, bump);
  const own = bumpDuration(bump);
  if (fit === "exact") return { fit, level: null, message: `Matches the bump's ${formatDuration(own)} length.` };
  if (fit === "cut") return { fit, level: "warn", message: `Cut short: the bump is ${formatDuration(own)} but this rule ends it after ${formatDuration(ruleDur)}.` };
  if (fit === "loop") return { fit, level: "warn", message: `Loops: the bump is ${formatDuration(own)}, so it restarts to fill this rule's ${formatDuration(ruleDur)}.` };
  return { fit, level: "info", message: `The bump has no fixed length, so it runs for the rule's ${formatDuration(ruleDur)} (previewed at ${formatDuration(effectiveDuration(bump))}).` };
}

/** Same rules in the same order, compared on the stored fields only. */
export function rulesEqual(a, b) {
  const norm = (r) => ({ bumpId: r.bumpId || "", every: r.every, offsetSeconds: Number(r.offsetSeconds) || 0, durationSeconds: Number(r.durationSeconds) || 0 });
  const x = (a || []).map(norm);
  const y = (b || []).map(norm);
  return x.length === y.length && x.every((r, i) => JSON.stringify(r) === JSON.stringify(y[i]));
}

/** Short channel badge text: "Science & Engineering" -> "SE", "USTV" -> "US". */
export function channelInitials(name) {
  const words = String(name || "").replace(/&/g, " ").split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
