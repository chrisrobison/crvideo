// bump-model.js -- pure helpers for Bump Studio drafts (no DOM, no fetch).
//
// A "draft" is exactly the editable subset of a bump definition
// (bumps/README.md): name, description, optional duration, background,
// audio, announcement, upcoming, style. Never id/schema_version/
// timestamps -- the server owns those (schema_version is derived from
// whether `duration` is present, see server/bump-admin.php).

import {
  DEFAULT_BUMP_DURATION, bumpDuration, effectiveDuration, bumpTiming, scheduleFit,
} from "../../../../channels/bump-player.js";

export { DEFAULT_BUMP_DURATION, bumpDuration, effectiveDuration, bumpTiming, scheduleFit };

export const MAX_AUDIO_LAYERS = 2; // server/bump-admin.php BUMP_ADMIN_MAX_AUDIO_LAYERS
export const MAX_UPCOMING = 6;
export const MIN_DURATION = 1;
export const MAX_DURATION = 300; // server/bump-admin.php BUMP_ADMIN_MAX_DURATION
export const MIN_TEXT_SPAN = 0.5;
export const STYLE_KEYS = ["accent", "accentWarm", "bg", "bg2", "fg", "muted"];
export const STYLE_DEFAULTS = { accent: "#4dd8e6", accentWarm: "#ffb454", bg: "#0a0d14", bg2: "#141a26", fg: "#f4f6fb", muted: "#9aa5b8" }; // <cr-bump>'s own :host defaults

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const round = (n, step = 0.1) => Math.round(n / step) * step;
export const roundTime = (n) => Math.round(n * 10) / 10;

export function emptyDraft() {
  return {
    name: "Untitled bump",
    description: "",
    background: { type: "color", color: "#14213d" },
    audio: [],
    announcement: null,
    upcoming: { count: 3, label: "Coming Up" },
    style: {},
  };
}

/** Editable draft from a saved bump (as returned by the list API). */
export function draftFromBump(bump) {
  const d = {
    name: bump?.name || "",
    description: bump?.description || "",
    background: clone(bump?.background) || { type: "color", color: "#14213d" },
    audio: Array.isArray(bump?.audio) ? clone(bump.audio) : [],
    announcement: bump?.announcement ? clone(bump.announcement) : null,
    upcoming: clone(bump?.upcoming) || { count: 3, label: "Coming Up" },
    style: bump?.style && typeof bump.style === "object" && !Array.isArray(bump.style) ? clone(bump.style) : {},
  };
  const duration = bumpDuration(bump);
  if (duration) d.duration = duration;
  return d;
}

/** The exact object sent to create/update -- also the basis for dirty
 *  checks, so two drafts that would save identically compare equal. */
export function toPayload(draft) {
  const d = clone(draft) || emptyDraft();
  const out = {
    name: String(d.name || "").trim(),
    description: d.description || "",
    background: d.background,
    audio: (d.audio || []).filter((l) => l && l.url).map((l) => ({ source: l.source || "custom", url: l.url, volume: Number(l.volume ?? 0.6) })),
    announcement: d.announcement?.url ? d.announcement : null,
    upcoming: { count: Number(d.upcoming?.count ?? 3), label: d.upcoming?.label ?? "Coming Up" },
    style: {},
  };
  const duration = bumpDuration(d);
  if (duration) {
    out.duration = duration;
    if (Number.isFinite(d.upcoming?.start)) out.upcoming.start = d.upcoming.start;
    if (Number.isFinite(d.upcoming?.end)) out.upcoming.end = d.upcoming.end;
  } else if (out.announcement) {
    delete out.announcement.start;
  }
  if (out.announcement) {
    out.announcement = { ...out.announcement, duckTo: Number(out.announcement.duckTo ?? 0.3) };
    if (!Number.isFinite(out.announcement.start)) delete out.announcement.start;
  }
  if (out.background?.type === "color") out.background = { type: "color", color: out.background.color || "#14213d" };
  else if (out.background) out.background = { type: out.background.type, url: out.background.url || "" };
  for (const k of STYLE_KEYS) if (d.style?.[k]) out.style[k] = d.style[k];
  return out;
}

export function draftsEqual(a, b) {
  return JSON.stringify(toPayload(a)) === JSON.stringify(toPayload(b));
}

