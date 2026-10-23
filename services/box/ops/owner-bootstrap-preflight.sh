#!/usr/bin/env bash
# Read-only fresh-install check for lares owner-bootstrap. All authority inputs are the
# installation's protected files and the live database; no copied provider data is passed here.
set -euo pipefail

PREFIX="${LARES_PREFIX:-}"
ROOT="$PREFIX/opt/lares"
CUR="$ROOT/current"
OPS="$CUR/services/box/ops"
BOX_DIR="$CUR/services/box"
INSTALL_ENV="$PREFIX/etc/lares/installation.env"
KEEPER_CONFIG="$PREFIX/etc/lares/keeper.json"
DATABASE_PASSWORD_FILE="$PREFIX/etc/lares/secrets/database-password"
: "${LARES_OWNER_BOOTSTRAP_CIDFILE:?owner bootstrap container id file is required}"

. "$OPS/engine-run.sh"
engine_resolve_image "$CUR/release.json" || { echo "owner bootstrap preflight refused: no installed engine image" >&2; exit 1; }

engine_run --cidfile "$LARES_OWNER_BOOTSTRAP_CIDFILE" --ro "$INSTALL_ENV" --ro "$KEEPER_CONFIG" --ro "$DATABASE_PASSWORD_FILE" \
  --env "DATABASE_PASSWORD_FILE=$DATABASE_PASSWORD_FILE" \
  --env "LARES_INSTALLATION_ENV_FILE=$INSTALL_ENV" \
  --env "LARES_KEEPER_CONFIG_FILE=$KEEPER_CONFIG" \
  --env "PGHOST=${PGHOST:-127.0.0.1}" --env "PGPORT=${PGPORT:-5432}" \
  --env "PGDATABASE=${PGDATABASE:-lares_state}" --env "PGUSER=lares_app" \
  bin/owner-bootstrap-preflight.ts
