// explorer-browser.js -- <explorer-browser>: the Finder-style columns. It only
// reads the store and calls its navigation methods; it owns no data. Columns
// are listboxes with roving focus:
//   Up/Down/Home/End  move focus within a column
//   Right / Enter / Space  select the focused item (Right then moves into the next column)
//   Enter on the already-selected item (or double-click)  open its editor
//   Left  move to the previous column

import * as M from "./explorer-model.js";
import { esc, thumb, icons, explorerCSS, fmtDuration, fmtDateTime, fmtBytes, plural, titleCase } from "./explorer-ui.js";
import { handoff } from "./explorer-actions.js";
import { ruleText } from "./explorer-channel.js";

const STEP = 200;

// ---------- column builders (pure reads of the store) ----------

const dot = (tone) => `<i class="dot" data-tone="${tone}"></i>`;

function channelsColumn(store) {
  const { data: d, route: r } = store;
  const items = (d.channels || []).map((c) => {
    const sv = store.scheduleView(c.id);
    const st = sv ? M.channelStatus(sv, store.clock()) : null;
    const tone = !st ? (d.scheduleErrors.has(c.id) ? "bad" : "muted") : { "scheduled-now": "info", continuity: "info", gap: "warn", "out-of-range": "warn" }[st.code] || "muted";
    const label = st ? st.label : d.scheduleErrors.has(c.id) ? "Schedule unavailable" : "Loading schedule…";
    return { key: c.id, title: c.name, sub: `${dot(tone)}${esc(label)}`, subHtml: true, thumb: c.logoUrl, label: c.name };
  });
  return { id: "channels", title: "Channels", count: items.length, items, selected: r.channel, loading: !d.channels && !store.errors.has("channels"), error: store.errors.get("channels"), empty: "No channels found." };
}

function showsColumn(store) {
  const { data: d, route: r } = store;
  let items;
  if (r.channel) {
    items = store.seriesOfChannel(r.channel).map((s) => ({
      key: s.id, title: s.row?.title || s.id, thumb: s.row?.thumbnail_url,
      sub: `${s.row ? plural(s.row.episode_count, "episode") : "…"} · ${s.blocks.length ? plural(s.blocks.length, "block") : "catalog only"}`,
    }));
  } else {
    items = [...(d.seriesIndex?.values() || [])].map((s) => ({
      key: s.id, title: s.title, thumb: s.thumbnail_url,
      sub: `${plural(s.episode_count, "episode")} · ${plural(store.carriersOf(s.id).length, "channel")}`,
    }));
  }
  items.sort((a, b) => a.title.localeCompare(b.title));
  return { id: "series", title: r.channel ? "Shows" : "All shows", count: items.length, items, selected: r.series, loading: !d.seriesIndex && !store.errors.has("series-index"), error: store.errors.get("series-index"), empty: r.channel ? "This channel's catalog carries no series." : "No series found." };
}

function episodesColumn(store) {
  const { route: r } = store;
  const detail = store.seriesDetail();
  const items = (detail?.episodes || []).map((e) => ({
    key: e.id, title: e.title, thumb: e.thumbnail_url,
    sub: `${e.episode_number != null ? `E${e.episode_number} · ` : ""}${e.duration != null ? fmtDuration(e.duration) : "—"}`,
    badge: e.status ? { label: e.status, tone: { approved: "good", candidate: "warn", rejected: "bad" }[e.status] || "muted" } : null,
  }));
  return { id: "episodes", title: "Episodes", count: detail ? items.length : null, items, selected: r.episode, loading: !detail && !store.errors.has(`series:${r.series}`), error: store.errors.get(`series:${r.series}`), empty: "This series has no episodes." };
}

function scheduleColumn(store) {
  const { route: r } = store;
  const sv = store.scheduleView(r.channel);
  const t = store.effectiveT();
  const items = sv ? M.channelAirings(sv, t - 1, t + 24 * 3600, { limit: 60 }).map((a) => ({
    key: String(a.startsAt), title: a.title, thumb: a.thumbnailUrl,
    sub: `${fmtDateTime(a.startsAt)} · ${fmtDuration(a.duration)}`,
    badge: a.startsAt <= t && a.endsAt > t ? { label: r.t === null ? "Scheduled now" : "At selected time", tone: "info" } : null,
  })) : [];
  const err = store.data.scheduleErrors.get(r.channel);
  return { id: "schedule", title: "Schedule", count: sv ? items.length : null, items, selected: r.airing !== null ? String(r.airing) : null, loading: !sv && !err, error: err, empty: sv && !M.locateAt(sv, t).state.startsWith("ok") ? "The selected time is outside the published window." : "Nothing published in the next 24 hours." };
}

