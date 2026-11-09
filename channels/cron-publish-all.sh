#!/bin/bash
# channels/cron-publish-all.sh
#
# Nightly rolling republish for every channel publish.php actually manages
# (i.e. has a programming.json) -- ustv (Google-Drive-backed, its own
# sync mechanism) and the youtube-adapter-demo fixture ("hidden": true,
# "Not real programming" per its meta.json) are deliberately excluded.
#
# publish.php only takes one channel id per invocation and builds no
# daemon/cron itself (see channels/publish/README.md), so this is the
# loop wrapper its own README suggests wiring into cron. Re-running with
# the same/overlapping window is idempotent (same approved-episode set,
# same recurrence math -- only _publish.generated_at changes), so this
# is safe to run nightly without drifting anything.
#
# Keeping each channel's schedule.json window rolling forward is also
# what lets AnnouncerPipeline::enqueueForSchedule() (called from
# publish.php itself) keep finding new transitions to enqueue for
# channels/announce-worker.php, and what makes channels/announce-gc.php's
# sweep actually reclaim anything over time -- without this, nothing
# ever ages out of any channel's manifest, so the GC has nothing to do.
#
# --window-timezone is passed explicitly as America/Los_Angeles: every
# one of these channels' programming.json blocks recur in that timezone
# (confirmed against each one), but publish.php's own default is UTC.
# Left at the default, a nightly run's --window-start=today (UTC)
# wouldn't land on these channels' own local midnight, which is what
# their rotation checkpoints are anchored to -- causing a spurious
# "window-start is earlier than the last known rotation checkpoint"
# reset warning (and the actual cursor/deferred-queue reset that comes
# with it) on every run instead of a clean overlapping-window continue.
#
# Usage: channels/cron-publish-all.sh [extra publish.php flags, e.g. --dry-run]

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

CHANNELS=(comedy-club film-day-at-school lecture-hall maker pet-central retrovision science world-explorer)

status=0
for ch in "${CHANNELS[@]}"; do
    echo "=== $ch ($(date -u +%FT%TZ)) ==="
    if ! php publish.php "$ch" --window-timezone=America/Los_Angeles "$@"; then
        echo "!!! $ch failed" >&2
        status=1
    fi
done
exit "$status"
