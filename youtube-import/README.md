# youtube-import

A standalone PHP command-line tool that imports a YouTube channel's
uploads (or a specific playlist) via the official YouTube Data API v3,
and writes or refreshes a portable `series.json` (see
`docs/series-and-channels.md` in the repo root for the full schema and
how series fit into a channel). No framework, no Composer -- plain PHP
8.2+, manually `require`d, in the same style as `ia-import/`.

**Importing never publishes anything.** Every new video becomes an
editorial "candidate"; only an editor approving it (and a later run of
`channels/publish.php`) can get it onto a broadcast channel. See
"Editorial status and content rights" below and in
`docs/series-and-channels.md`.

## Quick start

```sh
# A channel, by its @handle
php youtube-import.php --channel="@TechnologyConnections" \
  --output=../series/technology-connections/series.json

# A channel, by its canonical UC... id (skips the handle lookup)
php youtube-import.php --channel-id=UCy0tKL1T7wFoYcxCe0xjN6Q \
  --output=../series/technology-connections/series.json

# A specific playlist
php youtube-import.php --playlist=PLxxxxxxxxxxxxxxxxxxxxxxxx \
  --output=../series/some-playlist-series/series.json

# Preview what a run would do without writing anything
php youtube-import.php --channel="@TechnologyConnections" \
  --output=../series/technology-connections/series.json --dry-run --verbose

# Cap how many videos get enumerated (useful for a first trial run on a
# channel with hundreds of uploads)
php youtube-import.php --channel="@TechnologyConnections" \
  --output=../series/technology-connections/series.json --max-videos=20

# Refresh a previously-imported series: re-checks videos that were
# previously marked unavailable/private/deleted (skipped by default to
# save API quota), on top of the normal always-refreshed behavior for
# still-available and newly-discovered videos
php youtube-import.php --channel="@TechnologyConnections" \
  --output=../series/technology-connections/series.json --refresh
```

Note: every `--flag` that takes a value must use `=` (e.g. `--output=PATH`),
not a space — the parser treats `--output PATH` as the boolean flag
`--output` followed by a stray positional argument, silently dropping the
path. Same convention as `ia-import.php`.

## Credentials

Never pass an API key on the command line (it would be visible to any
other process on the machine via `ps`). In order:

1. The `YOUTUBE_API_KEY` environment variable, or
2. an untracked local PHP file (default `youtube-import/config.local.php`,
   override with `--config=PATH`) that returns an array:

   ```php
   <?php
   return ['api_key' => 'YOUR_YOUTUBE_DATA_API_V3_KEY'];
   ```

`config.local.php` is gitignored (`youtube-import/.gitignore`) -- the same
"untracked PHP file returned via `require`" shape this repo already uses
for `server/publish-secret.php`. **Never commit an API key.**

Getting a key: in the Google Cloud Console, enable the "YouTube Data API
v3" for a project, then create an API key credential (no OAuth consent
screen needed -- this tool only reads public metadata via a plain API
key, never an authenticated user's own data).

## CLI options

```
--channel=HANDLE_OR_USERNAME   Channel to import, by "@handle" or legacy username
--channel-id=ID                 Channel to import, by its canonical UC... id (skips handle lookup)
--playlist=ID                   Playlist to import directly (ignored if --channel/--channel-id given)
--output=PATH                   series.json to write/refresh (required)
--series-id=ID                   Override the series "id" (default: the --output directory's name)
--title=TITLE                    Override the series title (default: the channel/playlist's own title)
--max-videos=N                   Stop after discovering N videos
--refresh                        Also re-check videos previously marked unavailable/deleted/private
--dry-run                        Print the summary of what would change; write nothing
--verbose                        List every added/updated/unavailable episode id, not just counts
--config=PATH                    Path to a local PHP file returning ['api_key' => '...']
--timeout=SECONDS                Request timeout (default: 15)
--fixtures=DIR                   Serve API responses from DIR/*.json instead of the network (see tests/)
--help                           Display usage
```

Exactly one of `--channel`, `--channel-id`, `--playlist` is required.

## What gets written

