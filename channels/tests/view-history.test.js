// The view switcher's URL contract (scheduler/js/view.js): ?view=<name> deep links,
// and that switching to Explorer keeps Explorer's own parameters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VIEWS, viewFromSearch, urlForView } from "../../scheduler/js/view.js";

test("every view is deep-linkable and unknown views fall back to the schedule", () => {
  for (const v of VIEWS) assert.equal(viewFromSearch(`?view=${v}`), v);
  assert.ok(VIEWS.includes("explorer"));
  assert.equal(viewFromSearch(""), "schedule");
  assert.equal(viewFromSearch("?view=nope"), "schedule");
  assert.equal(viewFromSearch("?view=__proto__"), "schedule");
});

test("urlForView: schedule is the bare page, others carry ?view=, Explorer keeps its own parameters", () => {
  const base = "http://x/scheduler/index.html";
  assert.equal(urlForView("schedule", `${base}?view=bumps`), "/scheduler/index.html");
  assert.equal(urlForView("bumps", `${base}?view=explorer&channel=science`), "/scheduler/index.html?view=bumps");
  assert.equal(urlForView("explorer", `${base}?view=explorer&channel=science`), "/scheduler/index.html?view=explorer&channel=science");
  assert.equal(urlForView("explorer", `${base}?view=bumps`), "/scheduler/index.html?view=explorer");
  assert.equal(urlForView("explorer", `${base}`), "/scheduler/index.html?view=explorer");
});
