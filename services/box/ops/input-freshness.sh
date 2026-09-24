#!/usr/bin/env bash
# input-freshness.sh — the standing check for THE defect class this fleet keeps producing:
# a job that runs on schedule, logs success, and has silently lost its input.
#
# Three instances found in one week (2026-08-19 → 21), none caught by monitoring:
#
#   1. The dream cycle reported `promoted=0 superseded=0 held=0 needsConfirm=0` every night,
#      perfectly on schedule, for days. Its only input — `_meta/conversations/**/*.md` — had
#      been empty since 2026-08-13, because the process that wrote it was retired at the eve
#      cutover and nothing replaced it (ORB-138).
#   2. The briefs send nothing when there is nothing to say, which is correct — but "correctly
#      silent" and "the slot was missed" are indistinguishable in every durable record, because
#      sending nothing means no session, no workflow_runs row and no trace (scorecard S3).
#   3. The iMessage importer has captured NO message text since 2025 — macOS moved the body
#      from `message.text` to `attributedBody` and the importer still selects `m.text`. ~18
#      months of silent degradation behind a green import.
#
# WHY A GREEN LOG IS NOT ENOUGH. Every one of those jobs was "healthy" by its own account. The
# loop fired, the code ran, the log line printed. What died was upstream. So this checks the
# INPUTS directly and independently of whoever consumes them — it never asks a job how it is
# doing, it asks whether the thing that job reads has anything in it.
#
# DESIGN RULES, learned from the three above:
#   - Check the SOURCE, never the consumer's own success line.
#   - An empty result must be distinguishable from a stale one. Where a source can legitimately
#     be empty, check its FRESHNESS instead of its size.
#   - Consumer-agnostic on purpose: the digest check below passes whether the consumer is the
#     old `saga-digest` container or eve-saga's ported schedule. It tests the outcome, not the
#     implementation, so it survives the migration it was written during.
#   - Every check prints what it actually read. A threshold with no observed value is a check
#     nobody can debug at 3am.
#
# EXIT: 0 = all fresh, 1 = at least one stale input. Safe to run repeatedly; reads only.
#
# Runs on the agent box. The iMessage check needs the UNSTRIPPED source database, which lives
# only on Bendik's Mac (`~/.lares/network.db`) — on the box it SKIPS with a reason rather than
# silently passing, because a check that quietly does nothing is the very bug this file exists
# to catch.
#
# WHAT THIS DELIBERATELY DOES NOT CHECK: the nightly backup. ORB-154 asked for it here, but by
# then ORB-150 had already shipped `backup-verify.sh` as the backup's SINGLE liveness owner —
# and that script can do it properly, because it holds the restic credentials and asks the
# ARCHIVE what it contains rather than guessing from the box. Adding a second backup check here
# would make one incident arrive as two messages down two different alert paths, which is the
# noise ADR-0012 rule 4 exists to stop. The coverage assertions ORB-154 wanted — all three
# databases, every directory under /srv, plausible dump sizes — live in backup-verify.sh.
#
# ALERTING (ORB-154). Until now this had no timer and no monitor: it was verified on both hosts,
# green on the box, and run only by hand. It now runs hourly and pushes to its own Uptime Kuma
# monitor ("agent-box input freshness"):
#   - all inputs fresh   -> status=up   (ping = number of checks that actually ran)
#   - any input stale    -> status=down (Kuma fires its notification, message names which)
#   - this script broken -> no push     (Kuma's missed-heartbeat fires on its own)
# Kuma's window for it is 7800s against an hourly pusher. That >=2x slack is not decoration: the
# box's two older push monitors spent weeks alternating up/down every cycle because their windows
# were set at or below their pushers' periods, and a guard that cries wolf is a guard nobody reads.
# ORB-175 (2026-09-04): section 5b reads one heartbeat row per eve-saga schedule; the DOWN
# message names the schedule.
set -uo pipefail

