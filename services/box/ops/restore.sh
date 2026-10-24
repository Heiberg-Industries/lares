#!/usr/bin/env bash
# restore.sh — put an installation back from a nightly restic snapshot, onto a NEW server.
#
#   restore.sh --snapshot <id|latest> [--old-server-stopped] [--dry-run] [--yes] [--prefix <dir>]
#
# This is the guided form of docs/runbooks/export-and-teardown.md section 5 ("Current
# /opt/lares restore sequence") for restic snapshots. It restores into a server that
# install.sh has just finished and that holds nothing of its own yet.
#
# THE STARTING POINT (docs/install.md, "Restoring onto a new server"; this script checks it):
#   1. On YOUR machine you decrypted the snapshot's age bundle (the age private key never
#      touches this server) and copied ONLY these onto this server: etc/lares/installation.env,
#      etc/lares/console-oauth.env, etc/lares/backup.env, etc/lares/restic-password,
#      etc/lares/secrets/ and srv/lares/secrets/ (the agents' token folder). NEVER keeper.json or
#      keeper.env: they pin the old server's image digests.
#   2. You ran install.sh --yes --release <the same or a newer release>. It reuses those
#      answers and secrets, so the database came up with the OLD password.
#
# WHAT IT DOES, in this order. Nothing on this server changes until every check has passed:
#   checks -> restic restore into a private scratch folder -> checks on the snapshot ->
#   stop the keeper, then console, caddy and gateway (the database stays up) ->
#   drop, recreate and pg_restore each database -> migrate -> copy the agents, retired, taste
#   and installation folders from the snapshot -> start the base stack, then the keeper.
#
# WHY IT ASKS WHETHER THE OLD SERVER IS STOPPED. Two servers would both answer the chat
# doors, and both would write to one backup repository. It cannot see the old server, so it
# asks; with --yes you must say it with --old-server-stopped.
#
# Exit codes (same scheme as install.sh): 0 ok · 64 bad usage · 75 a step failed AFTER changes
# began (the message says exactly what was and was not changed) · 77 not running as root ·
# 78 refused (nothing was changed).
# LARES_PREFIX / --prefix keeps every write testable; host commands resolve from PATH so
# tests can put logging stubs ahead of them. NO SUDO. Nothing phones home: the only network
# use is restic reaching the repository named in /etc/lares/backup.env.
set -euo pipefail
umask 077

EX_OK=0
EX_USAGE=64
EX_TEMPFAIL=75
EX_NOTROOT=77
EX_REFUSED=78

HERE="$(cd "$(dirname "$0")" && pwd)"
BOX_DIR="$(cd "$HERE/.." && pwd)"

# The migration runner runs in the engine image when this box's engine came from one (an
# `engine-image` file in the box folder, or LARES_ENGINE_IMAGE; ops/engine-run.sh), and through
# pnpm on a checkout exactly as before. Only the checkout mode needs pnpm on this host.
ENGINE_MODE=host
if [ -r "$HERE/engine-run.sh" ]; then
  # shellcheck source=engine-run.sh
  . "$HERE/engine-run.sh"
  if engine_image_mode; then ENGINE_MODE=image; fi
fi

say() { printf 'restore: %s\n' "$1"; }
die() { printf 'restore: %s\n' "$1" >&2; exit "$2"; }

usage() {
  cat <<'EOF' >&2
Usage: restore.sh --snapshot <id|latest> [--old-server-stopped] [--dry-run] [--yes]
                  [--prefix <dir>]

Restores this installation from a nightly restic snapshot onto a new server that install.sh
has just finished. Run it as root from the checkout, after you have copied the secrets over
(docs/install.md, "Restoring onto a new server"). It refuses, changing nothing, when this
server is not a fresh install, when the snapshot is not usable, or when anything looks wrong.

  --snapshot <id|latest>  the restic snapshot to restore ("latest" = the newest nightly one)
  --old-server-stopped    you confirm the OLD server is switched off (required with --yes;
                          otherwise you are asked). Two live servers would both answer chat
                          and both write to the backup repository.
  --dry-run               do every check, including reading the snapshot into a private
                          scratch folder, then say what would happen. Changes nothing here.
  --yes                   do not ask for confirmation (unattended)
  --prefix <dir>          treat this directory as the install root instead of / (for testing)
  -h, --help              show this message

It replaces every database in the snapshot, and the agents, retired, taste and installation
folders. install.sh --restore <archive> (the check of an export archive) is a different job
and is unchanged.
EOF
}

DRY=0
ASSUME_YES="${LARES_ASSUME_YES:-0}"
PREFIX_ARG=""
SNAPSHOT=""
OLD_STOPPED=0

need_value() { [ "$2" -ge 2 ] || { echo "restore: $1 needs a value" >&2; exit "$EX_USAGE"; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --old-server-stopped) OLD_STOPPED=1; shift ;;
    --snapshot) need_value "$1" $#; SNAPSHOT="$2"; shift 2 ;;
    --prefix) need_value "$1" $#; PREFIX_ARG="$2"; shift 2 ;;
    -h|--help) usage; exit "$EX_USAGE" ;;
    *)
      echo "restore: I do not know the argument '$1', so I have not done anything." >&2
      usage
      exit "$EX_USAGE"
      ;;
  esac
done

PREFIX="${PREFIX_ARG:-${LARES_PREFIX:-/}}"
# P: where a logical path (/etc/lares/...) really lives, given the prefix.
export LARES_PREFIX="${PREFIX%/}"
P() { printf '%s%s' "${PREFIX%/}" "$1"; }
keeper_dc() { env -u COMPOSE_FILE docker compose --env-file "$KEEPER_ENV" "$@"; }

if [ -z "$SNAPSHOT" ]; then
  echo "restore: --snapshot <id|latest> is required, so I have not done anything." >&2
  usage
  exit "$EX_USAGE"
fi
printf '%s' "$SNAPSHOT" | grep -Eq '^[A-Za-z0-9]+$' || die "'$SNAPSHOT' is not a snapshot id (letters and digits only) or the word latest. Nothing was changed." "$EX_USAGE"

ETC_LARES=$(P /etc/lares)
OPT_LARES=$(P /opt/lares)
SRV_LARES=$(P /srv/lares)
TASTE_DIR=$(P /srv/taste)
COMPOSE_FILE="$OPT_LARES/compose.yaml"
KEEPER_COMPOSE="$OPT_LARES/compose.lares-keeper.yaml"
KEEPER_VAULT_COMPOSE="$OPT_LARES/compose.lares-keeper-vault.yaml"
KEEPER_VAULT_COMPOSE_SOURCE="$BOX_DIR/compose.lares-keeper-vault.yaml"
KEEPER_ENV="$ETC_LARES/keeper.env"
KEEPER_JSON="$ETC_LARES/keeper.json"
AGENTS_COMPOSE="$SRV_LARES/compose.lares-agents.yaml"
INSTALL_ENV="$ETC_LARES/installation.env"
SECRETS_DIR="$SRV_LARES/secrets"
ENV_FILE="$ETC_LARES/backup.env"

