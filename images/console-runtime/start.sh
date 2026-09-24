#!/bin/sh
set -eu
: "${CONSOLE_SESSION_SECRET_FILE:?CONSOLE_SESSION_SECRET_FILE required}"
if [ ! -r "$CONSOLE_SESSION_SECRET_FILE" ]; then
  echo "lares: CONSOLE_SESSION_SECRET_FILE ($CONSOLE_SESSION_SECRET_FILE) is not readable." >&2
  exit 78
fi
CONSOLE_SESSION_SECRET=$(cat "$CONSOLE_SESSION_SECRET_FILE")
export CONSOLE_SESSION_SECRET
exec node services/console/server.js
