#!/usr/bin/env bash
# backup-verify.sh — the SINGLE liveness owner for the agent box's nightly backup.
#
# WHY THIS EXISTS (ORB-150). On 22, 23 and 24 August 2026 agent-box-backup.service
# failed three nights running and nobody found out; it surfaced by accident while
# writing an unrelated runbook. backup.sh had behaved perfectly — it hit its own
# "postgres unreachable — refusing to take an empty snapshot" guard and exited 1,
# exactly as designed. The design note said the rest out loud:
#
#   "exit non-zero so the heartbeat never fires and healthchecks.io alerts"
#
# That mechanism did not exist. `HC_URL=` in the deployed /etc/agent-box/backup.env
# was EMPTY, and backup.sh's `if [ -n "${HC_URL:-}" ]` therefore skipped the ping
# without a word — on the failing nights AND on every successful night before them.
# There was no healthchecks.io check to go red. Loud is only useful if something is
# listening, and nothing ever was.
#
# WHY A VERIFIER RATHER THAN A HEARTBEAT IN backup.sh. A heartbeat measures that the
# script RAN. This box has now twice been harmed by a run that succeeded and produced
# nothing: 13 days of empty snapshots (2026-07-01→14) and one database of three
# (2026-08-17→24). So this asks the ARCHIVE, not the job: is there a nightly snapshot
# in the repository, is it recent, and does it carry everything it is supposed to? A
# unit that never starts fails this check too — that is the point, since a unit that
# never starts produces no failure to alert on.
#
# WHAT ORB-154 ADDED. Recency alone was never enough, and ORB-151 proved it: the
# nightly ran green for weeks while `/srv/eve-marcel` — Marcel's entire live trip
# store — was in no snapshot at all, because the path list still named the pre-eve
# `/srv/marcel` and backup.sh's `[ -d "$p" ]` guard skipped the renamed one in
# silence. A separate bug had the dump loop taking one database of three. Both are
# the same shape: the backup RAN, and covered less than it claimed. So this now
# asserts COVERAGE as well as recency, and derives what "covered" means from the
# LIVE BOX rather than from a list kept in step by hand:
#
#   - every database Postgres currently has must have a dump inside the snapshot
#   - every directory currently under /srv must be inside the snapshot, unless it is
#     named in BACKUP_IGNORED_PATHS with a reason
#   - every dump must be a plausible size, not merely non-zero
#
# A rename therefore fails this check the next morning instead of being discovered
# during a restore. That is the whole point: a list a human maintains drifts, a list
# read from the running system cannot.
#
# WHY IT PINGS /fail RATHER THAN GOING SILENT. It used to signal failure by NOT
# pinging and letting healthchecks.io time out — which meant a real failure took the
# check's grace period (2h) to surface, and made the alert path impossible to test
# without waiting. An explicit /fail ping carries the REASON to the notification and
# arrives in seconds, so "induce the failure and watch the alert fire" is a thing
# anyone can do in a minute (ORB-154).
#
# ONE OWNER, ONE ALERT (ADR-0012 rule 4). backup.sh deliberately does NOT ping any
# more, and input-freshness.sh deliberately does NOT check the backup: two checks on
# one job means one incident arrives as two messages, which is the noise ADR-0012
# exists to stop. Failed backups route to #lares-operations (degradation needing
# action, not this hour) — never #lares-alerts.
#
# TIMING. The backup runs 03:00 UTC; this runs 05:00 UTC. With a 24h window a
# failure last night is caught THIS morning (newest snapshot ~26h old), not after a
# second missed night.
#
# Deploy: copy to /opt/agent-box/backup-verify.sh (chmod 0750, root) alongside
# agent-box-backup-verify.service/.timer. Reads only — safe to run by hand.
set -euo pipefail

ENV_FILE="${AGENT_BOX_BACKUP_ENV:-/etc/agent-box/backup.env}"
# shellcheck source=/dev/null
source "$ENV_FILE"
export RESTIC_PASSWORD_FILE

MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-24}"
# The dumps are the store with no upstream source of truth and the one whose absence
# went unnoticed for 13 days. A snapshot without this path is not a backup.
REQUIRED_PATH="${BACKUP_REQUIRED_PATH:-/var/backups/pg}"
# A dump smaller than this is a truncated write dressed as a backup. backup.sh uses
# 1 KiB as its own floor; this is deliberately a little higher, because by the time a
# dump reaches the archive it has a schema in it at minimum.
MIN_DUMP_BYTES="${BACKUP_MIN_DUMP_BYTES:-4096}"
# Directories under /srv that are intentionally NOT in the snapshot. Anything else
# down there is required, so a new store is covered by default and a store that is
# deliberately excluded has to say so out loud, here, in writing.
BACKUP_IGNORED_PATHS="${BACKUP_IGNORED_PATHS:-}"
DB_COMPOSE_DIR="${DB_COMPOSE_DIR:-/opt/agent-box}"
# The database and role this installation uses. Same overridable names ops/install.sh,
# ops/update.sh and lib/db.ts read, with the same defaults — an installation that kept the
# installation-specific database and role names sets PGDATABASE and PGUSER in this script's
# environment. See LAR-74 §3.
DB_USER="${PGUSER:-lares}"
DB_NAME="${PGDATABASE:-lares_state}"
# LAR-54-s4: how many days a restore drill (sql/049's 'drill' row, written by
# restore-drill.sh) may go without a pass before it counts as stale. The drill runs
# monthly, so 45 gives it a full cycle plus real slack before this pages anyone.
DRILL_MAX_AGE_DAYS="${DRILL_MAX_AGE_DAYS:-45}"

# LAR-54-s6: a RESTIC_REPOSITORY value (sftp:user:pw@host:/path, s3:https://key:secret@
# host/bucket, ...) can carry a password or key right inside the string. That must
# never reach the database or a log line, so this strips "user[:pass]@" wherever it
# appears — right after a "scheme://" (the s3 example above) or directly after the
# restic scheme with no "//" at all (the sftp example above) — and leaves everything
# else, including a bare local path, untouched. Used identically by backup-verify.sh
# and restore-drill.sh (the two scripts that record a `target`); backup.sh never
# writes or prints one, so it has no need of it.
strip_target_credentials() {
  local v="$1"
  v=$(printf '%s' "$v" | sed -E 's#(://)[^/@]*@#\1#')
  v=$(printf '%s' "$v" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*:)?[^/@]*@#\1#')
  printf '%s' "$v"
}

