// js/bus.js -- the shared LARC/PAN bus wrapper. Under Node there is no
// `document`/`customElements`, so the module runs on its in-memory
// fallback backend; these tests pin that backend's semantics to the
// vendored LARC bus (vendor/larc/pan.js) and check the topic dictionary.
//
// Run: cd channels && node --test tests/*.test.js

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  TOPICS, SCHEDULER_CHANGE_TOPICS, matches, ready, busMode,
  publish, publishState, subscribe, request, respond, _resetForTests,
} from "../../js/bus.js";

const repo = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

beforeEach(() => _resetForTests());

// ---------- topic dictionary ----------

test("topic names are unique, lower-case, dot-separated and wildcard-free", () => {
  const values = Object.values(TOPICS);
  assert.equal(new Set(values).size, values.length, "duplicate topic value");
  for (const t of values) assert.match(t, /^[a-z]+(\.[a-z]+)+$/, t);
  assert.ok(Object.isFrozen(TOPICS));
});

test("state topics (and only state topics) end in .state", () => {
  for (const [key, topic] of Object.entries(TOPICS)) {
    assert.equal(key.endsWith("_STATE"), topic.endsWith(".state"), `${key} = ${topic}`);
  }
});

test("SCHEDULER_CHANGE_TOPICS: every scheduler topic except the tick", () => {
  const all = Object.values(TOPICS).filter((t) => t.startsWith("scheduler."));
  assert.deepEqual([...SCHEDULER_CHANGE_TOPICS].sort(), all.filter((t) => t !== TOPICS.SCHEDULER_TICK).sort());
  assert.ok(Object.isFrozen(SCHEDULER_CHANGE_TOPICS));
});

test("docs/bus-topics.md documents every topic", () => {
  const doc = readFileSync(repo("docs/bus-topics.md"), "utf8");
  for (const t of Object.values(TOPICS)) assert.ok(doc.includes(`\`${t}\``), `${t} missing from docs/bus-topics.md`);
});

// ---------- vendored file ----------

test("vendor/larc/pan.js matches the sha256 recorded in vendor/larc/README.md", () => {
  const readme = readFileSync(repo("vendor/larc/README.md"), "utf8");
  const recorded = readme.match(/sha256 \| `([0-9a-f]{64})`/)?.[1];
  assert.ok(recorded, "no sha256 row in vendor/larc/README.md");
  const actual = createHash("sha256").update(readFileSync(repo("vendor/larc/pan.js"))).digest("hex");
  assert.equal(actual, recorded);
});

