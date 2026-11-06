// channels/tests/epg-timeline.test.js
//
// Unit tests for buildEpgTimeline() (Phase 4 of docs/guide-update.md) --
// the guide-facing program-level projection of a published schedule.json,
// alongside the existing playback-facing buildTimeline(). Every schedule
// object below is built by hand (the same shape ScheduleWriter.php
// actually writes: one "normal" block, flat `items`, an optional
// top-level `programs` collection) rather than loaded from a fixture,
// since buildEpgTimeline() is a pure function of exactly that plain data.
// channels/tests/published-schedule.test.js separately proves the real
// PHP-compiled-and-written output loads correctly end to end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, buildEpgTimeline, episodeAiringTimes, locate, airings } from "../broadcast.js";

/** One "normal" block spanning `duration` seconds, holding `items` --
 *  exactly ScheduleWriter's output shape. */
function schedule(duration, items, programs) {
  return {
    schema_version: 1,
    channel: "Test Channel",
    blocks: [{ block: 1, type: "normal", duration, used: 0, remaining: 0, relative_start: 0, items }],
    ...(programs ? { programs } : {}),
  };
}

function videoItem(id, start, duration, extra = {}) {
  return {
    type: "video", id, start, duration, title: `Title ${id}`,
    source: { provider: "youtube", video_id: `v-${id}` },
    ...extra,
  };
}

function gapItem(start, duration, extra = {}) {
  return { type: "gap", start, duration, ...extra };
}

function program(occurrenceId, blockId, start, end, title, extra = {}) {
  return {
    occurrence_id: occurrenceId, block_id: blockId, title, description: null,
    series_id: null, series_title: null, boundary_mode: "hard",
    nominal_start: start, nominal_end: end, start, end, ...extra,
  };
}

test("a packed occurrence's several episodes collapse into one program entry", () => {
  const sch = schedule(3600, [
    videoItem("e1", 0, 500, { program_id: "b@0" }),
    videoItem("e2", 500, 400, { program_id: "b@0" }),
    gapItem(900, 2700, { program_id: "b@0" }),
  ], [program("b@0", "b", 0, 3600, "Electronics Lab")]);

  const tl = buildEpgTimeline(sch, 0);
  assert.equal(tl.entries.length, 1, "one EPG cell, not three raw items");
  const [entry] = tl.entries;
  assert.equal(entry.type, "program");
  assert.equal(entry.title, "Electronics Lab");
  assert.equal(entry.start, 0);
  assert.equal(entry.end, 3600);
  assert.equal(entry.episodes.length, 3, "all three underlying occurrences (2 videos + the unfilled remainder) are still available in detail");
  assert.equal(entry.episodes[0].id, "e1");
  assert.equal(entry.episodes[2].playable, false, "the gap segment is not itself playable");
});

test("a program entry is always playable even when some of its episodes are not", () => {
  const sch = schedule(1000, [
    videoItem("e1", 0, 500, { program_id: "b@0" }),
    gapItem(500, 500, { program_id: "b@0" }),
  ], [program("b@0", "b", 0, 1000, "Show")]);
  const tl = buildEpgTimeline(sch, 0);
  assert.equal(tl.entries[0].playable, true, "the program's own cell is playable (it IS scheduled), independent of its filler");
});

test("adjacent blocks of the same series stay distinct programs, never merged", () => {
  const sch = schedule(2000, [
    videoItem("e1", 0, 500, { program_id: "a@0" }),
    gapItem(500, 500, { program_id: "a@0" }),
    videoItem("e2", 1000, 500, { program_id: "b@1000" }),
    gapItem(1500, 500, { program_id: "b@1000" }),
  ], [
    program("a@0", "a", 0, 1000, "Same Show"),
    program("b@1000", "b", 1000, 2000, "Same Show"),
  ]);
  const tl = buildEpgTimeline(sch, 0);
  assert.equal(tl.entries.length, 2, "two separate occurrences, even with identical titles");
  assert.notEqual(tl.entries[0].id, tl.entries[1].id);
});

test("an AM and a PM occurrence of the same series_id are never confused with each other", () => {
  const sch = schedule(86400, [
    videoItem("e1", 3600, 1800, { program_id: "lineup-x-am@3600" }),
    gapItem(5400, 39600, { program_id: "lineup-x-am@3600" }),
    videoItem("e2", 46800, 1800, { program_id: "lineup-x-pm@46800" }),
    gapItem(48600, 37800, { program_id: "lineup-x-pm@46800" }),
  ], [
    program("lineup-x-am@3600", "lineup-x-am", 3600, 45000, "Great Show"),
    program("lineup-x-pm@46800", "lineup-x-pm", 46800, 86400, "Great Show"),
  ]);
  const tl = buildEpgTimeline(sch, 0);
  assert.equal(tl.entries.length, 2);
  assert.equal(tl.entries[0].title, "Great Show");
  assert.equal(tl.entries[1].title, "Great Show");
  assert.notEqual(tl.entries[0].id, tl.entries[1].id, "AM and PM occurrences get distinct occurrence ids despite identical titles/series");
});

