#!/usr/bin/env bash
# install.sh — the tested install path (docs/decisions/0022-the-tested-install-path.md:
# a fresh Ubuntu server, one command, "tested path" never "supported"). It checks this box, prints every preflight problem
# together with a paste-ready fix, and refuses before writing if anything is wrong. It
# then creates the installation's secrets, records four answers, renders and starts the
# release-pinned stack, proves the model, migrates the database, creates the owner and
# starts the keeper. It finishes honestly at the console's first-agent setup page: agent
# creation, its registered gateway key and the first proved conversation remain the next
# launch gate. LARES_PREFIX keeps every write testable; host commands resolve from PATH
# so tests can put logging stubs ahead of them.
#
# NOTHING PHONES HOME. The preflight reads this machine only. Later, the owner-requested
# path resolves the domain they supplied, calls this installation's own gateway to prove
# their model key, and checks the public console address they supplied. There is no
# telemetry, developer-owned endpoint, update check or download in this script.
#
# NO SUDO ANYWHERE. This refuses when it is not already root; it never re-executes
# itself with elevated privilege behind your back.
#
# OWNER DECISION (a starting point, not a measurement): the memory and disk floors
# below are the smallest numbers that leave room for Postgres, a gateway at its vendor
# floor and one agent — nothing in this repository has measured the running fleet, so
# both numbers live in ONE place each (LARES_MIN_MEMORY_MB, LARES_MIN_DISK_MB) and every
# refusal names both the number found and the number asked for.
#
# Exit codes: 0 ok · 64 bad usage · 75 a service did not become ready in time ·
# 77 not running as root · 78 a pre-flight check failed (every problem this run found
# is printed together, in one pass, before this exits — never one at a time across
# repeated runs).
#
# FIVE PROMISES THIS SCRIPT KEEPS FOR EVER (services/box/tests/install-contract.test.ts holds
# it to these, reading this file as text — not a fixture of what it does, the text itself):
#   1. every step that destroys something existing carries a `# undo:` comment naming the exact
#      command that puts it back, or says plainly that nothing puts it back.
#   2. it reaches only this installation's configured endpoints and public domain; it phones
#      home to nothing and nobody.
#   3. every image it pulls is named by digest (@sha256:...), never by a tag.
#   4. it never compiles or assembles an image on this box, and never installs dependencies here
#      except from a lockfile exactly as committed. Images are built in CI and pulled by digest.
#   5. online secrets are written under $SECRETS_DIR through lares_secret; the database operator
#      password is a separate root-only input outside every online mount and is never copied into
#      the keeper or normal database container.
#      or capture_model_key, and its value is never echoed anywhere.
set -euo pipefail
umask 077

EX_OK=0
EX_USAGE=64
EX_TEMPFAIL=75
EX_NOTROOT=77
EX_REFUSED=78

# Where this script lives, and where the box's own commands (doctor, migrate) live. The same
# resolution ops/update.sh uses: LARES_BOX_DIR overrides it, otherwise it is the parent of ops/.
HERE="$(cd "$(dirname "$0")" && pwd)"
BOX_DIR="${LARES_BOX_DIR:-$(cd "$HERE/.." && pwd)}"

# engine_run: the box's own programs (migrate, the renderers, doctor, first-owner) run in a
# throwaway container of the engine image, never on this host. See ops/engine-run.sh.
# shellcheck source=engine-run.sh
. "$HERE/engine-run.sh"

# `install.sh --backups ...` is the backup setup command: hand over to it with the other arguments.
for arg in "$@"; do
  if [ "$arg" = "--backups" ]; then
    rest=()
    for a in "$@"; do [ "$a" = "--backups" ] || rest+=("$a"); done
    exec "$HERE/setup-backups.sh" ${rest[@]+"${rest[@]}"}
  fi
done

say() { printf 'install: %s\n' "$1"; }
die() { printf 'install: %s\n' "$1" >&2; exit "$2"; }

usage() {
  cat <<'EOF' >&2
Usage: install.sh --backups [options]   (switch on backups: see setup-backups.sh --help)
       install.sh [--dry-run] [--yes] [--restore <archive>] [--release <file>] [--prefix <dir>]
                   [--domain <domain>] [--email <address>] [--name <name>]
                   [--model-key-file <path>] [--owner-id <id>]

Checks this box against the tested install path
(docs/decisions/0022-the-tested-install-path.md) and refuses, in one pass, before
writing anything, if something here is wrong. Fix what it prints and run it again.

  --dry-run            say what this would do, and change nothing
  --yes                do not ask for confirmation (for an unattended run)
  --restore <archive>  check an export archive before restoring by hand (it restores nothing).
                       To restore from the nightly backup snapshot onto a new server, run
                       restore.sh after install.sh (docs/install.md, "Restoring onto a new server")
  --release <file>     the release file naming which images to install (required for a real
                       install — the whole stack is rendered from it)
  --prefix <dir>       treat this directory as the install root instead of / (for testing)
  --domain <domain>    answer the domain question without being asked (example: example.com)
  --email <address>    answer the e-mail question without being asked
  --name <name>        answer the name question without being asked
  --model-key-file <path>
                       read the model provider key from this file instead of asking for it
                       (never pass the key itself as a flag or an environment variable — both
                       leak into the process list and shell history)
  --owner-id <id>      the owner's id in the identity register (default: derived from the
                       answered e-mail address's own local part)
  -h, --help           show this message
EOF
}

DRY_RUN=0
ASSUME_YES="${LARES_ASSUME_YES:-0}"
RESTORE_ARCHIVE=""
RELEASE_FILE=""
PREFIX_ARG=""
DOMAIN_FLAG=""
EMAIL_FLAG=""
NAME_FLAG=""
MODEL_KEY_FILE_FLAG=""
OWNER_ID_FLAG=""
OWNER_ID_GIVEN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --restore)
      if [ $# -lt 2 ]; then
        echo "install: --restore needs the path to a backup archive" >&2
        exit "$EX_USAGE"
      fi
      RESTORE_ARCHIVE="$2"
      shift 2
      ;;
    --release)
      if [ $# -lt 2 ]; then
        echo "install: --release needs the path to a release file" >&2
        exit "$EX_USAGE"
      fi
      RELEASE_FILE="$2"
      shift 2
      ;;
    --prefix)
      if [ $# -lt 2 ]; then
        echo "install: --prefix needs a directory" >&2
        exit "$EX_USAGE"
      fi
      PREFIX_ARG="$2"
      shift 2
      ;;
    --domain)
      if [ $# -lt 2 ]; then
        echo "install: --domain needs a domain" >&2
        exit "$EX_USAGE"
      fi
      DOMAIN_FLAG="$2"
      shift 2
      ;;
    --email)
      if [ $# -lt 2 ]; then
        echo "install: --email needs an e-mail address" >&2
        exit "$EX_USAGE"
      fi
      EMAIL_FLAG="$2"
      shift 2
      ;;
    --name)
      if [ $# -lt 2 ]; then
        echo "install: --name needs a name" >&2
        exit "$EX_USAGE"
      fi
      NAME_FLAG="$2"
      shift 2
      ;;
    --model-key-file)
      # The PATH is not secret; the file's CONTENTS are. This is the preferred way to answer
      # the model-key question in a non-interactive run — never --model-key <value>, which
      # would put the key itself in argv and in this shell's history.
      if [ $# -lt 2 ]; then
        echo "install: --model-key-file needs a path" >&2
        exit "$EX_USAGE"
      fi
      MODEL_KEY_FILE_FLAG="$2"
      shift 2
      ;;
    --owner-id)
      if [ $# -lt 2 ]; then
        echo "install: --owner-id needs an id" >&2
        exit "$EX_USAGE"
      fi
      # GIVEN, even if given as an empty string: `--owner-id ""` is somebody naming an id and
      # getting it wrong, not somebody leaving the choice to this script. It must refuse, not
      # quietly fall back to the derived default.
      OWNER_ID_FLAG="$2"
      OWNER_ID_GIVEN=1
      shift 2
      ;;
    -h|--help) usage; exit "$EX_USAGE" ;;
    *)
      # A typo in a flag must never be read as "no flags" — on this command that would
      # mean "go ahead with none of what you asked checked". services/box/migrate.ts's
      # main carries the identical reasoning, verbatim, for the identical reason.
      echo "install: I do not know the argument '$1', so I have not done anything." >&2
      usage
      exit "$EX_USAGE"
      ;;
  esac
done

PREFIX="${PREFIX_ARG:-${LARES_PREFIX:-/}}"
# Every path below is "$PREFIX/etc/..."; a trailing slash (and the default "/") would print
# as "//etc/...". Strip it: the real root is an empty prefix.
while [ "${PREFIX%/}" != "$PREFIX" ]; do PREFIX="${PREFIX%/}"; done
DRY="$DRY_RUN"
[ "${PGDATABASE:-lares_state}" = "lares_state" ] || die "PGDATABASE must be lares_state for this fixed database-role installation; no override was applied." "$EX_REFUSED"
[ "${PGUSER:-lares_app}" = "lares_app" ] || die "PGUSER must be lares_app for application-only installer actions; use the explicit offline operator path only for database administration." "$EX_REFUSED"
[ "${PGHOST:-127.0.0.1}" = "127.0.0.1" ] || die "PGHOST must be 127.0.0.1 because the database publishes only on host loopback." "$EX_REFUSED"
[ "${PGPORT:-5432}" = "5432" ] || die "PGPORT must be 5432 because the rendered database publishes that fixed host port." "$EX_REFUSED"

# The stack file and the keeper file share one Compose project name (changing it would rename
# the containers of existing installs), so each file sees the other's services as orphans and
# warns about them on every call. Silence the warning for this installer's calls only; the
# installer never passes --remove-orphans.
export COMPOSE_IGNORE_ORPHANS=1

# Every write the installer makes goes through this, so a dry run (--dry-run) can say what it
# would do instead of doing it.
do_or_say() {
  if [ "$DRY" -eq 1 ]; then
    say "would run: $*"
  else
    "$@"
  fi
}

# --- 0. root, before anything else is read or checked ---------------------------------
ROOT_ID=$(id -u 2>/dev/null) || ROOT_ID=""
if [ "$ROOT_ID" != "0" ]; then
  die "this needs to run as root (found user id '${ROOT_ID:-unknown}'). Try again with: sudo $0 $*" "$EX_NOTROOT"
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/lares-install-XXXXXX")
# STTY_ORIG: set only while the model key is being read from a real terminal with echo turned
# off (capture_model_key, below). One EXIT trap — the same one that already removes $WORK —
# restores it on every exit path, including Ctrl-C: bash runs the EXIT trap when a script
# terminates on an uncaught signal, not only on a normal return, so this needs no separate
# INT/TERM trap of its own (the same reasoning this script already relied on for $WORK).
STTY_ORIG=""
cleanup() {
  if [ -n "$STTY_ORIG" ]; then
    stty "$STTY_ORIG" 2>/dev/null || true
  fi
  # undo: cannot be undone by a command — $WORK is only this run's own scratch directory (mktemp -d, above); it never holds anything the installation owns, so there is nothing here to put back.
  rm -rf "$WORK"
}
trap cleanup EXIT
PROBLEMS="$WORK/problems.txt"
WARNINGS="$WORK/warnings.txt"
: > "$PROBLEMS"
: > "$WARNINGS"

# One problem: what is wrong, and a fix the owner can paste. Every problem this run
# finds is collected here and printed together at the end, in one pass — never one at
# a time across repeated runs.
problem() {
  {
    printf -- '- %s\n' "$1"
    printf '  fix: %s\n' "$2"
  } >> "$PROBLEMS"
}

warn() {
  printf -- '- %s\n' "$1" >> "$WARNINGS"
}

# --- screen one: start fresh, or restore from a backup? -----------------
# GUIDED, NEVER AUTOMATIC: this checks that an archive is genuine — a readable tar, a
# manifest.json that parses, every file it names present with the right size and sha256 — the
# same checks docs/runbooks/export-and-teardown.md section 4 has the owner do by hand. It never
# restores anything itself. On a genuine archive it reports what it found (counts only — never
# a dump's, a bundle's or a data tar's own bytes) and names, by section number, the two runbook
# steps nobody has rehearsed anywhere in this repository. It never reaches the checks below
# (memory, disk, docker, an existing installation): those are about THIS box being ready to run
# Lares, which a read-only check against an archive has no need of.
#
# `tar` and `sha256sum`/`shasum` are resolved from PATH like every other command here, so a
# test can see exactly what this reads — but unlike docker/chown/ufw/etc., these two are never
# stubbed in the tests that exercise this: they only ever read the archive and write into a
# scratch directory under $WORK, which the trap above removes on every exit.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# is_unsafe_member <name> — true (0) if this tar member could write outside the directory it
# is extracted into: an absolute path, or a path with a ".." segment. A name that merely
# CONTAINS two dots somewhere (globals..sql) is not a segment, and is not this.
is_unsafe_member() {
  case "$1" in
    /*) return 0 ;;
    ../*|*/../*|*/..|..) return 0 ;;
    *) return 1 ;;
  esac
}

