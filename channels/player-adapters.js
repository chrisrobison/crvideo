// Provider-specific playback adapters used by BroadcastPlayer (see
// broadcast.js). Internet Archive (and any other directly-hosted file)
// plays through a plain <video> element via Html5PlayerAdapter, exactly
// as it always has; a YouTube-hosted episode plays through the official
// YouTube IFrame Player API via YouTubePlayerAdapter. BroadcastPlayer picks
// between them per-airing using structured provider metadata (see
// resolveProvider() below) -- never by sniffing a URL string.
//
// Both adapters implement the same small surface (the spec's suggested
// PlayerAdapter shape): load(source, offsetSeconds), play(), pause(),
// seek(seconds), getCurrentTime(), getDuration(), destroy() -- plus
// setMuted()/isMuted() (needed to preserve a viewer's mute/volume choice
// across a program or provider transition) and a state-change callback
// used for the shared "loading/playing/buffering/ended/error/blocked"
// vocabulary BroadcastPlayer drives its UI from.
//
// Nothing here ever downloads, caches, proxies, or extracts a YouTube
// media stream -- playback is entirely inside YouTube's own iframe/player,
// which is also why YouTube's own controls, branding, and any ads it
// serves are left exactly as YouTube renders them (no overlay is ever
// drawn on top of the iframe itself; CRVideo's own transport UI -- the
// channel-number flash, the lower-third info bar, the tap-to-unmute hint
// -- stays in the surrounding page chrome, same as it already is for
// HTML5 playback in watch.html).

// ---------- continuity (Phase 5/6: dynamic "Coming Up Next" cards) ----------

import "./continuity-card.js"; // side-effect: registers <cr-continuity-card>

/**
 * Mounts/updates/hides a <cr-continuity-card> inside a container element
 * the caller owns (consistent placement with Html5PlayerAdapter/
 * YouTubePlayerAdapter, but NOT a PlayerAdapter itself -- a continuity
 * card is never "played, paused, or sought", just rendered, so forcing
 * it through that media-playback-shaped interface would only add
 * meaningless no-op methods). BroadcastPlayer calls this directly.
 * Never creates a fake video URL and never draws over an active
 * YouTube iframe -- see BroadcastPlayer.switchTo(), which always pauses/
 * hides the outgoing adapter first.
 */
export class ContinuityRenderer {
  constructor(container) {
    this.container = container;
    this.card = null;
  }

  /**
   * @param {{name?:string, logo?:string, theme?:Record<string,string>|null}|null} channel
   * @param {{title:string, description?:string, thumbnailUrl?:string, startsAt:number}|null} program the UPCOMING program, not this card itself
   * @param {() => number} clockNow
   * @param {{startsAt:number, endsAt:number}} cardSpan this continuity occurrence's own span, for the progress bar
   * @param {?string} template this occurrence's own continuity card "template" id
   *        (schedule.json's `cards[].template`, from continuity.json) -- narrows
   *        which `bumperTheme.bumpers` are eligible; see continuity-card.js.
   * @param {{bumpers?:Array<object>, quoteDecks?:Record<string,string[]>}|null} bumperTheme
   *        the channel's resolved `theme.json` (see broadcast.js's loadTheme()),
   *        NOT the same thing as `channel.theme` below -- that's the small,
   *        pre-existing color-token palette from meta.json. null (the default,
   *        and every channel without a theme.json) renders the plain generic
   *        card exactly as before this parameter existed.
   * @param {?string} audioUrl this occurrence's AI continuity announcer
   *        narration MP3 (see broadcast.js's findAnnouncementAudio()), or
   *        null -- the default, and every channel whose announcer isn't
   *        enabled -- for a silent card exactly as before this parameter
   *        existed.
   */
  show(channel, program, clockNow, cardSpan, template = null, bumperTheme = null, audioUrl = null) {
    if (!this.card) {
      this.card = document.createElement("cr-continuity-card");
      this.container.appendChild(this.card);
    }
    // Per-channel theming lives entirely in the page/caller (never
    // hardcoded in continuity-card.js itself) -- see loadChannel()'s
    // `theme` field in broadcast.js. Unset properties simply keep the
    // component's own generic defaults.
    const vars = { bg: "--cc-bg", bg2: "--cc-bg-2", fg: "--cc-fg", muted: "--cc-muted", accent: "--cc-accent", accentWarm: "--cc-accent-warm" };
    for (const [key, cssVar] of Object.entries(vars)) {
      const value = channel?.theme?.[key];
      if (value) this.card.style.setProperty(cssVar, value);
      else this.card.style.removeProperty(cssVar);
    }
    this.card.channel = channel;
    this.card.clockNow = clockNow;
    this.card.template = template;
    this.card.theme = bumperTheme;
    this.card.program = program;
    this.card.setCardSpan(cardSpan.startsAt, cardSpan.endsAt);
    this.card.audioUrl = audioUrl;
    this.container.hidden = false;
  }

