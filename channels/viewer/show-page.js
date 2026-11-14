// channels/viewer/show-page.js -- show.html?show=<series id>[&ch=<channel id>]:
// one show -- what it is, whether it's on right now, when it's next on, and
// which of its episodes are coming up on air. CRVideo is live TV, so this page
// never plays an episode: its one action is tuning to the channel that is
// airing the show. Episode lists come from channels/finder.php (approved
// episodes only); air times are derived from the published schedules.

import "./nav.js";
import { now } from "../broadcast.js";
import { startClock, loadChannelMetas, loadChannels, loadShowDetail, rememberChannel, urls } from "./data.js";
import {
  buildScheduleIndex, airStatus, episodeSchedule, timeLabel, whenLabel, untilLabel, durationLabel,
} from "./model.js";
import { $, el, link, showArt, livePill, param, emptyState } from "./ui.js";

const page = $("#page");
const COMING_LIMIT = 12;
const REST_INITIAL = 20;

init();

async function init() {
  await startClock();
  const id = param("show");
  const [show, metas] = await Promise.all([id ? loadShowDetail(id) : null, loadChannelMetas().catch(() => [])]);
  if (!show) return emptyState(page, "We couldn't find that show.", urls.browse(), "Browse all shows");

  const metaById = new Map(metas.map((m) => [m.id, m]));
  const carrying = show.channels.map((c) => metaById.get(c)).filter(Boolean);
  const ctx = carrying.find((m) => m.id === param("ch")) || carrying[0] || null;
  if (ctx) rememberChannel(ctx.id);
  document.title = `${show.title} · CRVideo`;

  // Only the channels that carry this show need their schedules loaded.
  const channels = await loadChannels(carrying);
  const view = { show, metaById, carrying, ctx, channels };
  paint(view);
  setInterval(() => paint(view), 30000);
}

let episodeLimit = REST_INITIAL;

function paint({ show, metaById, carrying, ctx, channels }) {
  const t = now();
  const list = buildScheduleIndex(channels, t).get(show.id);
  const status = airStatus(list, t);
  const sched = episodeSchedule(list, t);
  const nameOf = (id) => metaById.get(id)?.name ?? id;
  const numberOf = (id) => metaById.get(id)?.number;
  const chLabel = (id) => (numberOf(id) != null ? `Ch ${numberOf(id)} · ${nameOf(id)}` : nameOf(id));

  page.replaceChildren();

  const crumbs = el("div", "eyebrow crumbs");
  crumbs.append(link(urls.browse(), null, "Browse"), " / ");
  if (ctx) crumbs.append(link(urls.channel(ctx.id), null, ctx.name), " / ");
  crumbs.append(show.title);
  page.append(crumbs);

  const hero = el("section", "show-hero");
  hero.append(showArt(show, "big-poster"));
  const info = el("div", "show-info");
  info.append(el("div", "eyebrow", `${show.episode_count} episode${show.episode_count === 1 ? "" : "s"} in rotation`));
  info.append(el("h1", null, show.title));

  const creator = el("div", "creator");
  const parts = [];
  if (show.creator) parts.push(document.createTextNode(show.creator));
  for (const m of carrying) parts.push(link(urls.channel(m.id), null, m.number != null ? `${m.name} · Channel ${m.number}` : m.name));
  parts.forEach((node, i) => { if (i) creator.append(" · "); creator.append(node); });
  info.append(creator);
  if (show.description) info.append(el("p", "desc", show.description));
  info.append(airBox(status, t, ctx, chLabel));

  if (status.upcoming.length) {
    info.append(el("div", "eyebrow", "Upcoming airings"));
    const chips = el("div", "chips");
    for (const u of status.upcoming.slice(0, 8)) {
      chips.append(el("span", null, carrying.length > 1 ? `${whenLabel(u.startsAt, t)} · ${nameOf(u.channelId)}` : whenLabel(u.startsAt, t)));
    }
    info.append(chips);
  }
  hero.append(info);
  page.append(hero);

  // ----- episodes -----
  const head = el("div", "section-head");
  const left = el("div");
  left.append(el("div", "eyebrow", "Episode catalog"), el("h2", null, "Episodes in rotation"));
  head.append(left, el("div", "subtle", `${show.episodes.length} episode${show.episodes.length === 1 ? "" : "s"}`));
  page.append(head);

  const coming = show.episodes.filter((e) => sched.has(e.id)).sort((a, b) => sched.get(a.id).startsAt - sched.get(b.id).startsAt);
  const rest = show.episodes.filter((e) => !sched.has(e.id));
  const box = el("div", "episode-list");
  if (coming.length) {
    box.append(el("div", "ep-group", "Coming up on air"));
    for (const e of coming.slice(0, COMING_LIMIT)) box.append(episodeRow(show, e, sched.get(e.id), t, nameOf, carrying.length > 1));
  }
  if (rest.length) {
    if (coming.length) box.append(el("div", "ep-group", "Also in rotation"));
    for (const e of rest.slice(0, episodeLimit)) box.append(episodeRow(show, e, null, t, nameOf, false));
    if (rest.length > episodeLimit) {
      const more = el("button", "more", `Show all ${rest.length} episodes ▾`);
      more.type = "button";
      more.addEventListener("click", () => { episodeLimit = Infinity; paint({ show, metaById, carrying, ctx, channels }); });
      box.append(more);
    }
  }
  page.append(box);
  page.append(el("p", "footer-note", "CRVideo is live TV: episodes air when they're scheduled, and there's no on-demand playback. Tune in to a channel to watch."));
}

