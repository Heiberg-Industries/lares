/**
 * services/box/tests/live/gateway-completion.live.mts — the LIVE probe for `../../lib/doctor.ts`'s
 * `testModel`/`readModelTestResult` (W8A-s7b, the plan's own follow-up to W8A-s7:
 * `.claude/plans/2026-09-20-prelaunch-wave-8.md`, "8A", slice W8A-s7).
 *
 * NOT part of `pnpm test` (this file's `.live.mts` extension is not vitest's `*.test.*` glob, the
 * same convention every other file under a `tests/live/` directory in this repository already
 * uses). NOT run by whoever built W8A-s7, and not runnable from this worktree — it needs a real,
 * reachable gateway, which nothing in this repository's CI or dev environment has. Run it BY HAND
 * against a real installation's gateway, once after this file lands and again whenever LiteLLM is
 * upgraded or `doctor.ts`'s assumptions about its response shapes are next in doubt:
 *
 *     I_UNDERSTAND_THIS_SPENDS_MONEY=1 \
 *     GATEWAY_URL=https://gateway.example \
 *     GATEWAY_KEY_FILE=/run/secrets/gateway-key \
 *     PROBE_MODEL=lares-brain \
 *       npx tsx services/box/tests/live/gateway-completion.live.mts
 *
 * WHY THIS FILE EXISTS. Per the root CLAUDE.md's fixture rule ("a fixture is what we believe an
 * API does; only a live call is what it does"), `readModelTestResult` in `../../lib/doctor.ts`
 * branches on FOUR assumed response shapes, none of them measured against a real gateway when
 * W8A-s7 was written:
 *   1. a 200 whose body is `{ content: [{ type: ..., ... }, ...] }` (the documented Anthropic
 *      Messages shape the router route, `/v1/messages`, is supposed to answer with);
 *   2. a wrong key answers 401 or 403 (assumed from ordinary REST convention — LiteLLM's own
 *      shape for THIS specific case was never read from source, unlike the budget-refusal case
 *      below);
 *   3. an unknown model alias answers a bare 404, or a 4xx body whose `error.message` mentions
 *      both "model" and "not found"/"unknown" (LiteLLM's measured 400-budget-refusal shape,
 *      generalised on no direct evidence to the alias case);
 *   4. a budget refusal (`error.type === "budget_exceeded"`, on HTTP 400 or 429) — this ONE shape
 *      already has its own dedicated live probe,
 *      `packages/agent-kit/tests/live/litellm-budget-refusal.live.mts`, which mints a throwaway
 *      capped key and drives it to refusal for real. This file does not repeat that call (it
 *      would mint and spend down a second throwaway key for a fact the other probe already
 *      settles) — it reads that probe's own "LAST RUN" note instead. If that file has never been
 *      run either, run it first; `doctor.ts`'s `over-budget` verdict rests on its result.
 *
 * This file settles the other three: shape 1 by making one real, tiny, BILLED completion; shape 2
 * by sending the request again with a deliberately wrong key (never a real value that ever
 * worked — fabricated once, in this file, for this purpose); shape 3 by sending it again with a
 * deliberately unknown alias. Each answer is fed through the REAL `readModelTestResult` this
 * slice shipped, and the run asserts the verdict is the one `doctor.ts` promises.
 *
 * WHAT THIS PRINTS, for each of the three calls: the HTTP status and the KEY NAMES present in the
 * response envelope (`Object.keys(body)`, and `Object.keys(body.error)` when there is one) —
 * NEVER the values, NEVER the message text, NEVER the completion's own content. A gateway that
 * answers the "good" call is by definition returning real model output; this script never prints
 * it, on the same principle `litellm-key-info.live.mts` and `litellm-budget-refusal.live.mts`
 * already follow for a key's own numbers.
 *
 * NEVER PRINTS THE KEY, THE COMPLETION'S CONTENT, OR A CREDENTIAL IN THE URL. Every value this
 * script prints is either a fixed label, an HTTP status code, or an envelope's field NAMES
 * (`Object.keys(...)`) — never a field's VALUE, so there is no string anywhere in this file's
 * output that could carry the real key, the fabricated wrong key, or the model's own words, even
 * by accident. `GATEWAY_URL` itself is printed once, with any `user:pass@` userinfo stripped
 * first — a gateway address is not a secret, but nothing here assumes one was never pasted in
 * with embedded credentials by mistake.
 *
 * RE-RUN **2026-09-21** after the gateway was upgraded to LiteLLM **v1.101.0**: all three
 * shapes are UNCHANGED — 200 with content; 401 for a wrong key; 403 `key_model_access_denied`
 * for an unknown alias. `doctor.ts`'s regression tests still describe the live gateway, and the
 * two-minor-version upgrade broke nothing this engine depends on. Re-run it after every such
 * upgrade: that is exactly what this check is for.
 *
 * LAST RUN: **2026-09-21**, against a real LiteLLM **v1.99.1**, alias `heiberg-brain` (which that
 * gateway resolves through `router_settings.model_group_alias` to an Anthropic model), with a
 * throwaway virtual key restricted to that one alias.
 *
 *   Call 1, good request  → HTTP **200**, envelope keys
 *     `model,id,type,role,content,container,stop_reason,stop_sequence,stop_details,usage`.
 *     Verdict "ok". ASSUMPTION 1 (and 4) CONFIRMED — and with it the premise the whole gateway
 *     design rests on: a request in ANTHROPIC format to `/v1/messages` really does resolve a
 *     LiteLLM alias and come back with a completion.
 *   Call 2, wrong key     → HTTP **401**, envelope `{error:{message,type,param,code}}`.
 *     Verdict "unauthorised". ASSUMPTION CONFIRMED.
 *   Call 3, unknown alias → HTTP **403**, `error.type = "key_model_access_denied"`,
 *     `error.code = "403"`, `error.param = "model"`. **ASSUMPTION REFUTED.** The code assumed a
 *     404 (or a message naming "model" + "not found"), and read this 403 as a WRONG KEY — so a
 *     mistyped `LARES_MODEL_ALIAS` at install time would have told the owner to replace a key
 *     that was never the problem. `lib/doctor.ts` was fixed the same day: the model check now
 *     runs BEFORE the status-only auth check, and `tests/doctor-model.test.ts` carries that
 *     envelope as a regression case. First run: 2 of 3 passed and the failure was a real defect,
 *     which is the entire reason this file exists.
 *
 * NOT YET MEASURED, and worth the next person's attention: the gateway used here issues keys with
 * a model allow-list, so call 3 measured "this key may not use that alias". An alias that is not
 * REGISTERED AT ALL, asked for with an unrestricted key, may answer differently (a 400 or 404).
 * Both mean the same thing to an owner, and `readModelTestResult` treats them alike on purpose.
 *
 * Re-run this whenever LiteLLM is upgraded, or when doctor.ts's assumptions are next in doubt.
 */
