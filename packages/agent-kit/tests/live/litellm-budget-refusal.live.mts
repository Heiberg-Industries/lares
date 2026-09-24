/**
 * tests/live/litellm-budget-refusal.live.mts — the LIVE probe for `../../src/gateway-budget.ts`
 * (LAR-… "budget refusal recognised by type, on HTTP 400 and 429").
 *
 * NOT part of `pnpm test`, and NOT run by whoever/whatever built this slice — it needs a real
 * gateway and a real admin (master) key, neither of which are reachable from here. Run it by
 * hand, against a real installation's gateway, whenever LiteLLM is upgraded or its budget-
 * refusal shape is next in doubt:
 *
 *     I_UNDERSTAND_THIS_SPENDS_MONEY=1 \
 *     GATEWAY_URL=https://gateway.example \
 *     LITELLM_MASTER_KEY=sk-... \
 *     PROBE_MODEL=lares-brain \
 *       npx tsx packages/agent-kit/tests/live/litellm-budget-refusal.live.mts
 *
 * WHY THIS FILE EXISTS. Per the root CLAUDE.md's fixture rule ("a fixture is what we believe
 * an API does; only a live call is what it does"), `src/gateway-budget.ts`'s whole header is a
 * belief about two DIFFERENT measurements that were never the same live gateway: 400 was
 * measured against a real gateway on 2026-09-01 (`docs/runbooks/per-user-spend-caps.md`); 429
 * was read out of LiteLLM's own source on 2026-09-18 (`litellm/exceptions.py`,
 * `litellm/proxy/auth/auth_exception_handler.py`) — a real gateway has not yet been asked
 * directly whether it answers 400 or 429 since that source was read. This file is what
 * actually asks, the next time someone can run it.
 *
 * WHAT THIS DOES, in order:
 *   1. Mints a throwaway virtual key via `POST /key/generate` with a one-cent `max_budget`
 *      (`0.01`), a short duration, and a `key_alias` that says what it is, scoped to
 *      `PROBE_MODEL` only.
 *   2. Makes small calls through `POST /v1/messages` (the router route every agent actually
 *      uses — never the retired `/anthropic/v1` pass-through, ORB-225) with that key, using
 *      `PROBE_MODEL` and a tiny `max_tokens`, until one is refused or an attempt cap is hit.
 *   3. Prints the refusal's HTTP status and the JSON `error.type` / `error.code` / first 80
 *      characters of `error.message` — never the full body, and never the key.
 *   4. Feeds the REAL refusal (status + body, shaped the way the AI SDK would receive it)
 *      through this module's own `isBudgetExceeded` and asserts it recognises it. This is the
 *      one assertion this script lives for: everything above exists to produce a real refusal
 *      to hand it.
 *   5. Deletes the throwaway key via `POST /key/delete`, in a `finally` — runs even if step 4
 *      failed or an exception was thrown, so a failed run never leaves a spending key behind.
 *
 * NEVER PRINTS THE MASTER KEY OR THE MINTED KEY. `redact()` masks both wherever they appear in
 * a string, masks any `sk-...`-shaped token, and masks the value of any field whose NAME
 * conventionally carries a secret — the same approach `litellm-key-info.live.mts` uses.
 *
 * LAST RUN: **2026-09-21**, LiteLLM **v1.101.0**, alias `heiberg-brain` -> `claude-opus-5`,
 * throwaway key minted at `max_budget: 0.001`. **PASS.**
 *   - **THE ANSWER: 429, not 400.** Refused on call 6, with
 *     `error.type: "budget_exceeded"`, `error.code: "429"`, message beginning
 *     `"Budget has been exceeded! Key=..."`. The 400 recorded on 2026-09-01 in
 *     `docs/runbooks/per-user-spend-caps.md` no longer describes this gateway; the 429 read out
 *     of LiteLLM's own source on 2026-09-18 does.
 *   - **NOTHING BROKE, and the reason is worth keeping.** `isBudgetExceeded()` recognised it,
 *     and `services/box/lib/doctor.ts` reads it correctly too, because BOTH match on
 *     `error.type` and treat the status as a plausibility check only. Had either matched on the
 *     status code, a spending cap biting in production would have surfaced as an unrecognised
 *     error instead of the fixed one-sentence answer. The measured envelope is now pinned in
 *     `services/box/tests/doctor-model.test.ts`, together with a test asserting 400 and 429 read
 *     alike — so a future reader-by-status fails loudly.
 *   - **THE BITE POINT HAD TO BE LOWERED to make this probe work at all.** At the original
 *     `max_budget: 0.01`, twenty calls of this size against Opus 5 spend about $0.006 — under
 *     the cap — so the probe would have hit its attempt cap and reported "never refused"
 *     without testing anything. At $0.001 the cap bit on call 6. Raise `PROBE_MAX_BUDGET` if a
 *     gateway ignores budgets this small.
 *   - OBSERVED, not acted on: the refusal message embeds the key alias and a truncated key
 *     (`sk-...`). Anything that logs a gateway error verbatim will put key fragments in its
 *     logs.
 */
