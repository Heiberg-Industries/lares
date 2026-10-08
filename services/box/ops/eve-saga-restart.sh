#!/usr/bin/env bash
# Restart eve-saga and immediately reclaim any turn the restart wedged.
#
# WHY: eve's graceful shutdown waits only for HTTP connections to drain, but a turn is
# asynchronous — the session POST returned "accepted" long before the model finished. With no
# connections to wait for, the process exits instantly, cutting graphile-worker off before it
# releases its jobs. The in-flight turn's `msg_` job stays locked by a worker that no longer
# exists, and nothing retries it until eve's ~14-minute backstop (or graphile's ~4h stale-lock
# reclaim). Measured 3/3. See docs/runbooks/eve-saga.md.
#
# The reclaim below is graphile-worker's own supported API for exactly this — jobs held by a
# dead worker. Measured: three wedged turns (one stuck 2h51m) all resumed within 30s of it.
#
# SAFETY: only workers whose lock PREDATES the current container start are unlocked. Unlocking
# a live worker's job would run that job twice. eve-saga is a single container, so "locked
# before this container started" == "held by a process that no longer exists".
set -uo pipefail

C=agent-box-eve-saga-1
DB=agent-box-db-1
# The database and role this installation uses. Same overridable names ops/install.sh,
# ops/update.sh and lib/db.ts read, with the same defaults — an installation that kept the
# installation-specific database and role names sets PGDATABASE and PGUSER in this script's
# environment. See LAR-74 §3.
DB_USER="${PGUSER:-lares}"
DB_NAME="${PGDATABASE:-lares_state}"
HEALTH=http://172.18.0.24:3000/eve/v1/health

echo "restarting $C"
docker restart "$C" >/dev/null
until curl -sf -o /dev/null --max-time 5 "$HEALTH"; do sleep 2; done
STARTED=$(docker inspect -f '{{.State.StartedAt}}' "$C")
echo "back up, healthy (started $STARTED)"

# Give the fresh worker a moment to register before we look for stale locks.
sleep 3

# A query that fails is NOT "no wedged turns" (LAR-86). These reads used to discard psql's
# stderr and exit code, so an unreachable database — or a wrong PGDATABASE/PGUSER — printed
# "nothing to reclaim" and exited 0 over a turn that stayed wedged. Now the read refuses
# loudly, the way backup.sh does, and the script exits 2: the restart itself DID happen.
read_locks() { # <sql> -> the trimmed answer, or a refusal on stderr and exit 2
  local out
  if ! out=$(docker exec "$DB" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>&1); then
    echo "eve-saga-restart: could not reach database $DB_NAME as role $DB_USER in $DB ($(printf '%s' "$out" | tail -n 2 | tr '\n' ' ' | sed 's/ *$//')) — postgres unreachable; the container was restarted, but whether a turn is still wedged is UNKNOWN and nothing was reclaimed" >&2
    return 2
  fi
  printf '%s' "$out" | tr -d ' '
}

DEAD=$(read_locks \
  "select coalesce(string_agg(distinct quote_literal(locked_by), ','), '')
     from graphile_worker.jobs
    where locked_by is not null and locked_at < '$STARTED'::timestamptz") || exit 2

if [ -z "$DEAD" ]; then
  echo "no turns were wedged by the restart — nothing to reclaim"
  exit 0
fi

echo "reclaiming jobs from dead worker(s): $DEAD"
docker exec "$DB" psql -U "$DB_USER" -d "$DB_NAME" -q -c \
  "select graphile_worker.force_unlock_workers(array[$DEAD])" >/dev/null

LEFT=$(read_locks \
  "select count(*) from graphile_worker.jobs where locked_by is not null and locked_at < '$STARTED'::timestamptz") || exit 2
echo "stale locks remaining: $LEFT (0 = all reclaimed; the worker repolls within ~500ms)"
