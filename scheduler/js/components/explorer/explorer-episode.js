// explorer-episode.js -- the Episode inspector. An episode is a content item
// of a series; it is NOT an airing (airings are listed below it, each with
// its own channel + start). Preview plays the episode itself through the
// project's provider adapters and is separate from previewing an airing.

import * as M from "./explorer-model.js";
import { esc, thumb, pill, kv, section, emptyNote, btn, icons, fmtDateTime, fmtDuration, fmtDate, notRecorded, plural, titleCase, EDITORIAL_TONE, RIGHTS_LABEL, RIGHTS_TONE } from "./explorer-ui.js";

/** What the preview stage can honestly do for an episode (never invents a URL). */
export function episodePlayability(ep) {
  const src = ep?.source || {};
  if (src.provider === "youtube" && src.video_id) {
    if (src.embeddable === false) return { ok: false, reason: "The provider disallows embedding this video.", url: src.url };
    if (src.availability && src.availability !== "available") return { ok: false, reason: `The provider reports it as “${src.availability}”${src.availability_detail ? ` (${src.availability_detail})` : ""}.`, url: src.url };
    return { ok: true, source: { provider: "youtube", videoId: src.video_id }, url: src.url };
  }
  if (ep?.media_url) return { ok: true, source: { provider: "html5", mediaUrl: ep.media_url }, url: ep.media_url };
  return { ok: false, reason: "No playable source is recorded for this episode.", url: src.url || null };
}