  /** Mirrors BroadcastPlayer.setMuted()'s mute state onto the narration
   *  track -- the announcer's voice-over is "channel audio" exactly like
   *  any program's own soundtrack, so a viewer's mute/unmute choice must
   *  follow them into and out of a continuity card. */
  setMuted(muted) {
    this.card?.setMuted(muted);
  }

  hide() {
    this.container.hidden = true;
    if (this.card) this.card.audioUrl = null; // stop narration immediately -- never let it keep playing over the next program
  }

  destroy() {
    this.card?.remove();
    this.card = null;
  }
}

// ---------- pure, unit-testable helpers ----------

/** Exponential backoff, capped -- same formula BroadcastPlayer's HTML5
 *  path has always used (2s, 4s, 8s, 16s, 30s, 30s, ...). `attempt` is
 *  1-based (the first retry is attempt 1). */
export function computeBackoffMs(attempt, { base = 2000, max = 30000 } = {}) {
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
}

/**
 * Decides whether a player sitting at `currentTime` needs to jump to
 * `targetTime` to stay on the channel's live point, and if so, to where.
 * Returns null when no correction is needed (including "the file is
 * basically over, let it end naturally rather than seek past its end").
 * This is exactly the math seekToLive() used to do inline against a
 * <video> element, factored out so both adapters (and tests) share it.
 */
export function computeDriftCorrection(currentTime, targetTime, tolerance, duration) {
  if (!Number.isFinite(targetTime) || !Number.isFinite(currentTime)) return null;
  if (Number.isFinite(duration) && targetTime >= duration - 0.25) return null;
  if (Math.abs(currentTime - targetTime) <= tolerance) return null;
  return Math.max(0, targetTime);
}

/**
 * Structured provider selection for a schedule entry -- reads the
 * optional "source" object ia-import/youtube-import both already write
 * onto catalog/series items (see the per-series series.json files under
 * series/, whose episodes already carry a "source":
 * {"provider": "youtube", ...} field), extended minimally to
 * schedule.json's own items. Never inspects media_url/source_url text.
 *
 * @param {{source?: {provider?: string, video_id?: string}|null, media_url?: string|null}} item
 * @returns {{provider: string|null, videoId: string|null}}
 */
export function resolveProvider(item) {
  const source = item && typeof item.source === "object" && item.source !== null ? item.source : null;
  const provider = source && typeof source.provider === "string" && source.provider ? source.provider : null;
  if (provider === "youtube") {
    const videoId = typeof source.video_id === "string" && source.video_id ? source.video_id : null;
    return { provider: videoId ? "youtube" : null, videoId };
  }
  if (provider) {
    return { provider, videoId: null }; // a recognized-but-unhandled provider (future-proofing)
  }
  // Legacy convention: no "source" object at all, just a flat media_url --
  // exactly every existing ia-import-produced schedule.json entry.
  return { provider: item && item.media_url ? "html5" : null, videoId: null };
}

// ---------- shared base "interface" ----------

/** Documents the shape every adapter implements; not actually required to
 *  be the prototype parent (duck-typing is enough), but subclassing it
 *  keeps "did I implement everything" obvious. */
