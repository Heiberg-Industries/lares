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

# engine_run [--ro PATH]... [--rw PATH]... [--env NAME=VALUE]... SCRIPT [ARGS...]
#   SCRIPT is relative to services/box inside the image (migrate.ts, bin/render-stack.ts, ...).
#   --env is for plain settings only; a secret is handed over as a file under a --ro mount.
engine_run() {
  local -a docker_args=(
    run --rm --network host --user 0:0 --read-only --tmpfs /tmp
    --cap-drop ALL --security-opt no-new-privileges
    -e HOME=/tmp -w /app/services/box
  )
  while [ "$#" -gt 0 ]; do
    case "$1" in
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
  docker "${docker_args[@]}" --entrypoint /app/services/box/node_modules/.bin/tsx \
    "$ENGINE_IMAGE" "/app/services/box/$script" "$@"
}
