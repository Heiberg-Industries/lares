#!/usr/bin/env bash
# Captures the ADR-0015 rule 11 pair for every role: the assembled instructions and the tool
# list the REAL harness exposes. Run once before an eve bump and once after; the gate test
# compares them. Regenerating these files is a deliberate act that a reviewer must see.
#
# WHY THIS IS NOT `model-visible-tools-probe.sh`. That script is a VERIFIER, not an enumerator:
# it takes a list of names you already believe in and makes eve's own all-or-nothing mock-model
# matcher confirm every one of them is present (its own header, :1-11). It prints log lines to
# stderr and an exit code; it can never print a tool list, and it cannot discover a name nobody
# guessed. A before/after snapshot has to LIST what the model was handed, so this script reads
# that list out of eve's own runtime instead — see "the technique" below.
#
# THE TECHNIQUE, AND WHY IT IS THE REAL HARNESS.
#   1. Each role service already ships `agent/instrumentation.ts`, which — when a Langfuse key
#      file is readable — starts an OpenTelemetry NodeSDK exporting over OTLP/HTTP to
#      `$LANGFUSE_HOST/api/public/otel/v1/traces`, with `recordInputs: true`
#      (@lares/agent-kit/langfuse-otel resolves both from the environment). Pointing
#      LANGFUSE_HOST at a throwaway local sink is that file's own documented override path; no
#      engine code is modified and nothing leaves the machine.
#   2. eve's model-call span carries the attribute `gen_ai.tool.definitions` — the JSON tool
#      definitions eve actually handed the model for that call. Framework tools, authored tools,
#      extension contributions and everything the per-session dynamic resolver emitted are all in
#      there, already merged, already de-duplicated by eve. Nothing here recomputes them, and this
#      script never imports `grantedToolNames`, `@lares/agent-kit` or any compiled manifest.
#   3. The session is driven by `eve invoke` under `EVE_MOCK_AUTHORED_MODELS=1`, which makes eve
#      substitute an in-process mock for the real model (runtime/agent/mock-model-adapter.js) — so
#      the run never touches a network or a gateway. The prompt is the literal word `hello`, which
#      matches no tool name, so the mock dispatches NOTHING: the span is emitted, no `execute()`
#      runs, no external API is called and no message is sent.
#   4. All three roles compile `experimental.workflow.world` to `@workflow/world-postgres`, so a
#      durable session cannot start without a Postgres carrying that schema. Each role therefore
#      gets one disposable `docker run --rm` container, seeded from that service's own
#      hand-extracted `sql/001-eve-workflow.sql`, torn down unconditionally in a trap. Nothing
#      reaches a shared or production database.
#
# DETERMINISM. Only tool NAMES are written out — no timestamps, no session or trace ids, no
# absolute paths, no ordering from the wire: the names are sorted with `LC_ALL=C sort -u`. The
# instructions side is a byte-for-byte copy of the committed `agent/persona.md` after
# `assemble:check` proves it is current, so it is constant by construction. See
# ../snapshots/README.md, which records the exact normalisation so a later capture can apply the
# identical one.
#
# Requires: docker, psql, node. Run it as `pnpm -C packages/board-evals run snapshot:capture`.
# Set SNAPSHOT_OUT_DIR to write the six files somewhere other than the committed snapshots/
# directory (used by `snapshot:compare` to take an AFTER capture without touching the BEFORE
# files); unset, behaviour is exactly as before.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PKG="$(pwd)"
# SNAPSHOT_OUT_DIR lets an AFTER capture land somewhere other than the committed snapshots/
# directory, so re-measuring never touches the committed BEFORE files. Default is unchanged.
OUT="${SNAPSHOT_OUT_DIR:-snapshots}"
mkdir -p "$OUT"

