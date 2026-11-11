// explorer-api.js -- Explorer's read-only, cached data access. Everything is
// composed from existing sources (docs/explorer.md "Reused as-is"); nothing
// here writes. Every loader memoises its promise, drops a failed promise so
// a retry is possible, and returns plain data the pure model can index.

import { channelAdminApi, bumpAdminApi, explorerAdminApi } from "../../admin-api.js";
import { fetchJson, loadAnnouncements, loadBumpSchedule, loadTheme } from "../../../../channels/broadcast.js";
import { buildScheduleView } from "./explorer-model.js";

const CHANNELS_URL = new URL("../../../../channels/", import.meta.url);
export const REPO_ROOT = new URL("../../../../", import.meta.url);

/** A repo-relative media path ("media/..." | "channels/...") -> absolute URL, or null if not an approved location. */
export function mediaUrl(path) {
  const clean = String(path || "").replace(/^\/+/, "");
  if (!/^(?:media|channels)\/[A-Za-z0-9._\-\/]+$/.test(clean) || clean.split("/").includes("..")) return null;
  return new URL(clean, REPO_ROOT).href;
}

function memo(fn) {
  const cache = new Map();
  const wrapped = (key = "") => {
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => fn(key)).catch((e) => { cache.delete(key); throw e; }));
    return cache.get(key);
  };
  wrapped.clear = () => cache.clear();
  wrapped.peek = (key = "") => cache.has(key);
  return wrapped;
}

const channelBase = (id) => new URL(`${id}/`, CHANNELS_URL);

/** Visible channels: channel-admin's row (catalog refs, programming blocks) merged with channels.php's meta.json. */
export const getChannels = memo(async () => {
  const [rows, listing] = await Promise.all([
    channelAdminApi.list(),
    fetchJson(new URL("channels.php", CHANNELS_URL)).then((r) => r.channels || []).catch(() => []),
  ]);
  const meta = new Map(listing.map((m) => [m.id, m]));
  return rows
    .filter((c) => !c.hidden)
    .map((c) => {
      const m = meta.get(c.id) || {};
      return {
        ...c,
        meta: m,
        number: Number.isFinite(m.number) ? m.number : c.number ?? null,
        name: m.name || c.name || c.id,
        description: m.description || c.description || "",
        logoUrl: m.logo ? new URL(m.logo, channelBase(c.id)).href : null,
        theme: m.theme && typeof m.theme === "object" ? m.theme : null,
      };
    })
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.name.localeCompare(b.name));
});

export const getSeriesIndex = memo(() => explorerAdminApi.seriesIndex());
export const getSeriesDetail = memo((id) => explorerAdminApi.series(id));
export const getEpisodeIndex = memo(() => explorerAdminApi.episodeIndex());

/** A channel's published schedule as a ScheduleView (see explorer-model.js). */
export const getScheduleView = memo(async (id) => {
  const base = channelBase(id);
  const meta = await fetchJson(new URL("meta.json", base));
  const schedule = await fetchJson(new URL(meta.schedule || "schedule.json", base));
  return buildScheduleView({ id, meta, schedule });
});

const channelUrls = async (id) => {
  const channels = await getChannels();
  const meta = channels.find((c) => c.id === id)?.meta || {};
  const base = channelBase(id);
  return {
    announcementsUrl: new URL(meta.announcements || "announcements.json", base).href,
    bumpScheduleUrl: new URL(meta.bumpSchedule || "bump-schedule.json", base).href,
    themeUrl: new URL(meta.bumperTheme || "theme.json", base).href,
  };
};

export const getAnnouncements = async (id) => loadAnnouncements(await channelUrls(id)); // [] when absent
export const getBumpScheduleFor = async (id) => loadBumpSchedule(await channelUrls(id)); // {enabled:false,rules:[]} when absent
export const getBumperTheme = async (id) => loadTheme(await channelUrls(id)); // null when absent

/** Optional per-channel files; null when absent or unreadable (many channels have none of them). */
const optionalChannelJson = (file) => memo(async (id) => fetchJson(new URL(file, channelBase(id))).catch(() => null));
export const getContinuity = optionalChannelJson("continuity.json");
export const getAnnouncerConfig = optionalChannelJson("announcer.json");

export const getBumps = memo(() => bumpAdminApi.list());
export const getBumpSchedules = memo(() => bumpAdminApi.schedules());
export const getMedia = memo(() => bumpAdminApi.media());

/** Every visible channel's announcements, {channelId: record[]}. Small files; loaded together on demand. */
export const getAllAnnouncements = memo(async () => {
  const channels = await getChannels();
  const lists = await Promise.all(channels.map((c) => getAnnouncements(c.id)));
  return Object.fromEntries(channels.map((c, i) => [c.id, lists[i]]));
});

export function clearAll() {
  for (const f of [getChannels, getSeriesIndex, getSeriesDetail, getEpisodeIndex, getScheduleView, getContinuity, getAnnouncerConfig, getBumps, getBumpSchedules, getMedia, getAllAnnouncements]) f.clear();
}
