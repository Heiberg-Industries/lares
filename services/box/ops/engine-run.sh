# shellcheck shell=bash
# engine-run.sh — sourced by ops/install.sh, never run on its own.
#
# The box's own programs (the migration runner, the renderers, doctor, the first-owner step)
# are TypeScript that ships INSIDE the keeper image, with their dependencies. This host has no
# Node and no pnpm and installs none. `engine_run` runs one of those programs in a throwaway
# container of the engine image, and the image is named by digest and nothing else.
#
# The image, in the order it is looked for:
#   1. $LARES_ENGINE_IMAGE            tests, and anyone who must name one by hand
#   2. $BOX_DIR/engine-image          one line, written when the engine files were unpacked
#   3. the release file's images["lares-keeper"]
# Whatever is found must be `<repository>@sha256:<64 hex>`; a tag is refused and counts as
# "not found". engine_resolve_image sets ENGINE_IMAGE, or leaves it empty and returns 1.
#
# The container: host network (the database is published on 127.0.0.1 only), root inside it
# (the files it writes are root's, exactly as before), a read-only root filesystem with a
# tmpfs /tmp, every capability dropped, no new privileges, and no Docker socket. Host paths are
# mounted at the SAME path inside, so every path the installer builds (also under --prefix)
# means the same thing on both sides. Nothing secret travels in argv or in the environment: the
# database password is a FILE under the secrets directory, mounted read-only and named by
# DATABASE_PASSWORD_FILE.

ENGINE_IMAGE=""
ENGINE_DIGEST_PATTERN='^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$'

engine_resolve_image() {
  local candidate="" release_file="${1:-}"
  ENGINE_IMAGE=""
  if [ -n "${LARES_ENGINE_IMAGE:-}" ]; then
    candidate="$LARES_ENGINE_IMAGE"
  elif [ -r "$BOX_DIR/engine-image" ]; then
    candidate=$(head -n 1 "$BOX_DIR/engine-image" | tr -d '[:space:]')
  elif [ -n "$release_file" ] && [ -r "$release_file" ]; then
    candidate=$(grep -o '"lares-keeper"[[:space:]]*:[[:space:]]*"[^"]*"' "$release_file" 2>/dev/null \
      | head -n 1 | sed -e 's/^[^:]*:[[:space:]]*"//' -e 's/"$//') || candidate=""
  fi
  if printf '%s' "$candidate" | grep -Eq "$ENGINE_DIGEST_PATTERN"; then
    ENGINE_IMAGE="$candidate"
    return 0
  fi
  return 1
}

# engine_image_mode — true when this box runs the engine from an image (its own `engine-image`
# file, or LARES_ENGINE_IMAGE), false for a checkout that still has node and pnpm. Used by the
# scripts that also have to keep working on a checkout (update, rollback, restore).
engine_image_mode() {
  [ -n "${LARES_ENGINE_IMAGE:-}" ] || [ -r "$BOX_DIR/engine-image" ]
}

# engine_resolve_target_image RELEASE_FILE — for a script that moves to ANOTHER release (update).
# The engine to use is the TARGET release's, never the one this box was unpacked from, so the
# unpacked `engine-image` file is deliberately not consulted: LARES_ENGINE_IMAGE (tests), else
# the release file's images["lares-keeper"]. Sets ENGINE_IMAGE, or leaves it empty and returns 1.
engine_resolve_target_image() {
  local candidate="" release_file="${1:-}"
  ENGINE_IMAGE=""
  if [ -n "${LARES_ENGINE_IMAGE:-}" ]; then
    candidate="$LARES_ENGINE_IMAGE"
  elif [ -n "$release_file" ] && [ -r "$release_file" ]; then
    candidate=$(grep -o '"lares-keeper"[[:space:]]*:[[:space:]]*"[^"]*"' "$release_file" 2>/dev/null \
      | head -n 1 | sed -e 's/^[^:]*:[[:space:]]*"//' -e 's/"$//') || candidate=""
  fi
  if printf '%s' "$candidate" | grep -Eq "$ENGINE_DIGEST_PATTERN"; then
    ENGINE_IMAGE="$candidate"
    return 0
  fi
  return 1
}

