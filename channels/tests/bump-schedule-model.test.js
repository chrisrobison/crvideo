// channels/tests/bump-schedule-model.test.js
//
// Coverage for the Bump Studio Schedule workspace's pure helpers
// (scheduler/js/components/bump-studio/schedule-model.js): readable
// offsets, next-occurrence previews (which must agree with the player's
// own bumpRuleWindow()), overlap detection and duration-fit warnings.
// Lives here because this is the repo's only `node --test` suite.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatOffset, offsetToInput, parseOffsetInput, nextOccurrence, describeNext,
  formatCountdown, formatDuration, findOverlaps, fitWarning, rulesEqual, channelInitials,
} from "../../scheduler/js/components/bump-studio/schedule-model.js";
import { bumpRuleWindow, locateActiveBump } from "../player-adapters.js";

const UTC = { timeZone: "UTC" };
const HOUR = 1794020400; // 2026-11-07T03:00:00Z, an exact hour boundary
assert.equal(HOUR % 3600, 0);

// ---------- formatOffset ----------

test("formatOffset: hourly offsets read as clock marks", () => {
  assert.equal(formatOffset("hour", 0).short, ":00");
  assert.equal(formatOffset("hour", 1800).short, ":30");
  assert.equal(formatOffset("hour", 1810).short, ":30:10");
  assert.equal(formatOffset("hour", 10).short, "10 s after the hour");
  assert.equal(formatOffset("hour", 0).long, "On the hour");
});

test("formatOffset: half-hourly offsets name both firings", () => {
  assert.equal(formatOffset("halfHour", 0).short, ":00 & :30");
  assert.equal(formatOffset("halfHour", 10).short, "10 s after the half hour");
  assert.equal(formatOffset("halfHour", 300).short, ":05 & :35");
});

test("formatOffset: daily offsets become a local time of day", () => {
  assert.equal(formatOffset("day", 16 * 3600, UTC).short, "4:00 PM");
  assert.equal(formatOffset("day", 16 * 3600, UTC).long, "Daily at 4:00 PM (16:00 UTC)");
  // New York in November is UTC-5: 16:00 UTC is 11:00 AM there.
  assert.equal(formatOffset("day", 16 * 3600, { timeZone: "America/New_York", refSeconds: HOUR }).short, "11:00 AM");
});

// ---------- offset input round trip ----------

test("parseOffsetInput accepts minute marks and rejects out-of-period values", () => {
  assert.equal(parseOffsetInput("hour", ":30"), 1800);
  assert.equal(parseOffsetInput("hour", "30:10"), 1810);
  assert.equal(parseOffsetInput("hour", "0"), 0);
  assert.ok(Number.isNaN(parseOffsetInput("hour", "60")));
  assert.ok(Number.isNaN(parseOffsetInput("halfHour", "30:00")));
  assert.ok(Number.isNaN(parseOffsetInput("hour", "abc")));
  assert.ok(Number.isNaN(parseOffsetInput("hour", "5:75")));
});

test("daily offsets round-trip through local time", () => {
  const opts = { timeZone: "America/New_York", refSeconds: HOUR };
  assert.equal(offsetToInput("day", 16 * 3600, opts), "11:00:00");
  assert.equal(parseOffsetInput("day", "11:00", opts), 16 * 3600);
  assert.equal(parseOffsetInput("day", "20:30:15", opts), ((20 + 5) * 3600 + 30 * 60 + 15) % 86400);
  assert.equal(offsetToInput("hour", 1810), "30:10");
});

// ---------- nextOccurrence (through the player's own bumpRuleWindow) ----------

test("nextOccurrence finds the next hourly window", () => {
  const rule = { bumpId: "b", every: "hour", offsetSeconds: 1800, durationSeconds: 10 };
  const occ = nextOccurrence(rule, HOUR + 60);
  assert.deepEqual(occ, { startsAt: HOUR + 1800, endsAt: HOUR + 1810, active: false });
  // ...and the player agrees that window is exactly when it airs.
  assert.equal(bumpRuleWindow(rule, occ.startsAt - 1), null);
  assert.deepEqual(bumpRuleWindow(rule, occ.startsAt), { bumpId: "b", startsAt: occ.startsAt, endsAt: occ.endsAt });
});

test("nextOccurrence rolls over to the following period once the window has passed", () => {
  const rule = { bumpId: "b", every: "hour", offsetSeconds: 0, durationSeconds: 15 };
  assert.equal(nextOccurrence(rule, HOUR + 20).startsAt, HOUR + 3600);
  assert.equal(nextOccurrence(rule, HOUR - 1).startsAt, HOUR);
});

test("nextOccurrence reports an in-progress window as active", () => {
  const rule = { bumpId: "b", every: "halfHour", offsetSeconds: 0, durationSeconds: 15 };
  assert.deepEqual(nextOccurrence(rule, HOUR + 1805), { startsAt: HOUR + 1800, endsAt: HOUR + 1815, active: true });
});

test("nextOccurrence handles daily rules and rejects incomplete ones", () => {
  const rule = { bumpId: "b", every: "day", offsetSeconds: 16 * 3600, durationSeconds: 20 };
  const midnight = Math.floor(HOUR / 86400) * 86400;
  assert.equal(nextOccurrence(rule, HOUR).startsAt, midnight + 16 * 3600);
  assert.equal(nextOccurrence({ ...rule, every: "week" }, HOUR), null);
  assert.equal(nextOccurrence({ ...rule, bumpId: "" }, HOUR), null);
  assert.equal(nextOccurrence({ ...rule, durationSeconds: 0 }, HOUR), null);
});

