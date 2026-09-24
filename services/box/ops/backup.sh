#!/usr/bin/env bash
# Nightly backup on the agent box. Pushes an encrypted, deduplicated restic snapshot
# of the Postgres dumps + the knowledge stores + config to a Hetzner Storage Box in a
# different region, served APPEND-ONLY (a compromised box can add backups but cannot
# delete or overwrite history). Runs via systemd timer (agent-box-backup.timer).
#
# Deploy: copy to /opt/agent-box/backup.sh (chmod 0750, root), and place the filled
# /etc/agent-box/backup.env (from backup.env.example). The box only RUNS this — never
# build images here.
#
# SECRETS: the plaintext /opt/agent-box/.env is EXCLUDED from the restic snapshot so it
# cannot leak in cleartext. Instead, when AGE_SECRETS_RECIPIENT is set, /etc/agent-box (26
# credentials incl. RESTIC_PASSWORD_FILE + the Storage Box key) and the .env (TOKEN_ENC_KEY)
# are age-encrypted to an off-box public key and the CIPHERTEXT rides in the snapshot (step
# 1b). The private key lives only in Bendik's password manager. This is belt-and-suspenders:
# those secrets are ALSO escrowed directly (done 2026-07-15), which is what lets the archive
# be opened in the first place. See docs/runbooks/backup-and-restore.md.
set -euo pipefail

ENV_FILE="${AGENT_BOX_BACKUP_ENV:-/etc/agent-box/backup.env}"
# shellcheck source=/dev/null
source "$ENV_FILE"
export RESTIC_PASSWORD_FILE

# Keeper configuration includes credential references and its secrets live here.
# A Lares installation must never report a complete backup without escrow encryption.
if [ -d /etc/lares ] && [ -z "${AGE_SECRETS_RECIPIENT:-}" ]; then
  echo 'backup: /etc/lares exists but secrets encryption is not configured' >&2
  exit 1
fi

# Append-only is enforced SERVER-SIDE by the forced `rclone serve restic --append-only`
# command on the Storage Box key (Stage 1.5 plan Task 2). restic reaches it over the
# rclone backend by running ssh as its transport program.
#
# LAR-54-s6: an installation that is not Bendik's box is not required to have a
# Hetzner Storage Box at all. Setting RESTIC_REPOSITORY in backup.env points restic at
# any repository it natively supports instead — an SFTP host, an S3-compatible EU
# bucket, or a local path on a second disk (see backup.env.example for the three
# shapes and matching credential env vars, which are restic's own standard ones).
# Leaving it unset keeps this box's existing rclone-over-SSH form running exactly as
# it always has — that form is a real consumer of it, not a fallback to delete later.
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  RESTIC=(restic -r "$RESTIC_REPOSITORY")
else
  RCLONE_PROGRAM="ssh -p ${STORAGEBOX_PORT:-23} -i ${STORAGEBOX_SSH_KEY} ${STORAGEBOX_USER}@${STORAGEBOX_HOST}"
  RESTIC=(restic -o rclone.program="${RCLONE_PROGRAM}" -r "rclone:${RESTIC_REPO_PATH}")
fi

# BOTH compose files: compose.yaml alone is an INVALID project (services defined there
# reference secrets declared only in the override), so a single-file `docker compose` call
# exits non-zero. This guard used to be `-f compose.yaml` only and silently swallowed that
# failure — the dump block was skipped on every run from 2026-07-01 to 2026-07-14 while the
# script still exited 0 and pinged the heartbeat green. Keep these in sync with how the
# fleet actually runs.
COMPOSE=(-f /opt/agent-box/compose.yaml -f /opt/agent-box/compose.override.yaml)
DUMP=/var/backups/pg
mkdir -p "$DUMP"

dc() { docker compose "${COMPOSE[@]}" exec -T db "$@"; }

# The role this installation uses. Same overridable name ops/install.sh, ops/update.sh and
# lib/db.ts read, with the same default — an installation that kept the pre-2026-09-21 name
# with an installation-specific role sets PGUSER in this script's environment. See LAR-74 §3.
DB_USER="${PGUSER:-lares}"

