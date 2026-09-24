#!/usr/bin/env bash
# rollback.sh — W8D-s4. The command that puts the previous images back.
#
# THIS IS THE COMMAND SOMEBODY RUNS AT TWO IN THE MORNING, after ops/update.sh has already
# gone wrong. So it does exactly one thing and is unable to do a second:
#
#   1. read the last update's record       — update_history (sql/087_update_history.sql)
#   2. say what it would put back, and what it does NOT put back
#   3. ask, unless --yes
#   4. copy the installation's compose file(s) aside, then write the previous digests into them
#   5. docker compose pull  — the old digests may have been pruned; a failure puts the file back
#   6. docker compose up -d
#   7. check they came up
#   8. close the record with 'rolled-back'
#
# IT ONLY EVER GOES BACK ONE STEP (owner decision D3). The table keeps ten records so you can
# SEE what happened; this command reads exactly one — the newest. Once that record says
# 'rolled-back', running this again REFUSES rather than walking further back or flipping
# forward again. There is no --steps and no --to-release, deliberately: the further back you
# go the more likely the database has moved on in a way the old images cannot read, and there
# are no down migrations by decision (services/box/lib/migration-runner.ts's own header).
#
# IT DOES NOT PUT THE DATABASE BACK, AND IT SAYS SO EVERY TIME (owner decision D4). It runs no
# migration in either direction, writes nothing to the database except its own record, and
# restores nothing. Every update applies the migrations, and nothing written down says whether
# a given one changed anything — so this command assumes one did, says so before it acts, and
# names the backup that was taken before that update. Going back past a migration means
# restoring that backup (docs/runbooks/export-and-teardown.md).
#
# WHAT IT PUTS BACK COMES ONLY FROM THE RECORD. Not from what Docker happens to have cached,
# not from a registry listing, not from a guess. No record means there is nothing written down
# to go back to, and this command refuses and prints the by-hand form instead. Every value in
# the record is a full digest reference — the table's own CHECK guarantees it
# (update_history_images_are_digests), and this script checks again before it writes one into a
# compose file, because the thing being protected here is what actually starts.
#
# WHERE THE DIGESTS ARE WRITTEN. The installation's own compose file(s), the same ones
# ops/update.sh read them from: DB_COMPOSE_DIR plus UPDATE_COMPOSE_FILES. This repository is
# the ENGINE and ships no stack, so there is nowhere else they could come from. Services are
# matched by compose SERVICE NAME, because that is the key update.sh wrote the record with,
# from this very file.
#
# AND ONE THING IT CANNOT DO FOR YOU: if an agent's image is rendered into a compose file by
# the keeper from the keeper's own configuration, the keeper writes that file itself and will
# put its configured image back the next time it reconciles. Change that configuration too.
#
# Deploy: copy to the installation's ops directory (chmod 0750, root) beside update.sh.
# Run: rollback.sh [--dry-run] [--yes]
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# Where update.sh and backup.sh live. Defaults to this script's own directory, which is true
# both in the repository and on a box where the ops scripts are copied together.
OPS_DIR="${LARES_OPS_DIR:-$HERE}"
# Where lib/ lives — the update record's rules are engine code, not restated here.
BOX_DIR="${LARES_BOX_DIR:-$(cd "$HERE/.." && pwd)}"
# The same names ops/update.sh uses, so a rollback reads exactly the files the update wrote —
# the installer's own path (F1: $PREFIX/opt/lares/compose.yaml — one file, no override).
COMPOSE_DIR="${DB_COMPOSE_DIR:-/opt/lares}"
COMPOSE_FILES="${UPDATE_COMPOSE_FILES:-compose.yaml}"

# 64 usage · 78 refused, nothing changed · 70 the rollback itself failed.
EX_USAGE=64
EX_FAILED=70
EX_REFUSED=78

DRY_RUN=0
ASSUME_YES=0

usage() {
  cat <<'EOF' >&2
Usage: rollback.sh [--dry-run] [--yes]

Puts back the image digests that were running before the last update, and nothing else. It
goes back exactly one step, and it does not put the database back.

  --dry-run   say what would happen and change nothing
  --yes       do not ask for confirmation (for an unattended run)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit "$EX_USAGE" ;;
    *)
      echo "rollback: I do not know the argument '$1', so I have not done anything." >&2
      usage
      exit "$EX_USAGE"
      ;;
  esac
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/lares-rollback-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

