// channels/tests/bump-player.test.js
//
// Coverage for bump-player.js's pure, unit-testable helpers (volume
// clamping/ducking math, upcoming-list normalization). The actual
// <cr-bump> Web Component -- shadow DOM, <video>/<audio> wiring, real
// playback -- has no meaningful behavior without a real browser, same
// posture/rationale as player-adapters.test.js's header re: Html5PlayerAdapter/
// YouTubePlayerAdapter: faking the DOM well enough to exercise it wouldn't
// prove anything a browser wouldn't prove better.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clampVolume, duckedVolume, normalizeUpcoming,
  DEFAULT_BUMP_DURATION, bumpDuration, effectiveDuration, bumpTiming, compositionTime,
  layerStateAt, mediaPosition, needsResync, scheduleFit, CompositionClock,
} from "../bump-player.js";
import { BumpRenderer } from "../player-adapters.js";

// ---------- clampVolume ----------

test("clampVolume passes a value already in [0,1] through unchanged", () => {
  assert.equal(clampVolume(0.4), 0.4);
  assert.equal(clampVolume(0), 0);
  assert.equal(clampVolume(1), 1);
});

test("clampVolume clamps out-of-range values", () => {
  assert.equal(clampVolume(1.5), 1);
  assert.equal(clampVolume(-0.2), 0);
});

test("clampVolume falls back on a missing/non-numeric value instead of producing NaN", () => {
  assert.equal(clampVolume(undefined), 0.6);
  assert.equal(clampVolume(null), 0.6);
  assert.equal(clampVolume("not a number"), 0.6);
  assert.equal(clampVolume(undefined, 0.2), 0.2);
});

// ---------- duckedVolume ----------

test("duckedVolume multiplies the layer's own volume by duckTo", () => {
  assert.equal(duckedVolume(0.8, 0.5), 0.4);
  assert.equal(duckedVolume(1, 0), 0);
});

test("duckedVolume tolerates missing inputs via clampVolume's own fallbacks", () => {
  assert.equal(duckedVolume(undefined, undefined), 0 * 0.3);
});

// ---------- normalizeUpcoming ----------

const SHOW = (title, startsAt) => ({ title, startsAt });

test("normalizeUpcoming slices to at most `count` entries", () => {
  const list = [SHOW("A", 1), SHOW("B", 2), SHOW("C", 3), SHOW("D", 4)];
  assert.deepEqual(normalizeUpcoming(list, 2), [SHOW("A", 1), SHOW("B", 2)]);
});

test("normalizeUpcoming clamps count to the [0,6] range", () => {
  const list = [SHOW("A", 1), SHOW("B", 2)];
  assert.equal(normalizeUpcoming(list, 99).length, 2); // only 2 available either way
  assert.deepEqual(normalizeUpcoming(list, -3), []);
  assert.deepEqual(normalizeUpcoming(list, 0), []);
});

test("normalizeUpcoming drops malformed entries instead of throwing", () => {
  const list = [SHOW("A", 1), { title: "no startsAt" }, { startsAt: 2 }, null, SHOW("B", 3)];
  assert.deepEqual(normalizeUpcoming(list, 6), [SHOW("A", 1), SHOW("B", 3)]);
});

test("normalizeUpcoming tolerates a non-array list", () => {
  assert.deepEqual(normalizeUpcoming(null, 3), []);
  assert.deepEqual(normalizeUpcoming(undefined, 3), []);
});

// ---------- composition timing (schema_version 2) ----------

const V1 = { schema_version: 1, upcoming: { count: 3, label: "Coming Up" }, announcement: { url: "media/a.mp3", duckTo: 0.3 } };
const V2 = {
  schema_version: 2,
  duration: 15,
  announcement: { url: "media/a.mp3", duckTo: 0.3, start: 2 },
  upcoming: { count: 3, label: "Coming Up", start: 1, end: 12 },
};

test("bumpDuration is null for a v1 bump; effectiveDuration falls back to the documented default", () => {
  assert.equal(bumpDuration(V1), null);
  assert.equal(effectiveDuration(V1), DEFAULT_BUMP_DURATION);
  assert.equal(DEFAULT_BUMP_DURATION, 15);
  assert.equal(bumpDuration(V2), 15);
  assert.equal(bumpDuration({ duration: 0 }), null);
  assert.equal(bumpDuration({ duration: "abc" }), null);
  assert.equal(bumpDuration(null), null);
});

test("bumpTiming defaults reproduce v1 behavior: voice at 0, text for the whole window", () => {
  assert.deepEqual(bumpTiming(V1), { duration: null, announcementStart: 0, upcomingStart: 0, upcomingEnd: Infinity });
  assert.deepEqual(bumpTiming(V2), { duration: 15, announcementStart: 2, upcomingStart: 1, upcomingEnd: 12 });
});

test("compositionTime: a v1 bump never wraps on air (its schedule rule alone decides the length)", () => {
  assert.equal(compositionTime(40, V1), 40);
  assert.equal(compositionTime(-3, V1), 0);
});

test("compositionTime: a v2 bump loops on air when the window outlasts its duration", () => {
  assert.equal(compositionTime(4, V2), 4);
  assert.equal(compositionTime(15, V2), 0);
  assert.equal(compositionTime(17.5, V2), 2.5);
});

test("compositionTime: 'stop' clamps and 'loop' wraps at the effective duration (editor modes)", () => {
  assert.equal(compositionTime(99, V1, "stop"), DEFAULT_BUMP_DURATION);
  assert.equal(compositionTime(99, V2, "stop"), 15);
  assert.equal(compositionTime(16, V1, "loop"), 1);
});

