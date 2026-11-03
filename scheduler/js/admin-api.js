// Plain fetch wrappers for the two admin-UI backend endpoints
// (server/series-admin.php, server/channel-admin.php).
//
// Deliberately independent of store.js: that module owns the pre-
// existing, unrelated Drive/live-playlist scheduling concept (a
// different backend, a different data model entirely); these two talk
// to a completely different backend, so cf-series-admin.js/
// cf-channel-admin.js keep their own small local component state instead
// of entangling the two state models.
//
// No access control is required by these endpoints today -- see
// docs/admin-ui.md ("No access control") -- these calls succeed for
// anyone who can load this page. Nothing client-side can change that;
// it's recorded here only so this file isn't mistaken for a place that
// enforces anything.

const SERIES_ENDPOINT = "../server/series-admin.php";
const CHANNEL_ENDPOINT = "../server/channel-admin.php";

async function getJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status})`);
  return body;
}

async function postJson(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status})`);
  return body;
}

export const seriesAdminApi = {
  list: () => getJson(`${SERIES_ENDPOINT}?action=list`).then((r) => r.series),
  saveEpisode: (payload) => postJson(SERIES_ENDPOINT, { action: "save_episode", ...payload }),
  refresh: (seriesId, dryRun) => postJson(SERIES_ENDPOINT, { action: "refresh", series_id: seriesId, dry_run: !!dryRun }),
  newImport: (payload) => postJson(SERIES_ENDPOINT, { action: "new_import", ...payload }),
};

export const channelAdminApi = {
  list: () => getJson(`${CHANNEL_ENDPOINT}?action=list`).then((r) => r.channels),
  saveCatalog: (channelId, seriesIds) => postJson(CHANNEL_ENDPOINT, { action: "save_catalog", channel_id: channelId, series_ids: seriesIds }),
  saveProgramming: (channelId, blocks) => postJson(CHANNEL_ENDPOINT, { action: "save_programming", channel_id: channelId, blocks }),
  publish: (channelId, opts) => postJson(CHANNEL_ENDPOINT, { action: "publish", channel_id: channelId, ...opts }),
};