A `series.json` matching the schema in `docs/series-and-channels.md`.
Every new video is appended as:

```json
{
  "id": "yt-dQw4w9WgXcQ",
  "episode_number": 7,
  "title": "...",
  "description": "...",
  "duration": 1234.0,
  "year": 2024,
  "published_at": "2024-03-15T12:00:00Z",
  "thumbnail_url": "https://...",
  "guests": [],
  "source": {
    "provider": "youtube", "video_id": "dQw4w9WgXcQ",
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "channel_id": "...", "channel_title": "...",
    "kind": "upload", "embeddable": true, "made_for_kids": false,
    "privacy_status": "public", "availability": "available", "availability_detail": null
  },
  "status": "candidate",
  "rights": { "status": "unverified", "notes": null }
}
```

`kind` is one of `upload`, `short` (heuristic: duration <= 60s -- the
Data API has no authoritative "is a Short" field), `live_upcoming`,
`live_active`, or `live_vod`. For a live stream that hasn't ended, the
real duration is unknown and is never reported as `0` -- see
`src/YouTubeVideoClassifier.php`'s header for why YouTube's own API
makes that an easy mistake to make (`contentDetails.duration` reads
`"P0D"` while a stream is live).

### Which fields a refresh touches, and which it never does

| Field(s) | On refresh |
|---|---|
| `duration`, `year`, `published_at`, `thumbnail_url`, everything under `source` | always re-synced from the API |
| `title`, `description`, `guests`, `status`, `rights`, `episode_number` | **never touched again after creation** -- see below |

This is a deliberate simplification over tracking a per-field "was this
hand-edited?" dirty bit (which would need to remember the last value
*this tool* wrote, to tell "never touched" apart from "edited back to
coincidentally the same text"). Freezing those fields at creation time is
the simpler rule that can never clobber a hand edit, which is the hard
requirement; the cost is that a title YouTube later corrects won't
auto-sync -- an editor can still fix it by hand.

A video that stops resolving (deleted, made private, etc.) is marked
`source.availability = "unavailable"` in place -- **never removed** from
the array. Brand-new videos are appended at the end, numbered continuing
from the current max `episode_number`, and always start as
`status: "candidate"` with `rights.status: "unverified"`.

Writes are atomic (temp file + rename) and keep one prior-version backup
alongside the file (`<output>.bak`).

## Editorial status and content rights

`status` (`candidate` / `approved` / `rejected` / `disabled`) and
`rights.status` (`unverified` / `creator_permission` / `licensed` /
`public_domain` / `restricted`) are tracked separately and are **never**
set by this tool except at creation (`candidate` / `unverified`). Neither
a successful API fetch nor a video being publicly embeddable is ever
treated as permission to air it -- an editor has to set `status:
"approved"` by hand (or via whatever future editorial tool reads/writes
these files) before `channels/publish.php` will ever schedule it. See
`docs/series-and-channels.md` for the full policy, including why
`rights.status: "creator_permission"` never overrides YouTube's own API
terms or changes anything about how the video is played back.

## Testing

Same plain-PHP runner as `ia-import` (no PHPUnit, no Composer):

```sh
php youtube-import/tests/run-tests.php            # run everything
php youtube-import/tests/run-tests.php Recurrence # filter by substring
```

All tests run against `tests/fixtures/*.json` (shaped like real
`channels.list`/`playlistItems.list`/`videos.list`/`playlists.list`
responses) via `--fixtures=DIR` -- zero live network calls, zero API
quota used.

## Known limitations

- Shorts detection is a duration heuristic (<=60s), not an authoritative
  API field.
- Region-restriction/embeddability handling only special-cases the two
  genuinely permanent YouTube error codes (100 not found, 101/150
  embedding disabled); other error codes fall through to the ordinary
  bounded-retry path in `YouTubeApiClient`.
- No OAuth / authenticated access -- this is API-key-only, read-only
  public metadata, per the project's "never bypass playback restrictions"
  principle. A channel owner's own private/unlisted videos are not
  specially surfaced; they're simply omitted from `videos.list`'s
  response like any other inaccessible video.
