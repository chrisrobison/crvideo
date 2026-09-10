# Connecting ChannelFlow to Google Drive

ChannelFlow can use a Google Drive folder as: a shared media library, a
schedule backup/restore target, and an extra destination for `Publish`
(alongside the local `playlist.json` download). This is entirely
client-side — there's no backend — so it uses Google's OAuth "token
client" flow. That's a one-time, 5-minute setup in Google Cloud Console.

## 1. Create (or reuse) a Google Cloud project
Go to https://console.cloud.google.com/ and create a project (or pick an
existing one).

## 2. Enable the Drive API
**APIs & Services → Library** → search "Google Drive API" → **Enable**.

## 3. Configure the OAuth consent screen
**APIs & Services → OAuth consent screen**
- User type: **External**
- App name: `ChannelFlow` (anything you like), add your own email as
  support/contact email
- Scopes: you don't need to add anything here manually — the app requests
  `https://www.googleapis.com/auth/drive` at sign-in time
- Test users: add your own Google account email
- Leave it in **Testing** status — that's fine for personal/internal use
  and avoids Google's app-verification review (verification is only
  required if you want *other* people's Google accounts to use it).

## 4. Create the OAuth Client ID
**APIs & Services → Credentials → Create Credentials → OAuth client ID**
- Application type: **Web application**
- Authorized JavaScript origins: add every origin you'll load the app
  from, e.g.:
  - `https://cdr2.com` (wherever this is actually hosted)
  - `http://localhost:8080` (for local testing)
- No redirect URI is needed (this uses the implicit token flow, not the
  authorization-code flow).
- Click **Create** and copy the **Client ID** (looks like
  `1234567890-abc...apps.googleusercontent.com`).

## 5. Paste the Client ID into the app
Open `scheduler/js/drive-config.js` and set:

```js
export const GOOGLE_CLIENT_ID = "1234567890-abc...apps.googleusercontent.com";
```

A Client ID is a public identifier, not a secret — it's fine to commit.

## 6. Use it
Reload the scheduler and open the **Drive** menu in the header:
- **Connect Google Drive** — pops the standard Google sign-in/consent window.
- **Choose folder…** — browse your Drive and pick one folder. That folder
  becomes the shared media pool, the schedule backup location, and an
  extra Publish target, all at once.
- **Refresh media from Drive** — (re)lists that folder's video/audio/image
  files into the Media Library, tagged with a small ☁️ icon. Drag them onto
  the timeline exactly like local media.
- **Save schedule to Drive** / **Load schedule from Drive** — writes/reads
  `channelflow-schedule.json` in that folder.
- **Publish** (in the main toolbar) — when a Drive folder is chosen, also
  writes `playlist.json` into it, in addition to the local download.

### Reels — auto-filling dead air from a folder
Further down the same Drive menu is a separate **Reels** section — this is
for a folder of filler/bumper clips you want the scheduler to lean on
automatically whenever there's a gap in the Program track, so the channel
never actually goes to dead air.
- **Choose folder…** / paste a link — same as the main folder, but kept
  separate on purpose: your Reels pool doesn't have to be the same folder
  as your main shared media.
- **Auto-fill gaps** (toggle) — when on, *any* edit that opens a gap
  (deleting a segment, dragging one to reschedule it, resizing it shorter,
  even switching channel/date to a schedule with existing gaps) immediately
  gets patched with the next clip in the Reels folder, round-robin. The
  clip is looped for the entire gap — one clip per gap, not chained
  clips — so a 12-minute gap plays one reel on a loop until the next real
  program starts, the same way a "please stand by" filler reel works on a
  real broadcast channel.
- **Fill gaps now** — a one-off manual sweep, useful if you'd rather review
  gaps yourself before turning on full automation.

