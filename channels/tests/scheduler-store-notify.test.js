// scheduler/js/store-notify.js -- how ChannelFlow store mutations map to
// page-bus messages (store.js itself needs a DOM, so the mapping is kept
// pure and tested here).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { TOPICS, SCHEDULER_CHANGE_TOPICS } from "../../js/bus.js";
import { SCHEDULER_REASONS, schedulerNotifications, schedulerInitialState } from "../../scheduler/js/store-notify.js";

const fakeStore = (over = {}) => ({
  channels: [{ id: "mabuhay", name: "Mabuhay TV" }, { id: "cinema", name: "Classic Cinema" }],
  activeChannelId: "cinema",
  activeDate: "2026-11-10",
  isToday: () => true,
  selectedBlockId: "p-1",
  media: [{}, {}, {}],
  driveFolderId: "F1", driveFolderName: "Segments",
  reelsFolderId: null, reelsFolderName: null,
  autoFillReels: 1,
  publishedAt: 1234,
  nowSeconds: () => 3600,
  ...over,
});

test("every reason store.js emits is mapped, and every mapped reason is known", () => {
  const src = readFileSync(fileURLToPath(new URL("../../scheduler/js/store.js", import.meta.url)), "utf8");
  const used = new Set([...src.matchAll(/_emit\("([a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(used.size >= 8, "expected to find the store's _emit() calls");
  for (const r of used) assert.ok(SCHEDULER_REASONS.includes(r), `store.js emits unmapped reason "${r}"`);
  for (const r of SCHEDULER_REASONS) assert.ok(schedulerNotifications(r, fakeStore()).length >= 1, r);
});

test("every message targets a known topic; `state` exactly on .state topics; payloads are JSON-safe", () => {
  const known = new Set(Object.values(TOPICS));
  for (const r of SCHEDULER_REASONS) {
    for (const n of schedulerNotifications(r, fakeStore())) {
      assert.ok(known.has(n.topic), n.topic);
      assert.equal(!!n.state, n.topic.endsWith(".state"), `${r} -> ${n.topic}`);
      assert.deepEqual(JSON.parse(JSON.stringify(n.data)), n.data);
    }
  }
});

test("only the tick reason publishes scheduler.tick; everything else is a SCHEDULER_CHANGE_TOPICS topic", () => {
  for (const r of SCHEDULER_REASONS) {
    for (const n of schedulerNotifications(r, fakeStore())) {
      if (r === "tick") assert.equal(n.topic, TOPICS.SCHEDULER_TICK);
      else assert.ok(SCHEDULER_CHANGE_TOPICS.includes(n.topic), `${r} -> ${n.topic}`);
    }
  }
});

test("payload shapes", () => {
  const s = fakeStore();
  const one = (r, opts) => Object.fromEntries(schedulerNotifications(r, s, opts).map((n) => [n.topic, n.data]));
  assert.deepEqual(one("channel"), {
    [TOPICS.SCHEDULER_CHANNEL_STATE]: { channelId: "cinema", name: "Classic Cinema" },
    [TOPICS.SCHEDULER_SELECTION_STATE]: { blockId: "p-1" },
  });
  assert.deepEqual(one("date")[TOPICS.SCHEDULER_DATE_STATE], { date: "2026-11-10", isToday: true });
  assert.deepEqual(one("blocks")[TOPICS.SCHEDULER_BLOCKS_CHANGED], { channelId: "cinema", date: "2026-11-10" });
  assert.deepEqual(one("media-thumbnail")[TOPICS.SCHEDULER_MEDIA_CHANGED], { kind: "thumbnail", count: 3 });
  assert.deepEqual(one("drive-folder")[TOPICS.SCHEDULER_FOLDERS_STATE], { drive: { id: "F1", name: "Segments" }, reels: null });
  assert.deepEqual(one("reels-autofill")[TOPICS.SCHEDULER_AUTOFILL_STATE], { enabled: true });
  assert.deepEqual(one("publish")[TOPICS.SCHEDULER_SCHEDULE_PUBLISHED], { publishedAt: 1234, target: "local" });
  assert.deepEqual(one("publish", { target: "live" })[TOPICS.SCHEDULER_SCHEDULE_PUBLISHED], { publishedAt: 1234, target: "live" });
  assert.deepEqual(one("tick")[TOPICS.SCHEDULER_TICK], { now: 3600 });
  assert.deepEqual(one("select")[TOPICS.SCHEDULER_SELECTION_STATE], { blockId: "p-1" });
});

test("unknown reasons throw instead of silently publishing nothing", () => {
  assert.throws(() => schedulerNotifications("nope", fakeStore()), /Unknown scheduler store reason/);
});

test("initial state covers the retained snapshots a late subscriber needs", () => {
  const topics = schedulerInitialState(fakeStore()).map((n) => n.topic);
  for (const t of [TOPICS.SCHEDULER_CHANNEL_STATE, TOPICS.SCHEDULER_DATE_STATE, TOPICS.SCHEDULER_SELECTION_STATE,
    TOPICS.SCHEDULER_FOLDERS_STATE, TOPICS.SCHEDULER_AUTOFILL_STATE]) {
    assert.ok(topics.includes(t), t);
  }
  assert.ok(schedulerInitialState(fakeStore()).every((n) => n.state));
});