ENV_FILE=/etc/input-freshness.env
# shellcheck source=/dev/null
[ -r "$ENV_FILE" ] && . "$ENV_FILE"
KUMA_PUSH_URL="${KUMA_PUSH_URL:-}"

# ACKNOWLEDGED CHECKS. Space-separated `check-name:TICKET` pairs. An acknowledged check still
# runs and still prints its STALE line — nothing is hidden — but it does not turn the monitor
# red, because a monitor that is red on the day it is installed and stays red is not a monitor,
# it is wallpaper. This exists for ONE situation: a defect that is known, filed, and not yet
# fixed. The ticket reference is mandatory and is printed in every single report, so an ack has
# a name attached to it and a place it goes to die.
#
# The founding case is `imessage-content`: the importer has captured no message text since 2025
# because macOS moved the body from `message.text` to `attributedBody`. Without the ack the Mac
# half of this check is red from the moment it is installed (ORB-162), and the box half's genuinely useful
# signal gets learned-as-noise alongside it — which is the exact failure ORB-154 exists to end.
INPUT_FRESHNESS_ACK="${INPUT_FRESHNESS_ACK:-}"

push() { # status msg [ping]
  local status="$1" msg="$2" ping="${3:-}"
  if [ -z "$KUMA_PUSH_URL" ]; then
    echo "input-freshness: KUMA_PUSH_URL not set — checked the inputs, cannot push. Nothing is listening, which is the same silence this script exists to break." >&2
    return 0
  fi
  curl -fsS -m 15 -G "$KUMA_PUSH_URL" \
    --data-urlencode "status=$status" \
    --data-urlencode "msg=$msg" \
    ${ping:+--data-urlencode "ping=$ping"} \
    -o /dev/null || echo "input-freshness: kuma push failed" >&2
}

# A CHECK THAT DIES BEFORE IT REPORTS MUST SAY SO. The first run of this under systemd exited
# at `$HOME` — unset for a system unit — and `set -u` killed the script with status 1, which
# the unit's SuccessExitStatus treats as "a stale input was found", i.e. a clean finish. So the
# guard crashed and looked green, which is the precise shape of the bug it was written to catch.
# Now anything that ends this script before the report pushes DOWN with the line number on it.
REPORTED=0
on_exit() {
  local rc=$?
  [ "$REPORTED" -eq 1 ] && return
  echo "input-freshness: the check itself died (exit $rc) before it could report — it verified NOTHING this run" >&2
  push down "input-freshness on $(hostname): THE CHECK ITSELF DIED (exit $rc) before reporting — it verified nothing. journalctl -u input-freshness.service -n 30"
}
trap on_exit EXIT

acked_ticket() { # check-name -> ticket, or empty
  local name="$1" pair
  for pair in $INPUT_FRESHNESS_ACK; do
    case "$pair" in "$name":*) printf '%s' "${pair#*:}"; return 0 ;; esac
  done
  return 1
}

DB_CONTAINER="${DB_CONTAINER:-agent-box-db-1}"
# The database and role this installation uses. Same overridable names ops/install.sh,
# ops/update.sh and lib/db.ts read, with the same defaults — an installation that kept the
# installation-specific database and role names sets PGDATABASE and PGUSER in this script's
# environment. See LAR-74 §3.
DB_USER="${PGUSER:-lares}"
DB_NAME="${PGDATABASE:-lares_state}"
VAULT="${VAULT_PATH:-/srv/brain}"
NETWORK_DB="${NETWORK_DB:-/srv/network/network.db}"
# HOME is unset for a systemd system unit, hence the fallback — this line crashed the
# very first timed run on the box.
IMESSAGE_SOURCE_DB="${IMESSAGE_SOURCE_DB:-${LARES_HOME:-${HOME:-/root}/.lares}/network.db}"

FAILURES=0
LINES=()

