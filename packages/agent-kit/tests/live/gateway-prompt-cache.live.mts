/**
 * packages/agent-kit/tests/live/gateway-prompt-cache.live.mts — the LIVE probe for the
 * prompt-cache boundary (`../../src/prompt-cache.ts`, applied inside `gatewayModel()`'s fetch).
 *
 * NOT part of `pnpm test` (the `.live.mts` extension is not vitest's `*.test.*` glob). NOT
 * runnable from a dev machine or CI: it needs a real, reachable gateway. Run it BY HAND against
 * an installation's gateway, after this file lands and again whenever LiteLLM, eve or
 * `@ai-sdk/anthropic` is upgraded:
 *
 *     I_UNDERSTAND_THIS_SPENDS_MONEY=1 \
 *     GATEWAY_URL=https://gateway.example \
 *     GATEWAY_KEY_FILE=/run/secrets/gateway-key \
 *     PROBE_MODEL=lares-brain \
 *       npx tsx packages/agent-kit/tests/live/gateway-prompt-cache.live.mts
 *
 * WHY THIS FILE EXISTS. The unit tests (`tests/prompt-cache.test.ts`) prove what the engine
 * SENDS: the session-stable part of the system prompt becomes its own block carrying the
 * `cache_control` breakpoint, byte-identical from turn to turn. Only a live call says what the
 * gateway DOES with it: whether LiteLLM forwards the breakpoint on `/v1/messages`, whether the
 * provider then serves the second request from the cache, and whether the cache counts come
 * back. `gateway-lane-anthropic.live.mts` measured on 2026-09-21 that a breakpoint IS forwarded
 * (a cache entry was written) but an identical follow-up wrote it AGAIN and never read it. If
 * that still holds, every cached prefix costs the write premium on every call and saves
 * nothing, and the fix belongs in the gateway's configuration, not in this engine.
 *
 * WHAT IT SENDS: three small, BILLED calls through the real `gatewayModel()`, each with a system
 * prompt shaped exactly as eve 0.60.1 builds one (every block merged into one system message,
 * eve's own cache marker on it), carrying the boundary marker between a ~8k-token stable prefix
 * and a short per-turn tail:
 *   call 1 — the prefix + tail A: expected to WRITE the prefix to the cache;
 *   call 2 — identical to call 1: expected to READ the prefix (the control: this is the case
 *            that read 0 on 2026-09-21);
 *   call 3 — the same prefix + a DIFFERENT tail B, as the next turn's clock would be: expected
 *            to READ the prefix too. Only a breakpoint that sits at the boundary, before the
 *            tail, can be read here; eve's own breakpoint at the end of the system prompt
 *            would miss.
 *
 * SIZE. A prefix below the model's minimum caches nothing and reports zero, indistinguishable
 * from a gateway that strips the breakpoint. The minimum is model-dependent (up to 4096 tokens
 * on some models), so the prefix is ~8k tokens, twice the worst case.
 *
 * WHAT IT PRINTS: token counts, the KEY NAMES of the provider usage, and the gateway's
 * deployment id header (a hash, not an address) — never the key, the gateway's upstream
 * address, or the completion text. A different deployment id on two calls means the gateway
 * load-balanced them onto different upstream deployments, which by itself explains a miss.
 *
 * LAST RUN: never. Record the date, the LiteLLM version, the alias and the numbers here.
 */
import { readFileSync } from "node:fs";
import { generateText, type SystemModelMessage } from "ai";
import { createGatewayProvider } from "../../src/gateway-provider.js";
import { PROMPT_CACHE_BOUNDARY } from "../../src/prompt-cache.js";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// ── guard: every call below is real and billed ───────────────────────────────────────────────
if (process.env["I_UNDERSTAND_THIS_SPENDS_MONEY"] !== "1") {
  fail(
    "refusing to run: this probe makes three real, BILLED calls against the gateway, each with " +
      "an ~8k-token system prompt. Set I_UNDERSTAND_THIS_SPENDS_MONEY=1 to proceed.",
  );
}

const rawGatewayUrl = process.env["GATEWAY_URL"];
const keyFile = process.env["GATEWAY_KEY_FILE"];
const probeModel = process.env["PROBE_MODEL"];
if (!rawGatewayUrl) fail("GATEWAY_URL is not set. This probe needs a real, reachable gateway URL.");
if (!keyFile) fail("GATEWAY_KEY_FILE is not set. This probe reads the key from a file, exactly like a real agent does.");
if (!probeModel) fail("PROBE_MODEL is not set. Pass a real, working alias explicitly — this probe will not guess one.");

try {
  if (readFileSync(keyFile, "utf8").trim().length === 0) fail(`the key file at "${keyFile}" is empty.`);
} catch (err) {
  fail(`could not read GATEWAY_KEY_FILE at "${keyFile}": ${(err as Error).message}`);
}

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

const { gatewayModel } = createGatewayProvider({
  defaultKeyFile: keyFile,
  defaultGatewayUrl: rawGatewayUrl,
  defaultLane: "anthropic",
});

// Deterministic filler: the same bytes on every run, so a run within five minutes of another
// may already read from the cache on call 1. Wait five minutes between runs for a clean read.
const PREFIX_PARAGRAPH =
  "This paragraph is deterministic filler standing in for an agent's persona. Its only purpose " +
  "is to make the session-stable prefix comfortably longer than any model's caching minimum. ";
const STABLE_PREFIX = PREFIX_PARAGRAPH.repeat(130).trimEnd();
const approxPrefixTokens = Math.round(STABLE_PREFIX.length / 4);