import { isBudgetExceeded } from "../../src/gateway-budget.js";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// ── guard: this probe spends real money ─────────────────────────────────────────────────────
if (process.env["I_UNDERSTAND_THIS_SPENDS_MONEY"] !== "1") {
  fail(
    "refusing to run: this probe mints a real (throwaway) virtual key, makes real model calls " +
      "against it until it is refused, and only then deletes it. Set " +
      "I_UNDERSTAND_THIS_SPENDS_MONEY=1 to proceed.",
  );
}

const rawGatewayUrl = process.env["GATEWAY_URL"];
const masterKey = process.env["LITELLM_MASTER_KEY"];
const probeModel = process.env["PROBE_MODEL"];
if (!rawGatewayUrl) fail("GATEWAY_URL is not set. This probe needs a real gateway URL.");
if (!masterKey) fail("LITELLM_MASTER_KEY is not set. This probe needs a real admin key to mint and delete a throwaway key.");
if (!probeModel) fail("PROBE_MODEL is not set. Pass the cheapest configured alias explicitly — this probe will not guess one.");
const gatewayUrl = rawGatewayUrl.replace(/\/+$/, "");

// ── redaction — never printed, never logged, never thrown ──────────────────────────────────

const TOKEN_LIKE = /sk-[A-Za-z0-9_-]{6,}/g;
const SECRET_FIELD_NAMES = new Set(["key", "token", "api_key", "apikey", "authorization", "master_key", "secret"]);

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const s of secrets) if (s.length > 0) out = out.split(s).join("«redacted-key»");
    return out.replace(TOKEN_LIKE, "«redacted-token»");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELD_NAMES.has(k.toLowerCase()) ? "«redacted»" : redact(v, secrets);
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

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── step 1: mint a throwaway, tiny-budget key scoped to PROBE_MODEL ────────────────────
// The BITE POINT. A budget only refuses once spend EXCEEDS it, so it has to be small enough
// that MAX_ATTEMPTS tiny calls get there. ARITHMETIC, 2026-09-21 (not yet measured): 20 calls of
// ~15 input + 8 output tokens against claude-opus-5 ($5/$25 per MTok) spend roughly $0.006 —
// UNDER the $0.01 this probe used to mint, so it would have hit the attempt cap and reported
// "never refused" without ever testing the thing it exists to test. A tenth of a cent is
// exceeded within two or three calls on any model here, and costs less. Override with
// PROBE_MAX_BUDGET if a gateway ignores budgets this small.
const MAX_BUDGET = Number(process.env["PROBE_MAX_BUDGET"] ?? 0.001);
if (!Number.isFinite(MAX_BUDGET) || MAX_BUDGET <= 0) {
  fail(`PROBE_MAX_BUDGET must be a positive number — got ${JSON.stringify(process.env["PROBE_MAX_BUDGET"])}.`);
}
console.log(`=== Step 1: POST /key/generate (throwaway key, max_budget: ${MAX_BUDGET}) ===`);
const keyAlias = `lares-probe-budget-refusal-${Date.now()}`;
let mintedKey: string | undefined;
try {
  const res = await fetch(`${gatewayUrl}/key/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${masterKey}`, "content-type": "application/json", "Accept-Encoding": "identity" },
    body: JSON.stringify({
      duration: "10m",
      max_budget: MAX_BUDGET,
      models: [probeModel],
      key_alias: keyAlias,
      metadata: { purpose: "lares-live-probe: gateway-budget refusal shape" },
    }),
  });
  const body = await parseJson(res);
  console.log(`  status=${res.status}`);
  if (!res.ok || typeof body !== "object" || body === null) {
    fail(`/key/generate did not return a usable key: status=${res.status} body=${JSON.stringify(redact(body, []))}`);
  }
  const key = (body as Record<string, unknown>)["key"];
  if (typeof key !== "string" || key.length === 0) {
    fail(`/key/generate response had no usable "key" field: ${JSON.stringify(redact(body, []))}`);
  }
  mintedKey = key;
  report(true, `minted a throwaway key (alias ${keyAlias}, max_budget ${MAX_BUDGET}, model ${probeModel})`);
} catch (err) {
  fail(`network error on POST /key/generate: ${(err as Error).message}`);
}

