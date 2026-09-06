// Thin wrapper around Google Drive: OAuth (via Google Identity Services'
// token-client flow, the recommended approach for browser-only apps with no
// backend) plus a handful of plain fetch() calls against the Drive REST API.
//
// This is the one place in the app that talks to a non-local-standard API;
// everything else in ChannelFlow stays framework/dependency free.
import { GOOGLE_CLIENT_ID } from "./drive-config.js";
import { toast } from "./utils.js";

const SCOPE = "https://www.googleapis.com/auth/drive";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const TOKEN_STORAGE_KEY = "channelflow:drive-token";

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let gisLoadPromise = null;

export const driveEvents = new EventTarget();

function emit(detail) { driveEvents.dispatchEvent(new CustomEvent("change", { detail })); }

// Restore a still-valid token so a page reload doesn't force re-auth mid-session.
(function restoreToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.tokenExpiresAt > Date.now()) {
      accessToken = saved.accessToken;
      tokenExpiresAt = saved.tokenExpiresAt;
    }
  } catch (_) { /* ignore corrupt storage */ }
})();

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load Google Identity Services (offline / blocked?)"));
    document.head.appendChild(s);
  });
  return gisLoadPromise;
}

export const isConfigured = () => !!GOOGLE_CLIENT_ID;
export const isConnected = () => !!accessToken && Date.now() < tokenExpiresAt;
export const getAccessToken = () => accessToken;

export async function connect() {
  if (!isConfigured()) {
    toast('Add your Google Client ID to scheduler/js/drive-config.js first — see GOOGLE_DRIVE_SETUP.md.', "danger");
    throw new Error("Google Drive is not configured");
  }
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { reject(new Error(resp.error)); return; }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (Number(resp.expires_in) - 60) * 1000;
        try {
          sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ accessToken, tokenExpiresAt }));
        } catch (_) { /* ignore */ }
        emit({ connected: true });
        resolve(accessToken);
      },
      error_callback: (err) => reject(new Error(err?.type || "Google sign-in was cancelled")),
    });
    tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
  });
}

export function disconnect() {
  if (accessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
  try { sessionStorage.removeItem(TOKEN_STORAGE_KEY); } catch (_) { /* ignore */ }
  emit({ connected: false });
}

async function api(path, options = {}) {
  if (!isConnected()) throw new Error("Not connected to Google Drive");
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Drive API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

export async function getProfile() {
  if (!isConnected()) return null;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.ok ? res.json() : null;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
export const isFolder = (f) => f.mimeType === FOLDER_MIME;

export function driveTypeFor(mimeType) {
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  if (mimeType?.startsWith("image/")) return "graphic";
  return "graphic";
}

/** List the direct children of a folder ("root" = My Drive). */
export async function listFolder(folderId = "root") {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const fields = encodeURIComponent(
    "files(id,name,mimeType,size,videoMediaMetadata,thumbnailLink,modifiedTime)");
  const res = await api(`files?q=${q}&fields=${fields}&orderBy=folder,name&pageSize=200`);
  const data = await res.json();
  return data.files || [];
}

/** A streamable URL usable directly as a <video>/<audio> src (supports range/seek). */
export function streamUrl(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&access_token=${encodeURIComponent(accessToken)}`;
}

export async function findFileByName(folderId, name) {
  const safeName = name.replace(/'/g, "\\'");
  const q = encodeURIComponent(`'${folderId}' in parents and name = '${safeName}' and trashed = false`);
  const res = await api(`files?q=${q}&fields=files(id,name)`);
  const data = await res.json();
  return data.files?.[0] || null;
}

export async function readJsonFile(fileId) {
  const res = await api(`files/${fileId}?alt=media`);
  return res.json();
}

/** Create-or-update a small JSON file by name inside a folder (multipart upload). */
export async function writeJsonFile(folderId, name, obj) {
  const existing = await findFileByName(folderId, name);
  const boundary = `cf-${Math.random().toString(36).slice(2)}`;
  const metadata = existing ? { name } : { name, parents: [folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj, null, 2)}\r\n--${boundary}--`;
  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
  const res = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
