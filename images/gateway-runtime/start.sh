#!/bin/sh
set -eu
: "${MODEL_PROVIDER_KEY_FILE:?MODEL_PROVIDER_KEY_FILE required}"
: "${GATEWAY_MASTER_KEY_FILE:?GATEWAY_MASTER_KEY_FILE required}"
: "${DATABASE_PASSWORD_FILE:?DATABASE_PASSWORD_FILE required}"
: "${PGHOST:?PGHOST required}"
: "${PGPORT:?PGPORT required}"
: "${PGDATABASE:?PGDATABASE required}"
: "${PGUSER:?PGUSER required}"
if [ ! -r "$MODEL_PROVIDER_KEY_FILE" ]; then
  echo "lares: MODEL_PROVIDER_KEY_FILE ($MODEL_PROVIDER_KEY_FILE) is not readable." >&2
  exit 78
fi
if [ ! -r "$GATEWAY_MASTER_KEY_FILE" ]; then
  echo "lares: GATEWAY_MASTER_KEY_FILE ($GATEWAY_MASTER_KEY_FILE) is not readable." >&2
  exit 78
fi
if [ ! -r "$DATABASE_PASSWORD_FILE" ]; then
  echo "lares: DATABASE_PASSWORD_FILE ($DATABASE_PASSWORD_FILE) is not readable." >&2
  exit 78
fi
LARES_MODEL_PROVIDER_KEY=$(cat "$MODEL_PROVIDER_KEY_FILE")
export LARES_MODEL_PROVIDER_KEY
LARES_GATEWAY_MASTER_KEY=$(cat "$GATEWAY_MASTER_KEY_FILE")
export LARES_GATEWAY_MASTER_KEY
# install.sh generates this password as base64url: it contains no URL delimiters, whitespace or
# shell metacharacters. Keep it out of argv and Compose; it exists in this process only long
# enough to build the one environment variable LiteLLM's database-backed key manager reads.
LARES_DATABASE_PASSWORD=$(cat "$DATABASE_PASSWORD_FILE")
DATABASE_URL="postgresql://${PGUSER}:${LARES_DATABASE_PASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"
export DATABASE_URL
LARES_DATABASE_PASSWORD=
exec litellm --config /etc/litellm/config.yaml
