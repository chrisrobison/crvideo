// channels/viewer/channel-page.js -- channel.html: ONE channel at a time, with
// room to read. A live preview of what's on, the day's full lineup (a day-tab
// per day, two weeks of published schedule), and a shelf of the shows the
// channel carries. Everything about "when" comes from the channel's published
// schedule (viewer/model.js); descriptions and art come from channels/finder.php.

import "./nav.js";
import "../player-view.js";
import { now } from "../broadcast.js";
import {
  startClock, loadChannelMetas, loadChannels, loadShowIndex, rememberChannel, lastChannelId, urls,
} from "./data.js";
import {
  buildScheduleIndex, airStatus, airSummary, dayLineup, onAirNow, filterShows,
  dayStart, timeLabel, whenLabel, untilLabel, slotLabel,
} from "./model.js";
import { $, el, link, showArt, channelMark, livePill, param, replaceParams, emptyState } from "./ui.js";

const page = $("#page");
const longDay = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const tabDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });
const DAY_OFFSETS = [-1, 0, 1, 2, 3, 4, 5, 6];

let channel, meta, showsById = new Map(), channelShows = [], scheduleIndex = new Map();
let selectedDay = 0;
let showEarlier = false;
let heroKey = "";
const ui = {};

init();

async function init() {
  await startClock();
  let metas;
  try {
    metas = await loadChannelMetas();
  } catch (err) {
    return emptyState(page, `Couldn't load the channel list (${err.message}).`);
  }
  if (!metas.length) return emptyState(page, "No channels are on the air yet.");

  const wanted = param("ch");
  meta = metas.find((m) => m.id === wanted) || metas.find((m) => m.id === lastChannelId()) || metas[0];
  rememberChannel(meta.id);
  const d = Number.parseInt(param("day"), 10);
  selectedDay = DAY_OFFSETS.includes(d) ? d : 0;
  document.title = `${meta.name} · CRVideo`;

  const [[loaded], index] = await Promise.all([loadChannels([meta]), loadShowIndex()]);
  if (!loaded) return emptyState(page, `${meta.name} is off the air right now.`, urls.browse(), "Browse other channels");
  channel = loaded;
  showsById = new Map(index.shows.map((s) => [s.id, s]));
  channelShows = index.shows.filter((s) => s.channels.includes(channel.id));

  build(metas);
  refreshSchedule();
  tickHero();
  setInterval(tickHero, 1000);
  setInterval(refreshSchedule, 30000);
}

// ---------- layout ----------

function build(metas) {
  page.replaceChildren();

  const strip = el("nav", "chan-strip");
  strip.setAttribute("aria-label", "Channels");
  for (const m of metas) {
    const chip = link(urls.channel(m.id), "chip");
    if (m.number != null) chip.append(el("b", null, String(m.number)));
    chip.append(m.name);
    if (m.id === channel.id) chip.setAttribute("aria-current", "page");
    strip.append(chip);
  }
  page.append(strip);

  page.append(el("div", "eyebrow", channel.number != null ? `Channel ${channel.number}` : "Channel"));
  page.append(el("h1", "title", channel.name));
  if (channel.description) page.append(el("p", "subtle clamp2", channel.description));

  // hero: live preview + what's on
  const hero = el("section", "hero");
  const art = el("div", "hero-art");
  const player = document.createElement("cr-channel-player");
  player.compact = true;
  player.standalone = false; // this page owns the URL and title
  const watch = link(urls.watch(channel.id), "screen-link");
  watch.setAttribute("aria-label", `Watch ${channel.name} full screen`);
  watch.append(el("span", null, "Watch full screen ›"));
  art.append(player, watch, livePill());
  player.tune(channel.id);

  const info = el("div", "hero-info");
  const line = el("div", "channel-line");
  line.append(channelMark(channel));
  if (channel.number != null) line.append(el("span", "channel-number", String(channel.number)));
  line.append(channel.name);
  ui.title = el("h1");
  ui.meta = el("div", "meta");
  ui.nowep = el("div", "nowep");
  ui.desc = el("p", "desc");
  ui.start = el("span");
  ui.bar = el("i");
  ui.left = el("span");
  const progress = el("div", "progress");
  progress.append(ui.bar);
  const row = el("div", "progress-row");
  row.append(ui.start, progress, ui.left);
  ui.actions = el("div", "actions");
  ui.upnext = el("p", "upnext");
  info.append(line, ui.title, ui.meta, ui.nowep, ui.desc, row, ui.actions, ui.upnext);
  hero.append(art, info);
  page.append(hero);

  // full lineup
  const head = el("div", "section-head");
  const left = el("div");
  left.append(el("div", "eyebrow", "Full lineup"));
  ui.dayTitle = el("h2");
  left.append(ui.dayTitle);
  ui.tabs = el("div", "daytabs");
  ui.tabs.setAttribute("role", "group");
  ui.tabs.setAttribute("aria-label", "Day");
  head.append(left, ui.tabs);
  ui.schedule = el("div", "schedule");
  page.append(head, ui.schedule);

  // shelf
  const shelfHead = el("div", "section-head");
  const shelfLeft = el("div");
  shelfLeft.append(el("div", "eyebrow", "Browse"), el("h2", null, "On this channel"));
  ui.shelfCount = el("div", "subtle");
  shelfHead.append(shelfLeft, ui.shelfCount);
  ui.shelf = el("div", "shelf");
  if (channelShows.length) page.append(shelfHead, ui.shelf);
}

