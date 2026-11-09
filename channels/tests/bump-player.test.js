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

import { clampVolume, duckedVolume, normalizeUpcoming } from "../bump-player.js";

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
