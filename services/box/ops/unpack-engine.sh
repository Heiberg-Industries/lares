#!/usr/bin/env bash
# unpack-engine.sh <release> <engine-image-digest>
#
# Runs INSIDE the keeper image. Copies the engine files the host-side installer and its
# sibling scripts read into $OUT_ROOT/<release>/, in the repository's own layout:
#
#   services/box/ops/*                  the installer, update, rollback, restore, units, Caddyfile
#   services/box/sql/*                  the numbered migrations
#   services/box/compose.lares-keeper.yaml
#   services/box/compose.lares-keeper-vault.yaml
#   services/box/engine-image           one line: the digest passed in
#   services/creative/sql/001-eve-workflow.sql
#
# Refuses (exit 1, nothing left behind) if any expected file is missing. Copies nothing else.
# APP_ROOT and OUT_ROOT exist so a test can point the script at a checkout and a temp dir.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/app}"
OUT_ROOT="${OUT_ROOT:-/out}"

die() { echo "unpack-engine: $*" >&2; exit 1; }

[ "$#" -eq 2 ] || die "usage: unpack-engine.sh <release> <engine-image-digest>"
release="$1"
digest="$2"
case "$release" in
  ""|.*|*[!A-Za-z0-9._-]*) die "the release name must be letters, digits, '.', '_' or '-', and not start with '.': '$release'" ;;
esac
case "$digest" in
  ""|*[!A-Za-z0-9._:@/-]*) die "that does not look like an image digest reference: '$digest'" ;;
esac

box="$APP_ROOT/services/box"

# Every file that must exist. The ops and sql directories are copied whole, but must contain
# what the installer and its sibling scripts read by name.
required=(
  "$box/ops/install.sh"
  "$box/ops/engine-run.sh"
  "$box/ops/maintenance-custody.py"
  "$box/ops/update.sh"
  "$box/ops/rollback.sh"
  "$box/ops/restore.sh"
  "$box/ops/Caddyfile"
  "$box/sql/001_baseline.sql"
  "$box/compose.lares-keeper.yaml"
  "$box/compose.lares-keeper-vault.yaml"
  "$APP_ROOT/services/creative/sql/001-eve-workflow.sql"
)
for f in "${required[@]}"; do
  [ -f "$f" ] || die "an expected engine file is missing: $f. Nothing was unpacked."
done

mkdir -p "$OUT_ROOT"
stage="$(mktemp -d "$OUT_ROOT/.unpack.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

copy_dir_files() { # <source dir> <dest dir>: regular files directly inside, modes preserved
  local src="$1" dst="$2" f
  mkdir -p "$dst"
  for f in "$src"/*; do
    [ -f "$f" ] && cp -p "$f" "$dst/"
  done
  return 0
}

copy_dir_files "$box/ops" "$stage/services/box/ops"
copy_dir_files "$box/sql" "$stage/services/box/sql"
cp -p "$box/compose.lares-keeper.yaml" "$stage/services/box/"
cp -p "$box/compose.lares-keeper-vault.yaml" "$stage/services/box/"
mkdir -p "$stage/services/creative/sql"
cp -p "$APP_ROOT/services/creative/sql/001-eve-workflow.sql" "$stage/services/creative/sql/"
printf '%s\n' "$digest" > "$stage/services/box/engine-image"
chmod 0644 "$stage/services/box/engine-image"
find "$stage" -type d -exec chmod 0755 {} +

rm -rf "${OUT_ROOT:?}/$release"
mv "$stage" "$OUT_ROOT/$release"
trap - EXIT
echo "unpack-engine: unpacked $release to $OUT_ROOT/$release"
