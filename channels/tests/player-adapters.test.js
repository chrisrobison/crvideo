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
import { formatCountdown, hashSeed, pickWeightedIndex } from "../continuity-card.js";
import { buildTimeline, locate, airings, nextProgram, findAnnouncementAudio } from "../broadcast.js";

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

// ---------- continuity (Phase 4/5/6) ----------

test("a continuity schedule item is a real, playable-false, non-gap entry carrying its template/next-program fields", () => {
  const tl = buildTimeline(schedule([
    { type: "video", id: "a1", start: 0, duration: 600, title: "A1", media_url: "https://x.test/a1.mp4" },
    {
      type: "continuity", id: "continuity-600", start: 600, duration: 27,
      template: "up-next", next_program_id: "a2",
    },
    { type: "video", id: "a2", start: 627, duration: 600, title: "A2", media_url: "https://x.test/a2.mp4" },
  ]));
  const loc = locate(tl, tl.anchor + 610);
  assert.equal(loc.type, "continuity");
  assert.equal(loc.playable, false, "never driven through a PlayerAdapter -- rendered, not played");
  assert.equal(loc.template, "up-next");
  assert.equal(loc.nextProgramId, "a2");
  assert.equal(loc.id, "continuity-600");

  // Distinct from an ordinary gap: airings() still reports it as a real,
  // present entry (gap-free coverage), just not a "playable" one.
  const all = airings(tl, tl.anchor, tl.anchor + tl.cycle);
  assert.equal(all.some((a) => a.type === "continuity"), true);
  assert.equal(all.some((a) => a.type === "gap"), false);
});

test("a continuity item carries description/thumbnail through to the entry when the compiler provided them", () => {
  const tl = buildTimeline(schedule([
    {
      type: "video", id: "a1", start: 0, duration: 600, title: "A1", media_url: "https://x.test/a1.mp4",
      description: "An episode description.", thumbnail_url: "https://x.test/thumb.jpg",
    },
  ]));
  const loc = locate(tl, tl.anchor + 10);
  assert.equal(loc.description, "An episode description.");
  assert.equal(loc.thumbnailUrl, "https://x.test/thumb.jpg");
});

// ---------- formatCountdown (continuity-card.js) ----------

test("formatCountdown shows minutes:seconds for anything a minute or more away", () => {
  assert.equal(formatCountdown(90), "starts in 1:30");
  assert.equal(formatCountdown(600), "starts in 10:00");
});

test("formatCountdown shows plain seconds under a minute", () => {
  assert.equal(formatCountdown(27), "starts in 27s");
  assert.equal(formatCountdown(3), "starts in 3s");
});

test("formatCountdown never goes negative -- clamps to \"starting now\"", () => {
  assert.equal(formatCountdown(0), "starting now");
  assert.equal(formatCountdown(-5), "starting now");
});

// ---------- deterministic bumper selection (continuity-card.js) ----------
// This project's whole continuity system is built on "two viewers at the
// same occurrence see the same thing" -- these cover the pure selection
// math pickWeightedIndex()/hashSeed() use, never Math.random().

test("hashSeed is a pure function of its input -- same seed, same hash, every call", () => {
  assert.equal(hashSeed("continuity-1793577600"), hashSeed("continuity-1793577600"));
  assert.notEqual(hashSeed("continuity-1793577600"), hashSeed("continuity-1793577601"));
});

test("pickWeightedIndex is deterministic -- repeated calls with the same seed always pick the same index", () => {
  const weights = [1, 1, 1, 1, 1];
  const first = pickWeightedIndex(weights, "occurrence-42");
  for (let i = 0; i < 20; i++) {
    assert.equal(pickWeightedIndex(weights, "occurrence-42"), first);
  }
});

test("pickWeightedIndex returns an in-range index across many different seeds", () => {
  for (let i = 0; i < 200; i++) {
    const idx = pickWeightedIndex([2, 1, 1], `seed-${i}`);
    assert.ok(idx >= 0 && idx <= 2);
  }
});

test("pickWeightedIndex never picks a zero-weight item", () => {
  for (let i = 0; i < 200; i++) {
    const idx = pickWeightedIndex([0, 5, 0], `seed-${i}`);
    assert.equal(idx, 1);
  }
});

test("pickWeightedIndex falls back to index 0 for an empty or all-zero list rather than throwing", () => {
  assert.equal(pickWeightedIndex([], "seed"), 0);
  assert.equal(pickWeightedIndex([0, 0, 0], "seed"), 0);
});