function airingsColumn(store) {
  const { route: r } = store;
  const t = store.effectiveT();
  let list;
  if (r.episode) list = store.airingsOfEpisode(r.series, r.episode);
  else {
    const carriers = r.channel ? store.carriersOf(r.series).filter((c) => c.channelId === r.channel) : store.carriersOf(r.series);
    list = carriers.flatMap((c) => M.seriesAirings(store.scheduleView(c.channelId), r.series, { from: t, limit: 80 })).sort((a, b) => a.startsAt - b.startsAt).slice(0, 120);
  }
  const loading = store.carriersOf(r.series).some((c) => !store.scheduleView(c.channelId) && !store.data.scheduleErrors.has(c.channelId));
  const items = list.map((a) => ({
    key: `${a.channelId}@${a.startsAt}`, title: r.episode ? fmtDateTime(a.startsAt) : a.title,
    sub: `${store.channel(a.channelId)?.name || a.channelId} · ${r.episode ? fmtDuration(a.duration) : fmtDateTime(a.startsAt)}`,
    badge: a.startsAt <= t && a.endsAt > t ? { label: "At selected time", tone: "info" } : a.endsAt <= t ? { label: "Earlier", tone: "muted" } : { label: "Scheduled", tone: "good" },
    data: { channel: a.channelId, start: a.startsAt },
  }));
  return { id: "airings", title: r.episode ? "Airings" : "Upcoming airings", count: items.length, items, selected: r.airing !== null ? `${r.channel}@${r.airing}` : null, loading: loading && !items.length, empty: "No published airings (in the loaded schedules).", dataAct: "airing" };
}

const CATEGORIES = [
  { id: "bumps", label: "Bumps", icon: "bump" },
  { id: "announcements", label: "Voiceover announcements", icon: "voice" },
  { id: "music", label: "Music", icon: "music" },
  { id: "ambience", label: "Ambience", icon: "music" },
  { id: "video", label: "Background videos", icon: "video" },
  { id: "image", label: "Images", icon: "image" },
];

export function categoryItems(store, cat) {
  const d = store.data;
  if (cat === "bumps") return (d.bumps || []).map((b) => ({ key: `bump:${b.id}`, title: b.name || b.id, sub: b.description || "Bump", ref: { kind: "bump", id: b.id } }));
  if (cat === "announcements") {
    return Object.entries(d.allAnnouncements || {}).flatMap(([cid, list]) => list.map((a) => ({
      key: `announcement:${cid}:${a.id}`, title: a.text || a.id, sub: `${store.channel(cid)?.name || cid} · ${titleCase(a.type)}${a.duration ? ` · ${fmtDuration(a.duration)}` : ""}`, ref: { kind: "announcement", channelId: cid, id: a.id },
      badge: a.status !== "ready" ? { label: a.status || "unknown", tone: "warn" } : null,
    })));
  }
  return (d.media?.[cat] || []).map((m) => ({ key: `media:${m.url}`, title: m.name, sub: `${fmtBytes(m.bytes)} · ${m.url}`, ref: { kind: "media", path: m.url } }));
}

function categoryCount(store, cat) {
  const d = store.data;
  if (cat === "bumps") return d.bumps ? d.bumps.length : null;
  if (cat === "announcements") return d.allAnnouncements ? Object.values(d.allAnnouncements).reduce((n, l) => n + l.length, 0) : null;
  return d.media ? (d.media[cat] || []).length : null;
}

function librariesColumn(store) {
  const items = CATEGORIES.map((c) => ({ key: c.id, title: c.label, sub: (n => n === null ? "…" : plural(n, "asset"))(categoryCount(store, c.id)), icon: icons[c.icon], n: categoryCount(store, c.id) }))
    .filter((c) => c.n !== 0 || c.key === "bumps");
  return { id: "libraries", title: "Production", count: items.length, items, selected: store.route.cat, loading: false, empty: "" };
}

function assetsColumn(store) {
  const cat = store.route.cat;
  const items = categoryItems(store, cat);
  const sel = store.route.asset ? (store.route.asset.kind === "bump" ? `bump:${store.route.asset.id}` : store.route.asset.kind === "announcement" ? `announcement:${store.route.asset.channelId}:${store.route.asset.id}` : `media:${store.route.asset.path}`) : null;
  const loading = ["bumps", "media", "all-announcements"].some((k) => store.loading.has(k)) && !items.length;
  return { id: "assets", title: CATEGORIES.find((c) => c.id === cat)?.label || "Assets", count: items.length, items, selected: sel, loading, error: store.errors.get("bumps") || store.errors.get("media") || store.errors.get("all-announcements"), empty: "Nothing in this library." };
}

