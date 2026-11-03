// Tiny top-level view switcher -- plain EventTarget, same minimal-state
// convention store.js already uses. Lets cf-header's nav tabs swap which
// section of scheduler/index.html is visible, with no router/framework.
// "schedule" is the pre-existing Drive/live-playlist scheduler
// (unchanged); "series" and "programming" are the new admin views added
// alongside it. Switching views only toggles [hidden] -- nothing is ever
// unmounted, so none of the existing scheduler state/listeners are
// disturbed by this.

export const VIEWS = ["schedule", "series", "programming"];

class ViewState extends EventTarget {
  constructor() {
    super();
    this.current = "schedule";
  }

  setView(view) {
    if (!VIEWS.includes(view) || view === this.current) return;
    this.current = view;
    this.dispatchEvent(new CustomEvent("change", { detail: { view } }));
  }
}

export const viewState = new ViewState();
