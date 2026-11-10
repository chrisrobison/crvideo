// inspector-common.js -- tiny DOM helpers shared by the inspector sections.

import { icons } from "./studio-ui.js";

/** Parses an HTML string into a single element (or a fragment for several). */
export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.childElementCount === 1 ? t.content.firstElementChild : t.content;
}

/** Sets a form control's value unless the user is currently in it. */
export function setValue(el, value) {
  if (!el) return;
  const root = el.getRootNode();
  if (root.activeElement === el) return;
  if (el.type === "checkbox") el.checked = !!value;
  else if (String(el.value) !== String(value ?? "")) el.value = value ?? "";
}

export function searchBoxHtml(placeholder, cls = "q") {
  return `<label class="search"><span class="sr-only">${placeholder}</span>${icons.search}<input type="search" class="${cls}" placeholder="${placeholder}"></label>`;
}

export const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

/** Shared CSS for picker lists used by the music/voice sections. */
export const pickerCSS = `
  .pick{ list-style:none; margin:8px 0 0; padding:0; max-height:240px; overflow:auto; border:1px solid var(--border-soft); border-radius:var(--radius-sm); }
  .pick li{ display:flex; align-items:center; gap:8px; padding:7px 9px; cursor:pointer; font-size:12px; border-bottom:1px solid var(--border-soft); }
  .pick li:last-child{ border-bottom:0; }
  .pick li:hover, .pick li:focus-visible{ background:var(--panel-2); outline:none; }
  .pick li[aria-selected="true"]{ background:var(--accent-soft); }
  .pick .grp{ cursor:default; background:var(--bg-elevated); font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--text-faint); padding:5px 9px; }
  .pick .grp:hover{ background:var(--bg-elevated); }
  .pick .main{ flex:1; min-width:0; }
  .pick .t{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pick .sub{ font-size:11px; color:var(--text-muted); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .aud{ padding:4px 6px; border:0; background:transparent; color:var(--text-muted); }
  .aud svg{ width:14px; height:14px; }
  .aud[aria-pressed="true"]{ color:var(--accent); }
  .sec-h{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin:0 0 10px; }
  .sec-h h3{ margin:0; font-size:13px; }
`;