ACKED=()
pass() { LINES+=("OK    $1 — $2"); }
skip() { LINES+=("SKIP  $1 — $2"); }
fail() {
  local ticket
  if ticket=$(acked_ticket "$1"); then
    # Still printed, still visibly stale, deliberately not counted toward the alert.
    LINES+=("STALE $1 — $2  [ACKNOWLEDGED, $ticket — not alerting until that is closed]")
    ACKED+=("$1($ticket)")
    return
  fi
  LINES+=("STALE $1 — $2")
  FAILURES=$((FAILURES + 1))
}

# Absent docker == wrong host for this check (skip, loudly). Present docker but a failing query
# == a check we could not complete, which counts as FAILING — never pass on an unreadable input.
HAVE_DB=0
if command -v docker >/dev/null 2>&1 && docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then HAVE_DB=1; fi

psql_one() {
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null | tr -d ' '
}

# GNU stat on the box, BSD stat on the Mac. This script runs in BOTH places on purpose.
mtime_epoch() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

# Age in hours of the newest regular file under a directory tree ("" if none).
newest_age_hours() {
  local dir="$1"
  [ -d "$dir" ] || { echo ""; return; }
  local newest_epoch=0 f e
  while IFS= read -r f; do
    e=$(mtime_epoch "$f"); [ -z "$e" ] && continue
    [ "$e" -gt "$newest_epoch" ] && newest_epoch="$e"
  done < <(find "$dir" -type f -name '*.md' 2>/dev/null)
  [ "$newest_epoch" -eq 0 ] && { echo ""; return; }
  echo $(( ( $(date +%s) - newest_epoch ) / 3600 ))
}

# ── 1. Conversation capture — the ORB-138 regression, checked at the source ──────────────
# The dream cycle's only input. Threshold is generous (36h) so a genuinely quiet day does not
# cry wolf; a RETIRED WRITER shows up within two days, which is what actually happened.
CONV_AGE=$(newest_age_hours "$VAULT/_meta/conversations")
if [ ! -d "$VAULT" ]; then
  skip "conversation-capture" "no vault at $VAULT on this host — run this half on the agent box"
elif [ -z "$CONV_AGE" ]; then
  fail "conversation-capture" "no .md files at all under $VAULT/_meta/conversations — nothing is writing turns"
elif [ "$CONV_AGE" -gt 36 ]; then
  fail "conversation-capture" "newest turn is ${CONV_AGE}h old (>36h) — the writer has probably stopped, as it did on 2026-08-13"
else
  pass "conversation-capture" "newest turn ${CONV_AGE}h old"
fi

# ── 2. Dream cycle output — proves the 03:00 pass ran AND had something to write ─────────
DREAM_AGE=$(newest_age_hours "$VAULT/_meta/dream")
if [ ! -d "$VAULT" ]; then
  skip "dream-cycle" "no vault at $VAULT on this host — run this half on the agent box"
elif [ -z "$DREAM_AGE" ]; then
  fail "dream-cycle" "no dated notes under $VAULT/_meta/dream"
elif [ "$DREAM_AGE" -gt 36 ]; then
  fail "dream-cycle" "newest dream note is ${DREAM_AGE}h old (>36h) — the nightly pass has not run"
else
  pass "dream-cycle" "newest dream note ${DREAM_AGE}h old"
fi

# ── 3. Network replica — person_lookup's pulse source ────────────────────────────────────
# Pushed from the Mac, so it ages between pushes; 8 days is loose on purpose. A replica frozen
# for weeks makes every "nothing new from them" answer quietly wrong.
if [ -f "$NETWORK_DB" ]; then
  REPLICA_AGE=$(( ( $(date +%s) - $(mtime_epoch "$NETWORK_DB") ) / 86400 ))
  if [ "$REPLICA_AGE" -gt 8 ]; then
    fail "network-replica" "$NETWORK_DB is ${REPLICA_AGE} days old (>8) — person lookups are answering from a stale world"
  else
    pass "network-replica" "replica ${REPLICA_AGE} days old"
  fi
elif [ "$HAVE_DB" -eq 1 ]; then
  fail "network-replica" "$NETWORK_DB missing on the box — the pulse source of person_lookup is absent"
