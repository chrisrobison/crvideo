#!/usr/bin/env bash
# Makes every tree the web server (www-data) and the CLI user both WRITE group-writable:
# files 664, directories 2775 (setgid, so new entries inherit group www-data), group www-data.
# Safe to re-run any time (e.g. after a checkout, restore or a root-run job left files behind).
# Code is deliberately NOT touched -- only data: series/, bumps/, media/, cache/, each channel's
# own directory, playlist.json and the logs.
#
#   server/fix-permissions.sh            # needs to be a member of www-data; uses sudo -n only for
#                                        # entries owned by someone else (e.g. www-data-created files)
set -euo pipefail
cd "$(dirname "$0")/.."

roots=(series bumps media cache ia-import/.cache)
for d in channels/*/; do [ -f "$d/meta.json" ] && roots+=("${d%/}"); done
roots=($(for r in "${roots[@]}"; do [ -e "$r" ] && echo "$r"; done))

fix() { # $1 = find predicate args for who owns it ; $2.. = command prefix
  local sudo=$1; shift
  $sudo find "${roots[@]}" "$@" \( -type d -exec chmod g+rwxs {} + -o -type f -exec chmod g+rw {} + \)
  $sudo find "${roots[@]}" "$@" ! -group www-data -exec chgrp www-data {} +
}
fix "" -user "$(id -un)"
if [ -n "$(find "${roots[@]}" ! -user "$(id -un)" -print -quit)" ]; then
  fix "sudo -n" ! -user "$(id -un)"
fi
for f in playlist.json playlist.json.bak channels/*.log server/*.log; do
  [ -e "$f" ] || continue
  if [ -O "$f" ]; then chmod g+rw "$f"; chgrp www-data "$f"; else sudo -n chmod g+rw "$f"; sudo -n chgrp www-data "$f"; fi
done
echo "ok: $(find "${roots[@]}" -type d ! -perm -g=w | wc -l) dirs and $(find "${roots[@]}" -type f ! -perm -g=w | wc -l) files still lack group-write"
