#!/usr/bin/env bash
# The Docker-backed half of the ADR-0015 rule 11 gate. `snapshot-gate.test.ts` (vitest, no Docker)
# can only check that the committed BEFORE files exist, are well-formed, and that the assembled
# `agent/persona.md` still equals the committed `instructions-<role>.txt` byte for byte. It cannot
# tell you what the model was actually handed on THIS tree, because that requires a real `eve
# invoke` per role against a disposable Postgres (see `capture-snapshot.sh`'s own header for why).
#
# This script is that missing half: it takes a fresh AFTER capture into a throwaway directory
# (`capture-snapshot.sh`'s SNAPSHOT_OUT_DIR override — the committed snapshots/*.txt are never
# touched) and diffs all three kinds of file, per role, against the committed BEFORE.
#
#   - tools-<role>.txt and instructions-<role>.txt: a difference is a change in what the model may
#     DO or what we told it to be. Either one FAILS this script (non-zero exit).
#   - system-prompt-<role>.txt: NEVER fails this script. The README is explicit that this file is
#     expected to move when eve reworks its own preamble; the judgement of whether a given line is
#     harmless belongs to a person, not to a diff's exit code. Every differing line is printed, and
#     cross-checked against the committed `snapshots/system-prompt-allowlist.md` so the printout
#     says "already explained" or "UNEXPLAINED — write this up" rather than leaving a reviewer to
#     re-derive which is which.
#
# Run as `pnpm -C packages/board-evals run snapshot:compare`. Needs docker, psql, node — the same
# as snapshot:capture — and takes minutes (three real `eve invoke` runs). Not part of the default
# vitest gate for that reason; run it by hand before an eve-version bump lands.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ROLES=(chief-of-staff travel creative)
ALLOWLIST="snapshots/system-prompt-allowlist.md"

WORK="$(mktemp -d)"
cleanup() {
  if [ "${SNAPSHOT_COMPARE_KEEP:-}" = "1" ]; then
    echo "[compare] SNAPSHOT_COMPARE_KEEP=1 — leaving AFTER capture at $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

echo "[compare] capturing the AFTER state into $WORK (this runs a real eve invoke per role — minutes, not seconds)" >&2
EVE_TELEMETRY_DISABLED=1 SNAPSHOT_OUT_DIR="$WORK" bash scripts/capture-snapshot.sh

FAIL=0
for role in "${ROLES[@]}"; do
  echo "== $role =="

  if diff -u "snapshots/tools-$role.txt" "$WORK/tools-$role.txt" >"$WORK/$role.tools.diff"; then
    echo "[compare] $role: tools-$role.txt unchanged"
  else
    echo "[compare] $role: TOOL LIST DIFFERS (failing) —"
    cat "$WORK/$role.tools.diff"
    FAIL=1
  fi

  if diff -u "snapshots/instructions-$role.txt" "$WORK/instructions-$role.txt" >"$WORK/$role.instructions.diff"; then
    echo "[compare] $role: instructions-$role.txt unchanged"
  else
    echo "[compare] $role: INSTRUCTIONS DIFFER (failing) —"
    cat "$WORK/$role.instructions.diff"
    FAIL=1
  fi

  if diff -u "snapshots/system-prompt-$role.txt" "$WORK/system-prompt-$role.txt" >"$WORK/$role.system-prompt.diff"; then
    echo "[compare] $role: system-prompt-$role.txt unchanged"
  else
    echo "[compare] $role: system prompt differs (never fails this gate) —"
    cat "$WORK/$role.system-prompt.diff"
    while IFS= read -r line; do
      case "$line" in
        "+++"*|"---"*|"@@"*) continue ;;   # diff headers, not content
        "+"*|"-"*) ;;                       # an actual added/removed line
        *) continue ;;                      # unified-diff context line, not a change
      esac
      if grep -qF -- "$line" "$ALLOWLIST"; then
        echo "    already explained (see $ALLOWLIST): $line"
      else
        echo "    UNEXPLAINED — write this up before the wave proceeds: $line"
      fi
    done <"$WORK/$role.system-prompt.diff"
  fi
done

exit $FAIL
