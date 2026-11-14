# Viewer pages: Guide, Channels, Browse

The viewer-facing surfaces of CRVideo. They share one top bar
(`<cr-viewer-nav>`, `channels/viewer/nav.js`: **Guide / Channels / Browse** plus the
broadcast clock) and one palette (the guide's navy surfaces with a gold accent).

| URL | What it is |
| --- | --- |
| `channels/index.html` | **Guide** -- the cable-style grid: every channel, 24 h on one scrolling timeline. "What's on across everything." |
| `channels/channel.html?ch=<id>[&day=<n>]` | **Channels** -- one channel with room to read: a live preview, the day's full lineup (yesterday plus six days ahead), and a shelf of the shows it carries. |
| `channels/browse.html[?q=&ch=&airing=&view=&sort=&dir=]` | **Browse** (the viewer "Finder") -- search every show as **posters**, a sortable **list**, or **by channel**. Every control is mirrored into the URL, so any search is a link. |
| `channels/show.html?show=<series id>[&ch=<id>]` | One show: what it is, whether it is on now, when it is next on, and which of its episodes are coming up on air. |

## It is live TV, not on-demand

Nothing in these pages plays a chosen episode. Browse and the show page answer
"what is this, and when can I watch it?"; the only playback action is **Watch
Channel**, which tunes to the channel airing the show (`watch.html?ch=`). The
"WATCH NOW" badge appears only while a show is actually on. A show that is in a
channel's catalog but not in the published schedule is shown as "Not currently
scheduled", and sorts last.

## Where the data comes from

- **When** -- never stored. `viewer/model.js` derives every airing from each
  channel's published `schedule.json` through `buildEpgTimeline()` / `airings()`
  (the same code the guide draws), looking 14 days ahead (the publish window).
  The pages therefore cannot disagree with what is on air. A program with no
  `series_id` (e.g. USTV's single-channel playlist) has no show page.
- **What** -- `channels/finder.php`, a viewer-safe projection of `series/`:
  - `finder.php` -> `{shows: [{id, title, description, thumbnail_url, creator, year, channels[], episode_count}]}`
  - `finder.php?show=<id>` -> that show plus its approved episodes
  - A *show* is a series that at least one visible (non-`hidden`) channel's
    `catalog.json` references and that has at least one approved episode.
  - **Only `status: "approved"` episodes that are not `rights.status: "restricted"`
    are exposed, and neither field is included in the response.** Editorial status
    and rights notes stay backstage. (The raw `series/*/series.json` files are still
    plain static files on the server; see "No access control" in `docs/admin-ui.md`.)
  - Descriptions are cleaned (`FinderBuilder::cleanText`): URLs, hashtags and
    "Subscribe / Follow / Support us on Patreon" boilerplate paragraphs are
    dropped and the lead text is clipped at a word boundary.
  - The index touches ~30 MB of series files, so it is cached in
    `channels/finder/.cache/index.json` (git-ignored, group-writable) and rebuilt
    whenever any series, channel catalog or channel meta file is newer. The cache
    is best effort: if it can't be written the index is rebuilt per request.
- **Filters** -- Browse offers *Channel* and *Airing* (on now / next 12 hours /
  today / scheduled / not scheduled) plus free-text search over title, creator,
  description and channel name. There is deliberately no Decade or Genre filter:
  series files carry no genre, and `year` is empty.

## Files

```
channels/
  channel.html  browse.html  show.html     thin shells (importmap + <cr-viewer-nav> + one module)
  finder.php                               viewer-safe show index / detail (see above)
  finder/src/FinderBuilder.php             the projection; finder/tests/ -- plain-PHP tests
  viewer/
    viewer.css                             shared styles (gold accent tokens on :root)
    nav.js                                 <cr-viewer-nav>
    data.js                                loaders (channels, finder.php), last-channel memory, URL builders
    model.js                               pure logic: schedule index, air status, search/filter/sort,
                                           day lineup (with station-break rows), episode scheduling, labels
    ui.js                                  DOM helpers (textContent only; JSON is never assigned to innerHTML)
    channel-page.js  browse-page.js  show-page.js
  tests/viewer-model.test.js               node --test for model.js
```

The guide (`channels/index.html`) now uses the same nav and links into the
viewer pages: a "Channel page" link beside its Watch button, and "Full channel
lineup" / "About this show" links in a program's detail card.

## Running the tests

```sh
node --test channels/tests/*.test.js          # includes viewer-model.test.js
php channels/finder/tests/run-tests.php       # FinderBuilder
```

## Design mockups

The visual design started from the static mockups in `media/ui/viewer/`
(channel view, three Browse views, show detail). Differences from those mockups,
and why: the accent is the guide's gold, not cyan; Decade and Genre filters are
omitted (no data); the show page lists *Coming up on air* episodes with real air
times instead of an on-demand style sort control; and the channel lineup shows
**Station break** rows so a gap in the schedule is visible rather than skipped.
