#!/bin/sh
# server/kiosk-launch.sh
#
# Launches Chrome in kiosk mode pointed at sync-player.html with autoplay
# restrictions disabled, so the channel plays with sound from boot with
# nobody there to click anything. Pairs with the ?unmuted flag in
# sync-player.html (see sync-player.html's FORCE_UNMUTED).
#
# Run this from whatever starts on login/boot on the display machine (a
# systemd user service, an XDG autostart .desktop entry, crontab @reboot,
# etc.) -- this script itself doesn't daemonize or restart Chrome if it
# crashes; wrap it in your init system's restart-on-exit if you want that.

set -eu

URL="${CRVIDEO_PLAYER_URL:-https://cdr2.com/crvideo/sync-player.html?unmuted}"
PROFILE_DIR="${CRVIDEO_CHROME_PROFILE:-$HOME/.config/crvideo-kiosk-chrome}"

CHROME_BIN="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"
if [ -z "$CHROME_BIN" ]; then
  echo "No Chrome/Chromium binary found on PATH." >&2
  exit 1
fi

exec "$CHROME_BIN" \
  --kiosk \
  --autoplay-policy=no-user-gesture-required \
  --user-data-dir="$PROFILE_DIR" \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-translate \
  --no-first-run \
  --overscroll-history-navigation=0 \
  "$URL"
