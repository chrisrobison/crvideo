// channels/tests/published-schedule.test.js
//
// Integration test across the PHP/JS boundary: channels/publish/ (PHP)
// compiles recurring-series programming into a schedule.json; this test
// loads a REAL compiled schedule.json (committed at
// channels/tests/fixtures/published-schedule-sample/, generated once by
// running `php channels/publish.php` against a small fixture channel --
// see that directory's generation command in the phase 4 report) through
// the REAL, unmodified player code (buildTimeline/locate from
// broadcast.js) and proves two things end to end, not just at either side
// in isolation:
//
//   1. A calendar-recurrence-compiled schedule is just an ordinary
//      schedule.json as far as the player is concerned -- no player code
//      needed to change (phase 4's core design constraint).
//   2. "Joining a broadcast in the middle of an episode" -- tuning in at
//      an arbitrary instant inside a published episode's airtime --
//      resolves to the correct videoId/provider AND the correct offset
//      into that episode, purely from locate()'s existing startsAt math.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildTimeline, locate } from "../broadcast.js";

const FIXTURE = new URL("./fixtures/published-schedule-sample/", import.meta.url);

function readJson(relative) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, FIXTURE)), "utf8"));
}

const schedule = readJson("schedule.json");
const meta = readJson("meta.json");
const anchor = Date.parse(meta.anchor) / 1000;

test("a published (calendar-recurrence-compiled) schedule.json builds a valid timeline with no player changes", () => {
  const tl = buildTimeline(schedule, anchor);
  assert.equal(tl.cycle, 259200); // the 3-day window's real elapsed seconds
});

test("each published episode occurrence resolves with structured YouTube provider metadata, not url sniffing", () => {
  const tl = buildTimeline(schedule, anchor);
  // The fixture's three occurrences sit at relative seconds 46800 (ep1),
  // 133200 (ep2), 219600 (ep1 again -- the 2-episode rotation looping).
  const first = locate(tl, anchor + 46800 + 1);
  assert.equal(first.id, "ep1");
  assert.equal(first.playable, true);
  assert.equal(first.provider, "youtube");
  assert.equal(first.videoId, "aaa111");

  const second = locate(tl, anchor + 133200 + 1);
  assert.equal(second.id, "ep2");
  assert.equal(second.videoId, "bbb222");

  const third = locate(tl, anchor + 219600 + 1);
  assert.equal(third.id, "ep1");
  assert.equal(third.videoId, "aaa111");
});

test("tuning in mid-episode resolves the correct program AND the correct join offset into it", () => {
  const tl = buildTimeline(schedule, anchor);
  // ep1's first occurrence airs for 900s starting at relative t=46800.
  // Tune in 300s into it.
  const joinAt = anchor + 46800 + 300;
  const airing = locate(tl, joinAt);
  assert.equal(airing.id, "ep1");
  assert.equal(airing.playable, true);

  // This is exactly the computation BroadcastPlayer.load() performs
  // (channels/broadcast.js: `now() - this.airing.startsAt`) to decide
  // where to start/seek a newly-joining viewer.
  const offsetIntoEpisode = joinAt - airing.startsAt;
  assert.ok(Math.abs(offsetIntoEpisode - 300) < 0.001, `expected ~300s in, got ${offsetIntoEpisode}`);

  // And it must be well within the episode's real 900s duration -- not
  // past its end, not before its start.
  assert.ok(offsetIntoEpisode >= 0 && offsetIntoEpisode < 900);
});

test("time between occurrences resolves as a non-playable gap, not a crash", () => {
  const tl = buildTimeline(schedule, anchor);
  const gap = locate(tl, anchor + 10000); // well before the first occurrence at 46800
  assert.equal(gap.playable, false);
  assert.equal(gap.provider, null);
});

test("two independent lookups at the same instant agree -- deterministic, clock-derived selection", () => {
  const tl = buildTimeline(schedule, anchor);
  const t = anchor + 133200 + 42;
  const a = locate(tl, t);
  const b = locate(tl, t);
  assert.deepEqual(a, b);
});
