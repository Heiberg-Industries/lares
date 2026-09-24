#!/usr/bin/env bash
# THE INDEPENDENT BYTE-IDENTICAL PROBE (review follow-up on Task 7, ORB-278 step 2).
#
# Task 7's own gate — "Calliope's resolved tool list is IDENTICAL before and after" — is measured
# with `readResolvedTools({ dynamic })`, and `dynamic` can only be fed by `grantedToolNames(...)`,
# the SAME pure function the production resolver (`agent/tools/catalogue.ts`) and the registry
# (`agent/instrumentation.ts`) both call. That proves internal consistency, not ground truth: a
# logic error inside `grantedToolNames` would be invisible to a gate built out of the same
# function. THIS SCRIPT DOES NOT CALL `grantedToolNames`, DOES NOT IMPORT `@lares/agent-kit`, and
# DOES NOT READ ANY COMPILED MANIFEST. It drives a real session through eve's own runtime and
# reads back which tools the REAL harness actually dispatched calls to or blocked on.
#
# THE TECHNIQUE, AND WHY IT ISN'T A WIRE CAPTURE. The first attempt here was a fake LiteLLM
# gateway server, redirected to via `GATEWAY_URL`/`GATEWAY_KEY_FILE`
# (`@lares/agent-kit/gateway-provider`'s own override contract). It does not work for Calliope:
# her `agent/agent.ts` resolves the model at `session.started` and MUST return a serializable
# STRING there (eve 0.32 refuses a constructed provider object at session/turn scope — Task 1's
# Q5a). eve's runtime treats ANY string-valued dynamic model selection as a reference into its OWN
# built-in AI Gateway (`internal/gateway.js`: `GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh"`,
# hard-coded, no env override for the base URL — only `AI_GATEWAY_API_KEY`/`VERCEL_OIDC_TOKEN` for
# auth) — NEVER through the agent's own custom-constructed `fallback` provider, which anchors
# build-time metadata only. So the compiled fallback's `GATEWAY_URL` override is silently unused
# at runtime for this agent, and the real gateway call cannot be locally redirected without either
# genuine Vercel AI Gateway credentials (not available here, and not appropriate to fabricate for
# a probe) or privileged network interception (binding :443, spoofing DNS, accepting a self-signed
# cert) — out of proportion for a test script and not attempted.
#
# The technique that DOES work: `eve` itself substitutes ANY real model call — the dynamic
# session-scoped selection included — with an in-process `MockLanguageModelV3` when
# `EVE_MOCK_AUTHORED_MODELS=1` (`runtime/agent/mock-model-adapter.js`,
# `shouldMockAuthoredRuntimeModels`). This is checked BEFORE the string falls through to the real
# gateway (`runtime/agent/resolve-model.js`: `resolveMockAuthoredRuntimeModel` runs ahead of the
# `e.id` branch), so it never touches a network at all. The mock's `doGenerate` reads the REAL
# tools array eve built for that call (`getAvailableTools`) and, given a prompt of the form
# `call tools in parallel: <name>, <name>, ...`, calls EVERY named tool in ONE turn — but ONLY if
# ALL of them resolve against the real tool list (`createParallelAuthoredToolCallsResult`: a single
# missing name makes the WHOLE construct return null, all-or-nothing, by eve's own code, not ours).
# So: feed it every name from the baseline; if MORE THAN ONE distinct tool call is dispatched
# (impossible for the single-tool fallback path, which can only ever pick one), the all-or-nothing
# precondition MUST have passed — proof, from eve's own harness, that every named tool was really
# there. A generic, un-dispatched "Bootstrap reply" means at least one name was missing.
#
# What gets dispatched for real: creative's gated tools (atlas capability, autonomy "gated") ask
# for approval — a card, never executed. `ask_question` blocks on a question — never executed.
# Framework tools with no external dependency (set_language, todo) succeed silently against the
# disposable database below. Atlas's own read/write tools and `studio_ideate` DO run their real
# `execute()`, but fail harmlessly in this sandbox — `atlas_read/search/list` on
# `ATLAS_PATH is unset`, `studio_ideate` on `an unidentified principal is not an allowed approver`
# — proving they were found and wired without their failure modes doing anything to real infra.
# `load_skill` runs and fails with "No skill named ..." (creative's `skills: []`), which equally
# proves it was found. NOTHING here calls a real external API, sends a real message, or writes
# through a real board approval (the disposable database has no `approval_events` table either —
# a harmless warning, not a blocker: board-approval fails CLOSED to a card on an unreadable table).
#
# THE INFRASTRUCTURE COST, AND WHY IT IS UNAVOIDABLE FOR THIS AGENT. Calliope's
# `experimental.workflow.world` is hard-compiled to `@workflow/world-postgres` (agent/agent.ts —
# not overridable by env, and editing it is out of scope: this task must not disturb
# `services/creative`). A durable session cannot start at all without a reachable Postgres
# carrying that package's schema, so this script raises one disposable container for the
# duration of the probe and tears it down unconditionally in a `trap`. `sql/001-eve-workflow.sql`
# is Calliope's own hand-extracted schema (her header: "the box has no auto-migrate ... this file
# is the hand-extracted equivalent") — applied here exactly as documented, into a throwaway
# database nobody else touches. Nothing about this reaches a shared or production database:
# `docker run --rm`, ephemeral port, gone at exit.
#
# GENERALITY, HONESTLY STATED. This relies on `createParallelAuthoredToolCallsResult`'s
# all-or-nothing behaviour to make "more than one tool dispatched" mean "every named tool is
# present." That reasoning holds for ANY eve agent, not just Calliope — Tasks 8/9 can point this
# at their own service dir and expected-tools file unchanged. What is creative-specific is nothing
# structural; it is only that her `experimental.workflow.world` happens to be postgres, so THIS
# run pays the container cost. An agent on the default local-disk world (no override) needs no
# Postgres at all — this script still starts one unconditionally for simplicity today; a caller on
# the default world can skip straight to setting `EVE_MOCK_AUTHORED_MODELS=1` and invoking. Said
# here rather than built, per the instruction not to over-generalise a script only one task uses so far.
#
# Usage: `bash scripts/model-visible-tools-probe.sh [service-dir] [expected-tools-file]`
#   service-dir           default: services/creative
#   expected-tools-file   default: the Task 7 baseline (.superpowers/sdd/.../baseline/creative-tools.txt)
# Also runs a negative control (two names known to be ABSENT — capabilities creative never grants)
# to prove the technique is discriminating, not just optimistic.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(pwd)"
cd - >/dev/null