// What eve 0.60.1 puts on its merged system message for an Anthropic provider
// (`harness/prompt-cache.js`, `ANTHROPIC_CACHE_MARKER`).
const EVE_MARKER = { anthropic: { cacheControl: { type: "ephemeral" } }, bedrock: { cachePoint: { type: "default" } } };

/** The system prompt as eve merges it: session-scoped blocks, the boundary, turn-scoped blocks. */
function systemWithTail(tail: string): SystemModelMessage {
  return { role: "system", content: [STABLE_PREFIX, PROMPT_CACHE_BOUNDARY, tail].join("\n\n"), providerOptions: EVE_MARKER };
}

interface Measured {
  readonly write: number;
  readonly read: number;
  readonly input: number;
  readonly portableRead: number | undefined;
  readonly portableWrite: number | undefined;
  readonly deployment: string;
  readonly apiBase: string | undefined;
  readonly keys: string[];
}

interface AnthropicUsage {
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly input_tokens?: number;
}

/** MEASURED 2026-09-21 (see gateway-lane-anthropic.live.mts): the counts sit under
 *  `providerMetadata.anthropic.usage`, in Anthropic's own snake_case. Both spellings are read
 *  and the keys present are printed, so a rename shows up as data instead of a silent zero. */
async function call(label: string, tail: string): Promise<Measured> {
  const result = await generateText({
    model: gatewayModel(probeModel!),
    system: systemWithTail(tail),
    prompt: "Reply with the single word: ok.",
    maxOutputTokens: 16,
    maxRetries: 0,
  });
  const anthropic = (result.providerMetadata as { anthropic?: AnthropicUsage & { usage?: AnthropicUsage } } | undefined)
    ?.anthropic;
  const usage = anthropic?.usage;
  const headers = result.response.headers ?? {};
  const measured: Measured = {
    write: usage?.cache_creation_input_tokens ?? usage?.cacheCreationInputTokens ?? anthropic?.cacheCreationInputTokens ?? 0,
    read: usage?.cache_read_input_tokens ?? usage?.cacheReadInputTokens ?? anthropic?.cacheReadInputTokens ?? 0,
    input: usage?.input_tokens ?? 0,
    portableRead: result.usage.inputTokenDetails?.cacheReadTokens,
    portableWrite: result.usage.inputTokenDetails?.cacheWriteTokens,
    deployment: headers["x-litellm-model-id"] ?? "«absent»",
    apiBase: headers["x-litellm-model-api-base"],
    keys: [
      ...(anthropic ? Object.keys(anthropic).sort() : []),
      ...(usage ? Object.keys(usage).sort().map((k) => `usage.${k}`) : []),
    ],
  };
  console.log(`  ${label}: cache write=${measured.write}, cache read=${measured.read}, plain input=${measured.input}`);
  console.log(`  ${label}: portable usage cacheWrite=${measured.portableWrite ?? "«absent»"}, cacheRead=${measured.portableRead ?? "«absent»"}`);
  console.log(`  ${label}: gateway deployment id: ${measured.deployment}`);
  console.log(`  ${label}: reply has text: ${result.text.length > 0}`);
  return measured;
}

console.log(`Gateway: ${redactUrl(rawGatewayUrl)}`);
console.log(`Model alias under test: ${probeModel}`);
console.log(`Stable prefix sent: ~${approxPrefixTokens} tokens (worst-case model minimum is 4096)\n`);

console.log("=== Call 1: prefix + tail A (expected: WRITE the prefix) ===");
const first = await call("call 1", "Clock: tail A");
console.log(`  keys present under providerMetadata.anthropic: ${first.keys.join(", ") || "«none»"}`);

console.log("\n=== Call 2: identical to call 1 (expected: READ the prefix) ===");
const second = await call("call 2", "Clock: tail A");

console.log("\n=== Call 3: same prefix, different tail B (expected: READ the prefix) ===");
const third = await call("call 3", "Clock: tail B, the next turn");

const sameDeployment = first.deployment === second.deployment && second.deployment === third.deployment;
const sameApiBase = first.apiBase === second.apiBase && second.apiBase === third.apiBase;
console.log(`\n  same gateway deployment id on all three calls: ${sameDeployment}`);
console.log(`  same upstream api base on all three calls (compared, never printed): ${sameApiBase}`);

let failed = false;
function report(ok: boolean, label: string): void {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  if (!ok) failed = true;
}

console.log("\n=== Verdict ===");
report(first.write > 0 || first.read > 0, "call 1 touched the cache (a write, or a read left over from a run in the last five minutes)");
report(second.read > 0, "call 2 (identical) was served from the cache through the gateway");
report(third.read > 0, "call 3 (new tail) still read the stable prefix — the breakpoint sits at the boundary");

if (failed) {
  console.log(
    "\n  READ THIS BEFORE CONCLUDING ANYTHING. Zero counts have several causes:\n" +
      "    1. the gateway did not forward cache_control (call 1 wrote 0);\n" +
      "    2. it forwarded it but did not pass the counts back (check the provider's own usage page);\n" +
      "    3. the gateway sent the calls to different upstream deployments or accounts (see the\n" +
      "       deployment id and api base lines above) — each has its own cache;\n" +
      "    4. the alias does not resolve to an Anthropic model, where cache_control means nothing;\n" +
      "    5. more than five minutes passed between calls.\n" +
      "  If call 2 reads but call 3 does not, the engine's boundary is at fault, not the gateway.\n" +
      "  If call 1 writes and call 2 reads 0 (the 2026-09-21 result), every breakpoint the fleet\n" +
      "  sends costs the write premium and saves nothing: fix the gateway before relying on this.",
  );
}

console.log(`\n=== ${failed ? "FAIL" : "PASS"} ===`);
process.exit(failed ? 1 : 0);
