// Provider-specific playback adapters used by BroadcastPlayer (see
// broadcast.js). Direct files (Internet Archive etc.) play through a plain
// <video> via Html5PlayerAdapter; YouTube episodes play through the official
// IFrame Player API via YouTubePlayerAdapter. The provider is chosen per
// airing from structured metadata (see resolveProvider()), never by sniffing
// a URL.
//
// Both adapters implement load(source, offsetSeconds), play(), pause(),
// seek(seconds), getCurrentTime(), getDuration(), destroy(), setMuted()/
// isMuted() and a state-change callback using the shared vocabulary
// "loading/playing/buffering/ended/error/blocked".
//
// Nothing here downloads, caches, proxies or extracts a YouTube media
// stream: playback stays inside YouTube's own iframe, and no overlay is ever
// drawn on top of it (CRVideo's transport UI lives in the surrounding page).

// ---------- continuity cards ----------

import "./continuity-card.js"; // side-effect: registers <cr-continuity-card>
import "./bump-player.js"; // side-effect: registers <cr-bump>

/**
 * Mounts/updates/hides a <cr-continuity-card> inside a container the caller
 * owns. Not a PlayerAdapter: a card is rendered, never played, paused or
 * sought. BroadcastPlayer calls this directly, and always pauses/hides the
 * outgoing adapter first (see switchTo()) so a card is never drawn over a
 * YouTube iframe.
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
   * @param {?string} template this occurrence's card "template" id (schedule.json `cards[].template`); narrows which `bumperTheme.bumpers` are eligible (see continuity-card.js)
   * @param {{bumpers?:Array<object>, quoteDecks?:Record<string,string[]>}|null} bumperTheme
   *        the channel's resolved theme.json (see loadTheme()); not `channel.theme`, which is the small color-token palette. null renders the plain generic card.
   * @param {?string} audioUrl this occurrence's announcer narration MP3 (see findAnnouncementAudio()), or null for a silent card
   */
  show(channel, program, clockNow, cardSpan, template = null, bumperTheme = null, audioUrl = null) {
    if (!this.card) {
      this.card = document.createElement("cr-continuity-card");
      this.container.appendChild(this.card);
    }
    // Theming comes from the caller (loadChannel()'s `theme`), never hardcoded here; unset properties keep the component's defaults.
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

  /** Mirrors BroadcastPlayer's mute state onto the narration track, so a
   *  viewer's choice follows them into and out of a continuity card. */
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

// ---------- bump scheduling (clock-anchored, e.g. "top of the hour") ----------
//
// A bump (see bumps/README.md, bump-player.js) is scheduled client-side by
// wall clock, never published into schedule.json. ContinuityFiller.php can
// only fill an already-uncovered gap; it cannot carve a slot out of a
// tightly packed block, so "airs for 12s exactly on the hour" can't be
// guaranteed from the publish side. Instead BroadcastPlayer.tick() derives
// the window from the same wall clock as locate(), so every viewer computes
// the identical window and it fires regardless of the schedule's shape.
// Tradeoff: like a continuity card, a bump draws OVER whatever is airing
// without pausing the underlying schedule, so a viewer misses that slice of
// the program, as in a real station break.

export const BUMP_RULE_PERIODS = { hour: 3600, halfHour: 1800, day: 86400 };

/**
 * The window (if any) one bump rule ({bumpId, every, offsetSeconds,
 * durationSeconds}) defines around time `t`. `every` selects the period
 * (see BUMP_RULE_PERIODS), `offsetSeconds` (default 0) is how far into each
 * period the window starts, `durationSeconds` how long it stays up. Pure
 * function of (rule, t): returns null for an unrecognized `every` or when
 * `t` is outside the window; never throws on a malformed rule.
 */
export function bumpRuleWindow(rule, t) {
  const period = BUMP_RULE_PERIODS[rule?.every];
  if (!period || !rule?.bumpId) return null;
  const offset = Math.max(0, Math.min(period - 1, Number(rule.offsetSeconds) || 0));
  const duration = Math.max(0, Number(rule.durationSeconds) || 0);
  if (duration <= 0) return null;
  const startsAt = Math.floor((t - offset) / period) * period + offset;
  const endsAt = startsAt + duration;
  if (t < startsAt || t >= endsAt) return null;
  return { bumpId: rule.bumpId, startsAt, endsAt };
}

/** The first rule (array order) whose window contains `t`, or null: one
 *  "is a bump active, and which" check per tick(). */
export function locateActiveBump(rules, t) {
  if (!Array.isArray(rules)) return null;
  for (const rule of rules) {
    const window = bumpRuleWindow(rule, t);
    if (window) return window;
  }
  return null;
}

/**
 * Mounts/updates/hides a <cr-bump> inside a container the caller owns. Like
 * ContinuityRenderer, not a PlayerAdapter: a bump is driven by the clock.
 */
export class BumpRenderer {
  constructor(container) {
    this.container = container;
    this.el = null;
  }

  /**
   * @param {object} definition a full bump JSON object (bumps/<id>.json -- see bumps/README.md)
   * @param {Array<{title:string, startsAt:number, subtitle?:string}>} upcoming the channel's REAL upcoming programs, never invented here
   * @param {{name?:string, logo?:string}|null} channel
   * @param {() => number} clockNow
   * @param {boolean} muted
   * @param {number} [offset=0] seconds since the bump's window opened
   *   (`now() - window.startsAt`), so a viewer tuning in mid-bump starts at
   *   the same composition time as everyone else (see bump-player.js).
   */
  show(definition, upcoming, channel, clockNow, muted, offset = 0) {
    if (!this.el) {
      this.el = document.createElement("cr-bump");
      this.container.appendChild(this.el);
    }
    this.el.clockNow = clockNow;
    this.el.channel = channel;
    this.el.definition = definition;
    this.el.upcoming = upcoming;
    this.el.play({ muted, offset: Math.max(0, Number(offset) || 0) });
    this.container.hidden = false;
  }

  setMuted(muted) {
    this.el?.setMuted(muted);
  }

  hide() {
    this.container.hidden = true;
    this.el?.stop();
  }

  destroy() {
    this.el?.remove();
    this.el = null;
  }
}

// ---------- pure, unit-testable helpers ----------

/** Exponential backoff, capped (2s, 4s, 8s, 16s, 30s, ...). `attempt` is 1-based. */
export function computeBackoffMs(attempt, { base = 2000, max = 30000 } = {}) {
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
}

/**
 * Decides whether a player at `currentTime` must jump to `targetTime` to stay
 * on the live point, and if so, to where. Returns null when no correction is
 * needed (including when the file is nearly over: let it end rather than
 * seek past its end). Shared by both adapters and tests.
 */
export function computeDriftCorrection(currentTime, targetTime, tolerance, duration) {
  if (!Number.isFinite(targetTime) || !Number.isFinite(currentTime)) return null;
  if (Number.isFinite(duration) && targetTime >= duration - 0.25) return null;
  if (Math.abs(currentTime - targetTime) <= tolerance) return null;
  return Math.max(0, targetTime);
}

/**
 * Structured provider selection for a schedule entry, from the optional
 * "source" object ({"provider": "youtube", ...}) that series.json episodes
 * and schedule.json items carry. Never inspects media_url/source_url text.
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
  // No "source": a flat media_url means html5 (the convention ia-import schedules use).
  return { provider: item && item.media_url ? "html5" : null, videoId: null };
}

// ---------- shared base "interface" ----------

/** The shape every adapter implements. Subclassing is optional (duck typing
 *  works) but makes "did I implement everything" obvious. */
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
 * <video>-element playback: muted autoplay, never stays paused, and
 * NotAllowedError -> "blocked". Retry/backoff and drift-correction policy
 * live in BroadcastPlayer, shared with YouTubePlayerAdapter.
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
    // pause() below is deliberate (switching away) and sets `_suspended`, which this respects.
    video.addEventListener("pause", () => {
      if (!this._suspended && this.state !== "idle" && this.state !== "error" && !video.ended) this.play();
    });
  }

  _setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.onStateChange(state);
  }

  load(url, offsetSeconds = 0) {
    this._suspended = false;
    this._setState("loading");
    if (this._onLoadedMetadata) this.video.removeEventListener("loadedmetadata", this._onLoadedMetadata);
    this._onLoadedMetadata = () => this.seek(offsetSeconds);
    this.video.addEventListener("loadedmetadata", this._onLoadedMetadata, { once: true });
    this.video.src = url;
    this.video.load();
    this.play();
  }

  play() {
    this._suspended = false;
    const p = this.video.play();
    if (p) p.catch((err) => { if (err.name === "NotAllowedError") this._setState("blocked"); });
  }

  /** A deliberate pause (the adapter was switched away from, or a bump is
   *  drawn over it): stays paused until load()/play(), unlike an external
   *  pause, which the "never stays paused" listener undoes. */
  pause() {
    this._suspended = true;
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
    this._suspended = true;
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

// YT.PlayerError codes: 100 = video not found (removed/private), 101 & 150 =
// embedding disabled. All permanent, so BroadcastPlayer treats them as
// immediately exhausted (`fatal`) rather than retrying.
const YT_FATAL_ERROR_CODES = new Set([100, 101, 150]);

/**
 * Wraps one YT.Player bound to `container` (a DOM element the caller owns
 * and positions; never styled or covered here). Per YouTube's terms this
 * class never hides or replaces the player's controls/branding and never
 * touches ads; playerVars only disable the end-of-video related-videos grid
 * and annotations, which are ordinary embed options.
 *
 * `container` is never handed to `new YT.Player(...)`: the IFrame API
 * replaces the element it is given with the `<iframe>`, which would detach
 * `container` from the document -- the node BroadcastPlayer.switchTo()
 * toggles `.hidden` on. The API gets a disposable inner `mount` instead
 * (see _ensurePlayer()), keeping `container` stable and attached.
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
    this._suspended = false;
  }

  _setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.onStateChange(state);
  }

  _ensurePlayer() {
    if (this._playerPromise) return this._playerPromise;
    // Disposable mount for the IFrame API to replace; never `this.container` (see class docblock).
    const mount = document.createElement("div");
    mount.style.width = "100%";
    mount.style.height = "100%";
    this.container.appendChild(mount);
    this._playerPromise = loadYouTubeIframeApi().then((YT) => new Promise((resolve) => {
      this.player = new YT.Player(mount, {
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
      if (!this._suspended && this.state !== "idle" && this.state !== "error") this.play();
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
    this._suspended = false;
    this._setState("loading");
    const player = await this._ensurePlayer();
    // pause() arrived while the API/player was still loading: don't start a video nobody is watching.
    if (this._suspended) return;
    player.loadVideoById({ videoId, startSeconds: Math.max(0, offsetSeconds) });
    if (this.muted) player.mute(); else { player.unMute(); player.setVolume(100); }

    // The IFrame API doesn't reject refused autoplay like <video>.play().
    // If playback hasn't reached PLAYING/BUFFERING shortly after being
    // requested, report "blocked" (resolved by a user gesture calling resume()).
    clearTimeout(this._blockTimer);
    this._blockTimer = setTimeout(() => {
      if (this.state === "loading") this._setState("blocked");
    }, 4000);
  }

  play() {
    this._suspended = false;
    this.player?.playVideo?.();
  }

  /** A deliberate pause: stays paused until load()/play() (see Html5PlayerAdapter.pause()). */
  pause() {
    this._suspended = true;
    clearTimeout(this._blockTimer);
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
    this._suspended = true;
    clearTimeout(this._blockTimer);
    this.player?.destroy?.();
    this.player = null;
    this._playerPromise = null;
  }
}
