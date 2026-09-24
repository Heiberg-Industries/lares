#!/usr/bin/env bash
# update.sh — W8D-s3. The command that changes which images this installation runs.
# Nothing updates until a backup has actually been taken.
#
# WHY THE ORDER IS THE WHOLE POINT. An update that half-runs leaves an installation whose
# images and database disagree, and an update that skips the backup removes the only way
# back. So this script does one thing at a time, in one order, and every step says what
# undoes it:
#
#   1. read the release file            — digests only, or it is refused (lib/release-manifest.ts)
#   2. read what is running now         — from the installation's own compose file(s)
#   3. confirm a backup was VERIFIED    — backup_status's 'verify' row (sql/049_backup_status.sql)
#   4. take a fresh backup              — ops/backup.sh; a failure here changes nothing
#   5. write down what is running       — beginUpdate (sql/087_update_history.sql)
#   6. pull the new digests             — the compose file now names them
#   7. apply migrations                 — the ledger runner, never a file applied by hand
#   8. start the new images             — this is the first moment anything is switched
#   9. check they came up, then close the record with 'ok' or 'failed'
#
# A failure at ANY step leaves the images that were running still running and the record
# saying 'failed' with a one-sentence reason. It never leaves a half-switched installation
# that the record calls 'ok'.
#
# IT NEVER ROLLS THE DATABASE BACK, AND NEITHER DOES ANYTHING ELSE (owner decision D4).
# There are no down migrations, by decision (see services/box/lib/migration-runner.ts's own
# header). Once step 7 has run, ops/rollback.sh puts the SOFTWARE back and the database stays
# where the migration left it; going back past a migration means restoring the backup taken
# in step 4 (docs/runbooks/export-and-teardown.md).
#
# IT REACHES NOTHING BUT THE REGISTRY. The only thing that leaves this box is `docker pull`,
# to whatever registry the release file names. No heartbeat, no version ping, no telemetry,
# and no new version is ever looked for — you give this command a release file, it never goes
# to find one (owner decision D1).
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
# Where backup.sh and rollback.sh live. Defaults to this script's own directory, which is
# true both in the repository and on a box where the ops scripts are copied together.
OPS_DIR="${LARES_OPS_DIR:-$HERE}"
# Where migrate.ts and lib/ live — `pnpm -C "$BOX_DIR" migrate` is the ONLY way this script
# applies a migration (never a file applied by hand: the ledger is what makes an update
# repeatable).
BOX_DIR="${LARES_BOX_DIR:-$(cd "$HERE/.." && pwd)}"
# The same variable name ops/backup-verify.sh and ops/restore-drill.sh already use, but
# defaulting to the installer's own path (F1: $PREFIX/opt/lares/compose.yaml — one file, no
# override, since this engine now renders exactly one).
COMPOSE_DIR="${DB_COMPOSE_DIR:-/opt/lares}"
COMPOSE_FILES="${UPDATE_COMPOSE_FILES:-compose.yaml}"
# backup-verify.sh runs at 05:00 against a 03:00 backup, so a passing check is normally under
# 26h old. Older than this and the proof is last night's at best.
MAX_AGE_HOURS="${UPDATE_BACKUP_MAX_AGE_HOURS:-26}"
PG_USER="${PGUSER:-lares}"
PG_DATABASE="${PGDATABASE:-lares_state}"

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

WORK=$(mktemp -d "${TMPDIR:-/tmp}/lares-update-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

TAB=$(printf '\t')

# --- the seam into this repository's own TypeScript ----------------------------------------
# The release rules (lib/release-manifest.ts) and the update record (lib/update-history.ts)
# are engine code, not something to restate in shell where the two copies would drift. This
# temp program is the one place that calls them. LARES_UPDATE_RECORDER replaces it for the
# database half in tests — the release half always runs for real.
cat > "$WORK/record.mts" <<'TS'
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const boxDir = argv[0]!;
const op = argv[1];
const rest = argv.slice(2);
const lib = (name: string) => import(pathToFileURL(join(boxDir, "lib", name)).href);

async function main(): Promise<void> {
  if (op === "release") {
    const { parseReleaseManifest } = await lib("release-manifest.ts");
    const manifest = parseReleaseManifest(readFileSync(rest[0]!, "utf8"));
    let out = "release\t" + manifest.release + "\n";
    for (const service of Object.keys(manifest.images)) {
      out += "image\t" + service + "\t" + manifest.images[service] + "\n";
    }
    for (const sentence of manifest.breaking) out += "breaking\t" + sentence + "\n";
    process.stdout.write(out);
    return;
  }
  const { poolFromEnv } = await lib("db.ts");
  const history = await lib("update-history.ts");
  const pool = poolFromEnv();
  try {
    if (op === "previous-release") {
      const rows = await history.recentUpdates(pool);
      const last = rows.find((row: { outcome: string }) => row.outcome === "ok");
      process.stdout.write((last ? last.toRelease : "") + "\n");
    } else if (op === "begin") {
      const id = await history.beginUpdate(pool, {
        fromRelease: rest[0] === "" ? null : rest[0],
        toRelease: rest[1],
        images: JSON.parse(rest[2]!),
        snapshotId: rest[3] === "" ? null : rest[3],
      });
      process.stdout.write(String(id) + "\n");
    } else if (op === "finish") {
      await history.finishUpdate(pool, Number(rest[0]), rest[1], rest[2] === "" ? undefined : rest[2]);
    } else {
      throw new Error("update: unknown operation '" + String(op) + "'");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(1);
});
TS

# The database half of the seam. A non-zero exit here is never swallowed: a lost update
# record is exactly the failure the table exists to prevent.
recorder() {
  if [ -n "${LARES_UPDATE_RECORDER:-}" ]; then
    "$LARES_UPDATE_RECORDER" "$@"
  else
    node "$WORK/record.mts" "$BOX_DIR" "$@"
  fi
}

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
if ! recorder_out=$(node "$WORK/record.mts" "$BOX_DIR" release "$RELEASE_FILE" 2>"$WORK/release.err"); then
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
# backup-verify.sh is the single owner of that verdict (sql/049_backup_status.sql). An
# unreadable check counts as failing, never as passing — the same rule backup-verify.sh
# applies to every check it makes.
STATUS_SQL="SELECT ok, extract(epoch from now() - checked_at)::bigint FROM backup_status WHERE check_name = 'verify';"
STATUS_ROW=$(docker compose ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} exec -T db \
  psql -U "$PG_USER" -d "$PG_DATABASE" -tAc "$STATUS_SQL" 2>/dev/null) || STATUS_ROW=""
STATUS_ROW=$(printf '%s' "$STATUS_ROW" | tr -d '\r' | sed '/^$/d' | head -1)

BACKUP_REFUSAL=""
if [ -z "$STATUS_ROW" ]; then
  BACKUP_REFUSAL="I could not read whether this installation's backup has ever been verified. If services/box/sql/049_backup_status.sql has not been applied on this box yet, that is why."
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
  echo "update: if this installation's database has not had services/box/sql/087_update_history.sql applied yet, that is why. Apply it with: pnpm -C services/box migrate" >&2
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
if ! pnpm -C "$BOX_DIR" migrate; then
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