# verify_restore_archive <path> — the whole of "restore from a backup" in this installer. Exits
# the whole script itself (via die) on the first thing that is wrong; returns normally, having
# written nothing outside $WORK, once a genuine archive has been reported on.
verify_restore_archive() {
  local archive="$1" listing entry check_dir manifest name size sha
  local got_size got_sha local_path
  local db_count=0 vault_count=0 data_count=0 file_count=0
  local engine_version="" export_date=""

  [ -r "$archive" ] || die "could not read '$archive' — check the path, and that this user can read it. Nothing was checked, and nothing has been installed." "$EX_REFUSED"

  # List first, extract nothing yet — the same order as the runbook's own section 4a. A
  # hostile member is refused here, before a single byte is extracted anywhere.
  listing=$(tar -tf "$archive" 2>/dev/null) || die "could not read '$archive' as a tar archive — it is either not a tar file, or it is damaged. Nothing was checked, and nothing has been installed." "$EX_REFUSED"
  [ -n "$listing" ] || die "'$archive' is a tar archive, but it lists nothing at all. Nothing was checked, and nothing has been installed." "$EX_REFUSED"

  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if is_unsafe_member "$entry"; then
      die "refusing to look inside '$archive' — it contains '$entry', a path that would write outside where this check extracts to. This is not a genuine export, or it has been tampered with. Nothing was extracted, and nothing has been installed." "$EX_REFUSED"
    fi
  done <<RESTORE_ARCHIVE_LISTING
$listing
RESTORE_ARCHIVE_LISTING

  # Names are not enough. A member that is a symbolic or hard LINK can point outside the scratch
  # directory, and a later member written "through" it lands wherever the link points — the
  # classic way out of an extraction directory. A genuine export holds ordinary files only, so
  # anything that is not a plain file or a directory is a refusal, again before extraction. The
  # long listing's first character is the member's type on both GNU tar and bsdtar
  # (`-` file, `d` directory, `l` symbolic link, `h` hard link, `c`/`b`/`p` devices and pipes).
  long_listing=$(tar -tvf "$archive" 2>/dev/null) || die "could not read '$archive' as a tar archive — it is either not a tar file, or it is damaged. Nothing was checked, and nothing has been installed." "$EX_REFUSED"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      -*|d*) ;;
      *) die "refusing to look inside '$archive' — it contains something that is not an ordinary file or folder (a link or a device). A genuine export never does; this is not one, or it has been tampered with. Nothing was extracted, and nothing has been installed." "$EX_REFUSED" ;;
    esac
  done <<RESTORE_ARCHIVE_LONG_LISTING
$long_listing
RESTORE_ARCHIVE_LONG_LISTING

  check_dir="$WORK/restore-check"
  mkdir -p "$check_dir"
  tar -C "$check_dir" -xf "$archive" || die "'$archive' listed cleanly but could not be extracted for checking. Nothing has been installed." "$EX_REFUSED"

  manifest="$check_dir/manifest.json"
  if [ ! -f "$manifest" ]; then
    manifest=$(find "$check_dir" -maxdepth 2 -type f -name manifest.json 2>/dev/null | head -1)
  fi
  [ -n "$manifest" ] && [ -f "$manifest" ] || die "'$archive' has no manifest.json. A genuine export (services/box/ops/export.sh) always has one; this is not one, or it is damaged. Nothing has been installed." "$EX_REFUSED"

  engine_version=$(sed -n 's/.*"engineVersion" *: *"\([^"]*\)".*/\1/p' "$manifest" | head -1)
  export_date=$(sed -n 's/.*"date" *: *"\([^"]*\)".*/\1/p' "$manifest" | head -1)
  [ -n "$engine_version" ] || die "could not read the engine version out of '$manifest' — it does not look like an export manifest. Nothing has been installed." "$EX_REFUSED"
  [ -n "$export_date" ] || die "could not read the date out of '$manifest' — it does not look like an export manifest. Nothing has been installed." "$EX_REFUSED"

  sed -n 's/.*"name" *: *"\([^"]*\)", *"size" *: *\([0-9][0-9]*\), *"sha256" *: *"\([^"]*\)".*/\1 \2 \3/p' \
    "$manifest" > "$WORK/restore-manifest-files.txt"

  while read -r name size sha; do
    [ -n "$name" ] || continue
    file_count=$((file_count + 1))

    local_path="$check_dir/$name"
    [ -f "$local_path" ] || local_path="$check_dir/./$name"
    if [ ! -f "$local_path" ]; then
      local_path=$(find "$check_dir" -type f -name "$(basename -- "$name")" 2>/dev/null | head -1)
    fi
    [ -n "$local_path" ] && [ -f "$local_path" ] || die "refusing '$archive' — the manifest lists '$name', but the archive does not contain it. Nothing has been installed." "$EX_REFUSED"

    got_size=$(wc -c < "$local_path" | tr -d '[:space:]')
    [ "$got_size" = "$size" ] || die "refusing '$archive' — '$name' is $got_size bytes; the manifest says $size. The archive does not match its own manifest. Nothing has been installed." "$EX_REFUSED"

    got_sha=$(sha256_of "$local_path")
    [ "$got_sha" = "$sha" ] || die "refusing '$archive' — '$name' does not match the checksum in the manifest. The archive may be damaged or tampered with. Nothing has been installed." "$EX_REFUSED"

    case "$name" in
      *.dump) db_count=$((db_count + 1)) ;;
      *.bundle) vault_count=$((vault_count + 1)) ;;
      *.tar) data_count=$((data_count + 1)) ;;
    esac
  done < "$WORK/restore-manifest-files.txt"

  [ "$file_count" -gt 0 ] || die "'$manifest' lists no files at all — refusing an archive that proves nothing about itself. Nothing has been installed." "$EX_REFUSED"

  say "restore check only — nothing has been installed or restored. This reads '$archive' and a scratch copy under this machine's own temp directory, removed when this finishes."
  say "the archive matches its own manifest: every file it lists is present, the right size, and the right checksum."
  say "it was written by engine ${engine_version} on ${export_date}."
  say "it holds ${db_count} database dump(s), ${vault_count} vault bundle(s), and ${data_count} data directory tar(s)."
  say "restoring from a backup is guided, not automatic: follow docs/runbooks/export-and-teardown.md, section 5, on the server you are restoring TO, in this order:"
  say "  5a. load globals.sql through the database container, before any dump — this step has not been rehearsed anywhere in this repository."
  say "  5b. create a database for each dump named above."
  say "  5c. restore each dump into its database with pg_restore --no-owner."
  say "  5d. restore each vault bundle into a bare git repository — this step has not been rehearsed anywhere in this repository."
  say "  5e. extract each data directory tar back into place."
  say "read docs/runbooks/export-and-teardown.md in full before you begin, including section 5f — what the archive does not contain and has to be carried by hand."
}

# An explicit --restore is unambiguous: check it and stop, before any other check runs.
if [ -n "$RESTORE_ARCHIVE" ]; then
  verify_restore_archive "$RESTORE_ARCHIVE"
  exit "$EX_OK"
fi

# --- 1. operating system and version --------------------------------------------------
# Warn, never fail: Ubuntu 24.04 is the TESTED path, not the only one that can work
# (docs/decisions/0022-the-tested-install-path.md).
OS_NAME=$(uname -s 2>/dev/null) || OS_NAME=""
if [ "$OS_NAME" != "Linux" ]; then
  warn "this is not being run on Linux (uname -s said '${OS_NAME:-nothing}'). The tested install path is a fresh Ubuntu server; anything else is best-effort and has not been tried."
else
  OS_VERSION=$(lsb_release -rs 2>/dev/null) || OS_VERSION=""
  case "$OS_VERSION" in
    ''|*[!0-9.]*)
      warn "could not read this distribution's version (lsb_release -rs gave no usable answer). The tested install path is Ubuntu 22.04 or newer; proceeding without that check."
      ;;
    *)
      OS_MAJOR="${OS_VERSION%%.*}"
      case "$OS_MAJOR" in
        ''|*[!0-9]*)
          warn "could not read this distribution's version number ('$OS_VERSION'). The tested install path is Ubuntu 22.04 or newer; proceeding without that check."
          ;;
        *)
          if [ "$OS_MAJOR" -lt 22 ]; then
            warn "this is Ubuntu $OS_VERSION. The tested install path is Ubuntu 22.04 or newer — this may still work, but it has not been tried."
          fi
          ;;
      esac
      ;;
  esac
fi

# --- 2. memory -----------------------------------------------------
LARES_MIN_MEMORY_MB="${LARES_MIN_MEMORY_MB:-6144}"
MEM_TOTAL=$(free -m 2>/dev/null | awk '/^Mem:/ { print $2; exit }') || MEM_TOTAL=""
case "$MEM_TOTAL" in
  ''|*[!0-9]*)
    problem "could not read how much memory this box has (free -m gave no usable answer)." \
      "install procps (apt-get install -y procps) so 'free' is available, then run this again."
    ;;
  *)
    if [ "$MEM_TOTAL" -lt "$LARES_MIN_MEMORY_MB" ]; then
      problem "this box has ${MEM_TOTAL} MB of memory; the tested install path asks for at least ${LARES_MIN_MEMORY_MB} MB (a starting point, not a measurement — smaller may work, it just has not been measured)." \
        "rent a box with at least ${LARES_MIN_MEMORY_MB} MB ($(( LARES_MIN_MEMORY_MB / 1024 )) GiB) of memory, or set LARES_MIN_MEMORY_MB lower yourself if you are accepting that risk."
    fi
    ;;
esac

# --- 3. free disk ---------------------------------------------------
LARES_MIN_DISK_MB="${LARES_MIN_DISK_MB:-20480}"
AVAIL_KB=$(df -Pk "${PREFIX:-/}" 2>/dev/null | tail -1 | awk '{ print $4 }') || AVAIL_KB=""
case "$AVAIL_KB" in
  ''|*[!0-9]*)
    problem "could not read how much disk is free under ${PREFIX:-/} (df -Pk gave no usable answer)." \
      "check that ${PREFIX:-/} exists and that 'df' works there, then run this again."
    ;;
  *)
    AVAIL_MB=$(( AVAIL_KB / 1024 ))
    if [ "$AVAIL_MB" -lt "$LARES_MIN_DISK_MB" ]; then
      problem "only ${AVAIL_MB} MB free under ${PREFIX:-/}; the tested install path asks for at least ${LARES_MIN_DISK_MB} MB free ($(( LARES_MIN_DISK_MB / 1024 )) GiB)." \
        "free up space under ${PREFIX:-/}, or rent a box with a bigger disk, then run this again."
    fi
    ;;
esac

# --- 4. Docker ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  problem "docker is not installed." \
    "install it from your distribution's own packages (on Ubuntu 24.04: apt-get install -y docker.io docker-compose-v2), then run this again."
elif ! docker compose version >/dev/null 2>&1; then
  problem "'docker compose' is not available (docker is installed, but the compose plugin is not)." \
    "install the Compose v2 package (apt-get install -y docker-compose-v2), then run this again."
fi

# --- 5. host tools used later by the real install -----------------------------------------
# render-stack, migrations and first-owner run in a container of the engine image (engine_run),
# so this host needs no Node and no pnpm. Check the image during the dry run, before generating
# secrets or starting containers.
if ! engine_resolve_image "$RELEASE_FILE"; then
  problem "the engine image is not known: there is no digest in LARES_ENGINE_IMAGE, in $BOX_DIR/engine-image, or under images.\"lares-keeper\" in a release file given with --release." \
    "give --release <release file> (its lares-keeper image is the engine), or unpack the engine files so $BOX_DIR/engine-image exists, then run this again."
elif command -v docker >/dev/null 2>&1 && ! docker image inspect "$ENGINE_IMAGE" >/dev/null 2>&1; then
  problem "the engine image is not on this box: $ENGINE_IMAGE." \
    "fetch it by that exact digest (docker image pull $ENGINE_IMAGE), then run this again."
fi

# --- 6. ports 80 and 443 ------------------------------------------------------------------
SS_OUT=$(ss -ltn 2>/dev/null) || SS_OUT=""
BLOCKED=$(printf '%s\n' "$SS_OUT" | awk '{ print $4 }' | grep -E ':(80|443)$' | tr '\n' ' ') || BLOCKED=""
if [ -n "$BLOCKED" ]; then
  # A previous partial install can have started this exact stack already. Compose
  # lists only running containers by default; an unrelated listener still fails.
  OWN_CADDY=""
  if [ -f "$PREFIX/opt/lares/compose.yaml" ]; then
    OWN_CADDY=$(docker compose -f "$PREFIX/opt/lares/compose.yaml" ps -q caddy 2>/dev/null) || OWN_CADDY=""
  fi
  if [ -z "$OWN_CADDY" ]; then
    problem "something is already listening on: ${BLOCKED% }. Caddy needs 80 and 443 free to answer https and fetch a certificate." \
      "stop whatever is using ${BLOCKED% } (as root, 'ss -ltnp' names it), or move it elsewhere, then run this again."
  fi
fi

# --- 7. an existing installation ----------------------------------------------------------
# Found, not fixed: a partial install is reported as what it is, never silently repaired
# by this installer.
REPAIR_MODE=0
if [ -d "$PREFIX/srv/lares" ]; then
  REPAIR_MODE=1
fi

# Screen one only makes sense on a genuinely fresh box: an existing installation is repaired,
# never asked whether to "start fresh" (that would mean wiping it) or to restore over itself.
# RESTORE_ARCHIVE is always empty here — an explicit --restore already exited above.
if [ "$REPAIR_MODE" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  say "this box has nothing here yet. Lares can start fresh, or check a backup archive first (docs/runbooks/export-and-teardown.md) so you can restore it by hand."
  say "  1) start fresh (the default)"
  say "  2) check a backup archive — or pass --restore <archive> next time to skip this question"
  if [ "$ASSUME_YES" != "1" ] && [ "$DRY_RUN" -eq 0 ]; then
    if [ -t 0 ]; then
      printf 'install: start fresh, or check a backup archive? [F/r] ' >&2
      IFS= read -r SCREEN_ONE_ANSWER || SCREEN_ONE_ANSWER=""
      case "$SCREEN_ONE_ANSWER" in
        r|R|restore|Restore)
          printf 'install: path to the backup archive: ' >&2
          IFS= read -r RESTORE_ARCHIVE || RESTORE_ARCHIVE=""
          [ -n "$RESTORE_ARCHIVE" ] || die "no archive path was given, so nothing was checked and nothing has been installed." "$EX_USAGE"
          verify_restore_archive "$RESTORE_ARCHIVE"
          exit "$EX_OK"
          ;;
        *) : ;;  # anything else, including a bare Enter, means "start fresh"
      esac
    else
      die "this needs to know whether to start fresh or check a backup archive before doing anything else, and there is no terminal to ask. Run again with --yes to start fresh, or --restore <archive> to check a backup." "$EX_USAGE"
    fi
  fi
fi

