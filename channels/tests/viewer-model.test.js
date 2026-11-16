// channels/tests/viewer-model.test.js
//
// The viewer pages' pure logic (channels/viewer/model.js): schedule index,
// air status, Browse search/filter/sort, day lineup, episode scheduling and
// the small label helpers. Timeline tests use a tiny synthetic two-program
// cycle (7200 s, anchored at the epoch) run through the REAL buildEpgTimeline().
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEpgTimeline } from "../broadcast.js";
import {
  artIndex, monogram, dayStart, dayDiff, whenLabel, untilLabel, durationLabel, slotLabel,
  buildScheduleIndex, airStatus, airSummary, searchScore, filterShows, sortRows,
  dayLineup, onAirNow, episodeSchedule,
} from "../viewer/model.js";

const video = (id, start, duration, program) => ({ type: "video", id, title: id.toUpperCase(), start, duration, media_url: `/${id}.mp4`, program_id: program });
const schedule = {
  blocks: [{
    duration: 7200,
    items: [
      video("a", 0, 1800, "p1"), video("b", 1800, 1800, "p1"),
      video("c", 3600, 3300, "p2"),
      { type: "continuity", id: "brk", start: 6900, duration: 300 }, // between programs: its own passthrough entry
    ],
  }],
  programs: [
    { occurrence_id: "p1", block_id: "b1", title: "Alpha Hour", series_id: "alpha", series_title: "Alpha", start: 0, end: 3600 },
    { occurrence_id: "p2", block_id: "b2", title: "Beta Hour", series_id: "beta", series_title: "Beta", start: 3600, end: 6900 },
  ],
};
const channel = (id) => ({ id, epgTimeline: buildEpgTimeline(schedule, 0) });
const NOW = 1000 + 7200 * 1000; // 1000 s into an "alpha" slot

test("buildScheduleIndex groups playable programs by series, sorted, including the one on now", () => {
  const idx = buildScheduleIndex([channel("x")], NOW, NOW + 7200);
  assert.deepEqual([...idx.keys()].sort(), ["alpha", "beta"]);
  const alpha = idx.get("alpha");
  assert.equal(alpha[0].startsAt, NOW - 1000, "the in-progress airing is first");
  assert.equal(alpha[0].channelId, "x");
  assert.ok(alpha.every((p, i) => i === 0 || alpha[i - 1].startsAt <= p.startsAt));
});

test("airStatus / airSummary: on now, next, again, none", () => {
  const idx = buildScheduleIndex([channel("x")], NOW, NOW + 4 * 7200);
  const on = airStatus(idx.get("alpha"), NOW);
  assert.ok(on.onNow && on.next && on.again);
  assert.equal(on.again.startsAt, on.next.startsAt);
  assert.equal(airSummary(on, NOW).kind, "now");

  const later = airStatus(idx.get("beta"), NOW);
  assert.equal(later.onNow, null);
  assert.equal(later.next.startsAt, NOW - 1000 + 3600);
  assert.deepEqual(airSummary(later, NOW), { kind: "next", at: later.next.startsAt, inSec: 2600 });

  const none = airStatus([], NOW);
  assert.equal(airSummary(none, NOW).kind, "none");
  assert.equal(airStatus(undefined, NOW).next, null);
});

test("dayLineup: programs only (no station breaks), with episode counts", () => {
  const start = NOW - 1000;
  const rows = dayLineup(channel("x"), start, start + 7200);
  assert.deepEqual(rows.map((r) => r.title), ["Alpha Hour", "Beta Hour"]);
  assert.equal(rows[0].episodeCount, 2);
  assert.equal(rows[1].episodeCount, 1);
  assert.equal(rows[0].continued, false);
  const mid = dayLineup(channel("x"), start + 600, start + 1200);
  assert.equal(mid[0].continued, true, "a program already running when the window opens is flagged");
});

test("dayLineup: back-to-back station breaks merge into one row when long, and are dropped when short", () => {
  const gappy = {
    blocks: [{ duration: 7200, items: [
      video("a", 0, 1800, "p1"),
      { type: "continuity", id: "k1", start: 1800, duration: 600 },
      { type: "continuity", id: "k2", start: 2400, duration: 600 },
      video("c", 3000, 4200, "p2"),
    ] }],
    programs: [
      { occurrence_id: "p1", block_id: "b1", title: "Alpha Hour", series_id: "alpha", start: 0, end: 1800 },
      { occurrence_id: "p2", block_id: "b2", title: "Beta Hour", series_id: "beta", start: 3000, end: 7200 },
    ],
  };
  const ch = { id: "g", epgTimeline: buildEpgTimeline(gappy, 0) };
  const rows = dayLineup(ch, 0, 7200);
  assert.deepEqual(rows.map((r) => [r.isBreak, r.title]), [[false, "Alpha Hour"], [true, "Station break"], [false, "Beta Hour"]]);
  assert.equal(rows[1].startsAt, 1800);
  assert.equal(rows[1].endsAt, 3000, "the two 10-minute breaks are one 20-minute row");
  // the main fixture's 5-minute break is below the threshold
  assert.equal(dayLineup(channel("x"), NOW - 1000, NOW - 1000 + 7200).some((r) => r.isBreak), false);
});

test("onAirNow: current program, the episode airing, and the next program", () => {
  const r = onAirNow(channel("x"), NOW);
  assert.equal(r.nowProgram.title, "Alpha Hour");
  assert.equal(r.episode.id, "a");
  assert.equal(r.next.title, "Beta Hour");
  const brk = onAirNow(channel("x"), NOW - 1000 + 7000);
  assert.equal(brk.nowProgram, null, "a station break is not a program");
  assert.equal(brk.next.title, "Alpha Hour", "the cycle wraps to the next program");
});

