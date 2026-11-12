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
const ANNOUNCER_ENDPOINT = "../server/announcer-admin.php";
const BUMP_ENDPOINT = "../server/bump-admin.php";
const EXPLORER_ENDPOINT = "../server/explorer-admin.php";

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

// server/announcer-admin.php -- the AI continuity announcer's admin surface
// (see channels/announcer/README.md). A thin wrapper; see that file's header
// for what each action does.
export const announcerAdminApi = {
  list: () => getJson(`${ANNOUNCER_ENDPOINT}?action=list`).then((r) => r.channels),
  voices: (channelId) => getJson(`${ANNOUNCER_ENDPOINT}?action=voices&channel_id=${encodeURIComponent(channelId)}`),
  saveConfig: (channelId, config) => postJson(ANNOUNCER_ENDPOINT, { action: "save_config", channel_id: channelId, config }),
  previewVoice: (channelId, voice) => postJson(ANNOUNCER_ENDPOINT, { action: "preview_voice", channel_id: channelId, voice }),
  regenerate: (channelId, transitionId, opts) => postJson(ANNOUNCER_ENDPOINT, { action: "regenerate", channel_id: channelId, transition_id: transitionId, ...opts }),
  generateQueue: (channelId) => postJson(ANNOUNCER_ENDPOINT, { action: "generate_queue", channel_id: channelId }),
  approveScript: (channelId, scriptHash, text) => postJson(ANNOUNCER_ENDPOINT, { action: "approve_script", channel_id: channelId, script_hash: scriptHash, text }),
};

// server/bump-admin.php -- the bump creator's admin surface (see
// bumps/README.md for the full schema). Same thin, un-opinionated wrapper
// posture as the others above.
export const bumpAdminApi = {
  list: () => getJson(`${BUMP_ENDPOINT}?action=list`).then((r) => r.bumps),
  media: () => getJson(`${BUMP_ENDPOINT}?action=media`),
  create: (bump) => postJson(BUMP_ENDPOINT, { action: "create", ...bump }).then((r) => r.bump),
  update: (id, bump) => postJson(BUMP_ENDPOINT, { action: "update", id, ...bump }).then((r) => r.bump),
  delete: (id) => postJson(BUMP_ENDPOINT, { action: "delete", id }),
  // Channel scheduling (channels/<id>/bump-schedule.json) -- a separate
  // concern from the bump definitions above, see bump-admin.php's header.
  schedules: () => getJson(`${BUMP_ENDPOINT}?action=schedules`).then((r) => r.channels),
  saveSchedule: (channelId, enabled, rules) => postJson(BUMP_ENDPOINT, { action: "save_schedule", channel_id: channelId, enabled, rules }).then((r) => r.schedule),
};

// server/explorer-admin.php -- READ-ONLY compact projections of series/*/series.json
// for CRVideo Explorer (the full series list above is ~6 MB). GET only.
export const explorerAdminApi = {
  seriesIndex: () => getJson(`${EXPLORER_ENDPOINT}?action=series_index`).then((r) => r.series),
  series: (id) => getJson(`${EXPLORER_ENDPOINT}?action=series&id=${encodeURIComponent(id)}`).then((r) => r.series),
  episodeIndex: () => getJson(`${EXPLORER_ENDPOINT}?action=episode_index`).then((r) => r.episodes),
};
