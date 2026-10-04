# Local video cache downloader

`download-cache.mjs` pre-fetches the Drive video for whichever playlist
entry is airing right now, plus the one airing next, to `../cache/*.mp4`.
`sync-player.html` plays that local copy when it's present instead of
streaming straight from the Drive API in the browser -- which avoids the
403/"automated queries" block entirely for cached entries, since there's no
cross-site request or OAuth token in the URL at all once a file is local.

It keeps exactly two video files on disk (current + next) and deletes
anything else on every run, so disk usage stays bounded at roughly 2.5GB
rather than growing toward the full 24-hour loop (~85GB across all 72
segments).

## One-time setup

This needs a Google **service account** -- unlike the browser-side OAuth
flow (`scheduler/js/drive.js`, `sync-player.html`), a cron job can't pop up
a consent screen, so it needs a credential that works unattended.

1. **Create a service account** in the same Google Cloud project as the
   existing OAuth client (`GOOGLE_CLIENT_ID` in `scheduler/js/drive-config.js`):
   **IAM & Admin → Service Accounts → Create Service Account**. Name it
   something like `crvideo-cache-downloader`. No project IAM role is
   needed -- Drive access is granted by sharing, not by IAM.

2. **Create a JSON key** for it: open the new service account →
   **Keys → Add Key → Create new key → JSON**. This downloads a file.

3. **Save that file as `server/service-account.json`** (this exact path --
   `download-cache.mjs` reads it from there). This file is a credential;
   it's already covered by `.gitignore` and must never be committed.

4. **Share the Drive folder with the service account.** Open
   https://drive.google.com/drive/folders/1BQinVkjBE9IzRbMWxk6OJQhKGMHrqV1O
   (the `reels` folder) → **Share** → paste in the service account's email
   address (shown on its details page, looks like
   `crvideo-cache-downloader@<project-id>.iam.gserviceaccount.com`) →
   **Viewer**. This covers every file in the folder, so new segments don't
   need re-sharing later.

5. **Install dependencies:**
   ```sh
   cd server && npm install
   ```

6. **Test it manually:**
   ```sh
   node server/download-cache.mjs
   ```
   First run should print `Downloading "..."` for the currently-airing and
   next entries, then `Done: "..."`, and create `cache/manifest.json`.
   Re-running immediately should do nothing (files already present).

## Running it on a schedule

Add a cron entry that fires every minute. `flock -n` makes repeated
invocations safe even if one run is still mid-download (large files can
take a few minutes depending on bandwidth) -- a run that can't get the lock
just exits immediately instead of starting a second overlapping download:

```cron
* * * * * flock -n /home/cdr/domains/cdr2.com/www/crvideo/cache/.lock /home/cdr/.nvm/versions/node/v22.22.0/bin/node /home/cdr/domains/cdr2.com/www/crvideo/server/download-cache.mjs >> /home/cdr/domains/cdr2.com/www/crvideo/server/download-cache.log 2>&1
```

(Adjust the node path if it changes -- check with `which node`.)

## How `sync-player.html` uses this

On boot and on every manifest refresh, the player also fetches
`cache/manifest.json`. For an entry with a `driveFileId`, it plays
`cache/<driveFileId>.mp4` directly (same-origin, full native `<video>`
range/seek support) when the manifest marks that id `ready: true`.
Otherwise it falls back to the live Drive streaming URL + OAuth flow exactly
as before -- so playback still works (just without the ORB-safety benefit)
before the cache has warmed up, or if the downloader falls behind or fails
for a given file.

## Format `download-cache.mjs` expects

Only the `recurring` playlist format (`playlist.json` at the repo root, the
one actually in use) is supported -- it reads `timezone` + `entries[].{startSec,endSec,driveFileId,title}`
to figure out what's airing now and next. The one-off absolute-date format
sync-player.html also supports isn't handled by this script.
