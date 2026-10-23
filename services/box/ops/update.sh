#!/usr/bin/env bash
# update.sh — the command that changes which images this installation runs.
# Nothing updates until a backup has actually been taken.
#
# WHY THE ORDER IS THE WHOLE POINT. An update that half-runs leaves an installation whose
# images and database disagree, and an update that skips the backup removes the only way
# back. So this script does one thing at a time, in one order, and every step says what
# undoes it:
#
#   1. read the release file            — digests only, or it is refused (lib/release-manifest.ts)
#   2. read what is running now         — from the installation's own compose file(s)
#   3. confirm a backup was VERIFIED    — backup_status's 'verify' row (sql/001_baseline.sql)
#   4. take a fresh backup              — ops/backup.sh; a failure here changes nothing
#   5. write down what is running       — beginUpdate (sql/001_baseline.sql)
#   6. pull the new digests             — the compose file now names them
#   7. apply migrations                 — the ledger runner, never a file applied by hand
#   8. start the new images             — this is the first moment anything is switched
#   9. check they came up, then close the record with 'ok' or 'failed'
#
# A failure at ANY step leaves the images that were running still running and the record
# saying 'failed' with a one-sentence reason. It never leaves a half-switched installation
# that the record calls 'ok'.
#
# IT NEVER ROLLS THE DATABASE BACK, AND NEITHER DOES ANYTHING ELSE.
# There are no down migrations, by decision (see services/box/lib/migration-runner.ts's own
# header). Once step 7 has run, ops/rollback.sh puts the SOFTWARE back and the database stays
# where the migration left it; going back past a migration means restoring the backup taken
# in step 4 (docs/runbooks/export-and-teardown.md).
#
# IT REACHES NOTHING BUT THE REGISTRY. The only thing that leaves this box is `docker pull`,
# to whatever registry the release file names. No heartbeat, no version ping, no telemetry,
# and no new version is ever looked for — you give this command a release file, it never goes
# to find one.
#
# WHERE "WHAT IS RUNNING NOW" COMES FROM, AND WHEN IT IS NOT THERE. This repository is the
# ENGINE and ships no stack: `services/box/compose.lares-keeper.yaml` is the only compose file
# in it, and it starts the keeper and the egress proxy only. The file that names the running
# digests is INSTALLATION data on the box — the same file ops/backup-verify.sh already reaches
# for through DB_COMPOSE_DIR, plus whatever else UPDATE_COMPOSE_FILES names (an installation
# whose agents are rendered by the keeper adds that rendered file here). If no compose file on
# this box names an image by digest, there is nothing to write down, and this command refuses
# rather than guess. It does not invent a source.
#
# AND ONE THING IT CANNOT DO FOR YOU: if an agent's image is rendered by the keeper from the
# keeper's own configuration, the keeper writes that file itself and will put its configured
# image back the next time it reconciles. Change that configuration too. This script says so
# on the way out rather than pretending otherwise.
#
# Deploy: copy to the installation's ops directory (chmod 0750, root) beside backup.sh.
# Run: update.sh --release <file> [--dry-run] [--yes] [--even-though-the-backup-is-unproven]
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ORIGINAL_ARGS=("$@")
# Where backup.sh and rollback.sh live. Defaults to this script's own directory, which is
# true both in the repository and on a box where the ops scripts are copied together.
OPS_DIR="${LARES_OPS_DIR:-$HERE}"
# Where migrate.ts and lib/ live — the ledger runner (`pnpm -C "$BOX_DIR" migrate`, or the same
# program in the engine image) is the ONLY way this script applies a migration (never a file applied by hand: the ledger is what makes an update
# repeatable).
BOX_DIR="${LARES_BOX_DIR:-$(cd "$HERE/.." && pwd)}"
# The same variable name ops/backup-verify.sh and ops/restore-drill.sh already use, but
# defaulting to the installer's own path (F1: $PREFIX/opt/lares/compose.yaml — one file, no
# override, since this engine now renders exactly one).
if [ "${LARES_PREFIX+x}" = x ]; then ADMISSION_PREFIX="$LARES_PREFIX"; else ADMISSION_PREFIX=/; fi
if [ "${DB_COMPOSE_DIR+x}" = x ]; then COMPOSE_DIR="$DB_COMPOSE_DIR"
elif [ "$ADMISSION_PREFIX" != / ]; then COMPOSE_DIR=""
else COMPOSE_DIR="${ADMISSION_PREFIX%/}/opt/lares"; fi
if [ "${UPDATE_COMPOSE_FILES+x}" = x ]; then COMPOSE_FILES="$UPDATE_COMPOSE_FILES"; else COMPOSE_FILES=compose.yaml; fi
ENGINE_MODE=host
# backup-verify.sh runs at 05:00 against a 03:00 backup, so a passing check is normally under
# 26h old. Older than this and the proof is last night's at best.
MAX_AGE_HOURS="${UPDATE_BACKUP_MAX_AGE_HOURS:-26}"
PG_USER="${PGUSER:-lares_app}"
if [ "${LARES_OPERATOR_PASSWORD_FILE+x}" = x ]; then OPERATOR_PASSWORD_FILE="$LARES_OPERATOR_PASSWORD_FILE"; else OPERATOR_PASSWORD_FILE="${ADMISSION_PREFIX%/}/etc/lares/operator/database-password"; fi
SECRETS_DIR="${ADMISSION_PREFIX%/}/etc/lares/secrets"
if [ "${PGHOST+x}" = x ]; then UPDATE_PGHOST="$PGHOST"; else UPDATE_PGHOST=127.0.0.1; fi
if [ "${PGPORT+x}" = x ]; then UPDATE_PGPORT="$PGPORT"; else UPDATE_PGPORT=5432; fi
if [ "${PGDATABASE+x}" = x ]; then UPDATE_PGDATABASE="$PGDATABASE"; else UPDATE_PGDATABASE=lares_state; fi
PG_DATABASE="$UPDATE_PGDATABASE"
MAINTENANCE_TEST_OWNER=0
if [ "${LARES_MAINTENANCE_TESTING:-}" = 1 ] && [ "$(id -u)" -ne 0 ]; then
  MAINTENANCE_TEST_OWNER=1
