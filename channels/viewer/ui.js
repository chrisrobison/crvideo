// channels/viewer/ui.js -- DOM helpers shared by the viewer pages. Everything
// is built with createElement/textContent (channel and show data is
// untrusted JSON; nothing here ever assigns it to innerHTML).

import { artIndex, monogram } from "./model.js";

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function link(href, cls, text) {
  const a = el("a", cls, text);
  a.href = href;
  return a;
}

/** `<div class="art tint-N">` with the show's thumbnail when it has one (falling back to a
 *  tinted monogram if the image is missing or fails to load). */
export function showArt(show, cls = "") {
  const art = el("div", `art tint-${artIndex(show.id ?? show.title)} ${cls}`.trim());
  art.append(el("span", "mono", monogram(show.title)));
  const src = show.thumbnail_url;
  if (src) {
    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("load", () => art.classList.add("has-img"));
    img.addEventListener("error", () => img.remove());
    img.src = src;
    art.append(img);
  }
  return art;
}

/** A channel's square mark: its logo when it has one, else its number/initials. */
export function channelMark(channel, cls = "channel-mark") {
  const mark = el("span", cls);
  if (channel.logo) {
    const img = el("img");
    img.alt = "";
    img.src = channel.logo;
    img.addEventListener("error", () => { img.remove(); mark.textContent = monogram(channel.name); });
    mark.append(img);
  } else {
    mark.textContent = monogram(channel.name);
  }
  return mark;
}

export function livePill(label = "LIVE") {
  const p = el("span", "pill live");
  p.append(el("span", "dot"), label);
  return p;
}

/** Replaces the query string without adding history entries (filters, tabs). */
export function replaceParams(params) {
  const u = new URL(location.href);
  u.search = "";
  for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) u.searchParams.set(k, v);
  try { history.replaceState(null, "", u); } catch { /* sandboxed */ }
}

export const param = (name) => new URLSearchParams(location.search).get(name) || "";

export function emptyState(parent, message, href, label) {
  const box = el("div", "empty", message);
  if (href) { box.append(" "); box.append(link(href, null, label)); }
  parent.replaceChildren(box);
}