/** Client-side check mirroring the server's most common rejections, so the
 *  editor can explain before a round trip. Returns an error string or null. */
export function validateDraft(draft) {
  if (!String(draft?.name || "").trim()) return "Give the bump a name.";
  const bg = draft.background;
  if ((bg?.type === "video" || bg?.type === "image") && !bg.url) return `Pick a background ${bg.type} (or switch to a solid color).`;
  if ((draft.audio || []).length > MAX_AUDIO_LAYERS) return `At most ${MAX_AUDIO_LAYERS} music layers.`;
  return null;
}

/** Makes a draft's timing self-consistent after any edit (clamps into the
 *  composition, keeps text end > start). Mutates and returns `draft`. */
export function clampTiming(draft) {
  const dur = bumpDuration(draft);
  if (!dur) {
    if (draft.upcoming) { delete draft.upcoming.start; delete draft.upcoming.end; }
    if (draft.announcement) delete draft.announcement.start;
    return draft;
  }
  draft.duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, roundTime(dur)));
  const D = draft.duration;
  if (draft.announcement && Number.isFinite(draft.announcement.start)) {
    draft.announcement.start = roundTime(Math.min(Math.max(0, draft.announcement.start), Math.max(0, D - 0.1)));
  }
  const up = draft.upcoming || (draft.upcoming = { count: 3, label: "Coming Up" });
  if (Number.isFinite(up.start) || Number.isFinite(up.end)) {
    let s = Number.isFinite(up.start) ? up.start : 0;
    let e = Number.isFinite(up.end) ? up.end : D;
    s = Math.min(Math.max(0, s), Math.max(0, D - MIN_TEXT_SPAN));
    e = Math.min(Math.max(e, s + MIN_TEXT_SPAN), D);
    up.start = roundTime(s);
    up.end = roundTime(e);
    if (up.start === 0 && up.end === D) { delete up.start; delete up.end; } // full length == the default; keep the JSON minimal
  }
  return draft;
}

/** Opting a v1 draft into timing: pins the editor default as an explicit
 *  duration (the draft then saves as schema_version 2). */
export function ensureDuration(draft) {
  if (!bumpDuration(draft)) draft.duration = DEFAULT_BUMP_DURATION;
  return draft;
}

/** "media/music/bg-music04.mp3" -> "bg-music04" */
export function fileLabel(url) {
  const base = String(url || "").split("/").pop() || "";
  return base.replace(/\.[a-z0-9]+$/i, "") || "—";
}

export function audioSourceFor(media, url) {
  if (media?.music?.some((f) => f.url === url)) return "music";
  if (media?.ambience?.some((f) => f.url === url)) return "ambience";
  return "custom";
}

/** Finds the media-listing entry for a bump's announcement (for labels). */
export function findAnnouncement(media, ann) {
  if (!ann?.url) return null;
  const want = String(ann.url).replace(/^\/+/, "");
  for (const ch of media?.channels || []) {
    for (const a of ch.announcements || []) {
      if (String(a.url || "").replace(/^\/+/, "") === want) return { channel: ch, clip: a };
    }
  }
  const ch = (media?.channels || []).find((c) => c.id === ann.channelId) || null;
  return ch ? { channel: ch, clip: null } : null;
}

export function announcementTypeLabel(type) {
  return String(type || "announcement").replace(/_/g, " ");
}

/** Channels whose saved bump-schedule.json references `bumpId`. */
export function referencesTo(schedules, bumpId) {
  return (schedules || [])
    .map((c) => ({ id: c.id, name: c.name, enabled: !!c.enabled, rules: (c.rules || []).filter((r) => r.bumpId === bumpId) }))
    .filter((c) => c.rules.length);
}

export function uniqueName(base, bumps) {
  const names = new Set((bumps || []).map((b) => String(b.name || "").toLowerCase()));
  let name = `${base} copy`;
  let n = 2;
  while (names.has(name.toLowerCase())) name = `${base} copy ${n++}`;
  return name;
}

/** "00:04.2" style label for composition times. */
export function fmtTime(t, { tenths = false } = {}) {
  const v = Math.max(0, Number(t) || 0);
  const m = Math.floor(v / 60);
  const s = tenths ? (v % 60).toFixed(1).padStart(4, "0") : String(Math.floor(v % 60)).padStart(2, "0");
  return `${String(m).padStart(2, "0")}:${s}`;
}

export { round };