# LAR-54-s2: record this run's verdict in Postgres (sql/049_backup_status.sql) so the
# console can later show whether last night's backup was really verified. RULE: the
# ALERT always goes first, this bookkeeping always second and always bounded — callers
# ping (or refuse) BEFORE calling this, never after, so a hung docker/db never delays
# the one thing that pages someone. A failed or timed-out record only warns on stderr
# and never changes the exit code or the ping already sent (ADR-0012 rule 4: one owner
# of the alert). `target` deliberately carries no credentials: just the host and path,
# or (LAR-54-s6) RESTIC_REPOSITORY with any userinfo stripped.
record_status() {
  local ok="$1" detail="$2"
  local target
  if [ -n "${RESTIC_REPOSITORY:-}" ]; then
    target=$(strip_target_credentials "$RESTIC_REPOSITORY")
  else
    target="rclone:${STORAGEBOX_HOST}:${RESTIC_REPO_PATH}"
  fi
  # psql's `-c` does not interpolate `:'var'` — the SQL must go on STDIN for the `-v`
  # variables below to be substituted at all.
  local sql
  sql=$(cat <<'SQL'
INSERT INTO backup_status (check_name, ok, checked_at, last_pass_at, detail, target)
VALUES (
  'verify',
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
  # Bounded to 20s when `timeout` exists (the server has it; some Mac dev shells do
  # not) — a hung docker/db must never hang the script itself, only this bookkeeping.
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
    || echo "backup-verify: could not record status in backup_status (ok=$ok) — continuing; healthchecks.io remains the alert of record" >&2
}

# Every failure path goes through here, so every failure both tells the journal what
# happened AND puts the reason on the alert. Nothing about this script may fail
# silently — that is the failure mode it was written against.
fail() {
  echo "backup-verify: $1" >&2
  if [ -n "${HC_URL:-}" ]; then
    curl -fsS -m 15 --retry 2 --data-raw "backup-verify: $1" "${HC_URL}/fail" >/dev/null 2>&1 \
      || echo "backup-verify: could not reach healthchecks.io to report the failure" >&2
  fi
  record_status false "$1"
  exit 1
}

# The check that ORB-150 is actually about. An unconfigured heartbeat is the same
# silence as a missing one, so refuse to pretend: no URL, no verification, loud exit.
# systemd records a failed unit, which is visible even before anyone is listening.
# Note this one cannot route through fail() — there is nowhere to route it to.
if [ -z "${HC_URL:-}" ]; then
  EMPTY_HC_URL_MSG="HC_URL is empty in $ENV_FILE — nothing would be listening. Refusing to report a backup as verified with no way to alert. Create the healthchecks.io check (period 1 day, grace 2h, notify #lares-operations) and set HC_URL."
  echo "backup-verify: $EMPTY_HC_URL_MSG" >&2
  record_status false "$EMPTY_HC_URL_MSG"
  exit 1
fi

# LAR-54-s6: see backup.sh's own comment on the same branch — RESTIC_REPOSITORY set
# means "any restic repository", unset means this box's existing rclone-over-SSH form,
# unchanged.
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  RESTIC=(restic -r "$RESTIC_REPOSITORY")
else
  RCLONE_PROGRAM="ssh -p ${STORAGEBOX_PORT:-23} -i ${STORAGEBOX_SSH_KEY} ${STORAGEBOX_USER}@${STORAGEBOX_HOST}"
  RESTIC=(restic -o rclone.program="${RCLONE_PROGRAM}" -r "rclone:${RESTIC_REPO_PATH}")
fi

# --- 1. A nightly snapshot exists and is recent -------------------------------------
SNAPS=$("${RESTIC[@]}" snapshots --tag nightly --json 2>&1) \
  || fail "cannot read the restic repository — a backup we cannot read back is not a backup: $SNAPS"

# Deliberately no jq: it is not installed on the box and a monitoring script must not
# acquire a dependency that can go missing.
#
# BEWARE `--latest N`: it returns the latest N snapshots PER GROUP (host+paths+tags),
# and this repository has several groups because the path list has grown over time. So
# `--latest 1` here yields SEVEN objects, not one — including snapshots from June whose
# paths list is two entries long. Any check written as "does the output contain X"
# therefore answers from whichever old snapshot happens to contain X, which is exactly
# the kind of check that passes while the thing it guards is broken. Everything below
# is asserted against ONE object: the newest, isolated first.
SNAP_OBJ=$(printf '%s' "$SNAPS" | sed 's/},{/}\n{/g' | tail -1)
PREV_OBJ=$(printf '%s' "$SNAPS" | sed 's/},{/}\n{/g' | tail -2 | head -1)

# `|| true` on these three: an empty repository ("[]", no "time"/"short_id" to match at
# all) made `grep -o` exit 1 with nothing to show for it, and under `set -euo pipefail`
# that aborted the script right here — silently, with no ping — instead of reaching the
# graceful "no nightly snapshot" fail() call two lines below. Same idiom as DUMP_SIZES
# below: let the pipeline come back empty and let the existing emptiness check fail it.
SNAP_TIME=$(printf '%s' "$SNAP_OBJ" | grep -o '"time":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
SNAP_ID=$(printf '%s' "$SNAP_OBJ" | grep -o '"short_id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
PREV_ID=$(printf '%s' "$PREV_OBJ" | grep -o '"short_id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
if [ "$PREV_ID" = "$SNAP_ID" ]; then PREV_ID=""; fi

[ -n "$SNAP_TIME" ] || fail "no nightly snapshot in the repository at all — the backup has never succeeded here, or the repository is not the one being written to"

# GNU date on the box, BSD date on a Mac; this script is run by hand in both places.
# Normalise restic's RFC3339 to a form both accept: drop fractional seconds, and turn
# "Z" or "+02:00" into "+0000"/"+0200".
NORM=$(printf '%s' "$SNAP_TIME" | sed -E 's/\.[0-9]+//; s/Z$/+0000/; s/([+-][0-9]{2}):([0-9]{2})$/\1\2/')
SNAP_EPOCH=$(date -d "$NORM" +%s 2>/dev/null || date -j -f '%Y-%m-%dT%H:%M:%S%z' "$NORM" +%s 2>/dev/null || echo "")
[ -n "$SNAP_EPOCH" ] || fail "could not parse the snapshot timestamp '$SNAP_TIME' — treat an unreadable check as failing, never as passing"

# Compare in MINUTES. Integer-dividing into whole hours made anything under 25h read as
# "24h" and slip past a 24h window, and made BACKUP_MAX_AGE_HOURS=0 — the documented way
# to prove the alert fires — pass against a fresh snapshot instead of failing.
AGE_MIN=$(( ( $(date +%s) - SNAP_EPOCH ) / 60 ))
AGE_HOURS=$(( AGE_MIN / 60 ))
[ "$AGE_MIN" -le $(( MAX_AGE_HOURS * 60 )) ] \
  || fail "newest nightly snapshot is ${AGE_HOURS}h old (${AGE_MIN}m) (>${MAX_AGE_HOURS}h) — it is stale, so last night's backup did not reach the repository. Check: journalctl -u agent-box-backup.service -n 50"

# --- 2. Path coverage, derived from the live box ------------------------------------
# Prove the archive carries the thing it exists to carry. 31 consecutive snapshots in
# July were green and held no dump at all.
case "$SNAP_OBJ" in
  *"\"$REQUIRED_PATH\""*) : ;;
  *) fail "the newest nightly snapshot ($SNAP_ID, ${AGE_HOURS}h old) does NOT contain $REQUIRED_PATH — it is a snapshot of everything except the databases, which is the exact shape of the 2026-07-01→14 incident" ;;
esac

# ORB-151: /srv/eve-marcel was live and unbacked for weeks because the path list named
# the old /srv/marcel and the backup skipped the missing one without a word. Reading
# /srv on the box makes the NEXT rename fail here instead of during a restore.
MISSING_PATHS=""
for d in "${BACKUP_SRV_ROOT:-/srv}"/*; do
  [ -d "$d" ] || continue
  case " $BACKUP_IGNORED_PATHS " in *" $d "*) continue ;; esac
  case "$SNAP_OBJ" in
    *"\"$d\""*) : ;;
    *) MISSING_PATHS="$MISSING_PATHS $d" ;;
  esac
done
[ -z "$MISSING_PATHS" ] || fail "the newest nightly snapshot ($SNAP_ID) does not cover:${MISSING_PATHS} — these directories exist on the box and are in no backup. This is ORB-151's failure exactly: a store that was renamed or newly created, and a path list that did not follow. Either add them to backup.sh's PATHS, or, if they are genuinely disposable, name them in BACKUP_IGNORED_PATHS with a reason."

# --- 3. Database coverage -----------------------------------------------------------
# An unreadable check is a FAILING check. If we cannot ask Postgres what databases it
# has, we cannot claim the backup covers them, and claiming it anyway is the whole bug.
DBS=$(docker compose -f "$DB_COMPOSE_DIR/compose.yaml" -f "$DB_COMPOSE_DIR/compose.override.yaml" \
        exec -T db psql -U "$DB_USER" -d postgres -tAc \
        "SELECT datname FROM pg_database WHERE datistemplate=false AND datname<>'postgres'" 2>/dev/null \
      | tr -d '\r' | sed '/^$/d') \
  || DBS=""
[ -n "$DBS" ] || fail "could not ask Postgres which databases exist, so the snapshot's database coverage cannot be verified — treat an unreadable check as failing, never as passing. Is the db container up?"

DUMP_LS=$("${RESTIC[@]}" ls --json "$SNAP_ID" "$REQUIRED_PATH" 2>&1) \
  || fail "could not list $REQUIRED_PATH inside snapshot $SNAP_ID: $(printf '%s' "$DUMP_LS" | tail -3 | tr '\n' ' ')"

# name -> size, one per line, for everything restic found under the dump directory.
DUMP_SIZES=$(printf '%s' "$DUMP_LS" \
  | grep '"type":"file"' \
  | sed -n 's/.*"name":"\([^"]*\)".*"size":\([0-9]*\).*/\1 \2/p' || true)

printf '%s' "$DUMP_SIZES" | grep -q '^globals\.sql ' \
  || fail "snapshot $SNAP_ID has no globals.sql under $REQUIRED_PATH — the roles and grants are missing, so a restore comes back with no users"

MISSING_DBS="" SMALL_DBS=""
for db in $DBS; do
  size=$(printf '%s' "$DUMP_SIZES" | sed -n "s/^${db}\.dump //p" | head -1)
  if [ -z "$size" ]; then
    MISSING_DBS="$MISSING_DBS $db"
  elif [ "$size" -lt "$MIN_DUMP_BYTES" ]; then
    SMALL_DBS="$SMALL_DBS ${db}(${size}B)"
  fi
done
[ -z "$MISSING_DBS" ] || fail "snapshot $SNAP_ID is missing a dump for:${MISSING_DBS} — Postgres has these databases and the archive does not. That is the 2026-08-17→24 shape, where the dump loop took one database of three. (If you created one of these AFTER last night's 03:00 backup, tonight's run will cover it and this clears on its own tomorrow.)"
[ -z "$SMALL_DBS" ] || fail "snapshot $SNAP_ID carries implausibly small dumps:${SMALL_DBS} (floor ${MIN_DUMP_BYTES}B) — a dump that exists but holds nothing restores to nothing"

# --- 4. Plausible, not merely present: did a big dump suddenly collapse? -------------
# A dump that halves overnight is either a catastrophe upstream or a broken dump. Only
# applied to dumps big enough for the comparison to mean something — a 200 KB database
# can legitimately halve on a cleanup, a 190 MB one cannot do it quietly.
SHRUNK=""
if [ -n "$PREV_ID" ]; then
  PREV_LS=$("${RESTIC[@]}" ls --json "$PREV_ID" "$REQUIRED_PATH" 2>/dev/null || true)
  PREV_SIZES=$(printf '%s' "$PREV_LS" \
    | grep '"type":"file"' \
    | sed -n 's/.*"name":"\([^"]*\)".*"size":\([0-9]*\).*/\1 \2/p' || true)
  for db in $DBS; do
    now=$(printf '%s' "$DUMP_SIZES" | sed -n "s/^${db}\.dump //p" | head -1)
    was=$(printf '%s' "$PREV_SIZES" | sed -n "s/^${db}\.dump //p" | head -1)
    [ -n "$now" ] && [ -n "$was" ] || continue
    [ "$was" -ge 10485760 ] || continue
    if [ "$now" -lt $(( was / 2 )) ]; then SHRUNK="$SHRUNK ${db}(${was}B→${now}B)"; fi
  done
fi
[ -z "$SHRUNK" ] || fail "a dump collapsed to less than half its previous size overnight:${SHRUNK} (snapshot $PREV_ID → $SNAP_ID) — either the database lost most of its rows or the dump is truncated. Both are worth looking at before the old snapshot ages out."

# --- 5. Restore drill: has one passed recently, and did the last one pass? ----------
# LAR-54-s4. backup-verify.sh proves last night's ARCHIVE is complete; it says nothing
# about whether a restore from that archive actually works. restore-drill.sh (LAR-54-s3)
# rehearses that once a month and records its verdict in backup_status's 'drill' row
# (sql/049_backup_status.sql). This folds that verdict into the SAME alarm: a drill
# that failed, or one that has not passed in DRILL_MAX_AGE_DAYS, means the backup is
# unproven — and unproven is not the same as protected.
#
# "Treat an unreadable check as failing, never as passing" (the same rule step 3
# already applies to Postgres' own database list) applies here too — INCLUDING the
# one expected cause of an unreadable row on a box that has not yet applied 049: the
# fail() message below names it explicitly so that cause is never a mystery. This
# check therefore goes DOWN by design on a box where 049 is not yet applied, until it
# is.
#
# A row that has never passed (last_pass_at IS NULL) counts its age from created_at —
# sql/049 seeds the row at install, so a fresh installation gets a grace period from
# day one rather than reading as instantly overdue.
DRILL_ROW_SQL="SELECT ok, (last_pass_at IS NULL), floor(extract(epoch from now() - coalesce(last_pass_at, created_at)) / 86400)::bigint FROM backup_status WHERE check_name = 'drill';"
if command -v timeout >/dev/null 2>&1; then
  DRILL_ROW=$(timeout 20 docker compose -f "$DB_COMPOSE_DIR/compose.yaml" -f "$DB_COMPOSE_DIR/compose.override.yaml" \
        exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc "$DRILL_ROW_SQL" 2>/dev/null) || DRILL_ROW=""
else
  DRILL_ROW=$(docker compose -f "$DB_COMPOSE_DIR/compose.yaml" -f "$DB_COMPOSE_DIR/compose.override.yaml" \
        exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc "$DRILL_ROW_SQL" 2>/dev/null) || DRILL_ROW=""
fi
DRILL_ROW=$(printf '%s' "$DRILL_ROW" | tr -d '\r' | sed '/^$/d')

[ -n "$DRILL_ROW" ] \
  || fail "could not read the restore-drill status (backup_status row 'drill') — treat an unreadable check as failing, never as passing. If sql/049_backup_status.sql has not been applied on this box yet, that is why: apply it and this check clears on its own."

DRILL_OK=$(printf '%s' "$DRILL_ROW" | cut -d'|' -f1)
DRILL_NEVER_PASSED=$(printf '%s' "$DRILL_ROW" | cut -d'|' -f2)
DRILL_AGE_DAYS=$(printf '%s' "$DRILL_ROW" | cut -d'|' -f3)

case "$DRILL_AGE_DAYS" in
  ''|*[!0-9]*) fail "the restore-drill status row returned an unreadable age ('$DRILL_AGE_DAYS') — treat an unreadable check as failing, never as passing" ;;
esac

[ "$DRILL_OK" != "f" ] \
  || fail "the last restore drill failed — a backup nobody has proven can be restored is not a verified backup. Check: journalctl -u agent-box-restore-drill.service -n 50"

[ "$DRILL_AGE_DAYS" -le "$DRILL_MAX_AGE_DAYS" ] \
  || fail "no restore drill has passed in ${DRILL_AGE_DAYS}d (>${DRILL_MAX_AGE_DAYS}d, DRILL_MAX_AGE_DAYS) — a backup nobody has recently proven can be restored is not a verified backup. Check: journalctl -u agent-box-restore-drill.service -n 50"

if [ "$DRILL_NEVER_PASSED" = "t" ]; then
  DRILL_NOTE="never rehearsed, due in $(( DRILL_MAX_AGE_DAYS - DRILL_AGE_DAYS ))d"
else
  DRILL_NOTE="last restore drill ${DRILL_AGE_DAYS}d ago"
fi

DB_COUNT=$(printf '%s\n' "$DBS" | wc -l | tr -d ' ')
OK_MSG="OK — nightly snapshot $SNAP_ID ${AGE_HOURS}h old (${AGE_MIN}m); carries $REQUIRED_PATH with globals.sql + all $DB_COUNT database dumps, and every directory under /srv; $DRILL_NOTE"
echo "backup-verify: $OK_MSG"
curl -fsS -m 15 --retry 3 "$HC_URL" >/dev/null
record_status true "$OK_MSG"