else
  skip "network-replica" "$NETWORK_DB not on this host — run this half on the agent box"
fi

# ── 4. Reminder delivery — a due reminder that never went out ────────────────────────────
# Not a freshness check: an OVERDUE-and-still-pending row is direct proof the delivery loop is
# not running, regardless of what the loop's own log says.
if [ "$HAVE_DB" -eq 0 ]; then
  skip "reminder-delivery" "no $DB_CONTAINER on this host — run this half on the agent box"
  OVERDUE="skip"
else
  OVERDUE=$(psql_one "select count(*) from reminders where status='pending' and due_at < now() - interval '1 hour'")
fi
if [ "$OVERDUE" = "skip" ]; then
  :
elif [ -z "$OVERDUE" ]; then
  fail "reminder-delivery" "could not query reminders (is $DB_CONTAINER up?) — treat an unreadable check as failing, never as passing"
elif [ "$OVERDUE" -gt 0 ]; then
  fail "reminder-delivery" "$OVERDUE reminder(s) due over an hour ago and still pending"
else
  pass "reminder-delivery" "no overdue pending reminders"
fi

# ── 5. Digest queue has a live consumer — CONSUMER-AGNOSTIC ──────────────────────────────
# `claimDigestRequests` is a DELETE…RETURNING, so a pending row older than ten minutes means
# nothing is draining the queue. Passes whether the consumer is the old saga-digest container
# or eve-saga's ported schedule (ORB-133) — which is the point: it survives its own migration.
if [ "$HAVE_DB" -eq 0 ]; then
  skip "digest-queue" "no $DB_CONTAINER on this host — run this half on the agent box"
  STUCK="skip"
else
  STUCK=$(psql_one "select count(*) from digest_requests where status='pending' and created_at < now() - interval '10 minutes'")
fi
if [ "$STUCK" = "skip" ]; then
  :
elif [ -z "$STUCK" ]; then
  fail "digest-queue" "could not query digest_requests"
elif [ "$STUCK" -gt 0 ]; then
  fail "digest-queue" "$STUCK digest request(s) pending >10min — no consumer is draining the queue"
else
  pass "digest-queue" "no stuck digest requests"
fi

