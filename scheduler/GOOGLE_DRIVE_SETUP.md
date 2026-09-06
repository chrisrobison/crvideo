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
