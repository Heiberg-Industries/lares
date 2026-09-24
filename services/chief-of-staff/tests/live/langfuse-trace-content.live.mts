/**
 * tests/live/langfuse-trace-content.live.mts — the LIVE round trip behind W2-s9's `tracePolicy`
 * (LAR-69), a real Langfuse ingest-then-read, never a fixture.
 *
 * NOT part of `pnpm test`, and deliberately so: it sends one real trace to whatever Langfuse
 * project `LANGFUSE_HOST` names and reads it back over Langfuse's own public API. Run it by
 * hand, once per Langfuse project, and whenever `agent/instrumentation.ts`'s `tracePolicy` or
 * the wire shape `@lares/agent-kit/langfuse-otel` builds changes what it assumes Langfuse's
 * OTLP-ingestion or trace-read endpoints accept.
 *
 *     LANGFUSE_HOST=https://cloud.langfuse.com \
 *     LANGFUSE_PUBLIC_KEY=pk-lf-... \
 *     LANGFUSE_SECRET_KEY=sk-lf-... \
 *       npx tsx services/chief-of-staff/tests/live/langfuse-trace-content.live.mts
 *
 * All three are required, read from the environment only. This file never reads
 * `LANGFUSE_KEY_FILE` or any secret file: it is meant to be run by hand from a workstation,
 * against whichever Langfuse project the caller names, not against the box's own mounted
 * secret. The author of this file has no Langfuse credentials and did not look for any — it is
 * WRITTEN, never RUN, by the builder; the owner supplies real values and runs it.
 *
 * WHY THIS FILE EXISTS, AND WHAT IT ADDS OVER THE W2-s1 CAPTURE HARNESS.
 * `packages/board-evals/scripts/capture-snapshot.sh` already proves, on this branch, that each
 * role's `agent/instrumentation.ts` exports OTLP traces carrying `gen_ai.tool.definitions` and
 * `gen_ai.system_instructions` off the model-call span — but it points `LANGFUSE_HOST` at a
 * throwaway local sink that just appends bytes to a file. It proves "eve sends a well-formed
 * OTLP payload to whatever host we configure"; it says nothing about whether a real Langfuse
 * project accepts that payload, keeps it, and answers a query for it by id — and it never
 * exercises `tracePolicy` at all, since the mock-model harness never reaches audience-gated
 * content decisions. Per the root CLAUDE.md's fixture rule ("a fixture is what we believe an
 * API does; only a live call is what it does"), THIS file is what actually asks the
 * destination Langfuse itself:
 *
 *   1. POST a hand-built OTLP/HTTP trace — one span, one marker attribute this script invents
 *      itself, nothing read from a database, a conversation, or the codebase — to
 *      `${LANGFUSE_HOST}/api/public/otel/v1/traces`. The request body and headers mirror
 *      exactly what `@lares/agent-kit/langfuse-otel`'s `langfuseExporterConfig()` builds for
 *      the real exporter (same path, same HTTP Basic auth shape: public key as username,
 *      secret key as password, plus the `x-langfuse-ingestion-version: 4` header the v4
 *      migration requires) and what the installed `@opentelemetry/exporter-trace-otlp-http`
 *      (0.222.0) actually sends on the wire for this repo — confirmed by reading its source: it
 *      defaults to `Content-Type: application/json` via `JsonTraceSerializer`, not protobuf, so
 *      a hand-built JSON body is not a stand-in for the real wire format, it IS the real wire
 *      format. Every field name below (`resourceSpans`/`scopeSpans`/`spans`, hex trace/span
 *      ids, string nanosecond timestamps, `{key, value: {stringValue}}` attributes) was
 *      checked against `@opentelemetry/otlp-transformer`'s own JSON encoder and span
 *      transform, not guessed.
 *   2. Poll `GET ${LANGFUSE_HOST}/api/public/traces/{traceId}` (Langfuse's public trace-read
 *      API, same Basic auth) until the trace appears or a bounded number of attempts is spent.
 *      Langfuse's own ingestion is asynchronous, so an immediate 404 is not by itself a
 *      failure — only running out of attempts is.
 *
 * NEVER PRINTS TRACE CONTENT. The only content this script ever sends is a marker string it
 * generates itself (a random label, never anything from a real conversation) — that IS what
 * "content" means here, and the point of the probe is to confirm it survives the round trip,
 * not to keep it secret. What this script never prints is the read-back HTTP response BODY
 * (which could echo back unrelated project data if pointed at a non-empty project by mistake),
 * the Authorization header, or either key. Only statuses, the trace/span ids this script
 * itself generated, and a boolean "marker round-tripped" are logged.
 *
 * Exit code is 0 only when the POST was accepted AND the read-back found the marker attribute
 * on the trace this script sent. A network failure anywhere required is reported and counts as
 * a failure — never a faked pass.
 */
