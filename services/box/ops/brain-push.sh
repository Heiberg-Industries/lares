#!/usr/bin/env bash
# brain-push.sh — commit local Brain edits and push to the box.
# Run on the Mac from anywhere; BRAIN defaults to ~/Developer/brain.
set -euo pipefail
BRAIN="${BRAIN:-$HOME/Developer/brain}"
cd "$BRAIN"
if [ -z "$(git status --porcelain)" ]; then
  echo "brain-push: nothing to commit."
else
  git add -A   # -A stages new notes too; the guard above uses porcelain so untracked files count
  git commit -m "${1:-chore(brain): manual edit}"
fi
git pull --rebase --autostash origin main   # take the box's latest (e.g. nightly notes) first
git push origin main
