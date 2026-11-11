// explorer-search.js -- the Global Search results view and the inspector shown
// for a picked result. Searching is client-side over metadata only (see
// explorer-store.js searchDocs()); airings cover only the channel schedules
// already loaded, and the UI says so.

import { esc, thumb, pill, section, btn, icons, fmtDateTime, fmtDuration, plural, titleCase } from "./explorer-ui.js";
import { renderRelationships } from "./explorer-relationships.js";
import { pluralScope } from "./explorer-model.js";

const TYPE_LABEL = { channel: "Channels", series: "Series", episode: "Episodes", airing: "Airings", bump: "Bumps", announcement: "Voiceovers", media: "Media assets" };
const SCOPES = ["all", "channels", "series", "episodes", "airings", "bumps", "announcements", "media"];
const SCOPE_TYPE = { channels: "channel", series: "series", episodes: "episode", airings: "airing", bumps: "bump", announcements: "announcement", media: "media" };
const TYPE_ICON = { channel: icons.channel, series: icons.series, episode: icons.episode, airing: icons.clock, bump: icons.bump, announcement: icons.voice, media: icons.video };

export const docKey = (d) => `${d.type}|${d.id}`;

/** Route patch that selects a search document in the normal browser. */
export const docRoute = (d) => ({ ...d.ref });

export function renderSearchView(store, pickKey) {
  const r = store.route;
  const res = store.search();
  const cov = store.scheduleCoverage();
  const loading = [...store.loading].some((k) => ["episode-index", "bumps", "media", "all-announcements", "series-index", "channels"].includes(k));

  const scopes = SCOPES.map((s) => {
    const n = s === "all" ? res.total : res.counts[SCOPE_TYPE[s]] || 0;
    return `<button class="scope" data-act="search-scope" data-id="${s}" aria-pressed="${r.scope === s}"><span>${esc(s === "all" ? "All results" : titleCase(s))}</span><i>${n}</i></button>`;
  }).join("");

  const groups = res.groups.map((g) => `
    <section class="rg">
      <h3>${TYPE_ICON[g.type]} ${esc(TYPE_LABEL[g.type])} <i>${g.total}</i>${r.scope === "all" && g.total > g.items.length ? `<button class="cell-link" data-act="search-scope" data-id="${pluralScope(g.type)}">See all →</button>` : ""}</h3>
      ${g.items.map((d) => `
        <button class="res" data-act="search-pick" data-key="${esc(docKey(d))}" aria-pressed="${pickKey === docKey(d)}" data-open="${esc(JSON.stringify(docRoute(d)))}">
          ${thumb(d.thumb, d.title)}
          <span class="grow"><span class="t">${esc(d.title)}</span><span class="s">${esc(d.sub || "")}${d.startsAt ? ` · ${esc(fmtDateTime(d.startsAt))}` : ""}${d.duration ? ` · ${esc(fmtDuration(d.duration))}` : ""}</span></span>
          <span class="r">${icons.chevron}</span>
        </button>`).join("")}
    </section>`).join("");

  const empty = !res.groups.length ? `<p class="empty" style="padding:24px 14px">${loading ? "Loading searchable metadata…" : `No results for “${esc(r.q)}”.`}</p>` : "";
  return `
    <div class="search-layout">
      <aside class="scopes" aria-label="Search scopes"><h3>Search scopes</h3>${scopes}
        <p class="note" style="margin:12px 8px 0">Airings are searched in ${cov.loaded} of ${cov.total} channel schedules${cov.loaded < cov.total ? " (the rest are still loading)" : ""}${cov.failed ? `, ${cov.failed} unavailable` : ""}. Only the published window is searchable.</p>
      </aside>
      <div class="results" role="list">
        <div class="results-head"><b>${res.total}</b> result${res.total === 1 ? "" : "s"} for “${esc(r.q)}” ${loading ? '<span class="faint">· loading…</span>' : ""}</div>
        ${groups}${empty}
      </div>
    </div>`;
}

/** The Inspector for a picked search result: identity, relationships, and an Open action. */
export function renderPick(store, doc) {
  if (!doc) return `<div class="sec"><p class="empty">Select a result to see what it is connected to.</p></div>`;
  const ref = refOf(doc);
  return `
    <div class="sec"><div class="eyebrow-line">${esc(TYPE_LABEL[doc.type].toUpperCase())} · RELATIONSHIPS</div>
      <h2 class="ep-title">${esc(doc.title)}</h2><div class="sub">${esc(doc.sub || "")}</div></div>
    ${renderRelationships(store, ref)}
    <div class="actions">${btn("search-open", `Open in Explorer`, { primary: true, attrs: `data-open="${esc(JSON.stringify(docRoute(doc)))}"`, icon: icons.folder })}</div>`;
}

export function refOf(doc) {
  const r = doc.ref;
  switch (doc.type) {
    case "channel": return { type: "channel", id: r.channel };
    case "series": return { type: "series", id: r.series };
    case "episode": return { type: "episode", series: r.series, id: r.episode };
    case "airing": return { type: "airing", channel: r.channel, start: r.airing };
    case "bump": return { type: "bump", id: r.asset.id };
    case "announcement": return { type: "announcement", channel: r.asset.channelId, id: r.asset.id };
    default: return { type: "media", path: r.asset.path };
  }
}
