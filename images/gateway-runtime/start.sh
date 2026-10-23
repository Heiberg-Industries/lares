#!/bin/sh
set -eu
# This is deliberately the first action after shell safety flags. Direct starts are admitted
# only by the receipt-bound helper that owns inherited fd 9; identity environment alone is
# not authority. Keep this before every secret read and LiteLLM migration effect.
python -I /opt/lares-gateway/gateway_admission.py verify
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
: "${LARES_GATEWAY_ADMISSION_URL:?LARES_GATEWAY_ADMISSION_URL required}"
: "${LARES_GATEWAY_SERVICE_KEY_FILE:?LARES_GATEWAY_SERVICE_KEY_FILE required}"
: "${LARES_GATEWAY_ENDPOINT_HASH:?LARES_GATEWAY_ENDPOINT_HASH required}"
: "${LARES_GATEWAY_PROFILE_FILE:?LARES_GATEWAY_PROFILE_FILE required}"
CONFIG_FILE_PATH=/etc/litellm/config.yaml
export CONFIG_FILE_PATH
LITELLM_RUST=False
DISABLE_AIOHTTP_TRANSPORT=True
export LITELLM_RUST DISABLE_AIOHTTP_TRANSPORT
PYTHONPATH=/opt/lares-gateway
export PYTHONPATH
# The native CLI owns database/schema bootstrap; direct ASGI startup does not.
# Validate first, so missing admission authority never starts an unguarded server.
python /opt/lares-gateway/lares_gateway.py --check
litellm --config "$CONFIG_FILE_PATH" --skip_server_startup --enforce_prisma_migration_check
exec python /opt/lares-gateway/lares_gateway.py
