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

# Restore clients retain the same baked admission entrypoint as update clients, but their
# ownership evidence lives in the parent restore run (command substitutions do not preserve
# shell globals). These functions are deliberately separate from engine_run/operator_db_run.
RESTORE_CLIENT_NAME=""
RESTORE_CLIENT_ID=""
RESTORE_CLIENT_TOKEN=""
RESTORE_CLIENT_OPERATION=""
RESTORE_CLIENT_INTENT=""
RESTORE_CLIENT_CIDFILE=""

restore_client_id_is_valid() { [[ "$1" =~ ^[a-f0-9]{64}$ ]]; }
restore_client_at() { # physical prefix, logical absolute path; preserve exactly one leading slash
  local prefix="$1" logical="${2#/}"
  if [ "$prefix" = / ] || [ -z "$prefix" ]; then printf '/%s' "$logical"; else printf '%s/%s' "${prefix%/}" "$logical"; fi
}

restore_client_intent_write() { # run-directory, intent-file, op, owner token, container name, id or empty, state
  python3 - "$@" <<'PYRESTOREINTENT'
import json, os, pathlib, secrets, stat, sys
directory = pathlib.Path(sys.argv[1])
name, operation, owner, container, identity, state = sys.argv[2:]
try:
    fd = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError()
        record = {'version': 1, 'operation': operation, 'owner': owner, 'name': container,
                  'containerId': identity or None, 'state': state}
        raw = (json.dumps(record, sort_keys=True, separators=(',', ':')) + '\n').encode('ascii')
        if len(raw) > 1024 or '/' in name or not name.endswith('.intent'):
            raise ValueError()
        temporary = '.restore-intent-' + secrets.token_hex(12)
        out = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600, dir_fd=fd)
        try:
            with os.fdopen(out, 'wb', closefd=False) as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        finally:
            os.close(out)
        os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        os.close(fd)
except Exception:
    raise SystemExit(1)
PYRESTOREINTENT
}

restore_client_intent_clear() { # run-directory, intent-file, op, owner token, container name, id
  python3 - "$@" <<'PYRESTORECLEAR'
import json, os, pathlib, stat, sys
directory = pathlib.Path(sys.argv[1])
name, operation, owner, container, identity = sys.argv[2:]
try:
    fd = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError()
        record_fd = os.open(name, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | os.O_NONBLOCK, dir_fd=fd)
        try:
            record_info = os.fstat(record_fd)
            if (not stat.S_ISREG(record_info.st_mode) or record_info.st_uid != os.geteuid() or
                    stat.S_IMODE(record_info.st_mode) != 0o600 or record_info.st_nlink != 1 or record_info.st_size > 1024):
                raise ValueError()
            raw = os.read(record_fd, 1025)
        finally:
            os.close(record_fd)
        record = json.loads(raw)
        expected = {'version': 1, 'operation': operation, 'owner': owner, 'name': container,
                    'containerId': identity or None, 'state': 'created' if identity else 'creating'}
        if (record != expected or raw != (json.dumps(record, sort_keys=True, separators=(',', ':')) + '\n').encode('ascii')):
            raise ValueError()
        os.unlink(name, dir_fd=fd)
        os.fsync(fd)
    finally:
        os.close(fd)
except Exception:
    raise SystemExit(1)
PYRESTORECLEAR
}

restore_client_cidfile_read() { # private per-run cidfile; print only a valid immutable id
  python3 - "$@" <<'PYRESTORECIDREAD'
import os, pathlib, re, stat, sys
path = pathlib.Path(sys.argv[1])
try:
    parent = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    try:
        parent_info = os.fstat(parent)
        if (not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != os.geteuid() or
                stat.S_IMODE(parent_info.st_mode) != 0o700): raise ValueError()
        fd = os.open(path.name, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or
                    info.st_mode & 0o022 or info.st_size != 64): raise ValueError()
            raw = os.read(fd, 65)
        finally: os.close(fd)
    finally: os.close(parent)
    identity = raw.decode('ascii')
    if len(raw) != 64 or not re.fullmatch(r'[a-f0-9]{64}', identity): raise ValueError()
    print(identity)
except Exception: raise SystemExit(1)
PYRESTORECIDREAD
}