# The owner may have saved OAuth credentials before running this installer. Validate the
# public client ID while preflight can still refuse without writing installation secrets.
if [ "$DRY_RUN" -eq 0 ] && [ -f "$PREFIX/etc/lares/console-oauth.env" ] && \
   ! grep -Eq '^GOOGLE_CLIENT_ID_CONSOLE=[0-9]+-[A-Za-z0-9_-]+[.]apps[.]googleusercontent[.]com$' "$PREFIX/etc/lares/console-oauth.env"; then
  problem "the Google console client ID is malformed" "save only the client_id value ending in .apps.googleusercontent.com in $PREFIX/etc/lares/console-oauth.env, without quotes or adjacent JSON fields"
fi

# --- report --------------------------------------------------------------------------------
if [ -s "$WARNINGS" ]; then
  say "warnings (this can still go ahead):"
  while IFS= read -r line; do say "  $line"; done < "$WARNINGS"
fi

if [ -s "$PROBLEMS" ]; then
  {
    echo "install: this box is not ready yet. Nothing has been written. Fix these and run this again:"
    cat "$PROBLEMS"
  } >&2
  exit "$EX_REFUSED"
fi

if [ "$REPAIR_MODE" -eq 1 ]; then
  say "found an existing installation under $PREFIX/srv/lares — this would update it in place, not start over."
else
  say "found no existing installation under $PREFIX/srv/lares — this would start a fresh install."
fi

