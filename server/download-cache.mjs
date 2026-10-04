#!/usr/bin/env node
// server/download-cache.mjs
//
// Pre-fetches the Drive-hosted video file for the playlist entry that is
// currently airing, plus the one airing next, down to local disk -- so
// sync-player.html can play a same-origin static file instead of every
// viewer's browser streaming straight from the Drive API with an OAuth
// token in the URL. That direct-from-browser pattern is what was tripping
// Google's anti-abuse "automated queries" block; a local copy sidesteps it
// entirely (no cross-site request, no token in the URL, no ORB involved).
//
// Run this on a short interval via cron (see server/README.md) -- it's
// cheap to invoke repeatedly since it only downloads what's missing and
// exits immediately once the two wanted files are present.
//
// One-time setup required before this will work: server/README.md.

import { readFile, writeFile, readdir, stat, rename, unlink, mkdir } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLAYLIST_PATH = path.join(ROOT, "playlist.json");
const CACHE_DIR = path.join(ROOT, "cache");
const MANIFEST_PATH = path.join(CACHE_DIR, "manifest.json");
const KEY_PATH = path.join(__dirname, "service-account.json");

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// -- Same time-of-day math as sync-player.html's recurring-schedule logic --
function secondsSinceMidnight(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 3600 + get("minute") * 60 + get("second");
}

async function loadPlaylist() {
  const raw = JSON.parse(await readFile(PLAYLIST_PATH, "utf8"));
  if (!raw.recurring) {
    throw new Error("download-cache.mjs only supports the recurring playlist format right now.");
  }
  const entries = [...raw.entries].sort((a, b) => a.startSec - b.startSec);
  return { entries, timezone: raw.timezone || "UTC" };
}

function findCurrentAndNext(entries, nowSec) {
  const idx = entries.findIndex((e) => nowSec >= e.startSec && nowSec < e.endSec);
  if (idx === -1) return { current: null, next: entries[0] || null };
  const next = entries[(idx + 1) % entries.length];
  return { current: entries[idx], next };
}

async function authClient() {
  if (!existsSync(KEY_PATH)) {
    throw new Error(
      `Missing ${path.relative(ROOT, KEY_PATH)} -- see server/README.md for the one-time ` +
      `service-account setup (create it, share the Drive folder with it, drop the JSON key here).`
    );
  }
  const auth = new GoogleAuth({ keyFile: KEY_PATH, scopes: [DRIVE_SCOPE] });
  return auth.getClient();
}

async function fileReady(destPath) {
  try {
    const s = await stat(destPath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function cleanupOrphanedPartFiles() {
  // A cron entry wraps this script in `flock -n`, so only one instance ever
  // runs at a time -- any .part file found here is leftover from a run that
  // crashed or got killed mid-download, never one that's actively writing.
  const files = await readdir(CACHE_DIR).catch(() => []);
  for (const f of files) {
    if (!f.endsWith(".mp4.part")) continue;
    log(`Removing orphaned partial download ${f}`);
    await unlink(path.join(CACHE_DIR, f)).catch(() => {});
  }
}

async function downloadFile(client, fileId, destPath) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await client.request({ url, responseType: "stream" });
  const tmpPath = `${destPath}.part`;
  await pipeline(res.data, createWriteStream(tmpPath));
  await rename(tmpPath, destPath);
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  await cleanupOrphanedPartFiles();

  const { entries, timezone } = await loadPlaylist();
  const nowSec = secondsSinceMidnight(new Date(), timezone);
  const { current, next } = findCurrentAndNext(entries, nowSec);
  const wanted = [current, next].filter(Boolean);

  if (!wanted.length) {
    log("Nothing scheduled right now; nothing to do.");
    return;
  }

  const manifest = await readManifest();
  const keepIds = new Set(wanted.map((e) => e.driveFileId));
  let client = null;
  let hadFailure = false;

  for (const entry of wanted) {
    const destPath = path.join(CACHE_DIR, `${entry.driveFileId}.mp4`);
    if (await fileReady(destPath)) {
      manifest[entry.driveFileId] = {
        ready: true,
        path: `cache/${entry.driveFileId}.mp4`,
        title: entry.title,
        updatedAt: manifest[entry.driveFileId]?.updatedAt || new Date().toISOString(),
      };
      continue;
    }
    log(`Downloading "${entry.title}" (${entry.driveFileId})...`);
    try {
      client ||= await authClient();
      await downloadFile(client, entry.driveFileId, destPath);
      manifest[entry.driveFileId] = {
        ready: true,
        path: `cache/${entry.driveFileId}.mp4`,
        title: entry.title,
        updatedAt: new Date().toISOString(),
      };
      log(`Done: "${entry.title}"`);
    } catch (e) {
      log(`FAILED to download "${entry.title}" (${entry.driveFileId}): ${e.message}`);
      manifest[entry.driveFileId] = {
        ready: false,
        title: entry.title,
        error: e.message,
        updatedAt: new Date().toISOString(),
      };
      hadFailure = true;
    }
  }

  // Keep the cache to exactly what's current/next -- evict everything else
  // (manifest entries and the .mp4 files themselves) so disk usage stays
  // bounded to ~2 segments instead of growing toward the full 24h loop.
  for (const id of Object.keys(manifest)) {
    if (!keepIds.has(id)) delete manifest[id];
  }
  const files = await readdir(CACHE_DIR);
  for (const f of files) {
    if (!f.endsWith(".mp4")) continue;
    const id = f.slice(0, -4);
    if (!keepIds.has(id)) {
      log(`Evicting stale cached file ${f}`);
      await unlink(path.join(CACHE_DIR, f)).catch(() => {});
    }
  }

  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  if (hadFailure) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
