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

# A bounded normal-state client for update history and migrations. Keep this separate from
# engine_run: only these fixed consumers retain the image's baked maintenance entrypoint and
# receive the installation admission directory.
ENGINE_CLIENT_NAME=""
ENGINE_CLIENT_ID=""
ENGINE_CLIENT_TOKEN=""
ENGINE_CLIENT_OPERATION=""
ENGINE_CLIENT_INTENT=""

engine_client_id_is_valid() {
  [[ "$1" =~ ^[a-f0-9]{64}$ ]]
}

engine_normal_client_cleanup() {
  local inspection="" observed_id="" running="" observed_owner="" observed_operation=""
  local observed_name="" remaining="" name_remaining="" stopped=0 intent_file
  if [ -n "$ENGINE_CLIENT_ID" ] && ! engine_client_id_is_valid "$ENGINE_CLIENT_ID"; then
    echo "engine client cleanup: recorded identity is invalid; checking the fixed name and owner labels" >&2
    ENGINE_CLIENT_ID=""
  fi
  if [ -z "$ENGINE_CLIENT_NAME" ] && [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    for intent_file in "$WORK"/engine-client-*.intent; do
      if [ -e "$intent_file" ] || [ -L "$intent_file" ]; then
        echo "engine client cleanup: an outstanding client intent has no verified shell identity; evidence is retained" >&2
        return 1
      fi
    done
  fi
  [ -n "$ENGINE_CLIENT_NAME" ] || return 0
  if [ -z "$ENGINE_CLIENT_ID" ]; then
    if inspection=$(timeout --kill-after=5 20 docker inspect --format \
        '{{.Id}}|{{.State.Running}}|{{index .Config.Labels "com.lares.maintenance.owner"}}|{{index .Config.Labels "com.lares.maintenance.operation"}}|{{.Name}}' \
        "$ENGINE_CLIENT_NAME" 2>/dev/null); then
      IFS='|' read -r observed_id running observed_owner observed_operation observed_name <<< "$inspection"
      engine_client_id_is_valid "$observed_id" && [ "$observed_owner" = "$ENGINE_CLIENT_TOKEN" ] && \
        [ "$observed_operation" = "$ENGINE_CLIENT_OPERATION" ] && [ "$observed_name" = "/$ENGINE_CLIENT_NAME" ] || {
          echo "engine client cleanup: partial container ownership could not be verified" >&2; return 1;
        }
      ENGINE_CLIENT_ID="$observed_id"
    else
      name_remaining=$(timeout --kill-after=5 20 docker ps -aq --filter "name=^/$ENGINE_CLIENT_NAME$" 2>/dev/null) || {
        echo "engine client cleanup: name absence could not be checked" >&2; return 1;
      }
      [ -z "$name_remaining" ] || { echo "engine client cleanup: named client state is uncertain" >&2; return 1; }
      echo "engine client cleanup: partial client identity remains unverified; intent is retained" >&2
      return 1
    fi
  fi
  if inspection=$(timeout --kill-after=5 20 docker inspect --format \
      '{{.Id}}|{{.State.Running}}|{{index .Config.Labels "com.lares.maintenance.owner"}}|{{index .Config.Labels "com.lares.maintenance.operation"}}|{{.Name}}' \
      "$ENGINE_CLIENT_ID" 2>/dev/null); then
    IFS='|' read -r observed_id running observed_owner observed_operation observed_name <<< "$inspection"
    [ "$observed_id" = "$ENGINE_CLIENT_ID" ] && [ "$observed_owner" = "$ENGINE_CLIENT_TOKEN" ] && \
      [ "$observed_operation" = "$ENGINE_CLIENT_OPERATION" ] || {
        echo "engine client cleanup: immutable client ownership could not be verified" >&2; return 1;
      }
    if [ "$running" = true ]; then
      timeout --kill-after=5 20 docker stop --time 5 "$ENGINE_CLIENT_ID" >/dev/null 2>&1 || stopped=1
      running=$(timeout --kill-after=5 20 docker inspect --format '{{.State.Running}}' \
          "$ENGINE_CLIENT_ID" 2>/dev/null) || {
        echo "engine client cleanup: client state is uncertain" >&2; return 1;
      }
      [ "$running" = false ] || { echo "engine client cleanup: client is still running" >&2; return 1; }
    elif [ "$running" != false ]; then
      echo "engine client cleanup: client state is uncertain" >&2; return 1
    fi
    timeout --kill-after=5 20 docker rm "$ENGINE_CLIENT_ID" >/dev/null 2>&1 || true
  fi
  remaining=$(timeout --kill-after=5 20 docker ps -aq --no-trunc --filter "id=$ENGINE_CLIENT_ID" 2>/dev/null) || {
    echo "engine client cleanup: immutable identity absence could not be checked" >&2; return 1;
  }
  [ -z "$remaining" ] || { echo "engine client cleanup: owned client is still present" >&2; return 1; }
  name_remaining=$(timeout --kill-after=5 20 docker ps -aq --filter "name=^/$ENGINE_CLIENT_NAME$" 2>/dev/null) || {
    echo "engine client cleanup: absence could not be checked" >&2; return 1;
  }
  [ -z "$name_remaining" ] || { echo "engine client cleanup: client name is still present" >&2; return 1; }
  ENGINE_CLIENT_NAME=""
  ENGINE_CLIENT_ID=""
  ENGINE_CLIENT_TOKEN=""
  ENGINE_CLIENT_OPERATION=""
  [ -z "$ENGINE_CLIENT_INTENT" ] || rm -f -- "$ENGINE_CLIENT_INTENT"
  ENGINE_CLIENT_INTENT=""
  return 0
}

# engine_normal_client OPERATION [--ro PATH]... [--env NAME=VALUE]... SCRIPT [ARGS...]
# OPERATION is update or rollback; SCRIPT is update-record.ts or migrate.ts (migration is
# update-only). No generic command, entrypoint override, or writable admission bind is exposed.
engine_normal_client() {
  local operation="$1" script token admission identity identity_id identity_epoch
  shift
  local -a mounts=() environment=() create_args=()
  local mount_count=0 environment_count=0 index
  case "$operation" in update|rollback) ;; *) echo "engine client: unsupported operation" >&2; return 78 ;; esac
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --ro)
        [ "$#" -ge 2 ] || { echo "engine client: a read-only file was not named" >&2; return 78; }
        mounts+=(--mount "type=bind,src=$2,dst=$2,readonly")
        mount_count=$((mount_count + 2))
        shift 2
        ;;
      --env)
        [ "$#" -ge 2 ] || { echo "engine client: an environment value was not named" >&2; return 78; }
        case "$2" in
          DATABASE_PASSWORD_FILE=*|LARES_OPERATOR_PASSWORD_FILE=*|PGHOST=*|PGPORT=*|PGDATABASE=*|PGUSER=*)
            environment+=(--env "$2")
            environment_count=$((environment_count + 2)) ;;
          *) echo "engine client: environment name is not supported" >&2; return 78 ;;
        esac
        shift 2
        ;;
      *) break ;;
    esac
  done
  [ "$#" -ge 1 ] || { echo "engine client: no fixed program was named" >&2; return 78; }
  [ "$mount_count" -gt 0 ] || { echo "engine client: a read-only input file is required" >&2; return 78; }
  script="$1"
  shift
  case "$operation:$script" in
    update:bin/update-record.ts|update:migrate.ts|rollback:bin/update-record.ts) ;;
    *) echo "engine client: program is outside the fixed update/rollback set" >&2; return 78 ;;
  esac
  [ -n "$ENGINE_IMAGE" ] || { echo "engine client: no engine image is known" >&2; return 78; }
  [ -n "${ADMISSION_PREFIX:-}" ] || { echo "engine client: installation admission is unavailable" >&2; return 78; }
  command -v timeout >/dev/null 2>&1 || { echo "engine client: bounded cleanup is unavailable" >&2; return 78; }
  if [ "${MAINTENANCE_TEST_OWNER:-0}" = 1 ]; then
    python3 "$HERE/maintenance-custody.py" assert-normal-held "$ADMISSION_PREFIX" "$operation" --test-owner >/dev/null 2>&1
  else
    python3 "$HERE/maintenance-custody.py" assert-normal-held "$ADMISSION_PREFIX" "$operation" >/dev/null 2>&1
  fi
  if [ "$?" -ne 0 ]; then
    echo "engine client: normal admission is no longer valid" >&2
    return 78
  fi
  if [ "${MAINTENANCE_TEST_OWNER:-0}" = 1 ]; then
    identity=$(python3 "$HERE/maintenance-custody.py" validate-identity "$ADMISSION_PREFIX" "${LARES_SUBNET:-172.30.0.0/24}" --test-owner) || return 78
  else
    identity=$(python3 "$HERE/maintenance-custody.py" validate-identity "$ADMISSION_PREFIX" "${LARES_SUBNET:-172.30.0.0/24}") || return 78
  fi
  if [ -z "$identity" ]; then
    echo "engine client: installation receipt could not be validated" >&2
    return 78
  fi
  identity_id=$(printf '%s' "$identity" | python3 -c 'import json,sys; value=json.load(sys.stdin); print(value["installationId"])' 2>/dev/null) || return 78
  identity_epoch=$(printf '%s' "$identity" | python3 -c 'import json,sys; value=json.load(sys.stdin); print(value["epoch"])' 2>/dev/null) || return 78
  admission="$ADMISSION_PREFIX/var/lib/lares-maintenance/admission"
  if [ "$(timeout --kill-after=5 20 docker image inspect --format '{{json .Config.Entrypoint}}' "$ENGINE_IMAGE" 2>/dev/null)" != '["/usr/local/lib/lares/maintenance-admission-v1"]' ]; then
    echo "engine client: image does not contain the required maintenance entrypoint" >&2
    return 78
  fi
  token=$(python3 -c 'import uuid; print(uuid.uuid4().hex)' 2>/dev/null) || return 78
  ENGINE_CLIENT_TOKEN="$token"
  ENGINE_CLIENT_OPERATION="$operation"
  ENGINE_CLIENT_NAME="lares-${operation}-client-${token}"
  ENGINE_CLIENT_ID=""
  local cidfile="${WORK:?}/engine-client-${token}.cid" wait_status attach_status result inspection remaining
  ENGINE_CLIENT_INTENT="${WORK}/engine-client-${token}.intent"
  (umask 077; printf '%s\n%s\n%s\n' "$ENGINE_CLIENT_NAME" "$token" "$operation" > "$ENGINE_CLIENT_INTENT") || return 78
  create_args=(--name "$ENGINE_CLIENT_NAME" --cidfile "$cidfile" \
      --label "com.lares.maintenance.owner=$token" \
      --label "com.lares.maintenance.operation=$operation" \
      --network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
      -e HOME=/tmp -w /app/services/box \
      --mount "type=bind,src=$admission,dst=/run/lares-maintenance/admission,readonly")
  for ((index = 0; index < mount_count; index++)); do create_args+=("${mounts[index]}"); done
  for ((index = 0; index < environment_count; index++)); do create_args+=("${environment[index]}"); done
  if ! result=$(timeout --kill-after=5 30 docker create "${create_args[@]}" \
      "$ENGINE_IMAGE" /run/lares-maintenance/admission "$identity_id" "$identity_epoch" -- \
      node --import tsx/esm "/app/services/box/$script" "$@" 2>&1); then
    echo "engine client: the guarded client could not be created" >&2
    engine_normal_client_cleanup || return 78
    return 78
  fi
  ENGINE_CLIENT_ID=$(cat "$cidfile" 2>/dev/null || true)
  if ! engine_client_id_is_valid "$ENGINE_CLIENT_ID"; then
    echo "engine client: container identity was not recorded" >&2
    ENGINE_CLIENT_ID=""
    engine_normal_client_cleanup || return 78
    return 78
  fi
  inspection=$(timeout --kill-after=5 20 docker inspect --format \
      '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.lares.maintenance.owner"}}|{{index .Config.Labels "com.lares.maintenance.operation"}}' \
      "$ENGINE_CLIENT_ID" 2>/dev/null) || {
    echo "engine client: ownership could not be verified before start" >&2
    engine_normal_client_cleanup || return 78
    return 78
  }
  [ "$inspection" = "$ENGINE_CLIENT_ID|/$ENGINE_CLIENT_NAME|$token|$operation" ] || {
    echo "engine client: ownership changed before start" >&2
    engine_normal_client_cleanup || return 78
    return 78
  }
  if timeout --kill-after=5 1800 docker start --attach "$ENGINE_CLIENT_ID"; then
    attach_status=0
  else
    attach_status=$?
  fi
  case "$attach_status" in
    124|137)
      echo "engine client: attached client exceeded its bounded run" >&2
      engine_normal_client_cleanup || return 78
      return 78
      ;;
  esac
  if ! result=$(timeout --kill-after=5 30 docker wait "$ENGINE_CLIENT_ID" 2>/dev/null); then
    echo "engine client: client completion could not be verified" >&2
    engine_normal_client_cleanup || return 78
    return 78
  fi
  case "$result" in ''|*[!0-9]*) echo "engine client: client exit status was unreadable" >&2; engine_normal_client_cleanup || return 78; return 78 ;; esac
  wait_status=$((10#$result))
  inspection=$(timeout --kill-after=5 20 docker inspect --format \
      '{{.Id}}|{{.State.Running}}|{{.State.ExitCode}}|{{index .Config.Labels "com.lares.maintenance.owner"}}|{{index .Config.Labels "com.lares.maintenance.operation"}}' \
      "$ENGINE_CLIENT_ID" 2>/dev/null) || {
    echo "engine client: client completion could not be verified" >&2
    engine_normal_client_cleanup || return 78
    return 78
  }
  [ "$inspection" = "$ENGINE_CLIENT_ID|false|$wait_status|$token|$operation" ] || {
    echo "engine client: client ownership or completion changed" >&2
    engine_normal_client_cleanup || return 78
    return 78
  }
  if ! engine_normal_client_cleanup; then return 78; fi
  if [ "$attach_status" -ne 0 ] && [ "$wait_status" -eq 0 ]; then
    echo "engine client: output stream ended before client completion was confirmed" >&2
    return 78
  fi
  return "$wait_status"
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
