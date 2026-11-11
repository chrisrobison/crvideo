// Explorer's store: deep-link reconstruction, selection rules, browser history,
// bounded loading and search, against a fake API/window (no network, no DOM).
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { TOPICS, ready, publishState, subscribe } from "../../js/bus.js";
import { createExplorerStore, sanitizeRoute, defaultCategoryFor } from "../../scheduler/js/components/explorer/explorer-store.js";
import { parseRoute } from "../../scheduler/js/components/explorer/explorer-route.js";
import { A, fixture } from "./explorer-fixtures.js";

before(() => ready());

function fakeWindow(search = "") {
  const w = {
    location: { pathname: "/scheduler/index.html", search, hash: "" },
    entries: [search], index: 0, listeners: [],
    history: {
      pushState(_s, _t, url) { w.entries.splice(w.index + 1); w.entries.push(url.slice(url.indexOf("?"))); w.index++; w.location.search = w.entries[w.index]; w.pushes = (w.pushes || 0) + 1; },
      replaceState(_s, _t, url) { w.entries[w.index] = url.slice(url.indexOf("?")); w.location.search = w.entries[w.index]; w.replaces = (w.replaces || 0) + 1; },
    },
    addEventListener(type, fn) { if (type === "popstate") w.listeners.push(fn); },
    go(delta) { w.index += delta; w.location.search = w.entries[w.index]; w.listeners.forEach((fn) => fn()); },
  };
  return w;
}

const channels = [
  { id: "c1", name: "One", number: 1, hidden: false, series_refs: [{ series_id: "demo" }, { series_id: "other" }], programming_blocks: [{ id: "b1", series_id: "demo" }] },
  { id: "c2", name: "Two", number: 2, hidden: false, series_refs: [{ series_id: "demo" }], programming_blocks: [] },
  { id: "c3", name: "Three", number: 3, hidden: false, series_refs: [], programming_blocks: [] },
];
function fakeApi(calls = []) {
  const rec = (name, v) => (...a) => { calls.push([name, ...a]); return Promise.resolve(typeof v === "function" ? v(...a) : v); };
  return {
    calls,
    getChannels: rec("channels", channels),
    getSeriesIndex: rec("seriesIndex", [{ id: "demo", title: "Demo Show", episode_count: 2, status_counts: { approved: 2 } }, { id: "other", title: "Other Show", episode_count: 0, status_counts: {} }]),
    getSeriesDetail: rec("series", (id) => ({ id, title: id, episodes: [{ id: "ep-a", title: "Alpha" }, { id: "ep-b", title: "Beta" }], source: {} })),
    getEpisodeIndex: rec("episodeIndex", [{ id: "ep-a", s: "demo", t: "Alpha Bridge", d: 900, st: "approved" }, { id: "ep-b", s: "demo", t: "Beta", d: 600, st: "approved" }]),
    getScheduleView: rec("schedule", (id) => (id === "c3" ? Promise.reject(new Error("no schedule")) : { ...fixture(), channelId: id })),
    getAnnouncements: rec("announcements", []),
    getBumpScheduleFor: rec("bumpSchedule", { enabled: true, rules: [{ bumpId: "x", every: "hour", offsetSeconds: 0, durationSeconds: 10 }] }),
    getContinuity: rec("continuity", null),
    getAnnouncerConfig: rec("announcer", null),
    getBumps: rec("bumps", [{ id: "x", name: "Bump X", description: "d", background: { type: "color", color: "#000" }, audio: [] }]),
    getBumpSchedules: rec("bumpSchedules", [{ id: "c1", name: "One", enabled: true, rules: [{ bumpId: "x", every: "hour", offsetSeconds: 0, durationSeconds: 10 }] }]),
    getMedia: rec("media", { video: [{ url: "media/video/bg01.mp4", name: "bg01.mp4", bytes: 10 }], music: [], ambience: [], image: [] }),
    getAllAnnouncements: rec("allAnnouncements", { c1: [{ id: "a1", type: "coming_up_next", transitionId: "continuity-lead", text: "Stay tuned for Demo", audio: "/media/announcements/c1/a.mp3", status: "ready" }] }),
  };
}
const mk = (search = "", api = fakeApi()) => {
  const win = fakeWindow(search);
  const store = createExplorerStore({ api, win, clock: () => A + 100 });
  publishState(TOPICS.APP_VIEW_STATE, { view: "explorer" });
  store.init();
  return { store, win, api };
};

