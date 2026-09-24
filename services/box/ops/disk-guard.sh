#!/usr/bin/env bash
# /usr/local/bin/disk-guard.sh
#
# Reports root-filesystem usage to an Uptime Kuma "Push" monitor.
#   - under threshold  -> status=up   (Kuma stays green; disk% plotted as "ping")
#   - at/over threshold -> status=down (Kuma fires its configured notification)
# Bonus: if this stops running (box down / broken), Kuma's missed-heartbeat
# alert fires on its own — so it also catches "the box went away".
#
# Config lives in /etc/disk-guard.env (KUMA_PUSH_URL required; THRESHOLD/MOUNT
# optional). The push URL is a secret-ish token, kept out of this script.
set -euo pipefail

ENV_FILE=/etc/disk-guard.env
# shellcheck source=/dev/null
[ -r "$ENV_FILE" ] && . "$ENV_FILE"
if [ -z "${KUMA_PUSH_URL:-}" ]; then
  echo "disk-guard: KUMA_PUSH_URL not set — checked disk, cannot push"
  exit 0
fi
THRESHOLD="${THRESHOLD:-75}"
MOUNT="${MOUNT:-/}"

pct=$(df --output=pcent "$MOUNT" | tail -1 | tr -dc '0-9')

if [ "$pct" -ge "$THRESHOLD" ]; then
  status=down; msg="disk ${pct}% >= ${THRESHOLD}% on $(hostname):${MOUNT}"
else
  status=up;   msg="disk ${pct}% on $(hostname):${MOUNT}"
fi

curl -fsS -m 15 -G "$KUMA_PUSH_URL" \
  --data-urlencode "status=$status" \
  --data-urlencode "msg=$msg" \
  --data-urlencode "ping=$pct" \
  -o /dev/null