const secrets = [masterKey, mintedKey ?? ""];

try {
  // ── step 2: call /v1/messages with the throwaway key until refused ───────────────────────
  console.log("\n=== Step 2: POST /v1/messages with the throwaway key, until refused ===");
  const MAX_ATTEMPTS = 20;
  let refusalStatus: number | undefined;
  let refusalBody: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const res = await fetch(`${gatewayUrl}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mintedKey}`,
        "content-type": "application/json",
        "Accept-Encoding": "identity",
      },
      body: JSON.stringify({
        model: probeModel,
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const body = await parseJson(res);
    if (res.ok) {
      info(`call ${attempt} -> HTTP ${res.status} (not yet refused)`);
      continue;
    }
    console.log(`  call ${attempt} -> HTTP ${res.status}`);
    refusalStatus = res.status;
    refusalBody = body;
    break;
  }

  if (refusalStatus === undefined) {
    fail(`the key was never refused within ${MAX_ATTEMPTS} calls — raise max_budget's bite point or this cap, and re-run.`);
  }

  // ── step 3: print what was measured, never the full body ─────────────────────────────────
  console.log("\n=== Step 3: what the gateway actually said ===");
  const errorField =
    typeof refusalBody === "object" && refusalBody !== null
      ? (refusalBody as Record<string, unknown>)["error"]
      : undefined;
  const errorType =
    typeof errorField === "object" && errorField !== null ? (errorField as Record<string, unknown>)["type"] : undefined;
  const errorCode =
    typeof errorField === "object" && errorField !== null ? (errorField as Record<string, unknown>)["code"] : undefined;
  const errorMessage =
    typeof errorField === "object" && errorField !== null ? (errorField as Record<string, unknown>)["message"] : undefined;
  console.log(`  HTTP status: ${refusalStatus}`);
  console.log(`  error.type: ${JSON.stringify(errorType)}`);
  console.log(`  error.code: ${JSON.stringify(errorCode)}`);
  console.log(
    `  error.message (first 80 chars): ${JSON.stringify(typeof errorMessage === "string" ? errorMessage.slice(0, 80) : errorMessage)}`,
  );

  // ── step 4: the one assertion this script exists for ─────────────────────────────────────
  console.log("\n=== Step 4: does this module recognise the REAL refusal? ===");
  // Shaped the way the AI SDK's AI_APICallError carries a gateway refusal — statusCode plus
  // the parsed body on `data` — since that is the vantage point every door actually sees.
  const asAiSdkError = {
    name: "AI_APICallError",
    message: typeof errorMessage === "string" ? errorMessage : "",
    statusCode: refusalStatus,
    responseBody: JSON.stringify(refusalBody),
    data: refusalBody,
  };
  const recognised = isBudgetExceeded(asAiSdkError);
  report(recognised, `isBudgetExceeded() recognises the real HTTP ${refusalStatus} refusal as a budget refusal`);
} finally {
  // ── step 5: delete the throwaway key, unconditionally ─────────────────────────────────────
  console.log("\n=== Step 5: POST /key/delete (throwaway key cleanup) ===");
  if (mintedKey !== undefined) {
    try {
      const res = await fetch(`${gatewayUrl}/key/delete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${masterKey}`, "content-type": "application/json", "Accept-Encoding": "identity" },
        body: JSON.stringify({ keys: [mintedKey] }),
      });
      report(res.ok, `deleted the throwaway key (alias ${keyAlias}), status=${res.status}`);
      if (!res.ok) {
        const body = await parseJson(res);
        console.log(`  [WARNING] delete did not report success: ${JSON.stringify(redact(body, secrets))}`);
        console.log(`  [WARNING] delete this key by hand: alias "${keyAlias}" (max_budget ${MAX_BUDGET}, already spent).`);
      }
    } catch (err) {
      failed = true;
      console.log(`  [FAIL] network error on POST /key/delete: ${(err as Error).message}`);
      console.log(`  [WARNING] delete this key by hand: alias "${keyAlias}" (max_budget ${MAX_BUDGET}, already spent).`);
    }
  }
}

console.log(`\n=== ${failed ? "FAIL" : "PASS"} ===`);
process.exit(failed ? 1 : 0);