test("describeNext formats a same-day time with a live countdown", () => {
  const rule = { bumpId: "b", every: "hour", offsetSeconds: 0, durationSeconds: 15 };
  const now = HOUR + 3600 - (15 * 60 + 34); // 15 min 34 s before 04:00 UTC
  const d = describeNext(nextOccurrence(rule, now), now, UTC);
  assert.equal(d.when, "Today at 4:00 AM");
  assert.equal(d.countdown, "in 15 min 34 sec");
});

test("describeNext labels tomorrow and on-air windows", () => {
  const rule = { bumpId: "b", every: "day", offsetSeconds: 3600, durationSeconds: 20 };
  const now = HOUR; // 03:00 UTC, so 01:00 UTC is tomorrow
  assert.match(describeNext(nextOccurrence(rule, now), now, UTC).when, /^Tomorrow at 1:00 AM$/);
  const live = describeNext({ startsAt: now - 5, endsAt: now + 10, active: true }, now, UTC);
  assert.equal(live.when, "On air now");
  assert.equal(live.countdown, "10 sec left");
});

test("formatCountdown and formatDuration", () => {
  assert.equal(formatCountdown(8), "in 8 sec");
  assert.equal(formatCountdown(934), "in 15 min 34 sec");
  assert.equal(formatCountdown(7500), "in 2 h 5 min");
  assert.equal(formatDuration(15), "15 sec");
  assert.equal(formatDuration(90), "1 min 30 sec");
  assert.equal(formatDuration(120), "2 min");
});

// ---------- findOverlaps ----------

test("findOverlaps: the repo's typical :00 / :30 pair does not overlap", () => {
  const rules = [
    { bumpId: "a", every: "hour", offsetSeconds: 0, durationSeconds: 15 },
    { bumpId: "b", every: "hour", offsetSeconds: 1800, durationSeconds: 10 },
  ];
  assert.deepEqual(findOverlaps(rules), []);
});

test("findOverlaps flags an hourly rule colliding with a half-hourly one", () => {
  const rules = [
    { bumpId: "a", every: "hour", offsetSeconds: 0, durationSeconds: 15 },
    { bumpId: "b", every: "halfHour", offsetSeconds: 10, durationSeconds: 10 },
  ];
  const [o] = findOverlaps(rules);
  assert.equal(o.a, 0);
  assert.equal(o.b, 1);
  assert.equal(o.seconds, 5); // b starts at :00:10 while a runs to :00:15
  // The player really does see both windows at that instant, and plays the first rule.
  assert.ok(bumpRuleWindow(rules[0], o.at) && bumpRuleWindow(rules[1], o.at));
  assert.equal(locateActiveBump(rules, o.at).bumpId, "a");
});

test("findOverlaps catches a window that wraps past the period boundary", () => {
  const rules = [
    { bumpId: "a", every: "hour", offsetSeconds: 3590, durationSeconds: 20 }, // :59:50 -> :00:10
    { bumpId: "b", every: "day", offsetSeconds: 0, durationSeconds: 5 },
  ];
  assert.deepEqual(findOverlaps(rules).map(({ a, b }) => [a, b]), [[0, 1]]);
});

test("findOverlaps ignores adjacent (touching) windows and incomplete rules", () => {
  const rules = [
    { bumpId: "a", every: "hour", offsetSeconds: 0, durationSeconds: 30 },
    { bumpId: "b", every: "hour", offsetSeconds: 30, durationSeconds: 30 },
    { bumpId: "", every: "hour", offsetSeconds: 0, durationSeconds: 30 },
  ];
  assert.deepEqual(findOverlaps(rules), []);
});

// ---------- fitWarning ----------

test("fitWarning explains cut / loop / exact / open / missing", () => {
  const v2 = { id: "x", duration: 15 };
  assert.equal(fitWarning({ durationSeconds: 15 }, v2).fit, "exact");
  assert.equal(fitWarning({ durationSeconds: 15 }, v2).level, null);
  const cut = fitWarning({ durationSeconds: 10 }, v2);
  assert.equal(cut.fit, "cut");
  assert.equal(cut.level, "warn");
  assert.match(cut.message, /Cut short/);
  const loop = fitWarning({ durationSeconds: 20 }, v2);
  assert.equal(loop.fit, "loop");
  assert.match(loop.message, /Loops/);
  assert.equal(fitWarning({ durationSeconds: 20 }, { id: "v1" }).fit, "open");
  assert.equal(fitWarning({ bumpId: "gone", durationSeconds: 20 }, null).level, "error");
});

// ---------- misc ----------

test("rulesEqual compares stored fields in order", () => {
  const r = { bumpId: "a", every: "hour", offsetSeconds: 0, durationSeconds: 15 };
  assert.ok(rulesEqual([r], [{ ...r, offsetSeconds: "0" }]));
  assert.ok(!rulesEqual([r], [{ ...r, durationSeconds: 10 }]));
  assert.ok(!rulesEqual([r, { ...r, bumpId: "b" }], [{ ...r, bumpId: "b" }, r]));
});

test("channelInitials", () => {
  assert.equal(channelInitials("Science & Engineering"), "SE");
  assert.equal(channelInitials("USTV"), "US");
  assert.equal(channelInitials(""), "?");
});
