#!/usr/bin/env bash
# get-lares.sh — the one file a person downloads to install Lares on a server that has only
# Docker. It fetches the named release's file, pulls that release's engine image (the keeper
# image, by digest), unpacks the installer and its sibling scripts from it, and hands over to
# install.sh. Everything else lives in that image; this host needs no Node, no pnpm, no checkout.
#
#   curl -fsSLO https://raw.githubusercontent.com/Heiberg-Industries/lares/main/services/box/ops/get-lares.sh
#   sudo bash get-lares.sh --release 2026-10-19-rc.11
#
# Read the file before you run it. Nothing is piped into a shell, and nothing it downloads is run
# as a program: the release file is data (it is read for two fields, then handed to install.sh as a
# path), and the only code that runs comes out of an image named by digest.
#
# THE ONLY TWO HOSTS IT REACHES, and why each is allowed. A new one needs a reason here and in
# tests/get-lares-contract.test.ts:
#   raw.githubusercontent.com - this repository's releases/ folder on main: the release file names the exact images of one release
#   ghcr.io - the registry CI publishes the engine images to; the image is pulled by its sha256 digest, never by a tag
# NOTHING PHONES HOME: no telemetry, no version check. It reaches those two hosts only because you
# ran it with a release name, and only to fetch what that name points at.
#
# IMAGE MODE ONLY. There is no checkout mode here.
#
# WHAT IT DECIDES (the paths and names other scripts and the docs rely on):
#   release name   the full file name without .json, exactly as in releases/: 2026-10-19-rc.11.
#                  Short names ("rc.11") and "latest" are refused: one name, one file, no guessing.
#                  The downloaded file must name itself the same (its "release" field).
#   engine files   $PREFIX/opt/lares/releases/<name>/   the repository's own layout:
#                    release.json            the release file this was installed from
#                    services/box/ops/...    install.sh, update.sh, rollback.sh, restore.sh, lares, this file
#                    services/box/engine-image   one line: the keeper digest they came from
#   current        $PREFIX/opt/lares/current -> releases/<name>, switched only after install.sh succeeds
#   previous       $PREFIX/opt/lares/previous -> the release `lares update` left (one level only; set by
#                  `lares update`, not by update.sh run directly; `lares rollback` uses and removes it)
#   wrapper        $PREFIX/usr/local/bin/lares -> $PREFIX/opt/lares/current/services/box/ops/lares
#                  so switching `current` also switches the wrapper. Subcommands: update, rollback,
#                  restore, doctor, backups (each one existing script; see ops/lares).
#
# PROMISES (tests/get-lares-contract.test.ts reads this file as text): the engine image is pulled by
# digest only (@sha256:, from ghcr.io); it refuses when not root; it reports every problem it finds
# in one pass before changing anything; a failed download or pull writes nothing; running it again
# is safe (it replaces that release's unpacked folder and moves the symlinks); it never builds an
# image or installs a dependency; no secret passes through it.
#
# Usage: get-lares.sh --release <name> [--prefix <dir>] [--fetch-only] [--dry-run] [install.sh options...]
#        get-lares.sh --release-file <path>   use a release file you already have (offline, tests)
#   --fetch-only   download, pull and unpack, then stop (what `lares update` uses)
#   --dry-run      do the same into a throwaway folder and ask install.sh for a dry run; the engine image
#                  is still pulled, because the installer's checks live in it. Writes nothing under
#                  /etc, /srv or /opt/lares.
#   every other option is handed to install.sh unchanged (--yes, --domain, --email, ...).
# Exit codes: 0 ok · 64 bad usage · 75 a download or the image pull failed · 77 not root ·
# 78 a preflight check failed (all problems are printed together).
set -euo pipefail
umask 022

EX_USAGE=64
EX_TEMPFAIL=75
EX_NOTROOT=77
EX_REFUSED=78

RAW_BASE="https://raw.githubusercontent.com/Heiberg-Industries/lares/main/releases"
IMAGE_PATTERN='^ghcr\.io/[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$'
NAME_PATTERN='^[0-9]{4}-[0-9]{2}-[0-9]{2}-[A-Za-z0-9][A-Za-z0-9.]*$'

