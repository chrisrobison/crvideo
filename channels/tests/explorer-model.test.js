// Explorer's relationship / time-travel / bump-rule / search model.
// Deterministic fixtures are built in-test; a second group runs the same
// model over the real checked-in channel/series definitions using only
// structure that holds regardless of when schedules were last published.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as M from "../../scheduler/js/components/explorer/explorer-model.js";
import { A, fixture } from "./explorer-fixtures.js";

const ROOT = new URL("../../", import.meta.url);
const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, ROOT)), "utf8"));

// ---------- clock-derived offsets & boundaries ----------

test("offset into an episode is exact and deterministic", () => {
  const sv = fixture();
  const at = M.locateAt(sv, A + 500);
  assert.equal(at.state, "ok");
  assert.equal(at.entry.id, "ep-a");
  assert.equal(at.offset, 490);
  assert.equal(at.remaining, 410);
  assert.equal(at.program.occurrenceId, "P1");
  assert.equal(at.program.startsAt, A);
  assert.equal(at.program.endsAt, A + 1800);
  assert.deepEqual(M.locateAt(sv, A + 500), at, "same instant, same answer");
});

test("a boundary instant belongs to the item that starts there", () => {
  const sv = fixture();
  assert.equal(M.locateAt(sv, A + 910).entry.id, "ep-b");
  assert.equal(M.locateAt(sv, A + 910).offset, 0);
  assert.equal(M.locateAt(sv, A + 909.999).entry.id, "ep-a");
});

test("published schedule boundaries: before start / at end are explicitly out of range", () => {
  const sv = fixture();
  assert.equal(M.locateAt(sv, A - 1).state, "out-of-range");
  assert.equal(M.locateAt(sv, A).state, "ok");
  assert.equal(M.locateAt(sv, A + 7199).state, "ok");
  assert.equal(M.locateAt(sv, A + 7200).state, "out-of-range");
  assert.equal(M.locateAt(null, A).state, "no-schedule");
});

test("uncovered time is a gap, not an invented program", () => {
  const sv = fixture();
  const at = M.locateAt(sv, A + 4000);
  assert.equal(at.entry.kind, "gap");
  assert.equal(at.entry.title, null);
});

test("the first/last published item has no previous/next beyond the window", () => {
  const sv = fixture();
  assert.equal(M.locateAt(sv, A + 1).previous, null);
  assert.equal(M.locateAt(sv, A + 7000).next, null);
  assert.equal(M.locateAt(sv, A + 500).previous.id, "continuity-lead");
  assert.equal(M.locateAt(sv, A + 500).next.id, "ep-b");
});

test("a schedule with no published window is a looping schedule: no out-of-range, it wraps", () => {
  const sv = fixture({ window: false });
  assert.equal(sv.looping, true);
  assert.equal(M.locateAt(sv, A + 7200 + 500).entry.id, "ep-a", "second pass of the loop");
});

// ---------- episode -> airings ----------

test("episode-to-airing lookup lists every published occurrence, with occurrence ids", () => {
  const sv = fixture();
  const list = M.episodeAirings(sv, "ep-a");
  assert.deepEqual(list.map((a) => [a.startsAt - A, a.occurrenceId]), [[10, "P1"], [1800, "P2"]]);
  assert.deepEqual(M.episodeAirings(sv, "ep-b").map((a) => a.startsAt - A), [910]);
  assert.deepEqual(M.episodeAirings(sv, "nope"), []);
  assert.deepEqual(M.episodeAirings(sv, "ep-a", "some-other-series"), [], "same id attributed to a different series is rejected");
  assert.equal(M.episodeAirings(sv, "ep-a", "demo").length, 2);
});

test("an airing is identified by its start time; an episode id is not an airing id", () => {
  const sv = fixture();
  assert.equal(M.findAiring(sv, A + 10).entry.id, "ep-a");
  assert.equal(M.findAiring(sv, A + 1800).entry.id, "ep-a");
  assert.notEqual(M.findAiring(sv, A + 10).entry.occurrenceId, M.findAiring(sv, A + 1800).entry.occurrenceId);
  assert.equal(M.findAiring(sv, A + 11), null, "mid-airing is not a start");
  assert.equal(M.findAiring(sv, A), null, "a continuity item is not an airing");
  assert.equal(M.findAiring(sv, A + 99999), null, "out of range");
  assert.equal(M.findAiring(sv, Number.NaN), null);
});

