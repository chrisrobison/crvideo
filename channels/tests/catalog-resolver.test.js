// channels/tests/catalog-resolver.test.js
//
// Plain node:test coverage for catalog-resolver.js (no extra test runner,
// no dependencies -- `node --test` is built into Node 18+). Run with:
//
//   node --test channels/tests/catalog-resolver.test.js
//
// Fixtures under channels/tests/fixtures/ are real files on disk, laid out
// exactly like the real repo (channels/<id>/catalog.json + series/<id>/
// series.json as siblings under a shared root) so the path-safety checks
// in resolveRef() are exercised against real relative-URL resolution, not
// a mock. fsFetchJson() below is the only test-specific stand-in: it reads
// a file:// URL from disk instead of doing an HTTP fetch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveCatalog, resolveRef, loadSeries } from "../catalog-resolver.js";
import { buildTimeline } from "../broadcast.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);

function fsFetchJson(url) {
  return Promise.resolve().then(() => JSON.parse(readFileSync(fileURLToPath(url), "utf8")));
}

/** Wraps fsFetchJson, recording every URL it was asked to load (used by
 *  the depth-limit test to prove a nested series ref was never fetched). */
function trackingFetchJson() {
  const requested = [];
  const fn = (url) => {
    requested.push(String(url));
    return fsFetchJson(url);
  };
  fn.requested = requested;
  return fn;
}

// ---------- legacy compatibility ----------

test("a flat, series-less catalog.json (the pre-series format) still resolves unchanged", async () => {
  const url = new URL("legacy/channels/sample/catalog.json", FIXTURES);
  const { items, series, errors } = await resolveCatalog(url, { fetchJson: fsFetchJson });
  assert.deepEqual(errors, []);
  assert.deepEqual(series, []);
  assert.equal(items.size, 2);
  assert.equal(items.get("film-a").title, "Film A");
  assert.equal(items.get("film-b").creator, "Studio Two");
});

test("the real channels/film-day-at-school/catalog.json resolves as a legacy catalog with zero series", async () => {
  const url = new URL("../film-day-at-school/catalog.json", import.meta.url);
  const { items, series, errors } = await resolveCatalog(url, { fetchJson: fsFetchJson });
  assert.deepEqual(errors, []);
  assert.deepEqual(series, []);
  // The real catalog has 167 flat items as of this writing; assert "many,
  // and all present" rather than hardcoding the exact count so a future
  // re-import doesn't spuriously fail this test.
  assert.ok(items.size > 100, `expected >100 items, got ${items.size}`);
  assert.ok(items.has("0771_Duck_and_Cover_12_33_20_12"));
});

test("the real channels/film-day-at-school/schedule.json still builds a valid timeline", () => {
  const raw = readFileSync(fileURLToPath(new URL("../film-day-at-school/schedule.json", import.meta.url)), "utf8");
  const schedule = JSON.parse(raw);
  const tl = buildTimeline(schedule);
  assert.ok(tl.cycle > 0);
  assert.ok(tl.entries.length > 0);
});

test("the channels/science catalog/schedule/meta all parse and build a valid timeline", async () => {
  const base = new URL("../science/", import.meta.url);
  const meta = JSON.parse(readFileSync(fileURLToPath(new URL("meta.json", base)), "utf8"));
  assert.equal(meta.name, "Science & Engineering");

  const schedule = JSON.parse(readFileSync(fileURLToPath(new URL("schedule.json", base)), "utf8"));
  const tl = buildTimeline(schedule);
  assert.ok(tl.cycle > 0);
  assert.ok(tl.entries.length > 0);

  const { items, series, errors } = await resolveCatalog(new URL("catalog.json", base), { fetchJson: fsFetchJson });
  assert.deepEqual(errors, []);
  // Episode count here depends on real import state (zero when the four
  // series are still structural placeholders, 14+ each once a real
  // `youtube-import.php` run has populated them -- both are valid; this
  // test only cares that resolution itself is error-free and structurally
  // sound, not a specific episode count at a specific point in time.
  assert.ok(items.size >= 0);
  assert.deepEqual(series.map((s) => s.id).sort(), [
    "electroboom", "practical-engineering", "steve-mould", "technology-connections",
  ]);
});

// ---------- series references resolve correctly ----------

test("series references resolve, load concurrently, and index episodes under collision-resistant keys", async () => {
  const url = new URL("repo-root-ok/channels/sample-with-series/catalog.json", FIXTURES);
  const { items, series, errors } = await resolveCatalog(url, { fetchJson: fsFetchJson });
  assert.deepEqual(errors, []);
  assert.equal(series.length, 2);
  assert.equal(items.size, 3); // a:ep1, a:ep2, b:ep1
  assert.equal(items.get("a:ep1").title, "A1");
  assert.equal(items.get("b:ep1").title, "B1"); // same raw episode id "ep1" as a:ep1, no collision
  assert.equal(items.get("a:ep1").series_id, "a");
  assert.equal(items.get("a:ep1").series_title, "Series A");
});

// ---------- invalid / missing series files produce actionable errors, not crashes ----------

test("a missing series file produces an actionable error and leaves the rest of the catalog usable", async () => {
  const url = new URL("repo-root-ok/channels/sample-missing/catalog.json", FIXTURES);
  const { items, errors } = await resolveCatalog(url, { fetchJson: fsFetchJson });
  assert.equal(items.size, 1);
  assert.equal(items.get("standalone-item").title, "Still loads even though the series ref below is missing");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /failed to fetch/);
});