Pasting `https://drive.google.com/drive/folders/<id>` (a link to a folder
someone else shared with you, like a team's "reels" folder) works the same
way here as it does for the main folder.

## 7. (Optional) Broadcast a Drive folder 24/7 — `channel.html`

`../channel.html` (repo root, alongside `sync-player.html`) turns a Drive
folder straight into an unattended 24/7 channel — no `playlist.json`, no
sign-in, no scheduler UI involved. It:

- Lists the video files directly in a Drive folder.
- Reads a time-of-day range out of each **filename**, e.g.
  `01_USTV_MidnightMovies_12a-4a.mp4` → starts at 12:00am. Supports
  `H`, `H:MM`, `a`/`p`/`am`/`pm`, e.g. `4a-8a`, `4:30p-8p`.
  Only the *start* time matters — each video plays until the next one's
  start time (wrapping past midnight for the last video of the day), so
  the whole 24 hours is always covered with no dead air, even if the
  trailing label in the filename (the `-4a` part) doesn't line up exactly.
- Repeats that same schedule every day, forever — this is a loop by
  time-of-day, not a one-off run through today's date.
- On load (and on every reconnect), computes "now" in a fixed timezone
  (`America/Los_Angeles` by default) and jumps straight to the correct
  offset into the correct video, the same way `sync-player.html` does for
  `playlist.json` — so anyone opening the page mid-video joins in progress,
  like a real broadcast channel.
- Re-lists the folder every 5 minutes, so dropping in a replacement file
  (same or different name/time) picks up automatically, no redeploy.

### Why this needs a Google **API key**, not the OAuth sign-in above
Everything else in ChannelFlow assumes a human is at the keyboard to click
"Connect Google Drive," and that sign-in's access token expires roughly
hourly. A 24/7 channel has nobody there to re-authenticate. Instead,
`channel.html` uses a Google **API key** (no sign-in, doesn't expire) against
a folder that's shared **"Anyone with the link"** — exactly how you'd share
a folder for this purpose anyway.

**Create the key** (same Cloud project as step 4 above):
1. **APIs & Services → Credentials → Create Credentials → API key**.
2. Click the new key → **Restrict key**:
   - **API restrictions** → Restrict key → check **Google Drive API** only.
   - **Application restrictions** → **Websites** → add the origin(s) you'll
     host this page on (e.g. `https://cdr2.com/*`).
3. Copy the key into `scheduler/js/drive-config.js`:
   ```js
   export const GOOGLE_API_KEY = "AIza...";
   ```
   Even though it's restricted, treat it like the Client ID — it's meant to
   be public/committable, not a backend secret.

**Share the folder**: right-click it in Drive → **Share** → **General
access** → **Anyone with the link** → **Viewer**. (If it's already shared
more broadly — e.g. **Editor**, for a team that uploads into it — that's
fine too, it only needs to be link-readable.)

### Using it
```
https://your-domain/crvideo/channel.html?folder=<DRIVE_FOLDER_ID>&tz=America/Los_Angeles
```
- `folder` — Drive folder ID (defaults to the folder this was built for if
  omitted).
- `tz` — any IANA timezone name (defaults to `America/Los_Angeles`).
- `debug` — shows a live overlay: current slot, computed offset, actual
  player position, and any files whose names didn't match a time range.
- `sound=1` — starts unmuted instead of muted. Browsers block unmuted
  autoplay, so the default is to autoplay **muted** (works unattended on a
  kiosk/TV) with a small "🔇 Tap for sound" button a viewer can click.

### Limitations
- Video duration isn't validated against the filename's time range — if a
  file is shorter than its slot, playback holds on the last frame until the
  next slot starts (same clamping behavior as `sync-player.html`).
- Very large files that Drive flags for a virus-scan warning on the classic
  download link are *not* an issue here — `channel.html` streams through
  the Drive API's `alt=media` endpoint, which supports HTTP Range requests
  (seeking) and skips that interstitial entirely.

## Notes & limitations
- The whole integration is one folder for everything, kept intentionally
  simple. If you want separate "media" vs. "publish" folders later, that's
  a small change to `store.js` (two folder IDs instead of one).
- Drive video playback uses a streaming URL with the access token in the
  query string (`…?alt=media&access_token=…`) so `<video>` can seek/range
  natively. That token expires roughly an hour after connecting — if
  playback of a Drive-sourced clip starts failing, hit **Refresh media
  from Drive** (and reconnect if needed).
- The app requests the broad `drive` scope (full read/write to your
  Drive) rather than the narrower `drive.file` scope, so it can browse a
  folder you didn't create with the app (e.g. one shared by teammates).
  Since this is a personal/internal tool running in Testing mode, that's
  fine; tighten it later if you ever publish this for other users.
- The OAuth token is kept in `sessionStorage` (survives reloads in the
  same tab, cleared when the tab closes) — nothing Drive-related touches
  `localStorage` except the chosen folder's ID/name.
