#!/usr/bin/env bash
# export.sh — LAR-21-s2: one command, run by hand on the box, that takes the whole
# installation with you: every database, the vaults, the data directories, and a
# manifest listing exactly what is inside. It shares no code with backup.sh — the
# dump technique is copied, not imported, because the two scripts have different
# failure philosophies (a backup that fails leaves last night's snapshot standing; an
# export that fails should leave nothing half-written behind it, see the trap below).
#
# SECRETS NEVER LEAVE. This is the one property this script cannot get wrong. Nothing
# under /etc/agent-box, /etc/lares or /run/secrets is ever copied into the archive; no
# file named .env or ending .age is ever copied, whether it is a configured path itself
# or found nested inside a configured data directory. (The one file this script reads
# from there is its own settings file, below — read for its settings, never copied.)
# The database dumps DO hold the saved sign-ins to outside services, but only in their
# encrypted form: they are unreadable without the installation's token key, which is a
# secret, stays behind, and is carried to a new server by hand. See refuse_secret_path and
# check_no_nested_secrets below — both fail the whole export loudly rather than
# quietly leaving a file out, on the same "silence is the failure" principle as
# backup.sh's own dump assertions.
#
# NO HEARTBEAT AND NO NETWORK. This is a command the owner runs by hand and reads the
# manifest of afterwards (see docs/runbooks/export-and-teardown.md, LAR-21-s3) — it is
# not a scheduled job with a liveness owner, and it must never phone anywhere.
set -euo pipefail
umask 077

ENV_FILE="${AGENT_BOX_EXPORT_ENV:-${AGENT_BOX_BACKUP_ENV:-/etc/agent-box/backup.env}}"
# The settings file is optional: every setting below has a default, and an installation
# with no backup configured can still be exported.
if [ -f "$ENV_FILE" ]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

# --- configuration ---------------------------------------------------------------------
# Space-separated strings, not bash arrays — the restore-drill.sh lesson (its
# DRILL_RESTORE_PATHS comment): an empty bash array expanded with "${arr[@]}" under
# `set -u` is an unbound-variable error on bash 3.2 (macOS's default), so anything that
# could plausibly be empty is a plain word-split string here instead.
EXPORT_VAULT_PATHS="${EXPORT_VAULT_PATHS:-/srv/brain.git /srv/atlas.git}"
EXPORT_DATA_PATHS="${EXPORT_DATA_PATHS:-/srv/lares /srv/taste}"
EXPORT_DIR="${EXPORT_DIR:-/var/backups/export}"
# Never /tmp — restore-drill.sh's own comment on DRILL_SCRATCH_ROOT applies exactly as
# much here: /tmp can be a small tmpfs, and this script's work dir holds full database
# dumps plus vault bundles and data tars.
EXPORT_WORKDIR_ROOT="${EXPORT_WORKDIR_ROOT:-/var/tmp}"
# No ledger of applied SQL files here (WAVE-3-NOTES.md's ruling on this slice): an
# older box has no record of that history to report. Just what the box that produced
# this archive says it is.
ENGINE_VERSION="${LARES_ENGINE_VERSION:-unknown}"

SECRET_ROOTS="/etc/agent-box /etc/lares /run/secrets"