import { readFileSync } from "node:fs";
import { readModelTestResult, testModel, type ModelTestVerdict } from "../../lib/doctor.js";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// ── guard: the "good" call below is real and billed ─────────────────────────────────────────
if (process.env["I_UNDERSTAND_THIS_SPENDS_MONEY"] !== "1") {
  fail(
    "refusing to run: this probe makes one real, tiny, BILLED completion against the gateway " +
      "(plus two calls expected to be refused before any model runs). Set " +
      "I_UNDERSTAND_THIS_SPENDS_MONEY=1 to proceed.",
  );
}

const rawGatewayUrl = process.env["GATEWAY_URL"];
const keyFile = process.env["GATEWAY_KEY_FILE"];
const probeModel = process.env["PROBE_MODEL"];
if (!rawGatewayUrl) fail("GATEWAY_URL is not set. This probe needs a real, reachable gateway URL.");
if (!keyFile) fail("GATEWAY_KEY_FILE is not set. This probe reads the key from a file, exactly like the doctor does.");
if (!probeModel) fail("PROBE_MODEL is not set. Pass a real, working alias explicitly — this probe will not guess one.");
const gatewayUrl = rawGatewayUrl.replace(/\/+$/, "");

let realKey: string;
try {
  realKey = readFileSync(keyFile, "utf8").trim();
} catch (err) {
  fail(`could not read GATEWAY_KEY_FILE at "${keyFile}": ${(err as Error).message}`);
}
if (realKey.length === 0) fail(`the key file at "${keyFile}" is empty.`);

// A key that was never real to begin with — fabricated here, once, for the "wrong key" case.
// Never a value that ever authenticated against anything.
const WRONG_KEY = "sk-lares-doctor-probe-wrong-key-never-real";
// An alias no installation would ever register for real.
const UNKNOWN_ALIAS = "lares-doctor-probe-unknown-alias-never-registered";

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "«unparseable URL»";
  }
}