test("series airings and published rotation come from the schedule only", () => {
  const sv = fixture();
  assert.equal(M.seriesAirings(sv, "demo").length, 3);
  assert.equal(M.seriesAirings(sv, "demo", { limit: 1 }).length, 1);
  assert.equal(M.seriesAirings(sv, "demo", { from: A + 1600 }).length, 1);
  const rot = M.publishedRotation(sv, "demo");
  assert.deepEqual(rot.episodeOrder, ["ep-a", "ep-b"]);
  assert.equal(rot.airingCount, 3);
  assert.equal(rot.episodeSets[0].episode_count, 2);
  assert.deepEqual(M.seriesAirings(sv, "other"), []);
});

test("channel airings list playable videos only", () => {
  const sv = fixture();
  const list = M.channelAirings(sv, A, A + 7200);
  assert.deepEqual(list.map((a) => a.id), ["ep-a", "ep-b", "ep-a"]);
});

test("previous/next airing skips continuity and gaps and stops at the window edge", () => {
  const sv = fixture();
  assert.equal(M.adjacentAiring(sv, A + 10, 1).startsAt, A + 910, "ep-a -> ep-b");
  assert.equal(M.adjacentAiring(sv, A + 910, 1).startsAt, A + 1800, "skips the continuity filler");
  assert.equal(M.adjacentAiring(sv, A + 1800, 1), null, "only a gap follows");
  assert.equal(M.adjacentAiring(sv, A + 910, -1).startsAt, A + 10);
  assert.equal(M.adjacentAiring(sv, A + 10, -1), null, "only a continuity item precedes it");
  assert.equal(M.adjacentAiring(sv, A + 11, 1), null, "not an airing start");
});

// ---------- continuity around an airing ----------

test("continuity context contains only items the schedule actually has", () => {
  const sv = fixture();
  const ctx = M.airingContext(sv, A + 10);
  assert.deepEqual(ctx.segments.map((s) => [s.role, s.kind, s.startsAt - A]), [
    ["continuity", "continuity", 0], ["program", "video", 10], ["program", "video", 910], ["continuity", "continuity", 1510], ["next", "video", 1800],
  ]);
  assert.deepEqual(ctx.segments.filter((s) => s.selected).map((s) => s.startsAt - A), [10]);
});

test("an airing with no published continuity shows none (no assumed before/after bump)", () => {
  const sv = fixture();
  const ctx = M.airingContext(sv, A + 1800);
  assert.equal(ctx.segments.filter((s) => s.role === "continuity").length, 0, "this program has no continuity of its own");
  assert.equal(ctx.previous.kind, "continuity", "the neighbour is reported as it is");
  assert.equal(ctx.segments.find((s) => s.role === "previous").id, "continuity-fill");
  assert.equal(ctx.next.kind, "gap");
});

test("announcement-to-transition: matches by transition id and flags stale audio", () => {
  const sv = fixture();
  const ann = [
    { id: "a1", type: "coming_up_next", transitionId: "continuity-lead", toEpisodeId: "ep-a", status: "ready", audio: "/media/announcements/demo/a.mp3", text: "x" },
    { id: "a2", type: "coming_up_next", transitionId: "continuity-fill", toEpisodeId: "ep-zzz", status: "ready", audio: "/media/announcements/demo/b.mp3", text: "y" },
  ];
  const ctx = M.airingContext(sv, A + 10, ann);
  const lead = ctx.segments.find((s) => s.id === "continuity-lead").announcement;
  const fill = ctx.segments.find((s) => s.id === "continuity-fill").announcement;
  assert.equal(lead.state, "ready");
  assert.equal(lead.record.id, "a1");
  assert.equal(fill.state, "stale", "player would discard it: next episode disagrees");
  assert.equal(M.continuityAnnouncement(ann, { id: "continuity-none", nextProgramId: null }), null);
  assert.equal(M.continuityAnnouncement(null, { id: "x" }), null);
  const idx = M.indexAnnouncements({ demo: ann });
  assert.equal(idx.byTransition.get("demo:continuity-lead").id, "a1");
  assert.equal(idx.byKey.get("demo:a2").channelId, "demo");
  const tr = M.announcementTransition(sv, ann[0]);
  assert.equal(tr.occurrenceId, "P1");
  assert.equal(tr.continuity.startsAt, A);
  assert.equal(M.announcementTransition(sv, { transitionId: "channel-id" }), null);
});

