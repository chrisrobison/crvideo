import { store } from "../store.js";
import { baseComponentCSS, escapeHtml, secToClock, DAY_SECONDS, clamp } from "../utils.js";
import { toast } from "../utils.js";

const SNAP = 30; // seconds
const LABEL_ACCEPT = {
  program: new Set(["video", "audio", "graphic", "live"]),
  graphics: new Set(["graphic"]),
  live: new Set(["live"]),
};

const LABEL_WIDTH = 150; // keep in sync with .label-col / .track-label width below
const MIN_ZOOM = 1;
const MAX_ZOOM = 16;
const ZOOM_STORAGE_KEY = "channelflow:timeline-zoom";

/** Pick a readable tick interval (seconds) for the ruler/gridlines at a given zoom level —
 *  coarser when the full day is visible, finer as you zoom in on a narrower slice. */
function tickSecondsForZoom(zoom) {
  if (zoom < 1.5) return 7200; // 2h
  if (zoom < 3) return 3600;   // 1h
  if (zoom < 6) return 1800;   // 30m
  if (zoom < 10) return 900;   // 15m
  if (zoom < 16) return 600;   // 10m
  return 300;                  // 5m
}
function buildTicks(tickSec) {
  const n = DAY_SECONDS / tickSec;
  return Array.from({ length: n + 1 }, (_, i) => i * tickSec);
}
function tickLabel(sec) {
  return sec >= DAY_SECONDS ? "24:00" : secToClock(sec);
}

function blockToneStyle(type) {
  switch (type) {
    case "live": return "linear-gradient(135deg,var(--live-a),var(--live-b))";
    case "graphic": return "var(--graphic)";
    case "audio": return "linear-gradient(135deg,#6d28d9,#a855f7)";
    default: return "linear-gradient(135deg,var(--video-a),var(--video-b))";
  }
}

