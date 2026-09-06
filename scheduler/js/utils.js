// Shared helpers used across the ChannelFlow web components.
// Pure vanilla JS / web platform APIs only — no build step, no dependencies.

let uidCounter = 0;
export function uid(prefix = "id") {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter.toString(36)}`;
}

export const pad2 = (n) => String(Math.trunc(n)).padStart(2, "0");
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export const DAY_SECONDS = 86400;

/** Seconds-from-midnight -> "HH:MM" or "HH:MM:SS" */
export function secToClock(totalSec, withSeconds = false) {
  totalSec = ((Math.round(totalSec) % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return withSeconds ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(h)}:${pad2(m)}`;
}

/** Duration in seconds -> "23h 42m" style */
export function fmtHoursMinutes(totalSec) {
  totalSec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${pad2(m)}m`;
}

/** Duration in seconds -> "HH:MM:SS" */
export function fmtHMS(totalSec) {
  totalSec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

export function parseHMSToSec(str) {
  const parts = String(str).trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

/** <input type="time" step="1"> uses "HH:MM:SS" local value strings */
export const secToTimeValue = (sec) => secToClock(sec, true);
export const timeValueToSec = (val) => parseHMSToSec(val);

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[c]));
}

export function dateKey(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function keyToDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export function dateLabel(key) {
  const d = keyToDate(key);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export function dateLabelFull(key) {
  const d = keyToDate(key);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Current UTC "seconds since midnight" — the channel operates on UTC. */
export function nowUTCSeconds() {
  const d = new Date();
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
}
export function todayKey() {
  return dateKey(new Date());
}

/** Merge sorted [start,end) intervals; returns {covered, gaps:[[s,e]...]} within [0,DAY_SECONDS]. */
export function unionCoverage(intervals, dayEnd = DAY_SECONDS) {
  const sorted = intervals
    .map(([s, e]) => [clamp(s, 0, dayEnd), clamp(e, 0, dayEnd)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  let covered = 0;
  const gaps = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push([cursor, s]);
    covered += e - s;
    cursor = e;
  }
  if (cursor < dayEnd) gaps.push([cursor, dayEnd]);
  return { covered, gaps, merged };
}

/** Count raw pairwise overlaps in a (possibly unsorted) block list with .start/.end. */
export function countOverlaps(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  let conflicts = 0;
  const conflictIds = new Set();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      conflicts += 1;
      conflictIds.add(sorted[i].id);
      conflictIds.add(sorted[i - 1].id);
    }
  }
  return { conflicts, conflictIds };
}

export function typeTone(type) {
  switch (type) {
    case "live": return "live";
    case "graphic": return "graphic";
    case "audio": return "audio";
    default: return "video";
  }
}

/** Toast host — lazily created, appended once to <body>. */
export function toast(message, tone = "info", timeout = 3600) {
  let root = document.getElementById("toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "toast-root";
    document.body.appendChild(root);
  }
  const el = document.createElement("div");
  el.className = "cf-toast";
  el.dataset.tone = tone;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 260);
  }, timeout);
}

/** Shared baseline CSS injected into every shadow root for a consistent look. */
export const baseComponentCSS = `
  :host{ font: 14px/1.45 var(--font); color: var(--text); }
  *{ box-sizing: border-box; }
  button, input, select, textarea{ font: inherit; color: inherit; }
  button{
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 7px 12px; cursor: pointer;
  }
  button:hover{ border-color:#48536a; }
  button:active{ transform: translateY(1px); }
  button:disabled{ opacity:.5; cursor:not-allowed; }
  button.primary{ background: var(--accent); border-color: var(--accent); font-weight:600; color:#fff; }
  button.primary:hover{ background:#4c8cf5; }
  button.ghost{ background: transparent; }
  button.danger{ border-color: var(--live); color:#ffb4b4; }
  button.icon-btn{ padding:6px 8px; line-height:1; }
  input, select, textarea{
    background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-sm); padding: 8px 10px; width:100%;
  }
  input:focus, select:focus, textarea:focus{ outline:none; border-color: var(--accent); }
  label.field{ display:block; font-size:11px; text-transform:uppercase; letter-spacing:.05em;
    color: var(--text-muted); margin-bottom:14px; }
  label.field > .field-value{ margin-top:6px; }
  .badge{
    display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px;
    font-size:11px; font-weight:700; letter-spacing:.03em; text-transform:uppercase;
    background: var(--panel-3); color: var(--text-muted); white-space:nowrap;
  }
  .badge[data-tone="live"]{ background: var(--live-soft); color:#ff9d9d; }
  .badge[data-tone="video"]{ background: var(--accent-soft); color:#9dc3ff; }
  .badge[data-tone="graphic"]{ background: var(--good-soft); color:#8fe3ac; }
  .badge[data-tone="audio"]{ background: var(--purple-soft); color:#cbb3ff; }
  .badge[data-tone="warn"]{ background: var(--warn-soft); color:#ffd28f; }
  .muted{ color: var(--text-muted); }
  .row{ display:flex; align-items:center; }
  .spacer{ flex:1 1 auto; }
  .hidden{ display:none !important; }
  svg{ display:block; flex-shrink:0; }
`;
