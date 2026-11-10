// Tiny top-level view switcher. Lets cf-header's nav tabs (and anything
// else on the page, e.g. Bump Studio's "set up the announcer" link) swap
// which section of scheduler/index.html is visible, with no router/
// framework. "schedule" is the pre-existing Drive/live-playlist scheduler;
// "series", "programming", and "bumps" are admin views added alongside it.
// Switching views only toggles [hidden] -- nothing is ever unmounted, so
// none of the existing scheduler state/subscriptions are disturbed.
//
// Bus contract (docs/bus-topics.md):
//   app.view.open  (command) {view}  -> setView(view)
//   app.view.state (state, retained) {view} published on every change

import { TOPICS, publishState, subscribe } from "../../js/bus.js";

export const VIEWS = ["schedule", "series", "programming", "bumps"];

class ViewState {
  constructor() {
    this.current = "schedule";
    publishState(TOPICS.APP_VIEW_STATE, { view: this.current });
    subscribe(TOPICS.APP_VIEW_OPEN, ({ data }) => this.setView(data?.view));
  }

  setView(view) {
    if (!VIEWS.includes(view) || view === this.current) return;
    this.current = view;
    publishState(TOPICS.APP_VIEW_STATE, { view });
  }
}

export const viewState = new ViewState();
