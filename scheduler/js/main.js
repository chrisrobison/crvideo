// Registers every ChannelFlow web component and boots the store.
// Plain ES modules — no bundler, no build step.
import "./store.js";
import "./components/cf-toggle.js";
import "./components/cf-stat-card.js";
import "./components/cf-stat-bar.js";
import "./components/cf-header.js";
import "./components/cf-media-item.js";
import "./components/cf-media-library.js";
import "./components/cf-timeline.js";
import "./components/cf-rundown.js";
import "./components/cf-details-panel.js";
import "./components/cf-program-monitor.js";
import "./components/cf-drive-folder-picker.js";
import "./components/cf-series-admin.js";
import "./components/cf-channel-admin.js";
import { viewState } from "./view.js";

// Toggles which top-level view section is visible -- see view.js. The
// pre-existing SCHEDULE markup is untouched; this just adds [data-view]
// containers around it and the two new admin views, and shows exactly one.
function applyView() {
  document.querySelectorAll("[data-view]").forEach((el) => {
    el.hidden = el.dataset.view !== viewState.current;
  });
}
viewState.addEventListener("change", applyView);
applyView();
