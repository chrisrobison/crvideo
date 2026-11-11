// explorer-actions.js -- the click vocabulary of Explorer's markup. Panels
// render buttons/links with `data-act` (+ data-* ids) and one delegated
// handler (here) turns them into store navigation or hand-offs to the
// existing editors over the page bus. Nothing here mutates content: hand-offs
// only change which view/entity another editor SHOWS, and Bump Studio's own
// unsaved-changes guard still applies (it owns `studio.compose.open`).

import { TOPICS, publish, subscribe } from "../../../../js/bus.js";
import { parseAssetRef } from "./explorer-route.js";

const WATCH_URL = new URL("../../../../channels/watch.html", import.meta.url);

function openView(view) {
  publish(TOPICS.APP_VIEW_OPEN, { view });
}

/** Bump Studio lazy-loads its list on first view; wait for its own retained status before sending a command. */
function whenStudioReady(fn, timeoutMs = 8000) {
  let done = false;
  const ctl = new AbortController();
  const finish = () => { if (done) return; done = true; ctl.abort(); fn(); };
  subscribe(TOPICS.STUDIO_STATUS_STATE, ({ data }) => { if (data?.status === "ready") finish(); }, { retained: true, signal: ctl.signal });
  setTimeout(finish, timeoutMs); // never strand the hand-off; the studio ignores an unknown id
}

export const handoff = {
  programming(channelId, blockId = null) {
    openView("programming");
    publish(TOPICS.PROGRAMMING_CHANNEL_OPEN, { channelId, ...(blockId ? { blockId } : {}) });
  },
  seriesReview(seriesId, episodeId = null) {
    openView("series");
    publish(TOPICS.SERIES_REVIEW_OPEN, { seriesId, ...(episodeId ? { episodeId } : {}) });
  },
  bumpCompose(id) {
    openView("bumps");
    whenStudioReady(() => publish(TOPICS.STUDIO_COMPOSE_OPEN, { id }));
  },
  bumpSchedule(channelId) {
    openView("bumps");
    whenStudioReady(() => publish(TOPICS.STUDIO_SCHEDULE_OPEN, { channelId }));
  },
  /** Opens the channel in the existing player page in a new tab -- a separate, normal viewing session. */
  watchChannel(channelId) {
    const url = new URL(WATCH_URL);
    url.searchParams.set("ch", channelId);
    window.open(url.href, "_blank", "noopener");
  },
};

/**
 * @param {import("./explorer-store.js").ExplorerStore} store
 * @param {HTMLElement} el an element carrying data-act
 * @returns {boolean} whether the action was recognised here
 */
export function runAction(store, el) {
  const d = el.dataset;
  switch (d.act) {
    case "nav-channel": store.selectChannel(d.id); return true;
    case "nav-series": store.selectSeries(d.id, d.channel === undefined ? undefined : d.channel || null); return true;
    case "nav-episode":
      if (d.series && d.series !== store.route.series) store.go({ series: d.series, episode: d.id, airing: null, channel: d.channel ?? store.route.channel, mode: "programs", q: "" });
      else store.selectEpisode(d.id);
      return true;
    case "nav-airing": store.selectAiring(d.channel, Number(d.start)); return true;
    case "nav-asset": {
      const ref = parseAssetRef(d.asset);
      if (ref) store.selectAsset(ref);
      return !!ref;
    }
    case "nav-category": store.setCategory(d.id); return true;
    case "nav-mode": store.setMode(d.id); return true;
    case "nav-route": {
      const patch = JSON.parse(d.route || "{}");
      store.open(patch);
      return true;
    }
    case "time-now": store.setTime(null); return true;
    case "time-set": store.setTime(Number(d.t)); return true;
    case "open-programming": handoff.programming(d.channel || store.route.channel, d.block || null); return true;
    case "open-series-review": handoff.seriesReview(d.series || store.route.series, d.episode || null); return true;
    case "open-bump-studio": handoff.bumpCompose(d.id); return true;
    case "open-bump-schedule": handoff.bumpSchedule(d.channel || store.route.channel); return true;
    case "watch-channel": handoff.watchChannel(d.channel || store.route.channel); return true;
    default: return false;
  }
}
