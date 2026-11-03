// Resolves a channel catalog.json's `series` references into a flat map of
// playable entries, shared by the channel guide (index.html) and the watch
// player (watch.html) via broadcast.js.
//
// Background: a catalog.json historically held only a flat `items` array
// (one row per piece of media, keyed by id -- see channels/film-day-at-
// school/catalog.json, produced by ia-import). That format keeps working
// unchanged (schema_version 1, or no schema_version at all, with no
// `series` key -- see resolveCatalog() below). This module *adds* an
// optional `series` array of references to externally-maintained
// series.json files (see series/<id>/series.json for the format), so a
// show's metadata can be written once and reused across channels instead
// of copy-pasted into every catalog that airs it.
//
// This module is deliberately plain data in, plain data out: no DOM, no
// built-in network client baked into the resolution logic itself (callers
// inject `fetchJson`), so it can run under Node for tests and, so the same
// rules (safe reference resolution, one include level, duplicate/collision
// detection) can be mirrored in PHP -- see channels/publish/src/CatalogResolver.php,
// added in phase 4's publish step, which must be kept in lockstep with this
// file (same root-escape rule, same depth-1 limit, same dedup/collision
// handling; there is no shared source between the two implementations, by
// design -- see that file's header for the specifics of what must match).
//
// An episode's "status" (series.json's episode.status) is one of:
//   "candidate" -- imported but not reviewed; the default for anything an
//                  importer writes. Never eligible for scheduling.
//   "approved"  -- an editor has reviewed it and cleared it to air. Only
//                  "approved" episodes are eligible for the publish step's
//                  recurring-series rotation (channels/publish/).
//   "rejected"  -- reviewed and declined; kept in the file (never deleted)
//                  so it isn't re-imported as a new candidate.
//   "disabled"  -- was approved and may have aired before, but is
//                  temporarily pulled from rotation without un-approving
//                  it for good (e.g. a rights question came up). Distinct
//                  from "rejected" (permanent) and "candidate" (never yet
//                  reviewed).
// This module itself doesn't filter by status -- it indexes every episode
// a series.json lists, status included, so a catalog-metadata consumer
// (e.g. the guide) can still look up and display any episode by id. Status
// *filtering* is the publish step's job, not this resolver's.
//
// Separately, an episode's "rights" ({"status", "notes"}) tracks content
// licensing, independent of editorial status above. Suggested rights.status
// values: "unverified" (the default -- nothing has been checked; this is
// what every importer-written episode gets and NEVER anything else, since
// neither ia-import nor youtube-import infers rights from a video simply
// being publicly fetchable), "creator_permission", "licensed",
// "public_domain", "restricted". This field is editorial bookkeeping only
// -- see docs/series-and-channels.md ("Editorial status and content
// rights") for the full policy, including why "creator_permission" here
// never overrides YouTube's own API terms or unlocks any different
// playback behavior.

/** Series ids and episode ids must be filesystem/URL-safe tokens -- the
 *  same shape as CHANNEL_ID in broadcast.js. */
export const SERIES_ID = /^[a-z0-9][a-z0-9-]*$/;

/** series.json may not itself reference further series.json files. One
 *  include level only; see resolveCatalog()'s handling of a loaded
 *  series's own `series` field. */
export const MAX_SERIES_DEPTH = 1;

/** Default JSON fetcher (browser `fetch`, no caching beyond what the HTTP
 *  cache headers say -- same as broadcast.js's own fetchJson). Tests and
 *  any non-browser caller pass their own `fetchJson` instead. */
export async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/**
 * Resolves `ref` (as written in a catalog's `series` array, e.g.
 * "../../series/technology-connections/series.json") against the catalog
 * file that references it, and checks it's safe to follow:
 *
 *  - no absolute URL or protocol-relative reference (only a same-site
 *    relative path is accepted -- a catalog cannot pull in an arbitrary
 *    external JSON file and have it treated as trusted series metadata)
 *  - the resolved path must stay within `root` (by default two directories
 *    above the catalog, i.e. the repo root shared by channels/ and
 *    series/) -- this is the path-traversal guard: "../../../../etc/x"
 *    from a channel catalog resolves above `root` and is rejected, no
 *    matter how the string is spelled.
 *
 * Returns { url } on success or { error } (a string) on failure. Never
 * throws -- callers use this to decide whether to even attempt a fetch.
 */
export function resolveRef(catalogUrl, ref, root = defaultRoot(catalogUrl)) {
  catalogUrl = new URL(catalogUrl);
  root = new URL(root);
  if (typeof ref !== "string" || !ref.trim()) {
    return { error: "empty or missing reference" };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) {
    return { error: `absolute or protocol-relative references are not allowed: "${ref}"` };
  }
  let url;
  try {
    url = new URL(ref, catalogUrl);
  } catch {
    return { error: `malformed reference: "${ref}"` };
  }
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
    return { error: `reference escapes the allowed root: "${ref}"` };
  }
  return { url };
}

/** channels/<id>/catalog.json -> two directories up is the repo root
 *  shared by channels/ and series/. Callers (e.g. a future PHP mirror, or
 *  a catalog living somewhere else) can pass an explicit `root` instead. */
function defaultRoot(catalogUrl) {
  return new URL("../../", catalogUrl);
}