function usageColumn(store) {
  const a = store.route.asset;
  const idx = store.indexes();
  let items = [];
  if (a?.kind === "bump") items = (idx.bumpUsage.get(a.id) || []).map((u) => ({ key: `${u.channelId}:${u.ruleIndex}`, title: u.channelName, sub: ruleText(u.rule) + (u.enabled ? "" : " · scheduling OFF"), data: { channel: u.channelId } }));
  else if (a?.kind === "announcement") {
    const rec = idx.announcements.byKey.get(`${a.channelId}:${a.id}`);
    items = rec ? M.bumpsUsingAnnouncement(store.data.bumps || [], rec).map((b) => ({ key: `bump:${b.id}`, title: b.name || b.id, sub: "bump embedding this clip", data: { asset: `bump:${b.id}` } })) : [];
  } else if (a?.kind === "media") items = (idx.mediaUsage.get(M.normalizeMediaPath(a.path)) || []).map((u) => ({ key: `bump:${u.bumpId}:${u.role}`, title: u.bumpId, sub: `as ${u.role}`, data: { asset: `bump:${u.bumpId}` } }));
  return { id: "usage", title: "Where used", count: items.length, items, selected: null, loading: false, empty: a ? "No reference found." : "", dataAct: "usage" };
}

export function buildColumns(store) {
  const r = store.route;
  if (r.mode === "production") {
    const cols = [librariesColumn(store)];
    if (r.cat) cols.push(assetsColumn(store));
    if (r.asset) cols.push(usageColumn(store));
    return cols;
  }
  const cols = [channelsColumn(store), showsColumn(store)];
  if (r.series) cols.push(episodesColumn(store));
  else if (r.channel) cols.push(scheduleColumn(store));
  if (r.series) cols.push(airingsColumn(store));
  return cols;
}

// ---------- element ----------

class ExplorerBrowser extends HTMLElement {
  constructor() {
    super();
    this.limits = new Map();
    this.scroll = new Map();
    this._pendingFocus = null;
  }

