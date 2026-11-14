// channels/viewer/nav.js
//
// <cr-viewer-nav active="guide|channels|browse"> -- the one top bar shared by
// the viewer surfaces (the channel guide, channel.html, browse.html,
// show.html): CRVIDEO wordmark, Guide / Channels / Browse tabs and the
// broadcast clock. Self-contained (shadow DOM + its own styles) so it looks
// the same inside the guide's flex-column body as on the document-style pages.
//
// "Channels" deep-links to the channel the viewer last looked at (see
// viewer/data.js's rememberChannel()), so the tab is never a dead end.

import { now } from "../broadcast.js";
import { lastChannelId } from "./data.js";

const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });

const STYLE = `
:host { display: block; flex: 0 0 auto; position: sticky; top: 0; z-index: 20; }
header { height: 64px; display: flex; align-items: center; gap: 28px; padding: 0 clamp(14px, 3vw, 34px);
  border-bottom: 1px solid #243049; background: rgba(8, 11, 18, .94); backdrop-filter: blur(8px);
  font: 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #eef2f8; }
.brand { font-weight: 900; letter-spacing: .05em; color: #eef2f8; text-decoration: none; }
.brand b { color: #ffcc33; }
nav { display: flex; align-items: stretch; height: 100%; gap: 4px; }
nav a { display: flex; align-items: center; padding: 0 14px; color: #8e9ab0; text-decoration: none; font-weight: 700; font-size: 14px; border-bottom: 2px solid transparent; }
nav a:hover { color: #eef2f8; }
nav a[aria-current="page"] { color: #eef2f8; border-bottom-color: #ffcc33; }
a:focus-visible { outline: 2px solid #ffcc33; outline-offset: -2px; }
.spacer { flex: 1; }
.clock { font-variant-numeric: tabular-nums; font-weight: 800; color: #cdd5e3; white-space: nowrap; }
.clock span { color: #8e9ab0; font-weight: 600; }
@media (max-width: 640px) {
  header { gap: 10px; }
  nav a { padding: 0 9px; }
  .clock span, .clock i { display: none; }
}
@media (max-width: 520px) {
  .clock { display: none; }
  .spacer { display: none; }
  nav { margin-left: auto; }
}
`;

class CrViewerNav extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
    this._timer = setInterval(() => this._tick(), 5000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  static get observedAttributes() { return ["active"]; }
  attributeChangedCallback() { if (this.shadowRoot?.firstChild) this._render(); }

  _render() {
    const active = this.getAttribute("active");
    const saved = lastChannelId();
    const channels = saved ? `channel.html?ch=${encodeURIComponent(saved)}` : "channel.html";
    const tabs = [["guide", "Guide", "index.html"], ["channels", "Channels", channels], ["browse", "Browse", "browse.html"]];
    const base = new URL("../", import.meta.url).href;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      <header>
        <a class="brand" href="${base}index.html"><b>CR</b>VIDEO</a>
        <nav aria-label="Viewer">${tabs.map(([id, label, href]) =>
          `<a href="${base}${href}"${id === active ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>
        <div class="spacer"></div>
        <div class="clock" aria-label="Current time"></div>
      </header>`;
    this._tick();
  }

  _tick() {
    const clock = this.shadowRoot?.querySelector(".clock");
    if (!clock) return;
    const d = new Date(now() * 1000);
    clock.replaceChildren(fmtTime.format(d));
    const date = document.createElement("span");
    date.innerHTML = "&nbsp;<i style='font-style:normal'>·</i>&nbsp;";
    date.append(fmtDate.format(d));
    clock.append(date);
  }
}

if (!customElements.get("cr-viewer-nav")) customElements.define("cr-viewer-nav", CrViewerNav);
