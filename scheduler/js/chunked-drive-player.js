// Streams a *fragmented* MP4 from Google Drive into a <video> element via
// MediaSource Extensions, using only small, explicitly-bounded byte-range
// requests (never `Range: bytes=N-` with no end).
//
// Why this exists: a plain `<video src="…drive…?alt=media">` lets the
// browser's own media engine choose the Range header, and for large files it
// issues an *open-ended* range ("give me everything from byte 0 to EOF").
// Google Drive's per-file download quota appears to charge against the
// requested range, not bytes actually transferred, so one such request can
// burn (or outright exceed) most of a multi-hundred-GB daily budget in one
// shot. Every request this class makes has a concrete end byte, sized in low
// single-digit MB, regardless of how large the underlying file is.
//
// Requires the source file to be a *fragmented* MP4 (moov contains mvex,
// followed by moof+mdat pairs) — see scheduler/GOOGLE_DRIVE_SETUP.md for the
// ffmpeg flags. Fails fast (see `probe()`) against a normal "flat" MP4 so the
// caller can fall back to direct <video src> playback for those.
import { parseInitSegment, findFragments, scanForMoof } from "./mp4box.js";

const INIT_WINDOW_START = 256 * 1024;
const INIT_WINDOW_MAX = 4 * 1024 * 1024;
const SEEK_WINDOW_BYTES = 2 * 1024 * 1024;   // scanned around an estimated seek offset
const SEEK_MAX_ITERATIONS = 6;               // bracket-search retries before giving up
const STREAM_CHUNK_BYTES = 4 * 1024 * 1024;  // sequential fetch size once playing
const BUFFER_AHEAD_TARGET_SEC = 45;          // fetch more once buffered-ahead drops below this
const BUFFER_AHEAD_MAX_SEC = 90;             // stop fetching once buffered this far ahead
const BUFFER_BEHIND_KEEP_SEC = 30;           // trim buffered data older than this behind currentTime
const TRIM_INTERVAL_MS = 15000;

function concat(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out.buffer;
}

/** Parse a Drive-style {"error":{"message","errors":[{"reason"}]}} body, mirroring channel.html's probeAvailable(). */
async function parseDriveError(res) {
  let reason = null, message = null;
  try {
    const body = await res.json();
    reason = body?.error?.errors?.[0]?.reason || null;
    message = body?.error?.message || null;
  } catch (_) { /* non-JSON body */ }
  return { status: res.status, reason, message };
}

export class ChunkedDrivePlayer extends EventTarget {
  constructor(videoEl) {
    super();
    this.video = videoEl;
    this.reset();
  }

  reset() {
    this._abort?.abort();
    this._abort = new AbortController();
    this.url = null;
    this.fileSize = null;
    this.initSegment = null;
    this.mimeCodec = null;
    this.timescales = null;
    this.primaryTrackId = null;
    this.postInitOffset = 0; // byte offset right after the init segment (moov end)
    this.mediaSource = null;
    this.sourceBuffer = null;
    this._streamGeneration = 0; // bumped on every seek/destroy to cancel stale async loops
    this._trimTimer && clearInterval(this._trimTimer);
    this._trimTimer = null;
  }

  destroy() {
    this.reset();
    if (this.video) {
      try { this.video.removeAttribute("src"); this.video.load(); } catch (_) { /* ignore */ }
    }
  }

  _emitError(err) {
    this.dispatchEvent(new CustomEvent("error", { detail: err }));
  }