# --- 6b. the release this install is for ------------------------------------------
# --release has been parsed since the very first installer commit and read NOWHERE: advertised,
# accepted, and silently ignored. From here on it is load-bearing — run_stack renders the whole
# stack file from it, and every image in that file is a digest out of it, so an install with no
# release file has nothing to bring up.
#
# WHY HERE, and not beside the other usage checks at the top. A person whose box is too small,
# or who is not root, should be told THAT — the box's own checks have had their say by this
# line, and every problem they found has already been printed. Nothing has been written yet
# either: the first secret is generated a few lines below, so a refusal here still leaves the
# machine exactly as it was.
#
# A DRY RUN IS EXEMPT, on purpose: it asks nothing, writes nothing and never reaches run_stack,
# and "would this box do?" is a fair question to ask before a release file is in hand. Its own
# message at the foot of this script names the flag a real run needs.
#
# The wording follows ops/update.sh (its --release checks refuse for exactly these two reasons),
# so the two commands say the same thing about the same file.
if [ "$DRY_RUN" -eq 0 ]; then
  if [ -z "$RELEASE_FILE" ]; then
    echo "install: no --release file was given, so there is nothing to install. Nothing has been written." >&2
    usage
    exit "$EX_USAGE"
  fi
  if [ ! -f "$RELEASE_FILE" ]; then
    echo "install: there is no release file at '$RELEASE_FILE'. Nothing has been changed." >&2
    exit "$EX_USAGE"
  fi
  # The renderers run in a container that mounts the release file at its own path, so the path
  # must be absolute. Anchor a caller-relative release path now, while it still names the file
  # we checked.
  case "$RELEASE_FILE" in
    /*) ;;
    *) RELEASE_FILE="$PWD/$RELEASE_FILE" ;;
  esac
fi

LARES_NETWORK="${LARES_NETWORK:-lares-network}"
LARES_SUBNET="${LARES_SUBNET:-172.30.0.0/24}"

# Establish or validate the external database-authentication boundary before the installer
# creates a secret or asks the wizard to write installation settings. Fresh custody is only
# created after screen one accepted a new installation; existing state is never repaired here.
if [ "$DRY_RUN" -eq 0 ]; then
  if [ "$REPAIR_MODE" -eq 0 ]; then
    python3 "$HERE/maintenance-custody.py" prepare-fresh "${PREFIX:-/}" "$LARES_SUBNET" --confirm-fresh || die "fresh database authentication custody could not be prepared; any partial evidence was retained." "$EX_REFUSED"
  else
    python3 "$HERE/maintenance-custody.py" validate "${PREFIX:-/}" "$LARES_SUBNET" || die "this installation has missing or invalid database authentication custody; no repair was attempted." "$EX_REFUSED"
  fi
fi

# --- 7. the installation's own credentials -----------------------------------------
# OWNER DECISION: a secret is a FILE under /etc/lares/secrets/, root:lares 0440, mounted
# into containers as a Docker secret. Never an environment value (they leak into
# `docker inspect`, `ps` and every crash report), and never shown back.
#
# TWO PROMISES, AND WHY EACH ONE IS LOAD-BEARING:
#
#  1. GENERATED ONCE. A secret file that exists and is non-empty is left exactly as it is —
#     not rewritten, not truncated, not even re-permissioned. Regenerating token-enc-key would
#     make every OAuth token already stored in the database undecryptable (AES-256-GCM,
#     services/box/lib/crypto.ts), i.e. every saved sign-in silently dead. Regenerating
#     database-password would lock every agent out of Postgres. Because the installer must be
#     safe to re-run after ANY failure, "already there" has to mean "untouched", by
#     construction rather than by care.
#
#  2. NEVER PRINTED. A secret's value goes from /dev/urandom into its file through a pipe and a
#     redirection, and is never assigned to a shell variable, never passed as an argument to
#     anything (argv is world-readable in `ps`), never exported, and never echoed — not on
#     stdout, not on stderr, not on a dry run. What this command prints is names and paths.
#     Everything below is written that way on purpose; a line that captured a value into a
#     variable would put it one `set -x` away from a terminal scrollback and a support paste.
#
# ENTROPY: /dev/urandom, through od/head — present on every Ubuntu, in coreutils, with no
# package to install. (The plan sketched `openssl rand`; the pre-flight above does not check
# for openssl, and an installer that dies on a missing tool AFTER passing its own checks is
# worse than one that uses the kernel's own source. Same bytes, one dependency fewer.)
#
# OWNERSHIP IS NUMERIC, NOT A NAMED GROUP. Every runtime image
# runs `USER 10001:10001`, and compose bind-mounts each secret file with the HOST's ownership —
# the container sees exactly the numeric owner the host gave the file, never a name. A named
# host group (e.g. "lares") whose gid happens not to be 10001 on this particular box means the
# container's own user cannot read a secret it was just given: EACCES, every time, no matter how
# correctly the group was created. Naming the number instead of a group sidesteps that class of
# failure by construction. Every shipped image runs as gid 10001, so accepting another value
# would create secrets none of those images can read. Keep the environment name only to turn an
# accidental override into an explicit refusal rather than silently ignoring it.
LARES_RUNTIME_GID="${LARES_RUNTIME_GID:-10001}"
[ "$LARES_RUNTIME_GID" = "10001" ] || die "LARES_RUNTIME_GID is '$LARES_RUNTIME_GID', but every shipped runtime image uses gid 10001. Refusing before any secret is written; remove the override." "$EX_REFUSED"
SECRETS_DIR="$PREFIX/etc/lares/secrets"
OPERATOR_DIR="$PREFIX/etc/lares/operator"
OPERATOR_PASSWORD_FILE="$OPERATOR_DIR/database-password"

# Created, permissioned and owned only when it is not already there — an existing secrets
# directory belongs to a running installation and is not this command's to re-permission.
ensure_secrets_dir() {
  if [ -d "$SECRETS_DIR" ]; then
    return 0
  fi
  do_or_say mkdir -p "$SECRETS_DIR"
  do_or_say chmod 0750 "$SECRETS_DIR"
  if ! do_or_say chown "0:$LARES_RUNTIME_GID" "$SECRETS_DIR"; then
    say "could not set the owner of $SECRETS_DIR to 0:$LARES_RUNTIME_GID — it stays root-only for now (more restrictive, never less). Fix: chown 0:$LARES_RUNTIME_GID $SECRETS_DIR"
  fi
}

# lares_secret <name> <bytes> <encoding> [prefix]
#   encoding: hex (2 characters per byte) | base64url (URL-safe, no padding, no '+' or '/' and
#   in particular no ':', so it is safe inside an HTTP Basic credential and inside a URL).
#   The optional prefix is NOT secret — it exists because LiteLLM refuses a key that does not
#   begin "sk-".
lares_secret() {
  local name bytes encoding lead target tmp want got
  name="$1"; bytes="$2"; encoding="$3"; lead="${4:-}"
  target="$SECRETS_DIR/$name"

  # Promise 1. Non-empty means finished: leave it completely alone, and say so.
  if [ -s "$target" ]; then
    say "  $name — already there ($target). Left exactly as it is."
    return 0
  fi

  case "$encoding" in
    hex)       want=$(( bytes * 2 )) ;;
    base64url) want=$(( (bytes * 8 + 5) / 6 )) ;;
    *)         die "internal: unknown secret encoding '$encoding' for $name" "$EX_REFUSED" ;;
  esac
  want=$(( want + ${#lead} ))

  if [ "$DRY" -eq 1 ]; then
    say "  $name — would generate ${want} characters of $encoding into $target"
    return 0
  fi

  ensure_secrets_dir
  [ -r /dev/urandom ] || die "there is no readable /dev/urandom on this box, so no secret can be generated safely. Nothing has been written." "$EX_REFUSED"

  # Written to a NEIGHBOURING name first, inside the same directory (never /tmp — a secret must
  # not exist outside the directory it belongs in, even for a moment), checked for length, and
  # only then moved into place. An interrupted run therefore leaves a .partial the next run
  # removes, never a short or empty file some service would later read as its password.
  tmp="$target.partial"
  rm -f "$tmp"
  # umask 077 (set at the top of this file) means this is born 0600, so there is no window in
  # which it is readable by anyone else.
  case "$encoding" in
    hex)
      { printf '%s' "$lead"; od -An -vtx1 -N "$bytes" < /dev/urandom | tr -d ' \n'; printf '\n'; } > "$tmp"
      ;;
    base64url)
      { printf '%s' "$lead"; head -c "$bytes" /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; printf '\n'; } > "$tmp"
      ;;
  esac

  # A short read is a hard failure. `wc` is given the file on stdin and gives back a COUNT —
  # the only thing about a secret this script is ever allowed to know.
  got=$(wc -c < "$tmp" | tr -d ' ')
  if [ "$got" != "$(( want + 1 ))" ]; then
    rm -f "$tmp"
    die "generating $name produced the wrong number of characters, so it has been thrown away rather than used. Nothing was written to $target." "$EX_REFUSED"
  fi

  do_or_say chmod 0440 "$tmp"
  # chmod above runs first and unconditionally, so a chown failure below still leaves the file
  # 0440 root:root — readable by root alone, which is MORE restrictive than the intended
  # 0:LARES_RUNTIME_GID, never less. A container running as another uid will not be able to read
  # it until the owner is fixed by hand.
  if ! do_or_say chown "0:$LARES_RUNTIME_GID" "$tmp"; then
    say "  could not set the owner of $name to 0:$LARES_RUNTIME_GID — it stays root-only, and a container running as another user will not be able to read it. Fix: chown 0:$LARES_RUNTIME_GID $target"
  fi
  do_or_say mv "$tmp" "$target"
  say "  $name — generated ($target). Its value is not printed, here or anywhere else."
}

say "secrets (files under $SECRETS_DIR, owner 0:$LARES_RUNTIME_GID 0440 — never an environment value, never shown back):"
# The model PROVIDER key is NOT in this list. It is not ours to invent: it is asked for in the
# wizard and written straight to etc/lares/secrets/model-provider-key from the answer. A
# generated placeholder here would look exactly like a real key to every check after it.
lares_secret console-session-secret 32 base64url  # writes $SECRETS_DIR/console-session-secret
lares_secret console-vault-signing-key 32 hex     # writes $SECRETS_DIR/console-vault-signing-key (console/Keeper request capsule key)
lares_secret console-model-purpose-signing-key 32 hex # writes $SECRETS_DIR/console-model-purpose-signing-key (dedicated Console/Keeper model-purpose request capsule key)
lares_secret database-password      32 base64url  # writes $SECRETS_DIR/database-password
lares_secret financial-database-password 32 base64url
lares_secret workflow-provisioner-password 32 base64url
lares_secret workflow-password 32 base64url
lares_secret gateway-database-password 32 base64url
lares_secret eve-route-password     32 base64url  # writes $SECRETS_DIR/eve-route-password
lares_secret gateway-key            32 base64url "sk-"  # writes $SECRETS_DIR/gateway-key
# gateway-master-key. The engine renders the gateway service itself (lib/stack-compose.ts) and its
# LiteLLM configuration (lib/gateway-config.ts), and images/gateway-runtime/start.sh reads THIS
# file back as GATEWAY_MASTER_KEY_FILE and exports its contents as the value LiteLLM's
# general_settings.master_key resolves. The gateway is not started during installer setup.
lares_secret gateway-master-key     32 base64url "sk-"  # writes $SECRETS_DIR/gateway-master-key
lares_secret token-enc-key          32 hex  # writes $SECRETS_DIR/token-enc-key

# The Postgres superuser is an offline operator input, never a member of the online secrets
# directory or of any directory bind-mounted into Keeper. Existing files are retained, but the
# database bootstrap helper refuses an already initialized data directory or role state, so this
# cannot silently adopt an old password.
ensure_operator_password() {
  local tmp
  if ! python3 - "$PREFIX" "$OPERATOR_DIR" "$SECRETS_DIR" "$PREFIX/var/lib/lares" "$PREFIX/srv/lares" <<'PYOPERATOR'
import os,stat,sys
prefix,operator,secrets,keeper,agents=map(os.path.abspath,sys.argv[1:])
def overlaps(a,b):return a==b or a.startswith(b.rstrip(os.sep)+os.sep) or b.startswith(a.rstrip(os.sep)+os.sep)
operator_real=os.path.realpath(operator)
if any(overlaps(operator_real,os.path.realpath(online)) for online in (secrets,keeper,agents)):
 raise SystemExit('offline operator directory overlaps an online secret or data mount')
prefix_real=os.path.realpath(prefix)
if not (operator_real==prefix_real or operator_real.startswith(prefix_real.rstrip(os.sep)+os.sep)):
 raise SystemExit('offline operator directory resolves outside the installation prefix')
path=operator
while path!=prefix:
 if os.path.lexists(path) and stat.S_ISLNK(os.lstat(path).st_mode):
  raise SystemExit('offline operator directory has a symbolic-link ancestor')
 parent=os.path.dirname(path)
 if parent==path or not (path.startswith(prefix.rstrip(os.sep)+os.sep) or prefix==os.sep):
  raise SystemExit('offline operator directory escaped the installation prefix')
 path=parent
PYOPERATOR
  then
    die "the offline operator directory is not isolated from online mounts or contains a symbolic-link ancestor." "$EX_REFUSED"
  fi
  if [ -e "$OPERATOR_PASSWORD_FILE" ]; then
    [ -f "$OPERATOR_PASSWORD_FILE" ] && [ ! -L "$OPERATOR_PASSWORD_FILE" ] && [ -s "$OPERATOR_PASSWORD_FILE" ] \
      || die "the offline database operator credential at $OPERATOR_PASSWORD_FILE is not a non-empty regular file. Inspect it before retrying." "$EX_REFUSED"
    [ "$(stat -c '%u:%a' "$OPERATOR_PASSWORD_FILE" 2>/dev/null || true)" = "0:600" ] \
      || die "the offline database operator credential must be owned by root with mode 0600. Fix its permissions before retrying." "$EX_REFUSED"
    [ -d "$OPERATOR_DIR" ] && [ ! -L "$OPERATOR_DIR" ] && [ "$(stat -c '%u:%a' "$OPERATOR_DIR" 2>/dev/null || true)" = "0:700" ] \
      || die "the offline database operator directory must be a root-owned 0700 directory." "$EX_REFUSED"
    return
  fi
  [ "$DRY" -eq 1 ] && { say "would create a root-only offline database operator credential at $OPERATOR_PASSWORD_FILE"; return; }
  [ ! -e "$OPERATOR_DIR" ] && [ ! -L "$OPERATOR_DIR" ] || {
    [ -d "$OPERATOR_DIR" ] && [ ! -L "$OPERATOR_DIR" ] && [ "$(stat -c '%u:%a' "$OPERATOR_DIR" 2>/dev/null || true)" = "0:700" ] \
      || die "the offline database operator directory exists with unexpected type, owner or permissions." "$EX_REFUSED"
  }
  mkdir -p "$OPERATOR_DIR"
  [ ! -L "$OPERATOR_DIR" ] || die "the offline database operator directory became a symbolic link before credential creation." "$EX_REFUSED"
  chmod 0700 "$OPERATOR_DIR"
  tmp=$(mktemp "$OPERATOR_DIR/.database-password.XXXXXX") || die "the offline operator credential file could not be created safely." "$EX_REFUSED"
  head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$tmp"
  printf '\n' >> "$tmp"
  [ "$(wc -c < "$tmp" | tr -d ' ')" = 44 ] || { rm -f "$tmp"; die "the offline operator credential could not be generated safely." "$EX_REFUSED"; }
  chmod 0600 "$tmp"
  chown 0:0 "$tmp"
  ln "$tmp" "$OPERATOR_PASSWORD_FILE" || { rm -f "$tmp"; die "an operator credential appeared while this install was running; inspect it before retrying." "$EX_REFUSED"; }
  rm -f "$tmp"
}
ensure_operator_password

# --- 8. four questions, asked once -----------------------------
# FOUR THINGS ONLY: the domain, the e-mail address, the name, and a model provider key.
# Everything else — the time zone, the gateway address, the model alias, Slack, Telegram,
# Notion, backup — is either read from this machine or moved into the console, after the first
# conversation. Answers are written ONCE to $INSTALL_ENV; a re-run reads
# them back (wizard_already_done, below) and never asks again, and never silently overwrites an
# answer that is already there — there is no "change one answer" flag, so changing a written
# answer means editing the file by hand.
#
# THE MODEL KEY IS A SECRET, handled exactly like every other one above, the model provider's own key included: it goes straight into its own
# file under $SECRETS_DIR, 0440, 0:$LARES_RUNTIME_GID, through the same temp-name-then-mv
# discipline as lares_secret, and an existing non-empty file is left exactly as it is. It NEVER
# appears in $INSTALL_ENV, on a command line, in an environment variable, or on any stream this
# script writes to — see capture_model_key, below, for exactly how it travels from the keyboard
# (or a named file) to that file and nowhere else.
#
# THE SETTINGS FILE IS DATA, NOT A SCRIPT. A name typed here can contain almost anything short
# of a newline or a control character (it is a person's name, not a hostname) — semicolons,
# backticks, $(...), quotes. None of that may ever run as shell code. This script never
# `source`s or `eval`s $INSTALL_ENV, and reads it back only through read_setting(), below, which
# parses it with sed — never the shell's own word-splitting or expansion. Any later code that
# wants a value out of this file should do the same, for the same reason: env_line() quotes a
# value the moment it holds anything outside a safe, plain character set, so a value that round
# trips through read_setting() is exactly the value that was typed, and a value that is merely
# grepped out of the file (its own header says how) never needs unquoting at all unless it looks
# quoted to begin with.
INSTALL_ENV="$PREFIX/etc/lares/installation.env"
# The gateway is a compose service of the installation's own stack, reached on the fleet's own
# docker network under this compose service name, never the public internet.
# It is written plainly, as one address: the contract test's host rule names it as a fleet-internal
# service and says why, which is the honest way past that rule — splitting the string so the rule
# cannot see it would leave the next reader with a puzzle and the rule with a hole.
GATEWAY_URL_DEFAULT="http://lares-gateway:4000"
LARES_MODEL_ALIAS_DEFAULT="lares-brain"
# A fresh install's default model is Opus. Not a guess, not a
# tuning knob picked here — the gateway's own config renderer (lib/gateway-config.ts) takes
# whatever this settles on and never chooses one itself.
LARES_MODEL_DEFAULT="anthropic/claude-opus-5"
LARES_NAME_MAX=200

# env_line <key> <value> — one line of $INSTALL_ENV. A value made only of characters that are
# never special to a shell (letters, digits, and @ . : / = -) is written bare, so the common
# case — a domain, an e-mail address, a URL derived from the domain — reads exactly as typed.
# Anything else (a name with a space, a quote, a semicolon, a backtick) is single-quoted, which
# in POSIX shell quoting turns EVERY character inside it into literal text with no exception but
# the quote character itself, escaped the standard way: close the quote, add an escaped quote,
# reopen it.
env_line() {
  local key="$1" value="$2"
  case "$value" in
    *[!A-Za-z0-9@._:/=-]*)
      printf '%s=%s\n' "$key" "'$(printf '%s' "$value" | sed "s/'/'\\\\''/g")'"
      ;;
    *)
      printf '%s=%s\n' "$key" "$value"
      ;;
  esac
}

# read_setting <name> <file> — the sanctioned way anything reads a value back out of this file:
# never source, never eval. Round-trips whatever env_line wrote, quoted or not.
read_setting() {
  local name="$1" file="$2" raw
  [ -f "$file" ] || return 0
  raw=$(sed -n "s/^${name}=//p" "$file" | head -1) || raw=""
  case "$raw" in
    \'*\')
      raw="${raw#\'}"
      raw="${raw%\'}"
      printf '%s' "$raw" | sed "s/'\\\\''/'/g"
      ;;
    *)
      printf '%s' "$raw"
      ;;
  esac
}

validate_domain() {
  printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
}

validate_email() {
  local v="$1" at_count
  case "$v" in *[[:space:]]*) return 1 ;; esac
  at_count=$(printf '%s' "$v" | tr -cd '@' | wc -c | tr -d ' ')
  [ "$at_count" = "1" ] || return 1
  case "$v" in
    @*|*@) return 1 ;;
  esac
  return 0
}

validate_name() {
  local v="$1" len
  len=$(printf '%s' "$v" | wc -c | tr -d ' ')
  [ "$len" -ge 1 ] && [ "$len" -le "$LARES_NAME_MAX" ]
}

validate_model_key() {
  local v="$1"
  [ -n "$v" ] || return 1
  # Browser consoles can insert ESC before pasted characters. Those bytes are
  # invisible at this prompt but make the upstream HTTP auth header invalid.
  case "$v" in *[[:space:]]*|*[[:cntrl:]]*) return 1 ;; esac
  return 0
}

# apply_transform <name> <value> — the only shaping a candidate answer gets before validation.
# "lower" lower-cases a domain (DNS names are case-insensitive; storing one shape avoids two
# settings files disagreeing about the same server). "strip" removes control characters from a
# name (it will be shown on screen later, so anything invisible comes out) and trims the
# whitespace that is left at either end.
apply_transform() {
  case "$1" in
    lower) printf '%s' "$2" | tr '[:upper:]' '[:lower:]' ;;
    strip) printf '%s' "$2" | tr -d '[:cntrl:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' ;;
    *) printf '%s' "$2" ;;
  esac
}

# ask_and_validate <flag-value> <flag-name> <prompt-ending-in-?> <validator> <retry-message>
#                  [transform]
# Sets the global ANSWER on success. A flag value is validated once and either used or refused
# outright (there is no way to "try again" with a value baked into the command line). An
# interactive answer is re-asked until it validates, and refused, naming the flag, the moment
# stdin runs out with nothing usable in it left to read — this is what makes a non-interactive
# run with a missing answer refuse instead of hang: reading a closed or empty stdin returns
# immediately, it never blocks.
ANSWER=""
ask_and_validate() {
  local flag_val="$1" flag_name="$2" prompt="$3" validator="$4" bad_msg="$5" transform="${6:-}" candidate
  if [ -n "$flag_val" ]; then
    candidate=$(apply_transform "$transform" "$flag_val")
    if ! "$validator" "$candidate"; then
      die "the value given with $flag_name $bad_msg" "$EX_USAGE"
    fi
    ANSWER="$candidate"
    return 0
  fi
  while :; do
    say "$prompt"
    if ! IFS= read -r candidate; then
      die "nothing was given for $flag_name, and there is nothing left to read. Run again with $flag_name <value> to answer without a prompt." "$EX_USAGE"
    fi
    candidate=$(apply_transform "$transform" "$candidate")
    if "$validator" "$candidate"; then
      ANSWER="$candidate"
      return 0
    fi
    say "$bad_msg"
  done
}

# resolve_domain_addresses <domain> — every address this machine's own resolver can find for
# it, one per line, or nothing. getent (glibc's own lookup tool, present on every Ubuntu box —
# nothing to install) is tried first; dig is a fallback for a machine that has it but not a
# working getent. Both read only the resolver already configured on THIS machine — neither is
# an outside "what is my IP" service, and nothing here phones home.
resolve_domain_addresses() {
  local domain="$1"
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$domain" 2>/dev/null | awk '{print $1}'
    return 0
  fi
  if command -v dig >/dev/null 2>&1; then
    dig +short "$domain" 2>/dev/null
    return 0
  fi
  return 1
}

# server_addresses — this machine's own address(es), read locally from its network interfaces
# (hostname -I, present on every Ubuntu box). Never asked of an outside service — nothing here
# phones home either.
server_addresses() {
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$'
    return 0
  fi
  return 1
}

# check_domain_dns <domain> — refuses, before anything is written, unless
# the domain already resolves to THIS server: Let's Encrypt locks a domain out after repeated
# failed attempts, so guessing here and finding out later is worse than stopping now and asking
# again once the DNS record exists. No flag skips this check.
check_domain_dns() {
  local domain="$1" found mine record fip mip match
  found=$(resolve_domain_addresses "$domain") || found=""
  mine=$(server_addresses) || mine=""

  [ -n "$mine" ] || die "could not learn this machine's own address (no working 'hostname -I'), so $domain could not be checked. Nothing has been written." "$EX_REFUSED"

  record="A    $domain    ${mine%%$'\n'*}"

  if [ -z "$found" ]; then
    die "$domain does not resolve anywhere yet. Create this DNS record, wait for it to reach this machine, and run this again: $record" "$EX_REFUSED"
  fi

  match=0
  while IFS= read -r fip; do
    [ -n "$fip" ] || continue
    while IFS= read -r mip; do
      [ -n "$mip" ] || continue
      [ "$fip" = "$mip" ] && match=1
    done <<SERVER_ADDR
$mine
SERVER_ADDR
  done <<FOUND_ADDR
$found
FOUND_ADDR

  if [ "$match" -eq 0 ]; then
    die "$domain resolves to $(printf '%s' "$found" | tr '\n' ' '); this server is $(printf '%s' "$mine" | tr '\n' ' '). Create this DNS record, wait for it to reach this machine, and run this again: $record" "$EX_REFUSED"
  fi
}

# wizard_already_done — the three non-secret answers are all written down. The model key is
# checked separately, in capture_model_key, with the same "leave it alone" discipline every
# other secret gets.
wizard_already_done() {
  [ -f "$INSTALL_ENV" ] || return 1
  [ -n "$(read_setting LARES_DOMAIN "$INSTALL_ENV")" ] || return 1
  [ -n "$(read_setting LARES_OWNER_EMAIL "$INSTALL_ENV")" ] || return 1
  [ -n "$(read_setting LARES_OWNER_NAME "$INSTALL_ENV")" ] || return 1
  return 0
}

# write_installation_env — rewritten atomically (a neighbouring .partial, then mv), the same
# discipline lares_secret uses above, so an interrupted run never leaves a half-written file a
# later run would mistake for a finished one.
write_installation_env() {
  local tmp="$INSTALL_ENV.partial"
  local owner_id
  if [ "$OWNER_ID_GIVEN" -eq 1 ]; then
    [ -n "$OWNER_ID_FLAG" ] || die "--owner-id was given as an empty id. Nothing else was changed." "$EX_USAGE"
    owner_id="$OWNER_ID_FLAG"
  else
    owner_id=$(derive_owner_id "$LARES_OWNER_EMAIL")
    [ -n "$owner_id" ] || die "could not derive an owner id from '$LARES_OWNER_EMAIL'; use --owner-id. Nothing else was changed." "$EX_USAGE"
  fi
  do_or_say mkdir -p "$(dirname "$INSTALL_ENV")"
  rm -f "$tmp"
  {
    printf '%s\n' "# Written once by install.sh's four questions."
    printf '%s\n' "# Read this with read_setting() in that script, or with plain sed/grep —"
    printf '%s\n' "# never source or eval it: a name or an address typed here is data, not code."
    env_line LARES_DOMAIN "$LARES_DOMAIN"
    env_line LARES_OWNER_EMAIL "$LARES_OWNER_EMAIL"
    env_line LARES_OWNER_NAME "$LARES_OWNER_NAME"
    env_line LARES_OWNER_ID "$owner_id"
    env_line OWNER_HOME_TZ "$OWNER_HOME_TZ"
    printf '%s\n' "# CONSOLE_ALLOWED_EMAILS is comma-separated; add more addresses by editing"
    printf '%s\n' "# this file and rerunning the installer — Lares never assumes there is only"
    printf '%s\n' "# one person."
    env_line CONSOLE_ALLOWED_EMAILS "$LARES_OWNER_EMAIL"
    env_line CONSOLE_OAUTH_REDIRECT "https://$LARES_DOMAIN/api/auth/callback"
    env_line GATEWAY_URL "$GATEWAY_URL_DEFAULT"
    env_line LARES_MODEL_ALIAS "$LARES_MODEL_ALIAS_DEFAULT"
    env_line LARES_MODEL "$LARES_MODEL_DEFAULT"
  } > "$tmp"
  do_or_say chmod 0640 "$tmp"
  if ! do_or_say chown "0:$LARES_RUNTIME_GID" "$tmp"; then
    say "  could not set the owner of installation.env to 0:$LARES_RUNTIME_GID — it stays root-only for now (more restrictive, never less). Fix: chown 0:$LARES_RUNTIME_GID $INSTALL_ENV"
  fi
  do_or_say mv "$tmp" "$INSTALL_ENV"
}

# capture_model_key — the model PROVIDER key, read once and written
# straight to its own secret file. An existing non-empty file is left exactly as it is, exactly
# like lares_secret above, and this is the only place in the whole script that ever holds a
# secret's actual bytes in a shell variable — bash has no other way to receive typed input. The
# value is kept in exactly ONE local variable ($key), written out with a `>` REDIRECTION (a
# shell builtin: nothing this produces ever appears in any process's argument list), and unset
# (key="") the instant it has been written. It is never assigned to a global, never exported,
# never passed as an argument to an external command, and never echoed — on a prompt, on this
# script's own output, or in a dry run (capture_model_key is only ever called when DRY_RUN=0;
# see the call site below).
capture_model_key() {
  local target="$SECRETS_DIR/model-provider-key" key tmp

  if [ -s "$target" ]; then
    say "  model-provider-key — already there ($target). Left exactly as it is."
    return 0
  fi

  if [ -n "$MODEL_KEY_FILE_FLAG" ]; then
    [ -r "$MODEL_KEY_FILE_FLAG" ] || die "cannot read the file given with --model-key-file ('$MODEL_KEY_FILE_FLAG')." "$EX_USAGE"
    key=$(cat "$MODEL_KEY_FILE_FLAG")
    if ! validate_model_key "$key"; then
      key=""
      die "the file given with --model-key-file does not hold a usable key: it must be one line, non-empty, with no whitespace or control characters inside it." "$EX_USAGE"
    fi
  else
    while :; do
      say "paste your model provider's API key (it will not be shown as you type)?"
      # Terminal echo off before the read, restored the instant it returns — by hand here (not
      # only relying on `read -s`'s own handling), and again by the cleanup trap above on every
      # exit path, including Ctrl-C mid-read.
      if [ -t 0 ]; then
        STTY_ORIG=$(stty -g 2>/dev/null) || STTY_ORIG=""
        stty -echo 2>/dev/null || true
      fi
      if ! IFS= read -r key; then
        if [ -t 0 ]; then stty "$STTY_ORIG" 2>/dev/null || true; STTY_ORIG=""; fi
        die "nothing was given for the model key, and there is nothing left to read. Run again with --model-key-file <path> to answer without a prompt." "$EX_USAGE"
      fi
      if [ -t 0 ]; then
        stty "$STTY_ORIG" 2>/dev/null || true
        STTY_ORIG=""
        printf '\n'
      fi
      if validate_model_key "$key"; then
        break
      fi
      key=""
      say "that does not look like a key: it must be one line, non-empty, with no whitespace or control characters inside it. Try again."
    done
  fi

  ensure_secrets_dir
  tmp="$target.partial"
  rm -f "$tmp"
  printf '%s\n' "$key" > "$tmp"
  key=""
  do_or_say chmod 0440 "$tmp"
  if ! do_or_say chown "0:$LARES_RUNTIME_GID" "$tmp"; then
    say "  could not set the owner of model-provider-key to 0:$LARES_RUNTIME_GID — it stays root-only, and a container running as another user will not be able to read it. Fix: chown 0:$LARES_RUNTIME_GID $target"
  fi
  do_or_say mv "$tmp" "$target"
  say "  model-provider-key — saved ($target). Its value is not printed, here or anywhere else."
}

run_wizard() {
  if wizard_already_done; then
    say "the domain, e-mail address and name are already written down in $INSTALL_ENV — nothing was asked again."
  else
    say "four questions, asked once. Sign in to the console to confirm this host and finish explicit model budget setup before creating an agent."

    ask_and_validate "$DOMAIN_FLAG" "--domain" "what domain will people use to reach Lares (example: example.com)?" validate_domain "that does not look like a domain: no http://, no path, no port, no spaces, no leading dot (example: example.com). Try again." lower
    LARES_DOMAIN="$ANSWER"
    check_domain_dns "$LARES_DOMAIN"

    ask_and_validate "$EMAIL_FLAG" "--email" "what is your e-mail address?" validate_email "that does not look like an e-mail address: it needs exactly one @ with something on each side, and no spaces (example: you@example.com). Try again." ""
    LARES_OWNER_EMAIL="$ANSWER"

    ask_and_validate "$NAME_FLAG" "--name" "what is your name?" validate_name "that's either blank once invisible characters are removed, or over $LARES_NAME_MAX characters. Try again." strip
    LARES_OWNER_NAME="$ANSWER"

    # Time zone: read from the server, never asked.
    OWNER_HOME_TZ=""
    # timedatectl follows the active /etc/localtime link. On Ubuntu, /etc/timezone can
    # remain stale after set-timezone, so consult it only when timedatectl is unavailable.
    if command -v timedatectl >/dev/null 2>&1; then
      OWNER_HOME_TZ=$(timedatectl show -p Timezone --value 2>/dev/null) || OWNER_HOME_TZ=""
    fi
    if [ -z "$OWNER_HOME_TZ" ] && [ -r /etc/timezone ]; then
      OWNER_HOME_TZ=$(cat /etc/timezone 2>/dev/null | tr -d '[:space:]') || OWNER_HOME_TZ=""
    fi

    write_installation_env
    say "wrote $INSTALL_ENV."
  fi

  capture_model_key
}

# --- 9. render the stack from the release this run was given ----------------------
# THE FOUR QUESTIONS ARE ANSWERED AND NOTHING IS RUNNING YET. This is the step that turns a
# release file into the installation's own compose file. The database starts for the offline
# bootstrap; Console and Caddy start only after database verification. Gateway startup belongs
# to explicit model-budget setup, after the owner has confirmed the installation.
#
# THE RENDER IS ENGINE CODE, NOT SHELL. The release rules (lib/release-manifest.ts) and the
# stack file's shape (lib/stack-compose.ts) are TypeScript, and restating either in awk would
# be two copies free to drift. `bin/render-stack.ts` is the whole seam, reached the same way
# this script already reaches `migrate` and `first-owner`: `engine_run bin/render-stack.ts`.
# (ops/update.sh does its own release read from a temp program under bare `node`; that cannot
# work here — see that file's own header for why.) A refusal from the release rules — a file
# that is not JSON, an image named by a tag, a service the release names no image for — is
# that program's own stderr, printed as it was written, never re-worded here.
#
# NOTHING IS PULLED BY THIS SCRIPT. `docker compose up -d` pulls what the compose file names,
# and every one of those names is a digest out of the release file (the release rules refuse
# anything else), so promise 3 in this file's header holds without this script fetching an
# image itself.
run_stack() {
  local compose_file="$PREFIX/opt/lares/compose.yaml"
  local caddyfile="$PREFIX/etc/lares/Caddyfile"
  local gateway_config="$PREFIX/etc/lares/litellm-config.yaml"
  # The gateway's entrypoint, installed beside its configuration. NOTHING IN THIS REPOSITORY
  # BUILDS A GATEWAY IMAGE, and nothing may: the official LiteLLM image carries its own
  # `enterprise/` tree, whose licence forbids publishing or distributing it, and a derived image
  # would not be what upstream's cosign signature covers. So the release names the UPSTREAM
  # digest and this file reaches the container as a read-only bind mount instead. render-stack
  # installs it (and owns its mode) — this script only says where.
  local gateway_start="$PREFIX/etc/lares/gateway-start.sh"
  local caddy_data="$PREFIX/var/lib/lares/caddy"
  local db_data="$PREFIX/var/lib/lares/postgres"
  local database_auth_dir="$PREFIX/var/lib/lares-maintenance/postgres-auth"
  local taste_dir="$PREFIX/srv/taste"
  # The same overridable names run_database and run_first_owner read, with the same defaults.
  local db_name="${PGDATABASE:-lares_state}"
  local domain allowed_emails model_alias provider_model owner_id owner_home_tz tmp

  domain=$(read_setting LARES_DOMAIN "$INSTALL_ENV")
  [ -n "$domain" ] || die "the domain is not written down in $INSTALL_ENV, so the stack cannot be rendered. Nothing has been brought up." "$EX_REFUSED"
  allowed_emails=$(read_setting CONSOLE_ALLOWED_EMAILS "$INSTALL_ENV")
  [ -n "$allowed_emails" ] || die "the console allowed e-mails are not written down in $INSTALL_ENV, so access cannot be restricted. Nothing has been brought up." "$EX_REFUSED"
  owner_id=$(read_setting LARES_OWNER_ID "$INSTALL_ENV")
  if [ -z "$owner_id" ]; then
    if [ "$OWNER_ID_GIVEN" -eq 1 ]; then
      owner_id="$OWNER_ID_FLAG"
    else
      owner_id=$(derive_owner_id "$(read_setting LARES_OWNER_EMAIL "$INSTALL_ENV")")
    fi
  fi
  [ -n "$owner_id" ] || die "the owner's id cannot be resolved, so the console cannot be configured. Nothing has been brought up." "$EX_REFUSED"
  owner_home_tz=$(read_setting OWNER_HOME_TZ "$INSTALL_ENV")

  # The two values the gateway's own config is rendered from (lib/gateway-config.ts),
  # read back exactly as LARES_DOMAIN is above — never re-derived, never defaulted here.
  model_alias=$(read_setting LARES_MODEL_ALIAS "$INSTALL_ENV")
  [ -n "$model_alias" ] || die "the model alias is not written down in $INSTALL_ENV, so the gateway's configuration cannot be rendered. Nothing has been brought up." "$EX_REFUSED"
  provider_model=$(read_setting LARES_MODEL "$INSTALL_ENV")
  [ -n "$provider_model" ] || die "the model is not written down in $INSTALL_ENV, so the gateway's configuration cannot be rendered. Nothing has been brought up." "$EX_REFUSED"

  python3 "$HERE/maintenance-custody.py" validate "${PREFIX:-/}" "$LARES_SUBNET" || die "the installation's database authentication custody is missing or invalid; nothing was rendered or started." "$EX_REFUSED"
  do_or_say mkdir -p "$(dirname "$compose_file")" "$(dirname "$caddyfile")" "$(dirname "$gateway_config")" "$caddy_data" "$db_data"
  [ ! -L "$taste_dir" ] || die "$taste_dir is a symbolic link; refusing to mount it into the console." "$EX_REFUSED"
  do_or_say mkdir -p "$taste_dir"
  do_or_say chown 10001:10001 "$taste_dir"
  do_or_say chmod 0750 "$taste_dir"

  # Rendered to a NEIGHBOURING name and moved into place, the same discipline every other file
  # this script writes gets: an interrupted run leaves a .partial the next run overwrites,
  # never a half-written compose file `docker compose` would read as the whole stack.
  tmp="$compose_file.partial"
  rm -f "$tmp"
  # The renderer writes the compose file's neighbour, the gateway config and its start script
  # (two directories, mounted read-write) and reads the release file and, when there is one,
  # the installation's deadline calendar (read-only, mounted only if it exists: docker would
  # otherwise create the missing source as an empty root-owned folder).
  local -a render_mounts=(--rw "$(dirname "$compose_file")" --rw "$(dirname "$gateway_config")" --ro "$RELEASE_FILE" --ro "${PREFIX:-/}/var/lib/lares-maintenance")
  [ ! -d "$PREFIX/srv/lares/installation" ] || render_mounts+=(--ro "$PREFIX/srv/lares/installation")
  if ! engine_run "${render_mounts[@]}" bin/render-stack.ts \
      "$RELEASE_FILE" "$tmp" "$SECRETS_DIR" "$gateway_config" "$caddyfile" \
      "$caddy_data" "$db_data" "$LARES_NETWORK" "$LARES_SUBNET" "$domain" \
      "$db_name" "$model_alias" "$provider_model" "$gateway_start" "$allowed_emails" "$PREFIX/run/lares" "$owner_id" "$owner_home_tz" "$taste_dir" "$PREFIX/srv/lares/installation" "$database_auth_dir" "${PREFIX:-/}"; then
    rm -f "$tmp"
    # Not "the release file was refused": this one call also installs the gateway's start script,
    # and a missing script is not a bad release. Naming the wrong thing is the failure this
    # track keeps having to undo, so the sentence names the step and leaves the reason to the
    # program, which printed it.
    die "rendering this installation's stack from '$RELEASE_FILE' was refused (the reason is printed above). Nothing has been brought up." "$EX_REFUSED"
  fi
  if [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    die "rendering the stack file from '$RELEASE_FILE' produced nothing, so $compose_file has not been written. Nothing has been brought up." "$EX_REFUSED"
  fi
  do_or_say chmod 0640 "$tmp"
  do_or_say mv "$tmp" "$compose_file"
  say "wrote $compose_file from $RELEASE_FILE."
  # 0644, and set HERE rather than left to the mode render-stack asks for: umask 077 at the top
  # of this file means every file that program creates is born 0600 whatever mode it passes, so
  # the compose file and the Caddyfile are both chmod'd after the fact too. This one has to be
  # readable by LiteLLM INSIDE the gateway container, which publishes a `-non_root` variant and
  # whose image comes from the release manifest — the engine does not get to assume root. It
  # names no secret value: the provider key is an `os.environ/…` reference (lib/gateway-config.ts).
  do_or_say chmod 0644 "$gateway_config"
  say "wrote $gateway_config (the gateway's own configuration, naming $model_alias)."
  say "installed $gateway_start (the gateway's entrypoint — the engine builds no gateway image)."

  # THE CADDYFILE IS COMMITTED, NOT GENERATED. It lives beside this script (ops/Caddyfile) and
  # uses Caddy's own `{$LARES_DOMAIN}` substitution rather than a renderer, so there is nothing
  # to render — but something has to put it where the compose file mounts it from, and this is
  # the step that does that.
  [ -r "$HERE/Caddyfile" ] || die "the Caddyfile that belongs beside this script is missing ($HERE/Caddyfile), so Caddy would start with no site to serve. Nothing has been brought up." "$EX_REFUSED"
  do_or_say cp "$HERE/Caddyfile" "$caddyfile"
  do_or_say chmod 0644 "$caddyfile"
  say "installed $caddyfile (the domain reaches Caddy through the caddy service's own environment)."

  if ! do_or_say docker compose -f "$compose_file" up -d db; then
    die "the normal database service did not start after the temporary bootstrap container was removed." "$EX_REFUSED"
  fi
  local tries=0
  until docker compose -f "$compose_file" exec -T db pg_isready -U lares_operator -d postgres >/dev/null 2>&1; do
    tries=$((tries + 1)); [ "$tries" -lt 30 ] || die "the normal database service did not become ready after bootstrap removal." "$EX_TEMPFAIL"; sleep 1
  done
  local live_container
  live_container=$(docker compose -f "$compose_file" ps -q db 2>/dev/null) || live_container=""
  [ -n "$live_container" ] || die "the normal database container has no identity to verify." "$EX_REFUSED"
  if [ -n "${BOOTSTRAP_DB_CONTAINER_ID:-}" ] && [ "$live_container" = "$BOOTSTRAP_DB_CONTAINER_ID" ]; then
    die "the normal database service reused its bootstrap container, so the operator password may still be mounted. Nothing else was started." "$EX_REFUSED"
  fi
  local mounts
  mounts=$(docker inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' "$live_container" 2>/dev/null) \
    || die "the normal database container mounts could not be checked; no application service was started." "$EX_REFUSED"
  if printf '%s\n' "$mounts" | grep -Fqx "$OPERATOR_PASSWORD_FILE"; then
    die "the normal database container still mounts the offline operator credential. No application service was started." "$EX_REFUSED"
  fi
  say "the normal database service is running without the bootstrap container or its operator-secret mount."
}

run_online_stack() {
  local compose_file="$PREFIX/opt/lares/compose.yaml"
  if ! docker compose -f "$compose_file" up -d console caddy; then
    die "Console and Caddy did not start after the offline database steps completed." "$EX_REFUSED"
  fi
  say "Console and Caddy are running; the database remains operator-secret-free. This installer did not start the gateway."
}

# The first database container exists only for initialization. Its password is a host file under
# /etc/lares/operator, outside every online bind mount. A partial first setup has no completion
# marker and is refused on a rerun: we never infer custody from a role or an existing database.
BOOTSTRAP_DB_CONTAINER_ID=""
run_database_bootstrap() {
  local db_name="${PGDATABASE:-lares_state}" db_host="${PGHOST:-127.0.0.1}" db_port="${PGPORT:-5432}"
  local compose_file="$PREFIX/opt/lares/compose.bootstrap.yaml" final_file="$PREFIX/opt/lares/compose.yaml"
  local db_data="$PREFIX/var/lib/lares/postgres" database_auth_dir="$PREFIX/var/lib/lares-maintenance/postgres-auth" marker="$PREFIX/etc/lares/database-bootstrap-complete"
  local old_container role_image
  local tmp="$compose_file.partial" tries=0
  python3 "$HERE/maintenance-custody.py" validate "${PREFIX:-/}" "$LARES_SUBNET" || die "the installation's database authentication custody is missing or invalid; bootstrap was refused." "$EX_REFUSED"
  [ "$db_name" = "lares_state" ] || die "this database cutover is defined for lares_state. Refusing the PGDATABASE override '$db_name'." "$EX_REFUSED"
  [ ! -f "$marker" ] || { say "database roles and template — already prepared by this installer."; return; }
  [ -d "$db_data" ] && [ -n "$(ls -A "$db_data" 2>/dev/null)" ] \
    && die "the Postgres data directory is not empty but this installer has no completed database-bootstrap record. Inspect it; it will not be adopted." "$EX_REFUSED"
  [ ! -e "$final_file" ] || die "a normal stack file already exists without a completed database bootstrap. Inspect the installation before retrying." "$EX_REFUSED"

  mkdir -p "$(dirname "$compose_file")" "$(dirname "$db_data")"
  rm -f "$tmp"
  if ! engine_run --rw "$(dirname "$compose_file")" --ro "$RELEASE_FILE" --ro "${PREFIX:-/}/var/lib/lares-maintenance" bin/render-database-bootstrap.ts \
      "$RELEASE_FILE" "$tmp" "$OPERATOR_PASSWORD_FILE" "$db_data" "$LARES_NETWORK" "$LARES_SUBNET" "$database_auth_dir" "${PREFIX:-/}"; then
    rm -f "$tmp"
    die "the database-only bootstrap file could not be rendered." "$EX_REFUSED"
  fi
  chmod 0600 "$tmp"
  mv "$tmp" "$compose_file"
  docker compose -f "$compose_file" up -d db || die "the database-only bootstrap service did not start." "$EX_REFUSED"
  until docker compose -f "$compose_file" exec -T db pg_isready -U lares_operator -d postgres >/dev/null 2>&1; do
    tries=$((tries + 1)); [ "$tries" -lt 30 ] || die "the temporary database bootstrap did not become ready." "$EX_TEMPFAIL"; sleep 1
  done
  old_container=$(docker compose -f "$compose_file" ps -q db 2>/dev/null) || old_container=""
  [ -n "$old_container" ] || die "the bootstrap database container has no identity to verify." "$EX_REFUSED"

  engine_run --ro "$OPERATOR_PASSWORD_FILE" \
    --ro "$SECRETS_DIR/database-password" --ro "$SECRETS_DIR/financial-database-password" \
    --ro "$SECRETS_DIR/workflow-provisioner-password" --ro "$SECRETS_DIR/workflow-password" \
    --ro "$SECRETS_DIR/gateway-database-password" \
    --env "PGHOST=$db_host" --env "PGPORT=$db_port" \
    bin/database-setup.ts \
    --operator-password-file "$OPERATOR_PASSWORD_FILE" \
    --app-password-file "$SECRETS_DIR/database-password" \
    --financial-password-file "$SECRETS_DIR/financial-database-password" \
    --workflow-provisioner-password-file "$SECRETS_DIR/workflow-provisioner-password" \
    --workflow-password-file "$SECRETS_DIR/workflow-password" \
    --gateway-password-file "$SECRETS_DIR/gateway-database-password" \
    || die "database roles or the initial engine baseline could not be prepared. The partial data directory is retained for inspection and will not be adopted on a rerun." "$EX_REFUSED"

  # The workflow template is initialized from the exact creative role image in the release;
  # passwords are read inside that short-lived container and never put in URL/argv/Compose.
  role_image=$(python3 - "$RELEASE_FILE" <<'PYIMAGE'
import json,re,sys
try:
 value=json.load(open(sys.argv[1]))['images']['creative']
except (OSError,ValueError,KeyError,TypeError):raise SystemExit(1)
if not re.fullmatch(r'[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}',value):raise SystemExit(1)
print(value)
PYIMAGE
  ) || die "the release does not name the creative role image by digest, so the workflow template cannot be prepared." "$EX_REFUSED"
  docker run --rm --network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    -w /app/services/creative \
    -v "$SECRETS_DIR/workflow-provisioner-password:/run/secrets/workflow-provisioner:ro" \
    -e PGPASSWORD_FILE=/run/secrets/workflow-provisioner -e PGOPTIONS='-c role=lares_workflow_owner' \
    -e "WORKFLOW_POSTGRES_URL=postgres://lares_workflow_provisioner@${db_host}:${db_port}/empty_workflow" \
    --entrypoint /bin/sh "$role_image" -ec 'PGPASSWORD="$(cat "$PGPASSWORD_FILE")"; export PGPASSWORD; exec node --input-type=module -e '\''import { Pool } from "pg"; import { setupDatabase } from "@workflow/world-postgres/cli"; const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 1 }); try { const r = await pool.query("SELECT current_user, session_user, current_database()"); if (r.rows[0]?.current_user !== "lares_workflow_owner" || r.rows[0]?.session_user !== "lares_workflow_provisioner" || r.rows[0]?.current_database !== "empty_workflow") throw new Error("workflow template authority check failed"); } finally { await pool.end(); } await setupDatabase();'\'' ' \
    || die "the pinned workflow package could not prepare its owned template migrations." "$EX_REFUSED"

  engine_run --ro "$SECRETS_DIR/workflow-provisioner-password" --ro "$SECRETS_DIR/workflow-password" \
    bin/workflow-template.ts apply --host "$db_host" --port "$db_port" \
    --provisioner-password-file "$SECRETS_DIR/workflow-provisioner-password" \
    --runtime-password-file "$SECRETS_DIR/workflow-password" \
    || die "the workflow runtime privileges did not pass their exact post-migration check." "$EX_REFUSED"

  engine_run --ro "$OPERATOR_PASSWORD_FILE" --ro "$SECRETS_DIR/workflow-password" \
    --env "PGHOST=$db_host" --env "PGPORT=$db_port" \
    bin/database-setup.ts --finalize-workflow-template \
    --operator-password-file "$OPERATOR_PASSWORD_FILE" \
    --workflow-password-file "$SECRETS_DIR/workflow-password" \
    || die "the empty workflow template did not pass its final ownership, ACL and data checks." "$EX_REFUSED"

  # The bootstrap container was created with the operator password file mounted. Remove it,
  # then prove Docker no longer has that container before the normal compose starts a new one.
  docker compose -f "$compose_file" down || die "the temporary database bootstrap container could not be removed." "$EX_REFUSED"
  docker inspect "$old_container" >/dev/null 2>&1 && die "the bootstrap database container still exists; no normal services were started." "$EX_REFUSED"
  rm -f "$compose_file"
  BOOTSTRAP_DB_CONTAINER_ID="$old_container"
  mkdir -p "$(dirname "$marker")"
  touch "$marker"
  say "database roles, engine baseline, workflow template and gateway database are prepared; the bootstrap container has been removed."
}

# --- 10. the database is verified under the offline operator, or the install stops ---------
# THE COMPOSE FILE IS WRITTEN BY run_stack, IMMEDIATELY ABOVE (lib/stack-compose.ts renders the stack). This reads the path from ONE variable and still
# refuses by name if the file is not there, because "run_stack did not finish" and "somebody
# moved the file between two runs" are both states this step must stop on rather than create a
# database for a stack that will never come up.
#
# ALREADY DONE? — A MARKER FILE, NOT A LIVE QUERY. This command exists to take a box from
# nothing to a working install once; asking the live database "do you already have this" on
# every run is `lares doctor`'s job (it re-checks the running system every time, on purpose).
# This instead remembers its OWN completed step, exactly like wizard_already_done and
# lares_secret's "already there" check above, so re-running this after any earlier failure never
# tries to CREATE a database that already exists.
#
# PASSWORD DISCIPLINE, as everywhere else in this script: the database password goes from its
# secret file into ONE environment variable, for ONE command, and is unset the moment that
# command has run — never an argument. CREATE DATABASE itself goes in on the psql call's
# STDIN, never `-c` — the same shape ops/backup-verify.sh already uses to talk to this container.
run_database() {
  local compose_file="$PREFIX/opt/lares/compose.yaml"
  local db_name="${PGDATABASE:-lares_state}"
  local db_host="${PGHOST:-127.0.0.1}" db_port="${PGPORT:-5432}"
  local code=0

  if [ ! -f "$compose_file" ]; then
    die "there is no normal stack file at $compose_file, so the schema-owner migration cannot run." "$EX_REFUSED"
  fi
  [ "$db_name" = "lares_state" ] || die "this database cutover is defined for lares_state. Refusing the PGDATABASE override '$db_name'." "$EX_REFUSED"
  engine_run --ro "$OPERATOR_PASSWORD_FILE" --env DATABASE_PASSWORD_FILE="$OPERATOR_PASSWORD_FILE" \
    --env LARES_OPERATOR_PASSWORD_FILE="$OPERATOR_PASSWORD_FILE" \
    --env PGHOST="$db_host" --env PGPORT="$db_port" --env PGDATABASE="$db_name" --env PGUSER=lares_operator \
    migrate.ts --schema-owner || code=$?
  [ "$code" -eq 0 ] || die "schema-owner migrations refused. The operator credential and database identity must be inspected before retrying." "$EX_REFUSED"
  say "the database migration runner completed under lares_schema_owner using the explicit offline operator."
}

# --- 10b. the first-agent screen's installation settings ----------------------------------
# The schema is now complete, but two deliberately fail-closed settings have no migration
# default: the gateway alias prefix and the approved number of agents. A fresh installation's
# tested path needs exactly one first agent, so initialize missing values to `lares` and 1.
# Repair runs preserve every existing value; this is an initializer, not a settings reset.
run_installation_settings() {
  local db_name="${PGDATABASE:-lares_state}" db_user="${PGUSER:-lares_app}"
  local db_host="${PGHOST:-127.0.0.1}" db_port="${PGPORT:-5432}"
  local code

  code=0
  engine_run --ro "$SECRETS_DIR" --env DATABASE_PASSWORD_FILE="$SECRETS_DIR/database-password" \
    --env PGHOST="$db_host" --env PGPORT="$db_port" --env PGDATABASE="$db_name" --env PGUSER="$db_user" \
    bin/installation-settings.ts || code=$?
  if [ "$code" -ne 0 ]; then
    die "the first-agent settings could not be initialized. Nothing else was applied." "$EX_REFUSED"
  fi
}

# --- 11. the owner becomes a real member, with a real id ---------------------------
# THE MOST DANGEROUS STEP IN THIS INSTALLER — see services/box/lib/first-owner.ts's own header:
# a wrong id here is silent and permanent. `createFirstOwner`'s id stays free text by design
# (no shape heuristics beyond "not blank"), so THIS is where a real installation's id is
# actually decided — --owner-id names it outright; without that flag it is derived from the
# answered e-mail address's own local part (lower-cased, anything outside [a-z0-9-] turned into
# a dash, runs of dashes collapsed, leading/trailing dashes trimmed). If that comes out blank,
# this REFUSES rather than invent one — the owner has to type --owner-id themselves. Either way
# the id is PRINTED before it is written, every run, so this output is the record of what was
# chosen.
derive_owner_id() {
  local email="$1" local_part
  local_part="${email%%@*}"
  printf '%s' "$local_part" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9-]/-/g' -e 's/--*/-/g' -e 's/^-*//' -e 's/-*$//'
}