# --- hard refusals -----------------------------------------------------------------------
# Applied to every configured path (the vaults, the data directories, and the export
# destination itself) before any dump or bundle work starts, so a bad configuration
# fails fast and in one place.
refuse_secret_path() {
  local p="$1" root base
  for root in $SECRET_ROOTS; do
    case "$p" in
      "$root"|"$root"/*)
        echo "export: refusing — '$p' is under $root, which never leaves this box" >&2
        exit 1
        ;;
    esac
  done
  base=$(basename -- "$p")
  case "$base" in
    .env)
      echo "export: refusing — '$p' is named .env, which never leaves this box" >&2
      exit 1
      ;;
    *.age)
      echo "export: refusing — '$p' is an age-encrypted secret file, which never leaves this box" >&2
      exit 1
      ;;
  esac
}

# A configured DATA path is a whole directory tree, tarred as-is — unlike the
# configured path itself, a stray .env or *.age file could be sitting somewhere deeper
# inside it without anyone having put it there on purpose. This refuses the whole
# export rather than quietly excluding the file: an export that silently drops files
# is this script's version of backup.sh's own incident (a green run that silently
# skipped a database). Nothing is exported until the tree is proven clean.
check_no_nested_secrets() {
  local dir="$1" hits
  hits=$(find "$dir" \( -name '.env' -o -name '*.age' \) -print 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "export: refusing — $dir contains a secret file that must never leave this box:" >&2
    printf '%s\n' "$hits" >&2
    exit 1
  fi
}

refuse_secret_path "$EXPORT_DIR"
for p in $EXPORT_VAULT_PATHS; do refuse_secret_path "$p"; done
for p in $EXPORT_DATA_PATHS; do refuse_secret_path "$p"; done

# --- work dir, removed on both success and failure ----------------------------------------
# WORKDIR starts empty and is only ever rm -rf'd once it holds mktemp's own result —
# same shape as restore-drill.sh's SCRATCH/remove_scratch, so a trap that fires before
# mktemp ever runs (a bad EXPORT_WORKDIR_ROOT, say) has nothing to remove.
WORKDIR=""
cleanup() {
  local rc=$?
  [ -z "$WORKDIR" ] || rm -rf "$WORKDIR"
  exit "$rc"
}
trap cleanup EXIT INT TERM

[ -d "$EXPORT_WORKDIR_ROOT" ] || { echo "export: working directory root '$EXPORT_WORKDIR_ROOT' does not exist" >&2; exit 1; }
WORKDIR=$(mktemp -d "$EXPORT_WORKDIR_ROOT/lares-export.XXXXXX")
echo "export: working in $WORKDIR" >&2

# --- 1. Postgres: roles + every database, through the db container -----------------------
# Exactly backup.sh:49-94's technique, copied rather than shared: read the database
# list first, dump each one with </dev/null, and assert every dump landed non-empty.
COMPOSE=(-f /opt/agent-box/compose.yaml -f /opt/agent-box/compose.override.yaml)
dc() { docker compose "${COMPOSE[@]}" exec -T db "$@"; }

# The role this installation uses. Same overridable name ops/install.sh, ops/update.sh and
# lib/db.ts read, with the same default — an installation that kept the pre-2026-09-21 name
# with an installation-specific role sets PGUSER in this script's environment. See LAR-74 §3.
DB_USER="${PGUSER:-lares}"

dc pg_isready -U "$DB_USER" >/dev/null || { echo "export: postgres unreachable — refusing an incomplete export" >&2; exit 1; }

dc pg_dumpall -U "$DB_USER" -l postgres --globals-only > "$WORKDIR/globals.sql"

# THE DATABASE LIST IS READ FIRST, NOT PIPED INTO THE LOOP. `dc` is `docker compose
# exec`, which consumes stdin even with -T, so piping the list into a while-read loop
# would dump only the first database and silently skip the rest (backup.sh:70-76's own
# incident). `</dev/null` on the dump call is the belt to that braces.
DBS=$(dc psql -U "$DB_USER" -d postgres -tAc \
  "SELECT datname FROM pg_database WHERE datistemplate=false AND datname<>'postgres'")
[ -n "$DBS" ] || { echo "export: postgres returned NO databases — refusing an incomplete export" >&2; exit 1; }

EXPECTED=0
for db in $DBS; do
  [ -n "$db" ] || continue
  EXPECTED=$((EXPECTED + 1))
  dc pg_dump -U "$DB_USER" --format=custom "$db" > "$WORKDIR/${db}.dump" </dev/null
done

# All of them, non-empty — the same assertion backup.sh makes, for the same reason:
# "some dumps exist" is exactly the shape a silently-skipped database hides behind.
shopt -s nullglob
dumps=("$WORKDIR"/*.dump)
[ ${#dumps[@]} -gt 0 ] || { echo "export: no dumps produced" >&2; exit 1; }
[ ${#dumps[@]} -eq "$EXPECTED" ] || {
  echo "export: dumped ${#dumps[@]} of $EXPECTED databases — refusing an incomplete export" >&2
  exit 1
}

# --- 2. Vault bundles ----------------------------------------------------------------------
for vault in $EXPORT_VAULT_PATHS; do
  [ -e "$vault" ] || { echo "export: vault path '$vault' does not exist — refusing an incomplete export" >&2; exit 1; }
  name=$(basename "$vault")
  name=${name%.git}
  git --git-dir="$vault" bundle create "$WORKDIR/${name}.bundle" --all
done

# --- 3. Data directories ---------------------------------------------------------------------
for data in $EXPORT_DATA_PATHS; do
  [ -e "$data" ] || { echo "export: data path '$data' does not exist — refusing an incomplete export" >&2; exit 1; }
  check_no_nested_secrets "$data"
  name=$(basename "$data")
  tar -C "$(dirname "$data")" -cf "$WORKDIR/${name}.tar" "$name"
done

# --- 4. Manifest: engine version, date, and per-file name/size/sha256 -----------------------
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

MANIFEST_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MANIFEST="$WORKDIR/manifest.json"
{
  printf '{\n'
  printf '  "engineVersion": "%s",\n' "$ENGINE_VERSION"
  printf '  "date": "%s",\n' "$MANIFEST_DATE"
  printf '  "files": [\n'
  first=1
  for f in "$WORKDIR"/*; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    [ "$base" != "manifest.json" ] || continue
    size=$(wc -c < "$f" | tr -d '[:space:]')  # not `stat`: its flags differ between Linux and macOS
    sha=$(sha256_of "$f")
    if [ "$first" -eq 1 ]; then
      first=0
    else
      printf ',\n'
    fi
    printf '    {"name": "%s", "size": %s, "sha256": "%s"}' "$base" "$size" "$sha"
  done
  printf '\n  ]\n'
  printf '}\n'
} > "$MANIFEST"

# --- 5. One final archive --------------------------------------------------------------------
mkdir -p "$EXPORT_DIR"
FINAL_DATE=$(date -u +%Y-%m-%d)
FINAL="$EXPORT_DIR/lares-export-${FINAL_DATE}.tar"
tar -C "$WORKDIR" -cf "$FINAL" .

echo "export: wrote $FINAL" >&2
echo "export: it holds every database, these vaults: $EXPORT_VAULT_PATHS" >&2
echo "export: and these data directories: $EXPORT_DATA_PATHS" >&2
echo "export: a directory that is not in those two lists was NOT exported — compare them with what your backup covers (EXPORT_VAULT_PATHS, EXPORT_DATA_PATHS)." >&2
echo "export: no secret is inside. Saved sign-ins are in the dumps in encrypted form only; the key that opens them is not." >&2
# cleanup (the EXIT trap) removes WORKDIR here, on the way out — success or failure.
