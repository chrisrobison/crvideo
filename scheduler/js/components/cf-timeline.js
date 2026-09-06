import { store } from "../store.js";
import { baseComponentCSS, escapeHtml, secToClock, DAY_SECONDS, clamp } from "../utils.js";
import { toast } from "../utils.js";

const HOURS = Array.from({ length: 13 }, (_, i) => i * 2); // 0,2,...24
const SNAP = 30; // seconds
const LABEL_ACCEPT = {
  program: new Set(["video", "audio", "graphic", "live"]),
  graphics: new Set(["graphic"]),
  live: new Set(["live"]),
};

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

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${baseComponentCSS}
        :host{ display:block; background:var(--panel); border:1px solid var(--border); border-radius:var(--radius);
          padding:14px; overflow:hidden; }
        .scroller{ position:relative; }
        .ruler-row{ display:flex; }
        .label-col{ width:150px; flex-shrink:0; }
        .ruler{ position:relative; flex:1; height:22px; border-bottom:1px solid var(--border); }
        .ruler span{ position:absolute; top:0; font-size:11px; color:var(--text-muted); transform:translateX(-50%);
          font-variant-numeric:tabular-nums; }
        .ruler span:first-child{ transform:none; }
        .ruler span:last-child{ transform:translateX(-100%); }
        .tracks{ position:relative; margin-top:6px; }
        .track{ display:flex; align-items:stretch; margin-bottom:8px; }
        .track:last-child{ margin-bottom:0; }
        .track-label{ width:150px; flex-shrink:0; padding-right:12px; display:flex; flex-direction:column;
          justify-content:center; font-size:12px; font-weight:800; letter-spacing:.03em; }
        .track-label .sub{ font-size:10px; font-weight:500; color:var(--text-muted); text-transform:none;
          letter-spacing:normal; margin-top:2px; }
        .lane{ position:relative; flex:1; height:60px; background:var(--bg-elevated); border:1px solid var(--border-soft);
          border-radius:8px; background-image:repeating-linear-gradient(to right, var(--border-soft) 0, var(--border-soft) 1px,
          transparent 1px, transparent calc(100%/12)); }
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
      <div class="scroller">
        <div class="ruler-row">
          <div class="label-col"></div>
          <div class="ruler">
            ${HOURS.map((h) => `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, "0")}:00</span>`).join("")}
          </div>
        </div>
        <div class="tracks"></div>
        <div class="playhead hidden"><div class="tag"></div></div>
      </div>
    `;
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
        source: item.type === "live" ? item.title : "Video File", url: item.url,
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
    // The label column is a fixed 150px; the lane occupies the remaining width.
    playhead.style.left = `calc(150px + (100% - 150px) * ${now / DAY_SECONDS})`;
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