test("a deep link reconstructs the route and reports ignored parameters", () => {
  const { store } = mk("?view=explorer&channel=c1&series=demo&episode=ep-a&airing=1767571210&bogus=1&cat=nope");
  assert.deepEqual([store.route.channel, store.route.series, store.route.episode, store.route.airing], ["c1", "demo", "ep-a", 1767571210]);
  assert.deepEqual(store.invalid, ["cat"]);
});

test("an airing without a channel and an episode without a series are dropped", () => {
  assert.equal(sanitizeRoute({ ...parseRoute("channel=c1"), airing: 5 }).airing, 5);
  assert.equal(sanitizeRoute({ ...parseRoute(""), airing: 5 }).airing, null);
  assert.equal(sanitizeRoute({ ...parseRoute(""), episode: "e" }).episode, null);
  assert.equal(sanitizeRoute({ ...parseRoute("channel=c1"), cat: "bumps", mode: "programs" }).cat, null);
});

test("selection rules: channel clears deeper levels, series keeps the channel, episode keeps both", () => {
  const { store } = mk("?view=explorer&channel=c1&series=demo&episode=ep-a&airing=1767571210");
  store.selectEpisode("ep-b");
  assert.deepEqual([store.route.series, store.route.episode, store.route.airing], ["demo", "ep-b", null]);
  store.selectSeries("other");
  assert.deepEqual([store.route.channel, store.route.series, store.route.episode], ["c1", "other", null]);
  store.selectChannel("c2");
  assert.deepEqual([store.route.channel, store.route.series, store.route.episode, store.route.airing], ["c2", null, null, null]);
});

test("each selection pushes one history entry; Back/Forward re-reads the route", () => {
  const { store, win } = mk("?view=explorer");
  store.selectChannel("c1");
  store.selectSeries("demo");
  store.selectEpisode("ep-a");
  assert.equal(win.pushes, 3);
  assert.equal(win.location.search, "?view=explorer&channel=c1&series=demo&episode=ep-a");
  win.go(-1);
  assert.deepEqual([store.route.series, store.route.episode], ["demo", null]);
  win.go(-1);
  assert.equal(store.route.series, null);
  win.go(+2);
  assert.equal(store.route.episode, "ep-a");
  assert.equal(win.pushes, 3, "popstate never creates new entries");
});

test("selecting what is already selected adds no history entry", () => {
  const { store, win } = mk("?view=explorer&channel=c1");
  store.selectChannel("c1");
  assert.equal(win.pushes || 0, 0);
});

test("a time chosen before an airing survives only if it still points inside that airing", () => {
  const { store } = mk("?view=explorer&channel=c1&series=demo");
  return store.ensure().then(() => {
    store.go({ t: A + 5000 });
    store.selectAiring("c1", A + 10);
    assert.equal(store.route.t, A + 10, "moved to the airing start");
    store.go({ t: A + 400 });
    store.selectAiring("c1", A + 10);
    assert.equal(store.route.t, A + 400, "still inside, kept");
  });
});

test("jumping the time while an airing is selected follows the schedule, and clears it where there is no airing", async () => {
  const { store } = mk(`?view=explorer&channel=c1&airing=${A + 10}`);
  await store.ensure();
  store.setTime(A + 1000);
  assert.equal(store.route.airing, A + 910, "ep-b airs at 910");
  store.setTime(A + 1600);
  assert.equal(store.route.airing, null, "a continuity item is not an airing");
  store.setTime(null);
  assert.equal(store.route.t, null);
  assert.equal(store.timeMode(), "live");
});

test("time modes: live, travel, airing-start", () => {
  const { store } = mk("?view=explorer&channel=c1");
  assert.equal(store.timeMode(), "live");
  assert.equal(store.effectiveT(), A + 100);
  store.go({ t: A + 7 });
  assert.equal(store.timeMode(), "travel");
  store.go({ t: null, airing: A + 10 });
  assert.equal(store.timeMode(), "airing");
  assert.equal(store.effectiveT(), A + 10);
});

test("typing in search replaces history once a query exists; leaving search pushes", () => {
  const { store, win } = mk("?view=explorer&channel=c1");
  store.setQuery("b");
  const pushes = win.pushes;
  store.setQuery("br");
  store.setQuery("bri");
  assert.equal(win.pushes, pushes, "keystrokes replace");
  assert.ok(win.replaces >= 2);
  store.setQuery("");
  assert.equal(win.pushes, pushes + 1, "clearing is a navigation");
  assert.equal(store.route.scope, "all");
});