// ---------- hero (every second) ----------

function tickHero() {
  const t = now();
  const { current, nowProgram, next, episode } = onAirNow(channel, t);
  const key = `${nowProgram?.startsAt ?? "break"}:${episode?.id ?? ""}:${next?.startsAt ?? ""}`;
  if (key !== heroKey) {
    heroKey = key;
    renderHero(nowProgram, next, episode, current);
  }
  const a = nowProgram || current;
  if (a && a.endsAt > a.startsAt) {
    const done = Math.min(1, Math.max(0, (t - a.startsAt) / (a.endsAt - a.startsAt)));
    ui.bar.style.width = `${done * 100}%`;
    ui.left.textContent = `${Math.max(1, Math.ceil((a.endsAt - t) / 60))} min left`;
  }
}

function renderHero(nowProgram, next, episode, current) {
  const show = nowProgram?.seriesId ? showsById.get(nowProgram.seriesId) : null;
  ui.actions.replaceChildren();
  const watch = link(urls.watch(channel.id), "btn primary", "▶ Watch Channel");
  ui.actions.append(watch);

  if (nowProgram) {
    ui.title.textContent = nowProgram.title;
    const parts = [`${timeLabel(nowProgram.startsAt)} – ${timeLabel(nowProgram.endsAt)}`];
    if (nowProgram.seriesTitle && nowProgram.seriesTitle !== nowProgram.title) parts.push(nowProgram.seriesTitle);
    ui.meta.textContent = parts.join(" · ");
    ui.nowep.replaceChildren();
    if (episode?.title) ui.nowep.append("Now playing: ", el("b", null, episode.title));
    ui.desc.textContent = show?.description || nowProgram.description || channel.description || "";
    ui.start.textContent = timeLabel(nowProgram.startsAt);
    if (show) ui.actions.append(link(urls.show(show.id, channel.id), "btn ghost", "View show"));
  } else {
    // A station break between programs: say so, and point at what's next.
    ui.title.textContent = "Station break";
    ui.meta.textContent = current ? `Until ${timeLabel(current.endsAt)}` : "";
    ui.nowep.replaceChildren();
    ui.desc.textContent = channel.description || "";
    ui.start.textContent = current ? timeLabel(current.startsAt) : "";
  }

  ui.upnext.replaceChildren();
  if (next) ui.upnext.append("Up next: ", el("b", null, next.title), ` at ${timeLabel(next.startsAt)}`);
}

// ---------- lineup + shelf (every 30 s and on interaction) ----------

function refreshSchedule() {
  const t = now();
  scheduleIndex = buildScheduleIndex([channel], t);
  renderTabs(t);
  renderLineup(t);
  renderShelf(t);
}

function renderTabs(t) {
  ui.tabs.replaceChildren();
  for (const off of DAY_OFFSETS) {
    const day = new Date(dayStart(t, off) * 1000);
    const b = el("button", null, off === 0 ? `Today ${day.getDate()}` : off === -1 ? `Yesterday` : tabDay.format(day));
    b.type = "button";
    b.setAttribute("aria-pressed", String(off === selectedDay));
    b.addEventListener("click", () => {
      selectedDay = off;
      showEarlier = false;
      replaceParams({ ch: channel.id, day: off === 0 ? "" : off });
      refreshSchedule();
    });
    ui.tabs.append(b);
  }
}

