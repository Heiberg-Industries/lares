#!/usr/bin/env bash
# restore-drill.sh — the monthly REHEARSED restore (LAR-54-s3, ORB-187 design doc
# "Restore, rehearsed"). backup-verify.sh proves a snapshot exists and looks complete;
# it never opens the archive and checks the contents actually come back out as a
# working database. This is the one script that does: restore the newest nightly
# snapshot's dumps and a couple of directories into a SCRATCH location, load each dump
# into a THROWAWAY database, compare its table count against the live database, and
# record the verdict where the owner (eventually the console, s5) can see it.
#
# WHY A SCRATCH DATABASE, NOT THE LIVE ONE (decided 2026-09-04). Restoring INTO a live
# database to "check" it is not a check, it is an outage waiting to happen the first
# time the dump is stale or the restore is interrupted. A scratch database proves
# exactly the same thing — pg_restore succeeds and the table count is plausible —
# without ever writing to anything the fleet depends on. The live database is touched
# in this script for READS ONLY (a table count), never a write.
#
# WHY THE drill_ PREFIX IS ENFORCED IN CODE, NOT JUST BY CONVENTION. This script CREATEs
# and DROPs databases on the box that runs production Postgres. A bug that computed the
# wrong name, or a stray argument, dropping a real database is not a bug this script
# gets a second chance on. So the name is built in exactly one place (drill_db_name),
# and every CREATE/DROP re-validates that name against `^drill_[a-z0-9_]+$`
# immediately before running — not once at the top, not "trust the caller".
#
# WHY THE TRAP IS UNCONDITIONAL. A restore drill that fails halfway through, or is
# killed by a deploy, must not leave scratch databases sitting on the box (they would
# never be dropped again, and the next month's drill would collide with the same
# epoch-suffixed names badly enough to be confusing) or a scratch directory sitting on
# disk (this box has already run itself low on disk once — see disk-guard.sh). The
# EXIT/INT/TERM trap therefore always runs cleanup, on the pass path, the fail path and
# a `kill` alike, and never assumes anything it is about to remove is safe to remove
# without checking it first (see remove_scratch below).
#
# WHY NO HEARTBEAT PING. backup-verify.sh is the single liveness owner for the backup
# system (ADR-0012 rule 4, restated in that script's own header) — one job, one alert.
# This script only records its verdict in backup_status; a later slice (LAR-54-s4) adds
# the check that a stale or failed drill raises backup-verify.sh's alarm, the same way
# a stale snapshot does today. Until that lands, a broken drill is visible only in the
# `drill` row and this unit's own systemd state, exactly as the design doc says: "record
# the pass date where the owner can see it" is this slice; "a drill that has not passed
# in 45 days is a DOWN" is the next one.
#
# Deploy: copy to /opt/agent-box/restore-drill.sh (chmod 0750, root) alongside
# agent-box-restore-drill.service/.timer. Runs monthly at 03:40 UTC — after that
# night's backup (03:00) has normally finished and before verify (05:00), hours
# before anyone is awake (06:00 UTC lands in the morning brief's own hour in Oslo
# summer time, and this script loads dumps into live Postgres right alongside it).
# Safe to run by hand: everything it writes is scratch, and it cleans up after
# itself. NOTE: at 03:40 the "newest nightly snapshot" it rehearses may still be
# LAST night's if tonight's backup is unusually slow or has not started yet — that
# is fine for a rehearsal; it proves the archive can be restored, not that tonight
# specifically succeeded (backup-verify.sh at 05:00 is what proves that).
set -euo pipefail

ENV_FILE="${AGENT_BOX_BACKUP_ENV:-/etc/agent-box/backup.env}"
# shellcheck source=/dev/null
source "$ENV_FILE"
export RESTIC_PASSWORD_FILE

