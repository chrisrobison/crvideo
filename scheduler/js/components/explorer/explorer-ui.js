// explorer-ui.js -- formatters, tiny icons and the shared stylesheet for the
// Explorer components. Presentation only: no data access, no state.

import { baseComponentCSS, escapeHtml } from "../../utils.js";

export const esc = escapeHtml;

// ---------- formatting ----------

export function fmtDuration(sec, { ms = false } = {}) {
  if (!Number.isFinite(sec)) return "—";
  const neg = sec < 0;
  const s = Math.abs(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  const base = h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
  const frac = ms ? `.${String(Math.round((s % 1) * 1000)).padStart(3, "0")}` : "";
  return `${neg ? "-" : ""}${base}${frac}`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const timeSecFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
export const fmtTime = (t, seconds = false) => (Number.isFinite(t) ? (seconds ? timeSecFmt : timeFmt).format(new Date(t * 1000)) : "—");
export const fmtDate = (t) => (Number.isFinite(t) ? dateFmt.format(new Date(t * 1000)) : "—");
export const fmtDay = (t) => (Number.isFinite(t) ? dayFmt.format(new Date(t * 1000)) : "—");
export const fmtDateTime = (t, seconds = false) => `${fmtDay(t)}, ${fmtTime(t, seconds)}`;
export const tzName = () => new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || "local";

const p2 = (n) => String(n).padStart(2, "0");
/** epoch seconds -> value for <input type=date> / <input type=time step=1> in the browser's zone. */
export function toInputs(t) {
  const d = new Date(t * 1000);
  return { date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, time: `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` };
}
/** date + time input values (browser zone) -> epoch seconds, or null if either is unusable. */
export function fromInputs(date, time) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time || "");
  if (!dm || !tm) return null;
  const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]), Number(tm[3] || 0));
  const ms = d.getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const fmtBytes = (b) => (!Number.isFinite(b) ? "—" : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
export const titleCase = (s) => String(s || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ---------- small building blocks ----------

const svg = (body) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const icons = {
  channel: svg('<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19a10 10 0 0 1 0-14"/>'),
  series: svg('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
  episode: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16M16 4v16"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  play: svg('<path d="M7 5l12 7-12 7V5z" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>'),
  voice: svg('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),
  bump: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15l3-4 3 3 2-2 3 3"/>'),
  music: svg('<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="16" r="2"/>'),
  video: svg('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>'),
  link: svg('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>'),
  rewind: svg('<path d="M11 6l-7 6 7 6V6zM20 6l-7 6 7 6V6z"/>'),
  forward: svg('<path d="M13 6l7 6-7 6V6zM4 6l7 6-7 6V6z"/>'),
};

export function thumb(url, label, { cls = "" } = {}) {
  const initial = esc((label || "?").trim().charAt(0).toUpperCase() || "?");
  if (!url) return `<span class="thumb ph ${cls}" aria-hidden="true">${initial}</span>`;
  return `<span class="thumb ${cls}" aria-hidden="true"><img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"><b>${initial}</b></span>`;
}

/** tone: good | warn | bad | info | muted. The label is always real, derived text. */
export const pill = (label, tone = "muted", title = "") => `<span class="pill" data-tone="${tone}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</span>`;

export const EDITORIAL_TONE = { approved: "good", candidate: "warn", rejected: "bad", disabled: "muted" };
export const RIGHTS_LABEL = {
  unverified: "Unverified", creator_permission: "Creator permission", licensed: "Licensed", public_domain: "Public domain", restricted: "Restricted",
};
export const RIGHTS_TONE = { unverified: "warn", creator_permission: "good", licensed: "good", public_domain: "good", restricted: "bad" };

export const notRecorded = `<span class="faint">Not recorded</span>`;
export const kv = (label, value) => `<div class="kv"><span>${esc(label)}</span><b>${value}</b></div>`;
export const section = (title, body, { count = null, id = "" } = {}) => `
  <section class="sec"${id ? ` data-sec="${esc(id)}"` : ""}>
    <h3>${esc(title)}${count !== null ? ` <i>${count}</i>` : ""}</h3>
    ${body}
  </section>`;
export const emptyNote = (text) => `<p class="empty">${esc(text)}</p>`;
export const btn = (act, label, { id = "", primary = false, attrs = "", icon = "" } = {}) =>
  `<button class="${primary ? "primary" : ""}" data-act="${act}"${id !== "" ? ` data-id="${esc(id)}"` : ""} ${attrs}>${icon}${esc(label)}</button>`;

// ---------- stylesheet (shared by cf-explorer's children) ----------

export const explorerCSS = `
  ${baseComponentCSS}
  [hidden]{ display:none !important; }
  :host{ display:block; min-height:0; min-width:0; }
  button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible, a:focus-visible, summary:focus-visible{ outline:2px solid var(--accent); outline-offset:1px; }
  .sr-only{ position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .faint{ color:var(--text-faint); }
  .tnum{ font-variant-numeric:tabular-nums; }
  svg{ width:16px; height:16px; }

  /* thumbnails */
  .thumb{ position:relative; display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; width:56px; height:36px; border-radius:5px; overflow:hidden;
    background:linear-gradient(135deg,var(--panel-3),var(--panel)); color:var(--text-muted); font-weight:800; }
  .thumb img{ position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .thumb b{ font-size:14px; }
  .thumb.sq{ width:40px; height:40px; }
  .thumb.lg{ width:100%; height:auto; aspect-ratio:16/9; border-radius:8px; }

  .pill{ display:inline-flex; align-items:center; gap:4px; padding:1px 7px; border-radius:999px; font-size:10.5px; font-weight:700; letter-spacing:.02em; white-space:nowrap;
    background:var(--panel-3); color:var(--text-muted); border:1px solid transparent; }
  .pill[data-tone="good"]{ background:var(--good-soft); color:#8fe3ac; }
  .pill[data-tone="warn"]{ background:var(--warn-soft); color:#ffd28f; }
  .pill[data-tone="bad"]{ background:var(--live-soft); color:#ff9d9d; }
  .pill[data-tone="info"]{ background:var(--accent-soft); color:#9dc3ff; }
  .pill[data-tone="purple"]{ background:var(--purple-soft); color:#cbb3ff; }

  /* generic inspector building blocks */
  .sec{ border-top:1px solid var(--border-soft); padding:12px 14px; }
  .sec:first-child{ border-top:0; }
  .sec h3{ margin:0 0 8px; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted); }
  .sec h3 i{ font-style:normal; color:var(--text-faint); font-weight:600; margin-left:4px; }
  .empty{ margin:0; padding:6px 0; color:var(--text-muted); font-size:12.5px; }
  .kv{ display:grid; grid-template-columns:118px minmax(0,1fr); gap:8px; padding:3px 0; font-size:12.5px; }
  .kv > span{ color:var(--text-muted); }
  .kv > b{ font-weight:600; min-width:0; overflow-wrap:anywhere; }
  .chips{ display:flex; flex-wrap:wrap; gap:6px; }
  .chip{ display:inline-flex; align-items:center; gap:6px; background:var(--panel-2); border:1px solid var(--border); border-radius:999px; padding:3px 10px; font-size:12px; color:var(--text); cursor:pointer; }
  .chip:hover{ border-color:var(--accent-dim); background:var(--accent-soft); }
  .chip svg{ width:13px; height:13px; color:var(--text-muted); }
  .linkrow{ display:flex; align-items:center; gap:10px; width:100%; text-align:left; background:transparent; border:0; border-bottom:1px solid var(--border-soft); border-radius:0; padding:7px 4px; }
  .linkrow:last-child{ border-bottom:0; }
  .linkrow:hover{ background:var(--panel-2); }
  .linkrow .grow{ flex:1; min-width:0; }
  .linkrow .t{ display:block; font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .linkrow .s{ display:block; font-size:11.5px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .linkrow .r{ font-size:11.5px; color:var(--text-muted); white-space:nowrap; }
  .actions{ display:flex; flex-wrap:wrap; gap:8px; padding:12px 14px; border-top:1px solid var(--border-soft); }
  .actions button{ display:inline-flex; align-items:center; gap:6px; flex:1 1 auto; justify-content:center; }
  .note{ font-size:12px; color:var(--text-muted); background:var(--panel-2); border:1px solid var(--border-soft); border-radius:var(--radius-sm); padding:8px 10px; margin:0; }
  .note.warn{ border-color:rgba(245,165,36,.4); color:#ffd28f; }
  .note.bad{ border-color:rgba(239,68,68,.4); color:#ffb4b4; }
  .tabs{ display:flex; gap:4px; padding:8px 14px 0; border-bottom:1px solid var(--border-soft); overflow-x:auto; }
  .tabs button{ border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:var(--text-muted); padding:6px 10px; font-size:12.5px; white-space:nowrap; }
  .tabs button[aria-selected="true"]{ color:var(--text); border-bottom-color:var(--accent); }
  table.mini{ width:100%; border-collapse:collapse; font-size:12.5px; }
  table.mini th{ text-align:left; font-weight:600; font-size:11px; color:var(--text-muted); padding:4px 6px; border-bottom:1px solid var(--border-soft); }
  table.mini td{ padding:5px 6px; border-bottom:1px solid var(--border-soft); vertical-align:top; overflow-wrap:anywhere; word-break:break-word; }
  table.mini tr:last-child td{ border-bottom:0; }
  table.mini button.cell{ background:transparent; border:0; padding:0; text-align:left; color:var(--accent); cursor:pointer; }
  table.mini button.cell:hover{ text-decoration:underline; }
  pre.script, .script{ margin:0; white-space:pre-wrap; font:13px/1.5 var(--font); background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:var(--radius-sm); padding:10px 12px; }
`;