test("a malformed series.json (missing required \"title\") is reported, not thrown", async () => {
  const url = new URL("repo-root-ok/series/malformed/series.json", FIXTURES);
  const result = await loadSeries(url, fsFetchJson);
  assert.ok(result.error);
  assert.match(result.error, /title/);
});

test("resolveCatalog never throws for a malformed catalog.json itself", async () => {
  const fetchJson = () => Promise.resolve([1, 2, 3]); // valid JSON, wrong shape (array, not object)
  const { items, series, errors } = await resolveCatalog(new URL("http://example.test/catalog.json"), { fetchJson });
  assert.equal(items.size, 0);
  assert.deepEqual(series, []);
  assert.equal(errors.length, 1);
});

// ---------- duplicate IDs are detected ----------

test("a duplicate series reference (same file listed twice) is flagged and only loaded once", async () => {
  const url = new URL("repo-root-ok/channels/sample-dup-ref/catalog.json", FIXTURES);
  const { items, series, errors } = await resolveCatalog(url, { fetchJson: fsFetchJson });
  assert.equal(series.length, 1);
  assert.equal(items.size, 2); // series A's two episodes, counted once
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicate series reference/);
});

test("a colliding episode id (flat item id happens to match a series-derived key) is flagged, first one wins", async () => {
  const url = new URL("repo-root-ok/channels/sample-collide/catalog.json", FIXTURES);
  const { items, errors } = await resolveCatalog(url, { fetchJson: fsFetchJson });
  // "a:ep1" exists once, as the flat item (loaded before series are merged in)
  assert.equal(items.get("a:ep1").title, "Flat item that happens to share a series-derived key");
  assert.ok(errors.some((e) => /colliding episode id "a:ep1"/.test(e)));
});

test("a duplicate episode id inside one series.json is flagged, first one wins", async () => {
  const url = new URL("repo-root-ok/series/dupe-ep/series.json", FIXTURES);
  const result = await loadSeries(url, fsFetchJson);
  assert.ok(!result.error);
  // loadSeries itself doesn't dedupe episodes (resolveCatalog does, since
  // that's where the id-collision bookkeeping lives) -- confirm the raw
  // duplicate is visible so resolveCatalog's dedup is actually exercised:
  assert.equal(result.series.episodes.length, 2);
  assert.equal(result.series.episodes[0].id, result.series.episodes[1].id);

  // Now go through resolveCatalog and confirm the duplicate is caught.
  const catalogFetch = (u) => {
    if (String(u).endsWith("dupe-ep/series.json")) return fsFetchJson(u);
    throw new Error("unexpected fetch");
  };
  const fakeCatalogUrl = new URL("repo-root-ok/channels/sample/catalog.json", FIXTURES);
  const fakeCatalog = { schema_version: 2, items: [], series: [{ ref: "../../series/dupe-ep/series.json" }] };
  const fetchJson = (u) => (String(u) === String(fakeCatalogUrl) ? Promise.resolve(fakeCatalog) : catalogFetch(u));
  const { items, errors } = await resolveCatalog(fakeCatalogUrl, { fetchJson });
  assert.equal(items.size, 1); // only "dupe:x" -- the second "x" was dropped
  assert.equal(items.get("dupe:x").title, "first");
  assert.ok(errors.some((e) => /colliding episode id "dupe:x"/.test(e)));
});

// ---------- path safety and include depth/cycle restriction ----------

test("resolveRef rejects absolute, protocol-relative, and root-escaping references", () => {
  const catalogUrl = new URL("repo-root-ok/channels/sample/catalog.json", FIXTURES);

  const escaping = resolveRef(catalogUrl, "../../../outside/series.json");
  assert.ok(escaping.error, "escaping the root should be rejected");

  const absolute = resolveRef(catalogUrl, "https://evil.example/series.json");
  assert.ok(absolute.error, "an absolute URL should be rejected");

  const protocolRelative = resolveRef(catalogUrl, "//evil.example/series.json");
  assert.ok(protocolRelative.error, "a protocol-relative reference should be rejected");

  const fine = resolveRef(catalogUrl, "../../series/a/series.json");
  assert.ok(!fine.error, `expected no error, got: ${fine.error}`);
});

test("resolveCatalog surfaces path-traversal and unsafe-reference attempts as errors, not crashes", async () => {
  const url = new URL("traversal/channels/sample/catalog.json", FIXTURES);
  const { items, series, errors } = await resolveCatalog(url, { fetchJson: fsFetchJson });
  assert.equal(items.size, 0);
  assert.equal(series.length, 0);
  assert.equal(errors.length, 3);
  assert.ok(errors.every((e) => /escapes the allowed root|absolute or protocol-relative/.test(e)));
});

test("a series.json's own \"series\" field (nested include) is ignored, not followed -- depth is limited to one level", async () => {
  const track = trackingFetchJson();

  const fakeCatalogUrl = new URL("repo-root-ok/channels/sample/catalog.json", FIXTURES);
  const fakeCatalog = { schema_version: 2, items: [], series: [{ ref: "../../series/depth/series.json" }] };
  const fetchJson = (u) => (String(u) === String(fakeCatalogUrl) ? Promise.resolve(fakeCatalog) : track(u));

  const { items, errors } = await resolveCatalog(fakeCatalogUrl, { fetchJson });
  assert.equal(items.size, 1);
  assert.ok(items.has("depth:d1"));
  assert.ok(!items.has("nested:n1"), "the nested series must not have been merged in");
  assert.ok(!track.requested.some((u) => u.endsWith("nested.json")), "nested.json must never have been fetched");
  assert.ok(errors.some((e) => /may not itself contain a "series" field/.test(e)));
});