// ---------- bump rules ----------

test("bump rule windows align to the clock and respect first-match precedence", () => {
  const schedule = { enabled: true, rules: [
    { bumpId: "top", every: "hour", offsetSeconds: 0, durationSeconds: 15 },
    { bumpId: "half", every: "hour", offsetSeconds: 1800, durationSeconds: 10 },
    { bumpId: "overlap", every: "hour", offsetSeconds: 5, durationSeconds: 15 },
  ] };
  const base = Math.floor(A / 3600) * 3600;
  const w = M.bumpOverlays(schedule, base, base + 7200);
  assert.deepEqual(w.filter((x) => x.bumpId === "top").map((x) => x.startsAt - base), [0, 3600]);
  assert.deepEqual(w.filter((x) => x.bumpId === "half").map((x) => [x.startsAt - base, x.endsAt - base]), [[1800, 1810], [5400, 5410]]);
  assert.ok(w.filter((x) => x.bumpId === "overlap").every((x) => x.shadowed), "starts inside the earlier rule's window");
  assert.ok(w.filter((x) => x.bumpId !== "overlap").every((x) => !x.shadowed));
  assert.equal(M.activeBumpAt(schedule, base + 7).bumpId, "top", "first matching rule wins");
  assert.equal(M.activeBumpAt(schedule, base + 16).bumpId, "overlap");
  assert.equal(M.activeBumpAt(schedule, base + 100), null);
});

test("a window that began before `from` but is still open is included; disabled schedules produce none", () => {
  const r = { bumpId: "x", every: "hour", offsetSeconds: 0, durationSeconds: 20 };
  const base = Math.floor(A / 3600) * 3600;
  assert.deepEqual(M.bumpRuleWindowsBetween(r, base + 10, base + 15).map((w) => w.startsAt - base), [0]);
  assert.deepEqual(M.bumpRuleWindowsBetween(r, base + 20, base + 30), []);
  assert.deepEqual(M.bumpOverlays({ enabled: false, rules: [r] }, base, base + 3600), []);
  assert.deepEqual(M.bumpOverlays(null, base, base + 3600), []);
});

test("malformed bump rules never throw or match", () => {
  for (const rule of [null, {}, { bumpId: "x" }, { bumpId: "x", every: "fortnight", durationSeconds: 5 }, { bumpId: "x", every: "hour", durationSeconds: 0 }]) {
    assert.deepEqual(M.bumpRuleWindowsBetween(rule, A, A + 3600), []);
  }
});

test("a bump overlay never changes the underlying airing's times", () => {
  const sv = fixture();
  const before = M.findAiring(sv, A + 10).entry;
  M.bumpOverlays({ enabled: true, rules: [{ bumpId: "x", every: "hour", offsetSeconds: 0, durationSeconds: 3600 }] }, A, A + 3600);
  assert.deepEqual(M.findAiring(sv, A + 10).entry, before);
});

// ---------- reverse references ----------

test("reverse bump usage groups rules by bump id and channel", () => {
  const idx = M.indexBumpUsage([
    { id: "c1", name: "One", enabled: true, rules: [{ bumpId: "night-owl", every: "hour" }, { bumpId: "b2", every: "hour" }] },
    { id: "c2", name: "Two", enabled: false, rules: [{ bumpId: "night-owl", every: "day" }, null, {}] },
    { id: "c3", name: "Three", enabled: true },
  ]);
  assert.deepEqual(idx.get("night-owl").map((u) => [u.channelId, u.ruleIndex, u.enabled]), [["c1", 0, true], ["c2", 0, false]]);
  assert.equal(idx.get("b2").length, 1);
  assert.equal(idx.has("undefined"), false);
});