say() { printf 'get-lares: %s\n' "$1"; }
die() { printf 'get-lares: %s\n' "$1" >&2; exit "$2"; }

NAME=""
RELEASE_FILE_ARG=""
PREFIX_ARG="${LARES_PREFIX:-}"
FETCH_ONLY=0
DRY_RUN=0
PASS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --release|--release-file|--prefix)
      [ $# -ge 2 ] || die "$1 needs a value. Nothing was changed." "$EX_USAGE"
      case "$1" in
        --release) NAME="$2" ;;
        --release-file) RELEASE_FILE_ARG="$2" ;;
        --prefix) PREFIX_ARG="$2" ;;
      esac
      shift 2
      ;;
    --fetch-only) FETCH_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; PASS+=("$1"); shift ;;
    *) PASS+=("$1"); shift ;;
  esac
done

PREFIX="$PREFIX_ARG"
while [ "${PREFIX%/}" != "$PREFIX" ]; do PREFIX="${PREFIX%/}"; done

if [ -z "$NAME" ] && [ -z "$RELEASE_FILE_ARG" ]; then
  die "tell me which release to install: --release <name>, for example --release 2026-10-19-rc.11 (the file name in the releases folder, without .json). Nothing was changed." "$EX_USAGE"
fi
if [ -n "$NAME" ] && { ! printf '%s' "$NAME" | grep -Eq "$NAME_PATTERN" || [ "${NAME%.json}" != "$NAME" ]; }; then
  die "'$NAME' is not a full release name. Use the whole name from the releases folder, without .json, for example 2026-10-19-rc.11. Nothing was changed." "$EX_USAGE"
fi
if [ -n "$RELEASE_FILE_ARG" ] && [ ! -r "$RELEASE_FILE_ARG" ]; then
  die "cannot read the release file '$RELEASE_FILE_ARG'. Nothing was changed." "$EX_USAGE"
fi

# --- preflight: every problem, in one pass ---------------------------------------------------
PROBLEMS=()
NOT_ROOT=0
problem() { PROBLEMS+=("$1"); }

ROOT_ID=$(id -u 2>/dev/null) || ROOT_ID=""
if [ "$ROOT_ID" != "0" ]; then
  NOT_ROOT=1
  problem "this needs to run as root (found user id '${ROOT_ID:-unknown}'). Run it again as root, for example with: sudo bash $0 $*"
fi
if ! command -v docker >/dev/null 2>&1; then
  problem "docker is not installed. Install Docker Engine from your distribution's own packages or from docs.docker.com, then run this again."
elif ! docker info >/dev/null 2>&1; then
  problem "docker is installed but not answering (is the Docker service running, and are you root?). Start it, then run this again."
elif ! docker compose version >/dev/null 2>&1; then
  problem "the 'docker compose' command is missing. Install Docker's compose plugin, then run this again."
fi
if [ -z "$RELEASE_FILE_ARG" ] && ! command -v curl >/dev/null 2>&1; then
  problem "curl is not installed. Install it with your distribution's package command (for example: apt-get install curl), then run this again."
