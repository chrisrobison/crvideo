// explorer-route.js -- pure URL <-> Explorer route state. No DOM, no
// network, so it is unit-tested under Node (channels/tests/explorer-route.test.js).
//
// Explorer's deep links are ordinary query parameters on the scheduler page:
//
//   ?view=explorer&channel=science&series=practical-engineering&episode=yt-awV7FP9sAHE
//   ?view=explorer&channel=science&airing=1794384010&t=1794385000
//   ?view=explorer&mode=production&cat=bumps&asset=bump:night-owl
//   ?view=explorer&q=bridge&scope=episodes
//
// Identity rules (docs/explorer.md): every selection is a semantic id, never
// an array index or display name. An *airing* is (channel, start timestamp in
// epoch seconds) -- NOT an episode id, because one episode can air many times.
// Anything malformed is dropped (and reported in `invalid`), never trusted.

export const MODES = ["programs", "production"];
export const SEARCH_SCOPES = ["all", "channels", "series", "episodes", "airings", "bumps", "announcements", "media"];
export const PRODUCTION_CATEGORIES = ["bumps", "announcements", "music", "ambience", "video", "image"];

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const EPISODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MEDIA_PATH = /^(?:media|channels)\/[A-Za-z0-9._\-\/]{1,300}$/;
const ANNOUNCEMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** Typed asset reference: "bump:<id>" | "announcement:<channel>:<id>" | "media:<path>". */
export function parseAssetRef(raw) {
  if (typeof raw !== "string") return null;
  const i = raw.indexOf(":");
  if (i < 0) return null;
  const kind = raw.slice(0, i);
  const rest = raw.slice(i + 1);
  if (kind === "bump") return SLUG.test(rest) ? { kind, id: rest } : null;
  if (kind === "announcement") {
    const j = rest.indexOf(":");
    if (j < 0) return null;
    const channelId = rest.slice(0, j);
    const id = rest.slice(j + 1);
    return SLUG.test(channelId) && ANNOUNCEMENT_ID.test(id) ? { kind, channelId, id } : null;
  }
  if (kind === "media") {
    // Only repo-relative media/channels paths; no traversal, no schemes, no query.
    if (!MEDIA_PATH.test(rest) || rest.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return null;
    return { kind, path: rest };
  }
  return null;
}

export function assetRefToString(ref) {
  if (!ref) return null;
  if (ref.kind === "bump") return `bump:${ref.id}`;
  if (ref.kind === "announcement") return `announcement:${ref.channelId}:${ref.id}`;
  if (ref.kind === "media") return `media:${ref.path}`;
  return null;
}

/** Epoch seconds from an integer string or an ISO timestamp; null if neither. */
export function parseInstant(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  if (/^\d{9,11}$/.test(raw)) return Number(raw);
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return null;
}

export function emptyRoute() {
  return {
    mode: "programs",
    channel: null, series: null, episode: null, airing: null, t: null,
    cat: null, asset: null,
    q: "", scope: "all",
    invalid: [],
  };
}

/** @param {string|URLSearchParams} search */
export function parseRoute(search) {
  const p = search instanceof URLSearchParams ? search : new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const r = emptyRoute();
  const bad = (k) => { if (p.has(k)) r.invalid.push(k); };

  const mode = p.get("mode");
  if (mode && MODES.includes(mode)) r.mode = mode; else if (mode) bad("mode");

  for (const key of ["channel", "series"]) {
    const v = p.get(key);
    if (v && SLUG.test(v)) r[key] = v; else if (v) bad(key);
  }
  const ep = p.get("episode");
  if (ep && EPISODE_ID.test(ep)) r.episode = ep; else if (ep) bad("episode");

  const airing = p.get("airing");
  if (airing && /^\d{9,11}$/.test(airing)) r.airing = Number(airing); else if (airing) bad("airing");

  const t = p.get("t");
  const ti = parseInstant(t);
  if (ti !== null) r.t = ti; else if (t) bad("t");

  const cat = p.get("cat");
  if (cat && PRODUCTION_CATEGORIES.includes(cat)) r.cat = cat; else if (cat) bad("cat");

  const asset = parseAssetRef(p.get("asset"));
  if (asset) r.asset = asset; else if (p.get("asset")) bad("asset");

  const q = (p.get("q") || "").trim().slice(0, 120);
  r.q = q;
  const scope = p.get("scope");
  if (scope && SEARCH_SCOPES.includes(scope)) r.scope = scope; else if (scope) bad("scope");

  // An airing is only meaningful within a channel.
  if (r.airing !== null && !r.channel) { r.airing = null; r.invalid.push("airing"); }
  // An episode needs a series to be resolvable.
  if (r.episode && !r.series) { r.episode = null; r.invalid.push("episode"); }
  return r;
}

/** Route -> query string (no leading "?"), omitting defaults. `view=explorer` is always first. */
export function serializeRoute(route) {
  const p = new URLSearchParams();
  p.set("view", "explorer");
  if (route.mode && route.mode !== "programs") p.set("mode", route.mode);
  if (route.channel) p.set("channel", route.channel);
  if (route.series) p.set("series", route.series);
  if (route.episode) p.set("episode", route.episode);
  if (route.airing !== null && route.airing !== undefined) p.set("airing", String(route.airing));
  if (route.t !== null && route.t !== undefined) p.set("t", String(Math.floor(route.t)));
  if (route.cat) p.set("cat", route.cat);
  if (route.asset) p.set("asset", assetRefToString(route.asset));
  if (route.q) p.set("q", route.q);
  if (route.scope && route.scope !== "all") p.set("scope", route.scope);
  return p.toString();
}

/** Breadcrumb trail (labels are resolved by the caller; this only fixes the
 *  ordered, typed crumbs a route implies). */
export function routeCrumbs(route) {
  const crumbs = [{ type: "root" }];
  if (route.q) { crumbs.push({ type: "search", q: route.q }); return crumbs; }
  if (route.mode === "production") {
    crumbs.push({ type: "production" });
    if (route.cat) crumbs.push({ type: "category", cat: route.cat });
    if (route.asset) crumbs.push({ type: "asset", asset: route.asset });
    return crumbs;
  }
  if (route.channel) crumbs.push({ type: "channel", id: route.channel });
  if (route.series) crumbs.push({ type: "series", id: route.series });
  if (route.episode) crumbs.push({ type: "episode", id: route.episode });
  if (route.airing !== null) crumbs.push({ type: "airing", at: route.airing });
  return crumbs;
}
