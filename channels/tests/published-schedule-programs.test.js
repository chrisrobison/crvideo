// channels/tests/published-schedule-programs.test.js
//
// Same cross-boundary integration approach as published-schedule.test.js,
// extended to the program-level EPG:
// loads a REAL schedule.json compiled and written by the actual, unmodified
// PHP publisher (channels/publish.php) through the REAL, unmodified
// buildEpgTimeline()/locate()/airings() -- not just buildTimeline() -- and
// proves the "programs" collection it writes groups correctly end to end.
//
// Fixture source: channels/publish/tests/fixtures/epg-demo/ (a
// programming.json block titled "Demo Hour", packing enabled, two approved
// episodes -- ep1 900s, ep2 600s -- in a 1800s slot, deliberately leaving a
// 300s unfilled remainder with no continuity.json configured). Generated
// once with:
//
//   php channels/publish.php demo-channel \
//     --channels-root=<a scratch copy of fixtures/epg-demo/channels> \
//     --days=3 --window-start=2026-11-02 --window-timezone=America/Los_Angeles
//
// then the written schedule.json/meta.json were copied, unmodified, to
// channels/tests/fixtures/published-schedule-programs-sample/ (the same
// pattern published-schedule.test.js's own fixture was generated with).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildEpgTimeline, buildTimeline, episodeAiringTimes, locate, airings } from "../broadcast.js";

const FIXTURE = new URL("./fixtures/published-schedule-programs-sample/", import.meta.url);

function readJson(relative) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, FIXTURE)), "utf8"));
}

const schedule = readJson("schedule.json");
const meta = readJson("meta.json");
const anchor = Date.parse(meta.anchor) / 1000;

test("the real publisher's \"programs\" collection groups packed episodes plus their under-filled remainder into one EPG entry per occurrence", () => {
  const tl = buildEpgTimeline(schedule, anchor);
  const programEntries = tl.entries.filter((e) => e.type === "program");
  assert.equal(programEntries.length, 3, "three daily occurrences across the 3-day window");
  for (const p of programEntries) {
    assert.equal(p.title, "Demo Hour");
    assert.equal(p.episodes.length, 3, "ep1 + ep2 + the 300s unfilled remainder, all three kept, not discarded");
    assert.equal(p.end - p.start, 1800, "the full nominal slot, not just however much the two episodes used");
  }
});

test("the playback timeline is completely unaffected by any of this -- same entries buildTimeline() always produced", () => {
  const tl = buildTimeline(schedule, anchor);
  // Still one entry per raw item (2 videos + 2 gap segments per occurrence,
  // now one of those gaps split at the program boundary -- see
  // ScheduleWriterTest's testASingleRawGapStraddling... -- plus the long
  // inter-occurrence gaps): the player was never told anything about programs.
  const videos = tl.entries.filter((e) => e.playable);
  assert.equal(videos.length, 6, "2 videos x 3 occurrences, exactly as before this feature existed");
});

test("locate() on the EPG timeline resolves the whole occurrence, and the correct episode within it, at an arbitrary instant", () => {
  const tl = buildEpgTimeline(schedule, anchor);
  // First occurrence: ep1 at relative 46800 (900s), ep2 at 47700 (600s).
  // Tune in 100s into ep2.
  const t = anchor + 47700 + 100;
  const airing = locate(tl, t);
  assert.equal(airing.title, "Demo Hour");
  assert.equal(airing.playable, true);

  const current = airing.episodes.find((ep) => {
    const times = episodeAiringTimes(airing, ep);
    return times.startsAt <= t && t < times.endsAt;
  });
  assert.equal(current.id, "ep2");
  const times = episodeAiringTimes(airing, current);
  assert.ok(Math.abs(t - times.startsAt - 100) < 0.001);
});

test("the unfilled remainder resolves as part of the program, not as its own separate gap entry", () => {
  const tl = buildEpgTimeline(schedule, anchor);
  // 48300..48600 (relative) is the real, un-filled 300s remainder.
  const t = anchor + 48300 + 10;
  const airing = locate(tl, t);
  assert.equal(airing.type, "program", "still inside Demo Hour's own EPG cell, not a bare station-break gap");
  assert.equal(airing.title, "Demo Hour");
  assert.equal(airing.playable, true);
});

test("the real inter-occurrence gap (nothing scheduled at all) resolves as a non-playable gap, same as always", () => {
  const tl = buildEpgTimeline(schedule, anchor);
  const t = anchor + 48600 + 10; // just past the program's own nominal end
  const airing = locate(tl, t);
  assert.equal(airing.playable, false);
  assert.notEqual(airing.type, "program");
});

test("three occurrences across the published window never overlap", () => {
  const tl = buildEpgTimeline(schedule, anchor);
  const got = airings(tl, anchor, anchor + schedule.blocks[0].duration);
  let prevEnd = -Infinity;
  for (const a of got) {
    assert.ok(a.startsAt >= prevEnd, "no entry starts before the previous one ended");
    prevEnd = a.endsAt;
  }
});