export function stageHtml(persistKey, poster, play, act = "preview-episode") {
  return `
    <div class="stage" data-persist="${esc(persistKey)}">
      <div class="host" data-host>
        ${poster ? `<img src="${esc(poster)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        ${play.ok ? `<button class="bigplay" data-act="${act}" aria-label="Play preview" title="Preview (plays inside the provider's own player)">${icons.play}</button>`
          : `<div class="noplay">${esc(play.reason)}${play.url ? ` <a href="${esc(play.url)}" target="_blank" rel="noopener noreferrer">Open at source ↗</a>` : ""}</div>`}
      </div>
      <div class="stage-msg" data-msg aria-live="polite"></div>
    </div>`;
}

export function renderEpisode(store) {
  const sid = store.route.series;
  const eid = store.route.episode;
  const detail = store.seriesDetail(sid);
  if (!detail) {
    return store.errors.get(`series:${sid}`) ? `<div class="sec"><p class="note bad">${esc(store.errors.get(`series:${sid}`))}</p></div>` : `<div class="sec"><p class="empty">Loading episode…</p></div>`;
  }
  const ep = detail.episodes.find((e) => e.id === eid);
  if (!ep) return `<div class="sec"><p class="note bad">Series <b>${esc(detail.title)}</b> has no episode <code>${esc(eid)}</code>.</p></div>`;

  const play = episodePlayability(ep);
  const src = ep.source || {};
  const airs = store.airingsOfEpisode(sid, eid);
  const t = store.effectiveT();
  const carriers = store.carriersOf(sid);
  const loadingSched = carriers.some((c) => !store.scheduleView(c.channelId) && !store.data.scheduleErrors.has(c.channelId));
  const blocks = carriers.flatMap((c) => c.blocks.map((b) => ({ c, b })));

  const header = `
    <div class="eyebrow-line"><button class="cell-link" data-act="nav-series" data-id="${esc(sid)}" data-channel="${esc(store.route.channel || "")}">${esc(detail.title)}</button>${ep.episode_number != null ? ` · Episode ${esc(ep.episode_number)}` : ""}</div>
    <h2 class="ep-title">${esc(ep.title)}</h2>`;

  const rightsTone = RIGHTS_TONE[ep.rights?.status] || "muted";
  const details = section("Details", `
    ${kv("Series", `<button class="cell-link" data-act="nav-series" data-id="${esc(sid)}" data-channel="${esc(store.route.channel || "")}">${esc(detail.title)}</button> <code>${esc(sid)}</code>`)}
    ${kv("Episode id", `<code>${esc(ep.id)}</code>`)}
    ${kv("Season / episode", `<span class="faint">Season not recorded</span> · ${ep.episode_number != null ? `Episode ${esc(ep.episode_number)}` : notRecorded}`)}
    ${kv("Duration", ep.duration != null ? esc(fmtDuration(ep.duration)) : notRecorded)}
    ${kv("Published", ep.published_at ? esc(fmtDate(Date.parse(ep.published_at) / 1000)) : notRecorded)}
    ${kv("Provider", `${esc(titleCase(src.provider || "unknown"))}${src.channel_title ? ` · ${esc(src.channel_title)}` : ""}`)}
    ${kv("Source", src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.url.replace(/^https?:\/\//, "").slice(0, 52))} ↗</a>` : ep.media_url ? esc(ep.media_url) : notRecorded)}
    ${kv("Playback", [src.embeddable === false ? pill("Embedding disabled", "bad") : src.embeddable ? pill("Embeddable", "good") : "", src.availability ? pill(titleCase(src.availability), src.availability === "available" ? "good" : "warn") : "", src.privacy_status ? pill(titleCase(src.privacy_status), "muted") : "", src.made_for_kids ? pill("Made for kids", "info") : ""].filter(Boolean).join(" ") || notRecorded)}
    ${kv("Editorial status", ep.status ? pill(titleCase(ep.status), EDITORIAL_TONE[ep.status] || "muted") : notRecorded)}
    ${kv("Rights", ep.rights?.status ? pill(RIGHTS_LABEL[ep.rights.status] || ep.rights.status, rightsTone) : notRecorded)}
    ${kv("Rights notes", ep.rights?.notes ? esc(ep.rights.notes) : notRecorded)}
  `);

  const assets = section("Associated media assets", `
    ${ep.thumbnail_url ? kv("Thumbnail", `<a href="${esc(ep.thumbnail_url)}" target="_blank" rel="noopener noreferrer">image ↗</a>`) : ""}
    ${src.video_id ? kv("Video id", `<code>${esc(src.video_id)}</code> <span class="faint">(hosted by ${esc(titleCase(src.provider))}; Explorer never downloads or proxies it)</span>`) : ""}
    ${ep.media_url ? kv("Media file", esc(ep.media_url)) : ""}
    ${!ep.thumbnail_url && !src.video_id && !ep.media_url ? emptyNote("No media assets recorded.") : ""}`);

  const airingRows = airs.length ? airs.slice(0, 30).map((a) => {
    const ch = store.channel(a.channelId);
    const past = a.endsAt <= t;
    return `<button class="linkrow" data-act="nav-airing" data-channel="${esc(a.channelId)}" data-start="${a.startsAt}">
      <span class="grow"><span class="t">${esc(fmtDateTime(a.startsAt))}</span><span class="s">${esc(ch?.name || a.channelId)} · ${esc(fmtDuration(a.duration))}</span></span>
      ${a.startsAt <= t && a.endsAt > t ? pill("At selected time", "info") : past ? pill("Earlier", "muted") : pill("Scheduled", "good")}</button>`;
  }).join("") + (airs.length > 30 ? `<p class="empty">+ ${airs.length - 30} more</p>` : "")
    : emptyNote(loadingSched ? "Loading schedules…" : carriers.length ? "Not scheduled in any published window of the channels that carry this series." : "No channel carries this series.");

  const blockHtml = blocks.length ? `<div class="chips">${blocks.map(({ c, b }) => `<button class="chip" data-act="open-programming" data-channel="${esc(c.channelId)}" data-block="${esc(b.id)}" title="Open in Programming">${icons.calendar}${esc(c.channelName)} · ${esc(b.title || b.id)}</button>`).join("")}</div>
    <p class="note" style="margin-top:8px">These blocks air the series; whether this specific episode is in a block's rotation is shown by the airings above.</p>` : emptyNote("No programming block references this series.");

  return `
    <div class="sec">${header}</div>
    ${stageHtml(`episode:${sid}/${eid}`, ep.thumbnail_url, play)}
    ${ep.description ? `<div class="sec"><p class="desc clamp" tabindex="0" data-toggle-clamp title="Click to expand">${esc(ep.description)}</p></div>` : ""}
    ${details}
    ${assets}
    ${section("Scheduled airings", airingRows, { count: airs.length })}
    ${section("Programming blocks", blockHtml)}
    <div class="actions">
      ${play.ok ? btn("preview-episode", "Preview Episode", { primary: true, icon: icons.play }) : ""}
      ${btn("open-series-review", "Open in Series Review", { attrs: `data-series="${esc(sid)}" data-episode="${esc(eid)}"`, icon: icons.series })}
      ${blocks[0] ? btn("open-programming", "Open in Programming", { attrs: `data-channel="${esc(store.route.channel && blocks.some((x) => x.c.channelId === store.route.channel) ? store.route.channel : blocks[0].c.channelId)}"`, icon: icons.calendar }) : ""}
    </div>`;
}
