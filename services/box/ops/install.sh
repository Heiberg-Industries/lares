#!/usr/bin/env bash
# install.sh — the tested install path (begun by W8C-s1's preflight; completed by W8C-s9 —
# docs/decisions/0022-the-tested-install-path.md: a fresh Ubuntu server, one command,
# "tested path" never "supported"). It checks this box, prints every preflight problem
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
# OWNER DECISION C7 (a starting point, not a measurement): the memory and disk floors
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
#   5. a secret is written only under the secrets directory ($SECRETS_DIR), through lares_secret
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

say() { printf 'install: %s\n' "$1"; }
die() { printf 'install: %s\n' "$1" >&2; exit "$2"; }

usage() {
  cat <<'EOF' >&2
Usage: install.sh [--dry-run] [--yes] [--restore <archive>] [--release <file>] [--prefix <dir>]
                   [--domain <domain>] [--email <address>] [--name <name>]
                   [--model-key-file <path>] [--owner-id <id>]

Checks this box against the tested install path
(docs/decisions/0022-the-tested-install-path.md) and refuses, in one pass, before
writing anything, if something here is wrong. Fix what it prints and run it again.

  --dry-run            say what this would do, and change nothing
  --yes                do not ask for confirmation (for an unattended run)
  --restore <archive>  restore this installation from a backup instead of starting fresh
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
DRY="$DRY_RUN"

# Every later slice's write goes through this — unused today (this slice writes
# nothing at all), kept here so the next slice has exactly one place to plug into.
do_or_say() {
  if [ "$DRY" -eq 1 ]; then
    say "would run: $*"
  else
    "$@"
  fi
}

# The box's doctor (W8A-s7 built `--test-model`). A `lares-doctor` on PATH wins — that is how an
# installation that ships the command uses it, and how a test puts a stub ahead of it; with none,
# this falls back to the repository's own script, which is what a run from a checkout has. Without
# the fallback every real install would refuse at the model check with "command not found".
lares_doctor() {
  if command -v lares-doctor >/dev/null 2>&1; then
    lares-doctor "$@"
  else
    pnpm -C "$BOX_DIR" run doctor -- "$@"
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

# --- screen one: start fresh, or restore from a backup? (owner decision C3) -----------------
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

# verify_restore_archive <path> — the whole of "restore from a backup" in this slice. Exits
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
  say "restoring from a backup is guided, not automatic (owner decision C3): follow docs/runbooks/export-and-teardown.md, section 5, on the server you are restoring TO, in this order:"
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

# --- 2. memory (owner decision C7) -----------------------------------------------------
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

# --- 3. free disk (owner decision C7) ---------------------------------------------------
LARES_MIN_DISK_MB="${LARES_MIN_DISK_MB:-20480}"
AVAIL_KB=$(df -Pk "$PREFIX" 2>/dev/null | tail -1 | awk '{ print $4 }') || AVAIL_KB=""
case "$AVAIL_KB" in
  ''|*[!0-9]*)
    problem "could not read how much disk is free under $PREFIX (df -Pk gave no usable answer)." \
      "check that $PREFIX exists and that 'df' works there, then run this again."
    ;;
  *)
    AVAIL_MB=$(( AVAIL_KB / 1024 ))
    if [ "$AVAIL_MB" -lt "$LARES_MIN_DISK_MB" ]; then
      problem "only ${AVAIL_MB} MB free under $PREFIX; the tested install path asks for at least ${LARES_MIN_DISK_MB} MB free ($(( LARES_MIN_DISK_MB / 1024 )) GiB)." \
        "free up space under $PREFIX, or rent a box with a bigger disk, then run this again."
    fi
    ;;
esac

# --- 4. Docker ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  problem "docker is not installed." \
    "install it from your distribution's own packages (on Ubuntu: apt-get install -y docker.io docker-compose-plugin), then run this again."
elif ! docker compose version >/dev/null 2>&1; then
  problem "'docker compose' is not available (docker is installed, but the compose plugin is not)." \
    "install the compose plugin (apt-get install -y docker-compose-plugin), then run this again."
fi

# --- 5. ports 80 and 443 ------------------------------------------------------------------
SS_OUT=$(ss -ltn 2>/dev/null) || SS_OUT=""
BLOCKED=$(printf '%s\n' "$SS_OUT" | awk '{ print $4 }' | grep -E ':(80|443)$' | tr '\n' ' ') || BLOCKED=""
if [ -n "$BLOCKED" ]; then
  problem "something is already listening on: ${BLOCKED% }. Caddy needs 80 and 443 free to answer https and fetch a certificate." \
    "stop whatever is using ${BLOCKED% } (as root, 'ss -ltnp' names it), or move it elsewhere, then run this again."
