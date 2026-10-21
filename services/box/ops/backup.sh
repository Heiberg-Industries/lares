#!/usr/bin/env bash
# Nightly backup on the agent box. Pushes an encrypted, deduplicated restic snapshot
# of the Postgres dumps + the knowledge stores + config to an off-box restic repository,
# served APPEND-ONLY where the target supports it (a compromised box can add backups but cannot
# delete or overwrite history). Runs via systemd timer (lares-backup.timer).
#
# Deploy: copy to /opt/lares/backup.sh (chmod 0750, root), and place the filled
# /etc/lares/backup.env (from backup.env.example; lares-backup.service points here at it).
# An older /opt/agent-box layout reads /etc/agent-box/backup.env. The box only RUNS this —
# never build images here.
#
# SECRETS: no plaintext secret enters the restic snapshot. When AGE_SECRETS_RECIPIENT is set,
# /etc/lares plus the agents' token folder /srv/lares/secrets (the current layout: every secret
# file, the restic password, the backup settings, each agent's door and outside-tool tokens)
# — or, in an older layout, /etc/agent-box and the plaintext /opt/agent-box/.env, which is
# EXCLUDED from the snapshot itself — is age-encrypted to an off-box public key and the
# CIPHERTEXT rides in the snapshot (step 1b). The private key lives only in the owner's password manager. This is belt-and-suspenders:
# those secrets are ALSO escrowed directly (done once), which is what lets the archive
# be opened in the first place.
set -euo pipefail
umask 077

# An installer-built server keeps its settings in /etc/lares/backup.env; an older layout in
# /etc/agent-box/backup.env. AGENT_BOX_BACKUP_ENV (the systemd units set it) wins over both.
DEFAULT_BACKUP_ENV=/etc/agent-box/backup.env
[ -f /etc/lares/backup.env ] && DEFAULT_BACKUP_ENV=/etc/lares/backup.env
ENV_FILE="${AGENT_BOX_BACKUP_ENV:-$DEFAULT_BACKUP_ENV}"
# shellcheck source=/dev/null
source "$ENV_FILE"
export RESTIC_PASSWORD_FILE
if [ "${LARES_CURRENT_LAYOUT:-0}" = 1 ]; then
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
fi

# Keeper configuration includes credential references and its secrets live here.
# A Lares installation must never report a complete backup without escrow encryption.
if [ -d /etc/lares ] && [ -z "${AGE_SECRETS_RECIPIENT:-}" ]; then
  echo 'backup: /etc/lares exists but secrets encryption is not configured' >&2
  exit 1
fi

# Append-only is enforced SERVER-SIDE by the forced `rclone serve restic --append-only`
# command on the remote SSH key. restic reaches it over the
# rclone backend by running ssh as its transport program.
#
# An installation is not required to have an rclone-over-SSH target at all. Setting RESTIC_REPOSITORY in backup.env points restic at
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
# failure — the dump block was skipped on every run for two weeks while the
# script still exited 0 and pinged the heartbeat green. Keep these in sync with how the
# fleet actually runs.
if [ "${LARES_CURRENT_LAYOUT:-0}" = 1 ]; then
  [ -f /opt/lares/compose.yaml ] || { echo 'backup: current-layout Compose file missing' >&2; exit 1; }
  COMPOSE=(-f /opt/lares/compose.yaml)
else
  COMPOSE=(-f /opt/agent-box/compose.yaml -f /opt/agent-box/compose.override.yaml)
fi
DUMP=/var/backups/pg
mkdir -p "$DUMP"
if [ "${LARES_CURRENT_LAYOUT:-0}" = 1 ]; then
  # A failed current-layout backup must not strand plaintext database dumps.
  trap 'rm -rf -- "$DUMP"' EXIT
fi

dc() { docker compose "${COMPOSE[@]}" exec -T db "$@"; }

# The role this installation uses. Same overridable name ops/install.sh, ops/update.sh and
# lib/db.ts read, with the same default — an installation that kept an older role name
# sets PGUSER in this script's environment. See §3.
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
# That is not hypothetical: it is why one agent's database was never backed up for a week, and why a
# third database would have gone the same way. The old `[ ${#dumps[@]} -gt 0 ]` check below could not see it — one dump is "some".
# `</dev/null` on the dump call is the belt to this braces.
if [ "${LARES_CURRENT_LAYOUT:-0}" = 1 ]; then
  DB_QUERY="SELECT datname FROM pg_database WHERE datistemplate=false"
else
  DB_QUERY="SELECT datname FROM pg_database WHERE datistemplate=false AND datname<>'postgres'"
fi
DBS=$(dc psql -U "$DB_USER" -d postgres -tAc "$DB_QUERY")
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
# EVERY database, not merely some. This is the assertion an earlier failure showed was needed: a partial dump set restores to a partial system, and "some dumps exist" is exactly
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