restore_client_cidfile_clear() { # cidfile, immutable id
  python3 - "$@" <<'PYRESTORECID'
import os, pathlib, stat, sys
path = pathlib.Path(sys.argv[1]); expected = sys.argv[2].encode('ascii')
try:
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                info.st_nlink != 1 or info.st_size != 64 or len(expected) != 64 or
                os.read(fd, len(expected) + 1) != expected):
            raise ValueError()
    finally:
        os.close(fd)
    parent = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    try:
        os.unlink(path.name, dir_fd=parent); os.fsync(parent)
    finally:
        os.close(parent)
except Exception:
    raise SystemExit(1)
PYRESTORECID
}

engine_restore_client_intents_clear() {
  [ -n "${RESTORE_WORK:-}" ] && [ -d "$RESTORE_WORK" ] || return 0
  local intent
  for intent in "$RESTORE_WORK"/restore-client-*.intent; do
    if [ -e "$intent" ] || [ -L "$intent" ]; then
      echo 'restore client cleanup: a child intent remains; restore evidence is retained' >&2
      return 1
    fi
  done
}

engine_restore_client_cleanup() {
  local inspection observed_id running observed_owner observed_operation observed_name remaining name_remaining wait_status
  [ -n "$RESTORE_CLIENT_NAME" ] || return 0
  if [ -z "$RESTORE_CLIENT_ID" ] || ! restore_client_id_is_valid "$RESTORE_CLIENT_ID"; then
    if [ -n "$RESTORE_CLIENT_CIDFILE" ] && RESTORE_CLIENT_ID=$(restore_client_cidfile_read "$RESTORE_CLIENT_CIDFILE" 2>/dev/null) &&
        restore_client_id_is_valid "$RESTORE_CLIENT_ID"; then
      restore_client_intent_write "$RESTORE_WORK" "${RESTORE_CLIENT_INTENT##*/}" "$RESTORE_CLIENT_OPERATION" \
        "$RESTORE_CLIENT_TOKEN" "$RESTORE_CLIENT_NAME" "$RESTORE_CLIENT_ID" created || {
          echo 'restore client cleanup: cidfile identity could not be made durable; intent is retained' >&2; return 1;
        }
    else
      echo 'restore client cleanup: immutable container identity is unavailable; intent is retained' >&2
      return 1
    fi
  fi
  if inspection=$(timeout --kill-after=5 20 docker inspect --format \
      '{{.Id}}|{{.State.Running}}|{{index .Config.Labels "com.lares.restore.owner"}}|{{index .Config.Labels "com.lares.restore.operation"}}|{{.Name}}' \
      "$RESTORE_CLIENT_ID" 2>/dev/null); then
    IFS='|' read -r observed_id running observed_owner observed_operation observed_name <<< "$inspection"
    [ "$observed_id" = "$RESTORE_CLIENT_ID" ] && [ "$observed_owner" = "$RESTORE_CLIENT_TOKEN" ] && \
      [ "$observed_operation" = "$RESTORE_CLIENT_OPERATION" ] && [ "$observed_name" = "/$RESTORE_CLIENT_NAME" ] || {
        echo 'restore client cleanup: immutable ownership or name changed; intent is retained' >&2; return 1;
      }
    if [ "$running" = true ]; then
      timeout --kill-after=5 20 docker stop --time 5 "$RESTORE_CLIENT_ID" >/dev/null 2>&1 || true
      wait_status=$(timeout --kill-after=5 20 docker wait "$RESTORE_CLIENT_ID" 2>/dev/null) || {
        echo 'restore client cleanup: stopped client completion is uncertain; intent is retained' >&2; return 1;
      }
      case "$wait_status" in ''|*[!0-9]*) echo 'restore client cleanup: stopped client status is unreadable; intent is retained' >&2; return 1 ;; esac
      running=$(timeout --kill-after=5 20 docker inspect --format '{{.State.Running}}' "$RESTORE_CLIENT_ID" 2>/dev/null) || {
        echo 'restore client cleanup: stopped client state is uncertain; intent is retained' >&2; return 1;
      }
      [ "$running" = false ] || { echo 'restore client cleanup: client is still running; intent is retained' >&2; return 1; }
    elif [ "$running" != false ]; then
      echo 'restore client cleanup: client state is uncertain; intent is retained' >&2; return 1
    fi
    timeout --kill-after=5 20 docker rm "$RESTORE_CLIENT_ID" >/dev/null 2>&1 || {
      echo 'restore client cleanup: container removal is uncertain; intent is retained' >&2; return 1;
    }
  fi
  remaining=$(timeout --kill-after=5 20 docker ps -aq --no-trunc --filter "id=$RESTORE_CLIENT_ID" 2>/dev/null) || {
    echo 'restore client cleanup: immutable identity absence cannot be checked; intent is retained' >&2; return 1;
  }
  [ -z "$remaining" ] || { echo 'restore client cleanup: immutable client still exists; intent is retained' >&2; return 1; }
  name_remaining=$(timeout --kill-after=5 20 docker ps -aq --filter "name=^/$RESTORE_CLIENT_NAME$" 2>/dev/null) || {
    echo 'restore client cleanup: exact name absence cannot be checked; intent is retained' >&2; return 1;
  }
  [ -z "$name_remaining" ] || { echo 'restore client cleanup: client name is occupied; intent is retained' >&2; return 1; }
  restore_client_cidfile_clear "$RESTORE_CLIENT_CIDFILE" "$RESTORE_CLIENT_ID" || {
    echo 'restore client cleanup: cidfile removal is uncertain; restore evidence is retained' >&2; return 1;
  }
  restore_client_intent_clear "$RESTORE_WORK" "$RESTORE_CLIENT_INTENT" "$RESTORE_CLIENT_OPERATION" \
    "$RESTORE_CLIENT_TOKEN" "$RESTORE_CLIENT_NAME" "$RESTORE_CLIENT_ID" || {
      echo 'restore client cleanup: durable intent could not be cleared; it is retained' >&2; return 1;
    }
  RESTORE_CLIENT_NAME=""; RESTORE_CLIENT_ID=""; RESTORE_CLIENT_TOKEN=""; RESTORE_CLIENT_OPERATION=""; RESTORE_CLIENT_INTENT=""; RESTORE_CLIENT_CIDFILE=""
  return 0
}