run_first_owner() {
  local owner_email owner_name owner_id
  owner_email=$(read_setting LARES_OWNER_EMAIL "$INSTALL_ENV")
  owner_name=$(read_setting LARES_OWNER_NAME "$INSTALL_ENV")

  owner_id=$(read_setting LARES_OWNER_ID "$INSTALL_ENV")
  if [ -n "$owner_id" ]; then
    : # The wizard recorded the exact identity before the stack was rendered.
  elif [ "$OWNER_ID_GIVEN" -eq 1 ]; then
    if [ -z "$OWNER_ID_FLAG" ]; then
      die "--owner-id was given as an empty id. Name one, or leave the flag out to have it derived from the e-mail address. Nothing else was changed." "$EX_USAGE"
    fi
    owner_id="$OWNER_ID_FLAG"
  else
    owner_id=$(derive_owner_id "$owner_email")
    if [ -z "$owner_id" ]; then
      die "could not derive an owner id from '$owner_email' — nothing in it survives to become one. Run again with --owner-id <id> to name it yourself. Nothing else was changed." "$EX_USAGE"
    fi
  fi
  say "the owner's id will be: $owner_id"

  # THE SAME PG ENVIRONMENT run_database's migrate call is given, read the same way — see that
  # function's own comment on why each of these is what it is.
  local db_name="${PGDATABASE:-lares_state}" db_user="${PGUSER:-lares_app}"
  local db_host="${PGHOST:-127.0.0.1}" db_port="${PGPORT:-5432}"
  local code
  code=0
  engine_run --ro "$SECRETS_DIR" --env DATABASE_PASSWORD_FILE="$SECRETS_DIR/database-password" \
    --env PGHOST="$db_host" --env PGPORT="$db_port" --env PGDATABASE="$db_name" --env PGUSER="$db_user" \
    --env LARES_OWNER_ID="$owner_id" --env LARES_OWNER_EMAIL="$owner_email" --env LARES_OWNER_NAME="$owner_name" \
    bin/first-owner.ts --apply || code=$?
  if [ "$code" -ne 0 ]; then
    die "the owner could not be created. Nothing else was applied." "$EX_REFUSED"
  fi
  say "the owner ($owner_id) is a real member of this installation."
  # The keeper's one agent is bound to THIS id (see run_keeper, below). Published here rather
  # than recomputed there, so the binding cannot disagree with the row that was just written.
  OWNER_ID="$owner_id"
}