fi

# 64 usage · 75 the backup failed · 78 refused before anything changed · 70 failed afterwards.
EX_USAGE=64
EX_FAILED=70
EX_BACKUP=75
EX_REFUSED=78

RELEASE_FILE=""
DRY_RUN=0
ASSUME_YES=0
UNPROVEN_OK=0

usage() {
  cat <<'EOF' >&2
Usage: update.sh --release <file> [--dry-run] [--yes] [--even-though-the-backup-is-unproven]

Updates this installation to the images the release file names. Takes a backup first, writes
down which images were running, and stops at the first thing that goes wrong.

  --release <file>   the release file: a list of image digests, nothing else
  --dry-run          say what would happen and change nothing
  --yes              do not ask for confirmation (for an unattended run)
  --even-though-the-backup-is-unproven
                     go ahead although last night's backup was never verified. Deliberately
                     long to type, and written into this update's record.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --release)
      if [ $# -lt 2 ]; then
        echo "update: --release needs the path to a release file" >&2
        exit "$EX_USAGE"
      fi
      RELEASE_FILE="$2"
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --even-though-the-backup-is-unproven) UNPROVEN_OK=1; shift ;;
    -h|--help) usage; exit "$EX_USAGE" ;;
    *)
      echo "update: I do not know the argument '$1', so I have not done anything." >&2
      usage
      exit "$EX_USAGE"
      ;;
  esac
done

if [ -z "$RELEASE_FILE" ]; then
  echo "update: no --release file was given, so there is nothing to update to." >&2
  usage
  exit "$EX_USAGE"
fi

