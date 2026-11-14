// channels/viewer/browse-page.js -- browse.html: the viewer's Finder. Search and
// browse every show on the network as posters, a sortable list, or grouped by
// channel. It is a TV guide's index, not a video library: nothing here plays a
// chosen episode -- cards say when a show is next on, and "WATCH NOW" appears
// only while it is actually airing. Show data comes from channels/finder.php;
// "when" is derived from the published schedules (viewer/model.js).

import "./nav.js";
import { now } from "../broadcast.js";
import { startClock, loadChannelMetas, loadChannels, loadShowIndex, urls } from "./data.js";
import {
  buildScheduleIndex, airStatus, filterShows, sortRows, onAirNow, timeLabel, whenLabel, untilLabel,
  AIRING_FILTERS,
} from "./model.js";
import { $, el, link, showArt, channelMark, livePill, param, replaceParams } from "./ui.js";

const page = $("#page");
const VIEWS = [["posters", "▦ Posters"], ["list", "☷ List"], ["channels", "≡ By channel"]];
const AIRING_KEYS = AIRING_FILTERS.map(([k]) => k);

let metas = [], metaById = new Map(), channelById = new Map(), shows = [], scheduleIndex = new Map();
let state;
const ui = {};

init();

async function init() {
  await startClock();
  const [metaResult, index] = await Promise.all([loadChannelMetas().catch(() => []), loadShowIndex()]);
  metas = metaResult;
  metaById = new Map(metas.map((m) => [m.id, m]));
  shows = index.shows;

  const sort = param("sort");
  state = {
    q: param("q"),
    ch: metaById.has(param("ch")) ? param("ch") : "",
    airing: AIRING_KEYS.includes(param("airing")) ? param("airing") : "any",
    view: VIEWS.some(([v]) => v === param("view")) ? param("view") : "posters",
    sort: ["show", "channel", "next", "episodes"].includes(sort) ? sort : "",
    dir: param("dir") === "desc" ? -1 : 1,
  };

  buildChrome(index.failed);
  if (index.failed || !shows.length) {
    ui.results.replaceChildren(el("div", "empty", index.failed ? "The show list is unavailable right now. Try again in a moment." : "No shows are on the network yet."));
    return;
  }
  ui.results.replaceChildren(el("div", "empty", "Checking the schedule…"));
  await refreshSchedule();
  render();
  setInterval(async () => { await refreshSchedule(); render(); }, 60000);
}

async function refreshSchedule() {
  // Loaded once; timelines are pure functions of the clock, so re-indexing is cheap.
  if (!channelById.size) channelById = new Map((await loadChannels(metas)).map((c) => [c.id, c]));
  scheduleIndex = buildScheduleIndex([...channelById.values()], now());
}

// ---------- controls ----------

function buildChrome() {
  page.replaceChildren();
  const head = el("div", "finder-head");
  const left = el("div");
  left.append(
    el("div", "eyebrow", "CRVideo Finder"),
    el("h1", "title", "Find something worth tuning in for."),
    el("p", "subtle", "Browse the network independently of the clock. The schedule still decides when you can watch it."),
  );
  head.append(left, el("span", "pill", "Live TV, not on-demand"));

  const box = el("label", "searchbox");
  ui.q = el("input");
  ui.q.type = "search";
  ui.q.value = state.q;
  ui.q.placeholder = "Search shows, descriptions, channels…";
  ui.q.setAttribute("aria-label", "Search shows");
  ui.q.autocomplete = "off";
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  box.append(el("span", "glass", "⌕"), ui.q, el("span", "kbd", mac ? "⌘ K" : "Ctrl K"));
  ui.q.addEventListener("input", () => { state.q = ui.q.value; sync(); });
  ui.q.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (ui.q.value) { ui.q.value = ""; state.q = ""; sync(); } else ui.q.blur();
  });
  addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
    if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
      e.preventDefault();
      ui.q.focus();
      ui.q.select();
    }
  });

  const controls = el("div", "controls");
  const filters = el("div", "filters");
  ui.ch = el("select", "filter");
  ui.ch.setAttribute("aria-label", "Channel");
  ui.ch.append(new Option("All channels", ""));
  for (const m of metas) ui.ch.append(new Option(m.number != null ? `${m.number} · ${m.name}` : m.name, m.id));
  ui.ch.value = state.ch;
  ui.ch.addEventListener("change", () => { state.ch = ui.ch.value; sync(); });
  ui.airing = el("select", "filter");
  ui.airing.setAttribute("aria-label", "Airing");
  for (const [k, label] of AIRING_FILTERS) ui.airing.append(new Option(label, k));
  ui.airing.value = state.airing;
  ui.airing.addEventListener("change", () => { state.airing = ui.airing.value; sync(); });
  filters.append(ui.ch, ui.airing);

  const end = el("div", "controls-end");
  ui.count = el("span", "resultcount");
  const views = el("div", "views");
  views.setAttribute("role", "group");
  views.setAttribute("aria-label", "View");
  ui.viewButtons = VIEWS.map(([v, label]) => {
    const b = el("button", null, label);
    b.type = "button";
    b.addEventListener("click", () => { state.view = v; sync(); });
    views.append(b);
    return [v, b];
  });
  end.append(ui.count, views);
  controls.append(filters, end);

  ui.results = el("div");
  ui.results.setAttribute("aria-live", "polite");
  page.append(head, box, controls, ui.results);
}

