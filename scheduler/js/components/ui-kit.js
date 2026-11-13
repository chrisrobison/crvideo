// Shared building blocks for the ChannelFlow revamp screens (Series Review,
// Programming grid, Broadcast Schedule): inline icons, a page-header/panel/
// tab/chip CSS kit that every one of those shadow roots includes, and the
// per-series swatch picker. Plain strings -- no framework, same as the rest
// of the scheduler.

import { escapeHtml } from "../utils.js";

const P = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  calendarPlay: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="m10.5 13.5 3.5 2-3.5 2z" fill="currentColor"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  clapper: '<path d="M4 9h16v11H4zM4 9l2.5-5 4 1.2M9 5.2 13 6.4M13.5 6.4l4-1.2L20 9"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/>',
  cloudUp: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 10a4 4 0 0 1-.5 8H7z"/><path d="m9.5 13 2.5-2.5 2.5 2.5M12 10.5V17"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  megaphone: '<path d="M4 10v4a1 1 0 0 0 1 1h2l8 4V5L7 9H5a1 1 0 0 0-1 1z"/><path d="M18.5 9a4 4 0 0 1 0 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 9a4 4 0 0 1 0 6"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.01"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  drive: '<path d="m8 3 8 0 6 10-4 7H6l-4-7z"/><path d="m8 3 6 10H2M16 3l-6 10 4 7"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17v.01"/>',
};

/** An inline 24px-grid stroke icon. `size` is the rendered px size. */
export function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Stable swatch index 0..7 for a series id, so a show is the same colour everywhere. */
export function swatchIndex(key) {
  return hash(String(key || "")) % 8;
}

/** Inline style that paints an element with a series' swatch. */
export function swatchStyle(key) {
  const n = swatchIndex(key);
  return `background:var(--sw-${n}-bg);border-color:var(--sw-${n}-bd);color:var(--sw-${n}-fg)`;
}

/** Thumbnail URL for a catalog/schedule episode id like `yt-<videoId>`, if derivable. */
export function episodeThumb(ep) {
  if (!ep) return "";
  if (ep.thumbnail_url) return ep.thumbnail_url;
  const id = String(ep.video_id || ep.source?.video_id || (String(ep.id || "").startsWith("yt-") ? String(ep.id).slice(3) : ""));
  return id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg` : "";
}

/** A rounded thumbnail <img>, or a neutral placeholder when there is no URL. */
export function thumbHtml(url, cls = "thumb") {
  return url
    ? `<img class="${cls}" src="${escapeHtml(url)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : `<div class="${cls} ph"></div>`;
}

/** First letters of the words of a title, for an avatar fallback. */
export function initials(text) {
  return String(text || "?").split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}

/**
 * CSS shared by the three revamp screens. Each component includes it right
 * after `baseComponentCSS`. Layout contract: the host fills its container
 * (`:host{display:flex;flex-direction:column;height:100%}`), a `.page-head`
 * sits on top and a `.workspace` grid of `.panel`s below scrolls its columns
 * independently.
 */