if [ ! -f "$RELEASE_FILE" ]; then
  echo "update: there is no release file at '$RELEASE_FILE'. Nothing has been changed." >&2
  exit "$EX_USAGE"
fi

# Validate the complete target before creating scratch files or contacting Docker/Postgres.
if [ -r "$HERE/engine-run.sh" ]; then
  # shellcheck source=engine-run.sh
  . "$HERE/engine-run.sh"
  if engine_image_mode; then ENGINE_MODE=image; fi
fi
validate_target() {
  if [ "$MAINTENANCE_TEST_OWNER" = 1 ]; then
    python3 "$HERE/maintenance-custody.py" validate-update-target "$ADMISSION_PREFIX" "$COMPOSE_DIR" \
      "$COMPOSE_FILES" "$SECRETS_DIR/database-password" "$OPERATOR_PASSWORD_FILE" \
      "$UPDATE_PGHOST" "$UPDATE_PGPORT" "$UPDATE_PGDATABASE" --test-owner
  else
    python3 "$HERE/maintenance-custody.py" validate-update-target "$ADMISSION_PREFIX" "$COMPOSE_DIR" \
      "$COMPOSE_FILES" "$SECRETS_DIR/database-password" "$OPERATOR_PASSWORD_FILE" \
      "$UPDATE_PGHOST" "$UPDATE_PGPORT" "$UPDATE_PGDATABASE"
  fi
}
if ! validate_target; then
  echo "update: the requested Compose, credentials, or database do not match one installed Lares target." >&2
  exit "$EX_REFUSED"
fi

if [ "${LARES_MAINTENANCE_ADMITTED:-}" != 1 ]; then
  if [ "$MAINTENANCE_TEST_OWNER" = 1 ]; then
    exec python3 "$HERE/maintenance-custody.py" run-normal "$ADMISSION_PREFIX" update --test-owner -- "${ORIGINAL_ARGS[@]}"
  fi
  exec python3 "$HERE/maintenance-custody.py" run-normal "$ADMISSION_PREFIX" update \
    -- "${ORIGINAL_ARGS[@]}"
fi
if [ "$MAINTENANCE_TEST_OWNER" = 1 ]; then
  python3 "$HERE/maintenance-custody.py" assert-normal-held "$ADMISSION_PREFIX" update --test-owner >/dev/null 2>&1
else
  python3 "$HERE/maintenance-custody.py" assert-normal-held "$ADMISSION_PREFIX" update >/dev/null 2>&1
fi
if [ "$?" -ne 0 ]; then
  echo "update: normal maintenance admission is not valid; nothing has been changed." >&2
  exit "$EX_REFUSED"
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/lares-update-XXXXXX")
trap 'client_status=$?; trap - EXIT; if engine_normal_client_cleanup; then rm -rf "$WORK"; else client_status=78; echo "update: client cleanup is uncertain; evidence retained at $WORK" >&2; fi; exit "$client_status"' EXIT

TAB=$(printf '\t')

# --- the seam into this repository's own TypeScript ----------------------------------------
# The release rules (lib/release-manifest.ts) and the update record (lib/update-history.ts)
# are engine code, not something to restate in shell where the two copies would drift.
# bin/update-record.ts is the one place that calls them. LARES_UPDATE_RECORDER replaces it for
# the database half in tests — the release half always runs for real.
#
# TWO MODES. On a box whose engine came from an image (ops/engine-run.sh: an `engine-image` file
# in the box folder, or LARES_ENGINE_IMAGE) there is no node and no pnpm: every program runs in
# a throwaway container of the engine image, and for an update that image is the TARGET
# release's keeper image, so the new release's own parser and migrations are the ones that run.
# On a checkout (no such file) everything runs on the host exactly as it always has.
# Where the database password FILE is, for a container that reaches the database (never a value
# in argv or in the environment — see engine-run.sh).
DB_ENV=(--env "DATABASE_PASSWORD_FILE=$SECRETS_DIR/database-password"
  --env "PGHOST=$UPDATE_PGHOST" --env "PGPORT=$UPDATE_PGPORT"
  --env "PGDATABASE=$PG_DATABASE" --env "PGUSER=$PG_USER")