test("episodeSchedule: soonest airing per episode, flagged when on now", () => {
  const idx = buildScheduleIndex([channel("x")], NOW, NOW + 3 * 7200);
  const sched = episodeSchedule(idx.get("alpha"), NOW);
  assert.equal(sched.get("a").onNow, true);
  assert.equal(sched.get("b").onNow, false);
  assert.equal(sched.get("b").startsAt, NOW - 1000 + 1800);
  assert.equal(sched.get("b").channelId, "x");
  assert.equal(sched.has("c"), false, "c belongs to the other show");
});

const shows = [
  { id: "mr", title: "Mark Rober", description: "Former NASA engineer", creator: null, channels: ["sci"], episode_count: 39 },
  { id: "kz", title: "Kurzgesagt", description: "Big ideas about science", creator: null, channels: ["sci"], episode_count: 50 },
  { id: "tc", title: "Technology Connections", description: "How things work", creator: "Alec", channels: ["sci", "maker"], episode_count: 4 },
];
const statusBy = { mr: { onNow: { endsAt: 5 }, next: { startsAt: 90 } }, kz: { onNow: null, next: { startsAt: 50 } }, tc: { onNow: null, next: null } };
const names = { sci: "Science & Engineering", maker: "Maker Channel" };
const run = (opts) => filterShows(shows, (s) => statusBy[s.id], { channelNameOf: (id) => names[id], nowSec: 0, ...opts }).map((r) => r.show.id);

test("searchScore: all tokens must match; title beats description; channel names count", () => {
  assert.equal(searchScore(shows[0], "rober"), 8);
  assert.ok(searchScore(shows[0], "mark") > searchScore(shows[0], "nasa"));
  assert.equal(searchScore(shows[0], "mark zzz"), 0);
  assert.ok(searchScore(shows[2], "maker", ["Maker Channel"]) > 0);
  assert.equal(searchScore(shows[0], ""), 1);
});

test("filterShows: default order is on-now, then soonest next, then unscheduled", () => {
  assert.deepEqual(run({}), ["mr", "kz", "tc"]);
});

test("filterShows: channel, airing and query filters", () => {
  assert.deepEqual(run({ channel: "maker" }), ["tc"]);
  assert.deepEqual(run({ airing: "now" }), ["mr"]);
  assert.deepEqual(run({ airing: "unscheduled" }), ["tc"]);
  assert.deepEqual(run({ airing: "scheduled" }), ["mr", "kz"]);
  assert.deepEqual(run({ airing: "12h" }), ["mr", "kz"]);
  assert.deepEqual(run({ q: "ideas" }), ["kz"], "only Kurzgesagt mentions ideas");
  assert.equal(run({ q: "science" }).length, 3, "a carrying channel's name matches too");
  assert.deepEqual(run({ q: "nothing-matches" }), []);
});

test("sortRows sorts list-view columns, either direction, stable by title", () => {
  const rows = filterShows(shows, (s) => statusBy[s.id], { nowSec: 0 });
  assert.deepEqual(sortRows(rows, "show", 1).map((r) => r.show.id), ["kz", "mr", "tc"]);
  assert.deepEqual(sortRows(rows, "episodes", -1).map((r) => r.show.id), ["kz", "mr", "tc"]);
  assert.deepEqual(sortRows(rows, "next", 1).map((r) => r.show.id), ["mr", "kz", "tc"]);
  assert.deepEqual(sortRows(rows, "bogus", 1), rows);
});

test("labels", () => {
  assert.equal(monogram("Mark Rober"), "MR");
  assert.equal(monogram("Kurzgesagt"), "K");
  assert.equal(monogram("The Dodo"), "D");
  assert.equal(monogram("Technology Connections"), "TC");
  assert.equal(monogram(""), "?");
  assert.equal(artIndex("x"), artIndex("x"));
  assert.ok(artIndex("anything") >= 0 && artIndex("anything") < 6);
  assert.equal(untilLabel(40 * 60), "in 40 min");
  assert.equal(untilLabel(100 * 60), "in 1 hr 40 min");
  assert.equal(untilLabel(3 * 3600), "in 3 hr");
  assert.equal(untilLabel(2 * 86400), "in 2 days");
  assert.equal(durationLabel(1734), "28:54");
  assert.equal(durationLabel(3723), "1:02:03");
  assert.equal(durationLabel(null), "");
  assert.equal(slotLabel(3600), "1 hr");
  assert.equal(slotLabel(1800), "30 min");
  assert.equal(slotLabel(5400), "1 hr 30 min");
});

test("whenLabel / dayDiff use local calendar days (TZ-independent construction)", () => {
  const at = (d, h) => new Date(2026, 10, 13 + d, h, 0).getTime() / 1000;
  const now = at(0, 10);
  assert.equal(dayDiff(at(0, 23), now), 0);
  assert.equal(dayDiff(at(1, 0), now), 1);
  assert.equal(dayDiff(at(-1, 12), now), -1);
  assert.ok(whenLabel(at(0, 15), now).startsWith("Today "));
  assert.ok(whenLabel(at(1, 15), now).startsWith("Tomorrow "));
  assert.ok(!/^(Today|Tomorrow)/.test(whenLabel(at(3, 15), now)));
  assert.equal(dayStart(at(0, 15)), at(0, 0));
  assert.equal(dayStart(at(0, 15), 2), at(2, 0));
});