// ---------- findAnnouncementAudio (broadcast.js) ----------
// Pass 2 playback wiring: matches a continuity airing against the AI
// continuity announcer's channels/<id>/announcements.json manifest
// (see channels/announcer/src/AnnouncementContextBuilder.php, whose
// `transitionId` is exactly the continuity schedule item's own `id` --
// the same field mapScheduleItem() carries through as `airing.id`).

const BASE_AIRING = { type: "continuity", id: "continuity-1793577600", nextProgramId: "yt-abc123" };
const READY_ANNOUNCEMENT = {
  transitionId: "continuity-1793577600", type: "coming_up_next", status: "ready",
  audio: "/media/announcements/science/hash1.mp3", toEpisodeId: "yt-abc123",
};

test("findAnnouncementAudio matches a ready coming_up_next announcement by transitionId", () => {
  assert.equal(findAnnouncementAudio([READY_ANNOUNCEMENT], BASE_AIRING), "/media/announcements/science/hash1.mp3");
});

test("findAnnouncementAudio returns null when nothing matches this transition", () => {
  assert.equal(findAnnouncementAudio([{ ...READY_ANNOUNCEMENT, transitionId: "continuity-9999999999" }], BASE_AIRING), null);
});

test("findAnnouncementAudio ignores a non-ready (still generating/errored) entry", () => {
  assert.equal(findAnnouncementAudio([{ ...READY_ANNOUNCEMENT, status: "pending" }], BASE_AIRING), null);
});

test("findAnnouncementAudio ignores an entry with no type===coming_up_next (e.g. channel_id)", () => {
  assert.equal(findAnnouncementAudio([{ ...READY_ANNOUNCEMENT, type: "channel_id", transitionId: "channel-id" }], BASE_AIRING), null);
});

test("findAnnouncementAudio discards a stale entry whose toEpisodeId disagrees with the schedule's actual next program (spec section 11)", () => {
  assert.equal(findAnnouncementAudio([{ ...READY_ANNOUNCEMENT, toEpisodeId: "yt-some-other-episode" }], BASE_AIRING), null);
});

test("findAnnouncementAudio still matches when either side doesn't know the next-episode id (nothing to disagree on)", () => {
  assert.equal(findAnnouncementAudio([{ ...READY_ANNOUNCEMENT, toEpisodeId: null }], BASE_AIRING), "/media/announcements/science/hash1.mp3");
  assert.equal(findAnnouncementAudio([READY_ANNOUNCEMENT], { ...BASE_AIRING, nextProgramId: null }), "/media/announcements/science/hash1.mp3");
});

test("findAnnouncementAudio returns null for a missing/empty manifest or a non-continuity airing", () => {
  assert.equal(findAnnouncementAudio([], BASE_AIRING), null);
  assert.equal(findAnnouncementAudio(null, BASE_AIRING), null);
  assert.equal(findAnnouncementAudio(undefined, BASE_AIRING), null);
  assert.equal(findAnnouncementAudio([READY_ANNOUNCEMENT], null), null);
});

test("findAnnouncementAudio requires a real audio URL on the matched entry", () => {
  assert.equal(findAnnouncementAudio([{ ...READY_ANNOUNCEMENT, audio: null }], BASE_AIRING), null);
});

// ---------- continuity airing carries the fields findAnnouncementAudio needs ----------
// Grounds the above purely-synthetic fixtures against the REAL timeline
// builder: a continuity schedule item's own `id`/`next_program_id` must
// actually survive into the `airing` object switchTo() hands to
// findAnnouncementAudio(), or the matching above would never fire for
// real data.

test("buildTimeline carries a continuity item's id/next_program_id through as airing.id/airing.nextProgramId", () => {
  const schedule = {
    blocks: [{
      duration: 120,
      items: [
        { type: "video", id: "ep-1", title: "Episode One", start: 0, duration: 60, program_id: "prog-a", media_url: "https://example.org/ep1.mp4" },
        { type: "continuity", id: "continuity-1793577600", start: 60, duration: 10, next_program_id: "ep-2" },
        { type: "video", id: "ep-2", title: "Episode Two", start: 70, duration: 50, program_id: "prog-b", media_url: "https://example.org/ep2.mp4" },
      ],
    }],
  };
  const tl = buildTimeline(schedule, 0);
  const continuityEntry = tl.entries.find((e) => e.type === "continuity");
  assert.equal(continuityEntry.id, "continuity-1793577600");
  assert.equal(continuityEntry.nextProgramId, "ep-2");
  const located = locate(tl, 65);
  assert.equal(located.type, "continuity");
  assert.equal(located.id, "continuity-1793577600");
  assert.equal(located.nextProgramId, "ep-2");
});
