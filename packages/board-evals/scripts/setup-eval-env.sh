#!/usr/bin/env bash
# The five control files packages/board-evals's evals and probes read from `process.env`
# (lib/file-board.ts, lib/seam-grants.ts). There has never been a committed setup script for
# them (Task 7's brief names this as a known gap) — this is it.
#
# Usage: `source scripts/setup-eval-env.sh` from `packages/board-evals`. Sourcing (not executing)
# is required: the exports must land in the CALLING shell, since every later step — `pnpm run
# eval`, `eve invoke`, `eve start` — reads these as inherited environment, not as arguments.
#
# Starting state matches evals/board.eval.ts's own expectation: an empty grants list and an empty
# level table, so a freshly-sourced environment does not itself change what any committed eval
# observes. A caller who wants a gated board or a granted catalogue tool overwrites the files
# afterwards — see scripts/restart-probe.sh for a worked example.
set -euo pipefail

export EVE_TELEMETRY_DISABLED=1

export SEAM_GRANTS="$(mktemp)"
export BOARD_LEVELS="$(mktemp)"
export BOARD_SKEW="$(mktemp)"
export BOARD_LOG="$(mktemp)"
export BOARD_EVENTS="$(mktemp)"

echo '[]' > "$SEAM_GRANTS"
echo '{}' > "$BOARD_LEVELS"
echo 0 > "$BOARD_SKEW"
: > "$BOARD_LOG"
: > "$BOARD_EVENTS"
: > "$BOARD_EVENTS.resumed"

echo "board-evals env ready:" >&2
echo "  SEAM_GRANTS=$SEAM_GRANTS" >&2
echo "  BOARD_LEVELS=$BOARD_LEVELS" >&2
echo "  BOARD_SKEW=$BOARD_SKEW" >&2
echo "  BOARD_LOG=$BOARD_LOG" >&2
echo "  BOARD_EVENTS=$BOARD_EVENTS" >&2
