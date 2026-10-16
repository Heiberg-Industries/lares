#!/bin/sh
set -eu

# Installation-owned configuration is mounted read-only. Never route webhooks to
# an address compiled into the shared image.
config="${LARES_RELAY_CONFIG:-/run/lares/relay.conf}"
case "$config" in
  /*) ;;
  *) echo 'LARES_RELAY_CONFIG must be an absolute path' >&2; exit 1 ;;
esac
if [ ! -r "$config" ]; then
  echo 'Mount the installation relay configuration at /run/lares/relay.conf (or set LARES_RELAY_CONFIG).' >&2
  exit 1
fi
nginx -t -c "$config"
exec nginx -c "$config" -g 'daemon off;'