# 1. Postgres: roles + each DB in custom format, dumped THROUGH the container so the
#    client version always matches the server. A DB we cannot reach is a FAILED backup,
#    not a skipped step: exit non-zero so no snapshot is written and backup-verify.sh
#    sees a stale repository the next morning. Silence here is the whole reason 13 days
#    of backups were empty.
dc pg_isready -U "$DB_USER" >/dev/null || { echo "backup: postgres unreachable — refusing to take an empty snapshot" >&2; exit 1; }

dc pg_dumpall -U "$DB_USER" -l postgres --globals-only > "$DUMP/globals.sql"
# THE DATABASE LIST IS READ FIRST, NOT PIPED INTO THE LOOP. `dc` is `docker compose exec`,
# which CONSUMES STDIN even with -T — so `... | while read -r db; do dc pg_dump ...; done`
# dumps the FIRST database and then finds the pipe drained, silently skipping every other one.
# That is not hypothetical: it is why `lares_marcel` was never backed up between its creation
# on 2026-08-17 and this fix on 2026-08-24, and why `lares_calliope` would have gone the same
# way. The old `[ ${#dumps[@]} -gt 0 ]` check below could not see it — one dump is "some".
# `</dev/null` on the dump call is the belt to this braces.
DBS=$(dc psql -U "$DB_USER" -d postgres -tAc \
  "SELECT datname FROM pg_database WHERE datistemplate=false AND datname<>'postgres'")
[ -n "$DBS" ] || { echo "backup: postgres returned NO databases — refusing an empty snapshot" >&2; exit 1; }

EXPECTED=0
for db in $DBS; do
  [ -n "$db" ] || continue
  EXPECTED=$((EXPECTED + 1))
  dc pg_dump -U "$DB_USER" --format=custom "$db" > "$DUMP/${db}.dump" </dev/null
done