WORK="$(mktemp -d)"
CONTAINER_ID=""
SINK_PID=""
cleanup() {
  [ -n "$CONTAINER_ID" ] && docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
  [ -n "$SINK_PID" ] && kill "$SINK_PID" >/dev/null 2>&1 || true
  if [ "${SNAPSHOT_KEEP_WORK:-}" = "1" ]; then echo "[capture] SNAPSHOT_KEEP_WORK=1 — leaving $WORK" >&2
  else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# The OTLP sink: accepts any POST, appends the body, and reports the port it was given. Written
# here rather than committed as its own file so the whole capture is one reviewable script.
cat > "$WORK/otlp-sink.mjs" <<'SINK'
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
const [out, portFile] = process.argv.slice(2);
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    appendFileSync(out, Buffer.concat(chunks).toString("utf8") + "\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
SINK

# The extractor: every `gen_ai.tool.definitions` attribute in the captured OTLP payloads, unioned,
# one name per line. Exits non-zero when no model-call span carried the attribute, so a run that
# observed nothing can never be mistaken for an agent with no tools.
cat > "$WORK/extract-tools.mjs" <<'EXTRACT'
import { readFileSync } from "node:fs";
const names = new Set();
let spans = 0;
for (const line of readFileSync(process.argv[2], "utf8").split("\n")) {
  if (line.trim().length === 0) continue;
  let doc;
  try { doc = JSON.parse(line); } catch { continue; }
  for (const rs of doc.resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? [])
      for (const sp of ss.spans ?? [])
        for (const a of sp.attributes ?? []) {
          if (a.key !== "gen_ai.tool.definitions") continue;
          spans += 1;
          for (const d of JSON.parse(a.value?.stringValue ?? "[]")) if (d?.name) names.add(d.name);
        }
}
if (spans === 0) { console.error("no span carried gen_ai.tool.definitions — nothing was observed"); process.exit(1); }
if (names.size === 0) { console.error(`${spans} span(s) carried gen_ai.tool.definitions but no tool names`); process.exit(1); }
process.stdout.write([...names].join("\n") + "\n");
EXTRACT

# The system-prompt extractor: `gen_ai.system_instructions` off the SAME model-call span — the
# whole system prompt eve really sent, which `instructions-<role>.txt` is only one ingredient of
# (eve's own preamble and skills block wrap it, and our dynamic instruction blocks are appended).
# Available because each role's `agent/instrumentation.ts` sets `recordInputs: true`.
cat > "$WORK/extract-system-prompt.mjs" <<'SYSPROMPT'
import { readFileSync } from "node:fs";
let found = null;
for (const line of readFileSync(process.argv[2], "utf8").split("\n")) {
  if (line.trim().length === 0) continue;
  let doc;
  try { doc = JSON.parse(line); } catch { continue; }
  for (const rs of doc.resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? [])
      for (const sp of ss.spans ?? []) {
        const attrs = sp.attributes ?? [];
        if (!attrs.some((a) => a.key === "gen_ai.tool.definitions")) continue; // the model call
        const raw = attrs.find((a) => a.key === "gen_ai.system_instructions")?.value?.stringValue;
        if (raw !== undefined && found === null) found = raw;
      }
}
if (found === null) { console.error("the model-call span carried no gen_ai.system_instructions"); process.exit(1); }
const blocks = JSON.parse(found).filter((b) => b?.type === "text" && typeof b.content === "string");
if (blocks.length === 0) { console.error("gen_ai.system_instructions carried no text block"); process.exit(1); }
// 0.32 sends exactly ONE text block for all three roles, so this join is a no-op today; the count
// is logged so a future release splitting the prompt into several blocks is visible in the run log
// rather than silently concatenated away.
console.error(`[capture]   system prompt: ${blocks.length} text block(s)`);
process.stdout.write(blocks.map((b) => b.content).join("\n").replace(/\n*$/u, "\n"));
SYSPROMPT

for role in chief-of-staff travel creative; do
  SVC="$PKG/../../services/$role"

  # assemble-instructions.ts --check compares and writes nothing; without --check it writes
  # agent/persona.md. We want the assembled bytes without touching the service tree, so we
  # assert the committed persona is current, then copy it.
  pnpm -C "$SVC" run assemble:check
  cp "$SVC/agent/persona.md" "$OUT/instructions-$role.txt"

  # --- the real-harness tool list ------------------------------------------------------------
  RUN="$WORK/$role"; mkdir -p "$RUN"
  CONTAINER_ID=$(docker run --rm -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=probe -p 127.0.0.1::5432 postgres:16)
  PGPORT=$(docker inspect "$CONTAINER_ID" --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}')
  for _ in $(seq 1 60); do
    PGPASSWORD=postgres psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d probe -c 'select 1' >/dev/null 2>&1 && break
    sleep 1
  done
  # The role's own hand-extracted copy where it ships one. `services/travel` ships no `sql/` at
  # all, so it borrows the chief-of-staff copy: this file is `@workflow/world-postgres`'s schema,
  # identical for every role that pins the same world package, and it is applied here only to a
  # throwaway container. If a role ever needs a different one, give it its own `sql/` directory.
  SCHEMA="$SVC/sql/001-eve-workflow.sql"
  [ -f "$SCHEMA" ] || SCHEMA="$PKG/../../services/chief-of-staff/sql/001-eve-workflow.sql"
  PGPASSWORD=postgres psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d probe -v ON_ERROR_STOP=1 \
    -f "$SCHEMA" >/dev/null

  node "$WORK/otlp-sink.mjs" "$RUN/spans.ndjson" "$RUN/port" 2>"$RUN/sink.log" &
  SINK_PID=$!
  for _ in $(seq 1 30); do [ -s "$RUN/port" ] && break; sleep 1; done
  SINK_PORT="$(cat "$RUN/port")"
  printf 'snapshot-public\nsnapshot-secret\n' > "$RUN/langfuse-keys"   # a local sink; never a real key

  (
    cd "$SVC"
    # OTEL_BSP_* force the batch span processor to export each span within ~100ms: `eve invoke`
    # exits as soon as the turn ends, and the default 5s batch delay loses the payload entirely.
    EVE_TELEMETRY_DISABLED=1 \
    EVE_MOCK_AUTHORED_MODELS=1 \
    WORKFLOW_POSTGRES_URL="postgres://postgres:postgres@127.0.0.1:$PGPORT/probe" \
    DATABASE_URL="postgres://postgres:postgres@127.0.0.1:$PGPORT/probe" \
    LANGFUSE_KEY_FILE="$RUN/langfuse-keys" \
    LANGFUSE_HOST="http://127.0.0.1:$SINK_PORT" \
    OTEL_BSP_SCHEDULE_DELAY=100 OTEL_BSP_MAX_EXPORT_BATCH_SIZE=1 OTEL_BSP_EXPORT_TIMEOUT=5000 \
    node_modules/.bin/eve invoke "hello" >"$RUN/invoke.out" 2>"$RUN/invoke.err"
  ) || { echo "[capture] eve invoke failed for $role — see $RUN/invoke.err" >&2; exit 1; }
  sleep 3

  node "$WORK/extract-tools.mjs" "$RUN/spans.ndjson" | LC_ALL=C sort -u > "$OUT/tools-$role.txt"

  # THE TWO NORMALISATIONS IN THE WHOLE CAPTURE. Both are clocks, and they are the only volatile
  # things in the 0.32 payload — everything else is written out untouched, byte for byte.
  #   (1) the clock block's instant (`buildClockMarkdown`, @lares/agent-kit). The TIMEZONE is
  #       deliberately left visible: it comes from our settings, not from eve, so a change there
  #       is a finding, not noise.
  #   (2) a line that is exactly an ISO date — today only the travel persona's "## I dag" block.
  #       Matched on the whole line rather than on the heading above it on purpose: a release that
  #       renames the heading then still gets its date normalised instead of quietly leaking one.
  node "$WORK/extract-system-prompt.mjs" "$RUN/spans.ndjson" \
    | sed -E \
      -e 's/^It is .*, [0-9]{2}:[0-9]{2} \((.*)\)\. In UTC that instant is .*\.$/It is <NORMALISED-CLOCK> (\1). In UTC that instant is <NORMALISED-CLOCK-UTC>./' \
      -e 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/<NORMALISED-DATE>/' \
    > "$OUT/system-prompt-$role.txt"

  { kill "$SINK_PID" && wait "$SINK_PID"; } >/dev/null 2>&1 || true; SINK_PID=""
  docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true; CONTAINER_ID=""

  # A snapshot that recorded nothing is worse than no snapshot: it passes forever.
  test -s "$OUT/instructions-$role.txt" || { echo "EMPTY instructions snapshot for $role" >&2; exit 1; }
  test -s "$OUT/tools-$role.txt"        || { echo "EMPTY tools snapshot for $role" >&2; exit 1; }
  test -s "$OUT/system-prompt-$role.txt" || { echo "EMPTY system-prompt snapshot for $role" >&2; exit 1; }
  echo "$role: $(wc -l < "$OUT/tools-$role.txt") tools, $(wc -c < "$OUT/instructions-$role.txt") bytes of instructions, $(wc -c < "$OUT/system-prompt-$role.txt") bytes of system prompt"
done