MIGRATION_ENV=(--env "DATABASE_PASSWORD_FILE=$OPERATOR_PASSWORD_FILE"
  --env "LARES_OPERATOR_PASSWORD_FILE=$OPERATOR_PASSWORD_FILE"
  --env "PGHOST=$UPDATE_PGHOST" --env "PGPORT=$UPDATE_PGPORT"
  --env "PGDATABASE=$PG_DATABASE" --env "PGUSER=lares_operator")

# Reading a release file needs no database, only the file.
release_program() {
  if [ "$ENGINE_MODE" = image ]; then
    local file="$RELEASE_FILE"
    case "$file" in /*) ;; *) file="$PWD/$file" ;; esac
    engine_normal_client update --ro "$file" bin/update-record.ts release "$file"
  else
    node "$BOX_DIR/bin/update-record.ts" release "$RELEASE_FILE"
  fi
}

# The database half of the seam. A non-zero exit here is never swallowed: a lost update
# record is exactly the failure the table exists to prevent.
recorder() {
  if [ -n "${LARES_UPDATE_RECORDER:-}" ] && [ "${LARES_MAINTENANCE_TESTING:-}" = 1 ] && [ "$(id -u)" -ne 0 ]; then
    "$LARES_UPDATE_RECORDER" "$@"
  elif [ "$ENGINE_MODE" = image ]; then
    engine_normal_client update --ro "$SECRETS_DIR/database-password" "${DB_ENV[@]}" bin/update-record.ts "$@"
  else
    node "$BOX_DIR/bin/update-record.ts" "$@"
  fi
}

# The migration runner: in the target release's engine image, or (on a checkout) through pnpm.
run_migrations() {
  [ -f "$OPERATOR_PASSWORD_FILE" ] && [ ! -L "$OPERATOR_PASSWORD_FILE" ] \
    && [ "$(stat -c '%u:%a' "$OPERATOR_PASSWORD_FILE" 2>/dev/null || true)" = 0:600 ] \
    || { echo "update: the explicit offline operator credential is missing or unsafe; migrations were not run." >&2; return 78; }
  if [ "$ENGINE_MODE" = image ]; then
    engine_normal_client update --ro "$OPERATOR_PASSWORD_FILE" "${MIGRATION_ENV[@]}" migrate.ts --schema-owner
  else
    LARES_OPERATOR_PASSWORD_FILE="$OPERATOR_PASSWORD_FILE" DATABASE_PASSWORD_FILE="$OPERATOR_PASSWORD_FILE" \
      PGHOST="$UPDATE_PGHOST" PGPORT="$UPDATE_PGPORT" PGDATABASE="$PG_DATABASE" PGUSER=lares_operator \
      pnpm -C "$BOX_DIR" migrate -- --schema-owner
  fi
}

# In image mode the engine is the TARGET release's keeper image. It is fetched now, before
# anything is read or changed, so a registry problem is a plain refusal and not a half-update.
if [ "$ENGINE_MODE" = image ]; then
  if ! engine_resolve_target_image "$RELEASE_FILE"; then
    echo "update: this release file names no engine image (images.\"lares-keeper\" as a full digest), so the new migrations cannot be run. Nothing has been changed." >&2
    exit "$EX_REFUSED"
  fi
  if ! docker image inspect "$ENGINE_IMAGE" >/dev/null 2>&1 && ! docker pull "$ENGINE_IMAGE" >/dev/null; then
    echo "update: could not download the engine image $ENGINE_IMAGE, so nothing was changed." >&2
    exit "$EX_REFUSED"
  fi
fi

is_digest_reference() {
  printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$'
}

# service<TAB>image for every service in one compose file, taking the FIRST image line under
# each service key. Plain awk, no gawk extensions, no bash associative arrays (bash 3.2).
compose_images() {
  awk '
    /^services:[ \t]*$/ { in_services = 1; next }
    /^[^ \t#]/ { in_services = 0 }
    in_services != 1 { next }
    /^[ \t]*#/ { next }
    /^  [A-Za-z0-9][A-Za-z0-9._-]*:[ \t]*$/ {
      name = $0
      sub(/^[ \t]*/, "", name)
      sub(/:[ \t]*$/, "", name)
      seen = 0
      next
    }
    name != "" && seen == 0 && /^[ \t]+image:[ \t]*/ {
      image = $0
      sub(/^[ \t]*image:[ \t]*/, "", image)
      gsub(/^"|"$/, "", image)
      gsub(/^'"'"'|'"'"'$/, "", image)
      print name "\t" image
      seen = 1
    }
  ' "$1"
}