# --- 0. root ------------------------------------------------------------------------------
ROOT_ID=$(id -u 2>/dev/null) || ROOT_ID=""
if [ "$ROOT_ID" != "0" ]; then
  die "this needs to run as root (found user id '${ROOT_ID:-unknown}'). Try again with: sudo $0 $*" "$EX_NOTROOT"
fi

if [ "$DRY" != 1 ] && [ "$ASSUME_YES" = 1 ] && [ "$OLD_STOPPED" != 1 ]; then
  die "with --yes I cannot ask whether the OLD server is switched off, and two live servers would both answer chat and both write to the backup repository. Switch the old server off, then run again with --old-server-stopped. Nothing was changed." "$EX_REFUSED"
fi

# --- scratch folder and its trap ------------------------------------------------------------
SCRATCH=""
SCRATCH_ROOT=""
VAULT_SNAPSHOT_DB=""
PRESERVE_SCRATCH=0
VAULT_TARGET_PRESENT=0
vault_storage_unlock() { :; }
# Removes only the folder THIS run made, and only when it is under the configured scratch
# root: a trap that runs on every exit path is exactly where a wrong variable turns into rm -rf.
remove_scratch() {
  [ -n "$SCRATCH" ] && [ -n "$SCRATCH_ROOT" ] || return 0
  [ "$SCRATCH" != "/" ] || return 0
  [ -d "$SCRATCH" ] || return 0
  if [ "$PRESERVE_SCRATCH" = 1 ]; then echo "restore: incomplete restore staging retained privately at $SCRATCH; services remain stopped" >&2;return 0;fi
  case "$SCRATCH" in
    "$SCRATCH_ROOT"/restore-snapshot.*) rm -rf "$SCRATCH" ;;
    *) echo "restore: not removing '$SCRATCH': it is not under $SCRATCH_ROOT" >&2 ;;
  esac
}
cleanup() { local rc=$?; vault_storage_unlock; if [ -n "$VAULT_SNAPSHOT_DB" ];then db_run dropdb -U "$DB_USER" --if-exists "$VAULT_SNAPSHOT_DB" </dev/null >/dev/null 2>&1 || true;fi; remove_scratch; exit "$rc"; }
trap cleanup EXIT INT TERM

# --- 1. this must be a finished current-layout install ----------------------------------------
{ [ -f "$COMPOSE_FILE" ] && [ -d "$ETC_LARES" ]; } || die "this is not a finished Lares installation: /opt/lares/compose.yaml or /etc/lares is missing. Run install.sh first. Nothing was changed." "$EX_REFUSED"
[ -f "$INSTALL_ENV" ] || die "/etc/lares/installation.env is missing: copy it from the decrypted bundle (docs/install.md, \"Restoring onto a new server\"), then run install.sh. Nothing was changed." "$EX_REFUSED"
{ [ -f "$KEEPER_COMPOSE" ] && [ -f "$KEEPER_ENV" ] && [ -f "$KEEPER_JSON" ]; } || die "the keeper is not installed here (/opt/lares/compose.lares-keeper.yaml, /etc/lares/keeper.env or keeper.json is missing). Run install.sh first; it sets the keeper up. Nothing was changed." "$EX_REFUSED"
[ -f "$ENV_FILE" ] || die "/etc/lares/backup.env is missing, and it names the backup repository to restore from. Copy it from the decrypted bundle (with /etc/lares/restic-password). Nothing was changed." "$EX_REFUSED"

missing=""
ENGINE_TOOLS="restic docker pnpm python3"
[ "$ENGINE_MODE" = image ] && ENGINE_TOOLS="restic docker python3"
for tool in $ENGINE_TOOLS; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  msg="these tools are missing:$missing."
  case "$missing" in *restic*) msg="$msg Install restic with: apt-get install -y restic." ;; esac
  die "$msg Nothing was changed." "$EX_REFUSED"
fi
if [ "$ENGINE_MODE" = image ]; then
  engine_resolve_image "" || die "the engine image is not known: there is no digest in LARES_ENGINE_IMAGE or in $BOX_DIR/engine-image. Nothing was changed." "$EX_REFUSED"
  if ! docker image inspect "$ENGINE_IMAGE" >/dev/null 2>&1 && ! docker pull "$ENGINE_IMAGE" >/dev/null; then
    die "could not download the engine image $ENGINE_IMAGE. Nothing was changed." "$EX_REFUSED"
  fi
fi

# --- 2. the backup settings (repository, password file) -----------------------------------------
# shellcheck source=/dev/null
source "$ENV_FILE"
[ -n "${RESTIC_PASSWORD_FILE:-}" ] || die "/etc/lares/backup.env names no RESTIC_PASSWORD_FILE, so the repository cannot be opened. Nothing was changed." "$EX_REFUSED"
if [ ! -f "$RESTIC_PASSWORD_FILE" ] && [ -f "$(P "$RESTIC_PASSWORD_FILE")" ]; then
  RESTIC_PASSWORD_FILE=$(P "$RESTIC_PASSWORD_FILE")