DB_COMPOSE_DIR="${DB_COMPOSE_DIR:-/opt/agent-box}"
# The database and role this installation uses. Same overridable names ops/install.sh,
# ops/update.sh and lib/db.ts read, with the same defaults — an installation that kept the
# installation-specific database and role names sets PGDATABASE and PGUSER in this script's
# environment. See LAR-74 §3.
DB_USER="${PGUSER:-lares}"
DB_NAME="${PGDATABASE:-lares_state}"
# Same meaning as in backup-verify.sh: the path whose presence proves an archive
# actually carries the databases, not just everything around them.
REQUIRED_PATH="${BACKUP_REQUIRED_PATH:-/var/backups/pg}"
# The non-database directories the drill also proves come back readable. Space
# separated, same idiom as LARES_WORKFLOW_VOLUMES/BACKUP_IGNORED_PATHS elsewhere in
# this family of scripts — deliberately not an array, so an empty value never trips
# the "empty array under `set -u`" trap on macOS's bash 3.2.
DRILL_RESTORE_PATHS="${DRILL_RESTORE_PATHS:-/srv/lares /opt/agent-box}"
# A restored database is allowed to be a LITTLE smaller than live — a table created
# seconds after last night's dump is not a broken restore — but not dramatically
# smaller. 90% is a deliberately loose floor; it exists to catch "the dump restored to
# almost nothing", not to catch ordinary schema drift between backup and drill.
DRILL_TABLE_TOLERANCE_PCT="${DRILL_TABLE_TOLERANCE_PCT:-90}"
# NEVER /tmp: on the box /tmp can be a small tmpfs (RAM), and this script restores
# the vault, /opt/agent-box and every database dump into whatever this points at.
# /var/tmp is disk-backed on Linux by convention (and survives a reboot, which /tmp
# under systemd's tmpfiles rules does not) — an actively wrong default here would
# either fail loudly (out of space) or, worse, quietly eat RAM on a small box.
DRILL_SCRATCH_ROOT="${DRILL_SCRATCH_ROOT:-/var/tmp}"
# One configurable floor, not an estimate of the restore's real size — the archive
# can grow between drills and this is a monthly job, not a capacity planner. Raise
# it in backup.env if a real drill ever fails this check with room to spare.
DRILL_MIN_FREE_MB="${DRILL_MIN_FREE_MB:-5120}"

# --- 0. Scratch dir + the safety trap that always cleans it up ----------------------
# Every scratch database this run creates, space-separated (see the DRILL_RESTORE_PATHS
# comment above for why this is a string and not an array). Populated BEFORE each
# CREATE DATABASE is attempted, not after it succeeds, so a create that fails partway
# (e.g. the database exists on-disk but psql times out replying) still gets a DROP
# attempt in cleanup rather than being forgotten.
SCRATCH_DBS=""
SCRATCH=""
# Anchored on the CONFIGURED root, not derived from $SCRATCH after the fact — so the
# refusal in remove_scratch below holds even if $SCRATCH is ever corrupted to
# something outside it, rather than trusting whatever mktemp happened to return.
SCRATCH_ROOT="$DRILL_SCRATCH_ROOT"

# Refuses to touch the database unless its name is unambiguously a drill_ scratch
# database. Called again immediately before every single CREATE and DROP below — this
# function is cheap and the one place a wrong name must never slip through.
require_drill_name() {
  local name="$1"
  if [ -z "$name" ]; then
    echo "restore-drill: refusing — empty database name" >&2
    return 1
  fi
  case "$name" in
    drill_*) : ;;
    *)
      echo "restore-drill: refusing to touch database '$name' — does not start with drill_" >&2
      return 1
      ;;
  esac
  if [[ ! "$name" =~ ^drill_[a-z0-9_]+$ ]]; then
    echo "restore-drill: refusing to touch database '$name' — fails the drill_ safety pattern" >&2
    return 1
  fi
  return 0
}