  /** Bounded-range GET. `end` is inclusive and MUST be finite. Throws {status,reason,message} on failure. */
  async _fetchRange(start, end, { signal } = {}) {
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: signal || this._abort.signal,
    });
    if (res.status !== 206 && res.status !== 200) throw await parseDriveError(res);
    const contentRange = res.headers.get("content-range"); // "bytes start-end/total"
    if (contentRange) {
      const total = Number(contentRange.split("/")[1]);
      if (Number.isFinite(total)) this.fileSize = total;
    }
    return res.arrayBuffer();
  }

  /**
   * Probe whether `url` is a fragmented MP4 usable with this player. Does
   * NOT start playback. Returns { ok:true, mimeCodec, duration } or
   * { ok:false, reason } where reason is "not-fragmented" (caller should
   * fall back to direct <video src>) or a Drive error shape.
   */
  async probe(url) {
    this.url = url;
    let windowSize = INIT_WINDOW_START;
    for (;;) {
      let buf;
      try {
        buf = await this._fetchRange(0, windowSize - 1);
      } catch (err) {
        return { ok: false, reason: err.reason, message: err.message, status: err.status };
      }
      const result = parseInitSegment(buf);
      if (result.ok) {
        this.initSegment = result.initSegment;
        this.mimeCodec = result.mimeCodec;
        this.timescales = result.timescales;
        this.primaryTrackId = result.primaryTrackId;
        this.postInitOffset = result.initSegment.byteLength;
        return { ok: true, mimeCodec: result.mimeCodec };
      }
      if (result.reason === "not-fragmented") return { ok: false, reason: "not-fragmented" };
      if (windowSize >= INIT_WINDOW_MAX) return { ok: false, reason: "no-moov" };
      windowSize *= 2; // grow and retry — moov didn't fully fit in what we fetched
    }
  }

  /**
   * Attach a MediaSource to the video element, append the (already-probed)
   * init segment, then start streaming from `offsetSec` into the asset.
   * `durationSec` should come from Drive's videoMediaMetadata (this player
   * doesn't trust the fragmented moov's own duration field, which is 0 for
   * an empty-moov file).
   */
  async load(offsetSec, durationSec) {
    if (!this.initSegment) throw new Error("probe() must succeed before load()");
    if (!window.MediaSource || !MediaSource.isTypeSupported(this.mimeCodec)) {
      // Thrown (not emitted as an 'error' event) so the in-flight switchTo() await in channel.html
      // rejects cleanly instead of racing its own success path against an async error event.
      const err = new Error(`Browser cannot play ${this.mimeCodec}`);
      err.reason = "unsupported-codec";
      throw err;
    }
    this.duration = durationSec;
    this.mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = objectUrl;

    await new Promise((resolve) => this.mediaSource.addEventListener("sourceopen", resolve, { once: true }));
    URL.revokeObjectURL(objectUrl);
    if (Number.isFinite(durationSec) && durationSec > 0) {
      try { this.mediaSource.duration = durationSec; } catch (_) { /* non-fatal */ }
    }
    this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeCodec);
    this.sourceBuffer.mode = "segments"; // respect each fragment's own tfdt-derived timestamp

    await this._appendBuffer(this.initSegment);
    this._trimTimer = setInterval(() => this._trimBehind(), TRIM_INTERVAL_MS);
    await this.seek(offsetSec);
  }

  _appendBuffer(buf) {
    return new Promise((resolve, reject) => {
      const onUpdateEnd = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("SourceBuffer append failed")); };
      const cleanup = () => {
        this.sourceBuffer.removeEventListener("updateend", onUpdateEnd);
        this.sourceBuffer.removeEventListener("error", onError);
      };
      this.sourceBuffer.addEventListener("updateend", onUpdateEnd, { once: true });
      this.sourceBuffer.addEventListener("error", onError, { once: true });
      try { this.sourceBuffer.appendBuffer(buf); }
      catch (e) { cleanup(); reject(e); }
    });
  }

  /**
   * Jump to `offsetSec` into the asset: locate the right fragment (bounded search), clear old
   * buffer, restart streaming. Errors from locating/starting THIS seek are thrown (not emitted)
   * so `load()`'s caller sees a clean rejection instead of racing its own success path against
   * an async error event — important for the very first seek during a cold-start switch. Once
   * streaming is underway, the *ongoing* background fetch loop reports its own failures via the
   * 'error' event instead, since nothing is awaiting it directly by then.
   */
  async seek(offsetSec) {
    const generation = ++this._streamGeneration; // invalidates any in-flight streaming loop from a prior seek
    if (this.sourceBuffer && this.sourceBuffer.buffered.length) {
      try { this.sourceBuffer.remove(0, this.mediaSource.duration || Infinity); await this._waitUpdateEnd(); } catch (_) { /* ignore */ }
    }
    const fragmentByteOffset = await this._locateFragment(offsetSec);
    this._streamFrom(fragmentByteOffset, generation).catch((err) => {
      if (generation === this._streamGeneration) this._emitError(err);
    });
    // Give the stream loop a moment to append the first fragment before seeking currentTime,
    // otherwise the browser has nothing buffered yet to seek into.
    await this._waitForBufferAt(offsetSec, generation);
    this.video.currentTime = offsetSec;
  }

  _waitUpdateEnd() {
    if (!this.sourceBuffer.updating) return Promise.resolve();
    return new Promise((resolve) => this.sourceBuffer.addEventListener("updateend", resolve, { once: true }));
  }

  async _waitForBufferAt(offsetSec, generation, timeoutMs = 15000) {
    const start = Date.now();
    while (generation === this._streamGeneration && Date.now() - start < timeoutMs) {
      const buffered = this.sourceBuffer?.buffered;
      if (buffered) {
        for (let i = 0; i < buffered.length; i++) {
          if (offsetSec >= buffered.start(i) - 0.5 && offsetSec < buffered.end(i) + 5) return;
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /**
   * Estimate a byte offset for `targetSec` via average bitrate, then confirm/refine
   * by reading real fragment tfdt timestamps until the target is bracketed by a
   * fragment starting at-or-before it and one starting after it (or iterations run out).
   */
  async _locateFragment(targetSec) {
    const mediaBytes = this.fileSize - this.postInitOffset;
    const avgBytesPerSec = Number.isFinite(this.duration) && this.duration > 0 ? mediaBytes / this.duration : null;
    let estimate = this.postInitOffset + (avgBytesPerSec != null ? Math.round(targetSec * avgBytesPerSec) : 0);
    estimate = Math.max(this.postInitOffset, Math.min(estimate, this.fileSize - 1));

    let best = null; // {byteOffset, startTimeSec} of the latest confirmed fragment at-or-before targetSec
    let bytesPerSec = avgBytesPerSec; // refined from real fragment spacing as windows come back

    for (let i = 0; i < SEEK_MAX_ITERATIONS; i++) {
      const start = Math.max(this.postInitOffset, Math.min(estimate, this.fileSize - 1) - SEEK_WINDOW_BYTES / 2);
      const end = Math.min(this.fileSize - 1, start + SEEK_WINDOW_BYTES - 1);
      const buf = await this._fetchRange(start, end);
      // The window was fetched around an estimated byte offset, not a known box boundary — find
      // real alignment first (findFragments assumes its start position already IS one).
      const aligned = scanForMoof(buf, 0, buf.byteLength);
      const frags = aligned === -1 ? [] : findFragments(buf, aligned, buf.byteLength, this.timescales, this.primaryTrackId)
        .map((f) => ({ byteOffset: start + f.moofStart, startTimeSec: f.startTimeSec }))
        .filter((f) => f.startTimeSec != null);

      if (!frags.length) {
        // No usable fragment in this window (landed inside one large mdat, or right at its edge) — try earlier.
        estimate = start - SEEK_WINDOW_BYTES / 2;
        if (estimate < this.postInitOffset) break;
        continue;
      }

      // Refine bytes/sec from what this window actually showed — corrects for content whose bitrate
      // isn't perfectly constant, so a badly-off first guess still converges in a few iterations.
      if (frags.length >= 2) {
        const dt = frags[frags.length - 1].startTimeSec - frags[0].startTimeSec;
        const db = frags[frags.length - 1].byteOffset - frags[0].byteOffset;
        if (dt > 0) bytesPerSec = db / dt;
      }

      const before = frags.filter((f) => f.startTimeSec <= targetSec);
      const after = frags.filter((f) => f.startTimeSec > targetSec);
      if (before.length) best = before[before.length - 1];

      if (before.length && after.length) return best.byteOffset; // properly bracketed — done

      // Not bracketed yet — jump straight toward the target from the closest known point,
      // using the freshest bytes/sec estimate, rather than nudging by a fixed step.
      const anchor = before.length ? best : frags[0];
      const rate = bytesPerSec || SEEK_WINDOW_BYTES / 4;
      estimate = anchor.byteOffset + Math.round((targetSec - anchor.startTimeSec) * rate);
      estimate = Math.max(this.postInitOffset, Math.min(estimate, this.fileSize - 1));
    }
    // Iterations exhausted without a clean bracket — use the best fragment found, if any. Periodic
    // drift-correction in channel.html will nudge currentTime once playback is underway regardless.
    return best ? best.byteOffset : this.postInitOffset;
  }

  /** Sequentially fetch+append fragments starting at `byteOffset`, respecting a bounded look-ahead buffer. */
  async _streamFrom(byteOffset, generation) {
    let pos = byteOffset;
    let carry = null; // leftover bytes from a fragment that straddled a fetch boundary

    while (generation === this._streamGeneration) {
      if (pos >= this.fileSize) return; // reached end of file — let 'ended'/schedule logic take over

      const aheadSec = this._bufferedAheadSec();
      if (aheadSec > BUFFER_AHEAD_MAX_SEC) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const end = Math.min(this.fileSize - 1, pos + STREAM_CHUNK_BYTES - 1);
      let fresh;
      try {
        fresh = await this._fetchRange(pos, end);
      } catch (err) {
        throw err; // bubbles to caller, which emits a proper standby/backoff error
      }
      if (generation !== this._streamGeneration) return; // superseded by a newer seek
      const newBytesFetched = end - pos + 1;
      pos += newBytesFetched;

      const window = concat(carry, fresh);
      const frags = findFragments(window, 0, window.byteLength, this.timescales, this.primaryTrackId);
      let consumedThrough = 0;
      for (const f of frags) {
        await this._appendBuffer(window.slice(f.moofStart, f.segmentEnd));
        consumedThrough = f.segmentEnd;
        if (generation !== this._streamGeneration) return;
      }
      carry = consumedThrough < window.byteLength ? window.slice(consumedThrough) : null;

      if (this._bufferedAheadSec() < BUFFER_AHEAD_TARGET_SEC) continue;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  _bufferedAheadSec() {
    const buffered = this.sourceBuffer?.buffered;
    if (!buffered || !buffered.length) return 0;
    const t = this.video.currentTime;
    for (let i = 0; i < buffered.length; i++) {
      if (t >= buffered.start(i) - 1 && t <= buffered.end(i)) return buffered.end(i) - t;
    }
    return 0;
  }

  _trimBehind() {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || !sb.buffered.length) return;
    const cutoff = this.video.currentTime - BUFFER_BEHIND_KEEP_SEC;
    if (cutoff > sb.buffered.start(0) + 5) {
      try { sb.remove(sb.buffered.start(0), cutoff); } catch (_) { /* ignore */ }
    }
  }
}