/**
 * Loads and structurally validates one series.json. Never throws: fetch
 * failures and malformed JSON come back as { error } so one bad series
 * reference can't take down the whole catalog (or an unrelated channel).
 */
export async function loadSeries(url, fetchJsonFn = fetchJson) {
  let raw;
  try {
    raw = await fetchJsonFn(url);
  } catch (err) {
    return { error: `failed to fetch ${url}: ${err.message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: `${url}: series.json is not a JSON object` };
  }
  if (typeof raw.id !== "string" || !SERIES_ID.test(raw.id)) {
    return { error: `${url}: missing or invalid "id"` };
  }
  if (typeof raw.title !== "string" || !raw.title) {
    return { error: `${url}: missing "title"` };
  }
  const episodesRaw = raw.episodes;
  if (episodesRaw !== undefined && !Array.isArray(episodesRaw)) {
    return { error: `${url}: "episodes" must be an array` };
  }
  return { series: raw, url: String(url) };
}

/**
 * Resolves a channel's catalog.json: its flat `items` plus every series it
 * references, into one id -> item Map (what loadCatalog() in broadcast.js
 * has always returned, so existing callers don't change). Also returns the
 * loaded series' show-level metadata and a list of every problem hit along
 * the way -- missing/malformed files, unsafe references, duplicate
 * references, and colliding ids are all reported, never thrown, so a
 * broken reference degrades the one channel, not the whole guide.
 *
 * Episode ids are indexed as "<seriesId>:<episodeId>" -- collision-
 * resistant by construction, since two different series can never produce
 * the same key even if they happen to reuse an episode id internally.
 *
 * @returns {Promise<{items: Map<string,object>, series: object[], errors: string[]}>}
 */
export async function resolveCatalog(catalogUrl, { fetchJson: fetchJsonFn = fetchJson, root } = {}) {
  catalogUrl = new URL(catalogUrl);
  const errors = [];
  const items = new Map();
  const series = [];

  let raw;
  try {
    raw = await fetchJsonFn(catalogUrl);
  } catch (err) {
    errors.push(`failed to fetch catalog ${catalogUrl}: ${err.message}`);
    return { items, series, errors };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`${catalogUrl}: catalog.json is not a JSON object`);
    return { items, series, errors };
  }

  // ---- flat items (the pre-existing, still fully supported format) ----
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (!item || typeof item.id !== "string" || !item.id) {
      errors.push(`catalog item missing a string "id"`);
      continue;
    }
    if (items.has(item.id)) {
      errors.push(`duplicate item id "${item.id}" in catalog items`);
      continue;
    }
    items.set(item.id, item);
  }

  // ---- series references ----
  const seriesRefs = Array.isArray(raw.series) ? raw.series : [];
  const effectiveRoot = root ? new URL(root) : defaultRoot(catalogUrl);
  const seenUrls = new Set();
  const toLoad = [];

  for (const entry of seriesRefs) {
    const ref = entry && typeof entry.ref === "string" ? entry.ref : null;
    if (!ref) {
      errors.push(`series entry missing a string "ref": ${JSON.stringify(entry)}`);
      continue;
    }
    const resolved = resolveRef(catalogUrl, ref, effectiveRoot);
    if (resolved.error) {
      errors.push(`series ref "${ref}": ${resolved.error}`);
      continue;
    }
    const href = resolved.url.href;
    if (seenUrls.has(href)) {
      errors.push(`duplicate series reference (already included): "${ref}"`);
      continue;
    }
    seenUrls.add(href);
    toLoad.push(resolved.url);
  }

  // Load every referenced series concurrently; one failure doesn't block
  // the others or the catalog's flat items.
  const loaded = await Promise.all(toLoad.map((url) => loadSeries(url, fetchJsonFn)));

  for (const result of loaded) {
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    const s = result.series;

    // One include level only: a series.json is not itself allowed to
    // reference further series. Surface it as a warning and ignore the
    // field rather than crash or silently recurse.
    if (Array.isArray(s.series) && s.series.length) {
      errors.push(`${result.url}: series.json may not itself contain a "series" field (max depth is ${MAX_SERIES_DEPTH}); ignoring it`);
    }

    series.push({
      id: s.id,
      title: s.title,
      description: s.description ?? null,
      creator: s.creator ?? null,
      year: s.year ?? null,
      thumbnail_url: s.thumbnail_url ?? null,
      logo_url: s.logo_url ?? null,
      source: s.source ?? null,
      url: result.url,
      episodeCount: Array.isArray(s.episodes) ? s.episodes.length : 0,
    });

    const episodes = Array.isArray(s.episodes) ? s.episodes : [];
    episodes.forEach((ep, index) => {
      if (!ep || typeof ep.id !== "string" || !ep.id) {
        errors.push(`${result.url}: episode at index ${index} missing a string "id"`);
        return;
      }
      const key = `${s.id}:${ep.id}`;
      if (items.has(key)) {
        errors.push(`colliding episode id "${key}" (from ${result.url}); keeping the first one seen`);
        return;
      }
      items.set(key, {
        ...ep,
        id: key,
        series_id: s.id,
        series_title: s.title,
      });
    });
  }

  return { items, series, errors };
}
