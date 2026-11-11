// Tiny top-level view switcher. Lets cf-header's nav tabs (and anything
// else on the page, e.g. Bump Studio's "set up the announcer" link) swap
// which section of scheduler/index.html is visible, with no router/
// framework. "schedule" is the pre-existing Drive/live-playlist scheduler;
// "series", "programming", and "bumps" are admin views added alongside it;
// "explorer" is the read-only CRVideo Explorer.
// Switching views only toggles [hidden] -- nothing is ever unmounted, so
// none of the existing scheduler state/subscriptions are disturbed.
//
// The current view is mirrored into the URL as `?view=<name>` so deep links
// work and the browser's Back/Forward buttons move between views (for
// example Explorer -> Bump Studio -> Back). The "explorer" view's own query
// parameters (channel, series, ...) belong to explorer-store.js; when this
// module switches TO explorer it keeps whatever Explorer parameters are
// already in the URL.
//
// Bus contract (docs/bus-topics.md):
//   app.view.open  (command) {view}  -> setView(view)
//   app.view.state (state, retained) {view} published on every change

import { TOPICS, publishState, subscribe } from "../../js/bus.js";

export const VIEWS = ["schedule", "series", "programming", "bumps", "explorer"];

const hasWindow = typeof window !== "undefined" && typeof history !== "undefined";

/** The view named by a query string, or "schedule" if absent/unknown. */
export function viewFromSearch(search) {
  const v = new URLSearchParams(String(search || "").replace(/^\?/, "")).get("view");
  return VIEWS.includes(v) ? v : "schedule";
}

/** The URL (path + query + hash) that represents `view`, derived from `href`. */
export function urlForView(view, href) {
  const u = new URL(href, "http://x.invalid/");
  if (view === "schedule") u.search = "";
  else if (view === "explorer" && viewFromSearch(u.search) === "explorer") { /* keep Explorer's own params */ }
  else u.search = `?view=${view}`;
  return u.pathname + u.search + u.hash;
}

class ViewState {
  constructor() {
    this.current = hasWindow ? viewFromSearch(location.search) : "schedule";
    publishState(TOPICS.APP_VIEW_STATE, { view: this.current });
    subscribe(TOPICS.APP_VIEW_OPEN, ({ data }) => this.setView(data?.view));
    if (hasWindow) {
      // Back/Forward: the URL is the source of truth for which view is shown.
      window.addEventListener("popstate", () => {
        const view = viewFromSearch(location.search);
        if (view === this.current) return;
        this.current = view;
        publishState(TOPICS.APP_VIEW_STATE, { view });
      });
    }
  }

  setView(view) {
    if (!VIEWS.includes(view) || view === this.current) return;
    this.current = view;
    if (hasWindow) {
      try { history.pushState({ view }, "", urlForView(view, location.href)); } catch { /* sandboxed/file: keep working without history */ }
    }
    publishState(TOPICS.APP_VIEW_STATE, { view });
  }
}

export const viewState = new ViewState();