fi
[ -s "$RESTIC_PASSWORD_FILE" ] || die "the repository password file ($RESTIC_PASSWORD_FILE) is missing or empty: copy /etc/lares/restic-password from the decrypted bundle. Nothing was changed." "$EX_REFUSED"
export RESTIC_PASSWORD_FILE
if [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then export AWS_ACCESS_KEY_ID; fi
if [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then export AWS_SECRET_ACCESS_KEY; fi
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  RESTIC=(restic -r "$RESTIC_REPOSITORY")
elif [ -n "${RESTIC_REPO_PATH:-}" ]; then
  RCLONE_PROGRAM="ssh -p ${STORAGEBOX_PORT:-23} -i ${STORAGEBOX_SSH_KEY:-} ${STORAGEBOX_USER:-}@${STORAGEBOX_HOST:-}"
  RESTIC=(restic -o rclone.program="${RCLONE_PROGRAM}" -r "rclone:${RESTIC_REPO_PATH}")
else
  die "/etc/lares/backup.env names no RESTIC_REPOSITORY, so I do not know where the backups are. Nothing was changed." "$EX_REFUSED"
fi

# Restores retain the archived object owners and grants. A short-lived database client
# authenticates with the explicit offline operator credential kept outside online mounts.
DB_USER=lares_operator
DB_NAME="${PGDATABASE:-lares_state}"
OPERATOR_PASSWORD_FILE="${LARES_OPERATOR_PASSWORD_FILE:-$(P /etc/lares/operator/database-password)}"
export LARES_OPERATOR_PASSWORD_FILE="$OPERATOR_PASSWORD_FILE"
REQUIRED_PATH="${BACKUP_REQUIRED_PATH:-/var/backups/pg}"
# Same scratch settings as the monthly restore rehearsal, so one setting serves both.
SCRATCH_ROOT="${RESTORE_SCRATCH_ROOT:-${DRILL_SCRATCH_ROOT:-/var/tmp}}"
MIN_FREE_MB="${DRILL_MIN_FREE_MB:-5120}"

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
db_run() { operator_db_run -f "$COMPOSE_FILE" -- "$@"; }

[ -f "$OPERATOR_PASSWORD_FILE" ] && [ ! -L "$OPERATOR_PASSWORD_FILE" ] \
  && [ "$(stat -c '%u:%a' "$OPERATOR_PASSWORD_FILE" 2>/dev/null || true)" = 0:600 ] \
  || die "the explicit offline operator credential is missing or unsafe. Nothing was changed." "$EX_REFUSED"

# The engine roles are created at install time even when prepared financial custody is not
# configured. Check both role password files before any restore side effect; the financial role
# password stays in the protected install secret store and is not a Keeper config binding.
ENGINE_APP_PASSWORD_FILE=$(python3 - "$KEEPER_JSON" <<'PYAPP'
import json, sys
try:
    config=json.load(open(sys.argv[1]))
    db=config['db']
    if not isinstance(db,dict) or set(db)!={'host','port','database','user','passwordFile'} or db['user']!='lares_app':
        raise ValueError()
    if not isinstance(db['passwordFile'],str) or not db['passwordFile'].startswith('/'):
        raise ValueError()
    print(db['passwordFile'])
except Exception:
    raise SystemExit(1)
PYAPP
) || die 'Keeper configuration has no explicit application database credential.' "$EX_REFUSED"
ENGINE_FINANCIAL_PASSWORD_FILE="$(P /etc/lares/secrets/financial-database-password)"
ENGINE_OUTSIDE_CUSTODY_PASSWORD_FILE="$(P /etc/lares/secrets/outside-custody-database-password)"
for credential_file in "$ENGINE_APP_PASSWORD_FILE" "$ENGINE_FINANCIAL_PASSWORD_FILE" "$ENGINE_OUTSIDE_CUSTODY_PASSWORD_FILE"; do
  [ -f "$credential_file" ] && [ ! -L "$credential_file" ] \
    && [ -s "$credential_file" ] \
    && [ "$(stat -c '%u:%g:%a' "$credential_file" 2>/dev/null || true)" = 0:10001:440 ] \
    || die 'An engine role credential file is missing or unsafe. Nothing was changed.' "$EX_REFUSED"
done

# --- 3. the domain this server was installed with must match the restored one ---------------------
read_env_value() { # read_env_value <NAME> <file>: the value, unquoted
  local raw
  raw=$(sed -n "s/^${1}=//p" "$2" 2>/dev/null | head -1) || raw=""
  raw="${raw#\'}"; raw="${raw%\'}"; raw="${raw#\"}"; raw="${raw%\"}"
  printf '%s' "$raw"
}
RESTORED_DOMAIN=$(read_env_value LARES_DOMAIN "$INSTALL_ENV")
[ -n "$RESTORED_DOMAIN" ] || die "/etc/lares/installation.env holds no LARES_DOMAIN. Copy the real file from the decrypted bundle. Nothing was changed." "$EX_REFUSED"
# install.sh wrote the address it was installed with into the stack file it rendered.
INSTALLED_DOMAIN=$(sed -n 's/^ *LARES_DOMAIN: *//p' "$COMPOSE_FILE" | head -1 | tr -d "\"' \r")
if [ -n "$INSTALLED_DOMAIN" ] && [ "$INSTALLED_DOMAIN" != "$RESTORED_DOMAIN" ]; then
  die "this server was installed for the address '$INSTALLED_DOMAIN', but the restored installation.env says '$RESTORED_DOMAIN'. Restoring onto a different address is not supported yet. Put the restored installation.env in place, run install.sh again, then restore. Nothing was changed." "$EX_REFUSED"
fi

# --- 4. the target must be fresh ------------------------------------------------------------------
db_run pg_isready -U "$DB_USER" >/dev/null 2>&1 </dev/null \
  || die "the database container is not answering. Start it (docker compose -f /opt/lares/compose.yaml up -d db) or finish install.sh first. Nothing was changed." "$EX_REFUSED"

COUNTS=$(db_run psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT (SELECT count(*) FROM agent_definitions) || ' ' || (SELECT count(*) FROM agent_conversations) || ' ' || (SELECT count(*) FROM conversation_entries)" \
  </dev/null 2>/dev/null | tr -d '\r') || COUNTS=""
printf '%s' "$COUNTS" | grep -Eq '^[0-9]+ [0-9]+ [0-9]+$' \
  || die "I could not read how much this server already holds (the agent and conversation tables). Finish install.sh first; it creates them. Nothing was changed." "$EX_REFUSED"
read -r N_DEFS N_CONVS N_ENTRIES <<EOF
$COUNTS
EOF
[ "$N_DEFS" = 0 ] || die "this server already has $N_DEFS agent definition(s). A restore only goes onto a server that has none, because it replaces every database. Rebuild a clean server, run install.sh, then restore. Nothing was changed." "$EX_REFUSED"
{ [ "$N_CONVS" = 0 ] && [ "$N_ENTRIES" = 0 ]; } || die "this server already holds conversations ($N_CONVS conversation(s), $N_ENTRIES message(s)). A restore would erase them. Rebuild a clean server, run install.sh, then restore. Nothing was changed." "$EX_REFUSED"

if [ -d "$SRV_LARES/agents" ] && [ -n "$(ls -A "$SRV_LARES/agents" 2>/dev/null)" ]; then
  die "$SRV_LARES/agents is not empty, so agents already exist on this server. A restore only goes onto a fresh install. Nothing was changed." "$EX_REFUSED"
fi

PROJECT=$(sed -n 's/.*"project" *: *"\([^"]*\)".*/\1/p' "$KEEPER_JSON" | head -1)
[ -n "$PROJECT" ] || PROJECT=lares
if [ -f "$AGENTS_COMPOSE" ]; then
  RUNNING=$(docker compose --project-name "$PROJECT" --project-directory "$SRV_LARES" -f "$AGENTS_COMPOSE" ps -q </dev/null 2>/dev/null) \
    || die "I could not ask Docker which agents are running here. A restore needs none running. Nothing was changed." "$EX_REFUSED"
  [ -z "$RUNNING" ] || die "an agent container is running on this server. A restore only goes onto a fresh install with no agents. Nothing was changed." "$EX_REFUSED"
fi

# A fresh install may already own two initialized empty Vault repositories. Refuse
# meaningful content; preserve the verified bootstrap in staging until the restore verifies.
if [ -r "$HERE/vault-storage.sh" ]; then
  . "$HERE/vault-storage.sh"
  vault_storage_load "${PREFIX%/}" || die 'target Vault storage is incomplete; finish or reconcile its pending plan before restore preparation' "$EX_REFUSED"
  VAULT_TARGET_PRESENT="$VAULT_STORAGE_PRESENT"
  if [ "$VAULT_TARGET_PRESENT" = 1 ];then vault_storage_verify "${PREFIX%/}" "$DB_NAME" verify-files >/dev/null || die 'target Vault repository identity did not verify' "$EX_REFUSED"; vault_storage_lock || die 'target Vault repositories are busy' "$EX_REFUSED";fi
  vault_storage_verify "${PREFIX%/}" "$DB_NAME" verify-empty >/dev/null || die 'restore preparation requires untouched empty target Vault stores with matching database identity; export existing notes first' "$EX_REFUSED"
fi

# --- 5. room for the scratch copy -----------------------------------------------------------------------
if [ ! -d "$SCRATCH_ROOT" ] || [ ! -w "$SCRATCH_ROOT" ]; then
  die "the scratch folder $SCRATCH_ROOT does not exist or cannot be written. Set RESTORE_SCRATCH_ROOT (or DRILL_SCRATCH_ROOT) to a disk-backed folder with room for the whole snapshot. Nothing was changed." "$EX_REFUSED"
fi
AVAIL_KB=$(df -Pk "$SCRATCH_ROOT" | awk 'NR==2 {print $4}')
case "$AVAIL_KB" in
  ''|*[!0-9]*) die "I could not read the free space on $SCRATCH_ROOT. An unreadable check counts as failing. Nothing was changed." "$EX_REFUSED" ;;
esac
AVAIL_MB=$(( AVAIL_KB / 1024 ))
[ "$AVAIL_MB" -ge "$MIN_FREE_MB" ] || die "only ${AVAIL_MB}MB is free on $SCRATCH_ROOT and I need at least ${MIN_FREE_MB}MB (DRILL_MIN_FREE_MB). Free some space, or point RESTORE_SCRATCH_ROOT at a bigger disk. Nothing was changed." "$EX_REFUSED"

# --- 6. read the snapshot into a private scratch folder ------------------------------------------
SCRATCH=$(mktemp -d "$SCRATCH_ROOT/restore-snapshot.XXXXXX")
chmod 0700 "$SCRATCH"
RESTORE_ARGS=("$SNAPSHOT")
[ "$SNAPSHOT" != latest ] || RESTORE_ARGS+=(--tag nightly)
say "reading snapshot $SNAPSHOT from the backup repository into a private scratch folder (removed when this ends). This can take a while."
if ! "${RESTIC[@]}" restore "${RESTORE_ARGS[@]}" --target "$SCRATCH" \
     --include "$REQUIRED_PATH" --include /srv/lares/agents --include /srv/lares/retired \
     --include /srv/lares/installation --include /srv/taste --include /srv/vault --include /var/lib/lares-vault-git </dev/null; then
  die "restic could not restore snapshot '$SNAPSHOT' (its message is above). Check the snapshot id, the network and the repository password. Nothing on this server was changed." "$EX_REFUSED"
fi

# --- 7. the snapshot must hold what a restore needs -----------------------------------------------
DUMP_DIR="$SCRATCH$REQUIRED_PATH"
[ -f "$DUMP_DIR/$DB_NAME.dump" ] || die "the snapshot has no $DB_NAME.dump, so it does not hold the main database. Choose another snapshot. Nothing was changed." "$EX_REFUSED"

DUMPS=()
for f in "$DUMP_DIR"/*.dump; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .dump)
  # These names go into database commands: only plain lower-case names pass.
  printf '%s' "$name" | grep -Eq '^[a-z0-9_]+$' || die "the snapshot holds a database dump with the unsafe name '$name'. Names may only use a-z, 0-9 and _. Refusing the whole snapshot. Nothing was changed." "$EX_REFUSED"
  DUMPS+=("$name")
done
[ "${#DUMPS[@]}" -gt 0 ] || die "the snapshot holds no database dumps. Nothing was changed." "$EX_REFUSED"
[ -d "$SCRATCH/srv/lares/agents" ] || die "the snapshot has no agents folder (/srv/lares/agents), so it is not a complete backup. Choose another snapshot. Nothing was changed." "$EX_REFUSED"

# The snapshot's migration record, read straight out of the dump without touching any database
# (pg_restore with -f - and no -d never connects). A snapshot written by a NEWER release than
# this checkout cannot be understood by this checkout.
LEDGER=$(db_run pg_restore --data-only --table=schema_migrations -f - < "$DUMP_DIR/$DB_NAME.dump" 2>/dev/null \
  | tr -d '\r' | awk -F'\t' '
      /^COPY .*schema_migrations \(/ {
        cols = $0; sub(/^[^(]*\(/, "", cols); sub(/\).*$/, "", cols)
        n = split(cols, c, /, */); col = 0
        for (i = 1; i <= n; i++) if (c[i] == "filename") col = i
        incopy = (col > 0); next }
      incopy && /^\\\.$/ { incopy = 0; next }
      incopy { print $col }') || LEDGER=""
