// Explorer deep-link parsing/serialising (pure; no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, serializeRoute, parseAssetRef, assetRefToString, parseInstant, routeCrumbs, emptyRoute } from "../../scheduler/js/components/explorer/explorer-route.js";

test("a full programs deep link round-trips", () => {
  const qs = "view=explorer&channel=science&series=practical-engineering&episode=yt-awV7FP9sAHE&airing=1794384010&t=1794385000";
  const r = parseRoute(qs);
  assert.deepEqual([r.channel, r.series, r.episode, r.airing, r.t], ["science", "practical-engineering", "yt-awV7FP9sAHE", 1794384010, 1794385000]);
  assert.deepEqual(r.invalid, []);
  assert.equal(serializeRoute(r), qs);
});

test("defaults are omitted and view=explorer always leads", () => {
  assert.equal(serializeRoute(emptyRoute()), "view=explorer");
  assert.equal(serializeRoute({ ...emptyRoute(), mode: "production", cat: "bumps" }), "view=explorer&mode=production&cat=bumps");
});

test("malformed ids are dropped and reported, never trusted", () => {
  const r = parseRoute("?channel=../../etc&series=UPPER&episode=a b&airing=abc&t=yesterday&cat=nope&mode=evil&scope=zzz");
  assert.equal(r.channel, null);
  assert.equal(r.series, null);
  assert.equal(r.episode, null);
  assert.equal(r.airing, null);
  assert.equal(r.t, null);
  assert.equal(r.cat, null);
  assert.equal(r.mode, "programs");
  assert.equal(r.scope, "all");
  for (const k of ["channel", "series", "episode", "airing", "t", "cat", "mode", "scope"]) assert.ok(r.invalid.includes(k), k);
});

test("an airing needs a channel and an episode needs a series", () => {
  const a = parseRoute("airing=1794384010");
  assert.equal(a.airing, null);
  assert.ok(a.invalid.includes("airing"));
  const e = parseRoute("channel=science&episode=yt-abc");
  assert.equal(e.episode, null);
  assert.ok(e.invalid.includes("episode"));
});

test("an episode id is not an airing id: both can be present and stay distinct", () => {
  const r = parseRoute("channel=science&series=techmoan&episode=yt-3H3QRtDTE4Y&airing=1794384010");
  assert.equal(r.episode, "yt-3H3QRtDTE4Y");
  assert.equal(r.airing, 1794384010);
});

test("t accepts epoch seconds or ISO and normalises to epoch seconds", () => {
  assert.equal(parseInstant("1794384000"), 1794384000);
  assert.equal(parseInstant("2026-11-11T00:00:00-08:00"), 1794384000);
  assert.equal(parseInstant("2026-13-99T00:00:00Z"), null);
  assert.equal(parseInstant("12"), null);
  assert.equal(parseInstant(""), null);
});

test("typed asset references validate", () => {
  assert.deepEqual(parseAssetRef("bump:night-owl"), { kind: "bump", id: "night-owl" });
  assert.deepEqual(parseAssetRef("announcement:science:science-continuity-1794384000-next"), { kind: "announcement", channelId: "science", id: "science-continuity-1794384000-next" });
  assert.deepEqual(parseAssetRef("media:media/music/bg-music00.mp3"), { kind: "media", path: "media/music/bg-music00.mp3" });
  for (const bad of ["bump:", "bump:Bad_Id", "media:../server/service-account.json", "media:media/../x.mp3", "media:https://evil/x.mp3", "media:/etc/passwd", "media:server/x.json", "announcement:science", "wat:x", null, 5]) {
    assert.equal(parseAssetRef(bad), null, String(bad));
  }
  assert.equal(assetRefToString(parseAssetRef("bump:night-owl")), "bump:night-owl");
});

test("production and search routes serialise with their own parameters", () => {
  const r = parseRoute("mode=production&cat=announcements&asset=announcement:science:x-1");
  assert.equal(r.mode, "production");
  assert.equal(r.cat, "announcements");
  assert.equal(serializeRoute(r), "view=explorer&mode=production&cat=announcements&asset=announcement%3Ascience%3Ax-1");
  const s = parseRoute("q=%20bridge%20&scope=episodes");
  assert.deepEqual([s.q, s.scope], ["bridge", "episodes"]);
});

test("breadcrumbs follow the route's depth", () => {
  const types = (qs) => routeCrumbs(parseRoute(qs)).map((c) => c.type);
  assert.deepEqual(types(""), ["root"]);
  assert.deepEqual(types("channel=science&series=techmoan&episode=yt-1&airing=1794384010"), ["root", "channel", "series", "episode", "airing"]);
  assert.deepEqual(types("mode=production&cat=bumps&asset=bump:night-owl"), ["root", "production", "category", "asset"]);
  assert.deepEqual(types("q=bridge"), ["root", "search"]);
});