# ── 5b. Every eve-saga/eve-marcel schedule leaves a durable trace (ORB-175; generalises ORB-179;
#        LAR-44 added Marcel's four) ──────────────────────────────────────────────────────────
# The digest ran NOWHERE from 2026-08-21 to 2026-08-31 and nothing could see it: a filed-0
# pass leaves no artefact, and nine of Saga's thirteen schedules leave none on a quiet pass BY
# DESIGN (a brief with nothing to say sends nothing). So every schedule stamps
# heartbeat('<agent>/<schedule>') at every pass-complete point (@lares/agent-kit/schedule-heartbeat),
# and the slot-based ones also stamp '<agent>/<schedule>/tick' on every tick after the gate.
# Saga's rows are seeded at now() by sql/031_schedule_heartbeat.sql, Marcel's by
# sql/046_marcel_schedule_heartbeat.sql — the clock starts at install.
#
# Thresholds = the schedule's period plus the ≥2× slack the box's Kuma rules require, agreed
# 2026-09-04 (spec 2026-09-03-schedule-output-freshness-design.md; Marcel's own agreed 2026-09-15,
# LAR-44). The table below is pinned to the schedule code and the migration by
# services/chief-of-staff/tests/schedule-heartbeat-conformance.test.ts (Saga) and
# services/travel/tests/schedule-heartbeat-conformance.test.ts (Marcel): a key here that no
# schedule writes, or a threshold that differs from the agreed one, fails one of those tests.
# ONE line per schedule — key:threshold_hours:cadence.
#
# AN ABSENT ROW IS STALE, never fresh (ORB-179's rule): it means the migration was never
# applied, or the key drifted — both are exactly the silence this check exists to break.
#
# AN OPT-IN SCHEDULE IS DELIBERATELY ABSENT from this table and from the tick list below. Opt-in
# has a mechanical definition: the schedule's gate call is `scheduleExplicitlyEnabled(`
# (packages/agent-kit/src/schedule-switch.ts — silence means OFF, for a schedule that deletes),
# and a closed gate returns before it stamps anything. This script cannot yet tell "off on
# purpose" from "stopped", so a line here would go STALE on every installation that has not
# opted in — which is every installation by default — and stay red for ever; an alarm that
# cries wolf is worse than no alarm. Until it can report such a schedule as SKIP, the
# conformance test pins the absence. The heartbeat rows such a schedule seeds and stamps are
# harmless here: a row that no line below names is never looked up.
SCHEDULE_PASSES="
saga/morning-brief:26:daily 08:00 Oslo
saga/evening-brief:26:daily 20:00 Oslo
saga/market-refresh:26:nightly 04:30 UTC
saga/digest:20:09:00 + 17:00 Oslo
saga/dream:30:daily 03:00 Oslo
saga/telegram-handover:30:daily 00:00 Oslo
saga/voice-learn:192:Sundays 04:00 Oslo
saga/weekly-summary:192:Sundays
saga/crm-routing:20:09/13/17 Oslo
saga/deadlines:2:every 30 min
saga/email-triage:2:every minute
saga/meeting-followup:2:every 5 min
saga/outreach-reply-watch:2:every 15 min
saga/proposals-watch:2:every minute
saga/reminders:2:every minute
saga/reping:2:every 30 min
saga/owner-clock:2:every 30 min
marcel/trip-lifecycle:2:every minute
marcel/dream:30:daily, per trip (~02:00 trip-local)
marcel/proximity:2:every minute
marcel/taste-promote:2:every minute
"
# The slot-based schedules: their pass row moves once a day (or week), so a dead loop would
# hide behind a fresh pass for up to the pass threshold. The tick row catches it within 2 h.
SCHEDULE_TICKS="saga/morning-brief saga/evening-brief saga/digest saga/dream saga/telegram-handover saga/voice-learn saga/weekly-summary saga/crm-routing marcel/dream"
SCHEDULE_TICK_HOURS=2

if [ "$HAVE_DB" -eq 0 ]; then
  skip "saga/schedules" "no $DB_CONTAINER on this host — run this half on the agent box"