test("matches() agrees with the vendored PanBus.matches on a battery of cases", () => {
  // vendor/larc/pan.js can't be imported under Node (it extends HTMLElement
  // at top level), so lift the static matches() body out of the source.
  const src = readFileSync(repo("vendor/larc/pan.js"), "utf8");
  const body = src.match(/static matches\(topic, pattern\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(body, "could not find PanBus.matches in vendor/larc/pan.js");
  const upstream = new Function("topic", "pattern", body);
  const cases = [
    ["bumps.saved", "bumps.*"], ["bumps.item.saved", "bumps.*"], ["bumps.item.saved", "bumps.*.saved"],
    ["bumps.item.saved", "*"], ["bumps.item.saved", "*.item.*"], ["a.b", "a.b"], ["a.b", "a.c"],
    ["scheduler.tick", "scheduler.*"], ["scheduler.channel.state", "scheduler.*"], ["x", "*"],
    ["player.state", "player.*"], ["pan:$reply:a:b", "pan:$reply:a:b"], ["a.b", ""], ["a.b", "a.b.*"],
  ];
  for (const [topic, pattern] of cases) {
    assert.equal(matches(topic, pattern), upstream(topic, pattern), `${topic} ~ ${pattern}`);
  }
  assert.equal(matches("bumps.item.saved", "bumps.*"), false, "* is exactly one segment");
});

// ---------- in-memory fallback backend ----------

test("Node runs on the in-memory fallback, ready immediately", async () => {
  assert.equal(busMode(), "memory");
  assert.deepEqual(await ready(), { mode: "memory" });
});

test("publish/subscribe delivers synchronously with the full PAN message", () => {
  const got = [];
  subscribe("a.b", (m) => got.push(m));
  publish("a.b", { n: 1 });
  publish("a.c", { n: 2 });
  assert.equal(got.length, 1);
  assert.equal(got[0].topic, "a.b");
  assert.deepEqual(got[0].data, { n: 1 });
  assert.equal(typeof got[0].id, "string");
  assert.equal(typeof got[0].ts, "number");
});

test("retained messages replay only to subscribers that ask for them", () => {
  publish("x.state", { v: 1 }, { retain: true });
  publish("x.state", { v: 2 }, { retain: true });
  publish("x.event", { v: 3 });
  const plain = []; const late = [];
  subscribe("x.*", (m) => plain.push(m.data));
  subscribe("x.*", (m) => late.push(m.data), { retained: true });
  assert.deepEqual(plain, []);
  assert.deepEqual(late, [{ v: 2 }], "only the last retained message per topic, never non-retained ones");
});

test("unsubscribe function and AbortSignal both stop delivery", () => {
  const a = []; const b = [];
  const off = subscribe("t.x", (m) => a.push(m.data));
  const ctl = new AbortController();
  subscribe("t.x", (m) => b.push(m.data), { signal: ctl.signal });
  publish("t.x", 1);
  off(); ctl.abort();
  publish("t.x", 2);
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [1]);
  const c = [];
  subscribe("t.x", (m) => c.push(m), { signal: AbortSignal.abort() });
  publish("t.x", 3);
  assert.deepEqual(c, [], "an already-aborted signal never subscribes");
});

test("overlapping patterns in one subscription deliver each message once", () => {
  const got = [];
  subscribe(["s.*", "s.tick", "*"], (m) => got.push(m.topic));
  publish("s.tick");
  assert.deepEqual(got, ["s.tick"]);
});

test("a handler can unsubscribe itself from inside a retained delivery", async () => {
  publish("v.state", { view: "bumps" }, { retain: true });
  // Via its AbortSignal, synchronously (the delivery runs inside subscribe()):
  const ctl = new AbortController();
  let viaSignal = 0;
  subscribe("v.state", () => { viaSignal += 1; ctl.abort(); }, { retained: true, signal: ctl.signal });
  // Via the returned function, deferred (cf-bump-studio.js's pattern):
  let viaOff = 0;
  const off = subscribe("v.state", () => { viaOff += 1; queueMicrotask(() => off()); }, { retained: true });
  await Promise.resolve();
  publish("v.state", { view: "x" }, { retain: true });
  assert.equal(viaSignal, 1);
  assert.equal(viaOff, 1);
});

test("a throwing handler doesn't stop delivery to the others", () => {
  const errors = [];
  const orig = globalThis.reportError;
  globalThis.reportError = (e) => errors.push(e);
  try {
    const got = [];
    subscribe("e.x", () => { throw new Error("boom"); });
    subscribe("e.x", (m) => got.push(m.data));
    publish("e.x", 7);
    assert.deepEqual(got, [7]);
    assert.equal(errors.length, 1);
  } finally {
    globalThis.reportError = orig;
  }
});

test("publishState retains and skips identical consecutive snapshots", () => {
  const got = [];
  subscribe("app.view.state", (m) => got.push(m.data.view));
  assert.equal(publishState("app.view.state", { view: "a" }), true);
  assert.equal(publishState("app.view.state", { view: "a" }), false);
  assert.equal(publishState("app.view.state", { view: "b" }), true);
  assert.deepEqual(got, ["a", "b"]);
  const late = [];
  subscribe("app.view.state", (m) => late.push(m.data.view), { retained: true });
  assert.deepEqual(late, ["b"]);
});

test("request/respond: result, error and timeout", async () => {
  respond("math.double", (n) => n * 2);
  respond("math.fail", () => { throw new Error("nope"); });
  respond("math.slow", async (n) => n);
  assert.equal(await request("math.double", 21), 42);
  assert.equal(await request("math.slow", 5), 5);
  await assert.rejects(request("math.fail", 1), /nope/);
  await assert.rejects(request("nobody.home", 1, { timeoutMs: 20 }), /timeout/);
});
