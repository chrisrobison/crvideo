// channels/tests/filler.test.js
//
// The pure parts of filler.js: the deterministic scene/line walk, deck
// building, and how a bump is reduced to a filler scene. The renderers
// (FillerRenderer/FillerBed) are DOM/media wiring and need a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  pickIndex, buildDeck, pickLine, pickScene, toFillerDefinition, bedUrlFor, LINE_SECONDS, SCENE_SECONDS,
} from "../filler.js";

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

test("pickIndex visits every entry once before repeating, for any list size", () => {
  for (const n of [1, 2, 3, 7, 12, 80, 199]) {
    const seen = new Set(Array.from({ length: n }, (_, slot) => pickIndex(n, slot, "maker")));
    assert.equal(seen.size, n, `n=${n}`);
    assert.ok([...seen].every((i) => i >= 0 && i < n));
  }
});

test("pickIndex is deterministic, varies by channel, and is -1 for an empty list", () => {
  assert.equal(pickIndex(50, 123, "science"), pickIndex(50, 123, "science"));
  const a = Array.from({ length: 20 }, (_, s) => pickIndex(50, s, "science"));
  const b = Array.from({ length: 20 }, (_, s) => pickIndex(50, s, "maker"));
  assert.notDeepEqual(a, b);
  assert.equal(pickIndex(0, 5, "x"), -1);
});

test("buildDeck interleaves imponderables and quotes and drops malformed entries", () => {
  const deck = buildDeck({
    quotes: [{ text: "Q1", author: "A" }, { text: " " }, null, { text: "Q2" }],
    imponderables: [{ text: "I1" }],
  });
  assert.deepEqual(deck.map((e) => e.text), ["I1", "Q1", "Q2"]);
  assert.equal(deck[1].author, "A");
  assert.equal(deck[0].kind, "imponderable");
  assert.deepEqual(buildDeck(null), []);
});

test("pickLine/pickScene hold steady within a slot, change at the boundary, and tolerate empty input", () => {
  const deck = Array.from({ length: 30 }, (_, i) => ({ text: `L${i}` }));
  const t = 1_000_000;
  const slotStart = Math.floor(t / LINE_SECONDS) * LINE_SECONDS;
  assert.equal(pickLine(deck, slotStart, "c"), pickLine(deck, slotStart + LINE_SECONDS - 0.1, "c"));
  assert.notEqual(pickLine(deck, slotStart, "c"), pickLine(deck, slotStart + LINE_SECONDS, "c"));
  const scenes = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}` }));
  const s0 = Math.floor(t / SCENE_SECONDS) * SCENE_SECONDS;
  assert.equal(pickScene(scenes, s0, "c"), pickScene(scenes, s0 + SCENE_SECONDS - 1, "c"));
  assert.equal(pickLine([], t), null);
  assert.equal(pickScene(null, t), null);
});

test("toFillerDefinition strips the voice-over and closes the upcoming-text layer, keeping picture and sound", () => {
  const def = {
    id: "x", background: { type: "video", url: "media/video/bg01.mp4" }, audio: [{ source: "music", url: "m.mp3", volume: 0.5 }],
    announcement: { url: "a.mp3" }, upcoming: { count: 3, label: "Coming Up" },
  };
  const f = toFillerDefinition(def);
  assert.equal(f.announcement, null);
  assert.equal(f.upcoming.end, 0);
  assert.equal(f.upcoming.count, 0);
  assert.deepEqual(f.background, def.background);
  assert.deepEqual(f.audio, def.audio);
  assert.equal(def.announcement.url, "a.mp3", "input is not mutated");
});

test("bedUrlFor prefers the music layer, then any layer, else null", () => {
  assert.equal(bedUrlFor({ audio: [{ source: "ambience", url: "a.mp3" }, { source: "music", url: "m.mp3" }] }), "m.mp3");
  assert.equal(bedUrlFor({ audio: [{ source: "ambience", url: "a.mp3" }] }), "a.mp3");
  assert.equal(bedUrlFor({ audio: [] }), null);
  assert.equal(bedUrlFor(null), null);
});

test("shipped filler data: every scene bump exists, has sound, and the deck is big enough to not feel repetitive", () => {
  const { bumps } = read("../filler/scenes.json");
  assert.ok(bumps.length >= 5);
  for (const id of bumps) {
    const def = read(`../../bumps/${id}.json`);
    assert.ok(def.audio?.length, `${id} has an audio bed`);
  }
  const deck = buildDeck(read("../filler/quotes.json"));
  assert.ok(deck.length >= 100, `deck has ${deck.length} lines`);
  assert.ok(deck.every((e) => e.text.length <= 180));
});