_engine_restore_client_run() { # kind, operation, image, user, repeated --mount value/--env value, --, fixed node argv
  local kind="$1" operation="$2" image="$3" user="$4" token admission identity identity_id identity_epoch
  local result cidfile inspection attach_status wait_status
  shift 4
  local -a mounts=() environment=() create_args=() node_args=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    case "$1" in
      --mount)
        [ "$#" -ge 2 ] || return 78
        local -a fields=()
        IFS=, read -r -a fields <<< "$2"
        [ "${#fields[@]}" -ge 3 ] && [ "${#fields[@]}" -le 4 ] &&
          [ "${fields[0]}" = type=bind ] && [[ "${fields[1]}" == src=/* ]] && [[ "${fields[2]}" == dst=/* ]] || {
            echo 'restore client: a bind is outside the fixed mount form' >&2; return 78;
          }
        if [ "${#fields[@]}" -eq 4 ]; then [ "${fields[3]}" = readonly ] || return 78; fi
        local src="${fields[1]#src=}" dst="${fields[2]#dst=}"
        [[ "$src" != *','* && "$dst" != *','* && "$src" != *$'\n'* && "$dst" != *$'\n'* &&
          "$src" != *$'\r'* && "$dst" != *$'\r'* && "$src" != *'/../'* && "$dst" != *'/../'* ]] || return 78
        mounts+=(--mount "$2"); shift 2 ;;
      --env) [ "$#" -ge 2 ] || return 78; environment+=(--env "$2"); shift 2 ;;
      *) echo 'restore client: invalid fixed client inputs' >&2; return 78 ;;
    esac
  done
  [ "$#" -gt 0 ] || return 78
  shift
  node_args=("$@")
  case "$kind:$operation" in
    keeper:financial-freeze|keeper:migrate|keeper:verify-restored-engine|keeper:workflow-database|vault:verify-files|vault:verify-empty|vault:verify-snapshot|vault:verify) ;;
    *) echo 'restore client: operation is outside the fixed restore set' >&2; return 78 ;;
  esac
  [ "${node_args[0]:-}" = node ] && [ "${node_args[1]:-}" = --import ] &&
    [ "${node_args[2]:-}" = tsx/esm ] || { echo 'restore client: only the same-process Node loader form is allowed' >&2; return 78; }
  case "$kind:$operation" in
    keeper:financial-freeze)
      [ "$user" = 0:0 ] && [ "${#node_args[@]}" -eq 7 ] &&
        [ "${node_args[3]}" = /app/services/keeper/bin/budget-financial.ts ] &&
        [ "${node_args[4]}" = freeze ] && [ "${node_args[5]}" = --host ] &&
        [ "${node_args[6]}" = /etc/lares/keeper.json ] || return 78 ;;
    keeper:migrate)
      [ "$user" = 0:0 ] && [ "${#node_args[@]}" -eq 5 ] &&
        [ "${node_args[3]}" = /app/services/box/migrate.ts ] &&
        [ "${node_args[4]}" = --schema-owner ] || return 78 ;;
    keeper:verify-restored-engine)
      [ "$user" = 0:0 ] && [ "${#node_args[@]}" -eq 11 ] &&
        [ "${node_args[3]}" = /app/services/box/bin/database-setup.ts ] &&
        [ "${node_args[4]}" = --verify-restored-engine ] &&
        [ "${node_args[5]}" = --operator-password-file ] && [ "${node_args[6]}" = /etc/lares/operator/database-password ] &&
        [ "${node_args[7]}" = --app-password-file ] && [ "${node_args[8]}" = /etc/lares/secrets/database-password ] &&
        [ "${node_args[9]}" = --financial-password-file ] && [ "${node_args[10]}" = /etc/lares/secrets/financial-database-password ] || return 78 ;;
    keeper:workflow-database)
      [ "$user" = 0:0 ] && [ "${#node_args[@]}" -eq 13 ] &&
        [ "${node_args[3]}" = /app/services/box/bin/workflow-template.ts ] &&
        [ "${node_args[4]}" = verify-database ] && [ "${node_args[5]}" = --host ] && [ "${node_args[6]}" = 127.0.0.1 ] &&
        [ "${node_args[7]}" = --port ] && [ "${node_args[9]}" = --database ] &&
        [ "${node_args[11]}" = --runtime-password-file ] && [[ "${node_args[12]}" == /etc/lares/secrets/* ]] || return 78 ;;
    vault:*)
      [ "$user" = 10001:10001 ] && [ "${#node_args[@]}" -eq 7 ] &&
        [ "${node_args[3]}" = /app/services/box/bin/vault-storage.ts ] &&
        [ "${node_args[4]}" = "$operation" ] && [ "${node_args[5]}" = --prefix ] && [[ "${node_args[6]}" = /* ]] || return 78 ;;
  esac
  [ -n "${RESTORE_WORK:-}" ] && [ -d "$RESTORE_WORK" ] && [ -n "${ADMISSION_PREFIX:-}" ] || {
    echo 'restore client: durable restore admission is unavailable' >&2; return 78;
  }
  [ -n "$image" ] && [[ "$image" =~ $ENGINE_DIGEST_PATTERN ]] || { echo 'restore client: selected image digest is invalid' >&2; return 78; }
  command -v timeout >/dev/null 2>&1 || { echo 'restore client: bounded lifecycle controls are unavailable' >&2; return 78; }
  local -a test_owner=()
  if [ "${TEST_OWNER_FLAG:-0}" = 1 ] || { [ "${LARES_MAINTENANCE_TESTING:-}" = 1 ] && [ -n "${LARES_MAINTENANCE_TEST_PREFIX:-}" ]; }; then test_owner=(--test-owner); fi
  python3 "$HERE/maintenance-custody.py" assert-normal-held "$ADMISSION_PREFIX" restore "${test_owner[@]}" >/dev/null 2>&1 || {
    echo 'restore client: normal restore admission is no longer valid' >&2; return 78;
  }
  identity=$(python3 "$HERE/maintenance-custody.py" validate-identity "$ADMISSION_PREFIX" "${LARES_SUBNET:-172.30.0.0/24}" "${test_owner[@]}") || return 78
  identity_id=$(printf '%s' "$identity" | python3 -c 'import json,sys; print(json.load(sys.stdin)["installationId"])' 2>/dev/null) || return 78
  identity_epoch=$(printf '%s' "$identity" | python3 -c 'import json,sys; print(json.load(sys.stdin)["epoch"])' 2>/dev/null) || return 78
  admission="$ADMISSION_PREFIX/var/lib/lares-maintenance/admission"
  if [ "$(timeout --kill-after=5 20 docker image inspect --format '{{json .Config.Entrypoint}}' "$image" 2>/dev/null)" != '["/usr/local/lib/lares/maintenance-admission-v1"]' ]; then
    echo 'restore client: selected image does not contain the baked maintenance guard' >&2; return 78
  fi
  token=$(python3 -c 'import uuid; print(uuid.uuid4().hex)' 2>/dev/null) || return 78
  RESTORE_CLIENT_TOKEN="$token"; RESTORE_CLIENT_OPERATION="$kind:$operation"
  RESTORE_CLIENT_NAME="lares-restore-${kind}-${operation//[^a-z0-9-]/-}-$token"; RESTORE_CLIENT_ID=""
  RESTORE_CLIENT_INTENT="$RESTORE_WORK/restore-client-$token.intent"
  cidfile="$RESTORE_WORK/restore-client-$token.cid"
  RESTORE_CLIENT_CIDFILE="$cidfile"
  restore_client_intent_write "$RESTORE_WORK" "${RESTORE_CLIENT_INTENT##*/}" "$RESTORE_CLIENT_OPERATION" \
    "$RESTORE_CLIENT_TOKEN" "$RESTORE_CLIENT_NAME" '' creating || return 78
  create_args=(create --name "$RESTORE_CLIENT_NAME" --cidfile "$cidfile" \
    --label "com.lares.restore.owner=$token" --label "com.lares.restore.operation=$RESTORE_CLIENT_OPERATION" \
    --network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    --user "$user" -e HOME=/tmp -w /app \
    --mount "type=bind,src=$admission,dst=/run/lares-maintenance/admission,readonly")
  local item
  if [ "${#mounts[@]}" -gt 0 ]; then for item in "${mounts[@]}"; do create_args+=("$item"); done; fi
  if [ "${#environment[@]}" -gt 0 ]; then for item in "${environment[@]}"; do create_args+=("$item"); done; fi
  if ! result=$(timeout --kill-after=5 30 docker "${create_args[@]}" "$image" \
      /run/lares-maintenance/admission "$identity_id" "$identity_epoch" -- "${node_args[@]}" 2>&1); then
    echo 'restore client: guarded container creation failed; durable intent is retained' >&2
    return 78
  fi
  RESTORE_CLIENT_ID=$(restore_client_cidfile_read "$cidfile" 2>/dev/null) || RESTORE_CLIENT_ID=""
  if ! restore_client_id_is_valid "$RESTORE_CLIENT_ID"; then
    RESTORE_CLIENT_ID=""
    echo 'restore client: immutable container id was not recorded; durable intent is retained' >&2
    return 78
  fi
  restore_client_intent_write "$RESTORE_WORK" "${RESTORE_CLIENT_INTENT##*/}" "$RESTORE_CLIENT_OPERATION" \
    "$RESTORE_CLIENT_TOKEN" "$RESTORE_CLIENT_NAME" "$RESTORE_CLIENT_ID" created || {
      echo 'restore client: created container identity could not be persisted; container and evidence are retained' >&2
      return 78;
    }
  inspection=$(timeout --kill-after=5 20 docker inspect --format \
      '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.lares.restore.owner"}}|{{index .Config.Labels "com.lares.restore.operation"}}' \
      "$RESTORE_CLIENT_ID" 2>/dev/null) || { echo 'restore client: container ownership could not be verified before start' >&2; return 78; }
  [ "$inspection" = "$RESTORE_CLIENT_ID|/$RESTORE_CLIENT_NAME|$RESTORE_CLIENT_TOKEN|$RESTORE_CLIENT_OPERATION" ] || {
    echo 'restore client: container identity changed before start' >&2; return 78;
  }
  if timeout --kill-after=5 1800 docker start --attach "$RESTORE_CLIENT_ID" </dev/null; then attach_status=0; else attach_status=$?; fi
  if ! result=$(timeout --kill-after=5 30 docker wait "$RESTORE_CLIENT_ID" 2>/dev/null); then
    echo 'restore client: completion could not be verified' >&2; engine_restore_client_cleanup || return 78; return 78
  fi
  case "$result" in ''|*[!0-9]*) echo 'restore client: exit status is unreadable' >&2; engine_restore_client_cleanup || return 78; return 78 ;; esac
  wait_status=$((10#$result))
  inspection=$(timeout --kill-after=5 20 docker inspect --format \
      '{{.Id}}|{{.State.Running}}|{{.State.ExitCode}}|{{index .Config.Labels "com.lares.restore.owner"}}|{{index .Config.Labels "com.lares.restore.operation"}}' \
      "$RESTORE_CLIENT_ID" 2>/dev/null) || { echo 'restore client: completion identity is uncertain' >&2; engine_restore_client_cleanup || return 78; return 78; }
  [ "$inspection" = "$RESTORE_CLIENT_ID|false|$wait_status|$RESTORE_CLIENT_TOKEN|$RESTORE_CLIENT_OPERATION" ] || {
    echo 'restore client: completed container identity or status changed' >&2; engine_restore_client_cleanup || return 78; return 78;
  }
  if ! engine_restore_client_cleanup; then return 78; fi
  if [ "$attach_status" -ne 0 ] && [ "$wait_status" -eq 0 ]; then
    echo 'restore client: attached output ended before completion was confirmed' >&2; return 78
  fi
  return "$wait_status"
}

engine_restore_keeper_client() { # fixed operation only; caller supplies only the workflow database and port for that operation
  local operation="$1" host_operator='/etc/lares/operator/database-password' host_config='/etc/lares/keeper.json'
  local host_app='/etc/lares/secrets/database-password' host_financial='/etc/lares/secrets/financial-database-password'
  local host_workflow='/etc/lares/secrets/workflow-database-password' workflow_host workflow_container host_socket="" database port
  local -a mounts=() environment=() argv=() client_args=()
  case "$operation" in
    financial-freeze)
      [ "$#" -eq 1 ] && [ -n "${KEEPER_JSON:-}" ] && [ "$KEEPER_JSON" = "$(P /etc/lares/keeper.json)" ] || return 78
      host_socket=$(python3 - "${KEEPER_ENV:?}" "$(P /run/lares-host)" <<'PYSOCKET'
import os, pathlib, stat, sys
path = pathlib.Path(sys.argv[1]); expected = sys.argv[2]
try:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o640 or info.st_size > 65536: raise ValueError()
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino, opened.st_uid, stat.S_IMODE(opened.st_mode), opened.st_size) != (info.st_dev, info.st_ino, os.geteuid(), 0o640, info.st_size): raise ValueError()
        raw = os.read(fd, 65537)
    finally: os.close(fd)
    if len(raw) != info.st_size or len(raw) > 65536: raise ValueError()
    lines = raw.decode('utf-8').splitlines()
    values = [line.split('=', 1)[1].strip('"') for line in lines if line.startswith('LARES_HOST_SOCKET_DIR=') and '=' in line]
    if len(values) != 1 or values[0] != expected: raise ValueError()
    socket = pathlib.Path(expected); st = socket.lstat()
    if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or socket.resolve(strict=True) != socket: raise ValueError()
    print(expected)
except Exception: raise SystemExit(1)
PYSOCKET
      ) || { echo 'restore client: rendered host socket directory is missing or invalid' >&2; return 78; }
      [ -f "$KEEPER_JSON" ] && [ ! -L "$KEEPER_JSON" ] && [ -f "$(P /etc/lares/secrets/database-password)" ] && \
        [ -f "$(P /etc/lares/secrets/financial-database-password)" ] || return 78
      [ -d "$(P /var/lib/lares/budget-financial)" ] && [ ! -L "$(P /var/lib/lares/budget-financial)" ] || return 78
      mounts+=(--mount "type=bind,src=$KEEPER_JSON,dst=$host_config,readonly" \
        --mount "type=bind,src=$(P /etc/lares/secrets/database-password),dst=$host_app,readonly" \
        --mount "type=bind,src=$(P /etc/lares/secrets/financial-database-password),dst=$host_financial,readonly" \
        --mount "type=bind,src=$host_socket,dst=/run/lares-host,readonly" \
        --mount "type=bind,src=$(P /var/lib/lares/budget-financial),dst=/var/lib/lares/budget-financial")
      if [ "${NATIVE_PREPARED:-0}" = 1 ]; then
        [ -d "$(P /var/lib/lares/budget-native)" ] && [ ! -L "$(P /var/lib/lares/budget-native)" ] || return 78
        mounts+=(--mount "type=bind,src=$(P /var/lib/lares/budget-native),dst=/var/lib/lares/budget-native")
      fi
      argv=(node --import tsx/esm /app/services/keeper/bin/budget-financial.ts freeze --host "$host_config")
      ;;
    migrate)
      [ "$#" -eq 1 ] && [ "${OPERATOR_PASSWORD_FILE:-}" = "$(P "$host_operator")" ] || return 78
      database="${DB_NAME:-lares_state}"; port="${PGPORT:-5432}"
      [[ "$database" =~ ^[a-z0-9_]{1,63}$ && "$port" =~ ^[0-9]{1,5}$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] && \
        [ "${PGHOST:-127.0.0.1}" = 127.0.0.1 ] && [ "${DB_USER:-lares_operator}" = lares_operator ] || return 78
      mounts+=(--mount "type=bind,src=$OPERATOR_PASSWORD_FILE,dst=$host_operator,readonly")
      environment+=(--env "DATABASE_PASSWORD_FILE=$host_operator" --env "LARES_OPERATOR_PASSWORD_FILE=$host_operator" \
        --env PGHOST=127.0.0.1 --env "PGPORT=$port" --env "PGDATABASE=$database" --env PGUSER=lares_operator)
      argv=(node --import tsx/esm /app/services/box/migrate.ts --schema-owner)
      ;;
    verify-restored-engine)
      [ "$#" -eq 1 ] && [ "${OPERATOR_PASSWORD_FILE:-}" = "$(P "$host_operator")" ] && \
        [ "${ENGINE_APP_PASSWORD_FILE:-}" = "$(P "$host_app")" ] && [ "${ENGINE_FINANCIAL_PASSWORD_FILE:-}" = "$(P "$host_financial")" ] || return 78
      port="${PGPORT:-5432}"
      [[ "$port" =~ ^[0-9]{1,5}$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || return 78
      mounts+=(--mount "type=bind,src=$OPERATOR_PASSWORD_FILE,dst=$host_operator,readonly" \
        --mount "type=bind,src=$ENGINE_APP_PASSWORD_FILE,dst=$host_app,readonly" \
        --mount "type=bind,src=$ENGINE_FINANCIAL_PASSWORD_FILE,dst=$host_financial,readonly")
      environment+=(--env "DATABASE_PASSWORD_FILE=$host_operator" --env "LARES_OPERATOR_PASSWORD_FILE=$host_operator" \
        --env PGHOST=127.0.0.1 --env "PGPORT=$port" --env PGDATABASE=lares_state --env PGUSER=lares_operator)
      argv=(node --import tsx/esm /app/services/box/bin/database-setup.ts --verify-restored-engine \
        --operator-password-file "$host_operator" --app-password-file "$host_app" --financial-password-file "$host_financial")
      ;;
    workflow-database)
      [ "$#" -eq 3 ] || return 78
      database="$2"; port="$3"
      [[ "$database" =~ ^lares_[a-f0-9]{32}$ && "$port" =~ ^[0-9]{1,5}$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || return 78
      workflow_host="${WORKFLOW_PASSWORD_FILE:-}"
      if [ -n "${PREFIX:-}" ] && [ "${PREFIX%/}" != "" ] && [[ "$workflow_host" == "${PREFIX%/}"/* ]]; then
        workflow_container="/${workflow_host#"${PREFIX%/}/"}"
      else
        workflow_container="$workflow_host"
      fi
      case "$workflow_container" in /etc/lares/secrets/*) ;; *) return 78 ;; esac
      [[ "$workflow_container" != *'..'* && "$workflow_container" != *'/./'* && "$workflow_container" != *:* ]] || return 78
      [ "$workflow_host" = "$(P "$workflow_container")" ] && [ -f "$workflow_host" ] && [ ! -L "$workflow_host" ] || return 78
      mounts+=(--mount "type=bind,src=$workflow_host,dst=$workflow_container,readonly")
      environment+=(--env PGHOST=127.0.0.1 --env "PGPORT=$port" --env PGUSER=lares_app --env "PGDATABASE=$database")
      argv=(node --import tsx/esm /app/services/box/bin/workflow-template.ts verify-database \
        --host 127.0.0.1 --port "$port" --database "$database" --runtime-password-file "$workflow_container")
      ;;
    *) echo 'restore client: unsupported fixed Keeper operation' >&2; return 78 ;;
  esac
  if [ "${#mounts[@]}" -gt 0 ]; then client_args+=("${mounts[@]}"); fi
  if [ "${#environment[@]}" -gt 0 ]; then client_args+=("${environment[@]}"); fi
  _engine_restore_client_run keeper "$operation" "$ENGINE_IMAGE" 0:0 "${client_args[@]}" -- "${argv[@]}"
}

engine_restore_vault_client() { # physical prefix, database, mode; only the four fixed restore verification modes
  local prefix="${1%/}" database="$2" mode="$3" path image_file image
  local -a mounts=() environment=() argv=() client_args=()
  case "$mode" in verify-files|verify-empty|verify-snapshot|verify) ;; *) echo 'restore client: unsupported fixed Vault verification mode' >&2; return 78 ;; esac
  [ -n "$prefix" ] || prefix=/
  local dbport="${PGPORT:-5432}"
  [[ "$dbport" =~ ^[0-9]{1,5}$ ]] && [ "$dbport" -ge 1 ] && [ "$dbport" -le 65535 ] || return 78
  [ "$database" = lares_state ] || [[ "$database" =~ ^drill_vault_restore_[a-f0-9]{32}$ ]] || return 78
  image_file="$(restore_client_at "${LARES_PREFIX:-/}" /opt/lares/vault-recovery-engine-image)"
  [ -f "$image_file" ] && [ ! -L "$image_file" ] && [ "$(stat -c '%u:%a' "$image_file" 2>/dev/null || true)" = "$(id -u):640" ] || {
    echo 'restore client: separate Vault recovery image pin is missing or unsafe' >&2; return 78;
  }
  image=$(head -n 1 "$image_file" | tr -d '[:space:]')
  [[ "$image" =~ $ENGINE_DIGEST_PATTERN ]] || { echo 'restore client: Vault recovery image pin is not a digest' >&2; return 78; }
  if [ "${VAULT_STORAGE_PRESENT:-0}" = 1 ]; then
    path="$(restore_client_at "$prefix" /srv/lares/installation/vault-storage.json)"
    [ -f "$path" ] && [ ! -L "$path" ] || return 78
    mounts+=(--mount "type=bind,src=$path,dst=$path,readonly")
    for path in "${VAULT_STORAGE_REPOSITORIES[@]}"; do mounts+=(--mount "type=bind,src=$path,dst=$path,readonly"); done
    for path in "$(restore_client_at "$prefix" /var/lib/lares-vault-git)"/*.git; do
      [ -d "$path" ] || return 78
      mounts+=(--mount "type=bind,src=$path,dst=$path,readonly")
    done
  fi
  if [ "$mode" != verify-files ]; then
    path="$(restore_client_at "${LARES_PREFIX:-/}" /etc/lares/secrets/database-password)"
    [ -f "$path" ] && [ ! -L "$path" ] || return 78
    mounts+=(--mount "type=bind,src=$path,dst=/etc/lares/secrets/database-password,readonly")
    environment+=(--env DATABASE_PASSWORD_FILE=/etc/lares/secrets/database-password \
      --env PGHOST=127.0.0.1 --env "PGPORT=$dbport" --env PGUSER=lares_app --env "PGDATABASE=$database")
  fi
  argv=(node --import tsx/esm /app/services/box/bin/vault-storage.ts "$mode" --prefix "$prefix")
  if [ "${#mounts[@]}" -gt 0 ]; then client_args+=("${mounts[@]}"); fi
  if [ "${#environment[@]}" -gt 0 ]; then client_args+=("${environment[@]}"); fi
  _engine_restore_client_run vault "$mode" "$image" 10001:10001 "${client_args[@]}" -- "${argv[@]}"
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
