// channels/tests/player-adapters.test.js
//
// Coverage for the parts of the provider/playback-adapter layer that are
// genuinely unit-testable under Node: the pure helpers in
// player-adapters.js (backoff math, drift-correction math, structured
// provider resolution) and how that provider resolution flows through
// broadcast.js's buildTimeline()/locate()/airings()/nextProgram() to keep
// deterministic, clock-derived program selection working for both a
// legacy (implicit html5) schedule item and a YouTube-sourced one.
//
// What this file deliberately does NOT attempt to test -- and why: the
// actual DOM/<video> wiring in Html5PlayerAdapter, and all of
// YouTubePlayerAdapter (which talks to window.YT, a real IFrame API
// instance, and a live iframe) have no meaningful behavior without a real
// browser. Faking `document`/`YT` well enough to exercise them wouldn't
// prove anything a browser wouldn't already prove better; it would just
// be testing a hand-built mock against itself. Those parts are called out
// explicitly in the test report as needing manual/browser verification
// instead of being covered by a brittle, low-value fake.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { computeBackoffMs, computeDriftCorrection, resolveProvider } from "../player-adapters.js";
import { buildTimeline, locate, airings, nextProgram } from "../broadcast.js";

// ---------- computeBackoffMs ----------

test("computeBackoffMs doubles from a 2s base and caps at 30s", () => {
  assert.equal(computeBackoffMs(1), 2000);
  assert.equal(computeBackoffMs(2), 4000);
  assert.equal(computeBackoffMs(3), 8000);
  assert.equal(computeBackoffMs(4), 16000);
  assert.equal(computeBackoffMs(5), 30000); // 32000 -> capped
  assert.equal(computeBackoffMs(6), 30000);
  assert.equal(computeBackoffMs(20), 30000);
});

test("computeBackoffMs treats a non-positive attempt as the first attempt", () => {
  assert.equal(computeBackoffMs(0), 2000);
  assert.equal(computeBackoffMs(-5), 2000);
});

// ---------- computeDriftCorrection ----------

test("computeDriftCorrection returns null when within tolerance", () => {
  assert.equal(computeDriftCorrection(100, 101.5, 3, 600), null);
});

test("computeDriftCorrection returns the target when drift exceeds tolerance", () => {
  assert.equal(computeDriftCorrection(90, 100, 3, 600), 100);
});

test("computeDriftCorrection never returns a negative seek target", () => {
  assert.equal(computeDriftCorrection(50, -5, 3, 600), 0);
});

test("computeDriftCorrection returns null near the end of a known duration (let it end naturally)", () => {
  // duration 600, target 599.8 -- within the existing 0.25s "about to end" guard.
  assert.equal(computeDriftCorrection(590, 599.8, 3, 600), null);
});

test("computeDriftCorrection returns null for non-finite current/target time (e.g. the adapter isn't ready yet)", () => {
  assert.equal(computeDriftCorrection(NaN, 100, 3, 600), null);
  assert.equal(computeDriftCorrection(100, NaN, 3, 600), null);
  assert.equal(computeDriftCorrection(100, 105, 3, NaN), 105); // unknown duration is fine -- just means no near-end guard
});

// ---------- resolveProvider ----------

test("resolveProvider falls back to the legacy implicit html5 convention for a plain media_url item", () => {
  const r = resolveProvider({ media_url: "https://archive.org/download/x/x.mp4" });
  assert.deepEqual(r, { provider: "html5", videoId: null });
});

test("resolveProvider returns no provider for a gap (no media_url, no source)", () => {
  const r = resolveProvider({ type: "gap" });
  assert.deepEqual(r, { provider: null, videoId: null });
});