else
  # One query for every row; lines of `key=age_hours`. Looked up with sed below — bash 3.2 on the
  # Mac has no associative arrays, and this script runs there too.
  HB_ROWS=$(psql_one "select agent || '=' || floor(extract(epoch from (now() - updated_at))/3600) from heartbeat where agent like 'saga/%' or agent like 'marcel/%'")
  if [ -z "$HB_ROWS" ]; then
    fail "saga/schedules" "could not read heartbeat rows (is $DB_CONTAINER up? was sql/031_schedule_heartbeat.sql / sql/046_marcel_schedule_heartbeat.sql applied?) — an unreadable check is failing, never passing"
  else
    hb_age() { printf '%s\n' "$HB_ROWS" | sed -n "s#^$1=##p" | head -1; }

    # The while loop below runs in a subshell and its verdicts round-trip through a temp file
    # (see the comment after it). If that write or re-read fails silently, EVERY schedule verdict
    # vanishes and the run would push UP on zero evidence — the exact bug this script exists to
    # catch, aimed at itself. So the verdict count is checked against the expected count below,
    # which is DERIVED from $SCHEDULE_PASSES rather than written out here: a number in a comment
    # goes stale the first time a schedule is added, and a stale number is how this guard would
    # quietly start guarding the wrong thing.
    EXPECTED_SCHEDULES=$(printf '%s\n' "$SCHEDULE_PASSES" | grep -cE '^(saga|marcel)/')

    # THE DIGEST AND CRM-ROUTING THRESHOLDS FOLLOW THE OWNER'S HOURS (LAR-17). Their slots are a
    # setting now (schedule_settings, sql/065), and the table's 20 h was agreed for the DEFAULT
    # hours: the 16 h overnight gap + 4. An owner who switches to one digest a day would be paged
    # every evening by that number. So for `*/digest` and `*/crm-routing` — matched by SUFFIX: the
    # settings carry bare names, the table an agent prefix — the threshold is the longest gap
    # between consecutive slots, wrapping past midnight, + 4 h, and never above 26 h: a schedule
    # that runs once a day is a daily schedule and gets the daily number the briefs were agreed at
    # (24 + 4 would hand it MORE slack than they have). Defaults: 9,17 and 9,13,17 -> 16 + 4 = 20,
    # exactly the table. ONE query, BEFORE the loop — `docker exec` inside it would eat its stdin.
    #
    # WHOSE ROW? This script has no notion of an owner, and must not grow one (the engine holds no
    # owner ids). It reads every owner's row for the two schedules and, where two owners differ,
    # the LARGEST threshold wins: the alarm must not page for the quieter configuration.
    #
    # The fallback is the table, said out loud. `psql_one` swallows stderr, so "no rows" and "could
    # not read" are both an empty answer — hence the `_read_ok` marker line, which only a query
    # that actually ran returns. No marker (sql/065 not applied yet, a database error), or a stored
    # value the arithmetic cannot use, keeps the table's own number and adds ONE WARN line to the
    # report. The freshness check itself always runs; nothing here can widen a threshold.
    cadence_threshold() { # "9,17" -> 20; prints nothing and returns 1 for anything but whole hours 0-23
      local h first="" prev="" gap max=0
      case "$1" in ""|*[!0-9,]*|,*|*,|*,,*) return 1 ;; esac
      for h in $(printf '%s\n' "$1" | tr ',' '\n' | sort -n -u); do
        # No leading zeros either: bash arithmetic reads 09 as broken octal and dies on it.
        case "$h" in [0-9]|1[0-9]|2[0-3]) ;; *) return 1 ;; esac
        if [ -z "$first" ]; then first=$h; else gap=$((h - prev)); [ "$gap" -gt "$max" ] && max=$gap; fi
        prev=$h
      done
      gap=$((first + 24 - prev)); [ "$gap" -gt "$max" ] && max=$gap
      gap=$((max + 4)); [ "$gap" -gt 26 ] && gap=26
      printf '%s' "$gap"
    }
    CADENCE_THRESHOLDS="" # lines of `schedule=threshold_hours`, one per readable settings row
    CADENCE_UNUSABLE=""   # schedules with a stored value the arithmetic cannot use
    CADENCE_ROWS=$(psql_one "select '_read_ok' union all select schedule || '=' || array_to_string(hours, ',') from schedule_settings where schedule in ('digest','crm-routing')")
    case "$CADENCE_ROWS" in
      *_read_ok*)
        # A here-document, not a pipe: this loop has to set variables the rest of the script sees.
        while IFS= read -r row; do
          case "$row" in digest=*|crm-routing=*) ;; *) continue ;; esac
          if configured=$(cadence_threshold "${row#*=}"); then
            CADENCE_THRESHOLDS="$CADENCE_THRESHOLDS
${row%%=*}=$configured"
          else
            case " $CADENCE_UNUSABLE " in *" ${row%%=*} "*) ;; *) CADENCE_UNUSABLE="$CADENCE_UNUSABLE ${row%%=*}" ;; esac
          fi
        done <<EOF