class CfTimeline extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this._zoom = this._loadZoom();
      this.attachShadow({ mode: "open" });
      this._render();
      this._onChange = (e) => {
        if (e.detail.reason === "tick") this._updatePlayhead();
        else this._renderTracks();
      };
      store.addEventListener("change", this._onChange);
    }
    this._renderTracks();
  }

  disconnectedCallback() { store.removeEventListener("change", this._onChange); }

  // ---------- zoom ----------
  _loadZoom() {
    try {
      const n = Number(localStorage.getItem(ZOOM_STORAGE_KEY));
      if (Number.isFinite(n)) return clamp(n, MIN_ZOOM, MAX_ZOOM);
    } catch (_) { /* ignore */ }
    return MIN_ZOOM;
  }

  _saveZoom() {
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(this._zoom)); } catch (_) { /* ignore */ }
  }

  /** Apply this._zoom to the DOM: widen the scrollable inner track, redraw ruler
   *  ticks at an appropriate density, and update the gridline spacing + controls. */
  _applyZoom() {
    const root = this.shadowRoot;
    root.querySelector(".inner").style.width = `${this._zoom * 100}%`;
    const tickSec = tickSecondsForZoom(this._zoom);
    const ticks = buildTicks(tickSec);
    root.querySelector(".ruler").innerHTML = ticks
      .map((t) => `<span style="left:${(t / DAY_SECONDS) * 100}%">${tickLabel(t)}</span>`)
      .join("");
    this.style.setProperty("--grid-cols", String(DAY_SECONDS / tickSec));
    root.querySelector(".zoom-range").value = String(this._zoom);
    root.querySelector(".zoom-label").textContent = `${Math.round(this._zoom * 100)}%`;
    root.querySelector(".zoom-out").disabled = this._zoom <= MIN_ZOOM + 1e-6;
    root.querySelector(".zoom-in").disabled = this._zoom >= MAX_ZOOM - 1e-6;
    root.querySelector(".zoom-reset").disabled = this._zoom <= MIN_ZOOM + 1e-6;
  }

  /** Change zoom level while keeping the time under `anchorClientX` (viewport-relative
   *  pointer position; defaults to the visible center) stationary on screen. */
  _setZoom(nextZoom, anchorClientX) {
    const newZoom = clamp(Math.round(nextZoom * 10) / 10, MIN_ZOOM, MAX_ZOOM);
    if (newZoom === this._zoom) return;
    const root = this.shadowRoot;
    const viewport = root.querySelector(".viewport");
    const viewportRect = viewport.getBoundingClientRect();
    const viewportWidth = viewportRect.width || 1;
    const anchorPx = typeof anchorClientX === "number"
      ? clamp(anchorClientX - viewportRect.left, 0, viewportWidth)
      : viewportWidth / 2;

    const oldLaneWidth = Math.max(1, viewportWidth * this._zoom - LABEL_WIDTH);
    const oldContentX = viewport.scrollLeft + anchorPx;
    const timeAtAnchor = clamp(((oldContentX - LABEL_WIDTH) / oldLaneWidth) * DAY_SECONDS, 0, DAY_SECONDS);

    this._zoom = newZoom;
    this._applyZoom();
    this._saveZoom();

    const newLaneWidth = Math.max(1, viewportWidth * this._zoom - LABEL_WIDTH);
    const newContentX = LABEL_WIDTH + (timeAtAnchor / DAY_SECONDS) * newLaneWidth;
    viewport.scrollLeft = newContentX - anchorPx;
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        :host{ display:block; background:var(--panel); border:1px solid var(--border); border-radius:var(--radius);
          padding:14px; overflow:hidden; }
        .toolbar{ display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-bottom:10px; }
        .toolbar .zoom-hint{ font-size:11px; color:var(--text-faint); margin-right:4px; }
        .toolbar button{ padding:4px 9px; font-size:14px; font-weight:700; line-height:1; }
        .toolbar button.ghost{ font-size:11px; font-weight:700; }
        .zoom-range{ width:120px; padding:0; border:none; background:transparent; accent-color:var(--accent); }
        .zoom-label{ font-size:11px; color:var(--text-muted); font-variant-numeric:tabular-nums; min-width:38px;
          text-align:right; }
        .scroller{ position:relative; }
        .viewport{ overflow-x:auto; overflow-y:hidden; }
        .viewport::-webkit-scrollbar{ height:10px; }
        .viewport::-webkit-scrollbar-track{ background:var(--bg-elevated); border-radius:6px; }
        .viewport::-webkit-scrollbar-thumb{ background:var(--border); border-radius:6px; }
        .viewport::-webkit-scrollbar-thumb:hover{ background:#48536a; }
        .inner{ position:relative; width:100%; }
        .ruler-row{ display:flex; }
        .label-col{ width:${LABEL_WIDTH}px; flex-shrink:0; position:sticky; left:0; z-index:4; background:var(--panel); }
        .ruler{ position:relative; flex:1; height:22px; border-bottom:1px solid var(--border); }
        .ruler span{ position:absolute; top:0; font-size:11px; color:var(--text-muted); transform:translateX(-50%);
          font-variant-numeric:tabular-nums; white-space:nowrap; }
        .ruler span:first-child{ transform:none; }
        .ruler span:last-child{ transform:translateX(-100%); }
        .tracks{ position:relative; margin-top:6px; }
        .track{ display:flex; align-items:stretch; margin-bottom:8px; }
        .track:last-child{ margin-bottom:0; }
        .track-label{ width:${LABEL_WIDTH}px; flex-shrink:0; padding-right:12px; display:flex; flex-direction:column;
          justify-content:center; font-size:12px; font-weight:800; letter-spacing:.03em; position:sticky; left:0;
          z-index:4; background:var(--panel); }
        .track-label .sub{ font-size:10px; font-weight:500; color:var(--text-muted); text-transform:none;
          letter-spacing:normal; margin-top:2px; }
        .lane{ position:relative; flex:1; height:60px; background:var(--bg-elevated); border:1px solid var(--border-soft);
          border-radius:8px; background-image:repeating-linear-gradient(to right, var(--border-soft) 0, var(--border-soft) 1px,
          transparent 1px, transparent calc(100% / var(--grid-cols, 12))); }
        .lane.drop-ok{ outline:2px solid var(--good); outline-offset:-2px; }
        .lane.drop-bad{ outline:2px solid var(--live); outline-offset:-2px; }
        .block{ position:absolute; top:4px; bottom:4px; border-radius:6px; padding:6px 10px; color:#fff; overflow:hidden;
          cursor:grab; border:1.5px solid rgba(255,255,255,.08); box-shadow:0 1px 2px rgba(0,0,0,.3); user-select:none; }
        .block:active{ cursor:grabbing; }
        .block[data-type="graphic"]{ color:var(--text); border:1.5px solid var(--border); }
        .block.selected{ outline:2px solid var(--purple); outline-offset:1px; z-index:3; }
        .block.on-air{ box-shadow:0 0 0 2px var(--purple), 0 0 16px rgba(139,92,246,.5); z-index:2; }
        .block .title{ font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .block .range{ font-size:10px; opacity:.85; margin-top:2px; white-space:nowrap; }
        .handle{ position:absolute; top:0; bottom:0; width:9px; cursor:ew-resize; }
        .handle.left{ left:0; } .handle.right{ right:0; }
        .handle:hover{ background:rgba(255,255,255,.18); }
        .playhead{ position:absolute; top:0; bottom:0; width:0; border-left:2px solid var(--live); z-index:5;
          pointer-events:none; }
        .playhead .tag{ position:absolute; top:-20px; left:0; transform:translateX(-50%); background:var(--live);
          color:#fff; font-size:10px; font-weight:800; padding:2px 8px; border-radius:4px; white-space:nowrap; }
      </style>
      <div class="toolbar">
        <span class="zoom-hint" title="Hold Ctrl/⌘ and scroll over the timeline to zoom">Zoom</span>
        <button class="zoom-out icon-btn ghost" title="Zoom out">−</button>
        <input type="range" class="zoom-range" min="${MIN_ZOOM}" max="${MAX_ZOOM}" step="0.1" value="1">
        <button class="zoom-in icon-btn ghost" title="Zoom in">+</button>
        <span class="zoom-label">100%</span>
        <button class="zoom-reset ghost" title="Reset zoom to the full day">Fit</button>
      </div>
      <div class="scroller">
        <div class="viewport">
          <div class="inner">
            <div class="ruler-row">
              <div class="label-col"></div>
              <div class="ruler"></div>
            </div>
            <div class="tracks"></div>
            <div class="playhead hidden"><div class="tag"></div></div>
          </div>
        </div>
      </div>
    `;
    this._wireZoomControls();
    this._applyZoom();
  }

  _wireZoomControls() {
    const root = this.shadowRoot;
    const viewport = root.querySelector(".viewport");
    root.querySelector(".zoom-in").addEventListener("click", () => this._setZoom(this._zoom * 1.6));
    root.querySelector(".zoom-out").addEventListener("click", () => this._setZoom(this._zoom / 1.6));
    root.querySelector(".zoom-reset").addEventListener("click", () => this._setZoom(MIN_ZOOM));
    root.querySelector(".zoom-range").addEventListener("input", (e) => this._setZoom(Number(e.target.value)));
    viewport.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // plain/shift wheel keeps native scroll/pan
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.01);
      this._setZoom(this._zoom * factor, e.clientX);
    }, { passive: false });
  }

  _laneEl(trackId) { return this.shadowRoot.querySelector(`.lane[data-track-id="${trackId}"]`); }

  _renderTracks() {
    const root = this.shadowRoot;
    const schedule = store.getActiveSchedule();
    const tracksEl = root.querySelector(".tracks");
    tracksEl.innerHTML = schedule.tracks.map((track) => `
      <div class="track">
        <div class="track-label">${escapeHtml(track.label)}<span class="sub">${escapeHtml(track.sublabel)}</span></div>
        <div class="lane" data-track-id="${track.id}"></div>
      </div>
    `).join("");

    for (const track of schedule.tracks) {
      const lane = this._laneEl(track.id);
      this._wireLaneDrop(lane, track.id);
      for (const b of track.blocks) this._renderBlock(lane, track, b);
    }
    this._updatePlayhead();
  }

  _renderBlock(lane, track, b) {
    const now = store.nowSeconds();
    const isToday = store.isToday();
    const el = document.createElement("div");
    el.className = "block";
    el.dataset.blockId = b.id;
    el.dataset.type = b.type;
    if (b.id === store.selectedBlockId) el.classList.add("selected");
    if (isToday && now >= b.start && now < b.end) el.classList.add("on-air");
    el.style.left = `${(b.start / DAY_SECONDS) * 100}%`;
    el.style.width = `${((b.end - b.start) / DAY_SECONDS) * 100}%`;
    el.style.background = blockToneStyle(b.type);
    el.innerHTML = `
      <div class="title">${escapeHtml(b.title)}</div>
      <div class="range">${secToClock(b.start)} – ${secToClock(b.end)}</div>
      <div class="handle left"></div>
      <div class="handle right"></div>
    `;
    lane.appendChild(el);
    this._wireBlockDrag(el, lane, track, b);
  }

  _wireBlockDrag(el, lane, track, b) {
    const onPointerDown = (e) => {
      const isLeftHandle = e.target.classList.contains("left");
      const isRightHandle = e.target.classList.contains("right");
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      const laneRect = lane.getBoundingClientRect();
      const startX = e.clientX;
      const originalStart = b.start;
      const originalEnd = b.end;
      let moved = false;
      let pendingStart = originalStart;
      let pendingEnd = originalEnd;

      const xToSec = (clientX) => clamp((clientX - laneRect.left) / laneRect.width, 0, 1) * DAY_SECONDS;
      const snap = (s) => Math.round(s / SNAP) * SNAP;

      // While the gesture is in progress we only touch this element's own style —
      // never the store — so a mid-drag re-render (triggered by other state changes)
      // can't yank the element out from under an active pointer capture.
      const paint = (start, end) => {
        el.style.left = `${(start / DAY_SECONDS) * 100}%`;
        el.style.width = `${((end - start) / DAY_SECONDS) * 100}%`;
        el.querySelector(".range").textContent = `${secToClock(start)} – ${secToClock(end)}`;
      };

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        if (Math.abs(dx) > 3) moved = true;
        if (isLeftHandle) {
          pendingStart = Math.max(0, Math.min(pendingEnd - SNAP, snap(xToSec(ev.clientX))));
          paint(pendingStart, pendingEnd);
        } else if (isRightHandle) {
          pendingEnd = Math.min(DAY_SECONDS, Math.max(pendingStart + SNAP, snap(xToSec(ev.clientX))));
          paint(pendingStart, pendingEnd);
        } else if (moved) {
          const duration = originalEnd - originalStart;
          const deltaSec = (dx / laneRect.width) * DAY_SECONDS;
          pendingStart = Math.max(0, Math.min(DAY_SECONDS - duration, snap(originalStart + deltaSec)));
          pendingEnd = pendingStart + duration;
          paint(pendingStart, pendingEnd);
        }
      };
      const onUp = () => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        if (isLeftHandle) store.resizeBlock(b.id, "start", pendingStart);
        else if (isRightHandle) store.resizeBlock(b.id, "end", pendingEnd);
        else if (moved) store.moveBlock(b.id, pendingStart);
        else store.selectBlock(b.id);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp, { once: true });
    };
    el.addEventListener("pointerdown", onPointerDown);
  }

  _wireLaneDrop(lane, trackId) {
    lane.addEventListener("dragover", (e) => {
      if (![...e.dataTransfer.types].includes("application/x-cf-media")) return;
      e.preventDefault();
      lane.classList.add("drop-ok");
    });
    lane.addEventListener("dragleave", () => lane.classList.remove("drop-ok", "drop-bad"));
    lane.addEventListener("drop", (e) => {
      e.preventDefault();
      lane.classList.remove("drop-ok", "drop-bad");
      const mediaId = e.dataTransfer.getData("application/x-cf-media");
      const item = store.media.find((m) => m.id === mediaId);
      if (!item) return;
      if (!LABEL_ACCEPT[trackId].has(item.type)) {
        toast(`"${item.title}" (${item.type}) can't be placed on the ${trackId} track.`, "danger");
        return;
      }
      const rect = lane.getBoundingClientRect();
      const dropSec = Math.round((clamp((e.clientX - rect.left) / rect.width, 0, 1) * DAY_SECONDS) / SNAP) * SNAP;
      const duration = Number.isFinite(item.duration) ? Math.round(item.duration) : item.type === "live" ? 1800 : 60;
      const start = Math.min(DAY_SECONDS - duration, dropSec);
      const created = store.addBlock(trackId, {
        title: item.title, type: item.type, start, end: start + duration,
        source: item.type === "live" ? item.title : (item.driveFileId ? "Drive segment" : "Video File"),
        url: item.url, driveFileId: item.driveFileId || null,
      });
      if (created) store.selectBlock(created.id);
      toast(`Added "${item.title}" to ${trackId}`, "good");
    });
  }

  _updatePlayhead() {
    const root = this.shadowRoot;
    const playhead = root.querySelector(".playhead");
    if (!store.isToday()) { playhead.classList.add("hidden"); return; }
    playhead.classList.remove("hidden");
    const now = store.nowSeconds();
    // The label column is a fixed 150px; the lane occupies the remaining width of
    // the (possibly zoomed-in, wider-than-viewport) inner scroll content.
    playhead.style.left = `calc(${LABEL_WIDTH}px + (100% - ${LABEL_WIDTH}px) * ${now / DAY_SECONDS})`;
    playhead.querySelector(".tag").textContent = `NOW ${secToClock(now)}`;
    root.querySelectorAll(".block.on-air").forEach((el) => el.classList.remove("on-air"));
    const isToday = store.isToday();
    if (isToday) {
      root.querySelectorAll(".block").forEach((el) => {
        const found = store.findBlock(el.dataset.blockId);
        if (found && now >= found.block.start && now < found.block.end) el.classList.add("on-air");
      });
    }
  }
}
customElements.define("cf-timeline", CfTimeline);