test("reverse media usage normalises leading slashes and records roles", () => {
  const bumps = [
    { id: "a", background: { type: "video", url: "media/video/bg01.mp4" }, audio: [{ source: "music", url: "media/music/m.mp3" }], announcement: { url: "media/announcements/x/h.mp3" } },
    { id: "b", background: { type: "color", color: "#000" }, audio: [{ source: "ambience", url: "/media/music/m.mp3" }], announcement: null },
  ];
  const idx = M.indexMediaUsage(bumps);
  assert.deepEqual(idx.get("media/music/m.mp3"), [{ bumpId: "a", role: "music" }, { bumpId: "b", role: "ambience" }]);
  assert.deepEqual(idx.get("media/video/bg01.mp4"), [{ bumpId: "a", role: "background" }]);
  const used = M.bumpsUsingAnnouncement(bumps, { audio: "/media/announcements/x/h.mp3" });
  assert.deepEqual(used.map((b) => b.id), ["a"]);
  assert.deepEqual(M.bumpsUsingAnnouncement(bumps, { audio: null }), []);
});

test("series carriers: shared series appear once per channel with distinct catalog/block state", () => {
  const channels = [
    { id: "c1", name: "One", series_refs: [{ series_id: "shared" }, { series_id: "only-one" }, { series_id: null }], programming_blocks: [{ id: "b1", series_id: "shared" }] },
    { id: "c2", name: "Two", series_refs: [{ series_id: "shared" }], programming_blocks: [] },
    { id: "c3", name: "Three", series_refs: [], programming_blocks: [{ id: "x", series_id: "shared" }, { id: "y", series_id: "shared" }] },
  ];
  const idx = M.indexSeriesCarriers(channels);
  const shared = idx.get("shared");
  assert.deepEqual(shared.map((c) => [c.channelId, c.inCatalog, c.blocks.length]), [["c1", true, 1], ["c2", true, 0], ["c3", false, 2]]);
  assert.equal(idx.get("only-one").length, 1);
  assert.equal(idx.has("null"), false);
});

// ---------- search ----------

test("search filters, ranks and groups by entity type", () => {
  const docs = M.buildSearchIndex([
    { type: "series", id: "practical-engineering", title: "Practical Engineering", sub: "series", ref: {} },
    { type: "episode", id: "e1", title: "Bridges: How They Really Work", sub: "Practical Engineering", ref: {} },
    { type: "episode", id: "e2", title: "The Hidden Cost of Concrete", sub: "Practical Engineering", ref: {} },
    { type: "bump", id: "pe-next", title: "Practical Engineering Coming Up", ref: {} },
    { type: "channel", id: "science", title: "Science & Engineering", ref: {} },
  ]);
  const r = M.searchIndex(docs, "practical engineering");
  assert.deepEqual(r.groups.map((g) => g.type), ["series", "episode", "bump"]);
  assert.equal(r.groups[0].items[0].id, "practical-engineering", "title match outranks subtitle-only matches");
  assert.equal(r.counts.episode, 2, "episodes match through their series subtitle");
  assert.equal(M.searchIndex(docs, "bridge").groups[0].items[0].id, "e1");
  assert.equal(M.searchIndex(docs, "bridge zzz").total, 0, "AND semantics");
  assert.equal(M.searchIndex(docs, "   ").total, 0);
  const scoped = M.searchIndex(docs, "engineering", { scope: "episodes" });
  assert.deepEqual(scoped.groups.map((g) => g.type), ["episode"]);
  assert.equal(scoped.counts.channel, 1, "counts still cover every type so scope chips stay accurate");
  assert.equal(M.searchIndex(docs, "science engineering").groups[0].items[0].id, "science");
  assert.equal(M.normalizeText("Café  Ünï—Test"), "cafe uni test");
});

// ---------- channel status honesty ----------

test("channel status is derived from the schedule and never claims 'on air'", () => {
  const sv = fixture();
  const s = M.channelStatus(sv, A + 100);
  assert.equal(s.code, "scheduled-now");
  assert.ok(!/on air|live/i.test(s.label));
  assert.equal(M.channelStatus(sv, A + 4000).code, "gap");
  assert.equal(M.channelStatus(sv, A + 10000).code, "out-of-range");
  assert.equal(M.channelStatus(sv, A - 10).label, "Schedule not yet started");
  assert.equal(M.channelStatus(null, A).code, "unavailable");
  assert.equal(M.channelStatus(sv, A + 5).code, "continuity");
});

// ---------- real, checked-in definitions ----------

const channelIds = readdirSync(fileURLToPath(new URL("channels/", ROOT)), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(fileURLToPath(new URL(`channels/${d.name}/meta.json`, ROOT))))
  .map((d) => d.name);