$CADENCE_ROWS
EOF
        if [ -n "$CADENCE_UNUSABLE" ]; then
          LINES+=("WARN  schedule-cadence — the stored hours in schedule_settings for:${CADENCE_UNUSABLE} are not whole hours 0-23 — keeping the table's threshold for those; the freshness check itself still ran")
        fi ;;
      *)
        LINES+=("WARN  schedule-cadence — could not read schedule_settings (sql/065_schedule_settings.sql not applied yet, or a database error) — the digest and crm-routing thresholds stay at the table's numbers, which assume the default hours; the freshness check itself still ran") ;;
    esac
    # bare schedule name -> the largest threshold its settings rows give; "" = keep the table's.
    cadence_hours() {
      case " $CADENCE_UNUSABLE " in *" $1 "*) return 0 ;; esac
      printf '%s\n' "$CADENCE_THRESHOLDS" | sed -n "s#^$1=##p" | sort -n | tail -1
    }

    printf '%s\n' "$SCHEDULE_PASSES" | while IFS=: read -r key hours cadence; do
      [ -z "$key" ] && continue
      case "$key" in
        */digest|*/crm-routing)
          configured=$(cadence_hours "${key##*/}")
          if [ -n "$configured" ]; then hours=$configured; cadence="the owner's hours in schedule_settings"; fi ;;
      esac
      age=$(hb_age "$key")
      if [ -z "$age" ]; then
        echo "STALE $key — no heartbeat row (seeded by sql/031_schedule_heartbeat.sql or sql/046_marcel_schedule_heartbeat.sql; a schedule writes it on every completed pass) — never ran since install, or the key drifted"
      elif [ "$age" -ge "$hours" ]; then
        echo "STALE $key — last completed pass ${age}h ago (threshold ${hours}h; $cadence) — the schedule is not running, or every pass is failing (check the container log)"
      else
        echo "OK    $key — last completed pass ${age}h ago"
      fi
    done > "${TMPDIR:-/tmp}/input-freshness.schedules.$$"
    # The while loop ran in a subshell (pipe), so its verdicts come back through a file, not
    # through LINES/FAILURES — re-read them into the real report here.
    while IFS= read -r line; do
      case "$line" in
        "STALE "*) name=${line#STALE }; name=${name%% *}; fail "$name" "${line#STALE $name — }" ;;
        "OK    "*) name=${line#OK    }; name=${name%% *}; pass "$name" "${line#OK    $name — }" ;;
      esac
    done < "${TMPDIR:-/tmp}/input-freshness.schedules.$$"
    # grep -c prints 0 AND exits 1 on a zero-match file — never `|| echo 0` here, it doubles the value.
    GOT_SCHEDULES=$(grep -c '^\(OK\|STALE\)' "${TMPDIR:-/tmp}/input-freshness.schedules.$$" 2>/dev/null | head -1)
    GOT_SCHEDULES=${GOT_SCHEDULES:-0}
    if [ "$GOT_SCHEDULES" -ne "$EXPECTED_SCHEDULES" ]; then
      fail "saga/schedules" "expected $EXPECTED_SCHEDULES schedule verdicts, got $GOT_SCHEDULES — the check could not complete (temp file under ${TMPDIR:-/tmp} unwritable?); an incomplete check is failing, never passing"
    fi
    rm -f "${TMPDIR:-/tmp}/input-freshness.schedules.$$"

    DEAD_LOOPS=""
    for key in $SCHEDULE_TICKS; do
      age=$(hb_age "$key/tick")
      if [ -z "$age" ]; then DEAD_LOOPS="$DEAD_LOOPS $key(no row)"
      elif [ "$age" -ge "$SCHEDULE_TICK_HOURS" ]; then DEAD_LOOPS="$DEAD_LOOPS $key(${age}h)"
      fi
    done
    if [ -n "$DEAD_LOOPS" ]; then
      fail "saga/schedule-loops" "tick row older than ${SCHEDULE_TICK_HOURS}h for:${DEAD_LOOPS} — the container may be up, but these schedule loops are not ticking (a closed gate looks exactly like this)"
    else
      pass "saga/schedule-loops" "all $(echo $SCHEDULE_TICKS | wc -w | tr -d ' ') slot-based schedules ticked within ${SCHEDULE_TICK_HOURS}h"
    fi
  fi
fi

# ── 6. iMessage content capture — the attributedBody rot ─────────────────────────────────
# Must read the UNSTRIPPED source; the box replica has content nulled by design (replica.ts's
# privacy boundary), so running this against the replica would report 100% empty forever and
# mean nothing. Skips loudly off the Mac rather than passing vacuously.
# `better-sqlite3` resolves only from a workspace that hoists it (services/network), never from
# the repo root the Mac's launchd job runs in — invoked from `$REPO` this check fell through to
# SKIP on every run (live 2026-09-02, box-alerting runbook § The Mac half) and a monitor wired
# against it would have sat on SKIP forever. So the read runs from that directory (ORB-179).
NETWORK_DIR="${NETWORK_DIR:-}"
if [ -z "$NETWORK_DIR" ]; then
  skip "imessage-content" "NETWORK_DIR is unset — set it to the network package dir (e.g. the lares engine's services/network) so better-sqlite3 can be resolved"
elif [ -f "$IMESSAGE_SOURCE_DB" ] && command -v node >/dev/null 2>&1; then
  EMPTY_PCT=$(cd "$NETWORK_DIR" 2>/dev/null; node -e '
    try {
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1], { readonly: true });
      const r = db.prepare(
        "SELECT count(*) n, sum(case when content is null or content=\x27\x27 then 1 else 0 end) e " +
        "FROM interactions WHERE channel=\x27imessage\x27 AND at > datetime(\x27now\x27,\x27-30 days\x27)"
      ).get();
      if (!r || !r.n) { console.log("nodata"); }
      else console.log(Math.round((r.e / r.n) * 100));
    } catch { console.log("err"); }
  ' "$IMESSAGE_SOURCE_DB" 2>/dev/null)
  case "$EMPTY_PCT" in
    nodata) skip "imessage-content" "no iMessage rows in the last 30 days to judge" ;;
    err|"")  skip "imessage-content" "could not read $IMESSAGE_SOURCE_DB (better-sqlite3 unavailable here)" ;;
    *) if [ "$EMPTY_PCT" -gt 20 ]; then
         fail "imessage-content" "${EMPTY_PCT}% of the last 30 days' iMessages have NO text — the importer reads m.text, but macOS moved the body to attributedBody"
       else
         pass "imessage-content" "${EMPTY_PCT}% empty over the last 30 days"
       fi ;;
  esac
