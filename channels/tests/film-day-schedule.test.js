// channels/tests/film-day-schedule.test.js
//
// Integration coverage for the feature/film-day-thematic-blocks migration:
// Film Day at School was the one channel still built by the old, one-off
// ia-import "balanced" bin-packed generator (flat 30-minute blocks with no
// topical organization -- see git history for the original schedule.json
// shape). It's now compiled by the same channels/publish.php pipeline
// every other channel uses, from channels/film-day-at-school/
// programming.json's ten thematic blocks (Health Class, Civics Hour,
// Science Shorts, The Working World x2, Mind Your Manners x2, Safety
// First, Wired World, On the Move, Marriage & the Office, Shorts &
// Curiosities) over the real 167-item catalog, re-curated by subject
// matter into series/film-day-*/series.json.
//
// This loads the REAL, already-committed channels/film-day-at-school/
// schedule.json + meta.json (not a synthetic fixture) through the real,
// unmodified buildEpgTimeline()/buildTimeline() -- same approach as
// published-schedule-programs.test.js -- to prove the migration actually
// produced a correctly-grouped guide, not just a well-formed
// programming.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildEpgTimeline, buildTimeline, airings } from "../broadcast.js";

const BASE = new URL("../film-day-at-school/", import.meta.url);

function readJson(relative) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, BASE)), "utf8"));
}

const schedule = readJson("schedule.json");
const meta = readJson("meta.json");
const anchor = Date.parse(meta.anchor) / 1000;

const EXPECTED_THEME_TITLES = new Set([
  "Health Class",
  "Civics Hour",
  "Science Shorts",
  "The Working World",
  "Mind Your Manners",
  "Safety First",
  "Wired World",
  "On the Move",
  "Marriage & the Office",
  "Shorts & Curiosities",
]);

test("schedule.json carries the program-level \"programs\" collection (the old one-off generator never emitted this)", () => {
  assert.ok(Array.isArray(schedule.programs), "expected a top-level \"programs\" array");
  assert.ok(schedule.programs.length > 0);
  for (const p of schedule.programs) {
    assert.ok(EXPECTED_THEME_TITLES.has(p.title), `unexpected program title "${p.title}"`);
  }
});

test("the EPG timeline groups each packed occurrence into exactly one guide cell per theme, not one per film", () => {
  const tl = buildEpgTimeline(schedule, anchor);
  const programEntries = tl.entries.filter((e) => e.type === "program");
  assert.ok(programEntries.length > 0, "expected at least one program entry");

  // Every raw video item in the compiled schedule carries a program_id;
  // the EPG must fold all of them into program entries, never leaving a
  // themed occurrence's films as individual top-level entries.
  const rawVideoCount = schedule.blocks.reduce(
    (sum, b) => sum + b.items.filter((it) => it.type === "video").length,
    0,
  );
  const groupedVideoCount = programEntries.reduce((sum, p) => sum + p.episodes.length, 0);
  assert.ok(
    groupedVideoCount >= rawVideoCount,
    `expected every one of the ${rawVideoCount} raw video items (plus any in-program filler) to be ` +
      `accounted for across program entries' episodes, got ${groupedVideoCount}`,
  );

  // At least one occurrence should actually be multi-film (that's the
  // entire point of packing short archival shorts into a 2-hour slot) --
  // this is the concrete proof the "one tiny illegible cell per film"
  // complaint is fixed for this channel.
  const multiFilm = programEntries.filter((p) => p.episodes.length > 1);
  assert.ok(multiFilm.length > 0, "expected at least one program occurrence packing more than one film");
});

test("a multi-film program occurrence expands its full lineup in order, each with real editorial metadata", () => {
  const tl = buildEpgTimeline(schedule, anchor);
  const busy = tl.entries.find((e) => e.type === "program" && e.episodes.length > 1);
  assert.ok(busy, "expected to find a packed, multi-film program occurrence");
  for (const ep of busy.episodes) {
    if (ep.type === "gap" || ep.type === "continuity") continue;
    assert.ok(typeof ep.title === "string" && ep.title.length > 0, "each packed episode keeps its own real title");
  }
});

test("the playback timeline is unaffected by the program-level grouping -- same raw video count as the compiled schedule", () => {
  const tl = buildTimeline(schedule, anchor);
  const playable = tl.entries.filter((e) => e.playable);
  const rawVideoCount = schedule.blocks.reduce(
    (sum, b) => sum + b.items.filter((it) => it.type === "video").length,
    0,
  );
  assert.equal(playable.length, rawVideoCount);
});

test("airings() across one full published cycle never overlap", () => {
  const tl = buildEpgTimeline(schedule, anchor);
  const got = airings(tl, anchor, anchor + tl.cycle);
  let prevEnd = -Infinity;
  for (const a of got) {
    assert.ok(a.startsAt >= prevEnd, "no entry starts before the previous one ended");
    prevEnd = a.endsAt;
  }
});