TAB=$(printf '\t')

# --- the seam into this repository's own TypeScript ----------------------------------------
# The update record (lib/update-history.ts) is engine code. This temp program is the one place
# that calls it. LARES_UPDATE_RECORDER replaces it in tests. Mirrors ops/update.sh's seam
# deliberately: the two scripts stay independent files, and the duplication is three small
# helpers rather than a shared library nobody can read on its own at two in the morning.
cat > "$WORK/record.mts" <<'TS'
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const boxDir = argv[0]!;
const op = argv[1];
const rest = argv.slice(2);
const lib = (name: string) => import(pathToFileURL(join(boxDir, "lib", name)).href);

async function main(): Promise<void> {
  const { poolFromEnv } = await lib("db.ts");
  const history = await lib("update-history.ts");
  const pool = poolFromEnv();
  try {
    if (op === "previous-images") {
      // Exactly one record: the newest. Going further back is not an option this command has.
      const [last] = await history.recentUpdates(pool, 1);
      if (!last) return; // nothing written down — the caller refuses
      // previousImages() is the module's own answer to "what was running before the newest
      // update that finished ok". When the newest record IS that update, it is the source. An
      // update that failed after switching is the other case a rollback exists for, and its
      // own row holds the same map.
      const images = last.outcome === "ok" ? await history.previousImages(pool) : last.images;
      let out =
        ["record", String(last.id), last.outcome, last.toRelease, last.snapshotId ?? ""].join("\t") + "\n";
      for (const service of Object.keys(images ?? {})) {
        out += ["image", service, (images as Record<string, string>)[service]].join("\t") + "\n";
      }
      process.stdout.write(out);
    } else if (op === "finish") {
      await history.finishUpdate(pool, Number(rest[0]), rest[1], rest[2] === "" ? undefined : rest[2]);
    } else {
      throw new Error("rollback: unknown operation '" + String(op) + "'");
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

recorder() {
  if [ -n "${LARES_UPDATE_RECORDER:-}" ]; then
    "$LARES_UPDATE_RECORDER" "$@"
  else
    node "$WORK/record.mts" "$BOX_DIR" "$@"
  fi
}

# Duplicated from ops/update.sh on purpose — see the seam comment above.
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

# --- 1. the last update's record -----------------------------------------------------------
if ! recorder previous-images > "$WORK/record.tsv" 2>"$WORK/record.err"; then
  echo "rollback: I could not read what was running before, so I cannot put anything back. Nothing has been changed." >&2
  sed 's/^/rollback: /' "$WORK/record.err" >&2
  echo "rollback: if this installation's database has not had services/box/sql/087_update_history.sql applied yet, that is why." >&2
  exit "$EX_REFUSED"
fi

# The by-hand form, resolved the same way the real run resolves it, so the line printed in a
# refusal is one that can be pasted rather than read and corrected.
BY_HAND=""
for file in $COMPOSE_FILES; do
  case "$file" in
    /*) BY_HAND="$BY_HAND -f $file" ;;
    *) BY_HAND="$BY_HAND -f $COMPOSE_DIR/$file" ;;
  esac
done

no_record() {
  echo "rollback: No update has been recorded on this installation, so there is nothing written down to go back to. Nothing has been changed." >&2
  echo "rollback: this command never guesses a digest from what Docker happens to have cached — the wrong one would start and look fine." >&2
  echo "rollback: if you know the digest that was running, put it into that service's image: line by hand in the installation's own compose file, then run:" >&2
  echo "rollback:   docker compose$BY_HAND pull && docker compose$BY_HAND up -d" >&2
  exit "$EX_REFUSED"
}

RECORD_LINE=$(awk -F'\t' '$1 == "record" { print; exit }' "$WORK/record.tsv")
if [ -z "$RECORD_LINE" ]; then
  no_record
fi

UPDATE_ID=$(printf '%s\n' "$RECORD_LINE" | cut -f2)
OUTCOME=$(printf '%s\n' "$RECORD_LINE" | cut -f3)
TO_RELEASE=$(printf '%s\n' "$RECORD_LINE" | cut -f4)
SNAPSHOT_ID=$(printf '%s\n' "$RECORD_LINE" | cut -f5)

# --- 2. one step, and only one (owner decision D3) ------------------------------------------
case "$OUTCOME" in
  ok|failed)
    # 'ok' is the ordinary case. 'failed' is the case this command exists for: update.sh names
    # rollback.sh when the new images would not start, and that row holds the same map.
    :
    ;;
  rolled-back)
    echo "rollback: this installation has already been put back one step, from release $TO_RELEASE, so there is nothing further to put back. Nothing has been changed." >&2
    echo "rollback: a rollback goes back exactly one step, on purpose. The further back you go, the more likely the database has moved on in a way the older software cannot read." >&2
    echo "rollback: if this version is not the one you want either, the way forward is $OPS_DIR/update.sh with a release file." >&2
    exit "$EX_REFUSED"
    ;;
  started)
    echo "rollback: the last update has not finished — its record still says it is running. Nothing has been changed." >&2
    echo "rollback: if an update is running right now, let it finish; it puts things back itself when it can. If it was interrupted, its record will never close on its own, and putting images back by hand is the honest way out." >&2
    exit "$EX_REFUSED"
    ;;
  *)
    echo "rollback: the last update's record says '$OUTCOME', which I do not know how to act on. Nothing has been changed." >&2
    exit "$EX_REFUSED"
    ;;
esac

awk -F'\t' '$1 == "image" { print $2 "\t" $3 }' "$WORK/record.tsv" > "$WORK/recorded.tsv"
if [ ! -s "$WORK/recorded.tsv" ]; then
  no_record
fi

# Every value in the record is a digest reference — the table's own CHECK says so. Checked
# again here because the next thing that happens to one of these is being written into the
# file that decides what starts.
while IFS="$TAB" read -r service image; do
  [ -n "$service" ] || continue
  if ! is_digest_reference "$image"; then
    echo "rollback: the record says '$service' was running '$image', which is not an image pinned by digest, so I cannot put back a version I can name. Nothing has been changed." >&2
    exit "$EX_REFUSED"
  fi
done < "$WORK/recorded.tsv"

# --- 3. what is running now -----------------------------------------------------------------
: > "$WORK/current.tsv"
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
    printf '%s\t%s\t%s\n' "$service" "$image" "$path" >> "$WORK/current.tsv"
  done < <(compose_images "$path")
done

if [ -z "$FOUND_COMPOSE" ]; then
  echo "rollback: there is no compose file at any of these paths, so there is nothing to write the previous digests into. Nothing has been changed." >&2
  echo "rollback: name the installation's own compose file(s) in UPDATE_COMPOSE_FILES, relative to DB_COMPOSE_DIR ($COMPOSE_DIR), or as absolute paths — the same ones $OPS_DIR/update.sh was given." >&2
  exit "$EX_REFUSED"
fi

# Matched by compose SERVICE NAME: that is the key update.sh wrote the record with, reading
# this very file. A recorded service that is no longer here cannot be put back, and putting
# back some of them is the half-state this command must never leave behind.
: > "$WORK/plan.tsv"
GONE=""
while IFS="$TAB" read -r service image; do
  [ -n "$service" ] || continue
  found=$(awk -F'\t' -v wanted="$service" '$1 == wanted { print $3 "\t" $2; exit }' "$WORK/current.tsv")
  if [ -z "$found" ]; then
    GONE="$GONE $service"
    continue
  fi
  printf '%s\t%s\t%s\t%s\n' "$service" "${found%%$TAB*}" "${found#*$TAB}" "$image" >> "$WORK/plan.tsv"
done < "$WORK/recorded.tsv"

if [ -n "$GONE" ]; then
  echo "rollback: the record names$GONE, and no compose file on this box has that any more, so I cannot put this installation back as a whole. Nothing has been changed." >&2
  echo "rollback: putting back some of the services and not the others is the one state this command will not leave you in." >&2
  exit "$EX_REFUSED"
fi

if [ ! -s "$WORK/plan.tsv" ]; then
  no_record
fi

# --- 4. say what this puts back, and what it does not ---------------------------------------
echo "rollback: putting back what was running before release $TO_RELEASE."
echo "rollback: this would change:"
while IFS="$TAB" read -r service path current image; do
  [ -n "$service" ] || continue
  echo "  $service"
  echo "    from $current"
  echo "    to   $image"
done < "$WORK/plan.tsv"
echo "rollback: this puts the software back. It does not put the database back."
echo "rollback: every update applies the migrations, and nothing written down says whether that one changed the database — so assume it did. The software going back may not be able to read it."
echo "rollback: if it cannot, the way back is to restore the backup taken before that update: docs/runbooks/export-and-teardown.md."
if [ -n "$SNAPSHOT_ID" ]; then
  echo "rollback: that backup is snapshot $SNAPSHOT_ID."
else
  echo "rollback: no backup snapshot was written down for that update, so find the last one taken before it."
fi
echo "rollback: this goes back exactly one step. There is no second step."
echo "rollback: if any of these images is rendered into a compose file by the keeper from its own configuration, change that configuration too, or the keeper puts its configured image back the next time it reconciles."

# --- 5. a dry run stops here, having changed nothing -----------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  echo "rollback: this was a dry run. Nothing has been changed."
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  if [ -t 0 ]; then
    printf 'rollback: go ahead? Type yes to continue: '
    read -r answer || answer=""
    if [ "$answer" != "yes" ]; then
      echo "rollback: not going ahead. Nothing has been changed." >&2
      exit "$EX_REFUSED"
    fi
  else
    echo "rollback: there is nobody here to ask, so I am not going ahead. Nothing has been changed. Read the list above and run this again with --yes." >&2
    exit "$EX_REFUSED"
  fi
fi

# --- 6. the compose file(s), copied aside and rewritten --------------------------------------
# undo: restore_compose_files puts every one of them back byte for byte. Either every file
# names the previous digests or every file names the ones it had — never half of each.
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

# --- 7. pull the previous digests ------------------------------------------------------------
# They were running on this box, which does not mean they are still fetchable: a registry can
# drop a digest and `docker image prune` can drop the local copy. A pull that fails here has
# changed nothing, and nothing is recorded as put back.
echo "rollback: pulling the images that were running before."
if ! docker compose ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} pull; then
  restore_compose_files
  echo "rollback: the previous images could not be pulled, so nothing was switched and nothing has been written down as put back. The images you are on are still running." >&2
  echo "rollback: they may have been removed from the registry, or pruned from this box. The message above says which." >&2
  exit "$EX_FAILED"
fi

# --- 8. the switch ----------------------------------------------------------------------------
echo "rollback: starting them."
if ! docker compose ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} up -d; then
  echo "rollback: the previous images were pulled and could not be started. Nothing has been written down as put back." >&2
  echo "rollback: the compose file now names the previous digests, so running this command again, or 'docker compose up -d' by hand, tries exactly the same thing." >&2
  exit "$EX_FAILED"
fi

# --- 9. did they come up? ---------------------------------------------------------------------
RUNNING=$(docker compose ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} ps --services --filter status=running 2>/dev/null) || RUNNING=""
MISSING=""
while IFS="$TAB" read -r service path current image; do
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
  echo "rollback: these did not come up after the switch:$MISSING" >&2
  echo "rollback: the previous images are in place and those are not running, so this is not a rollback I can vouch for and nothing has been written down as put back. Running this again tries exactly the same thing." >&2
  echo "rollback: if the older software cannot read the database, this is what that looks like — restore the backup taken before that update (docs/runbooks/export-and-teardown.md)." >&2
  exit "$EX_FAILED"
fi

# --- 10. write down that this happened ---------------------------------------------------------
# undo: none. This is what stops a second rollback from walking further back (owner decision D3).
DETAIL=$(printf '%s' "put back the images recorded before release $TO_RELEASE; the database was not touched" | cut -c1-400)
if ! recorder finish "$UPDATE_ID" rolled-back "$DETAIL"; then
  echo "rollback: the previous images are running, and I could not write that down (record id $UPDATE_ID). Until that row says rolled-back, this command will offer to do the same thing again." >&2
  exit "$EX_FAILED"
fi

echo "rollback: the images that were running before release $TO_RELEASE are back."
echo "rollback: the database was not touched, and nothing has been restored. If this installation now behaves as though it cannot read its own data, that is a migration the older software does not know about: restore the backup taken before that update (docs/runbooks/export-and-teardown.md)."
echo "rollback: that was the one step back this command has. To move again, $OPS_DIR/update.sh with a release file."