test("a legitimate standalone short program (no program_id) is never merged into its neighbor", () => {
  const sch = schedule(1000, [
    videoItem("e1", 0, 500, { program_id: "a@0" }),
    videoItem("station-id", 500, 30), // explicitly scheduled standalone programming -- no program_id at all
    videoItem("e2", 530, 470, { program_id: "b@530" }),
  ], [program("a@0", "a", 0, 500, "Show A"), program("b@530", "b", 530, 1000, "Show B")]);
  const tl = buildEpgTimeline(sch, 0);
  assert.equal(tl.entries.length, 3, "the station id keeps its own narrow cell, not folded into either neighbor");
  assert.equal(tl.entries[1].id, "station-id");
  assert.equal(tl.entries[1].end - tl.entries[1].start, 30);
});

test("a legacy schedule with no programs collection falls back to one entry per item, unchanged", () => {
  const sch = schedule(900, [
    videoItem("e1", 0, 500),
    gapItem(500, 400),
  ]); // no "programs" key at all -- e.g. Film Day at School
  const playback = buildTimeline(sch, 0);
  const epg = buildEpgTimeline(sch, 0);
  assert.equal(epg.entries.length, playback.entries.length, "identical to the playback timeline when there is no program metadata");
  assert.equal(epg.entries[0].type, "video");
  assert.equal(epg.entries[1].type, "gap");
});

test("an item referencing an unknown program_id degrades to a standalone entry rather than disappearing", () => {
  const sch = schedule(500, [videoItem("e1", 0, 500, { program_id: "ghost@0" })], []); // programs: [] -- nothing resolves "ghost@0"
  const tl = buildEpgTimeline(sch, 0);
  assert.equal(tl.entries.length, 1);
  assert.equal(tl.entries[0].id, "e1", "falls through to the legacy per-item shape, never silently dropped");
});

test("episodeAiringTimes() resolves an episode's absolute time from its owning program airing", () => {
  const sch = schedule(3600, [
    videoItem("e1", 0, 900, { program_id: "b@0" }),
    videoItem("e2", 900, 900, { program_id: "b@0" }),
    gapItem(1800, 1800, { program_id: "b@0" }),
  ], [program("b@0", "b", 0, 3600, "Show")]);
  const tl = buildEpgTimeline(sch, 1_000_000); // arbitrary anchor
  const [airing] = airings(tl, 1_000_000, 1_000_000 + 3600);
  const times = episodeAiringTimes(airing, airing.episodes[1]);
  assert.equal(times.startsAt, 1_000_000 + 900);
  assert.equal(times.endsAt, 1_000_000 + 1800);
});

test("the currently-airing episode within a program is the one locate() finds at `now`", () => {
  const sch = schedule(3600, [
    videoItem("e1", 0, 900, { program_id: "b@0" }),
    videoItem("e2", 900, 900, { program_id: "b@0" }),
    gapItem(1800, 1800, { program_id: "b@0" }),
  ], [program("b@0", "b", 0, 3600, "Show")]);
  const anchor = 500_000;
  const tl = buildEpgTimeline(sch, anchor);
  const t = anchor + 950; // 50s into e2
  const airing = locate(tl, t);
  assert.equal(airing.title, "Show");
  const nowEpisode = airing.episodes.find((ep) => {
    const times = episodeAiringTimes(airing, ep);
    return times.startsAt <= t && t < times.endsAt;
  });
  assert.equal(nowEpisode.id, "e2");
});

test("no two EPG entries overlap across a cycle boundary (midnight/window-repeat crossing)", () => {
  const sch = schedule(7200, [
    videoItem("e1", 0, 3600, { program_id: "a@0" }),
    videoItem("e2", 3600, 3600, { program_id: "b@3600" }),
  ], [program("a@0", "a", 0, 3600, "Morning"), program("b@3600", "b", 3600, 7200, "Evening")]);
  const tl = buildEpgTimeline(sch, 0);
  // Ask for a window spanning 1.5 cycles -- forces the cycle to wrap once,
  // the same "does the loop repeat cleanly" guarantee buildTimeline already
  // has, now checked for the grouped program-level entries too.
  const got = airings(tl, 0, 7200 * 1.5);
  assert.equal(got.length, 3, "Morning, Evening, then Morning again -- no duplicate or dropped entry at the wrap point");
  assert.equal(got[0].title, "Morning");
  assert.equal(got[1].title, "Evening");
  assert.equal(got[2].title, "Morning");
  assert.equal(got[1].endsAt, got[2].startsAt, "back to back across the wrap, no gap or overlap introduced by it");
});
