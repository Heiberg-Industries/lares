/**
 * tests/live/litellm-key-info.live.mts — the LIVE probe for `../../src/gateway-key-info.ts`
 * (LAR-20-s1).
 *
 * NOT part of `pnpm test`, and deliberately so: it calls the real gateway with a real agent
 * key, including a call that spends nothing (`GET /key/info`) and one deliberately expected to
 * be REFUSED (`POST /key/generate`, to prove a non-admin key can't mint new ones). Run it by
 * hand, once per agent key, and whenever `gateway-key-info.ts`'s parsing changes what it
 * assumes the response looks like:
 *
 *     GATEWAY_URL=https://gateway.example GATEWAY_KEY_FILE=/run/secrets/gateway-key \
 *       npx tsx packages/agent-kit/tests/live/litellm-key-info.live.mts
 *
 * WHY THIS FILE EXISTS. `gateway-key-info.ts`'s whole header is a belief, not a documented
 * contract: LiteLLM's proxy docs (checked 2026-09-18, docs.litellm.ai/docs/proxy/virtual_keys)
 * show `GET /key/info` ONLY in the master-key form, `?key=<some key an admin manages>`, and
 * that one worked example does not even show `max_budget`/`budget_duration`/`budget_reset_at`/
 * `key_alias` inside `/key/info` itself (those four appear on the equivalent key-object schema
 * documented for `/user/info` and `/key/generate` instead). Nothing in the docs says what the
 * SAME endpoint, called with NO `key` parameter and an ordinary (non-admin, budget-capped)
 * virtual key as the bearer token, answers. The shipped client believes it answers 200 with the
 * calling key's own `spend`/`max_budget`/`budget_duration`/`budget_reset_at`/`key_alias`, under
 * the documented `{ info: {...} }` envelope. Per the root CLAUDE.md's fixture rule ("a fixture
 * is what we believe an API does; only a live call is what it does"), this file is what
 * actually asks.
 *
 * WHAT THIS CHECKS, per the LAR-20-s1 slice spec, in order:
 *   1. GET /key/info with NO query parameter — the self-read form the client believes in.
 *      Records the status and which of the five fields the client needs are present.
 *   2. If step 1's status was not 200, retries the SAME endpoint with the documented
 *      `?key=<the same key>` form and records the same things. (If step 1 already worked,
 *      step 2 does not run — there is nothing left to settle.)
 *   3. POST /key/generate, which MUST answer 401 or 403 — proof that this ordinary key cannot
 *      mint new keys of its own. A 200 here would be a real security surprise, not a shape
 *      question, so it counts toward this script's exit code.
 *   4. GET /spend/logs?limit=1 and GET /user/daily/activity — recorded WITHOUT asserting
 *      anything, since the slice spec does not depend on either. This is deliberate: LiteLLM's
 *      docs describe `/spend/keys` and `/spend/users` as scoped to the caller's own data for a
 *      non-admin key by default (docs.litellm.ai/docs/proxy/cost_tracking) but make no such
 *      statement for `/spend/logs` or `/user/daily/activity` specifically, and two open
 *      (unverified, non-doc) GitHub issues report inconsistent 403s on both for non-"Default"
 *      key roles — so this step is pure observation for whoever designs a later slice that
 *      might want them, never a check this probe can honestly assert on.
 *
 * Exit code is 0 only when step 1 or step 2 produced every field `readOwnKeyInfo` needs (a
 * numeric `spend`) AND step 3 refused as expected. A network failure anywhere required is
 * reported and counts as a failure — never a faked pass.
 *
 * NEVER PRINTS THE KEY. `redact()` below masks the loaded key wherever it appears in a string,
 * masks any `sk-...`-shaped token, and masks the value of any field whose NAME conventionally
 * carries a secret (`key`, `token`, `api_key`, …) — so even a gateway response this file's
 * author didn't anticipate (e.g. an endpoint that echoes a key back verbatim) cannot leak it
 * through this script's own logging.
 *
 * LAST RUN: **2026-09-21**, LiteLLM **v1.101.0**, against an ordinary virtual key.
 * **FAILED, and the failure is the answer.** Steps 1 and 2 both returned **403**:
 * `"Virtual key is not allowed to call this route. Only allowed to call routes:
 * ['llm_api_routes']. Tried to call route: /key/info"`. So on this gateway an ordinary virtual
 * key cannot read its own spend AT ALL — not in the no-parameter form, not in the documented
 * `?key=` form. `gateway-key-info.ts`'s central belief is therefore FALSE here, and a Costs
 * page built on "each agent key reads its own spend" cannot work as designed (LAR-20). The two
 * ways out: widen `allowed_routes` on agent keys to include `/key/info`, or have the console
 * read spend server-side with the master key it already holds for the gateway surface. That is
 * an owner decision, not a builder's.
 * Step 3 PASSED (POST /key/generate -> 403): an ordinary key cannot mint keys. Note it passed
 * for a broader reason than intended — this key cannot reach any admin route at all.
 * Step 4, informational: /spend/logs and /user/daily/activity both 403, same restriction.
 */