export class PlayerAdapter {
  /** @param {string} source provider-specific: a media URL (Html5) or a YouTube video id. */
  load(source, offsetSeconds) { throw new Error("load() not implemented"); } // eslint-disable-line no-unused-vars
  play() {}
  pause() {}
  seek(seconds) {} // eslint-disable-line no-unused-vars
  getCurrentTime() { return NaN; }
  getDuration() { return NaN; }
  setMuted(muted) {} // eslint-disable-line no-unused-vars
  isMuted() { return true; }
  destroy() {}
}

// ---------- HTML5 (Internet Archive / any direct file) ----------

/**
 * A faithful extraction of the <video>-element logic BroadcastPlayer has
 * always used (phase 1's broadcast.js) into the adapter shape: same
 * muted-autoplay setup, same "never stays paused" behavior, same
 * NotAllowedError -> "blocked" handling. Behavior is unchanged; only the
 * retry/backoff and drift-correction *policy* now lives in BroadcastPlayer
 * (shared with YouTubePlayerAdapter) rather than duplicated per adapter.
 */
export class Html5PlayerAdapter extends PlayerAdapter {
  constructor(video, { onStateChange = () => {}, onError = () => {} } = {}) {
    super();
    this.video = video;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.state = "idle";

    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.controls = false;
    video.preload = "auto";
    video.disablePictureInPicture = true;

    this._onLoadedMetadata = null; // set per-load, for the initial seek-to-offset
    video.addEventListener("playing", () => this._setState("playing"));
    video.addEventListener("waiting", () => this._setState("buffering"));
    video.addEventListener("ended", () => this._setState("ended"));
    video.addEventListener("error", () => {
      this._setState("error");
      this.onError({ fatal: false, message: "HTML5 media error" });
    });
    // A broadcast never stays paused: whatever paused it (a media key, the
    // OS), pick right back up, unless we're mid-error/idle.
    video.addEventListener("pause", () => {
      if (this.state !== "idle" && this.state !== "error" && !video.ended) this.play();
    });
  }

  _setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.onStateChange(state);
  }

  load(url, offsetSeconds = 0) {
    this._setState("loading");
    if (this._onLoadedMetadata) this.video.removeEventListener("loadedmetadata", this._onLoadedMetadata);
    this._onLoadedMetadata = () => this.seek(offsetSeconds);
    this.video.addEventListener("loadedmetadata", this._onLoadedMetadata, { once: true });
    this.video.src = url;
    this.video.load();
    this.play();
  }

  play() {
    const p = this.video.play();
    if (p) p.catch((err) => { if (err.name === "NotAllowedError") this._setState("blocked"); });
  }

  pause() {
    this.video.pause();
  }

  seek(seconds) {
    if (this.video.readyState < 1 || this.video.seeking) return;
    this.video.currentTime = Math.max(0, seconds);
  }

  getCurrentTime() {
    return this.video.currentTime;
  }

  getDuration() {
    return this.video.duration;
  }

  setMuted(muted) {
    this.video.muted = muted;
    if (!muted) this.video.volume = 1;
  }

  isMuted() {
    return this.video.muted;
  }

  destroy() {
    if (this._onLoadedMetadata) this.video.removeEventListener("loadedmetadata", this._onLoadedMetadata);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}

// ---------- YouTube (official IFrame Player API) ----------

let iframeApiPromise = null;

/** Loads https://www.youtube.com/iframe_api exactly once per page, however
 *  many YouTubePlayerAdapter instances are created. Resolves with the
 *  global `YT` namespace the script installs. */
function loadYouTubeIframeApi() {
  if (iframeApiPromise) return iframeApiPromise;
  iframeApiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") previous();
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api"; // YouTube's own CDN -- no third-party mirror
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load the YouTube IFrame API script."));
    document.head.appendChild(script);
  });
  return iframeApiPromise;
}

// YT.PlayerError codes (see the IFrame API docs): 100 = video not found
// (removed/private), 101 & 150 = the uploader has disabled embedding.
// Both are permanent for this video -- retrying changes nothing, so
// BroadcastPlayer treats them as immediately exhausted (see `fatal`
// below), not just another transient failure to back off and retry.
const YT_FATAL_ERROR_CODES = new Set([100, 101, 150]);

