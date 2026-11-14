// channels/viewer/data.js
//
// Browser-side loading for the viewer pages: the channel list and published
// schedules (broadcast.js, the same loaders the guide and player use) plus the
// viewer-safe show index/detail from channels/finder.php. Also the tiny
// "last channel" memory and the URL builders every page shares.

import { listChannels, loadChannel, fetchJson, syncClock } from "../broadcast.js";

const FINDER_URL = new URL("../finder.php", import.meta.url);
const LAST_KEY = "crvideo:viewer-channel";
const GUIDE_FOCUS_KEY = "crvideo:guide-focus"; // the guide's own "focused channel"

/** Correct for a wrong local clock, but never hold the page up for it. */
export async function startClock() {
  await Promise.race([syncClock(), new Promise((r) => setTimeout(r, 1500))]);
}

/** Visible channels' meta.json records (number, name, description, logo...), in channel order. */
export const loadChannelMetas = () => listChannels();

/** Fully loads (schedule + timelines) the given channel metas; one that fails is skipped and logged. */
export async function loadChannels(metas) {
  const settled = await Promise.allSettled(metas.map((m) => loadChannel(m.id, m)));
  settled.forEach((r, i) => { if (r.status === "rejected") console.warn(`Channel ${metas[i].id}:`, r.reason); });
  return settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
}

/** The show index. Never throws: `{shows: [], failed: true}` lets pages degrade to schedule-only. */
export async function loadShowIndex() {
  try {
    const { shows } = await fetchJson(FINDER_URL);
    return { shows: Array.isArray(shows) ? shows : [], failed: false };
  } catch (err) {
    console.warn("Show index unavailable:", err);
    return { shows: [], failed: true };
  }
}

/** One show with its approved episodes, or null if unknown. */
export async function loadShowDetail(id) {
  try {
    return await fetchJson(new URL(`?show=${encodeURIComponent(id)}`, FINDER_URL));
  } catch {
    return null;
  }
}

export function rememberChannel(id) {
  try { localStorage.setItem(LAST_KEY, id); } catch { /* optional */ }
}

/** The channel the viewer last opened here, else the one focused in the guide, else null. */
export function lastChannelId() {
  try { return localStorage.getItem(LAST_KEY) || localStorage.getItem(GUIDE_FOCUS_KEY) || null; } catch { return null; }
}

// URL builders -- every viewer page lives in channels/, so these are relative.
const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : "";
};
export const urls = {
  guide: () => "index.html",
  watch: (ch) => `watch.html${qs({ ch })}`,
  channel: (ch, extra = {}) => `channel.html${qs({ ch, ...extra })}`,
  show: (show, ch) => `show.html${qs({ show, ch })}`,
  browse: (params = {}) => `browse.html${qs(params)}`,
};