# 1b. Secrets bundle: /etc/lares (older layout: /etc/agent-box + /opt/agent-box/.env),
#     tarred and age-encrypted to an OFF-BOX recipient. Ciphertext is safe to carry in the
#     snapshot — the private key lives only in the owner's password manager — so a box loss
#     becomes a decrypt-and-restore, not a day of re-minting the whole fleet's credentials.
#     Decrypt with: age -d -i <private-key> agent-box-secrets.tar.age | tar -xf - .
#     Fail loud if configured-but-broken: a silently-missing secrets backup is the exact
#     failure class this script exists to kill. Skips only when no recipient is set.
if [ -n "${AGE_SECRETS_RECIPIENT:-}" ]; then
  command -v age >/dev/null || { echo "backup: AGE_SECRETS_RECIPIENT set but 'age' not installed" >&2; exit 1; }
  mkdir -p "$DUMP/secrets"
  if [ "${LARES_CURRENT_LAYOUT:-0}" = 1 ]; then
    # Current installations keep all host configuration under /etc/lares.
    # Only its age ciphertext enters restic; the identity stays off-box.
    SECRET_PATHS=(etc/lares)
    # The agents' token folder (each agent's model-gateway key, door tokens and outside-tool
    # tokens) is kept by the keeper under /srv/lares/secrets. It goes into the encrypted
    # bundle ONLY, so a restore does not mean reconnecting every door and outside tool by
    # hand. It is never a plain restic path (the source list below is explicit and names no parent of it).
    [ ! -d /srv/lares/secrets ] || SECRET_PATHS+=(srv/lares/secrets)
  else
    SECRET_PATHS=(etc/agent-box opt/agent-box/.env)
    [ ! -d /etc/lares ] || SECRET_PATHS+=(etc/lares)
  fi
  tar -C / -cf - "${SECRET_PATHS[@]}" \
    | age -r "$AGE_SECRETS_RECIPIENT" -o "$DUMP/secrets/agent-box-secrets.tar.age"
  [ -s "$DUMP/secrets/agent-box-secrets.tar.age" ] || { echo "backup: secrets bundle empty" >&2; exit 1; }
fi

# 2. Brain bare repo: pack objects for an on-disk-consistent snapshot (skip if absent).
[ -d /srv/brain.git ] && git --git-dir=/srv/brain.git gc --quiet || true

# 3. One restic snapshot. Only include paths that exist — restic treats a missing source
#    as an error (exit 3). Never snapshot the secret-bearing .env.
#    The WORKING TREES are included alongside the bare repos: uncommitted files (the
#    conversation log under _meta/conversations/, the clipper's _inbox/) live only there,
#    and a bare-repo-only snapshot silently misses them. Atlas and
#    the agents' state dirs have no upstream source of truth — losing them is permanent.
#    THE `[ -d "$p" ]` GUARD BELOW IS A TRAP, AND IT SPRUNG. A path that does not exist is
#    skipped without a word — correct for a genuinely optional path, silent data loss for a
#    RENAMED one. When an agent's data root moved to a fresh path, the list kept naming the old
#    one, the guard skipped the new one, and that agent's entire live store was never backed up
#    at all. Same for `/srv/taste` (the owner's curated store, written by the console) and
#    `/srv/agent` (the persona.md that OVERRIDES the image); both were checked against the
#    actual snapshot, not assumed, and neither was covered anywhere else. None of the three is
#    a cache; none is reconstructible.
#    tests/backup-coverage.test.ts now asserts this list against compose.yaml's bind mounts,
#    so the next rename fails a test instead of a restore.
if [ "${LARES_CURRENT_LAYOUT:-0}" = 1 ]; then
  # /srv/lares also contains live plaintext gateway/OAuth secrets. Never add
  # that parent to a snapshot, even with a restic exclude pattern: keep the
  # source list explicit and refuse a missing portable store.
  PATHS=("$DUMP")
  # /srv/lares/installation (the installation's own data, e.g. the deadline calendar) is
  # portable too, but an installation that has none does not have the folder: back it up when
  # present, never require it.
  STORES=(/srv/lares/agents /srv/lares/retired /srv/taste)
  [ -d /srv/lares/installation ] && STORES+=(/srv/lares/installation)
  for p in "${STORES[@]}"; do
    [ -d "$p" ] || { echo "backup: required portable store missing: $p" >&2; exit 1; }
    secret_hits=$(find "$p" \( -name .env -o -name secrets -o -name '*-key' -o -name '*-secret' \) -print)
    [ -z "$secret_hits" ] || { echo "backup: portable store contains a secret path: $p" >&2; exit 1; }
    PATHS+=("$p")
  done
  # Refuse an unclassified new top-level store rather than silently omitting it.
  for p in /srv/lares/*; do
    [ -e "$p" ] || continue
    case "$p" in
      /srv/lares/agents|/srv/lares/retired|/srv/lares/installation|/srv/lares/backup|/srv/lares/egress|/srv/lares/secrets|/srv/lares/compose.lares-agents.yaml) ;;
      *) echo "backup: unclassified Lares store: $p" >&2; exit 1 ;;
    esac
  done
else
  PATHS=("$DUMP" /opt/agent-box)
  for p in /srv/brain /srv/brain.git /srv/atlas /srv/atlas.git /srv/network \
           /srv/agent /srv/taste /srv/lares; do
    [ -d "$p" ] && PATHS+=("$p")
  done
fi
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
#    pinged nothing, on failing and successful nights alike. That is how failed
#    nights went unnoticed: the "exit non-zero so the heartbeat never
#    fires" design above was correct and had nothing on the other end.
#    Liveness is now owned by ONE thing — backup-verify.sh — which asks the repository
#    whether a fresh snapshot is actually IN it rather than asking this script whether
#    it ran. It catches everything a heartbeat here would (no run -> no fresh snapshot)
#    plus the failures a backup can have: a green run that archived no dump.
#    One job, one liveness owner, one alert (ADR-0012 rule 4).

# 5. Local cleanup — the snapshot is safely off-box now.
rm -rf "$DUMP"