# Replace the image line of every service named in the map file, and touch nothing else —
# not the other services, not the indentation, not a comment.
rewrite_compose() {
  awk -v mapfile="$2" '
    BEGIN {
      while ((getline line < mapfile) > 0) {
        cut = index(line, "\t")
        if (cut > 0) replacement[substr(line, 1, cut - 1)] = substr(line, cut + 1)
      }
    }
    /^services:[ \t]*$/ { in_services = 1; print; next }
    /^[^ \t#]/ { in_services = 0 }
    in_services == 1 && /^  [A-Za-z0-9][A-Za-z0-9._-]*:[ \t]*$/ {
      name = $0
      sub(/^[ \t]*/, "", name)
      sub(/:[ \t]*$/, "", name)
      seen = 0
      print
      next
    }
    in_services == 1 && name != "" && seen == 0 && /^[ \t]+image:[ \t]*/ {
      seen = 1
      if (name in replacement) {
        indentation = $0
        sub(/image:.*$/, "", indentation)
        print indentation "image: " replacement[name]
        next
      }
      print
      next
    }
    { print }
  ' "$1" > "$WORK/rewritten" && cat "$WORK/rewritten" > "$1"
}

# --- 1. the release file -------------------------------------------------------------------
if ! recorder_out=$(release_program 2>"$WORK/release.err"); then
  echo "update: this release file was refused, so nothing has been changed." >&2
  sed 's/^/update: /' "$WORK/release.err" >&2
  exit "$EX_REFUSED"
fi
printf '%s\n' "$recorder_out" > "$WORK/manifest.tsv"

TO_RELEASE=$(awk -F'\t' '$1 == "release" { print $2 }' "$WORK/manifest.tsv")
awk -F'\t' '$1 == "image" { print $2 "\t" $3 }' "$WORK/manifest.tsv" > "$WORK/release-images.tsv"
awk -F'\t' '$1 == "breaking" { print $2 }' "$WORK/manifest.tsv" > "$WORK/breaking.txt"

# --- 2. what is running now ----------------------------------------------------------------
: > "$WORK/current.tsv"
: > "$WORK/not-pinned.txt"
FOUND_COMPOSE=""
COMPOSE_ARGS=()
for file in $COMPOSE_FILES; do
  case "$file" in
    /*) path="$file" ;;
    *) path="$COMPOSE_DIR/$file" ;;
  esac
  [ -f "$path" ] || continue
  FOUND_COMPOSE="$FOUND_COMPOSE $path"
  COMPOSE_ARGS+=(-f "$path")
  while IFS="$TAB" read -r service image; do
    [ -n "$service" ] || continue
    if is_digest_reference "$image"; then
      printf '%s\t%s\t%s\n' "$service" "$image" "$path" >> "$WORK/current.tsv"
    else
      printf '%s\n' "$service" >> "$WORK/not-pinned.txt"
    fi
  done < <(compose_images "$path")
done

if [ ! -s "$WORK/current.tsv" ]; then
  echo "update: I could not write down what is running, so I cannot promise to put it back. Nothing has been changed." >&2
  if [ -z "$FOUND_COMPOSE" ]; then
    echo "update: there is no compose file at any of these paths. Name the installation's own compose file(s) in UPDATE_COMPOSE_FILES, relative to DB_COMPOSE_DIR ($COMPOSE_DIR), or as absolute paths." >&2
  else
    echo "update: none of$FOUND_COMPOSE names an image by digest (name@sha256:...), so there is no version of anything to put back." >&2
  fi
  exit "$EX_REFUSED"
fi

# What this release changes here, matched by image NAME: the release says which image, the
# compose file says which service runs it. No mapping between the two is invented.
: > "$WORK/plan.tsv"
while IFS="$TAB" read -r service image path; do
  [ -n "$service" ] || continue
  repository=${image%@*}
  replacement=$(awk -F'\t' -v repository="$repository" '
    { candidate = $2; sub(/@.*$/, "", candidate); if (candidate == repository) print $2 }
  ' "$WORK/release-images.tsv" | head -1)
  [ -n "$replacement" ] || continue
  printf '%s\t%s\t%s\t%s\n' "$service" "$path" "$image" "$replacement" >> "$WORK/plan.tsv"
done < "$WORK/current.tsv"

if [ ! -s "$WORK/plan.tsv" ]; then
  echo "update: this release names no image that this installation is running, so there is nothing here for it to update. Nothing has been changed." >&2
  exit "$EX_REFUSED"
fi

# --- 3. say what this would do -------------------------------------------------------------
echo "update: release $TO_RELEASE"
if [ -s "$WORK/breaking.txt" ]; then
  echo "update: this release changes how things work. Read this before going on:"
  while IFS= read -r sentence; do
    [ -n "$sentence" ] || continue
    echo "  - $sentence"
  done < "$WORK/breaking.txt"
fi
echo "update: this would change:"
while IFS="$TAB" read -r service path image replacement; do
  [ -n "$service" ] || continue
  echo "  $service"
  echo "    from $image"
  echo "    to   $replacement"
done < "$WORK/plan.tsv"
if [ -s "$WORK/not-pinned.txt" ]; then
  echo "update: left alone, because their images are not named by digest and so cannot be put back: $(tr '\n' ' ' < "$WORK/not-pinned.txt")"
fi

# --- 4. has a backup been taken AND verified? ----------------------------------------------
# backup-verify.sh is the single owner of that verdict (sql/001_baseline.sql). An
# unreadable check counts as failing, never as passing — the same rule backup-verify.sh
# applies to every check it makes.
STATUS_SQL="SELECT ok, extract(epoch from now() - checked_at)::bigint FROM backup_status WHERE check_name = 'verify';"
STATUS_ROW=$(docker compose ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} exec -T db \
  psql -U "$PG_USER" -d "$PG_DATABASE" -tAc "$STATUS_SQL" 2>/dev/null) || STATUS_ROW=""
STATUS_ROW=$(printf '%s' "$STATUS_ROW" | tr -d '\r' | sed '/^$/d' | head -1)

BACKUP_REFUSAL=""
if [ -z "$STATUS_ROW" ]; then
  BACKUP_REFUSAL="I could not read whether this installation's backup has ever been verified. If services/box/sql/001_baseline.sql has not been applied on this box yet, that is why."
else
  STATUS_OK=${STATUS_ROW%%|*}
  STATUS_AGE=${STATUS_ROW#*|}
  if [ -z "$STATUS_AGE" ] || [ -z "$STATUS_OK" ]; then
    BACKUP_REFUSAL="this installation's backup has never been verified, so there is no proof that what you have can be restored."
  else
    case "$STATUS_AGE" in
      ''|*[!0-9]*)
        BACKUP_REFUSAL="the backup check's own age came back unreadable ('$STATUS_AGE'), and an unreadable check counts as a failing one."
        ;;
      *)
        STATUS_AGE_HOURS=$(( STATUS_AGE / 3600 ))
        if [ "$STATUS_OK" != "t" ]; then
          BACKUP_REFUSAL="the last backup check did not pass, ${STATUS_AGE_HOURS}h ago. A backup nobody has proven can be restored is not a backup yet."
        elif [ "$STATUS_AGE_HOURS" -gt "$MAX_AGE_HOURS" ]; then
          BACKUP_REFUSAL="the last backup check passed ${STATUS_AGE_HOURS}h ago, which is older than the ${MAX_AGE_HOURS}h this command will accept, so it says nothing about what is on this box now."
        fi
        ;;
    esac
  fi
fi

OVERRIDE_NOTE=""
if [ -n "$BACKUP_REFUSAL" ]; then
  if [ "$UNPROVEN_OK" -eq 1 ]; then
    OVERRIDE_NOTE="ran with --even-though-the-backup-is-unproven: $BACKUP_REFUSAL"
    echo "update: going ahead with an unproven backup, because you asked for that in so many words."
    echo "update: $BACKUP_REFUSAL"
  else
    echo "update: $BACKUP_REFUSAL Nothing has been changed." >&2
    echo "update: take one and prove it first: $OPS_DIR/backup.sh && $OPS_DIR/backup-verify.sh" >&2
    echo "update: or, if you have decided to go ahead without that proof, run this again with --even-though-the-backup-is-unproven." >&2
    exit "$EX_REFUSED"
  fi
fi

# --- 5. a dry run stops here, having changed nothing ---------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  echo "update: this was a dry run. Nothing has been changed."
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  if [ -t 0 ]; then
    printf 'update: go ahead? Type yes to continue: '
    read -r answer || answer=""
    if [ "$answer" != "yes" ]; then
      echo "update: not going ahead. Nothing has been changed." >&2
      exit "$EX_REFUSED"
    fi
  else
    echo "update: there is nobody here to ask, so I am not going ahead. Nothing has been changed. Read the list above and run this again with --yes." >&2
    exit "$EX_REFUSED"
  fi
fi

# --- 6. a fresh backup, before anything else -----------------------------------------------
# undo: none needed — a backup adds a snapshot and changes nothing on this box.
echo "update: taking a backup first."
if ! "$OPS_DIR/backup.sh" 2>&1 | tee "$WORK/backup.out"; then
  echo "update: the backup did not finish, so nothing else has been done. The message above says why. Nothing has been changed." >&2
  exit "$EX_BACKUP"
fi
# restic prints "snapshot <id> saved" on success. Best effort only: the record's own list of
# digests is what a rollback needs, and an empty snapshot id costs nothing.
SNAPSHOT_ID=$(sed -n 's/.*snapshot \([0-9a-f][0-9a-f]*\) saved.*/\1/p' "$WORK/backup.out" | tail -1)

# --- 7. write down what is running ---------------------------------------------------------
# undo: the row is closed as 'failed' by every failure path below.
FROM_RELEASE=$(recorder previous-release 2>/dev/null | tr -d '\r' | head -1) || FROM_RELEASE=""
IMAGES_JSON=$(awk -F'\t' '
  BEGIN { printf "{" }
  { gsub(/"/, "", $1); gsub(/"/, "", $3); printf "%s\"%s\":\"%s\"", (written++ ? "," : ""), $1, $3 }
  END { printf "}" }
' "$WORK/plan.tsv")

if ! UPDATE_ID=$(recorder begin "$FROM_RELEASE" "$TO_RELEASE" "$IMAGES_JSON" "$SNAPSHOT_ID"); then
  echo "update: I could not write down what is running, so I cannot promise to put it back. Nothing has been changed." >&2
  echo "update: if this installation's database has not had services/box/sql/001_baseline.sql applied yet, that is why. Apply it with: pnpm -C services/box migrate" >&2
  exit "$EX_REFUSED"
fi
UPDATE_ID=$(printf '%s' "$UPDATE_ID" | tr -d '\r' | head -1)

close_record() {
  local outcome="$1" detail="$2"
  if [ -n "$OVERRIDE_NOTE" ]; then detail="$detail ($OVERRIDE_NOTE)"; fi
  # The column holds 400 characters; a record that is refused for being too long is a lost
  # record, which is the one thing this table must not be.
  detail=$(printf '%s' "$detail" | cut -c1-400)
  recorder finish "$UPDATE_ID" "$outcome" "$detail" \
    || echo "update: I could not close this update's record (id $UPDATE_ID, $outcome). The row still says what was running before." >&2
}

# undo: put every compose file back exactly as it was.
awk -F'\t' '{ print $1 "\t" $4 }' "$WORK/plan.tsv" > "$WORK/replacements.tsv"
: > "$WORK/originals.tsv"
INDEX=0
for path in $(awk -F'\t' '{ print $2 }' "$WORK/plan.tsv" | sort -u); do
  INDEX=$(( INDEX + 1 ))
  cat "$path" > "$WORK/original-$INDEX"
  printf '%s\t%s\n' "$INDEX" "$path" >> "$WORK/originals.tsv"
  rewrite_compose "$path" "$WORK/replacements.tsv"
done

restore_compose_files() {
  while IFS="$TAB" read -r index path; do
    [ -n "$index" ] || continue
    cat "$WORK/original-$index" > "$path"
  done < "$WORK/originals.tsv"
}

# --- 8. pull the new digests ----------------------------------------------------------------
# The compose file now names them, and it can only name digests: a name that is not a full
# digest reference never reaches it (step 2 refuses one, lib/release-manifest.ts refuses one).
echo "update: pulling the new images."
if ! docker compose ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} pull; then
  restore_compose_files
  close_record failed "the new images could not be pulled"
  echo "update: the new images could not be pulled, so nothing was switched. The images that were running before are still running." >&2
  exit "$EX_FAILED"
fi

# --- 9. migrations, after the backup and before the switch ----------------------------------
# Through the ledger runner, never by applying a file by hand. There is no way back from a
# migration except the backup taken in step 6 — which is why that step is not optional.
echo "update: applying migrations."
if ! run_migrations; then
  restore_compose_files
  close_record failed "the migrations were refused"
  echo "update: the migrations were refused, so the new images have not been started and the software you were running is still running." >&2
  echo "update: nothing needs putting back. If you do find this installation on the new images, $OPS_DIR/rollback.sh puts the previous ones back." >&2
  exit "$EX_FAILED"
fi

# --- 10. the switch — the first moment anything changes -------------------------------------
# undo: $OPS_DIR/rollback.sh, which puts back exactly the digests written down in step 7.
echo "update: starting the new images."
if ! docker compose ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} up -d; then
  close_record failed "the new images could not be started"
  echo "update: the new images could not be started. Put the previous ones back with: $OPS_DIR/rollback.sh" >&2
  exit "$EX_FAILED"
fi

# --- 11. did they come up? ------------------------------------------------------------------
RUNNING=$(docker compose ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} ps --services --filter status=running 2>/dev/null) || RUNNING=""
MISSING=""
while IFS="$TAB" read -r service path image replacement; do
  [ -n "$service" ] || continue
  case "
$RUNNING
" in
    *"
$service
"*) : ;;
    *) MISSING="$MISSING $service" ;;
  esac
done < "$WORK/plan.tsv"

if [ -n "$MISSING" ]; then
  close_record failed "did not come up after the switch:$MISSING"
  echo "update: these did not come up after the switch:$MISSING" >&2
  echo "update: the new images are in place and they are not running. This command will not put them back on its own — you decide that, with: $OPS_DIR/rollback.sh" >&2
  exit "$EX_FAILED"
fi

close_record ok "updated to $TO_RELEASE"
echo "update: $TO_RELEASE is in place."
echo "update: the images that were running before are written down. $OPS_DIR/rollback.sh puts them back — the software, not the database."
echo "update: if any of these images is rendered into a compose file by the keeper from its own configuration, change that configuration too, or the keeper puts its configured image back the next time it reconciles."
