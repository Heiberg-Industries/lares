#!/usr/bin/env bash
# note-lock.sh — run a command holding an advisory lock on ONE Brain note.
# Usage: note-lock.sh <note-path-relative-to-/srv/brain> -- <command...>
# Example: note-lock.sh wiki/person/jane-doe.md -- bash -c 'echo "..." >> /srv/brain/wiki/person/jane-doe.md'
# The lock is a sidecar file under /srv/brain/.locks/ keyed by the note path; flock
# serialises only writers to the SAME note. Lock auto-releases when <command> exits.
set -euo pipefail

WORK=/srv/brain
LOCKDIR="$WORK/.locks"

NOTE="${1:?usage: note-lock.sh <note-path> -- <command...>}"
shift
[ "${1:-}" = "--" ] && shift || { echo "note-lock.sh: expected -- before the command" >&2; exit 2; }

# A safe, collision-free lock filename: replace path separators so it's one flat file.
LOCKFILE="$LOCKDIR/$(printf '%s' "$NOTE" | tr '/' '_').lock"
mkdir -p "$LOCKDIR"

# -w 30: wait up to 30s for the lock, then fail rather than hang a writer forever.
exec 9>"$LOCKFILE"
if ! flock -w 30 9; then
  echo "note-lock.sh: timed out waiting for lock on $NOTE" >&2
  exit 1
fi
"$@"