function airBox(status, t, ctx, chLabel) {
  const box = el("div", "airbox");
  const text = el("div");
  const big = el("div", "big");
  const small = el("div", "small");
  let action;
  if (status.onNow) {
    const cid = status.onNow.channelId;
    big.append(livePill("ON NOW"), `Airing until ${timeLabel(status.onNow.endsAt)}`);
    small.textContent = `On ${chLabel(cid)}${status.again ? ` · again ${whenLabel(status.again.startsAt, t)}` : ""}`;
    action = link(urls.watch(cid), "btn primary", "▶ Watch Channel");
  } else if (status.next) {
    const cid = status.next.channelId;
    big.append(`Next airs ${whenLabel(status.next.startsAt, t)}`);
    small.textContent = `On ${chLabel(cid)} · ${untilLabel(status.next.startsAt - t)}`;
    action = link(urls.channel(cid), "btn ghost", "See the channel lineup");
  } else {
    box.classList.add("idle");
    big.append("Not currently scheduled");
    small.textContent = ctx
      ? `It's part of ${ctx.name}'s catalog but isn't in the published schedule right now.`
      : "It isn't in any published schedule right now.";
    if (ctx) action = link(urls.channel(ctx.id), "btn ghost", "See the channel lineup");
  }
  text.append(big, small);
  box.append(text);
  if (action) box.append(action);
  return box;
}

function episodeRow(show, ep, airing, t, nameOf, showChannel) {
  const row = el("div", "ep");
  row.classList.toggle("on-air", !!airing?.onNow);
  row.append(el("div", "epnum", ep.number != null ? `#${String(ep.number).padStart(2, "0")}` : ""));
  row.append(showArt({ id: ep.id, title: show.title, thumbnail_url: ep.thumbnail_url || null }, "thumb"));
  const text = el("div");
  text.append(el("h3", null, ep.title || "Untitled"));
  if (ep.description) text.append(el("p", null, ep.description));
  row.append(text);

  const when = el("div", "when");
  if (airing) {
    when.append(el("b", null, airing.onNow ? "ON NOW" : `Airs ${whenLabel(airing.startsAt, t)}`));
    if (showChannel) when.append(nameOf(airing.channelId), el("br"));
  }
  const dur = durationLabel(ep.duration);
  if (dur) when.append(dur);
  row.append(when);
  return row;
}