/**
 * Wraps one YT.Player bound to `container` (a plain DOM element the
 * caller owns and positions -- never styled or covered by this class).
 * Per YouTube's terms, this class never hides or replaces the player's
 * own controls/branding and never serves or suppresses ads: playerVars
 * below only disable the unrelated end-of-video "related videos" grid
 * and annotations, which YouTube's own docs list as ordinary embed
 * options, not a branding workaround.
 */
export class YouTubePlayerAdapter extends PlayerAdapter {
  constructor(container, { onStateChange = () => {}, onError = () => {} } = {}) {
    super();
    this.container = container;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.state = "idle";
    this.player = null;
    this.muted = true;
    this._blockTimer = 0;
    this._playerPromise = null;
  }

  _setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.onStateChange(state);
  }

  _ensurePlayer() {
    if (this._playerPromise) return this._playerPromise;
    this._playerPromise = loadYouTubeIframeApi().then((YT) => new Promise((resolve) => {
      this.player = new YT.Player(this.container, {
        height: "100%",
        width: "100%",
        playerVars: {
          autoplay: 1,
          mute: 1,
          playsinline: 1,
          controls: 1, // YouTube's own controls, left on -- never hidden
          rel: 0,
          iv_load_policy: 3, // hide annotations; an ordinary, documented embed param
          fs: 1,
        },
        events: {
          onReady: () => resolve(this.player),
          onStateChange: (e) => this._handleStateChange(e, YT),
          onError: (e) => this._handleError(e),
        },
      });
    }));
    return this._playerPromise;
  }

  _handleStateChange(e, YT) {
    clearTimeout(this._blockTimer);
    if (e.data === YT.PlayerState.PLAYING) this._setState("playing");
    else if (e.data === YT.PlayerState.BUFFERING) this._setState("buffering");
    else if (e.data === YT.PlayerState.ENDED) this._setState("ended");
    else if (e.data === YT.PlayerState.PAUSED) {
      // Same "a broadcast never stays paused" rule as Html5PlayerAdapter.
      if (this.state !== "idle" && this.state !== "error") this.play();
    }
  }

  _handleError(e) {
    const fatal = YT_FATAL_ERROR_CODES.has(e.data);
    this._setState("error");
    this.onError({
      fatal,
      message: fatal
        ? `This video is unavailable or cannot be embedded (YouTube error ${e.data}).`
        : `YouTube player error ${e.data}.`,
    });
  }

  async load(videoId, offsetSeconds = 0) {
    this._setState("loading");
    const player = await this._ensurePlayer();
    player.loadVideoById({ videoId, startSeconds: Math.max(0, offsetSeconds) });
    if (this.muted) player.mute(); else { player.unMute(); player.setVolume(100); }

    // The IFrame API gives no promise/rejection for refused autoplay the
    // way HTML5 <video>.play() does. If playback hasn't reached PLAYING or
    // BUFFERING shortly after being requested, treat it as autoplay having
    // been blocked -- same outward "blocked" state as the HTML5 adapter,
    // resolved the same way (a user gesture calling resume()/play()).
    clearTimeout(this._blockTimer);
    this._blockTimer = setTimeout(() => {
      if (this.state === "loading") this._setState("blocked");
    }, 4000);
  }

  play() {
    this.player?.playVideo?.();
  }

  pause() {
    this.player?.pauseVideo?.();
  }

  seek(seconds) {
    this.player?.seekTo?.(Math.max(0, seconds), true);
  }

  getCurrentTime() {
    const t = this.player?.getCurrentTime?.();
    return typeof t === "number" ? t : NaN;
  }

  getDuration() {
    const d = this.player?.getDuration?.();
    return typeof d === "number" && d > 0 ? d : NaN;
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.player) return;
    if (muted) this.player.mute(); else { this.player.unMute(); this.player.setVolume(100); }
  }

  isMuted() {
    return this.player ? this.player.isMuted() : this.muted;
  }

  destroy() {
    clearTimeout(this._blockTimer);
    this.player?.destroy?.();
    this.player = null;
    this._playerPromise = null;
  }
}
