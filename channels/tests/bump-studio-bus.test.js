// Bump Studio store <-> page bus: what bump-studio-store.js publishes for
// each kind of mutation, the commands it handles, and that the per-frame
// "playback" slice never reaches the bus. Runs on js/bus.js's in-memory
// backend (no DOM under Node); the backend is NOT reset between tests
// because the store subscribes to its commands once, at import.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TOPICS, subscribe, publish } from "../../js/bus.js";
import { studioStore as store, changeOf, PLAYBACK_CHANGE } from "../../scheduler/js/components/bump-studio/bump-studio-store.js";
import { bumpAdminApi } from "../../scheduler/js/admin-api.js";

/** Records every bus message published while `fn` runs. */
async function traffic(fn) {
  const log = [];
  const off = subscribe("*", (m) => log.push({ topic: m.topic, data: m.data }));
  try { await fn(); } finally { off(); }
  return log;
}
const topics = (log) => log.map((m) => m.topic);

test("initial retained state is on the bus for late subscribers", () => {
  const seen = {};
  const off = subscribe([TOPICS.STUDIO_STATUS_STATE, TOPICS.STUDIO_WORKSPACE_STATE, TOPICS.BUMPS_DRAFT_STATE],
    (m) => { seen[m.topic] = m.data; }, { retained: true });
  off();
  assert.deepEqual(seen[TOPICS.STUDIO_STATUS_STATE], { status: "idle", error: null });
  assert.deepEqual(seen[TOPICS.STUDIO_WORKSPACE_STATE], { workspace: "compose" });
  assert.deepEqual(seen[TOPICS.BUMPS_DRAFT_STATE], { id: null, isNew: false, dirty: false, canSave: false });
});

test("a mutation publishes one studio.changed with keys as an array + source", async () => {
  const log = await traffic(() => store.setLayer("music"));
  assert.deepEqual(log, [{ topic: TOPICS.STUDIO_CHANGED, data: { keys: ["layer"], source: null } }]);
  assert.deepEqual(changeOf(log[0]), { keys: new Set(["layer"]), source: null });
});

test("draft edits: studio.changed every time, bumps.draft.state only when save flags change", async () => {
  store.state.bumps = [];
  const log = await traffic(() => {
    store.newBump(); // nothing dirty yet, so no confirm() needed
    store.updateDraft((d) => { d.name = "Bus test"; }, "inspector");
    store.updateDraft((d) => { d.name = "Bus test 2"; }, "inspector");
  });
  const changed = log.filter((m) => m.topic === TOPICS.STUDIO_CHANGED).map((m) => m.data);
  assert.deepEqual(changed, [
    { keys: ["selection", "draft"], source: null },
    { keys: ["draft"], source: "inspector" },
    { keys: ["draft"], source: "inspector" },
  ]);
  const draftStates = log.filter((m) => m.topic === TOPICS.BUMPS_DRAFT_STATE).map((m) => m.data);
  assert.deepEqual(draftStates, [
    { id: null, isNew: true, dirty: false, canSave: true }, // blank new bump: savable, not yet dirty
    { id: null, isNew: true, dirty: true, canSave: true }, // first edit flips dirty
  ], "the second keystroke changes no flag, so publishes no draft state");
  assert.ok(log.some((m) => m.topic === TOPICS.BUMPS_SELECTION_STATE && m.data.isNew === true));
});

test("save of a new bump publishes bumps.item.created; a re-save publishes bumps.item.saved", async () => {
  const origCreate = bumpAdminApi.create;
  const origUpdate = bumpAdminApi.update;
  bumpAdminApi.create = async (p) => ({ id: "bus-test", ...p });
  bumpAdminApi.update = async (id, p) => ({ id, ...p });
  try {
    const created = await traffic(() => store.save());
    assert.ok(topics(created).includes(TOPICS.BUMPS_LIST_CHANGED));
    assert.deepEqual(created.find((m) => m.topic === TOPICS.BUMPS_ITEM_CREATED).data, { id: "bus-test", name: "Bus test 2", source: "save" });
    assert.deepEqual(created.filter((m) => m.topic === TOPICS.BUMPS_DRAFT_STATE).at(-1).data,
      { id: "bus-test", isNew: false, dirty: false, canSave: false });

    store.updateDraft((d) => { d.description = "edited"; });
    const saved = await traffic(() => store.save());
    assert.deepEqual(saved.find((m) => m.topic === TOPICS.BUMPS_ITEM_SAVED).data, { id: "bus-test", name: "Bus test 2", source: "save" });
    assert.ok(!topics(saved).includes(TOPICS.BUMPS_ITEM_CREATED));
  } finally {
    bumpAdminApi.create = origCreate;
    bumpAdminApi.update = origUpdate;
  }
});

test("remove publishes bumps.item.deleted", async () => {
  const orig = bumpAdminApi.delete;
  bumpAdminApi.delete = async () => ({ ok: true });
  try {
    const log = await traffic(() => store.remove("bus-test"));
    assert.deepEqual(log.find((m) => m.topic === TOPICS.BUMPS_ITEM_DELETED).data, { id: "bus-test" });
  } finally {
    bumpAdminApi.delete = orig;
  }
});

test("studio.schedule.open command switches to Schedule with that channel focused", async () => {
  const log = await traffic(() => publish(TOPICS.STUDIO_SCHEDULE_OPEN, { channelId: "science" }));
  assert.equal(store.state.workspace, "schedule");
  assert.equal(store.state.scheduleFocus, "science");
  assert.ok(log.some((m) => m.topic === TOPICS.STUDIO_CHANGED && m.data.keys.includes("scheduleFocus")));
  assert.ok(log.some((m) => m.topic === TOPICS.STUDIO_WORKSPACE_STATE && m.data.workspace === "schedule"));
});

test("studio.compose.open command loads the bump into Compose", async () => {
  store.state.bumps = [{ id: "b1", name: "One", background: { type: "color", color: "#000" } }];
  store.state.saved = store.state.draft ? JSON.parse(JSON.stringify(store.state.draft)) : null; // not dirty: no confirm()
  publish(TOPICS.STUDIO_COMPOSE_OPEN, { id: "b1" });
  assert.equal(store.state.selectedId, "b1");
  assert.equal(store.state.workspace, "compose");
});

test("playback never touches the bus; it fires store.transport 'playback' events", async () => {
  let frames = 0;
  const onFrame = () => { frames += 1; };
  store.transport.addEventListener("playback", onFrame);
  const log = await traffic(() => {
    for (let i = 0; i < 5; i++) store.setPlayback({ time: i / 60, playing: true });
    store.setMuted(true);
    store.setLoop(true);
    store.setVolume(0.5);
  });
  store.transport.removeEventListener("playback", onFrame);
  assert.deepEqual(log, []);
  assert.ok(frames >= 8);
  assert.deepEqual(PLAYBACK_CHANGE.keys, new Set(["playback"]));
});