[ -n "$LEDGER" ] || die "I could not read the migration record out of $DB_NAME.dump, so I cannot tell which release wrote this snapshot. Nothing was changed." "$EX_REFUSED"
SNAP_NEWEST=$(printf '%s\n' "$LEDGER" | LC_ALL=C sort | tail -1)
OWN_NEWEST=$(for f in "$BOX_DIR"/sql/[0-9]*.sql; do [ -e "$f" ] && basename "$f"; done | LC_ALL=C sort | tail -1) || OWN_NEWEST=""
[ -n "$OWN_NEWEST" ] || die "I found no migration files in $BOX_DIR/sql, so I cannot compare releases. Nothing was changed." "$EX_REFUSED"
if [ "$(printf '%s\n%s\n' "$SNAP_NEWEST" "$OWN_NEWEST" | LC_ALL=C sort | tail -1)" != "$OWN_NEWEST" ]; then
  die "the snapshot comes from a newer release (its newest database change is $SNAP_NEWEST; this checkout only knows up to $OWN_NEWEST). Check out the same or a newer release, run install.sh with it, then restore. Nothing was changed." "$EX_REFUSED"
fi

# The agents' token folder must have arrived with the secrets, or every door and outside tool
# would have to be reconnected by hand.
AGENT_NAMES=()
for d in "$SCRATCH/srv/lares/agents"/*/; do
  [ -d "$d" ] || continue
  AGENT_NAMES+=("$(basename "$d")")
done
if [ "${#AGENT_NAMES[@]}" -gt 0 ] && { [ ! -d "$SECRETS_DIR" ] || [ -z "$(ls -A "$SECRETS_DIR" 2>/dev/null)" ]; }; then
  die "the snapshot holds ${#AGENT_NAMES[@]} agent(s) but $SECRETS_DIR (the agents' token folder) is empty here. Copy srv/lares/secrets/ from the decrypted bundle first (docs/install.md, \"Restoring onto a new server\"). Nothing was changed." "$EX_REFUSED"
fi
[ -r "$ETC_LARES/secrets/database-password" ] || die "$ETC_LARES/secrets/database-password is missing, so the migration step could not sign in. Copy etc/lares/secrets/ from the decrypted bundle and run install.sh. Nothing was changed." "$EX_REFUSED"

# Validate complete incoming files first. The owner/area comparison uses the actual
# restored snapshot database, never current grants or a guessed COPY-text parser.
VAULT_INCOMING_PRESENT=0
if [ -r "$HERE/vault-storage.sh" ];then
  vault_storage_load "$SCRATCH" || die 'snapshot Vault inventory or either storage root is missing or conflicting' "$EX_REFUSED"
  VAULT_INCOMING_PRESENT="$VAULT_STORAGE_PRESENT"
  vault_storage_verify "$SCRATCH" "$DB_NAME" verify-files >/dev/null || die 'snapshot Vault Git integrity or local origin pairing failed' "$EX_REFUSED"
  if [ "$VAULT_INCOMING_PRESENT" = 1 ] || [ -r "$OPT_LARES/vault-recovery-engine-image" ];then
    VAULT_SNAPSHOT_DB="drill_vault_restore_$$"
    db_run createdb -U "$DB_USER" -O lares_operator "$VAULT_SNAPSHOT_DB" </dev/null || die 'cannot create the private snapshot verification database' "$EX_REFUSED"
    db_run pg_restore --exit-on-error -U "$DB_USER" -d "$VAULT_SNAPSHOT_DB" < "$DUMP_DIR/$DB_NAME.dump" || die 'snapshot database could not be verified before restoration' "$EX_REFUSED"
    vault_storage_verify "$SCRATCH" "$VAULT_SNAPSHOT_DB" verify-snapshot >/dev/null || die 'snapshot Vault metadata, ownership and stored markers disagree' "$EX_REFUSED"
    db_run dropdb -U "$DB_USER" "$VAULT_SNAPSHOT_DB" </dev/null || die 'snapshot verification database could not be removed' "$EX_REFUSED"
    VAULT_SNAPSHOT_DB=""
  fi
fi

say "the snapshot is usable: ${#DUMPS[@]} database dump(s), ${#AGENT_NAMES[@]} agent folder(s), newest database change $SNAP_NEWEST."

# Custody is not part of a database backup. Missing prepared custody must never look like
# an unprepared legacy install. Read-only, including on --dry-run; no journal file is opened.
FINANCIAL_PREPARED=$(python3 - "$KEEPER_JSON" "$(P /var/lib/lares/budget-financial)" <<'PYFINANCIAL'
import json, os, sys
try:
    config = json.load(open(sys.argv[1]))
    if 'budgetFinancial' in config:
        financial = config['budgetFinancial']
        app = config['db']
        fields = {'host', 'port', 'database', 'user', 'passwordFile'}
        if not isinstance(app, dict) or set(app) != fields or app['user'] != 'lares_app':
            raise ValueError('invalid app database binding')
        if not isinstance(financial, dict) or set(financial) != {'directory', 'db'} or financial['directory'] != '/var/lib/lares/budget-financial':
            raise ValueError('invalid financial binding')
        db = financial['db']
        if not isinstance(db, dict) or set(db) != fields or db['user'] != 'lares_financial':
            raise ValueError('invalid financial database binding')
        if any(not isinstance(db[k], str) or not db[k] for k in ('host', 'database')) or not isinstance(db['port'], int) or db['port'] < 1 or db['port'] > 65535:
            raise ValueError('invalid financial database coordinates')
        if any(db[k] != app[k] for k in ('host', 'port', 'database')):
            raise ValueError('financial database must match the engine database')
        if any(not isinstance(value, str) or not value.startswith('/') for value in (app['passwordFile'], db['passwordFile'])):
            raise ValueError('invalid database password file')
        if not os.path.isdir(sys.argv[2]) or os.path.islink(sys.argv[2]):
            raise ValueError('prepared custody is missing')
        print('1')
    else:
        if os.path.lexists(sys.argv[2]):
            raise ValueError('unbound custody needs recovery')
        print('0')
except Exception:
    sys.exit(1)
PYFINANCIAL
) || die 'financial custody is missing, unsafe or unbound; recovery is required before restore. Nothing was changed.' "$EX_REFUSED"
if [ "$FINANCIAL_PREPARED" = 0 ];then
  say 'financial custody is not configured (legacy inactive path)'
fi
NATIVE_PREPARED=$(python3 - "$KEEPER_JSON" "$(P /var/lib/lares/budget-native)" <<'PYNATIVE'
import json, os, sys
try:
    config = json.load(open(sys.argv[1]))
    if 'budgetNative' in config:
        if config['budgetNative'] != {'directory': '/var/lib/lares/budget-native'} or 'budgetFinancial' not in config:
            raise ValueError('invalid native binding')
        if not os.path.isdir(sys.argv[2]) or os.path.islink(sys.argv[2]):
            raise ValueError('prepared native custody is missing')
        print('1')
    else:
        if os.path.lexists(sys.argv[2]):
            raise ValueError('unbound native custody needs recovery')
        print('0')
except Exception:
    sys.exit(1)
PYNATIVE
) || die 'native custody is missing, unsafe or unbound; recovery is required before restore. Nothing was changed.' "$EX_REFUSED"
if [ "$NATIVE_PREPARED" = 1 ];then
  say 'prepared native custody is recorded outside backups and will be drained before restore'
fi

# --- 8. dry run stops here ----------------------------------------------------------------------------
if [ "$DRY" = 1 ]; then
  say "dry run: nothing on this server was changed. With these answers I would:"
  say "  1. drain configured native cleanup and permanently freeze prepared financial custody, then stop the keeper, console, caddy and the model gateway (the database stays up)"
  say "  2. drop, recreate and restore these databases from the snapshot: ${DUMPS[*]}"
  say "  3. apply any newer database changes (pnpm -C services/box migrate)"
  say "  4. copy the agents, retired, taste and installation folders from the snapshot, keeping owners and modes"
  say "  5. start the base stack, then the keeper"
  say "  and then print the steps that stay yours."
  exit "$EX_OK"
fi

# --- 9. the owner's last say --------------------------------------------------------------------------
if [ "$ASSUME_YES" != 1 ]; then
  say "This replaces EVERY database on this server with snapshot $SNAPSHOT, and copies the agents, retired, taste and installation folders over."
  printf 'restore: is the OLD server switched off? Two live servers would both answer chat and both write to the backup repository. Type stopped to confirm: ' >&2
  ans=""; IFS= read -r ans || ans=""
  [ "$ans" = "stopped" ] || die "not confirmed, so nothing was changed." "$EX_REFUSED"
  printf 'restore: replace this server with snapshot %s now? [y/N] ' "$SNAPSHOT" >&2
  ans=""; IFS= read -r ans || ans=""
  case "$ans" in y|Y|yes|YES) ;; *) die "not confirmed, so nothing was changed." "$EX_REFUSED" ;; esac
fi

# --- 10. from here on, things change ---------------------------------------------------------------------
CHANGED="nothing yet"
midway() { # midway <what failed>
  die "$1 This restore is only part done. Already changed: $CHANGED. The services that were stopped stay stopped. This server is no longer a fresh install, so do not simply run restore.sh again: rebuild a clean server, run install.sh, then restore. The backup repository was never written to." "$EX_TEMPFAIL"
}
# valid_name: the last guard in front of any database command.
valid_name() { printf '%s' "$1" | grep -Eq '^[a-z0-9_]+$'; }

# Persist the exact, trusted compose selection in keeper.env. Future `docker compose
# --env-file /etc/lares/keeper.env` calls therefore keep the prepared Vault overlay selected.
write_keeper_compose_selection() { # 0 base only; 1 verified Vault inventory and overlay
  local include_vault="$1" temporary
  temporary=$(mktemp "$ETC_LARES/.keeper.env.XXXXXX") || midway 'Could not prepare the keeper compose selection.'
  if ! awk -F= '$1 != "COMPOSE_FILE" && $1 != "LARES_VAULT_WORKING_ROOT" && $1 != "LARES_VAULT_BARE_ROOT"' "$KEEPER_ENV" > "$temporary"; then
    rm -f "$temporary"
    midway 'Could not read the existing keeper environment while selecting its compose files.'
  fi
  if [ "$include_vault" = 1 ]; then
    [ -f "$KEEPER_VAULT_COMPOSE_SOURCE" ] || midway 'The release is missing the optional keeper Vault compose file.'
    if [ -e "$KEEPER_VAULT_COMPOSE" ]; then
      cmp -s "$KEEPER_VAULT_COMPOSE_SOURCE" "$KEEPER_VAULT_COMPOSE" || midway 'The installed keeper Vault compose file differs from this release; reconcile it before restore.'
    else
      cp -p "$KEEPER_VAULT_COMPOSE_SOURCE" "$KEEPER_VAULT_COMPOSE" || midway 'Could not install the verified keeper Vault compose file.'
    fi
    printf 'LARES_VAULT_WORKING_ROOT="%s"\nLARES_VAULT_BARE_ROOT="%s"\nCOMPOSE_FILE="%s:%s"\n' \
      "$(P /srv/vault)" "$(P /var/lib/lares-vault-git)" "$KEEPER_COMPOSE" "$KEEPER_VAULT_COMPOSE" >> "$temporary" || midway 'Could not save the prepared keeper compose selection.'
  else
    printf 'COMPOSE_FILE="%s"\n' "$KEEPER_COMPOSE" >> "$temporary" || midway 'Could not save the base keeper compose selection.'
  fi
  chmod 0640 "$temporary" && mv -f "$temporary" "$KEEPER_ENV" || midway 'Could not install the selected keeper compose environment.'
}

# A host-only action stops admission synchronously, drains the current owner boundedly,
# fsyncs a permanent freeze under the lifetime kernel lock, then acknowledges. If the keeper
# is unavailable, the host command must acquire that SAME lock; contention stops restore.
if [ "$FINANCIAL_PREPARED" = 1 ];then
  say 'draining native custody and permanently freezing prepared financial custody before stopping any service'
  if ! keeper_dc exec -T lares-keeper \
    /app/services/keeper/node_modules/.bin/tsx /app/services/keeper/bin/budget-financial.ts freeze --host </dev/null;then
    if [ "$ENGINE_MODE" = image ];then
      engine_run --ro "$KEEPER_JSON" --rw "$(P /var/lib/lares)" ../keeper/bin/budget-financial.ts freeze --host "$KEEPER_JSON" </dev/null \
        || die 'financial freeze was not durably acknowledged; no service was stopped and no database was replaced' "$EX_REFUSED"
    else
      pnpm -C "$BOX_DIR/../keeper" exec tsx bin/budget-financial.ts freeze --host "$KEEPER_JSON" </dev/null \
        || die 'financial freeze was not durably acknowledged; no service was stopped and no database was replaced' "$EX_REFUSED"
    fi
  fi
  CHANGED='financial custody is permanently frozen'
fi

say "stopping the keeper, then console, caddy and the model gateway (the database stays up)"
keeper_dc stop </dev/null || midway "Could not stop the keeper."
CHANGED="the keeper is stopped"
dc stop console caddy lares-gateway </dev/null || midway "Could not stop console, caddy and the gateway."
CHANGED="the keeper, console, caddy and gateway are stopped"
if [ "$VAULT_TARGET_PRESENT" = 1 ];then
  PRESERVE_SCRATCH=1
  vault_storage_stage_empty "${PREFIX%/}" "$SCRATCH" || midway 'Could not stage the exact empty target Vault stores.'
  vault_storage_unlock
  CHANGED="$CHANGED; exact empty target Vault stores retained in private staging"
fi

restore_database() { # restore_database <name> <already-exists: 0|1>
  local db="$1" existing="$2" owner
  valid_name "$db" || midway "Refused to touch a database named '$db'."
  case "$db" in
    lares_state) owner=lares_schema_owner ;;
    litellm) owner=lares_gateway ;;
    postgres) owner=postgres ;;
    lares_[a-f0-9][a-f0-9][a-f0-9][a-f0-9]*)
      printf '%s' "$db" | grep -Eq '^lares_[a-f0-9]{32}$' || midway "Refused unknown workflow database '$db'."
      owner=lares_workflow_owner ;;
    *) midway "Refused database '$db' because its intended owner is unknown." ;;
  esac
  say "restoring database $db"
  if [ "$existing" = 0 ]; then
    db_run dropdb -U "$DB_USER" --if-exists --force "$db" </dev/null || midway "Could not drop database $db."
    CHANGED="$CHANGED; database $db dropped"
    # Fresh custom-format dumps include database metadata. Let pg_restore create the database
    # from that archive so its owner, comment and database ACL survive alongside object grants.
    db_run pg_restore --exit-on-error --create -U "$DB_USER" -d postgres < "$DUMP_DIR/$db.dump" \
      || midway "pg_restore could not create database $db with its archived ownership and grants."
    CHANGED="$CHANGED; database $db restored"
    return 0
  fi
  db_run pg_restore --exit-on-error -U "$DB_USER" -d "$db" < "$DUMP_DIR/$db.dump" \
    || midway "pg_restore of database $db failed."
  CHANGED="$CHANGED; database $db restored"
}
for db in "${DUMPS[@]}"; do
  [ "$db" != postgres ] || continue
  restore_database "$db" 0
done
# PostgreSQL roles are recreated by the fresh installer with the fixed role names and safe
# flags. Object ownership and grants are restored from each database archive; global role
# passwords stay with this host's explicitly escrowed operator credential.
for db in "${DUMPS[@]}"; do
  [ "$db" = postgres ] || continue
  restore_database postgres 1
done

say "applying any newer database changes"
code=0
if [ "$ENGINE_MODE" = image ]; then
  engine_run --ro "$OPERATOR_PASSWORD_FILE" --env "DATABASE_PASSWORD_FILE=$OPERATOR_PASSWORD_FILE" \
    --env "LARES_OPERATOR_PASSWORD_FILE=$OPERATOR_PASSWORD_FILE" \
    --env "PGHOST=${PGHOST:-127.0.0.1}" --env "PGPORT=${PGPORT:-5432}" \
    --env "PGDATABASE=$DB_NAME" --env "PGUSER=$DB_USER" migrate.ts --schema-owner || code=$?
else
  LARES_OPERATOR_PASSWORD_FILE="$OPERATOR_PASSWORD_FILE" DATABASE_PASSWORD_FILE="$OPERATOR_PASSWORD_FILE" \
    PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGDATABASE="$DB_NAME" PGUSER="$DB_USER" \
    pnpm -C "$BOX_DIR" migrate -- --schema-owner || code=$?
fi
[ "$code" -eq 0 ] || midway "The database migration did not finish (exit $code)."
CHANGED="$CHANGED; migrations applied"

if [ "$ENGINE_MODE" = image ]; then
  engine_run --ro "$OPERATOR_PASSWORD_FILE" --ro "$ENGINE_APP_PASSWORD_FILE" --ro "$ENGINE_FINANCIAL_PASSWORD_FILE" --ro "$ENGINE_OUTSIDE_CUSTODY_PASSWORD_FILE" \
    --env "DATABASE_PASSWORD_FILE=$OPERATOR_PASSWORD_FILE" --env "LARES_OPERATOR_PASSWORD_FILE=$OPERATOR_PASSWORD_FILE" \
    --env "PGHOST=127.0.0.1" --env "PGPORT=${PGPORT:-5432}" --env "PGDATABASE=lares_state" --env "PGUSER=lares_operator" \
    bin/database-setup.ts --prepare-restored-engine --operator-password-file "$OPERATOR_PASSWORD_FILE" \
    --app-password-file "$ENGINE_APP_PASSWORD_FILE" --financial-password-file "$ENGINE_FINANCIAL_PASSWORD_FILE" \
    --outside-custody-password-file "$ENGINE_OUTSIDE_CUSTODY_PASSWORD_FILE" \
    || midway 'Restored engine ownership or database grants do not match the required role boundary.'
else
  LARES_OPERATOR_PASSWORD_FILE="$OPERATOR_PASSWORD_FILE" DATABASE_PASSWORD_FILE="$OPERATOR_PASSWORD_FILE" \
    PGHOST=127.0.0.1 PGPORT="${PGPORT:-5432}" PGDATABASE=lares_state PGUSER=lares_operator \
    pnpm -C "$BOX_DIR" exec tsx bin/database-setup.ts --prepare-restored-engine \
    --operator-password-file "$OPERATOR_PASSWORD_FILE" --app-password-file "$ENGINE_APP_PASSWORD_FILE" \
    --financial-password-file "$ENGINE_FINANCIAL_PASSWORD_FILE" \
    --outside-custody-password-file "$ENGINE_OUTSIDE_CUSTODY_PASSWORD_FILE" \
    || midway 'Restored engine ownership or database grants do not match the required role boundary.'
fi

# Prove every restored per-agent database still has its recorded owner marker and the exact
# restricted runtime ACL before any Keeper or agent service is restarted.
WORKFLOW_ROWS=$(db_run psql -U "$DB_USER" -d "$DB_NAME" -F $'\t' -Atc \
  "SELECT a.workflow_database, a.ownership, a.ownership_token, COALESCE(pg_get_userbyid(d.datdba),''), COALESCE(shobj_description(d.oid,'pg_database'),'') FROM agent_resources a LEFT JOIN pg_database d ON d.datname=a.workflow_database WHERE a.workflow_database IS NOT NULL ORDER BY a.workflow_database") \
  || midway 'Could not verify restored workflow database ownership records.'
WORKFLOW_PASSWORD_FILE=$(python3 - "$KEEPER_JSON" <<'PYWORKFLOW'
import json, sys
try:
    cfg=json.load(open(sys.argv[1]))
    value=cfg['lifecycle']['runtime']['workflowPasswordFile']
    if not isinstance(value,str) or not value.startswith('/'):
        raise ValueError()
    print(value)
except Exception:
    raise SystemExit(1)
PYWORKFLOW
) || midway 'Keeper configuration has no explicit workflow runtime password file.'
WORKFLOW_DATABASES=()
while IFS=$'\t' read -r workflow_db ownership token db_owner marker; do
  [ -n "$workflow_db" ] || continue
  printf '%s' "$workflow_db" | grep -Eq '^lares_[a-f0-9]{32}$' \
    || midway "Restored workflow database name '$workflow_db' is unsupported."
  [ "$ownership" = owned ] && printf '%s' "$token" | grep -Eq '^[0-9a-f-]{36}$' \
    && [ "$db_owner" = lares_workflow_owner ] && [ "$marker" = "lares-owned:$token" ] \
    || midway "Workflow database $workflow_db ownership could not be verified."
  found=0
  for dumped in "${DUMPS[@]}"; do [ "$dumped" = "$workflow_db" ] && found=1; done
  [ "$found" = 1 ] || midway "Workflow database $workflow_db has no restored archive."
  WORKFLOW_DATABASES+=("$workflow_db")
done <<< "$WORKFLOW_ROWS"
for dumped in "${DUMPS[@]}"; do
  case "$dumped" in
    lares_[a-f0-9][a-f0-9][a-f0-9][a-f0-9]*)
      printf '%s' "$dumped" | grep -Eq '^lares_[a-f0-9]{32}$' || midway "Restored database '$dumped' has an unsupported name."
      found=0
      for known in "${WORKFLOW_DATABASES[@]}"; do [ "$known" = "$dumped" ] && found=1; done
      [ "$found" = 1 ] || midway "Restored workflow database $dumped has no matching ownership record."
      ;;
  esac
done
if [ "${#WORKFLOW_DATABASES[@]}" -gt 0 ]; then
  [ -r "$WORKFLOW_PASSWORD_FILE" ] && [ ! -L "$WORKFLOW_PASSWORD_FILE" ] \
    || midway 'Workflow runtime credential is missing or unsafe; restored agents remain stopped.'
  for workflow_db in "${WORKFLOW_DATABASES[@]}"; do
    if [ "$ENGINE_MODE" = image ]; then
      engine_run --ro "$WORKFLOW_PASSWORD_FILE" \
        --env "PGHOST=127.0.0.1" --env "PGPORT=${PGPORT:-5432}" \
        bin/workflow-template.ts verify-database --host 127.0.0.1 --port "${PGPORT:-5432}" \
        --database "$workflow_db" --runtime-password-file "$WORKFLOW_PASSWORD_FILE" \
        || midway "The restricted workflow login could not verify database $workflow_db."
    else
      pnpm -C "$BOX_DIR" exec tsx bin/workflow-template.ts verify-database --host 127.0.0.1 --port "${PGPORT:-5432}" \
        --database "$workflow_db" --runtime-password-file "$WORKFLOW_PASSWORD_FILE" \
        || midway "The restricted workflow login could not verify database $workflow_db."
    fi
  done
fi

# restic restored these as root, so each file keeps its numeric owner and mode; cp -a keeps them
# on the way in (the agent containers run as uid 10001 and read these folders by number).
copy_folder() { # copy_folder <from in scratch> <to on this server> <label>
  local from="$1" to="$2" label="$3"
  if [ ! -d "$from" ]; then
    say "the snapshot has no $label folder; leaving $to as it is"
    return 0
  fi
  mkdir -p "$to" || midway "Could not create $to."
  cp -a "$from/." "$to/" || midway "Could not copy the $label folder."
  CHANGED="$CHANGED; $label folder copied"
}
copy_folder "$SCRATCH/srv/lares/agents" "$SRV_LARES/agents" agents
copy_folder "$SCRATCH/srv/lares/retired" "$SRV_LARES/retired" retired
copy_folder "$SCRATCH/srv/taste" "$TASTE_DIR" taste
copy_folder "$SCRATCH/srv/lares/installation" "$SRV_LARES/installation" installation
if [ "$VAULT_INCOMING_PRESENT" = 1 ];then
  copy_folder "$SCRATCH/srv/vault" "$(P /srv/vault)" 'managed Vault working'
  copy_folder "$SCRATCH/var/lib/lares-vault-git" "$(P /var/lib/lares-vault-git)" 'managed Vault Git history'
fi
if [ -r "$HERE/vault-storage.sh" ];then
  vault_storage_load "${PREFIX%/}" || midway 'Restored Vault inventory is incomplete.'
  vault_storage_verify "${PREFIX%/}" "$DB_NAME" verify >/dev/null || midway 'Restored Vault database, files, ownership or Git pairing did not verify.'
  write_keeper_compose_selection "$VAULT_STORAGE_PRESENT"
fi
PRESERVE_SCRATCH=0

if [ "$FINANCIAL_PREPARED" = 1 ];then
  say 'starting the base stack and requesting keeper start; prepared financial custody remains frozen'
else
  say "starting the base stack, then the keeper"
fi
dc up -d </dev/null || midway "Could not start the base stack."
CHANGED="$CHANGED; base stack started"
keeper_dc up -d </dev/null || midway "Could not start the keeper."
if [ "$FINANCIAL_PREPARED" = 1 ];then
  CHANGED="$CHANGED; keeper start requested (financial recovery required)"
  say "restored snapshot $SNAPSHOT: ${#DUMPS[@]} database(s), ${#AGENT_NAMES[@]} agent folder(s)."
  say 'Financial recovery is required. Protected custody remains permanently frozen; keeper startup refuses that custody.'
  say 'A detached compose start does not prove keeper, runtime or spending readiness. Keep agents stopped.'
  say 'Owner-directed reconciliation must preserve unknown liabilities and suppression, then invalidate restored console, resume and job authority before any fresh caps, keys or profiles.'
  say 'This release does not implement that reconciliation. Do not remove custody files, rerun fresh preparation or apply agents to bypass recovery.'
  exit "$EX_OK"
fi
CHANGED="$CHANGED; keeper started"

# --- 11. what is left for you -------------------------------------------------------------------------------
say "restored snapshot $SNAPSHOT: ${#DUMPS[@]} database(s), ${#AGENT_NAMES[@]} agent folder(s). The agents themselves are NOT running yet; step 4 below starts them."
say ""
say "What is left, in this order:"
step=1
say "  $step. Google connection, once per organisation: add GOOGLE_CLIENT_ID_<ORG> and GOOGLE_CLIENT_SECRET_<ORG> to /etc/lares/console-oauth.env if they are not already there, then run:"
say "       python3 $HERE/configure-google-keeper.py --org <org>"
say "       and restart only the keeper: env -u COMPOSE_FILE docker compose --env-file /etc/lares/keeper.env restart"
step=$((step + 1))
say "  $step. Point DNS for $RESTORED_DOMAIN at THIS server (the old server must stay off)."
# The installer only mounts the deadline calendar when the file is there when it runs, and the
# restore put it back AFTER that run, so the console and the chief of staff do not see it yet.
# Re-running the installer is the one place that wires it, but it needs this domain to already
# point at this server (it checks), so it is printed here, after the DNS step, not run.
if [ -f "$SRV_LARES/installation/deadline-calendar.json" ]; then
  step=$((step + 1))
  say "  $step. Deadline calendar: the restored calendar is not connected to the console and the agents yet. Once DNS points here, run the installer again with the same release; it reuses everything and mounts the calendar:"
  say "       ./services/box/ops/install.sh --yes --release releases/<release-file>.json"
fi
step=$((step + 1))
say "  $step. Sign in to the console at https://$RESTORED_DOMAIN/ and open each agent."
# The agent's plaintext model-gateway key lives in the token folder (<agent>-gateway-key), which
# came back with the secrets, so the key helper is only needed for an agent whose key file is
# not there.
NO_KEY=()
for n in ${AGENT_NAMES[@]+"${AGENT_NAMES[@]}"}; do
  [ -e "$SECRETS_DIR/$n-gateway-key" ] || NO_KEY+=("$n")
done
step=$((step + 1))
if [ "${#NO_KEY[@]}" -eq 0 ]; then
  say "  $step. Model gateway keys: nothing to do. Every agent's key file came back with the token folder, so rotate-restored-gateway-key.py is not needed."
else
  say "  $step. Model gateway keys: these agents have no key file in the token folder: ${NO_KEY[*]}. BEFORE applying each one (the next step), run:"
  for n in "${NO_KEY[@]}"; do
    say "       python3 $HERE/rotate-restored-gateway-key.py --agent $n            (checks only)"
    say "       python3 $HERE/rotate-restored-gateway-key.py --agent $n --execute"
  done
fi
step=$((step + 1))
say "  $step. Apply each agent once: press \"Start agent (applies saved definition)\" when it is stopped, or \"Apply connection changes (restarts agent)\" when the console offers that instead."
if [ "${#AGENT_NAMES[@]}" -gt 0 ]; then
  say "       agents in this snapshot: ${AGENT_NAMES[*]}"
fi
# Telegram caches the address of the webhook host, so after the DNS change it keeps sending to the
# old server. Registering the webhook again makes it look the address up again. The keeper's
# registration needs the agent applied, so it is a step for after the apply step, not something
# this script can do now.
HAS_TELEGRAM=0
for n in ${AGENT_NAMES[@]+"${AGENT_NAMES[@]}"}; do
  if [ -e "$SECRETS_DIR/$n-telegram-token" ]; then HAS_TELEGRAM=1; fi
done
if [ "$HAS_TELEGRAM" -eq 1 ]; then
  step=$((step + 1))
  say "  $step. Telegram: Telegram remembers the OLD server's address, so the first messages would time out. After the agent is applied, open the agent in the console, go to its Telegram door and press \"Register Telegram webhook\" once. Messages are delivered to this server from then on."
fi
if [ -n "${LARES_WORKFLOW_VOLUMES:-}" ]; then
  step=$((step + 1))
  say "  $step. This restore does not bring back the retained file volumes named in backup.env (${LARES_WORKFLOW_VOLUMES}); the snapshot carries them, but copying them back is still a manual job."
fi
step=$((step + 1))
say "  $step. Check: sign in at https://$RESTORED_DOMAIN/; send one chat message to an agent and read the reply; open the Backup page and confirm the next backup is scheduled (run lares backups again if it is not)."
say ""
say "Still unproven until it has been done on a real second server: the saved sign-ins decrypting with the restored key, a chat door answering, and a full agent conversation."
exit "$EX_OK"