# A fresh identity register has no organisation. Enrol the one verified owner under the
# configured domain before the keeper starts. The command is transactional and refuses to
# adopt or change an existing organisation on a repair run.
run_first_organisation() {
  local db_name="${PGDATABASE:-lares_state}" db_user="${PGUSER:-lares_app}"
  local db_host="${PGHOST:-127.0.0.1}" db_port="${PGPORT:-5432}"
  local domain owner_email code=0
  domain=$(read_setting LARES_DOMAIN "$INSTALL_ENV")
  owner_email=$(read_setting LARES_OWNER_EMAIL "$INSTALL_ENV")
  engine_run --ro "$SECRETS_DIR" --env DATABASE_PASSWORD_FILE="$SECRETS_DIR/database-password" \
    --env PGHOST="$db_host" --env PGPORT="$db_port" --env PGDATABASE="$db_name" --env PGUSER="$db_user" \
    --env LARES_OWNER_ID="$OWNER_ID" --env LARES_OWNER_EMAIL="$owner_email" --env LARES_DOMAIN="$domain" \
    bin/first-organisation.ts || code=$?
  if [ "$code" -ne 0 ]; then
    die "the first organisation could not be enrolled. The keeper was not started; review the existing membership before retrying." "$EX_REFUSED"
  fi
}