function envelopeKeys(body: unknown): { top: string[]; error: string[] | null } {
  if (typeof body !== "object" || body === null) return { top: [], error: null };
  const top = Object.keys(body as Record<string, unknown>);
  const err = (body as Record<string, unknown>)["error"];
  const error = typeof err === "object" && err !== null ? Object.keys(err as Record<string, unknown>) : null;
  return { top, error };
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

let failed = false;
function report(ok: boolean, label: string): void {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  if (!ok) failed = true;
}

/** One `/v1/messages` call, through a plain fetch — never through `testModel` itself, so the
 *  status/body this script prints and the ones fed to `readModelTestResult`/`testModel` below
 *  are provably the same real response, not two different code paths that happen to agree. */
async function rawCall(key: string, model: string): Promise<{ status: number; body: unknown; bodyText: string }> {
  const res = await fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Accept-Encoding": "identity",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    }),
  });
  const body = await parseJson(res);
  return { status: res.status, body, bodyText: JSON.stringify(body) };
}

console.log(`Gateway: ${redactUrl(gatewayUrl)}`);
console.log(`Model alias under test: ${probeModel}\n`);

// ── call 1: the good request — real key, real alias, one real billed completion ─────────────
console.log("=== Call 1: a good request (real key, real alias) ===");
const good = await rawCall(realKey, probeModel);
const goodKeys = envelopeKeys(good.body);
console.log(`  status=${good.status}`);
console.log(`  envelope keys: ${JSON.stringify(goodKeys.top)}`);
if (goodKeys.error) console.log(`  error keys: ${JSON.stringify(goodKeys.error)}`);
const goodVerdict = readModelTestResult(good.status, good.bodyText);
report(goodVerdict.verdict === "ok", `readModelTestResult reads the real answer as "ok" (got "${goodVerdict.verdict}")`);
// Also drive the actual testModel() this probe exists to check, not just the pure classifier.
const goodViaTestModel = await testModel({ gatewayUrl, key: realKey, alias: probeModel });
report(
  goodViaTestModel.verdict === "ok",
  `testModel() itself reads the real answer as "ok" (got "${goodViaTestModel.verdict}")`,
);

// ── call 2: a wrong key ──────────────────────────────────────────────────────────────────────
console.log("\n=== Call 2: a wrong key (real alias) ===");
const wrongKey = await rawCall(WRONG_KEY, probeModel);
const wrongKeyKeys = envelopeKeys(wrongKey.body);
console.log(`  status=${wrongKey.status}`);
console.log(`  envelope keys: ${JSON.stringify(wrongKeyKeys.top)}`);
if (wrongKeyKeys.error) console.log(`  error keys: ${JSON.stringify(wrongKeyKeys.error)}`);
const wrongKeyVerdict: { verdict: ModelTestVerdict } = readModelTestResult(wrongKey.status, wrongKey.bodyText);
report(
  wrongKeyVerdict.verdict === "unauthorised",
  `readModelTestResult reads a wrong key as "unauthorised" (got "${wrongKeyVerdict.verdict}", HTTP ${wrongKey.status})`,
);

// ── call 3: an unknown model alias (real key) ───────────────────────────────────────────────
console.log("\n=== Call 3: an unknown model alias (real key) ===");
const unknownAlias = await rawCall(realKey, UNKNOWN_ALIAS);
const unknownAliasKeys = envelopeKeys(unknownAlias.body);
console.log(`  status=${unknownAlias.status}`);
console.log(`  envelope keys: ${JSON.stringify(unknownAliasKeys.top)}`);
if (unknownAliasKeys.error) console.log(`  error keys: ${JSON.stringify(unknownAliasKeys.error)}`);
const unknownAliasVerdict = readModelTestResult(unknownAlias.status, unknownAlias.bodyText);
report(
  unknownAliasVerdict.verdict === "no-such-model",
  `readModelTestResult reads an unknown alias as "no-such-model" (got "${unknownAliasVerdict.verdict}", HTTP ${unknownAlias.status})`,
);

console.log(`\nBudget-refusal shape (this file's 4th assumed shape) is NOT re-checked here — see`);
console.log(`packages/agent-kit/tests/live/litellm-budget-refusal.live.mts's own "LAST RUN" note.`);

console.log(`\n=== ${failed ? "FAIL" : "PASS"} ===`);
process.exit(failed ? 1 : 0);