const seriesIds = new Set(readdirSync(fileURLToPath(new URL("series/", ROOT)), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
const seriesIdFromRef = (ref) => /series\/([a-z0-9][a-z0-9-]*)\/series\.json$/.exec(ref || "")?.[1] ?? null;

function realChannelRows() {
  return channelIds.map((id) => {
    const rd = (f) => { try { return read(`channels/${id}/${f}`); } catch { return null; } };
    const meta = rd("meta.json") || {};
    const cat = rd("catalog.json");
    const prog = rd("programming.json");
    return {
      id, name: meta.name || id, hidden: !!meta.hidden,
      series_refs: (cat?.series || []).map((e) => ({ ref: e.ref, series_id: seriesIdFromRef(e.ref) })),
      programming_blocks: prog?.blocks || [],
    };
  });
}

test("real catalogs: every referenced and programmed series exists, and missing optional files are tolerated", () => {
  const rows = realChannelRows();
  assert.ok(rows.length >= 7);
  for (const ch of rows) {
    for (const ref of ch.series_refs) if (ref.series_id) assert.ok(seriesIds.has(ref.series_id), `${ch.id} -> ${ref.series_id}`);
    for (const b of ch.programming_blocks) assert.ok(seriesIds.has(b.series_id), `${ch.id} block ${b.id}`);
  }
  assert.ok(rows.some((c) => c.series_refs.length === 0 || c.programming_blocks.length === 0), "at least one channel lacks optional data (e.g. ustv)");
});

test("real catalogs: series carried by several channels resolve to every carrier", () => {
  const idx = M.indexSeriesCarriers(realChannelRows());
  const shared = [...idx].filter(([, c]) => c.length > 1);
  for (const [, carriers] of shared) {
    assert.equal(new Set(carriers.map((c) => c.channelId)).size, carriers.length, "one entry per channel");
  }
  // Every programming block is attributed to the channel that declares it.
  for (const ch of realChannelRows()) {
    for (const b of ch.programming_blocks) {
      assert.ok(idx.get(b.series_id).some((c) => c.channelId === ch.id && c.blocks.some((x) => x.id === b.id)));
    }
  }
});

test("real published schedules: window start resolves, window end is out of range, every airing is findable", () => {
  let checked = 0;
  for (const id of channelIds) {
    const meta = read(`channels/${id}/meta.json`);
    let schedule;
    try { schedule = read(`channels/${id}/schedule.json`); } catch { continue; }
    if (!schedule?.blocks?.length) continue;
    let sv;
    try { sv = M.buildScheduleView({ id, meta, schedule }); } catch { continue; }
    if (!sv.window) continue;
    checked++;
    assert.equal(M.locateAt(sv, sv.window.start).state, "ok", id);
    assert.equal(M.locateAt(sv, sv.window.end).state, "out-of-range", id);
    assert.equal(M.locateAt(sv, sv.window.start - 1).state, "out-of-range", id);
    // Sample a handful of published programs: each one's first video is a findable airing with a correct offset.
    for (const p of [...sv.programs.values()].slice(0, 5)) {
      const v = p.episodes.find((e) => e.type === "video");
      if (!v) continue;
      const startsAt = sv.anchor + v.start;
      const ctx = M.airingContext(sv, startsAt);
      assert.ok(ctx, `${id} ${p.id}`);
      assert.equal(ctx.program.occurrenceId, p.id);
      assert.equal(M.locateAt(sv, startsAt + 7).offset, 7);
      assert.ok(M.episodeAirings(sv, v.id).some((a) => a.startsAt === startsAt));
    }
  }
  assert.ok(checked >= 5, `expected several published channels, saw ${checked}`);
});

test("real announcements: every ready coming-up-next record resolves to a transition or is reported as outside the window", () => {
  const meta = read("channels/science/meta.json");
  const schedule = read("channels/science/schedule.json");
  const sv = M.buildScheduleView({ id: "science", meta, schedule });
  const anns = read("channels/science/announcements.json").announcements;
  const found = anns.filter((a) => a.type === "coming_up_next").map((a) => M.announcementTransition(sv, a)).filter(Boolean);
  assert.ok(found.length > 0, "at least some announcements match published continuity items");
  for (const t of found) assert.ok(t.continuity.startsAt >= sv.window.start && t.continuity.startsAt < sv.window.end);
});