fi

# --- 6. an existing installation ----------------------------------------------------------
# Found, not fixed: a partial install is reported as what it is, never silently repaired
# by this slice.
REPAIR_MODE=0
if [ -d "$PREFIX/srv/lares" ]; then
  REPAIR_MODE=1
fi

# Screen one only makes sense on a genuinely fresh box: an existing installation is repaired,
# never asked whether to "start fresh" (that would mean wiping it) or to restore over itself.
# RESTORE_ARCHIVE is always empty here — an explicit --restore already exited above.
if [ "$REPAIR_MODE" -eq 0 ]; then
  say "this box has nothing here yet. Lares can start fresh, or check a backup archive first (docs/runbooks/export-and-teardown.md) so you can restore it by hand."
  say "  1) start fresh (the default)"
  say "  2) check a backup archive — or pass --restore <archive> next time to skip this question"
  if [ "$ASSUME_YES" != "1" ]; then
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
  say "found an existing installation under $PREFIX/srv/lares — this would repair it, not start over."
else
  say "found no existing installation under $PREFIX/srv/lares — this would start a fresh install."
fi

# --- 6b. the release this install is for (W8F-F7a) ------------------------------------------
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
  # The renderers run through `pnpm -C "$BOX_DIR"`, which changes their working directory.
  # Anchor a caller-relative release path now, while it still names the file we checked.
  case "$RELEASE_FILE" in
    /*) ;;
    *) RELEASE_FILE="$PWD/$RELEASE_FILE" ;;
  esac
fi

# --- 7. the installation's own credentials (W8C-s2) -----------------------------------------
# OWNER DECISION A1: a secret is a FILE under /etc/lares/secrets/, root:lares 0440, mounted
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
# OWNERSHIP IS NUMERIC, NOT A NAMED GROUP (controller ruling W8C-s2b/a). Every runtime image
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
#   begin "sk-" (docs/research/2026-09-18-prelaunch/08-litellm-okf.md).
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

say "secrets (files under $SECRETS_DIR, owner 0:$LARES_RUNTIME_GID 0440 — owner decision A1: never an environment value, never shown back):"
# The model PROVIDER key is NOT in this list. It is not ours to invent: it is asked for in a
# later slice and written straight to etc/lares/secrets/model-provider-key from the answer. A
# generated placeholder here would look exactly like a real key to every check after it.
lares_secret console-session-secret 32 base64url  # writes $SECRETS_DIR/console-session-secret
lares_secret database-password      32 base64url  # writes $SECRETS_DIR/database-password
lares_secret eve-route-password     32 base64url  # writes $SECRETS_DIR/eve-route-password
lares_secret gateway-key            32 base64url "sk-"  # writes $SECRETS_DIR/gateway-key
# gateway-master-key. CORRECTED W8F-F7a: the comment that stood here said "the engine itself
# ships no gateway … so no engine code reads this file back", and BOTH halves have since become
# false. The engine now renders the gateway service itself (lib/stack-compose.ts) and its
# LiteLLM configuration (lib/gateway-config.ts), and images/gateway-runtime/start.sh reads THIS
# file back as GATEWAY_MASTER_KEY_FILE and exports its contents as the value LiteLLM's
# general_settings.master_key resolves. It is also the credential run_model_check presents
# below — see that function for why it, and not the model provider's own key.
lares_secret gateway-master-key     32 base64url "sk-"  # writes $SECRETS_DIR/gateway-master-key
lares_secret token-enc-key          32 hex  # writes $SECRETS_DIR/token-enc-key

# --- 8. four questions, asked once (W8C-s4, owner decision C4) -----------------------------
# FOUR THINGS ONLY: the domain, the e-mail address, the name, and a model provider key.
# Everything else — the time zone, the gateway address, the model alias, Slack, Telegram,
# Notion, backup — is either read from this machine or moved into the console, after the first
# conversation (owner decision C4). Answers are written ONCE to $INSTALL_ENV; a re-run reads
# them back (wizard_already_done, below) and never asks again, and never silently overwrites an
# answer that is already there — the plan names no "change one answer" flag for this slice, so
# none exists yet; changing a written answer today means editing the file by hand.
#
# THE MODEL KEY IS A SECRET, handled exactly like every other one above (owner decision A1,
# extended by owner decision C6 to the model provider's own key): it goes straight into its own
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
# parses it with sed — never the shell's own word-splitting or expansion. Any later slice that
# wants a value out of this file should do the same, for the same reason: env_line() quotes a
# value the moment it holds anything outside a safe, plain character set, so a value that round
# trips through read_setting() is exactly the value that was typed, and a value that is merely
# grepped out of the file (its own header says how) never needs unquoting at all unless it looks
# quoted to begin with.
INSTALL_ENV="$PREFIX/etc/lares/installation.env"
# The gateway is the owner's own stack (owner decision C1 — not shipped by this engine), reached
# on the fleet's own docker network under this compose service name, never the public internet.
# It is written plainly, as one address: the contract test's host rule names it as a fleet-internal
# service and says why, which is the honest way past that rule — splitting the string so the rule
# cannot see it would leave the next reader with a puzzle and the rule with a hole.
GATEWAY_URL_DEFAULT="http://lares-gateway:4000"
LARES_MODEL_ALIAS_DEFAULT="lares-brain"
# The owner's ruling of 2026-09-21: a fresh install's default model is Opus. Not a guess, not a
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
  case "$v" in *[[:space:]]*) return 1 ;; esac
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

# check_domain_dns <domain> (owner decision C5) — refuses, before anything is written, unless
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
  do_or_say mkdir -p "$(dirname "$INSTALL_ENV")"
  rm -f "$tmp"
  {
    printf '%s\n' "# Written once by install.sh's four questions (owner decision C4)."
    printf '%s\n' "# Read this with read_setting() in that script, or with plain sed/grep —"
    printf '%s\n' "# never source or eval it: a name or an address typed here is data, not code."
    env_line LARES_DOMAIN "$LARES_DOMAIN"
    env_line LARES_OWNER_EMAIL "$LARES_OWNER_EMAIL"
    env_line LARES_OWNER_NAME "$LARES_OWNER_NAME"
    env_line OWNER_HOME_TZ "$OWNER_HOME_TZ"
    printf '%s\n' "# CONSOLE_ALLOWED_EMAILS is comma-separated; add more addresses by editing"
    printf '%s\n' "# this file and restarting the console — Lares never assumes there is only"
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

# capture_model_key (owner decisions A1, C6) — the model PROVIDER key, read once and written
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
      die "the file given with --model-key-file does not hold a usable key: it must be one line, non-empty, with no spaces or tabs inside it." "$EX_USAGE"
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
      say "that does not look like a key: it must be one line, non-empty, with no spaces or tabs inside it. Try again."
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
    say "four questions, asked once (owner decision C4). Everything else moves into the console, after the first conversation."

    ask_and_validate "$DOMAIN_FLAG" "--domain" "what domain will people use to reach Lares (example: example.com)?" validate_domain "that does not look like a domain: no http://, no path, no port, no spaces, no leading dot (example: example.com). Try again." lower
    LARES_DOMAIN="$ANSWER"
    check_domain_dns "$LARES_DOMAIN"

    ask_and_validate "$EMAIL_FLAG" "--email" "what is your e-mail address?" validate_email "that does not look like an e-mail address: it needs exactly one @ with something on each side, and no spaces (example: you@example.com). Try again." ""
    LARES_OWNER_EMAIL="$ANSWER"

    ask_and_validate "$NAME_FLAG" "--name" "what is your name?" validate_name "that's either blank once invisible characters are removed, or over $LARES_NAME_MAX characters. Try again." strip
    LARES_OWNER_NAME="$ANSWER"

    # Time zone (owner decision C4): read from the server, never asked.
    OWNER_HOME_TZ=""
    if [ -r /etc/timezone ]; then
      OWNER_HOME_TZ=$(cat /etc/timezone 2>/dev/null | tr -d '[:space:]') || OWNER_HOME_TZ=""
    fi
    if [ -z "$OWNER_HOME_TZ" ] && command -v timedatectl >/dev/null 2>&1; then
      OWNER_HOME_TZ=$(timedatectl show -p Timezone --value 2>/dev/null) || OWNER_HOME_TZ=""
    fi

    write_installation_env
    say "wrote $INSTALL_ENV."
  fi

  capture_model_key
}

# --- 9. the stack comes up, rendered from the release this run was given (W8F-F7a) ----------
# THE FOUR QUESTIONS ARE ANSWERED AND NOTHING IS RUNNING YET. This is the step that turns a
# release file into the installation's own compose file and starts it. It has to happen before
# the model check below, because that check calls the gateway by its COMPOSE SERVICE NAME — a
# container that does not exist until this function has run.
#
# THE RENDER IS ENGINE CODE, NOT SHELL. The release rules (lib/release-manifest.ts) and the
# stack file's shape (lib/stack-compose.ts) are TypeScript, and restating either in awk would
# be two copies free to drift. `bin/render-stack.ts` is the whole seam, reached the same way
# this script already reaches `migrate` and `first-owner`: `pnpm -C "$BOX_DIR" render-stack`.
# (ops/update.sh does its own release read from a temp program under bare `node`; that cannot
# work here — see that file's own header for why.) A refusal from the release rules — a file
# that is not JSON, an image named by a tag, a service the release names no image for — is
# that program's own stderr, printed as it was written, never re-worded here.
#
# NOTHING IS PULLED BY THIS SCRIPT. `docker compose up -d` pulls what the compose file names,
# and every one of those names is a digest out of the release file (the release rules refuse
# anything else), so promise 3 in this file's header holds without this script fetching an
# image itself.
LARES_NETWORK="${LARES_NETWORK:-lares-network}"
LARES_SUBNET="${LARES_SUBNET:-172.30.0.0/24}"

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
  # The same overridable names run_database and run_first_owner read, with the same defaults.
  local db_name="${PGDATABASE:-lares_state}" db_user="${PGUSER:-lares}"
  local gateway_db_marker="$PREFIX/etc/lares/gateway-database-created"
  local domain model_alias provider_model tmp tries=0 existing

  domain=$(read_setting LARES_DOMAIN "$INSTALL_ENV")
  [ -n "$domain" ] || die "the domain is not written down in $INSTALL_ENV, so the stack cannot be rendered. Nothing has been brought up." "$EX_REFUSED"

  # F7a-2: the two values the gateway's own config is rendered from (lib/gateway-config.ts),
  # read back exactly as LARES_DOMAIN is above — never re-derived, never defaulted here.
  model_alias=$(read_setting LARES_MODEL_ALIAS "$INSTALL_ENV")
  [ -n "$model_alias" ] || die "the model alias is not written down in $INSTALL_ENV, so the gateway's configuration cannot be rendered. Nothing has been brought up." "$EX_REFUSED"
  provider_model=$(read_setting LARES_MODEL "$INSTALL_ENV")
  [ -n "$provider_model" ] || die "the model is not written down in $INSTALL_ENV, so the gateway's configuration cannot be rendered. Nothing has been brought up." "$EX_REFUSED"

  do_or_say mkdir -p "$(dirname "$compose_file")" "$(dirname "$caddyfile")" "$(dirname "$gateway_config")" "$caddy_data" "$db_data"

  # Rendered to a NEIGHBOURING name and moved into place, the same discipline every other file
  # this script writes gets: an interrupted run leaves a .partial the next run overwrites,
  # never a half-written compose file `docker compose` would read as the whole stack.
  tmp="$compose_file.partial"
  rm -f "$tmp"
  if ! pnpm -C "$BOX_DIR" render-stack \
      "$RELEASE_FILE" "$tmp" "$SECRETS_DIR" "$gateway_config" "$caddyfile" \
      "$caddy_data" "$db_data" "$LARES_NETWORK" "$LARES_SUBNET" "$domain" \
      "$db_user" "$db_name" "$model_alias" "$provider_model" "$gateway_start"; then
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
  # to render — but something has to put it where the compose file mounts it from, and until
  # this slice nothing did. That is all this is.
  [ -r "$HERE/Caddyfile" ] || die "the Caddyfile that belongs beside this script is missing ($HERE/Caddyfile), so Caddy would start with no site to serve. Nothing has been brought up." "$EX_REFUSED"
  do_or_say cp "$HERE/Caddyfile" "$caddyfile"
  do_or_say chmod 0644 "$caddyfile"
  say "installed $caddyfile (the domain reaches Caddy through the caddy service's own environment)."

  # LiteLLM's virtual keys live in a separate database (installer design, Part 1), so create it
  # before the gateway starts. Starting db alone is harmless on a re-run; the existence check
  # makes the database creation itself idempotent. The database name is an engine constant,
  # never owner input, so it is safe in the fixed SQL below. No password crosses argv or stdin:
  # psql runs inside the database container over its local socket as the POSTGRES_USER.
  if ! do_or_say docker compose -f "$compose_file" up -d db; then
    die "the database container did not come up (docker's own message is above). Everything generated so far is left exactly as it is — fix what it named, then run this again." "$EX_REFUSED"
  fi
  until docker compose -f "$compose_file" exec -T db pg_isready -U "$db_user" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
      die "the database container did not become ready, so the gateway database was not created and the gateway was not started." "$EX_TEMPFAIL"
    fi
    sleep 1
  done
  if [ -f "$gateway_db_marker" ]; then
    say "gateway database litellm — already created by this installer. Left exactly as it is."
  else
    existing=$(docker compose -f "$compose_file" exec -T db \
      psql -U "$db_user" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = 'litellm'" </dev/null 2>/dev/null \
      | tr -d '[:space:]') || existing=""
    if [ "$existing" = "1" ]; then
      say "gateway database litellm — already there (the stack created it earlier). Left exactly as it is."
    elif printf 'CREATE DATABASE litellm;\n' \
        | docker compose -f "$compose_file" exec -T db psql -U "$db_user" -d postgres
    then
      say "gateway database litellm — created."
    else
      die "could not create the gateway database litellm, so the gateway was not started." "$EX_REFUSED"
    fi
    do_or_say mkdir -p "$(dirname "$gateway_db_marker")"
    do_or_say touch "$gateway_db_marker"
  fi

  if ! do_or_say docker compose -f "$compose_file" up -d; then
    die "the stack did not come up (docker's own message is above). Everything generated so far is left exactly as it is — fix what it named, then run this again." "$EX_REFUSED"
  fi
  say "the stack is up: db, console, lares-gateway, caddy."
}

# --- 9b. prove the key works, now that the gateway it calls is running (W8C-s5, moved here
#          by W8F-F7a) ------------------------------------------------------------------------
# WHY THIS IS A FUNCTION OF ITS OWN. It used to be step 9 INSIDE run_wizard, which put it
# before anything had started the gateway it calls: `GATEWAY_URL` is http://lares-gateway:4000,
# a compose service name, so on a fresh box the call could only fail, and the installer then
# died saying "the model key did not work" — naming the one thing that was not wrong. A fresh
# install could not finish. It now runs after run_stack, and tests/install-stack.test.ts pins
# that order by reading the two calls out of one log rather than trusting this comment.
#
# THE ONE LIVE CALL IN THE WHOLE INSTALLER, and it happens on the owner's server at install
# time — never in a builder's test (CLAUDE.md: a fixture is what we believe an API does; only
# a live call is what it does; W8A-s7 built and probed the call itself, this only wires it).
# `lares_doctor` (above) prefers a `lares-doctor` on PATH, exactly like docker/chown/ufw, so a
# test can stub it. The key travels only as a PATH to its file — never read into this script,
# never on this or any other command's argument list, so it cannot appear in a log or a process
# listing. A non-zero exit refuses (everything generated so far — every secret, $INSTALL_ENV,
# the stack file, the containers already started — is left exactly as it is, so a re-run
# resumes instead of starting over); the child's own stderr, never captured or rewritten here,
# is what tells the owner what to change (W8A-s7 guarantees it carries no key and no gateway
# response body).
#
# WHICH CREDENTIAL IT PRESENTS, settled here rather than left to be rediscovered. This check
# used to hand over $SECRETS_DIR/model-provider-key, and doctor.ts sends whatever it is given
# as the `x-api-key` header. But the thing answering is now OUR gateway, and its configuration
# (lib/gateway-config.ts) sets general_settings.master_key — so LiteLLM authenticates the
# CALLER against its own master key, or against a virtual key minted through /key/generate and
# held in its database. The model provider's key is neither: to LiteLLM it is simply a key it
# does not know, and the 2026-09-21 live probe measured exactly that case as a 401. No
# per-agent virtual key has been minted at this point in a fresh install, so the master key is
# the only credential LiteLLM will accept, and it is what this presents. The provider key is
# still proven by this call, one layer further in: the gateway uses it to reach the model, and
# a bad one comes back as the gateway's own upstream failure.
run_model_check() {
  local gateway_url model_alias
  gateway_url=$(read_setting GATEWAY_URL "$INSTALL_ENV")
  model_alias=$(read_setting LARES_MODEL_ALIAS "$INSTALL_ENV")
  if ! do_or_say lares_doctor --test-model --gateway "$gateway_url" --alias "$model_alias" --key-file "$SECRETS_DIR/gateway-master-key"; then
    die "the gateway did not answer with a working model. Everything generated so far is left exactly as it is — fix what the line above names (the model provider key, or the gateway), then run this again." "$EX_REFUSED"
  fi
}

# --- 10. the database is created and migrated, or the install stops (W8C-s6) ---------------
# THE COMPOSE FILE IS WRITTEN BY run_stack, IMMEDIATELY ABOVE (corrected W8F-F7a — the comment
# that stood here said the neutral stack was "a later track, not built yet"; this IS that track
# and lib/stack-compose.ts is that stack). This still reads the path from ONE variable and still
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
  # PGDATABASE / PGUSER / PGHOST / PGPORT are the SAME overridable names ops/update.sh and
  # lib/db.ts already read, with the same defaults — so this installation's spelling of them
  # lives in one place and wave 9's naming sweep has one list to change, not a new literal here.
  local compose_file="$PREFIX/opt/lares/compose.yaml"
  local db_name="${PGDATABASE:-lares_state}" db_user="${PGUSER:-lares}"
  local db_host="${PGHOST:-127.0.0.1}" db_port="${PGPORT:-5432}"
  local db_created_marker="$PREFIX/etc/lares/database-created"
  local tries=0 db_password code existing

  if [ ! -f "$compose_file" ]; then
    die "there is no stack file at $compose_file, so no database can be created. The step before this one writes it from the release file — run this again, and if it still says this, what it printed there is the thing to fix. Nothing has been changed." "$EX_REFUSED"
  fi

  do_or_say docker compose -f "$compose_file" up -d db

  until docker compose -f "$compose_file" exec -T db pg_isready -U "$db_user" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
      die "the database container did not become ready. Nothing else was applied." "$EX_REFUSED"
    fi
    sleep 1
  done

  # NO PASSWORD ON THIS CALL, on purpose. `docker compose exec` does not carry the host's
  # environment into the container, so a PGPASSWORD set here would reach nothing; psql inside
  # the container talks over its own local socket, which is exactly how ops/restore-drill.sh and
  # ops/input-freshness.sh already reach this database. A password only appears below, for the
  # ONE call that connects from THIS machine.
  #
  # ALREADY THERE can also mean the stack's own first start created it: a Postgres image creates
  # POSTGRES_DB itself at first init (and runs sql/001_init.sql from docker-entrypoint-initdb.d —
  # see the top of migrate.ts), which is exactly what run_stack's `up -d` above just did — so
  # on a fresh install the container will usually have made it already. Asking is one SELECT;
  # getting it wrong would refuse a perfectly good installation over a database that exists.
  if [ -f "$db_created_marker" ]; then
    say "database $db_name — already there. Left exactly as it is."
  else
    existing=$(docker compose -f "$compose_file" exec -T db \
      psql -U "$db_user" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '$db_name'" </dev/null 2>/dev/null \
      | tr -d '[:space:]') || existing=""
    if [ "$existing" = "1" ]; then
      say "database $db_name — already there (the stack's own first start created it). Left exactly as it is."
      do_or_say mkdir -p "$(dirname "$db_created_marker")"
      do_or_say touch "$db_created_marker"
    elif printf 'CREATE DATABASE %s;\n' "$db_name" \
        | docker compose -f "$compose_file" exec -T db psql -U "$db_user" -d postgres
    then
      do_or_say mkdir -p "$(dirname "$db_created_marker")"
      do_or_say touch "$db_created_marker"
      say "database $db_name — created."
    else
      die "could not create the $db_name database. Nothing else was applied." "$EX_REFUSED"
    fi
  fi

  # services/box/migrate.ts's own exit codes: 0 nothing left to do · 1 refused (its own message,
  # already printed to stderr above this call, says what to fix) · 2 dry-run-only, there is work
  # to do — reachable only if this were ever called with --dry-run, which a real install never
  # does, but the runner's own contract names it so this still answers it correctly rather than
  # treating it as a failure.
  # THE RUNNER'S ENVIRONMENT, and why it has to be given one. migrate.ts connects through
  # lib/db.ts's poolFromEnv, whose defaults are for a process INSIDE the fleet: host "db" (a
  # compose service name, which does not resolve on this machine) and the password at
  # /run/secrets/db_password (a mount that exists only in a container). Run from here with
  # neither, it cannot connect at all. So this one call — and nothing else — is given the
  # address and the password, the password read from its file into ONE variable for ONE command
  # and cleared immediately, never an argument. PGHOST/PGPORT are overridable above because
  # reaching the database from the host means the stack publishes that port — which the file
  # run_stack renders does, to 127.0.0.1 only.
  db_password=$(cat "$SECRETS_DIR/database-password")
  code=0
  PGHOST="$db_host" PGPORT="$db_port" PGDATABASE="$db_name" PGUSER="$db_user" \
    PGPASSWORD="$db_password" pnpm -C "$BOX_DIR" migrate || code=$?
  db_password=""
  if [ "$code" -eq 0 ]; then
    say "database migrations applied through the runner."
  else
    if [ "$code" -eq 2 ]; then
      say "migrations: there is work to do (a dry run reported it; nothing was applied)."
    else
      die "the database migration runner refused. Nothing else was applied." "$EX_REFUSED"
    fi
  fi
}

# --- 10b. the first-agent screen's installation settings ----------------------------------
# The schema is now complete, but two deliberately fail-closed settings have no migration
# default: the gateway alias prefix and the approved number of agents. A fresh installation's
# tested path needs exactly one first agent, so initialize missing values to `lares` and 1.
# Repair runs preserve every existing value; this is an initializer, not a settings reset.
run_installation_settings() {
  local db_name="${PGDATABASE:-lares_state}" db_user="${PGUSER:-lares}"
  local db_host="${PGHOST:-127.0.0.1}" db_port="${PGPORT:-5432}"
  local db_password code

  db_password=$(cat "$SECRETS_DIR/database-password")
  code=0
  PGHOST="$db_host" PGPORT="$db_port" PGDATABASE="$db_name" PGUSER="$db_user" \
    PGPASSWORD="$db_password" pnpm -C "$BOX_DIR" installation-settings || code=$?
  db_password=""
  if [ "$code" -ne 0 ]; then
    die "the first-agent settings could not be initialized. Nothing else was applied." "$EX_REFUSED"
  fi
}

# --- 11. the owner becomes a real member, with a real id (W8C-s7) ---------------------------
# THE MOST DANGEROUS STEP IN THIS INSTALLER — see services/box/lib/first-owner.ts's own header:
# a wrong id here is silent and permanent. `createFirstOwner`'s id stays free text by design
# (W5I-s7: no shape heuristics beyond "not blank"), so THIS is where a real installation's id is
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

  if [ "$OWNER_ID_GIVEN" -eq 1 ]; then
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
  local db_name="${PGDATABASE:-lares_state}" db_user="${PGUSER:-lares}"
  local db_host="${PGHOST:-127.0.0.1}" db_port="${PGPORT:-5432}"
  local db_password code
  db_password=$(cat "$SECRETS_DIR/database-password")
  code=0
  PGHOST="$db_host" PGPORT="$db_port" PGDATABASE="$db_name" PGUSER="$db_user" \
    PGPASSWORD="$db_password" \
    LARES_OWNER_ID="$owner_id" LARES_OWNER_EMAIL="$owner_email" LARES_OWNER_NAME="$owner_name" \
    pnpm -C "$BOX_DIR" first-owner --apply || code=$?
  db_password=""
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
  local db_name="${PGDATABASE:-lares_state}" db_user="${PGUSER:-lares}"
  local db_host="${PGHOST:-127.0.0.1}" db_port="${PGPORT:-5432}"
  local db_password domain owner_email code=0
  domain=$(read_setting LARES_DOMAIN "$INSTALL_ENV")
  owner_email=$(read_setting LARES_OWNER_EMAIL "$INSTALL_ENV")
  db_password=$(cat "$SECRETS_DIR/database-password")
  PGHOST="$db_host" PGPORT="$db_port" PGDATABASE="$db_name" PGUSER="$db_user" \
    PGPASSWORD="$db_password" LARES_OWNER_ID="$OWNER_ID" \
    LARES_OWNER_EMAIL="$owner_email" LARES_DOMAIN="$domain" \
    pnpm -C "$BOX_DIR" first-organisation || code=$?
  db_password=""
  if [ "$code" -ne 0 ]; then
    die "the first organisation could not be enrolled. The keeper was not started; review the existing membership before retrying." "$EX_REFUSED"
  fi
}

# --- 12. the keeper is configured and started, from the same release (W8F-F7b) ---------------
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
LARES_PROXY_ADDRESS="${LARES_PROXY_ADDRESS:-172.30.0.2}"

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
  local db_name="${PGDATABASE:-lares_state}" db_user="${PGUSER:-lares}"
  local gateway_url tmp env_tmp

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
  if ! pnpm -C "$BOX_DIR" render-keeper-config \
      "$RELEASE_FILE" "$tmp" "$env_tmp" "$keeper_config" \
      "$LARES_PROJECT" "$root" "$agents_dir" "$retired_dir" "$backup_dir" "$egress_dir" \
      "$SECRETS_DIR" "$socket_dir" "$host_socket_dir" \
      "$LARES_NETWORK" "$LARES_SUBNET" "$LARES_PROXY_ADDRESS" "$gateway_url" \
      "$db_user" "$db_name" "$OWNER_ID"; then
    rm -f "$tmp" "$env_tmp"
    die "the release file '$RELEASE_FILE' was refused (the reason is printed above). The keeper has not been configured or started, and everything written before this — every secret, $INSTALL_ENV, the stack and its containers, the database, the owner — is left exactly as it is." "$EX_REFUSED"
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

  do_or_say cp "$BOX_DIR/compose.lares-keeper.yaml" "$keeper_compose"
  do_or_say chmod 0640 "$keeper_compose"

  if ! do_or_say docker compose --env-file "$keeper_env" -f "$keeper_compose" up -d; then
    die "the keeper did not come up (docker's own message is above). Everything generated so far — every secret, $INSTALL_ENV, the stack, the database, the owner and $keeper_config — is left exactly as it is; fix what it named, then run this again." "$EX_REFUSED"
  fi
  say "the keeper is up, and this installation's first-agent role defaults are bound to $OWNER_ID."
}

# --- 13. finish honestly at the console, before any agent exists (W8C-s9) -----------------
# The keeper configuration above carries first-agent role bindings, but it does not create or
# reconcile that agent's definition/runtime, and no per-agent LiteLLM virtual key has been minted.
# `/chat` therefore has no registered agent to show. The one honest address to print is the
# console's existing first-agent setup page. A later launch gate owns creation, key registration,
# agent health and the first proved web-chat turn; this installer claims none of them.
run_finish() {
  local domain compose_file tries=0
  domain=$(read_setting LARES_DOMAIN "$INSTALL_ENV")
  [ -n "$domain" ] || die "the domain is not written down in $INSTALL_ENV, so the console cannot be checked. The installation is left exactly as it is." "$EX_REFUSED"
  compose_file="$PREFIX/opt/lares/compose.yaml"

  until curl -fsS --max-time 5 "https://$domain/api/auth/login" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      die "the console did not come up at the public address. The installation is left exactly as it is. Inspect it with docker compose logs: docker compose -f $compose_file logs --tail 200 console caddy" "$EX_TEMPFAIL"
    fi
    sleep 2
  done

  if [ "$REPAIR_MODE" -eq 1 ]; then
    say "the repair run is finished. This run did not create, start or prove an agent conversation."
    say "Open the console:"
    say "https://$domain/"
  else
    say "the installer is finished. No agent is running and no conversation is ready yet."
    say "Open this to create your first agent:"
    say "https://$domain/agents/new"
    say 'Nothing is backed up yet. `lares backup` sets that up.'
    say "No chat app is connected yet; after the first agent is running, web chat is the first door and Slack or Telegram can be connected later."
  fi
}

if [ "$DRY_RUN" -eq 1 ]; then
  say "the four questions (domain, e-mail, name, model key) would be asked next, and the answers written to $INSTALL_ENV and $SECRETS_DIR/model-provider-key."
  say "then the release given with --release would be rendered into $PREFIX/opt/lares/compose.yaml, the stack brought up from it, the model proved through the gateway, the database created and migrated, the owner made a real member, and the keeper configured from the same release with first-agent role defaults bound to that owner. A real run needs --release <file>; a dry run asks nothing and writes nothing."
else
  # THE ORDER IS THE POINT, not a sequence of independent steps (W8F-F7a). run_stack must come
  # before run_model_check: that check calls the gateway by its compose service name, so until
  # the stack is up there is nothing there to answer it — which is how a fresh install used to
  # end, with "the model key did not work" against a key that was fine. run_database follows
  # the model check so nothing is built on a model that cannot answer, and run_first_owner
  # follows the database it writes a row into, and run_keeper follows the owner whose id the one
  # agent it defines is bound to (W8F-F7b). tests/install-stack.test.ts and
  # tests/install-keeper.test.ts pin those orderings against the stub log rather than against
  # this comment.
  run_wizard        # the four questions ONLY — no outside call
  run_stack
  run_model_check
  run_database
  run_installation_settings
  run_first_owner
  run_first_organisation
  run_keeper
  run_finish
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "this was a dry run. Nothing has been changed."
  exit "$EX_OK"
fi

exit "$EX_OK"