test("resolveProvider reads structured source.provider for a YouTube item, not the URL", () => {
  const r = resolveProvider({
    source: { provider: "youtube", video_id: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
  });
  assert.deepEqual(r, { provider: "youtube", videoId: "dQw4w9WgXcQ" });
});

test("resolveProvider treats a youtube source with no video_id as unplayable, never guessing one", () => {
  const r = resolveProvider({ source: { provider: "youtube" } });
  assert.deepEqual(r, { provider: null, videoId: null });
});

test("resolveProvider passes through an unrecognized-but-present provider for future-proofing", () => {
  const r = resolveProvider({ source: { provider: "vimeo" }, media_url: "https://example.test/should-be-ignored.mp4" });
  assert.deepEqual(r, { provider: "vimeo", videoId: null });
});

test("resolveProvider prefers structured source over a coincidentally-present media_url", () => {
  // A YouTube item should never be picked up as "html5" just because some
  // other field happens to be set -- provider resolution must be
  // structured, not url/field sniffing.
  const r = resolveProvider({
    source: { provider: "youtube", video_id: "abc123" },
    media_url: "https://example.test/irrelevant.mp4",
  });
  assert.deepEqual(r, { provider: "youtube", videoId: "abc123" });
});

// ---------- end-to-end through buildTimeline/locate/airings/nextProgram ----------

function schedule(items) {
  return {
    schema_version: 1,
    channel: "Test Channel",
    slot_duration: 1800,
    blocks: [{ block: 1, type: "normal", duration: 1800, items }],
  };
}

test("a legacy (implicit html5) schedule item resolves and locates exactly as before", () => {
  const tl = buildTimeline(schedule([
    { type: "video", id: "a", start: 0, duration: 900, title: "A", media_url: "https://x.test/a.mp4" },
    { type: "gap", start: 900, duration: 900 },
  ]));
  const loc = locate(tl, tl.anchor + 10);
  assert.equal(loc.playable, true);
  assert.equal(loc.provider, "html5");
  assert.equal(loc.videoId, null);
  assert.equal(loc.mediaUrl, "https://x.test/a.mp4");
});

test("a YouTube-sourced schedule item is located as a real, playable program via structured source metadata", () => {
  const tl = buildTimeline(schedule([
    {
      type: "video", id: "yt-dQw4w9WgXcQ", start: 0, duration: 900, title: "A YouTube Episode",
      source: { provider: "youtube", video_id: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    },
    { type: "gap", start: 900, duration: 900 },
  ]));
  const loc = locate(tl, tl.anchor + 10);
  assert.equal(loc.playable, true);
  assert.equal(loc.provider, "youtube");
  assert.equal(loc.videoId, "dQw4w9WgXcQ");
  assert.equal(loc.mediaUrl, null);
  assert.equal(loc.sourceUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(loc.title, "A YouTube Episode");

  // Program selection stays deterministic and clock-derived: the same
  // instant always locates the same entry, by construction (locate() is a
  // pure function of (timeline, t)).
  const again = locate(tl, tl.anchor + 10);
  assert.deepEqual(loc, again);
});

test("airings() and nextProgram() both treat a YouTube item as a real program, not a gap", () => {
  const tl = buildTimeline(schedule([
    {
      type: "video", id: "yt-1", start: 0, duration: 600, title: "YT One",
      source: { provider: "youtube", video_id: "vid1" },
    },
    { type: "gap", start: 600, duration: 300 },
    { type: "video", id: "a2", start: 900, duration: 900, title: "HTML5 Two", media_url: "https://x.test/2.mp4" },
  ]));
  const all = airings(tl, tl.anchor, tl.anchor + tl.cycle);
  const playableTitles = all.filter((a) => a.playable).map((a) => a.title);
  assert.deepEqual(playableTitles, ["YT One", "HTML5 Two"]);

  const next = nextProgram(tl, tl.anchor + 10);
  assert.equal(next.title, "HTML5 Two"); // the next program *after* the currently-airing YT One
});

test("the real channels/youtube-adapter-demo/schedule.json (the manual QA fixture) resolves both programs with the right providers", () => {
  const raw = readFileSync(fileURLToPath(new URL("../youtube-adapter-demo/schedule.json", import.meta.url)), "utf8");
  const tl = buildTimeline(JSON.parse(raw));
  assert.equal(tl.cycle, 80);

  const html5Program = locate(tl, tl.anchor + 10);
  assert.equal(html5Program.provider, "html5");
  assert.equal(html5Program.playable, true);
  assert.equal(html5Program.mediaUrl, "https://archive.org/download/0771_Duck_and_Cover_12_33_20_12/0771_Duck_and_Cover_12_33_20_12.mp4");

  const youtubeProgram = locate(tl, tl.anchor + 70);
  assert.equal(youtubeProgram.provider, "youtube");
  assert.equal(youtubeProgram.playable, true);
  assert.equal(youtubeProgram.videoId, "jNQXAC9IVRw");

  // The 80s cycle repeats with no gap, so a viewer tuning in at any time
  // sees one of the two programs -- never a station break -- confirmed
  // across every second of the loop, not just the two sampled instants
  // above.
  for (let t = 0; t < 80; t++) {
    assert.equal(locate(tl, tl.anchor + t).playable, true, `expected a program airing at t=${t}`);
  }
});

test("a malformed youtube item (missing video_id) locates as an unplayable gap-like entry, not a crash", () => {
  const tl = buildTimeline(schedule([
    { type: "video", id: "bad", start: 0, duration: 900, title: "Bad", source: { provider: "youtube" } },
    { type: "video", id: "good", start: 900, duration: 900, title: "Good", media_url: "https://x.test/g.mp4" },
  ]));
  const loc = locate(tl, tl.anchor + 10);
  assert.equal(loc.playable, false);
  assert.equal(loc.provider, null);
});