/** Pushes state into the URL and redraws. */
function sync() {
  replaceParams({
    q: state.q.trim(), ch: state.ch, airing: state.airing === "any" ? "" : state.airing,
    view: state.view === "posters" ? "" : state.view,
    sort: state.view === "list" ? state.sort : "", dir: state.view === "list" && state.sort && state.dir < 0 ? "desc" : "",
  });
  render();
}

// ---------- results ----------

const channelNameOf = (id) => metaById.get(id)?.name ?? id;
const statusOf = (show, channelId = null) => {
  const list = scheduleIndex.get(show.id);
  return airStatus(channelId ? list?.filter((x) => x.channelId === channelId) : list, now());
};

function render() {
  const t = now();
  if (!ui.results || !state) return;
  const rows = filterShows(shows, (s) => statusOf(s), { q: state.q, channel: state.ch, airing: state.airing, channelNameOf, nowSec: t });
  ui.count.textContent = `${rows.length} show${rows.length === 1 ? "" : "s"}`;
  for (const [v, b] of ui.viewButtons) b.setAttribute("aria-pressed", String(v === state.view));

  if (!rows.length) {
    ui.results.replaceChildren(el("div", "empty", "No shows match. Try a different search or clear a filter."));
    return;
  }
  if (state.view === "list") ui.results.replaceChildren(renderList(rows, t));
  else if (state.view === "channels") ui.results.replaceChildren(...renderGroups(rows, t));
  else ui.results.replaceChildren(renderPosters(rows, t));
}

/** "10 PM" for something later today, "Sat 10:00 AM" etc. otherwise. */
const compactWhen = (at, t) => whenLabel(at, t).replace(/^Today /, "");

/** Which channel a card should open the show page in. */
function contextChannel(row, forced = null) {
  return forced || row.status.onNow?.channelId || row.status.next?.channelId
    || (row.show.channels.includes(state.ch) ? state.ch : row.show.channels[0]);
}

function airLine(status, t, className = "air") {
  const p = el("div", className);
  if (status.onNow) {
    p.append(el("b", null, "On now"), ` until ${timeLabel(status.onNow.endsAt)}`);
    if (status.again) p.append(` · again ${compactWhen(status.again.startsAt, t)}`);
  } else if (status.next) {
    p.append("Next airs ", el("b", null, whenLabel(status.next.startsAt, t)));
  } else {
    p.append("Not currently scheduled");
  }
  return p;
}

function renderPosters(rows, t) {
  const grid = el("div", "cards");
  for (const row of rows) {
    const { show, status } = row;
    const ch = contextChannel(row);
    const card = link(urls.show(show.id, ch), "showcard");
    const art = showArt(show, "showart");
    if (status.onNow) art.append(livePill("WATCH NOW"));
    card.append(art, el("h3", null, show.title), airLine(status, t));
    const chip = el("div", "channel-chip");
    chip.append(el("i"), channelNameOf(ch) + (show.channels.length > 1 ? ` +${show.channels.length - 1}` : ""));
    card.append(chip);
    grid.append(card);
  }
  return grid;
}