test("layerStateAt: text appears only inside upcoming.start..end", () => {
  assert.equal(layerStateAt(V2, 0.5).textVisible, false);
  assert.equal(layerStateAt(V2, 1).textVisible, true);
  assert.equal(layerStateAt(V2, 11.99).textVisible, true);
  assert.equal(layerStateAt(V2, 12).textVisible, false);
  assert.equal(layerStateAt(V1, 0).textVisible, true);
  assert.equal(layerStateAt(V1, 500).textVisible, true);
});

test("layerStateAt: announcement is positioned by announcement.start and its real clip length", () => {
  assert.deepEqual(layerStateAt(V2, 1, { announcementDuration: 4 }).announcement, { active: false, offset: 0, before: true });
  assert.deepEqual(layerStateAt(V2, 3.5, { announcementDuration: 4 }).announcement, { active: true, offset: 1.5, before: false });
  assert.equal(layerStateAt(V2, 6, { announcementDuration: 4 }).announcement.active, false); // 2 + 4 = done
  // Unknown clip length: active from its start until it ends on its own.
  assert.equal(layerStateAt(V2, 60).announcement.active, true);
  assert.equal(layerStateAt({ upcoming: {} }, 1).announcement, null);
});

test("mediaPosition wraps looping media and clamps one-shot media", () => {
  assert.equal(mediaPosition(25, 10, true), 5);
  assert.equal(mediaPosition(25, 10, false), 10);
  assert.equal(mediaPosition(3, NaN, true), 3);
  assert.equal(mediaPosition(-1, 10, false), 0);
});

test("needsResync tolerates small drift and measures distance across a loop seam", () => {
  assert.equal(needsResync(5.0, 5.2), false);
  assert.equal(needsResync(5.0, 6.0), true);
  assert.equal(needsResync(9.9, 0.1, { loopLength: 10 }), false); // 0.2s apart across the seam
  assert.equal(needsResync(9.9, 0.1), true);
  assert.equal(needsResync(NaN, 1), false);
});

test("scheduleFit reports exact / cut / loop / open", () => {
  assert.equal(scheduleFit(15, V2), "exact");
  assert.equal(scheduleFit(10, V2), "cut");
  assert.equal(scheduleFit(30, V2), "loop");
  assert.equal(scheduleFit(12, V1), "open");
});

// ---------- CompositionClock: derived from a clock, never accumulated ----------

function fakeNow(start = 1000) {
  const c = { t: start };
  return { c, now: () => c.t };
}

test("CompositionClock reads elapsed time from the clock, independent of how often it's sampled", () => {
  const { c, now } = fakeNow();
  const clock = new CompositionClock(now);
  clock.play(0);
  // Sample irregularly (simulating throttled/missed timer ticks) -- the
  // reading only ever depends on the clock, so there's nothing to drift.
  c.t += 0.016; clock.elapsed;
  c.t += 2.984;
  assert.equal(clock.elapsed, 3);
  c.t += 600; // a background tab that never ticked for 10 minutes
  assert.equal(clock.elapsed, 603);
});

test("CompositionClock starts at an offset (a viewer joining mid-bump)", () => {
  const { c, now } = fakeNow();
  const clock = new CompositionClock(now);
  clock.play(7.25);
  assert.equal(clock.elapsed, 7.25);
  c.t += 1;
  assert.equal(clock.elapsed, 8.25);
});

test("CompositionClock pause holds, seek moves, play resumes from the held point", () => {
  const { c, now } = fakeNow();
  const clock = new CompositionClock(now);
  clock.play(0);
  c.t += 4;
  clock.pause();
  c.t += 10;
  assert.equal(clock.elapsed, 4);
  assert.equal(clock.playing, false);
  clock.seek(9);
  assert.equal(clock.elapsed, 9);
  clock.play();
  c.t += 1;
  assert.equal(clock.elapsed, 10);
});

test("clock-derived live offset + compositionTime gives the same frame to every viewer", () => {
  // Window opened at broadcast time 1000; viewers tune in at 1003 and 1017
  // (each starting at its own clock-derived offset) and are compared at 1019.
  const windowStart = 1000;
  const { c, now } = fakeNow(1003);
  const early = new CompositionClock(now);
  early.play(c.t - windowStart);
  c.t = 1017;
  const late = new CompositionClock(now);
  late.play(c.t - windowStart);
  c.t = 1019;
  assert.equal(compositionTime(early.elapsed, V2), compositionTime(late.elapsed, V2));
  assert.equal(compositionTime(early.elapsed, V2), 4); // 19s into a looping 15s composition
});

// ---------- BumpRenderer passes the clock-derived offset to <cr-bump> ----------

test("BumpRenderer.show() starts the bump at the given window offset", () => {
  const calls = [];
  const fakeEl = { play: (opts) => calls.push(opts), setMuted() {}, stop() {} };
  const container = { hidden: true, appendChild() {} };
  const renderer = new BumpRenderer(container);
  renderer.el = fakeEl; // skip document.createElement in Node
  renderer.show(V2, [], null, () => 0, true, 6.5);
  assert.deepEqual(calls[0], { muted: true, offset: 6.5 });
  renderer.show(V2, [], null, () => 0, false);
  assert.deepEqual(calls[1], { muted: false, offset: 0 });
  assert.equal(container.hidden, false);
});