# engine_run [--cidfile PATH] [--ro PATH]... [--rw PATH]... [--env NAME=VALUE]... SCRIPT [ARGS...]
#   SCRIPT is relative to services/box inside the image (migrate.ts, bin/render-stack.ts, ...).
#   --env is for plain settings only; a secret is handed over as a file under a --ro mount.
engine_run() {
  local runtime_user=0:0
  local -a docker_args=(
    run --rm --network host --read-only --tmpfs /tmp
    --cap-drop ALL --security-opt no-new-privileges
    -e HOME=/tmp -w /app/services/box
  )
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --runtime-user) runtime_user=10001:10001; shift ;;
      --cidfile) docker_args+=(--cidfile "$2"); shift 2 ;;
      --ro) docker_args+=(-v "$2:$2:ro"); shift 2 ;;
      --rw) docker_args+=(-v "$2:$2"); shift 2 ;;
      --env) docker_args+=(-e "$2"); shift 2 ;;
      *) break ;;
    esac
  done
  [ "$#" -ge 1 ] || { echo "engine_run: no program was named" >&2; return 2; }
  [ -n "$ENGINE_IMAGE" ] || { echo "engine_run: no engine image is known" >&2; return 2; }
  local script="$1"
  shift
  docker "${docker_args[@]:0:4}" --user "$runtime_user" "${docker_args[@]:4}" --entrypoint /app/services/box/node_modules/.bin/tsx \
    "$ENGINE_IMAGE" "/app/services/box/$script" "$@"
}

# operator_db_run COMPOSE_ARGS... -- PROGRAM ARGS...
# Run a PostgreSQL client in a short-lived database image with the host-only offline operator
# secret mounted only into that disposable client. The ordinary database container never gets
# this mount. The secret value is read inside the disposable container, not put in host argv,
# Compose values, or logs. Compose's db image supplies the matching client tools.
operator_db_run() {
  local operator_file="${LARES_OPERATOR_PASSWORD_FILE:-${LARES_PREFIX:-}/etc/lares/operator/database-password}"
  local image_json image timeout_seconds="${OPERATOR_DB_TIMEOUT:-}"
  local -a compose_args=() program=() docker_args=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do compose_args+=("$1"); shift; done
  [ "$#" -gt 0 ] || { echo "operator_db_run: no PostgreSQL command was named" >&2; return 64; }
  shift
  program=("$@")
  [ "${#program[@]}" -gt 0 ] || { echo "operator_db_run: no PostgreSQL command was named" >&2; return 64; }
  [ -f "$operator_file" ] && [ ! -L "$operator_file" ] && [ -s "$operator_file" ] \
    || { echo "operator_db_run: offline operator credential is missing or unsafe; refusing database access" >&2; return 78; }
  [ "$(stat -c '%u:%a' "$operator_file" 2>/dev/null || true)" = 0:600 ] \
    || { echo "operator_db_run: offline operator credential must be root-owned mode 0600" >&2; return 78; }
  if [ -n "$timeout_seconds" ]; then
    [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] && command -v timeout >/dev/null 2>&1 \
      || { echo "operator_db_run: requested timeout is invalid or unavailable" >&2; return 64; }
  fi
  if [ -n "$timeout_seconds" ]; then
    image_json=$(timeout "$timeout_seconds" docker compose "${compose_args[@]}" config --format json) \
      || { echo "operator_db_run: database Compose configuration could not be read" >&2; return 1; }
  else
    image_json=$(docker compose "${compose_args[@]}" config --format json) \
    || { echo "operator_db_run: database Compose configuration could not be read" >&2; return 1; }
  fi
  image=$(printf '%s' "$image_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["db"]["image"])') \
    || { echo "operator_db_run: database image could not be resolved" >&2; return 1; }
  docker_args=(run --rm -i --network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    -v "$operator_file:/run/secrets/database-operator:ro" \
    -e PGPASSWORD_FILE=/run/secrets/database-operator -e PGHOST=127.0.0.1 -e PGPORT="${PGPORT:-5432}" -e PGUSER=lares_operator \
    --entrypoint /bin/sh "$image" -ec 'export PGPASSWORD="$(cat "$PGPASSWORD_FILE")"; unset PGPASSWORD_FILE; exec "$@"' sh "${program[@]}")
  if [ -n "$timeout_seconds" ]; then timeout "$timeout_seconds" docker "${docker_args[@]}"; else docker "${docker_args[@]}"; fi
}
