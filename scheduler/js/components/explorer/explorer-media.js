// explorer-media.js -- the one-preview-at-a-time media lifecycle for
// Explorer. Previews are strictly read-only: they play through the
// project's own adapters / <cr-bump> / <audio> inside the Inspector, never
// touch a live channel, never write a schedule, and never download or proxy
// third-party media (YouTube plays only inside YouTube's own iframe).
//
// Only ONE preview exists at a time: starting another (or navigating away,
// or the Inspector re-rendering a different entity) stops the previous one.

import { YouTubePlayerAdapter, ContinuityRenderer } from "../../../../channels/player-adapters.js";
import "../../../../channels/bump-player.js"; // registers <cr-bump> -- the existing bump renderer, no second one

let current = null; // {stop(), key}

export function stopPreview() {
  const c = current;
  current = null;
  try { c?.stop(); } catch { /* a dying preview must never break navigation */ }
}
export const activePreviewKey = () => current?.key ?? null;

function claim(key, stop) {
  stopPreview();
  current = { key, stop };
}

/** A clock that reads `t0` at call time and advances in real time -- how a preview "inspects" an instant without moving any real clock. */
export function virtualClock(t0) {
  const base = performance.now();
  return () => t0 + (performance.now() - base) / 1000;
}

/**
 * Play a published video occurrence (or an episode) in `host`.
 * @param {{provider:string|null, videoId?:string|null, mediaUrl?:string|null}} source
 * @returns {Promise<{ok:boolean, message?:string}>}
 */
export async function previewVideo(host, key, source, offset = 0, { onState } = {}) {
  host.innerHTML = "";
  const box = document.createElement("div");
  box.className = "player-box";
  host.appendChild(box);
  if (source.provider === "youtube" && source.videoId) {
    const adapter = new YouTubePlayerAdapter(box, {
      onStateChange: (s) => onState?.(s),
      onError: (e) => onState?.("error", e.message),
    });
    claim(key, () => { adapter.destroy(); host.innerHTML = ""; });
    adapter.setMuted(false); // we are inside a user gesture (the click that started this)
    await adapter.load(source.videoId, offset);
    return { ok: true, adapter };
  }
  if (source.provider === "html5" && source.mediaUrl) {
    // A directly hosted file: a plain native <video> with its own controls.
    const video = document.createElement("video");
    video.controls = true; video.playsInline = true; video.preload = "metadata";
    video.src = source.mediaUrl;
    video.addEventListener("loadedmetadata", () => { if (offset > 0 && offset < video.duration) video.currentTime = offset; video.play().catch(() => {}); }, { once: true });
    box.appendChild(video);
    claim(key, () => { video.pause(); video.removeAttribute("src"); video.load(); host.innerHTML = ""; });
    return { ok: true };
  }
  return { ok: false, message: "This item has no playable source Explorer can preview." };
}

/** Render a bump with the existing <cr-bump>, optionally from a time offset. `upcoming` must be REAL schedule entries. */
export function previewBump(host, key, { definition, upcoming = [], channel = null, offset = 0, clockNow, muted = false, loop = false }) {
  host.innerHTML = "";
  const el = document.createElement("cr-bump");
  el.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
  host.appendChild(el);
  el.clockNow = clockNow || (() => Date.now() / 1000);
  el.channel = channel;
  el.definition = definition;
  el.upcoming = upcoming;
  el.endBehavior = loop ? "loop" : "stop";
  claim(key, () => { el.stop?.(); host.innerHTML = ""; });
  el.play({ muted, offset: Math.max(0, offset) });
  return el;
}

/** Play an <audio> source; the returned element carries native controls. */
export function previewAudio(host, key, url) {
  host.innerHTML = "";
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  audio.src = url;
  audio.style.width = "100%";
  host.appendChild(audio);
  claim(key, () => { audio.pause(); audio.removeAttribute("src"); audio.load(); host.innerHTML = ""; });
  audio.play().catch(() => {});
  return audio;
}

/** Render a published continuity card (the real <cr-continuity-card> via ContinuityRenderer) for inspection. */
export function previewContinuity(host, key, { channel, program, clockNow, cardSpan, template, bumperTheme, audioUrl }) {
  host.innerHTML = "";
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;inset:0";
  host.appendChild(box);
  const renderer = new ContinuityRenderer(box);
  claim(key, () => { renderer.hide(); renderer.destroy(); host.innerHTML = ""; });
  renderer.show(channel, program, clockNow, cardSpan, template, bumperTheme, audioUrl);
  renderer.setMuted(false);
  return renderer;
}