else
  skip "imessage-content" "unstripped source DB not present here (lives on the Mac at ~/.lares/network.db) — cannot judge from the box replica, whose content is windowed to 90 days (Meta always stripped) — the empty-% judgement still needs the unstripped Mac db"
fi

# ── Report ───────────────────────────────────────────────────────────────────────────────
printf '%s\n' "${LINES[@]}"

# The alert has to NAME the stale input. "input-freshness failed" tells you a job is unhappy;
# "conversation-capture, dream-cycle" tells you the dream cycle has been reflecting on nothing
# since the writer stopped — which is the difference between an alert and a chore.
STALE_NAMES=$(printf '%s\n' "${LINES[@]}" | grep -v ACKNOWLEDGED | sed -n 's/^STALE  *\([^ ]*\) .*/\1/p' | paste -sd, -)
ACK_NOTE=""
if [ ${#ACKED[@]} -gt 0 ]; then
  ACK_NOTE=" [stale but acknowledged: $(printf '%s,' "${ACKED[@]}" | sed 's/,$//')]"
fi
FRESH=$(printf '%s\n' "${LINES[@]}" | grep -c '^OK') || FRESH=0
SKIPPED=$(printf '%s\n' "${LINES[@]}" | grep -c '^SKIP') || SKIPPED=0

REPORTED=1
if [ "$FAILURES" -gt 0 ]; then
  SUMMARY="$FAILURES stale input(s): ${STALE_NAMES} — a consumer reading these is reporting success over nothing${ACK_NOTE}"
  echo "input-freshness: $SUMMARY"
  push down "input-freshness on $(hostname): $SUMMARY" "$FAILURES"
  exit 1
fi
SUMMARY="$FRESH input(s) fresh, ${#ACKED[@]} acknowledged-stale, $SKIPPED skipped as not-this-host${ACK_NOTE}"
echo "input-freshness: $SUMMARY"
push up "input-freshness on $(hostname): $SUMMARY" "$FRESH"
exit 0