import { randomBytes } from "node:crypto";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const rawHost = process.env["LANGFUSE_HOST"];
const publicKey = process.env["LANGFUSE_PUBLIC_KEY"];
const secretKey = process.env["LANGFUSE_SECRET_KEY"];
if (!rawHost) fail("LANGFUSE_HOST is not set. This probe needs the installation's own Langfuse host, public key and secret key.");
if (!publicKey) fail("LANGFUSE_PUBLIC_KEY is not set. This probe needs the installation's own Langfuse host, public key and secret key.");
if (!secretKey) fail("LANGFUSE_SECRET_KEY is not set. This probe needs the installation's own Langfuse host, public key and secret key.");
const host = rawHost.replace(/\/+$/u, "");

// Same header shape @lares/agent-kit/langfuse-otel's langfuseExporterConfig() builds for the
// real exporter — see that file's own comment on the ingestion-version header.
const authHeaders: Record<string, string> = {
  Authorization: "Basic " + Buffer.from(`${publicKey}:${secretKey}`).toString("base64"),
  "x-langfuse-ingestion-version": "4",
};

let failed = false;
function report(ok: boolean, label: string): void {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  if (!ok) failed = true;
}
function info(label: string): void {
  console.log(`  [info] ${label}`);
}

// ── build one OTLP/HTTP JSON trace, entirely synthetic ─────────────────────────────────────

const traceId = randomBytes(16).toString("hex"); // 32 hex chars, per the OTLP spec
const spanId = randomBytes(8).toString("hex"); // 16 hex chars
const marker = `lares-w2-s9-live-probe-${randomBytes(6).toString("hex")}`;
const startMs = Date.now();
const endMs = startMs + 5;

const otlpBody = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "lares-w2-s9-live-probe" } }],
      },
      scopeSpans: [
        {
          scope: { name: "lares-live-probe" },
          spans: [
            {
              traceId,
              spanId,
              name: "w2-s9-instrumentation-live-probe",
              kind: 1, // SPAN_KIND_INTERNAL — API's INTERNAL (0) offset by 1 per the OTLP transform
              startTimeUnixNano: String(BigInt(startMs) * 1_000_000n),
              endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
              attributes: [
                { key: "lares.probe", value: { stringValue: "w2-s9-instrumentation-live-probe" } },
                { key: "lares.probe.marker", value: { stringValue: marker } },
              ],
              status: { code: 1 }, // STATUS_CODE_OK
            },
          ],
        },
      ],
    },
  ],
};

// ── Step 1: POST the trace to Langfuse's OTLP ingestion endpoint ───────────────────────────
console.log("=== Step 1: POST one clearly-labelled test trace to Langfuse's OTLP endpoint ===");
console.log(`  host=${host} traceId=${traceId} spanId=${spanId}`);
try {
  const res = await fetch(`${host}/api/public/otel/v1/traces`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify(otlpBody),
  });
  // Never read or print the response body here — Langfuse's OTLP endpoint has no reason to
  // echo project data back on ingest, but nothing this script does depends on it either way.
  console.log(`  status=${res.status}`);
  report(res.ok, `POST /api/public/otel/v1/traces accepted the trace (status ${res.status})`);
} catch (err) {
  report(false, `network error POSTing the trace: ${(err as Error).message}`);
}

// ── Step 2: read the trace back — ingestion is async, so poll with a bounded budget ────────
console.log("\n=== Step 2: GET the trace back from Langfuse's public trace-read API ===");
const ATTEMPTS = 6;
const DELAY_MS = 3000;
let found = false;
let lastStatus: number | undefined;

for (let attempt = 1; attempt <= ATTEMPTS && !found; attempt++) {
  if (attempt > 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  try {
    const res = await fetch(`${host}/api/public/traces/${traceId}`, { headers: authHeaders });
    lastStatus = res.status;
    if (res.status === 200) {
      // The read-back body could in principle carry OTHER traces' data if this script were
      // ever pointed at the wrong project by mistake — so it is never logged. Only a
      // substring check for THIS script's own marker, and only a boolean is printed.
      const text = await res.text();
      found = text.includes(marker) && text.includes(traceId);
      info(`attempt ${attempt}/${ATTEMPTS}: status=${res.status} marker present=${found}`);
    } else {
      info(`attempt ${attempt}/${ATTEMPTS}: status=${res.status} (not yet available or not found)`);
    }
  } catch (err) {
    info(`attempt ${attempt}/${ATTEMPTS}: network error: ${(err as Error).message}`);
  }
}

report(
  found,
  found
    ? `trace ${traceId} was read back with its marker attribute intact (last status ${lastStatus})`
    : `trace ${traceId} was NOT read back with its marker attribute within ${ATTEMPTS} attempts (last status ${lastStatus}) — either ingestion is slower than this budget, or the trace did not really land`,
);

console.log(`\n=== ${failed ? "FAIL" : "PASS"} ===`);
process.exit(failed ? 1 : 0);