import { readFileSync } from "node:fs";
import { readOwnKeyInfo, type GatewayKeyInfo } from "../../src/gateway-key-info.js";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const rawGatewayUrl = process.env["GATEWAY_URL"];
const keyFile = process.env["GATEWAY_KEY_FILE"];
if (!rawGatewayUrl) fail("GATEWAY_URL is not set. This probe needs a real gateway URL and a real agent key.");
if (!keyFile) fail("GATEWAY_KEY_FILE is not set. This probe needs a real gateway URL and a real agent key.");
const gatewayUrl = rawGatewayUrl.replace(/\/+$/, "");

let key: string;
try {
  key = readFileSync(keyFile, "utf8").trim();
} catch (err) {
  fail(`could not read GATEWAY_KEY_FILE (${keyFile}): ${(err as Error).message}`);
}
if (key.length === 0) fail(`the key file at GATEWAY_KEY_FILE (${keyFile}) is empty.`);

// ── redaction — never printed, never logged, never thrown ──────────────────────────────────

const TOKEN_LIKE = /sk-[A-Za-z0-9_-]{6,}/g;
const SECRET_FIELD_NAMES = new Set(["key", "token", "api_key", "apikey", "authorization", "master_key", "secret"]);

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.split(key).join("«redacted-key»").replace(TOKEN_LIKE, "«redacted-token»");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELD_NAMES.has(k.toLowerCase()) ? "«redacted»" : redact(v);
    }
    return out;
  }
  return value;
}

let failed = false;
function report(ok: boolean, label: string): void {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  if (!ok) failed = true;
}
function info(label: string): void {
  console.log(`  [info] ${label}`);
}

/** Prints only field NAMES, value TYPES and the (redacted) values of the five fields
 *  `GatewayKeyInfo` needs — never the raw body, which could carry the key under a field this
 *  file doesn't anticipate. */
function describeCandidateInfo(body: unknown): void {
  if (typeof body !== "object" || body === null) {
    info("response body is not a JSON object — nothing to describe");
    return;
  }
  const info_ = (body as Record<string, unknown>)["info"];
  if (typeof info_ !== "object" || info_ === null) {
    info('response has no "info" object — the documented envelope was not present');
    return;
  }
  const rec = info_ as Record<string, unknown>;
  for (const field of ["spend", "max_budget", "budget_duration", "budget_reset_at", "key_alias"]) {
    const present = field in rec;
    const v = rec[field];
    console.log(`  [info] ${field}: present=${present} type=${typeof v} value=${JSON.stringify(redact(v))}`);
  }
}

/** Runs a raw GET against the gateway with this agent's own key, for diagnostics only — the
 *  shipped client (`readOwnKeyInfo`) is exercised separately, below, so a parsing regression in
 *  it is caught even if this raw path still "looks fine". */