test("mode switches reset the browser selection and keep it semantic", () => {
  const { store } = mk("?view=explorer&channel=c1&series=demo");
  store.setMode("production");
  assert.deepEqual([store.route.mode, store.route.channel, store.route.series], ["production", null, null]);
  store.setCategory("bumps");
  store.selectAsset({ kind: "bump", id: "x" });
  assert.equal(store.win.location.search, "?view=explorer&mode=production&cat=bumps&asset=bump%3Ax");
  assert.equal(defaultCategoryFor({ kind: "media", path: "media/music/a.mp3" }), "music");
  assert.equal(defaultCategoryFor({ kind: "announcement", channelId: "c", id: "i" }), "announcements");
});

test("loading is bounded to what the route needs (+ the carriers of a series)", async () => {
  const api = fakeApi();
  const { store } = mk("?view=explorer&channel=c1&series=demo&episode=ep-a", api);
  await store.ensure();
  const sched = api.calls.filter((c) => c[0] === "schedule").map((c) => c[1]).sort();
  assert.deepEqual(sched, ["c1", "c2"], "the selected channel and the other carrier of `demo` only (c3 carries nothing)");
  assert.equal(api.calls.filter((c) => c[0] === "series").length, 1);
  assert.equal(api.calls.filter((c) => c[0] === "episodeIndex").length, 0, "the episode index is only for search");
  assert.equal(api.calls.filter((c) => c[0] === "allAnnouncements").length, 0);
});

test("a failed schedule is reported per channel, not fatal", async () => {
  const { store } = mk("?view=explorer&channel=c3");
  await store.ensure();
  assert.match(store.data.scheduleErrors.get("c3"), /no schedule/);
  assert.equal(store.scheduleView("c3"), null);
  assert.ok(store.channel("c3"));
});

test("episode airings combine every loaded carrier and reject other series' items", async () => {
  const { store } = mk("?view=explorer&series=demo&episode=ep-a");
  await store.ensure();
  const list = store.airingsOfEpisode("demo", "ep-a");
  assert.deepEqual(list.map((a) => [a.channelId, a.startsAt - A]), [["c1", 10], ["c2", 10], ["c1", 1800], ["c2", 1800]].sort((x, y) => x[1] - y[1]));
  assert.deepEqual(store.airingsOfEpisode("other", "ep-a"), []);
});

test("search covers channels, series, episodes, airings, bumps, voiceovers and media", async () => {
  const { store } = mk("?view=explorer&q=demo");
  await store.ensure();
  await store.ensureSearchData();
  const types = store.search().groups.map((g) => g.type);
  assert.ok(types.includes("series"));
  assert.ok(types.includes("announcement"), "voiceover matched by its script");
  store.go({ q: "bump", scope: "all" });
  assert.deepEqual(store.search().groups.map((g) => g.type), ["bump"]);
  store.go({ q: "alpha" });
  assert.equal(store.search().groups[0].items[0].ref.episode, "ep-a");
  store.go({ q: "bg01" });
  assert.equal(store.search().groups[0].type, "media");
  store.go({ q: "alpha", scope: "series" });
  assert.equal(store.search().groups.length, 0);
});

test("EXPLORER_OPEN switches to Explorer, selects, and validates like the URL", async () => {
  const { store } = mk("?view=explorer");
  const views = [];
  subscribe(TOPICS.APP_VIEW_OPEN, ({ data }) => views.push(data.view));
  publishState(TOPICS.APP_VIEW_STATE, { view: "bumps" });
  store.open({ channel: "c1", series: "demo", asset: { kind: "bump", id: "x" }, airing: "nope" });
  assert.deepEqual(views, ["explorer"]);
  assert.equal(store.route.channel, "c1");
  assert.equal(store.route.series, "demo");
  assert.equal(store.route.airing, null, "malformed airing ignored");
  publishState(TOPICS.APP_VIEW_STATE, { view: "explorer" });
});

test("the retained bus state carries semantic ids only", () => {
  const { store } = mk("?view=explorer&channel=c1&series=demo");
  const seen = [];
  subscribe(TOPICS.EXPLORER_ROUTE_STATE, ({ data }) => seen.push(data), { retained: true });
  store.selectEpisode("ep-a");
  const last = seen[seen.length - 1];
  assert.deepEqual([last.channel, last.series, last.episode, last.airing], ["c1", "demo", "ep-a", null]);
});