# A dump that exists but is empty/truncated restores to nothing. Prove each one carries
# data before we archive it — an assertion, not a hope.
shopt -s nullglob
dumps=("$DUMP"/*.dump)
[ ${#dumps[@]} -gt 0 ] || { echo "backup: no dumps produced" >&2; exit 1; }
# EVERY database, not merely some. This is the assertion the 2026-08-24 incident needed and did
# not have: a partial dump set restores to a partial system, and "some dumps exist" is exactly
# the shape a silently-skipped database hides behind. A new database on this box is therefore a
# LOUD failure until it is dumped, which is the correct default for a backup.
[ ${#dumps[@]} -eq "$EXPECTED" ] || {
  echo "backup: dumped ${#dumps[@]} of $EXPECTED databases — refusing a partial snapshot" >&2
  printf 'backup: expected: %s\n' "$(echo $DBS | tr '\n' ' ')" >&2
  printf 'backup: got:      %s\n' "$(basename -a "${dumps[@]}" | tr '\n' ' ')" >&2
  exit 1
}
for d in "${dumps[@]}"; do
  [ "$(stat -c %s "$d")" -gt 1024 ] || { echo "backup: $d is empty or truncated" >&2; exit 1; }
done

# 1b. Secrets bundle: /etc/agent-box (26 credentials) + /opt/agent-box/.env (TOKEN_ENC_KEY),
#     tarred and age-encrypted to an OFF-BOX recipient. Ciphertext is safe to carry in the
#     snapshot — the private key lives only in Bendik's password manager — so a box loss
#     becomes a decrypt-and-restore, not a day of re-minting the whole fleet's credentials.
#     Decrypt with: age -d -i <private-key> agent-box-secrets.tar.age | tar -xf - .
#     Fail loud if configured-but-broken: a silently-missing secrets backup is the exact
#     failure class this script exists to kill. Skips only when no recipient is set.
if [ -n "${AGE_SECRETS_RECIPIENT:-}" ]; then
  command -v age >/dev/null || { echo "backup: AGE_SECRETS_RECIPIENT set but 'age' not installed" >&2; exit 1; }
  mkdir -p "$DUMP/secrets"
  SECRET_PATHS=(etc/agent-box opt/agent-box/.env)
  [ ! -d /etc/lares ] || SECRET_PATHS+=(etc/lares)
  tar -C / -cf - "${SECRET_PATHS[@]}" \
    | age -r "$AGE_SECRETS_RECIPIENT" -o "$DUMP/secrets/agent-box-secrets.tar.age"
  [ -s "$DUMP/secrets/agent-box-secrets.tar.age" ] || { echo "backup: secrets bundle empty" >&2; exit 1; }
fi

# 2. Brain bare repo: pack objects for an on-disk-consistent snapshot (skip if absent).
[ -d /srv/brain.git ] && git --git-dir=/srv/brain.git gc --quiet || true

# 3. One restic snapshot. Only include paths that exist — restic treats a missing source
#    as an error (exit 3). Never snapshot the secret-bearing .env.
#    The WORKING TREES are included alongside the bare repos: uncommitted files (the W3
#    conversation log under _meta/conversations/, the clipper's _inbox/) live only there,
#    and a bare-repo-only snapshot silently misses them. Atlas, the relationship graph and
#    the agents' state dirs have no upstream source of truth — losing them is permanent.
#    THE `[ -d "$p" ]` GUARD BELOW IS A TRAP, AND IT SPRUNG. A path that does not exist is
#    skipped without a word — correct for a genuinely optional path, silent data loss for a
#    RENAMED one. `/srv/marcel` is OLD Marcel's root; live eve-marcel writes `/srv/eve-marcel`
#    (MARCEL_DATA_ROOT in compose.yaml), a deliberately fresh path chosen at the eve port. The
#    list kept naming the old one, the guard skipped the new one, and Marcel's entire live trip
#    store — every trip file plus the seeded config.json without which every TripStore call
#    throws — was never backed up at all (ORB-151). Same for `/srv/taste` (Bendik's curated
#    store, written by the console) and `/srv/agent` (the persona.md that OVERRIDES the image);
#    both were checked against the actual snapshot, not assumed, and neither was covered
#    anywhere else. None of the three is a cache; none is reconstructible.
#    tests/backup-coverage.test.ts now asserts this list against compose.yaml's bind mounts,
#    so the next rename fails a test instead of a restore.
PATHS=("$DUMP" /opt/agent-box)
for p in /srv/brain /srv/brain.git /srv/atlas /srv/atlas.git /srv/network /srv/saga-state \
         /srv/agent /srv/taste /srv/eve-marcel /srv/marcel /srv/lares; do
  [ -d "$p" ] && PATHS+=("$p")
done
# Retained Eve file/blob volumes are separate from the PostgreSQL workflow stores.
# Enumerate exact installation-owned names in backup.env; never archive dbdata live.
for volume in ${LARES_WORKFLOW_VOLUMES:-}; do
  [[ "$volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || { echo 'backup: invalid workflow volume name' >&2; exit 1; }
  mount=$(docker volume inspect --format '{{.Mountpoint}}' "$volume")
  [[ "$mount" == /var/lib/docker/volumes/*/_data && -d "$mount" ]] || { echo 'backup: workflow volume unavailable' >&2; exit 1; }
  PATHS+=("$mount")
done
"${RESTIC[@]}" backup "${PATHS[@]}" \
  --tag nightly --exclude-caches --exclude /opt/agent-box/.env

# 4. NO heartbeat here — deliberately. This block used to be
#      `if [ -n "${HC_URL:-}" ]; then curl ... "$HC_URL"; fi`
#    and HC_URL was EMPTY in the deployed /etc/agent-box/backup.env, so it silently
#    pinged nothing, on failing and successful nights alike. That is why three failed
#    nights (22–24 Aug 2026) went unnoticed: the "exit non-zero so the heartbeat never
#    fires" design above was correct and had nothing on the other end (ORB-150).
#    Liveness is now owned by ONE thing — backup-verify.sh — which asks the repository
#    whether a fresh snapshot is actually IN it rather than asking this script whether
#    it ran. It catches everything a heartbeat here would (no run -> no fresh snapshot)
#    plus the failures this box has actually had: a green run that archived no dump.
#    One job, one liveness owner, one alert (ADR-0012 rule 4).

# 5. Local cleanup — the snapshot is safely off-box now.
rm -rf "$DUMP"