fi
if [ "${#PROBLEMS[@]}" -gt 0 ]; then
  printf 'get-lares: this server is not ready, and nothing was changed. Fix these and run it again:\n' >&2
  for p in "${PROBLEMS[@]}"; do printf '  - %s\n' "$p" >&2; done
  [ "$NOT_ROOT" -eq 1 ] && exit "$EX_NOTROOT"
  exit "$EX_REFUSED"
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/lares-get-XXXXXX")
cleanup() {
  # undo: cannot be undone by a command — $WORK is only this run's own scratch folder (mktemp -d, above); it never holds anything the installation owns.
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- the release file ------------------------------------------------------------------------
RELEASE_TMP="$WORK/release.json"
if [ -n "$RELEASE_FILE_ARG" ]; then
  cp "$RELEASE_FILE_ARG" "$RELEASE_TMP"
else
  URL="$RAW_BASE/$NAME.json"
  if ! curl -fsSL --proto '=https' --tlsv1.2 -o "$RELEASE_TMP" "$URL"; then
    die "could not download the release file for '$NAME' from $URL. Check the name against the releases folder of the repository and this server's internet connection. Nothing was changed." "$EX_TEMPFAIL"
  fi
fi

field() { # field <json key>: the first string value for that key
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$RELEASE_TMP" 2>/dev/null \
    | head -n 1 | sed -e 's/^[^:]*:[[:space:]]*"//' -e 's/"$//' || true
}
FILE_NAME=$(field release)
if ! printf '%s' "$FILE_NAME" | grep -Eq "$NAME_PATTERN"; then
  die "that release file does not carry a usable release name. Nothing was changed." "$EX_REFUSED"
fi
if [ -n "$NAME" ] && [ "$FILE_NAME" != "$NAME" ]; then
  die "you asked for '$NAME' but the file names itself '$FILE_NAME'. Refusing, because they should be the same release. Nothing was changed." "$EX_REFUSED"
fi
NAME="$FILE_NAME"
ENGINE_IMAGE=$(field lares-keeper)
if ! printf '%s' "$ENGINE_IMAGE" | grep -Eq "$IMAGE_PATTERN"; then
  die "the release file does not name the engine image by digest from ghcr.io (found '${ENGINE_IMAGE:-nothing}'). Only an image written as ghcr.io/<name>@sha256:<64 hex> is accepted. Nothing was changed." "$EX_REFUSED"
fi

# --- the engine image, then its files --------------------------------------------------------
say "downloading the Lares engine image for $NAME (a few hundred megabytes the first time)."
if ! docker pull "$ENGINE_IMAGE" >/dev/null; then
  die "could not download the Lares engine image for $NAME. This is usually the internet connection or the registry being unreachable; wait a minute and run it again. Nothing was changed." "$EX_TEMPFAIL"
fi

LARES_ROOT="$PREFIX/opt/lares"
RELEASES="$LARES_ROOT/releases"
[ "$DRY_RUN" -eq 0 ] || RELEASES="$WORK/releases"
mkdir -p "$RELEASES"
if ! docker run --rm --network none --user 0:0 --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges \
    -v "$RELEASES:/out" --entrypoint /bin/bash "$ENGINE_IMAGE" \
    /app/services/box/ops/unpack-engine.sh "$NAME" "$ENGINE_IMAGE"; then
  die "the engine image downloaded, but its installer files could not be unpacked. Nothing else was changed. Run it again; if it keeps failing, the image may be damaged." "$EX_TEMPFAIL"
fi
UNPACKED="$RELEASES/$NAME"
cp "$RELEASE_TMP" "$UNPACKED/release.json.partial"
mv "$UNPACKED/release.json.partial" "$UNPACKED/release.json"
chmod 0644 "$UNPACKED/release.json"
say "unpacked $NAME to $UNPACKED"

if [ "$FETCH_ONLY" -eq 1 ]; then
  exit 0
fi

# --- hand over to the installer, then switch ---------------------------------------------------
INSTALL_ARGS=(--release "$UNPACKED/release.json")
[ -z "$PREFIX_ARG" ] || INSTALL_ARGS+=(--prefix "$PREFIX")
for a in ${PASS[@]+"${PASS[@]}"}; do INSTALL_ARGS+=("$a"); done
code=0
bash "$UNPACKED/services/box/ops/install.sh" "${INSTALL_ARGS[@]}" || code=$?
if [ "$code" -ne 0 ]; then
  printf 'get-lares: install.sh stopped (exit %s); read what it printed above. Nothing was switched, and running this again is safe.\n' "$code" >&2
  exit "$code"
fi
if [ "$DRY_RUN" -eq 0 ]; then
  ln -sfn "releases/$NAME" "$LARES_ROOT/current"
  mkdir -p "$PREFIX/usr/local/bin"
  ln -sfn "$LARES_ROOT/current/services/box/ops/lares" "$PREFIX/usr/local/bin/lares"
  say "done. From now on use: lares update | rollback | restore | doctor | backups"
fi