function renderLineup(t) {
  const start = dayStart(t, selectedDay);
  const end = dayStart(t, selectedDay + 1);
  ui.dayTitle.textContent = longDay.format(new Date(start * 1000));
  const rows = dayLineup(channel, start, end);
  ui.schedule.replaceChildren();
  if (!rows.length) {
    ui.schedule.append(el("div", "empty", "Nothing scheduled this day."));
    return;
  }

  // Today: tuck the long-finished programs (all but the most recent one) behind a
  // toggle, so the page opens at "now" instead of at midnight.
  let hidden = 0;
  if (selectedDay === 0) {
    const firstUnfinished = rows.findIndex((r) => r.endsAt > t);
    hidden = Math.max(0, (firstUnfinished < 0 ? rows.length : firstUnfinished) - 1);
  }
  if (hidden > 0) {
    const toggle = el("button", "earlier", showEarlier ? "Hide earlier programs ▴" : `Earlier today (${hidden}) ▾`);
    toggle.type = "button";
    toggle.addEventListener("click", () => { showEarlier = !showEarlier; renderLineup(now()); });
    ui.schedule.append(toggle);
  }

  for (const r of rows.slice(showEarlier ? 0 : hidden)) {
    const show = r.seriesId ? showsById.get(r.seriesId) : null;
    const isNow = r.startsAt <= t && t < r.endsAt;
    const past = r.endsAt <= t;
    if (r.isBreak) {
      const brk = el("div", "schedule-row break");
      brk.classList.toggle("now", isNow);
      brk.classList.toggle("past", past);
      const time = el("div", "time", timeLabel(r.startsAt));
      if (r.continued) time.append(el("small", null, "from previous day"));
      const program = el("div", "program");
      program.append(el("h3", null, "Station break"), el("p", null, "No program scheduled. The channel airs filler and station identification."));
      const end = el("div", "row-end");
      end.append(el("b", null, slotLabel(r.endsAt - r.startsAt)), isNow ? "On now" : past ? `Ended ${timeLabel(r.endsAt)}` : "");
      brk.append(time, el("div"), program, end);
      ui.schedule.append(brk);
      continue;
    }
    const row = show ? link(urls.show(show.id, channel.id), "schedule-row") : el("div", "schedule-row");
    row.classList.toggle("now", isNow);
    row.classList.toggle("past", past);

    const time = el("div", "time", timeLabel(r.startsAt));
    if (r.continued) time.append(el("small", null, "from previous day"));
    const thumb = showArt(show || { id: r.seriesId || r.title, title: r.title }, "thumb");

    const program = el("div", "program");
    program.append(el("h3", null, r.title));
    const bits = [];
    if (r.episodeCount > 1) bits.push(`${r.episodeCount} episodes`);
    const desc = show?.description || r.description;
    if (desc) bits.push(desc);
    if (bits.length) program.append(el("p", null, bits.join(" · ")));

    const end = el("div", "row-end");
    if (isNow) {
      end.append(el("b", "nowtag", "NOW PLAYING"), `${Math.max(1, Math.ceil((r.endsAt - t) / 60))} min left`);
    } else {
      end.append(el("b", null, slotLabel(r.endsAt - r.startsAt)));
      end.append(past ? `Ended ${timeLabel(r.endsAt)}` : r.startsAt - t < 3 * 3600 ? `Starts ${untilLabel(r.startsAt - t)}` : "");
    }
    row.append(time, thumb, program, end);
    ui.schedule.append(row);
  }
}

function renderShelf(t) {
  if (!channelShows.length) return;
  const rows = filterShows(channelShows, (s) => airStatus(scheduleIndex.get(s.id), t), { nowSec: t });
  ui.shelfCount.textContent = `${rows.length} show${rows.length === 1 ? "" : "s"}`;
  ui.shelf.replaceChildren();
  for (const { show, status } of rows) {
    const card = link(urls.show(show.id, channel.id), "poster");
    const sum = airSummary(status, t);
    const p = el("p");
    if (sum.kind === "now") {
      p.append(el("b", null, "On now"));
      if (sum.again) p.append(` · again ${whenLabel(sum.again, t).replace(/^Today /, "")}`);
    } else if (sum.kind === "next") {
      p.append("Next: ", whenLabel(sum.at, t).replace(/^Today /, ""));
    } else {
      p.append("Not currently scheduled");
    }
    card.append(showArt(show), el("h3", null, show.title), p);
    ui.shelf.append(card);
  }
}
