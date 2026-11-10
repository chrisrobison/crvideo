// studio-ui.js -- small shared UI pieces for the Bump Studio components:
// a CSS layer on top of utils.js's baseComponentCSS (same tokens, same
// dark theme), inline SVG icons, and a lazily-loading media thumbnail.

import { baseComponentCSS } from "../../utils.js";
import { posterFrame } from "./media-peaks.js";

export const REPO_ROOT = new URL("../../../../", import.meta.url);
/** Repo-root-relative bump path ("media/...") -> absolute URL. */
export const mediaUrl = (path) => new URL(String(path || "").replace(/^\/+/, ""), REPO_ROOT).href;

export const studioCSS = `
  ${baseComponentCSS}
  :host{ --studio-gap:12px; --track-h:30px; }
  [hidden]{ display:none !important; }
  button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible, summary:focus-visible{
    outline:2px solid var(--accent); outline-offset:1px;
  }
  .eyebrow{ font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted); }
  .seg{ display:inline-flex; background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm); padding:2px; gap:2px; }
  .seg button{ border:0; background:transparent; padding:5px 10px; font-size:12px; color:var(--text-muted); border-radius:4px; }
  .seg button[aria-pressed="true"], .seg button[aria-selected="true"]{ background:var(--panel-3); color:var(--text); }
  .icon-btn{ display:inline-flex; align-items:center; justify-content:center; gap:6px; }
  .icon-btn svg{ width:16px; height:16px; }
  button.toggle[aria-pressed="true"]{ background:var(--accent-soft); border-color:var(--accent-dim); color:#cfe0ff; }
  .field-row{ display:grid; grid-template-columns: 92px minmax(0,1fr); align-items:center; gap:8px; margin-bottom:10px; }
  .field-row > label, .field-row > .lbl{ font-size:12px; color:var(--text-muted); }
  .field-row input[type="range"]{ padding:0; accent-color:var(--accent); }
  .inline{ display:flex; align-items:center; gap:8px; }
  .num{ width:76px !important; font-variant-numeric:tabular-nums; }
  .tnum{ font-variant-numeric:tabular-nums; }
  .small{ font-size:12px; }
  .faint{ color:var(--text-faint); }
  .empty-state{ padding:18px 12px; text-align:center; color:var(--text-muted); font-size:13px; }
  .empty-state p{ margin:0 0 10px; }
  details.adv{ border-top:1px solid var(--border-soft); margin-top:12px; padding-top:8px; }
  details.adv > summary{ cursor:pointer; font-size:12px; color:var(--text-muted); list-style:none; padding:4px 0; }
  details.adv > summary::before{ content:"▸ "; }
  details.adv[open] > summary::before{ content:"▾ "; }
  details.adv > summary::-webkit-details-marker{ display:none; }
  .card{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px; }
  .card + .card{ margin-top:8px; }
  .search{ position:relative; }
  .search input{ padding-left:30px; }
  .search svg{ position:absolute; left:9px; top:50%; transform:translateY(-50%); width:14px; height:14px; color:var(--text-faint); pointer-events:none; }
  .thumb{ position:relative; background:#05070b; overflow:hidden; border-radius:4px; }
  .thumb video, .thumb img{ width:100%; height:100%; object-fit:cover; display:block; }
  .thumb img:not([src]){ visibility:hidden; }
  .sr-only{ position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
`;

const svg = (body, vb = "0 0 24 24") => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  play: svg(`<path d="M7 5l12 7-12 7V5z" fill="currentColor" stroke="none"/>`),
  pause: svg(`<rect x="6" y="5" width="4" height="14" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" fill="currentColor" stroke="none"/>`),
  stop: svg(`<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>`),
  volume: svg(`<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>`),
  mute: svg(`<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/>`),
  loop: svg(`<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>`),
  fullscreen: svg(`<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>`),
  search: svg(`<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>`),
  plus: svg(`<path d="M12 5v14M5 12h14"/>`),
  more: svg(`<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>`),
  mic: svg(`<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>`),
  music: svg(`<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>`),
  image: svg(`<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>`),
  film: svg(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>`),
  text: svg(`<path d="M5 6V4h14v2M12 4v16M9 20h6"/>`),
  sliders: svg(`<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>`),
  x: svg(`<path d="M6 6l12 12M18 6L6 18"/>`),
  edit: svg(`<path d="M4 20h4L19 9l-4-4L4 16v4z"/>`),
  fit: svg(`<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>`),
  zoomIn: svg(`<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M8 11h6M11 8v6"/>`),
  zoomOut: svg(`<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M8 11h6"/>`),
  calendar: svg(`<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`),
  layers: svg(`<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>`),
  save: svg(`<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>`),
  trash: svg(`<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/>`),
  check: svg(`<path d="M5 12l5 5 9-10"/>`),
  swatch: svg(`<circle cx="12" cy="12" r="8"/>`),
};

let observer = null;
/** A lazily-loading media thumbnail: an <img> of a captured frame for video
 *  (media-peaks.js posterFrame), requested once scrolled into view, with
 *  hover-to-play of the real video when `hoverPlay`. Dispatches
 *  "thumb-duration" (detail: seconds) once a video's length is known. */
export function makeThumb(type, path, { hoverPlay = true } = {}) {
  const box = document.createElement("div");
  box.className = "thumb";
  if (!path) return box;
  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  box.append(img);
  if (type === "image") {
    img.loading = "lazy";
    img.src = mediaUrl(path);
    return box;
  }
  box.dataset.path = path;
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      observer.unobserve(el);
      posterFrame(el.dataset.path).then(({ url, duration }) => {
        el.querySelector("img").src = url;
        el.dispatchEvent(new CustomEvent("thumb-duration", { detail: duration }));
      }).catch(() => {});
    }
  }, { rootMargin: "120px" });
  observer.observe(box);
  if (hoverPlay) {
    let v = null;
    box.addEventListener("mouseenter", () => {
      if (!v) {
        v = Object.assign(document.createElement("video"), { muted: true, playsInline: true, loop: true, preload: "auto" });
        v.style.cssText = "position:absolute;inset:0";
        v.src = mediaUrl(path);
        box.append(v);
      }
      v.hidden = false;
      v.play().catch(() => {});
    });
    box.addEventListener("mouseleave", () => { if (v) { v.pause(); v.hidden = true; } });
  }
  return box;
}

/** Collapses rapid calls into one per animation frame. */
export function rafThrottle(fn) {
  let pending = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; fn(...lastArgs); });
  };
}