log() { echo "[model-tools-probe] $*" >&2; }
fail() { echo "[model-tools-probe] FAIL: $*" >&2; exit 1; }

SERVICE_DIR="${1:-$SCRIPT_DIR/../../../services/creative}"
EXPECTED_FILE="${2:-$SCRIPT_DIR/../../../.superpowers/sdd/2026-09-16-lares-agent-definitions-step-2/baseline/creative-tools.txt}"
NEGATIVE_NAMES="${3:-gmail_send,vault_file}"   # capabilities this agent's grants never reach
SERVICE_DIR="$(cd "$SERVICE_DIR" && pwd)" || fail "service dir not found: $1"
[ -f "$EXPECTED_FILE" ] || fail "expected-tools file not found: $EXPECTED_FILE"

EXPECTED_NAMES="$(grep -v '^\s*$' "$EXPECTED_FILE" | tr '\n' ',' | sed 's/,$//')"
EXPECTED_COUNT="$(grep -c . "$EXPECTED_FILE" 2>/dev/null || true)"
log "service: $SERVICE_DIR"
log "expected ($EXPECTED_COUNT names): $EXPECTED_NAMES"

WORK="$(mktemp -d)"
CONTAINER_ID=""
cleanup() {
  if [ -n "$CONTAINER_ID" ]; then
    log "tearing down the disposable postgres container ($CONTAINER_ID)"
    docker rm -f "$CONTAINER_ID" >/dev/null 2>&1
  fi
  if [ "${MTP_KEEP_WORK:-}" = "1" ]; then
    log "MTP_KEEP_WORK=1 — leaving $WORK for inspection"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# --- disposable postgres, schema applied from the service's own hand-extracted file ----------
[ -f "$SERVICE_DIR/sql/001-eve-workflow.sql" ] || fail "no sql/001-eve-workflow.sql under $SERVICE_DIR — is this an eve app with a postgres workflow world?"
log "starting a disposable postgres:16 (docker run --rm, ephemeral port)"
CONTAINER_ID=$(docker run --rm -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=probe -p 127.0.0.1::5432 postgres:16)
PGPORT=$(docker inspect "$CONTAINER_ID" --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}')
log "postgres on 127.0.0.1:$PGPORT (container $CONTAINER_ID)"

for _ in $(seq 1 30); do
  PGPASSWORD=postgres psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d probe -c 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
PGPASSWORD=postgres psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d probe -c 'select 1' >/dev/null 2>&1 \
  || fail "postgres never became reachable on 127.0.0.1:$PGPORT"

log "applying $SERVICE_DIR/sql/001-eve-workflow.sql (this agent's own hand-extracted schema) into the disposable database"
PGPASSWORD=postgres psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d probe -v ON_ERROR_STOP=1 -f "$SERVICE_DIR/sql/001-eve-workflow.sql" >/dev/null \
  || fail "schema apply failed"

WORKFLOW_URL="postgres://postgres:postgres@127.0.0.1:$PGPORT/probe"

# invoke_probe PROMPT OUT_JSON OUT_ERR
# eve's own startup (e.g. a Graphile Worker pool-size warning) can print multi-line console
# output to STDOUT ahead of the one final `JSON.stringify(result)` line the CLI itself writes
# (`cli/invoke/command.js`: `logger.log(JSON.stringify(l, null, 2))`), so OUT_JSON is cleaned to
# just that trailing pretty-printed object (from the LAST line that is exactly `{` to EOF) before
# anything tries to `jq` it. The raw, uncleaned capture is kept alongside as `.raw` for debugging.
#
# THE EXIT CODE IS SAVED, NOT DISCARDED (review follow-up, folded in while generalising this
# script for Task 8/travel). The script does not `set -e`, and until now nothing downstream ever
# looked at whether `eve invoke` itself succeeded — a crash isolated to the NEGATIVE leg alone
# (a bad flag, a dead postgres connection, `eve invoke` segfaulting before it dispatches anything)
# would leave `$out_err`/`$out_json` empty, `distinct_dispatch_count` would read that as
# `NEG_DISPATCH=0` — the exact value a CORRECT negative result also produces — and the whole
# script would report PASS having proved nothing about the negative leg at all. Saved to
# `$out_json.exit` (a sidecar file, not a global) so both legs can be checked independently and a
# failure in one cannot be shadowed by the other running afterward.
invoke_probe() {
  local prompt="$1" out_json="$2" out_err="$3" raw="$2.raw" rc
  (
    cd "$SERVICE_DIR"
    export EVE_MOCK_AUTHORED_MODELS=1
    export WORKFLOW_POSTGRES_URL="$WORKFLOW_URL"
    export DATABASE_URL="$WORKFLOW_URL"
    node_modules/.bin/eve invoke "$prompt" > "$raw" 2>"$out_err"
  )
  rc=$?
  echo "$rc" > "$out_json.exit"
  local start_line
  start_line=$(grep -n '^{$' "$raw" | tail -1 | cut -d: -f1)
  if [ -n "$start_line" ]; then
    tail -n "+$start_line" "$raw" > "$out_json"
  else
    cp "$raw" "$out_json"
  fi
}

# distinct_dispatch_count OUT_JSON OUT_ERR NAMES_CSV
# Counts DISTINCT tool names, from NAMES_CSV, with real dispatch evidence in this invoke: either a
# `toolName: '<name>'` line in stderr (the tool ran, successfully or not) or a pending
# input-request (approval card / question) — each pending request is one blocked dispatch the
# single-tool fallback path could never produce more than one of.
distinct_dispatch_count() {
  local out_json="$1" out_err="$2" names_csv="$3"
  local stderr_hits pending
  stderr_hits=$(echo "$names_csv" | tr ',' '\n' | while read -r n; do
    [ -n "$n" ] && grep -q "toolName: '$n'" "$out_err" 2>/dev/null && echo "$n"
  done | sort -u | grep -c . || true)
  pending=$(jq '.requests | length // 0' "$out_json" 2>/dev/null || echo 0)
  echo $((stderr_hits + pending))
}

# --- POSITIVE: every expected name, in one batch ------------------------------------------------
log "positive case: 'call tools in parallel: $EXPECTED_NAMES'"
invoke_probe "call tools in parallel: $EXPECTED_NAMES" "$WORK/pos.json" "$WORK/pos.err"
POS_DISPATCH=$(distinct_dispatch_count "$WORK/pos.json" "$WORK/pos.err" "$EXPECTED_NAMES")
log "positive case: $POS_DISPATCH distinct tool(s) dispatched (>1 is only possible if eve's own all-or-nothing batch matcher accepted every one of the $EXPECTED_COUNT names)"

# --- NEGATIVE control: names this agent never grants --------------------------------------------
log "negative case: 'call tools in parallel: $NEGATIVE_NAMES' (expected to be absent)"
invoke_probe "call tools in parallel: $NEGATIVE_NAMES" "$WORK/neg.json" "$WORK/neg.err"
# THE FIX: a `NEG_DISPATCH=0` on its own is ambiguous — it is what a CORRECT negative result
# looks like, and it is ALSO what a crashed `eve invoke` looks like (empty stdout, empty stderr,
# nothing for `distinct_dispatch_count` to find). Checking the saved exit code and requiring a
# real, message-shaped reply is what tells the two apart, so this leg cannot pass by accident.
NEG_RC=$(cat "$WORK/neg.json.exit" 2>/dev/null || echo "")
[ "$NEG_RC" = "0" ] || fail "the negative leg's \`eve invoke\` exited ${NEG_RC:-<unknown>} (not 0) — a crash here must not be read as \"nothing dispatched\"; see $WORK/neg.err"
NEG_DISPATCH=$(distinct_dispatch_count "$WORK/neg.json" "$WORK/neg.err" "$NEGATIVE_NAMES")
NEG_MESSAGE=$(jq -r '.outcome.message // .message // ""' "$WORK/neg.json" 2>/dev/null)
log "negative case: $NEG_DISPATCH distinct tool(s) dispatched; reply: $NEG_MESSAGE"
case "$NEG_MESSAGE" in
  *"$NEGATIVE_NAMES"*) : ;;
  *) fail "the negative leg's reply doesn't look like the expected generic un-dispatched fallback (got: \"$NEG_MESSAGE\") — an empty or unrelated message is indistinguishable from a silent crash, which is exactly what NEG_DISPATCH=0 alone cannot rule out; see $WORK/neg.json / neg.err" ;;
esac

echo "" >&2
if [ "$POS_DISPATCH" -gt 1 ] && [ "$NEG_DISPATCH" -eq 0 ]; then
  log "PASS — the model-visible tool set matches the baseline (all $EXPECTED_COUNT names dispatched as a batch), and the negative control ($NEGATIVE_NAMES) correctly dispatched nothing"
  log "this is independent of grantedToolNames: it observes eve's own runtime tool resolution and its own all-or-nothing mock-model matcher, neither of which this script calls into"
  exit 0
fi
{
  [ "$POS_DISPATCH" -le 1 ] && echo "the positive case dispatched at most one tool — eve's all-or-nothing batch matcher REJECTED the full expected list, meaning at least one of [$EXPECTED_NAMES] is missing from the model-visible tool set. See $WORK/pos.json / pos.err."
  [ "$NEG_DISPATCH" -gt 0 ] && echo "the negative case dispatched $NEG_DISPATCH tool(s) — at least one of [$NEGATIVE_NAMES] is unexpectedly present. See $WORK/neg.json / neg.err."
} | while read -r line; do log "$line"; done
fail "the independent probe disagrees with the baseline — see the lines above"