export const uiKitCSS = `
  :host{ display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; }
  svg{ display:block; flex-shrink:0; }
  .page-head{ display:flex; align-items:center; gap:14px; padding:14px 22px 12px; }
  .page-head .head-ico{ width:40px; height:40px; display:grid; place-items:center; color:var(--text); opacity:.9; }
  .page-head h1{ margin:0; font-size:22px; line-height:1.15; font-weight:750; letter-spacing:-.01em; }
  .page-head p{ margin:2px 0 0; color:var(--text-muted); font-size:13px; }
  .page-head .spacer{ flex:1; }
  .workspace{ flex:1; min-height:0; display:grid; gap:14px; padding:0 14px 14px; }
  .panel{ background:linear-gradient(180deg, rgba(24,30,59,.72), rgba(18,23,48,.82)); border:1px solid var(--border);
    border-radius:var(--radius); min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden;
    box-shadow:0 10px 30px rgba(3,5,14,.35); }
  .panel-head{ display:flex; align-items:center; gap:10px; padding:14px 16px; flex-shrink:0; }
  .panel-head h2{ margin:0; font-size:15px; font-weight:700; display:flex; align-items:center; gap:9px; }
  .panel-head h2 .count{ color:var(--text-muted); font-weight:600; }
  .panel-body{ flex:1; min-height:0; overflow:auto; }
  .panel-foot{ flex-shrink:0; padding:10px 14px; border-top:1px solid var(--border-soft); display:flex; align-items:center; gap:10px; }

  /* Buttons (extends baseComponentCSS) */
  button{ display:inline-flex; align-items:center; justify-content:center; gap:7px; border-radius:9px; padding:8px 14px; font-weight:600; font-size:13px; }
  button.primary{ box-shadow:0 4px 14px rgba(109,93,252,.35); }
  button.sm{ padding:5px 10px; font-size:12px; border-radius:8px; }
  button.icon{ padding:7px; width:34px; height:34px; border-radius:9px; background:var(--panel-2); }
  button.outline{ background:transparent; border-color:#3a4373; }
  button.good{ background:rgba(34,197,94,.14); border-color:rgba(34,197,94,.5); color:#9af0b8; }
  button.bad{ background:rgba(239,68,68,.12); border-color:rgba(239,68,68,.45); color:#ffb4b4; }

  /* Pills / chips */
  .pill{ display:inline-flex; align-items:center; gap:5px; padding:3px 11px; border-radius:999px; font-size:12px; font-weight:650;
    border:1px solid var(--border); background:var(--panel-2); color:var(--text-muted); white-space:nowrap; }
  .pill[data-tone="candidate"],.pill[data-tone="warn"]{ background:rgba(224,149,58,.14); border-color:rgba(224,149,58,.6); color:#f6c27d; }
  .pill[data-tone="approved"],.pill[data-tone="good"]{ background:rgba(34,197,94,.13); border-color:rgba(34,197,94,.55); color:#8fe3ac; }
  .pill[data-tone="rejected"],.pill[data-tone="bad"]{ background:rgba(239,68,68,.13); border-color:rgba(239,68,68,.55); color:#ffa6a6; }
  .pill[data-tone="disabled"],.pill[data-tone="neutral"]{ background:rgba(120,130,170,.14); border-color:rgba(120,130,170,.4); color:#b7bfdc; }
  .pill[data-tone="accent"]{ background:var(--accent-soft); border-color:var(--accent-line); color:#cfc8ff; }
  .chip-row{ display:flex; gap:7px; flex-wrap:wrap; }
  .chip{ padding:5px 13px; border-radius:999px; font-size:12.5px; font-weight:600; background:transparent; color:var(--text-muted); border:1px solid var(--border); }
  .chip:hover{ color:var(--text); border-color:#4a5486; }
  .chip.on{ background:var(--accent); border-color:var(--accent); color:#fff; box-shadow:0 3px 10px rgba(109,93,252,.35); }
  .chip .n{ opacity:.8; margin-left:4px; }

  /* Tabs */
  .tabs{ display:flex; gap:4px; }
  .tabs.pill-tabs{ background:rgba(10,13,28,.6); border:1px solid var(--border); border-radius:11px; padding:4px; }
  .tabs.pill-tabs button{ flex:1; background:transparent; border:1px solid transparent; color:var(--text-muted); padding:7px 12px; }
  .tabs.pill-tabs button.on{ background:var(--accent); color:#fff; box-shadow:0 3px 10px rgba(109,93,252,.4); }
  .tabs.line-tabs{ border-bottom:1px solid var(--border-soft); padding:0 12px; }
  .tabs.line-tabs button{ background:transparent; border:0; border-bottom:2px solid transparent; border-radius:0; color:var(--text-muted); padding:11px 14px; }
  .tabs.line-tabs button.on{ color:var(--text); border-bottom-color:var(--accent-hi); background:linear-gradient(180deg, transparent, rgba(109,93,252,.14)); }
  .seg{ display:inline-flex; background:rgba(10,13,28,.6); border:1px solid var(--border); border-radius:10px; padding:3px; }
  .seg button{ background:transparent; border:0; color:var(--text-muted); padding:6px 16px; border-radius:8px; }
  .seg button.on{ background:var(--accent); color:#fff; }

  /* Search / selects */
  .search{ position:relative; display:flex; align-items:center; }
  .search svg{ position:absolute; left:11px; color:var(--text-muted); pointer-events:none; }
  .search input{ padding-left:36px; border-radius:10px; background:rgba(10,13,28,.6); }
  select{ border-radius:9px; background:rgba(10,13,28,.6); appearance:none; padding-right:28px;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239099b8' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat:no-repeat; background-position:right 10px center; }
  input[type=checkbox]{ width:16px; height:16px; padding:0; accent-color:var(--accent); flex-shrink:0; }
  input[type=date], input[type=time]{ color-scheme:dark; }

  .thumb{ object-fit:cover; background:var(--panel-3); border-radius:7px; flex-shrink:0; }
  .thumb.ph{ background:linear-gradient(135deg,#1b2347,#2a2f5c); }
  .empty{ padding:40px 20px; text-align:center; color:var(--text-muted); }
  .error{ color:#ffb4b4; padding:12px 16px; background:var(--live-soft); border-radius:var(--radius-sm); margin:12px; }
  .link{ color:#8fb4ff; text-decoration:underline; text-underline-offset:2px; cursor:pointer; background:none; border:0; padding:0; font:inherit; }
  a{ color:#8fb4ff; }

  /* Key/value details table */
  .kv{ display:grid; grid-template-columns:auto 1fr; font-size:13px; }
  .kv > div{ padding:9px 4px; border-bottom:1px solid var(--border-soft); }
  .kv svg{ display:inline-block; vertical-align:-2px; }
  .kv > div:nth-child(odd){ color:var(--text-muted); padding-right:18px; white-space:nowrap; }
  .kv > div:nth-child(even){ color:var(--text); min-width:0; overflow-wrap:anywhere; }

  /* Dialog */
  dialog{ background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:14px; padding:0;
    box-shadow:0 24px 70px rgba(0,0,0,.6); width:min(720px, 94vw); max-height:88vh; }
  dialog::backdrop{ background:rgba(4,6,16,.66); backdrop-filter:blur(2px); }
  .dlg-head{ display:flex; align-items:center; gap:10px; padding:16px 20px; border-bottom:1px solid var(--border-soft); }
  .dlg-head h2{ margin:0; font-size:16px; flex:1; }
  .dlg-body{ padding:18px 20px; overflow:auto; max-height:calc(88vh - 70px); }
  pre.output{ background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm);
    padding:10px; font:11px/1.5 var(--mono); white-space:pre-wrap; word-break:break-word; max-height:300px; overflow:auto; margin:10px 0 0; }
  .menu{ position:relative; }
  .menu > .menu-pop{ position:absolute; right:0; top:calc(100% + 6px); min-width:210px; background:var(--panel); border:1px solid var(--border);
    border-radius:11px; padding:6px; box-shadow:0 14px 34px rgba(0,0,0,.55); z-index:40; display:none; }
  .menu.open > .menu-pop{ display:block; }
  .menu-pop button{ display:flex; width:100%; justify-content:flex-start; background:transparent; border:0; padding:8px 10px; font-weight:500; }
  .menu-pop button:hover{ background:var(--panel-3); }
  .menu-pop hr{ border:0; border-top:1px solid var(--border-soft); margin:5px 0; }

  @media (max-width:1100px){
    :host{ height:auto; }
    .workspace{ grid-template-columns:1fr !important; }
    .panel{ max-height:none; }
  }
`;

/** Wire `.menu` popovers inside `root`: click the first child to toggle, click elsewhere to close. */
export function wireMenus(root, signal) {
  root.querySelectorAll(".menu").forEach((m) => {
    m.firstElementChild.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !m.classList.contains("open");
      root.querySelectorAll(".menu.open").forEach((o) => o.classList.remove("open"));
      m.classList.toggle("open", open);
    });
  });
  document.addEventListener("click", () => root.querySelectorAll(".menu.open").forEach((o) => o.classList.remove("open")), { signal });
}