async function rawGet(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${gatewayUrl}${path}`, {
    headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

let gotNumericSpend = false;

// ── Step 1: GET /key/info, no query parameter — the self-read form the client believes in ──
console.log("=== Step 1: GET /key/info (no query parameter) ===");
let step1Status: number | undefined;
try {
  const { status, body } = await rawGet("/key/info");
  step1Status = status;
  console.log(`  status=${status}`);
  console.log(`  redacted body: ${JSON.stringify(redact(body)).slice(0, 800)}`);
  describeCandidateInfo(body);
} catch (err) {
  report(false, `network error on GET /key/info (no parameter): ${(err as Error).message}`);
}

// Exercise the SHIPPED client too, over the real gateway — this is what actually decides the
// exit code, since it is the exact parsing LAR-20-s1 ships.
const clientResultStep1: GatewayKeyInfo | null = await readOwnKeyInfo({ gatewayUrl, key, fetch: globalThis.fetch });
info(`readOwnKeyInfo(...) over the no-parameter form: ${clientResultStep1 === null ? "null (unavailable)" : `spend=${clientResultStep1.spend}`}`);
if (clientResultStep1 !== null) gotNumericSpend = true;

// ── Step 2: only if step 1 did not answer 200 — the documented ?key=<same key> fallback ────
if (step1Status !== 200) {
  console.log("\n=== Step 2: GET /key/info?key=<own key> (step 1 was not 200) ===");
  try {
    const { status, body } = await rawGet(`/key/info?key=${encodeURIComponent(key)}`);
    console.log(`  status=${status}`);
    console.log(`  redacted body: ${JSON.stringify(redact(body)).slice(0, 800)}`);
    describeCandidateInfo(body);
    if (
      status === 200 &&
      typeof body === "object" &&
      body !== null &&
      typeof (body as Record<string, unknown>)["info"] === "object"
    ) {
      const rec = (body as Record<string, unknown>)["info"] as Record<string, unknown>;
      if (typeof rec["spend"] === "number" && Number.isFinite(rec["spend"])) gotNumericSpend = true;
    }
  } catch (err) {
    report(false, `network error on GET /key/info?key=...: ${(err as Error).message}`);
  }
} else {
  console.log("\n=== Step 2 skipped — step 1 already answered 200 ===");
}

report(gotNumericSpend, "step 1 or step 2 produced a numeric spend — the field readOwnKeyInfo needs");

// ── Step 3: POST /key/generate MUST be refused ──────────────────────────────────────────────
console.log("\n=== Step 3: POST /key/generate (must be refused — this is not an admin key) ===");
try {
  const res = await fetch(`${gatewayUrl}/key/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", "Accept-Encoding": "identity" },
    // If the gateway ever DID allow this, the key it minted must be harmless: it expires in a
    // minute, cannot spend, and carries a name that says what it is.
    body: JSON.stringify({ duration: "1m", max_budget: 0.0000001, key_alias: "lares-probe-must-not-exist" }),
  });
  console.log(`  status=${res.status}`);
  if (res.ok) {
    console.log(
      "  [WARNING] the gateway MINTED a key for a non-admin caller. It expires in one minute and cannot spend, " +
      'but delete the key named "lares-probe-must-not-exist" on the gateway and find out why this was allowed.',
    );
  }
  report(res.status === 401 || res.status === 403, `POST /key/generate answers 401 or 403 (got ${res.status})`);
} catch (err) {
  report(false, `network error on POST /key/generate: ${(err as Error).message}`);
}

// ── Step 4: recorded, never asserted ────────────────────────────────────────────────────────
console.log("\n=== Step 4: GET /spend/logs?limit=1 and GET /user/daily/activity (informational only) ===");
for (const path of ["/spend/logs?limit=1", "/user/daily/activity"]) {
  try {
    const { status } = await rawGet(path);
    info(`GET ${path} -> status=${status}`);
  } catch (err) {
    info(`GET ${path} -> network error: ${(err as Error).message}`);
  }
}

console.log(`\n=== ${failed ? "FAIL" : "PASS"} ===`);
process.exit(failed ? 1 : 0);
