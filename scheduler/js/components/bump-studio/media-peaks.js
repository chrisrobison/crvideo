// media-peaks.js -- timeline visuals computed in the browser from the real
// media files: audio waveforms (Web Audio decodeAudioData) and video
// filmstrips (an offscreen <video> + canvas). No libraries, no server-side
// processing; results are cached per file for the life of the page and
// work is queued one file at a time so it never competes with playback.

const REPO_ROOT = new URL("../../../../", import.meta.url);
const mediaUrl = (path) => new URL(String(path || "").replace(/^\/+/, ""), REPO_ROOT).href;

const cache = new Map();
function makeQueue() {
  let tail = Promise.resolve();
  return (job) => {
    const p = tail.then(job, job);
    tail = p.catch(() => {});
    return p;
  };
}
const enqueue = makeQueue();
const enqueuePoster = makeQueue(); // thumbnails never wait behind waveforms/filmstrips

/** Peak amplitude (0-1) per bucket across the whole file. */
export function audioPeaks(path, buckets = 240) {
  const key = `peaks:${path}:${buckets}`;
  if (!cache.has(key)) {
    cache.set(key, enqueue(async () => {
      const res = await fetch(mediaUrl(path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 22050);
      const audio = await ctx.decodeAudioData(buf);
      const data = audio.getChannelData(0);
      const out = new Float32Array(buckets);
      const per = Math.max(1, Math.floor(data.length / buckets));
      let max = 0;
      for (let b = 0; b < buckets; b++) {
        let peak = 0;
        const end = Math.min(data.length, (b + 1) * per);
        for (let i = b * per; i < end; i += 4) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
        out[b] = peak;
        if (peak > max) max = peak;
      }
      if (max > 0) for (let b = 0; b < buckets; b++) out[b] /= max;
      return out;
    }));
  }
  return cache.get(key);
}

/** Peaks -> a mirrored-bar SVG as a CSS-ready data URL. */
export function waveformUrl(peaks, color = "rgba(255,255,255,.75)") {
  const n = peaks.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const h = Math.max(0.04, peaks[i]) * 46;
    d += `M${i + 0.5} ${50 - h}V${50 + h}`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} 100" preserveAspectRatio="none"><path d="${d}" stroke="${color}" stroke-width="0.6" fill="none"/></svg>`;
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`; // single quotes: this lands inside double-quoted style attributes
}

/** A horizontal strip of `frames` thumbnails spanning one pass of the video. */
export function filmstrip(path, { frames = 6, height = 36 } = {}) {
  const key = `strip:${path}:${frames}:${height}`;
  if (!cache.has(key)) {
    cache.set(key, enqueue(() => new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.playsInline = true;
      v.src = mediaUrl(path);
      const fail = () => { v.removeAttribute("src"); reject(new Error("filmstrip failed")); };
      const timer = setTimeout(fail, 60000);
      v.addEventListener("error", () => { clearTimeout(timer); fail(); }, { once: true });
      v.addEventListener("loadeddata", async () => {
        try {
          const w = Math.round(height * (v.videoWidth / v.videoHeight || 16 / 9));
          const canvas = Object.assign(document.createElement("canvas"), { width: w * frames, height });
          const g = canvas.getContext("2d");
          for (let i = 0; i < frames; i++) {
            await new Promise((ok) => {
              v.addEventListener("seeked", ok, { once: true });
              v.currentTime = Math.min(v.duration - 0.05, ((i + 0.5) * v.duration) / frames);
            });
            g.drawImage(v, i * w, 0, w, height);
          }
          clearTimeout(timer);
          const url = canvas.toDataURL("image/jpeg", 0.72);
          const duration = v.duration;
          v.removeAttribute("src");
          v.load();
          resolve({ url, duration });
        } catch (e) { clearTimeout(timer); reject(e); }
      }, { once: true });
    })));
  }
  return cache.get(key);
}

/** One still frame (~1s in) as a JPEG data URL plus the video's length --
 *  reliable thumbnails, unlike relying on a preload="metadata" <video> to
 *  paint a frame (many browsers don't). */
export function posterFrame(path, { width = 192, at = 1 } = {}) {
  const key = `poster:${path}:${width}`;
  if (!cache.has(key)) {
    cache.set(key, enqueuePoster(() => new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.playsInline = true;
      const timer = setTimeout(() => { v.removeAttribute("src"); reject(new Error("poster timeout")); }, 45000);
      v.addEventListener("error", () => { clearTimeout(timer); reject(new Error("poster failed")); }, { once: true });
      v.addEventListener("loadedmetadata", () => {
        v.addEventListener("seeked", () => {
          try {
            const h = Math.round(width / (v.videoWidth / v.videoHeight || 16 / 9));
            const canvas = Object.assign(document.createElement("canvas"), { width, height: h });
            canvas.getContext("2d").drawImage(v, 0, 0, width, h);
            const duration = v.duration;
            clearTimeout(timer);
            resolve({ url: canvas.toDataURL("image/jpeg", 0.75), duration });
          } catch (e) { clearTimeout(timer); reject(e); }
          v.removeAttribute("src");
          v.load();
        }, { once: true });
        v.currentTime = Math.min(at, (v.duration || 2) / 2);
      }, { once: true });
      v.src = mediaUrl(path);
    })));
  }
  return cache.get(key);
}