# The one place the scratch database name is built, so there is exactly one thing to
# get right. Lower-cased and stripped of anything outside [a-z0-9_] first, because a
# live database's own name is not guaranteed to already satisfy require_drill_name's
# pattern (an upper-case letter would otherwise produce a name this script itself then
# refuses to create).
drill_db_name() {
  local db="$1" safe
  safe=$(printf '%s' "$db" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_' '_')
  printf 'drill_%s_%s' "$safe" "$EPOCH"
}

psql_exec_c() {
  local dbname="$1" sql="$2"
  docker compose -f "$DB_COMPOSE_DIR/compose.yaml" -f "$DB_COMPOSE_DIR/compose.override.yaml" \
    exec -T db psql -U "$DB_USER" -d "$dbname" -v ON_ERROR_STOP=1 -c "$sql"
}

# CREATE DATABASE cannot run inside a transaction/against the database being created,
# so this always connects to the always-present `postgres` database — never to a
# scratch or live database — to issue it.
create_drill_db() {
  local name="$1"
  require_drill_name "$name" || return 1
  psql_exec_c postgres "CREATE DATABASE \"$name\";"
}

# Used only from cleanup. Deliberately never calls fail() or exits non-zero: cleanup
# must finish trying to drop every OTHER scratch database even if one drop fails, and
# a database that fails to drop here is bookkeeping debt (a stray drill_* database),
# never a reason to mask the drill's own pass/fail result.
drop_drill_db() {
  local name="$1"
  require_drill_name "$name" || return 0
  psql_exec_c postgres "DROP DATABASE IF EXISTS \"$name\";" \
    || echo "restore-drill: could not drop scratch database $name — it may need manual cleanup ('DROP DATABASE IF EXISTS \"$name\";' against $DB_COMPOSE_DIR)" >&2
  return 0
}

# Refuses to remove anything that is not unambiguously the scratch directory THIS run
# created via mktemp: empty, "/", or outside DRILL_SCRATCH_ROOT (the configured root,
# captured into SCRATCH_ROOT before mktemp ever runs) are all refused outright, rather
# than trusting that $SCRATCH still holds what it was assigned. A trap that runs on
# every exit path — including a kill mid-script — is exactly the place a variable gone
# wrong turns into `rm -rf /`, so this is deliberately paranoid rather than clever.
remove_scratch() {
  if [ -z "$SCRATCH" ]; then
    echo "restore-drill: scratch dir was never set — nothing to remove" >&2
    return
  fi
  if [ "$SCRATCH" = "/" ]; then
    echo "restore-drill: refusing to remove '/'" >&2
    return
  fi
  if [ ! -d "$SCRATCH" ]; then
    return
  fi
  case "$SCRATCH" in
    "$SCRATCH_ROOT"/*) rm -rf "$SCRATCH" ;;
    *) echo "restore-drill: refusing to remove '$SCRATCH' — not under the scratch root ($SCRATCH_ROOT) this run created" >&2 ;;
  esac
}

cleanup() {
  local rc=$?
  local db
  for db in $SCRATCH_DBS; do
    drop_drill_db "$db"
  done
  remove_scratch
  exit "$rc"
}
trap cleanup EXIT INT TERM

# LAR-54-s6: identical to backup-verify.sh's function of the same name (scripts in
# this family are self-contained — no shared sourced helper — so it is duplicated, not
# imported). A RESTIC_REPOSITORY value can carry a password or key right inside the
# string (sftp:user:pw@host:/path, s3:https://key:secret@host/bucket, ...); this must
# never reach the database or a log line, so it strips "user[:pass]@" wherever it
# appears — right after a "scheme://" or directly after the restic scheme with no "//"
# at all — and leaves everything else, including a bare local path, untouched.
strip_target_credentials() {
  local v="$1"
  v=$(printf '%s' "$v" | sed -E 's#(://)[^/@]*@#\1#')
  v=$(printf '%s' "$v" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*:)?[^/@]*@#\1#')
  printf '%s' "$v"
}

# LAR-54-s2's technique, reused for the 'drill' row: SQL on STDIN (psql's `-c` does not
# interpolate `:'var'`), bounded so a hung docker/db never hangs the drill itself, and a
# failed record only warns — it must never change the drill's own exit code. There is
# no ping to sequence against here (this script sends none), so unlike
# backup-verify.sh's record_status there is nothing to prove runs "before" the record.
record_status() {
  local ok="$1" detail="$2"
  local target
  if [ -n "${RESTIC_REPOSITORY:-}" ]; then
    target=$(strip_target_credentials "$RESTIC_REPOSITORY")
  else
    target="rclone:${STORAGEBOX_HOST}:${RESTIC_REPO_PATH}"
  fi
  local sql
  sql=$(cat <<'SQL'
INSERT INTO backup_status (check_name, ok, checked_at, last_pass_at, detail, target)
VALUES (
  'drill',
  :'ok'::boolean,
  now(),
  CASE WHEN :'ok'::boolean THEN now() ELSE NULL END,
  :'detail',
  :'target'
)
ON CONFLICT (check_name) DO UPDATE SET
  ok           = EXCLUDED.ok,
  checked_at   = EXCLUDED.checked_at,
  last_pass_at = COALESCE(EXCLUDED.last_pass_at, backup_status.last_pass_at),
  detail       = EXCLUDED.detail,
  target       = EXCLUDED.target;
SQL
  )
  local recorded=1
  if command -v timeout >/dev/null 2>&1; then
    if printf '%s\n' "$sql" | timeout 20 docker compose -f "$DB_COMPOSE_DIR/compose.yaml" -f "$DB_COMPOSE_DIR/compose.override.yaml" \
          exec -T db psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
          -v ok="$ok" -v detail="$detail" -v target="$target" >/dev/null 2>&1
    then
      recorded=0
    fi
  else
    if printf '%s\n' "$sql" | docker compose -f "$DB_COMPOSE_DIR/compose.yaml" -f "$DB_COMPOSE_DIR/compose.override.yaml" \
          exec -T db psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
          -v ok="$ok" -v detail="$detail" -v target="$target" >/dev/null 2>&1
    then
      recorded=0
    fi
  fi
  [ "$recorded" -eq 0 ] \
    || echo "restore-drill: could not record status in backup_status (ok=$ok) — continuing; this only affects visibility, not the drill's own result" >&2
}

# Every failure path goes through here so every failure both explains itself on stderr
# and lands in the 'drill' row. The EXIT trap still fires after this exits 1, so scratch
# cleanup always runs regardless of where in the drill the failure happened.
fail() {
  echo "restore-drill: $1" >&2
  record_status false "$1"
  exit 1
}

# --- Scratch root: must exist, be writable, and have real room before we touch it --
# Checked before mktemp ever runs, so a misconfigured DRILL_SCRATCH_ROOT fails loudly
# with no scratch directory and no scratch database ever created — nothing for the
# trap to need to clean up.
if [ ! -d "$DRILL_SCRATCH_ROOT" ] || [ ! -w "$DRILL_SCRATCH_ROOT" ]; then
  fail "scratch root $DRILL_SCRATCH_ROOT does not exist or is not writable — set DRILL_SCRATCH_ROOT in backup.env to a disk-backed directory with room for a full restore"
fi

# `df -Pk` is the POSIX-portable form: it prints available space in fixed 1024-byte
# blocks in a predictable column on both the Linux box and a Mac dev shell, unlike
# `-h`/`-H`, whose human-readable units and column widths differ by platform. This is
# deliberately one configurable floor, not an estimate of what THIS restore needs —
# see the DRILL_MIN_FREE_MB comment above.
AVAIL_KB=$(df -Pk "$DRILL_SCRATCH_ROOT" | awk 'NR==2 {print $4}')
case "$AVAIL_KB" in
  ''|*[!0-9]*) fail "could not read free space on $DRILL_SCRATCH_ROOT from 'df -Pk' — treat an unreadable check as failing, never as passing" ;;
esac
AVAIL_MB=$(( AVAIL_KB / 1024 ))
[ "$AVAIL_MB" -ge "$DRILL_MIN_FREE_MB" ] \
  || fail "only ${AVAIL_MB}MB free on $DRILL_SCRATCH_ROOT, need at least ${DRILL_MIN_FREE_MB}MB (DRILL_MIN_FREE_MB) — freeing space (or pointing DRILL_SCRATCH_ROOT somewhere with more) comes before the next drill can run"

SCRATCH=$(mktemp -d "$DRILL_SCRATCH_ROOT/restore-drill.XXXXXX")
EPOCH=$(date +%s)

# LAR-54-s6: see backup.sh's own comment on the same branch — RESTIC_REPOSITORY set
# means "any restic repository", unset means this box's existing rclone-over-SSH form,
# unchanged.
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  RESTIC=(restic -r "$RESTIC_REPOSITORY")
else
  RCLONE_PROGRAM="ssh -p ${STORAGEBOX_PORT:-23} -i ${STORAGEBOX_SSH_KEY} ${STORAGEBOX_USER}@${STORAGEBOX_HOST}"
  RESTIC=(restic -o rclone.program="${RCLONE_PROGRAM}" -r "rclone:${RESTIC_REPO_PATH}")
fi

# --- 1. Which snapshot to rehearse ---------------------------------------------------
# Copied from backup-verify.sh: no jq (not installed on the box, and a script that
# checks the backup must not acquire a dependency that can itself go missing), and
# asserted against the NEWEST snapshot in isolation — `--latest 1` returns one object
# PER GROUP in a repository with several path-list generations, so "contains X"
# checks against the raw output answer from whichever old snapshot happens to have X.
SNAPS=$("${RESTIC[@]}" snapshots --tag nightly --json 2>&1) \
  || fail "cannot read the restic repository — a backup we cannot read back is not a backup: $SNAPS"

SNAP_OBJ=$(printf '%s' "$SNAPS" | sed 's/},{/}\n{/g' | tail -1)
# `|| true`: an empty repository ("[]") has no "short_id" to grep, and under
# `set -euo pipefail` a `grep -o` that matches nothing would abort the script right
# here instead of reaching the graceful "no nightly snapshot" fail() call below.
SNAP_ID=$(printf '%s' "$SNAP_OBJ" | grep -o '"short_id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
[ -n "$SNAP_ID" ] || fail "no nightly snapshot in the repository at all — there is nothing to rehearse a restore from"

# --- 2. Restore into the scratch directory -------------------------------------------
# ASSUMPTION (unconfirmed without a live run): `restic restore <id> --target DIR
# --include /a --include /b` recreates each included path in full under DIR (e.g. the
# dumps land at "$SCRATCH/var/backups/pg/..."), the way `restic restore` documents
# itself as doing. Everything below reads from that assumed layout.
RESTORE_INCLUDES=("$REQUIRED_PATH")
for p in $DRILL_RESTORE_PATHS; do
  RESTORE_INCLUDES+=("$p")
done
RESTIC_INCLUDE_ARGS=()
for inc in "${RESTORE_INCLUDES[@]}"; do
  RESTIC_INCLUDE_ARGS+=(--include "$inc")
done
"${RESTIC[@]}" restore "$SNAP_ID" --target "$SCRATCH" "${RESTIC_INCLUDE_ARGS[@]}" \
  || fail "restic restore of snapshot $SNAP_ID into $SCRATCH failed — cannot rehearse a restore that does not even run"

# --- 3. Assert the restore actually produced something --------------------------------
# The same shape of assertion backup-verify.sh makes against the archive: a restore
# that "succeeds" and produces nothing is not a passing drill, it is the drill's own
# version of the 2026-07-01→14 incident (a green run that archived no dump).
DUMP_DIR="$SCRATCH$REQUIRED_PATH"
[ -f "$DUMP_DIR/globals.sql" ] \
  || fail "restore of snapshot $SNAP_ID has no globals.sql under $DUMP_DIR — the restore produced nothing usable"

shopt -s nullglob
dumps=("$DUMP_DIR"/*.dump)
[ ${#dumps[@]} -gt 0 ] \
  || fail "restore of snapshot $SNAP_ID has no *.dump files under $DUMP_DIR — there is nothing to load into a scratch database"

MISSING_DIRS=""
for p in $DRILL_RESTORE_PATHS; do
  target_dir="$SCRATCH$p"
  if [ ! -d "$target_dir" ] || [ -z "$(ls -A "$target_dir" 2>/dev/null)" ]; then
    MISSING_DIRS="$MISSING_DIRS $p"
  fi
done
[ -z "$MISSING_DIRS" ] \
  || fail "restore of snapshot $SNAP_ID is missing or empty for:${MISSING_DIRS} — these directories should have come back with the snapshot's own content"

# --- 4. Load each dump into a throwaway database and compare table counts -----------
# Reads the LIVE database only to count its tables — never anything else, and never a
# write. `pg_tables` (not information_schema.tables) so views never inflate the count.
table_count() {
  local dbname="$1"
  docker compose -f "$DB_COMPOSE_DIR/compose.yaml" -f "$DB_COMPOSE_DIR/compose.override.yaml" \
    exec -T db psql -U "$DB_USER" -d "$dbname" -tAc \
    "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')" \
    2>/dev/null | tr -d '\r' | tr -d ' '
}

for dumpfile in "${dumps[@]}"; do
  db=$(basename "$dumpfile" .dump)
  drill_db=$(drill_db_name "$db")
  # Tracked BEFORE the create is attempted (and dropped with IF EXISTS in cleanup), so
  # a create that fails partway still gets a drop attempt instead of being forgotten.
  SCRATCH_DBS="$SCRATCH_DBS $drill_db"

  create_drill_db "$drill_db" \
    || fail "could not create scratch database $drill_db for $db — the restore drill cannot proceed (or the computed name failed the drill_ safety check)"

  # ASSUMPTION (unconfirmed without a live run): pg_restore, run through the db
  # container with no filename argument, reads the custom-format dump from its own
  # stdin the way its documentation says it does for "no input file name specified".
  docker compose -f "$DB_COMPOSE_DIR/compose.yaml" -f "$DB_COMPOSE_DIR/compose.override.yaml" \
      exec -T db pg_restore --no-owner -U "$DB_USER" -d "$drill_db" < "$dumpfile" \
    || fail "pg_restore into $drill_db failed for $dumpfile — the archived dump for $db does not restore cleanly"

  drill_count=$(table_count "$drill_db") || fail "could not read the table count of restored database $drill_db"
  live_count=$(table_count "$db") || fail "could not read the live table count of $db to compare the restore against"

  case "$drill_count" in
    ''|*[!0-9]*) fail "restored database $drill_db returned a non-numeric table count ('$drill_count') — treat an unreadable check as failing, never as passing" ;;
  esac
  case "$live_count" in
    ''|*[!0-9]*) fail "live database $db returned a non-numeric table count ('$live_count') — treat an unreadable check as failing, never as passing" ;;
  esac

  [ "$drill_count" -ge 1 ] \
    || fail "restored database $drill_db (from dump $db) has 0 tables — the dump restored to nothing"

  threshold=$(( live_count * DRILL_TABLE_TOLERANCE_PCT / 100 ))
  [ "$drill_count" -ge "$threshold" ] \
    || fail "restored $db has $drill_count tables, live $db has $live_count — below the ${DRILL_TABLE_TOLERANCE_PCT}% tolerance (needs at least $threshold)"
done

# --- 5. Record the verdict ------------------------------------------------------------
DUMP_COUNT=${#dumps[@]}
OK_MSG="OK — snapshot $SNAP_ID restored into scratch; $DUMP_COUNT database dump(s) loaded and within ${DRILL_TABLE_TOLERANCE_PCT}% of live table counts; $DRILL_RESTORE_PATHS restored non-empty"
echo "restore-drill: $OK_MSG"
record_status true "$OK_MSG"