# Managed stores are provisioned only after current owner/org enrollment. Recovery programs
# are refreshed first; incomplete storage stops installation before the keeper can start.
run_vault_storage() {
  local prefix="${PREFIX%/}" install_dir="$PREFIX/srv/lares/installation" plan verified roots
  local db_name="${PGDATABASE:-lares_state}" db_user="${PGUSER:-lares_app}"
  local -a envs=(--env "DATABASE_PASSWORD_FILE=$SECRETS_DIR/database-password" --env "PGHOST=${PGHOST:-127.0.0.1}" --env "PGPORT=${PGPORT:-5432}" --env "PGDATABASE=$db_name" --env "PGUSER=$db_user")
  if [ "$DRY" = 1 ]; then say 'would refresh recovery tooling, validate the current owner and initialize explicit private/shared stores; runtime Vault tools remain disabled';return 0;fi
  roots=$(python3 - "$PREFIX" <<'PYVAULT'
import json,os,stat,sys
prefix=sys.argv[1].rstrip('/')
for logical in ['/srv/vault','/var/lib/lares-vault-git','/srv/lares/installation']:
 path=prefix+logical
 while path and path!='/':
  if os.path.lexists(path) and stat.S_ISLNK(os.lstat(path).st_mode):raise SystemExit('vault storage: symbolic-link storage path refused')
  if prefix and path==prefix:break
  path=os.path.dirname(path)
file=prefix+'/etc/lares/keeper.json';roots=[]
if os.path.exists(file):
 try:value=json.load(open(file)).get('lifecycle',{})
 except (ValueError,AttributeError):raise SystemExit('vault storage: keeper configuration is not valid JSON; no store was initialized')
 for group in ['bindings','defaultBindings']:
  for binding in value.get(group,{}).values():
   roots.extend(m['source'] for m in binding.get('mounts',[]))
for root in roots:
 for managed in [prefix+'/srv/vault',prefix+'/var/lib/lares-vault-git']:
  if root==managed or root.startswith(managed+'/') or managed.startswith(root.rstrip('/')+'/'):raise SystemExit('vault storage: legacy runtime mount overlaps new guarded storage')
print(json.dumps(roots))
PYVAULT
  ) || die 'Vault storage paths conflict with existing data or legacy mounts; nothing was initialized.' "$EX_REFUSED"
  local -a preview_mounts=(--runtime-user --ro "$SECRETS_DIR" --env "LARES_VAULT_LEGACY_ROOTS=$roots")
  [ ! -d "$install_dir" ] || preview_mounts+=(--ro "$install_dir")
  [ ! -e "$PREFIX/srv/vault" ] || preview_mounts+=(--ro "$PREFIX/srv/vault")
  [ ! -e "$PREFIX/var/lib/lares-vault-git" ] || preview_mounts+=(--ro "$PREFIX/var/lib/lares-vault-git")
  plan=$(engine_run "${preview_mounts[@]}" "${envs[@]}" bin/vault-storage.ts preview --prefix "$prefix" --owner "$OWNER_ID") || die 'Vault storage preview refused; review the existing owner, paths and pending plan.' "$EX_REFUSED"
  LARES_ENGINE_IMAGE="$ENGINE_IMAGE" bash "$HERE/refresh-recovery.sh" --prefix "$PREFIX" || die 'Recovery tooling could not be refreshed; no new Vault store was initialized.' "$EX_REFUSED"
  . "$HERE/vault-storage.sh"
  vault_storage_prepare "$PREFIX" "$plan" || die 'Vault storage preparation refused; retain the pending plan and retry after reviewing it.' "$EX_REFUSED"
  local -a apply_mounts=(--runtime-user --ro "$SECRETS_DIR" --ro "$install_dir" --env "LARES_VAULT_LEGACY_ROOTS=$roots")
  local path
  while IFS= read -r path; do [ -z "$path" ] || apply_mounts+=(--rw "$path");done < <(python3 - "$prefix" "$plan" <<'PYVAULT'
import json,sys
prefix=sys.argv[1];inv=json.loads(sys.argv[2])
for a in inv['areas']:print(prefix+'/srv/'+a['relativePath']);print(prefix+a['origin'])
PYVAULT
  )
  for path in backup.sh export.sh restore.sh backup-verify.sh restore-drill.sh setup-backups.sh vault-storage.sh engine-run.sh refresh-recovery.sh vault-recovery.json vault-recovery-engine-image;do apply_mounts+=(--ro "$PREFIX/opt/lares/$path");done
  for path in lares-backup.service lares-backup.timer lares-backup-verify.service lares-backup-verify.timer lares-restore-drill.service lares-restore-drill.timer;do apply_mounts+=(--ro "$PREFIX/etc/systemd/system/$path");done
  engine_run "${apply_mounts[@]}" "${envs[@]}" bin/vault-storage.ts apply --prefix "$prefix" --owner "$OWNER_ID" >/dev/null || die 'Vault initialization did not complete; its exact pending plan is retained and the keeper was not started.' "$EX_REFUSED"
  verified=$(engine_run "${apply_mounts[@]}" "${envs[@]}" bin/vault-storage.ts verify-plan --prefix "$prefix") || die 'Vault verification failed; the pending plan remains incomplete and the keeper was not started.' "$EX_REFUSED"
  vault_storage_publish "$PREFIX" "$verified" || die 'Vault inventory publication failed; retry the same plan before starting the keeper.' "$EX_REFUSED"
  say 'private/shared Vault repositories verified; runtime tools and mounts remain disabled. Taste is unchanged.'
}

# --- 12. the keeper is configured and started, from the same release ---------------
# WHAT THIS STEP IS. The keeper is the only thing in the fleet allowed to start, stop or
# reconfigure an agent. It boots from ONE file, $PREFIX/etc/lares/keeper.json, whose shape is
# services/keeper/lib/config.ts's own schema — a strict object that refuses anything it does not
# recognise, and whose refusal is silent to the owner ("keeper: invalid or unreadable
# configuration"). That file is rendered by lib/keeper-config.ts, from the same release file the
# stack came up from, so the keeper's own image, its egress proxy's, its firewall helper's and
# all three role images are the SAME digests this installation is running.
#
# IT RUNS AFTER run_first_owner, AND THE ORDER IS LOAD-BEARING. The configuration defines one
# role the owner chooses for their first agent, and binds it to the owner's id — the id
# run_first_owner derives, prints and writes into the identity register. Rendered before that,
# the role defaults would name nobody.
# $OWNER_ID below is what makes that a refusal rather than a silent mistake, and
# tests/install-keeper.test.ts pins the order against the stub log rather than against this
# comment.
#
# THE NETWORK IS THE ONE THE STACK ALREADY CREATED. compose.lares-keeper.yaml joins
# $LARES_NETWORK as `external: true`, and run_stack's rendered compose file gives that network
# its own `name:` — so the network Compose created is literally this string, and this step
# neither creates a second one nor needs to.
OWNER_ID=""
LARES_PROJECT="${LARES_PROJECT:-lares}"
# Reserve the high end of the default /24 for the static proxy. Docker assigns
# the stack's ordinary services from the low end; .2 is already the fresh DB.
LARES_PROXY_ADDRESS="${LARES_PROXY_ADDRESS:-172.30.0.254}"