function renderList(rows, t) {
  const sorted = state.sort ? sortRows(rows, state.sort, state.dir, channelNameOf) : rows;
  const wrap = el("div", "list-wrap");
  const table = el("table", "list");
  const thead = el("thead");
  const hr = el("tr");
  for (const [key, label] of [["show", "Show"], ["channel", "Channel"], ["next", "Next airing"], ["episodes", "Episodes"]]) {
    const th = el("th");
    th.scope = "col";
    th.setAttribute("aria-sort", state.sort === key ? (state.dir > 0 ? "ascending" : "descending") : "none");
    const b = el("button", null, label);
    b.type = "button";
    b.addEventListener("click", () => {
      state.dir = state.sort === key ? -state.dir : 1;
      state.sort = key;
      sync();
    });
    th.append(b);
    hr.append(th);
  }
  thead.append(hr);

  const tbody = el("tbody");
  for (const row of sorted) {
    const { show, status } = row;
    const ch = contextChannel(row);
    const href = urls.show(show.id, ch);
    const tr = el("tr", "row");
    tr.addEventListener("click", (e) => { if (!e.target.closest("a")) location.href = href; });

    const info = el("div", "list-show");
    const text = el("div");
    const title = link(href, null);
    title.append(el("h3", null, show.title));
    text.append(title);
    if (show.description) text.append(el("p", null, show.description));
    info.append(showArt(show), text);
    const tdShow = el("td");
    tdShow.append(info);

    const m = metaById.get(ch);
    const tdChan = el("td", "muted", m ? (m.number != null ? `${m.number} · ${m.name}` : m.name) : "");
    if (show.channels.length > 1) tdChan.append(` +${show.channels.length - 1}`);

    const tdNext = el("td");
    const next = el("div", "nextair");
    if (status.onNow) {
      next.append(livePill("ON NOW"));
      if (status.again) next.append(el("small", null, `Again ${compactWhen(status.again.startsAt, t)}`));
    } else if (status.next) {
      next.append(el("b", null, whenLabel(status.next.startsAt, t)), el("small", null, untilLabel(status.next.startsAt - t)));
    } else {
      next.append(el("span", "subtle", "Not currently scheduled"));
    }
    tdNext.append(next);

    tr.append(tdShow, tdChan, tdNext, el("td", "muted", String(show.episode_count ?? "")));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function renderGroups(rows, t) {
  const groups = [];
  for (const m of metas) {
    if (state.ch && m.id !== state.ch) continue;
    const mine = rows.filter((r) => r.show.channels.includes(m.id));
    if (!mine.length) continue;
    const group = el("section", "group");
    const head = el("div", "group-head");
    if (m.number != null) head.append(el("span", "channel-number", String(m.number)));
    head.append(channelMark(m));
    const grow = el("div", "grow");
    grow.append(el("div", "group-title", m.name));
    const channel = channelById.get(m.id);
    const onNow = channel ? onAirNow(channel, t).nowProgram : null;
    grow.append(el("div", "group-desc", `${mine.length} show${mine.length === 1 ? "" : "s"}${onNow ? ` · ${onNow.title} is on now` : ""}`));
    head.append(grow, link(urls.channel(m.id), "btn small ghost", "Full channel lineup ›"));

    const grid = el("div", "group-grid");
    for (const { show } of mine) {
      const status = statusOf(show, m.id);
      const card = link(urls.show(show.id, m.id), "group-card");
      const p = el("p");
      if (status.onNow) p.append(el("b", null, "On now"), status.again ? ` · again ${compactWhen(status.again.startsAt, t)}` : "");
      else if (status.next) p.append(`Next ${compactWhen(status.next.startsAt, t)}`);
      else p.append("Not currently scheduled");
      card.append(showArt(show), el("h3", null, show.title), p);
      grid.append(card);
    }
    group.append(head, grid);
    groups.push(group);
  }
  return groups;
}
