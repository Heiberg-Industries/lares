#!/usr/bin/env bash
# prune-images.sh — remove the container images of old releases, and nothing else.
#
#   prune-images.sh --releases-dir <dir> --keep <release.json> [--keep <release.json>] [--dry-run]
#
# `lares update` runs this after a successful update, keeping the release now running and the one
# before it so a rollback stays possible. The rules, all of them checked here:
#   - Only an image that some release file in <dir>/*/release.json names is ever a candidate. An
#     image that no release names (an agent's own image, an image from something else on the
#     server) is never touched.
#   - An image either kept release names is kept.
#   - An image any container uses, running or stopped, is kept.
#   - A failed removal is reported and skipped; this script never makes an update fail (it exits 0
#     unless it was called wrongly).
# It prints how much disk space the removal gave back, measured on the disk Docker stores images on.
set -uo pipefail

releases_dir=""
keep=()
dry=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --releases-dir) releases_dir="${2:-}"; shift 2 || exit 64 ;;
    --keep) keep+=("${2:-}"); shift 2 || exit 64 ;;
    --dry-run) dry=1; shift ;;
    *) echo "prune-images: unknown option $1" >&2; exit 64 ;;
  esac
done
[ -d "$releases_dir" ] && [ "${#keep[@]}" -gt 0 ] || { echo "prune-images: --releases-dir and at least one --keep are required" >&2; exit 64; }

note() { printf 'prune-images: %s\n' "$1"; }

# "all" and "keep" reference lists, one image reference (name@sha256:...) per line.
refs() { # FILE...
  python3 -I - "$@" <<'PY'
import json, re, sys
for path in sys.argv[1:]:
    try:
        images = json.load(open(path)).get("images", {})
    except Exception:
        continue
    for ref in images.values():
        if isinstance(ref, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9./_:-]*@sha256:[0-9a-f]{64}", ref):
            print(ref.removeprefix("docker.io/library/").removeprefix("docker.io/"))
PY
}

all_refs=$(refs "$releases_dir"/*/release.json) || all_refs=""
# EVERY keep file must be readable and name at least one image: a keep list that is only partly
# known could let the release that was meant to stay be removed.
keep_refs=""
for file in "${keep[@]}"; do
  one=$(refs "$file") || one=""
  if [ -z "$one" ]; then
    note "the release file $file could not be read or names no image, so no image was removed"
    exit 0
  fi
  keep_refs+="$one"$'\n'
done

# Image ids that a container (running or not) is made from.
used_ids=""
container_ids=$(docker ps -a -q --no-trunc 2>/dev/null) || { note "could not list containers, so no image was removed"; exit 0; }
if [ -n "$container_ids" ]; then
  # shellcheck disable=SC2086 # container ids, one word each
  used_ids=$(docker inspect --format '{{.Image}}' $container_ids 2>/dev/null) || { note "could not read the containers, so no image was removed"; exit 0; }
fi

# Docker lists Docker Hub images without their docker.io/ prefix; release files spell it out.
listing=$(docker image ls --digests --no-trunc --format '{{.Repository}}@{{.Digest}} {{.ID}}' 2>/dev/null | sed -e 's#^docker\.io/library/##' -e 's#^docker\.io/##') || { note "could not list images, so none was removed"; exit 0; }

free_kb() {
  local root
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || root=/
  [ -d "$root" ] || root=/
  df -Pk "$root" 2>/dev/null | awk 'NR == 2 { print $4 }'
}

before=$(free_kb)
removed=0
failed=0
while read -r ref id; do
  [ -n "${ref:-}" ] && [ -n "${id:-}" ] || continue
  printf '%s\n' "$all_refs" | grep -Fxq -- "$ref" || continue   # no release names it: not ours
  printf '%s\n' "$keep_refs" | grep -Fxq -- "$ref" && continue   # a release we keep
  if printf '%s\n' "$used_ids" | grep -Fxq -- "$id"; then continue; fi
  if [ "$dry" -eq 1 ]; then note "would remove $ref"; removed=$((removed + 1)); continue; fi
  if docker rmi "$ref" >/dev/null 2>&1; then removed=$((removed + 1)); else note "could not remove $ref; it stays"; failed=$((failed + 1)); fi
done <<<"$listing"

if [ "$removed" -eq 0 ]; then
  note "no old release images to remove"
elif [ "$dry" -eq 1 ]; then
  note "$removed old release image(s) would be removed"
else
  after=$(free_kb)
  freed_mb=0
  if [[ "${before:-}" =~ ^[0-9]+$ ]] && [[ "${after:-}" =~ ^[0-9]+$ ]] && [ "$after" -gt "$before" ]; then freed_mb=$(( (after - before) / 1024 )); fi
  note "removed $removed old release image(s), freeing about ${freed_mb} MB"
fi
[ "$failed" -eq 0 ] || note "$failed image(s) could not be removed; run docker image ls to see them"
exit 0