run_keeper() {
  # THE KEEPER-OWNED ROOT. compose.lares-keeper.yaml mounts this one directory into the keeper
  # container at the SAME absolute path and nothing else of this host, so everything the keeper
  # itself writes — the agents' definitions, retired folders, its backup checkout, the egress
  # staging files and the agents' own compose file — lives under it.
  local root="$PREFIX/srv/lares"
  local managed_secrets_dir="$root/secrets"
  local agents_dir="$root/agents" retired_dir="$root/retired"
  local backup_dir="$root/backup" egress_dir="$root/egress"
  local socket_dir="$PREFIX/run/lares" host_socket_dir="$PREFIX/run/lares-host"
  local keeper_config="$PREFIX/etc/lares/keeper.json"
  local keeper_env="$PREFIX/etc/lares/keeper.env"
  local keeper_compose="$PREFIX/opt/lares/compose.lares-keeper.yaml"
  local keeper_vault_compose="$PREFIX/opt/lares/compose.lares-keeper-vault.yaml"
  local vault_ready=""
  local vault_mounts=""
  local -a compose_cmd
  local db_name="${PGDATABASE:-lares_state}" db_user="${PGUSER:-lares_app}"
  local gateway_url tmp env_tmp before_sum="" after_sum="" keeper_running=""

  [ -n "$OWNER_ID" ] || die "the keeper cannot be configured before the owner exists: every first-agent role default is bound to the owner's id, and nothing has set one. Fix: in the dispatch block at the foot of this script, run_keeper goes after run_first_owner. Nothing has been brought up, and nothing already written has been changed." "$EX_REFUSED"

  gateway_url=$(read_setting GATEWAY_URL "$INSTALL_ENV")
  [ -n "$gateway_url" ] || die "the gateway address is not written down in $INSTALL_ENV, so the keeper cannot be told where the agents reach their model. Nothing has been brought up." "$EX_REFUSED"

  # THE KEEPER'S COMPOSE FILE IS COMMITTED, NOT GENERATED (services/box/compose.lares-keeper.yaml
  # — the same shape as ops/Caddyfile in run_stack above): every value it needs comes in through
  # the env file rendered below, so there is nothing to render in the file itself. Something has
  # to put it where this brings it up from, and that is all this is.
  [ -r "$BOX_DIR/compose.lares-keeper.yaml" ] || die "the keeper's own compose file is missing ($BOX_DIR/compose.lares-keeper.yaml), so there is nothing to bring the keeper up from. Nothing has been brought up, and nothing already written has been changed." "$EX_REFUSED"

  do_or_say mkdir -p "$root" "$agents_dir" "$retired_dir" "$backup_dir" "$egress_dir" \
    "$socket_dir" "$host_socket_dir" "$(dirname "$keeper_config")" "$(dirname "$keeper_compose")"

  # The proxy starts with the keeper, before the first agent exists. Its regular
  # per-agent seal is written by keeper on agent creation, so give this empty
  # installation a deny-all bootstrap config. Never replace a keeper-owned seal.
  [ ! -L "$egress_dir/squid.conf" ] || die "$egress_dir/squid.conf is a symbolic link; refusing to replace the proxy configuration." "$EX_REFUSED"
  if [ ! -e "$egress_dir/squid.conf" ]; then
    printf 'http_port 8888\nhttp_access deny all\n' > "$egress_dir/squid.conf.partial"
    do_or_say chmod 0644 "$egress_dir/squid.conf.partial"
    do_or_say mv "$egress_dir/squid.conf.partial" "$egress_dir/squid.conf"
    say "installed a deny-all proxy configuration until the first agent is created."
  fi

  # Runtime-control, door and per-agent gateway secrets are keeper-owned output, not installer
  # inputs. They live below the keeper's writable same-path root. The installer secret directory
  # remains mounted read-only and supplies only shared platform inputs such as the database and
  # route passwords. Refuse a link before creating the directory: a secret root must never be a
  # redirect to somewhere outside the installation.
  [ ! -L "$managed_secrets_dir" ] || die "$managed_secrets_dir is a symbolic link, so it cannot be used as the keeper's secret root. Nothing already written has been changed." "$EX_REFUSED"
  if [ ! -d "$managed_secrets_dir" ]; then
    do_or_say mkdir -p "$managed_secrets_dir"
    do_or_say chmod 0700 "$managed_secrets_dir"
    do_or_say chown 0:0 "$managed_secrets_dir"
  fi

  # Rendered to neighbouring names and moved into place, the same discipline every other file
  # this script writes gets: an interrupted run leaves a .partial the next run overwrites, never
  # a half-written configuration the keeper would boot from.
  tmp="$keeper_config.partial"
  env_tmp="$keeper_env.partial"
  rm -f "$tmp" "$env_tmp"
  [ ! -f "$keeper_config" ] || before_sum=$(sha256_of "$keeper_config")
  # The renderer reads the release file, the keeper.json already on this box and the installation's
  # deadline calendar, and writes its two outputs next to keeper.json. All of that lives under two
  # directories; the secrets folder is not needed (the renderer is only told its path).
  # The one-shot renderer validates the completed normal receipt before reading keeper.json.
  # Give that renderer a read-only view of the maintenance root; the long-running Keeper gets
  # only the exact admission child through its own Compose bind.
  local -a keeper_mounts=(--rw "$(dirname "$keeper_config")" --ro "$RELEASE_FILE" --ro "$PREFIX/var/lib/lares-maintenance")
  [ ! -d "$root/installation" ] || keeper_mounts+=(--ro "$root/installation")
  if ! engine_run "${keeper_mounts[@]}" bin/render-keeper-config.ts \
      "$RELEASE_FILE" "$tmp" "$env_tmp" "$keeper_config" \
      "$LARES_PROJECT" "$root" "$agents_dir" "$retired_dir" "$backup_dir" "$egress_dir" \
      "$SECRETS_DIR" "$socket_dir" "$host_socket_dir" \
      "$LARES_NETWORK" "$LARES_SUBNET" "$LARES_PROXY_ADDRESS" "$gateway_url" \
      "$db_name" "$OWNER_ID" "$(read_setting LARES_OWNER_EMAIL "$INSTALL_ENV")" \
      "$(read_setting LARES_DOMAIN "$INSTALL_ENV")" "$(read_setting OWNER_HOME_TZ "$INSTALL_ENV")" "${PREFIX:-/}"; then
    rm -f "$tmp" "$env_tmp"
    die "the keeper's configuration could not be rendered from '$RELEASE_FILE' and the keeper.json already on this box (the reason is printed above; $keeper_config itself is untouched). The keeper has not been configured or started, and everything written before this — every secret, $INSTALL_ENV, the stack and its containers, the database, the owner — is left exactly as it is." "$EX_REFUSED"
  fi
  if [ ! -s "$tmp" ]; then
    rm -f "$tmp" "$env_tmp"
    die "rendering the keeper's configuration from '$RELEASE_FILE' produced nothing, so $keeper_config has not been written. The keeper has not been started, and everything written before this is left exactly as it is." "$EX_REFUSED"
  fi
  # 0600, set HERE as well as by the program that wrote it: `umask 077` at the top of this file
  # already makes it root-only, and this says so on purpose rather than by accident. keeper.json
  # names every path this installation keeps a secret at, and the one process that reads it is
  # the keeper container, which compose.lares-keeper.yaml runs as `user: '0:0'`.
  do_or_say chmod 0600 "$tmp"
  do_or_say mv "$tmp" "$keeper_config"
  # 0640 for the env file: `docker compose` reads it on this host, as root, and it holds only
  # image digests and paths — no secret value, here or anywhere else in this script.
  do_or_say chmod 0640 "$env_tmp"
  do_or_say mv "$env_tmp" "$keeper_env"
  say "wrote $keeper_config — any first-agent role is bound to $OWNER_ID."
  [ "$DRY" -eq 1 ] || after_sum=$(sha256_of "$keeper_config")

  do_or_say cp "$BOX_DIR/compose.lares-keeper.yaml" "$keeper_compose"
  do_or_say chmod 0640 "$keeper_compose"

  # A separate exact-path overlay gives Keeper access only to the already prepared managed
  # roots. Validate the published inventory and every canonical directory before activating it.
  # Missing custody disables Vault mounts while leaving ordinary Keeper startup available.
  # If an older exact overlay exists but its inventory is unreadable, preserve that evidence
  # and its mounts while Keeper's broker independently refuses Vault requests.
  if [ "$DRY" -eq 0 ]; then
    vault_ready=$(python3 "$BOX_DIR/ops/keeper-vault-roots.py" validate "$PREFIX" 2>/dev/null) || vault_ready=""
  fi
  if [ "$vault_ready" = ready ] && [ -r "$BOX_DIR/compose.lares-keeper-vault.yaml" ]; then
    do_or_say cp "$BOX_DIR/compose.lares-keeper-vault.yaml" "$keeper_vault_compose"
    do_or_say chmod 0640 "$keeper_vault_compose"
    vault_mounts=ready
  elif [ -f "$keeper_vault_compose" ] && [ -r "$BOX_DIR/compose.lares-keeper-vault.yaml" ] && cmp -s "$keeper_vault_compose" "$BOX_DIR/compose.lares-keeper-vault.yaml"; then
    # Keep a previously prepared exact overlay mounted if its inventory is temporarily
    # unreadable. The broker validates the inventory on every request and refuses Vault reads;
    # preserving these mounts avoids silently changing custody evidence during recovery.
    if python3 "$BOX_DIR/ops/keeper-vault-roots.py" roots "$PREFIX" >/dev/null 2>&1; then vault_mounts=preserved; fi
  fi
  if [ -n "$vault_mounts" ]; then
    # Persist only the two canonical host paths, so a later compose recreate using keeper.env
    # can retain the optional exact overlay. No secret value is added.
    if [ "$DRY" -eq 0 ]; then
      do_or_say cp "$keeper_env" "$keeper_env.partial"
      printf 'LARES_VAULT_WORKING_ROOT="%s/srv/vault"\nLARES_VAULT_BARE_ROOT="%s/var/lib/lares-vault-git"\n' "$PREFIX" "$PREFIX" >> "$keeper_env.partial"
      printf 'COMPOSE_FILE="%s:%s"\n' "$keeper_compose" "$keeper_vault_compose" >> "$keeper_env.partial"
      do_or_say chmod 0640 "$keeper_env.partial"
      do_or_say mv "$keeper_env.partial" "$keeper_env"
      compose_cmd=(env -u COMPOSE_FILE docker compose --env-file "$keeper_env")
    else
      compose_cmd=(docker compose --env-file "$keeper_env" -f "$keeper_compose" -f "$keeper_vault_compose")
    fi
  else
    if [ "$DRY" -eq 0 ]; then
      do_or_say cp "$keeper_env" "$keeper_env.partial"
      printf 'COMPOSE_FILE="%s"\n' "$keeper_compose" >> "$keeper_env.partial"
      do_or_say chmod 0640 "$keeper_env.partial"
      do_or_say mv "$keeper_env.partial" "$keeper_env"
      compose_cmd=(env -u COMPOSE_FILE docker compose --env-file "$keeper_env")
    else
      compose_cmd=(docker compose --env-file "$keeper_env" -f "$keeper_compose")
    fi
  fi

  # The keeper reads keeper.json only when it starts, so a keeper that is already running keeps
  # its old settings until it is recreated. Recreate it only when this run changed the file;
  # an unchanged file leaves a healthy keeper alone.
  if [ "$DRY" -eq 0 ] && [ -n "$before_sum" ] && [ "$before_sum" != "$after_sum" ]; then
    keeper_running=$("${compose_cmd[@]}" ps -q lares-keeper 2>/dev/null || true)
  fi
  if [ -n "$keeper_running" ]; then
    say "keeper.json changed and the keeper is running, so it is being restarted to read it."
    if ! "${compose_cmd[@]}" up -d --force-recreate lares-keeper; then
      die "the keeper could not be restarted with its new settings (docker's own message is above). $keeper_config has been updated and everything else is left exactly as it is; fix what it named, then run this again." "$EX_REFUSED"
    fi
  fi
  if ! do_or_say "${compose_cmd[@]}" up -d; then
    die "the keeper did not come up (docker's own message is above). Everything generated so far — every secret, $INSTALL_ENV, the stack, the database, the owner and $keeper_config — is left exactly as it is; fix what it named, then run this again." "$EX_REFUSED"
  fi
  say "the keeper is up, and this installation's first-agent role defaults are bound to $OWNER_ID."
}

# --- 13. finish honestly at the console, before any agent exists -----------------
# The keeper configuration above carries first-agent role bindings, but it does not create or
# reconcile that agent's definition/runtime, and no per-agent LiteLLM virtual key has been minted.
# `/chat` therefore has no registered agent to show. The one honest address to print is the
# console's existing first-agent setup page. A later launch gate owns creation, key registration,
# agent health and the first proved web-chat turn; this installer claims none of them.
run_finish() {
  local domain compose_file oauth_file tries=0
  domain=$(read_setting LARES_DOMAIN "$INSTALL_ENV")
  [ -n "$domain" ] || die "the domain is not written down in $INSTALL_ENV, so the console cannot be checked. The installation is left exactly as it is." "$EX_REFUSED"
  compose_file="$PREFIX/opt/lares/compose.yaml"
  oauth_file="$PREFIX/etc/lares/console-oauth.env"

  until curl -fsS --max-time 5 "https://$domain/api/auth/login" >/dev/null 2>&1; do
    if [ ! -f "$oauth_file" ] || \
       ! grep -Eq '^GOOGLE_CLIENT_ID_CONSOLE=.+$' "$oauth_file" || \
       ! grep -Eq '^GOOGLE_CLIENT_SECRET_CONSOLE=.+$' "$oauth_file"; then
      die "the console cannot offer Google sign-in yet. Save GOOGLE_CLIENT_ID_CONSOLE and GOOGLE_CLIENT_SECRET_CONSOLE in $oauth_file (root-owned, mode 0600), then run this installer again. Everything installed so far is preserved." "$EX_REFUSED"
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      die "the console did not come up at the public address. The installation is left exactly as it is. Inspect it with docker compose logs: docker compose -f $compose_file logs --tail 200 console caddy" "$EX_TEMPFAIL"
    fi
    sleep 2
  done

  if [ "$REPAIR_MODE" -eq 1 ]; then
    say "the installer is finished (this was a re-run on an existing installation, or the step after a restore). This run did not create, start or prove an agent conversation."
    say "Open the console:"
    say "https://$domain/"
  else
    say "infrastructure and Console are ready. No agent is running, and no conversation has been tested."
    say "Sign in to Console to confirm this host and finish the explicit model budget setup before creating an agent:"
    say "https://$domain/sign-in"
    say 'Backups are not switched on yet. Do not rely on this installation for data you need to keep: run lares backups to switch them on and prove them once.'
    say "No chat app is connected yet; after the first agent is running, web chat is the first door and Slack or Telegram can be connected later."
  fi
}

if [ "$DRY_RUN" -eq 1 ]; then
  say "the four questions (domain, e-mail, name, model key) would be asked next, and the answers written to $INSTALL_ENV and $SECRETS_DIR/model-provider-key."
  say "then the release given with --release would be rendered, the database prepared and verified offline, and Console and Caddy started. The owner would sign in to confirm this host and finish explicit model budget setup before creating an agent. No model call or conversation would be tested. A real run needs --release <file>; a dry run asks nothing and writes nothing."
else
  # Preserve the offline database boundary before starting the owner-facing services. Owner,
  # organisation and keeper setup complete before the truthful infrastructure-ready handoff.
  run_wizard        # the four questions ONLY — no outside call
  run_database_bootstrap
  run_stack
  run_database
  run_online_stack
  run_installation_settings
  run_first_owner
  run_first_organisation
  run_vault_storage
  run_keeper
  run_finish
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "this was a dry run. Nothing has been changed."
  exit "$EX_OK"
fi

exit "$EX_OK"