  set store(s) { this._store = s; this.render(); }

  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${explorerCSS}${STYLE}</style><div class="cols" role="group" aria-label="Explorer columns"></div>`;
    const root = this.shadowRoot;
    root.addEventListener("click", (e) => this._onClick(e));
    root.addEventListener("dblclick", (e) => this._onDblClick(e));
    root.addEventListener("keydown", (e) => this._onKey(e));
    this.render();
  }

  render() {
    if (!this._store || !this.shadowRoot) return;
    const store = this._store;
    const wrap = this.shadowRoot.querySelector(".cols");
    // remember scroll + focus so a background data load doesn't disturb either
    wrap.querySelectorAll(".col").forEach((c) => this.scroll.set(c.dataset.col, c.querySelector(".list")?.scrollTop || 0));
    const hadFocus = this.shadowRoot.activeElement?.closest?.(".item");
    const focusKey = hadFocus ? { col: hadFocus.dataset.col, key: hadFocus.dataset.key } : this._pendingFocus;
    this._pendingFocus = null;
    const hScroll = wrap.scrollLeft;

    const cols = buildColumns(store);
    wrap.innerHTML = cols.map((c) => this._colHtml(c)).join("");
    wrap.querySelectorAll(".col").forEach((c) => { const l = c.querySelector(".list"); if (l) l.scrollTop = this.scroll.get(c.dataset.col) || 0; });
    wrap.scrollLeft = hScroll;
    // The selection changed: keep the newest column fully in view (the Inspector stays put).
    const routeKey = JSON.stringify([store.route.mode, store.route.channel, store.route.series, store.route.episode, store.route.airing, store.route.cat, store.route.asset]);
    if (routeKey !== this._routeKey) { this._routeKey = routeKey; this._routeAt = performance.now(); }
    // Re-check for a short settle window after each selection: columns fill in as data arrives.
    if (performance.now() - (this._routeAt || 0) < 4000) {
      const els = [...wrap.querySelectorAll(".col")];
      const last = els[els.length - 1];
      if (last && els.length > 1 && last.offsetLeft + last.offsetWidth > wrap.clientWidth + wrap.scrollLeft - 2) {
        let left = 0, used = 0;
        for (let i = els.length - 1; i >= 0; i--) { used += els[i].offsetWidth + 10; if (used > wrap.clientWidth) { left = els[i + 1]?.offsetLeft ?? els[i].offsetLeft; break; } }
        wrap.scrollTo({ left, behavior: "smooth" });
      }
    }
    if (focusKey) this.focusItem(focusKey.col, focusKey.key);
  }

  _colHtml(c) {
    const limitKey = `${c.id}`;
    let limit = this.limits.get(limitKey) || STEP;
    const selIdx = c.items.findIndex((i) => i.key === c.selected);
    if (selIdx >= limit) { limit = selIdx + 1; this.limits.set(limitKey, limit); }
    const shown = c.items.slice(0, limit);
    const tabbable = c.selected && shown.some((i) => i.key === c.selected) ? c.selected : shown[0]?.key;
    const body = c.error ? `<p class="note bad" style="margin:8px">${esc(c.error)}</p>`
      : c.loading ? `<p class="empty" style="padding:12px">Loading…</p>`
      : !shown.length ? (c.empty ? `<p class="empty" style="padding:12px">${esc(c.empty)}</p>` : "")
      : shown.map((i) => `
        <button class="item" role="option" tabindex="${i.key === tabbable ? 0 : -1}" aria-selected="${i.key === c.selected}"
          data-col="${c.id}" data-key="${esc(i.key)}" ${i.data ? `data-extra="${esc(JSON.stringify(i.data))}"` : ""}>
          ${i.icon ? `<span class="ic">${i.icon}</span>` : thumb(i.thumb, i.label || i.title)}
          <span class="grow"><span class="t">${esc(i.title)}</span><span class="s">${i.subHtml ? i.sub : esc(i.sub || "")}</span>${i.badge ? `<span class="bd"><span class="pill" data-tone="${i.badge.tone}">${esc(titleCase(i.badge.label))}</span></span>` : ""}</span>
          ${c.id !== "airings" && c.id !== "usage" ? `<span class="chev">${icons.chevron}</span>` : ""}
        </button>`).join("") + (c.items.length > shown.length ? `<button class="more" data-act="col-more" data-col="${c.id}">Show ${Math.min(STEP, c.items.length - shown.length)} more of ${c.items.length - shown.length}</button>` : "");
    return `
      <section class="col" data-col="${c.id}" aria-label="${esc(c.title)}">
        <header><span>${esc(c.title)}</span>${c.count != null ? `<i>${c.count}</i>` : ""}</header>
        <div class="list" role="listbox" aria-label="${esc(c.title)}">${body}</div>
      </section>`;
  }

  focusItem(col, key) {
    const list = this.shadowRoot?.querySelector(`.col[data-col="${col}"] .list`);
    if (!list) return false;
    const el = [...list.querySelectorAll(".item")].find((i) => i.dataset.key === key) || list.querySelector(".item[aria-selected=true]") || list.querySelector(".item");
    el?.focus({ preventScroll: false });
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    return !!el;
  }

  /** Focus the column named `id` (used by inspector actions like "View All Episodes"). */
  focusColumn(id) {
    const col = this.shadowRoot?.querySelector(`.col[data-col="${id}"]`);
    if (!col) return;
    col.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    (col.querySelector(".item[aria-selected=true]") || col.querySelector(".item"))?.focus();
  }

  // ---- interaction ----

  _select(el) {
    const s = this._store;
    const { col, key } = el.dataset;
    const extra = el.dataset.extra ? JSON.parse(el.dataset.extra) : {};
    if (col === "channels") s.selectChannel(key);
    else if (col === "series") s.selectSeries(key);
    else if (col === "episodes") s.selectEpisode(key);
    else if (col === "schedule") s.selectAiring(s.route.channel, Number(key));
    else if (col === "airings") s.selectAiring(extra.channel, Number(extra.start));
    else if (col === "libraries") s.setCategory(key);
    else if (col === "assets") { const item = categoryItems(s, s.route.cat).find((i) => i.key === key); if (item) s.selectAsset(item.ref); }
    else if (col === "usage") {
      if (extra.channel) s.go({ mode: "programs", channel: extra.channel, series: null, episode: null, airing: null, cat: null, asset: null });
      else if (extra.asset) { const [, id] = extra.asset.split(":"); s.selectAsset({ kind: "bump", id }); }
    }
  }

  _open(el) {
    const s = this._store;
    const { col, key } = el.dataset;
    if (col === "channels") handoff.programming(key);
    else if (col === "series") handoff.seriesReview(key);
    else if (col === "episodes") handoff.seriesReview(s.route.series, key);
    else if (col === "schedule" || col === "airings") handoff.programming(s.route.channel || JSON.parse(el.dataset.extra || "{}").channel);
    else if (col === "assets") {
      const ref = s.route.asset;
      if (ref?.kind === "bump") handoff.bumpCompose(ref.id);
      else if (ref?.kind === "announcement") handoff.programming(ref.channelId);
    }
  }

  _onClick(e) {
    const more = e.target.closest("[data-act=col-more]");
    if (more) { const k = more.dataset.col; this.limits.set(k, (this.limits.get(k) || STEP) + STEP); this._pendingFocus = null; this.render(); return; }
    const el = e.target.closest(".item");
    if (el) this._select(el);
  }

  _onDblClick(e) {
    const el = e.target.closest(".item");
    if (el) this._open(el);
  }

  _onKey(e) {
    const el = e.target.closest?.(".item");
    if (!el) return;
    const list = el.closest(".list");
    const items = [...list.querySelectorAll(".item")];
    const i = items.indexOf(el);
    const go = (n) => { const t = items[Math.max(0, Math.min(items.length - 1, n))]; t?.focus(); t?.scrollIntoView?.({ block: "nearest" }); items.forEach((x) => x.tabIndex = x === t ? 0 : -1); };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); go(i + 1); break;
      case "ArrowUp": e.preventDefault(); go(i - 1); break;
      case "Home": e.preventDefault(); go(0); break;
      case "End": e.preventDefault(); go(items.length - 1); break;
      case "ArrowLeft": {
        e.preventDefault();
        const prev = el.closest(".col").previousElementSibling;
        (prev?.querySelector(".item[aria-selected=true]") || prev?.querySelector(".item"))?.focus();
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        if (el.getAttribute("aria-selected") !== "true") this._select(el);
        // the next column is rendered by the store's change; focus it right after
        queueMicrotask(() => setTimeout(() => {
          const next = this.shadowRoot.querySelector(`.col[data-col="${el.dataset.col}"]`)?.nextElementSibling;
          (next?.querySelector(".item[aria-selected=true]") || next?.querySelector(".item"))?.focus();
        }, 0));
        break;
      }
      case "Enter":
      case " ":
        e.preventDefault();
        if (e.key === "Enter" && el.getAttribute("aria-selected") === "true") this._open(el);
        else { this._pendingFocus = { col: el.dataset.col, key: el.dataset.key }; this._select(el); }
        break;
      default:
    }
  }
}

const STYLE = `
  :host{ display:block; height:100%; min-width:0; }
  .cols{ display:flex; gap:10px; height:100%; overflow-x:auto; overflow-y:hidden; padding:0 2px 2px; }
  .col{ flex:0 0 clamp(230px, 22vw, 290px); min-width:0; display:flex; flex-direction:column; background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); }
  .col > header{ display:flex; align-items:center; gap:8px; padding:10px 12px; font-size:11.5px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; border-bottom:1px solid var(--border-soft); }
  .col > header i{ font-style:normal; font-weight:700; background:var(--panel-3); color:var(--text-muted); border-radius:999px; padding:0 7px; font-size:11px; }
  .list{ flex:1; min-height:0; overflow-y:auto; padding:6px; display:flex; flex-direction:column; gap:3px; }
  .item{ display:flex; align-items:center; gap:10px; width:100%; text-align:left; background:transparent; border:1px solid transparent; border-radius:8px; padding:7px 8px; }
  .item:hover{ background:var(--panel-2); border-color:var(--border-soft); }
  .item[aria-selected="true"]{ background:var(--accent-soft); border-color:var(--accent-dim); }
  .item .grow{ flex:1; min-width:0; }
  .item .t{ display:block; font-size:13px; font-weight:650; line-height:1.25; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .item .s{ display:block; font-size:11.5px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:1px; }
  .item .chev{ color:var(--text-faint); display:flex; }
  .item .ic{ width:36px; height:36px; display:grid; place-items:center; background:var(--panel-3); border-radius:8px; color:var(--text-muted); flex:0 0 auto; }
  .dot{ display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:6px; background:var(--text-faint); vertical-align:middle; }
  .dot[data-tone="info"]{ background:#60a5fa; } .dot[data-tone="warn"]{ background:var(--warn); } .dot[data-tone="bad"]{ background:var(--live); }
  .bd{ display:block; margin-top:3px; }
  .more{ margin:6px; font-size:12px; }
`;

customElements.define("explorer-browser", ExplorerBrowser);
