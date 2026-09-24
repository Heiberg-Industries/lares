/**
 * packages/agent-kit/tests/live/gateway-lane-anthropic.live.mts — the LIVE probe for the
 * ANTHROPIC lane of `../../src/gateway-provider.js`'s `gatewayModel()` (F8, wave 8F: the two-
 * lane ruling in `.claude/plans/2026-09-20-prelaunch-wave-8f-neutral-stack.md`, "RULED:
 * vendor-agnostic, and the two lanes").
 *
 * NOT part of `pnpm test` (this file's `.live.mts` extension is not vitest's `*.test.*` glob,
 * the same convention every other file under a `tests/live/` directory in this repository
 * already uses). NOT runnable from this worktree — it needs a real, reachable gateway, which
 * nothing in this repository's CI or dev environment has. Run it BY HAND against a real
 * installation's gateway, once after this file lands and again whenever LiteLLM or
 * `@ai-sdk/anthropic` is upgraded:
 *
 *     I_UNDERSTAND_THIS_SPENDS_MONEY=1 \
 *     GATEWAY_URL=https://gateway.example \
 *     GATEWAY_KEY_FILE=/run/secrets/gateway-key \
 *     PROBE_MODEL=lares-brain \
 *       npx tsx packages/agent-kit/tests/live/gateway-lane-anthropic.live.mts
 *
 * WHY THIS FILE EXISTS. Per the root CLAUDE.md's fixture rule ("a fixture is what we believe an
 * API does; only a live call is what it does"), `tests/gateway-provider.test.ts` only asserts on
 * the shape of the request this lane BUILDS (headers, baseURL, provider name) — it never sends
 * one. This file sends two real ones: a tool call and a streaming turn, the owner's own PROOF
 * requirement ("one live probe PER LANE — a real tool call + a streaming turn — not per
 * vendor").
 *
 * WHAT THIS PRINTS: shapes, booleans and counts only — never the key, never a tool argument's
 * value, never the completion or stream text itself.
 *
 * IT ALSO ANSWERS LAR-85's LIVE HALF. Calls 3 and 4 send a real `cache_control` breakpoint and
 * report whether a cache entry was created and then read back THROUGH the gateway. The engine
 * sets `cache_control` nowhere today; LAR-85 asks whether doing so would pay, and that depends
 * first on whether LiteLLM forwards it at all. Answering it here costs two extra small calls in
 * a sitting that is already happening.
 *
 * LAST RUN: **2026-09-21**, LiteLLM **v1.101.0**, alias `heiberg-brain` -> `claude-opus-5`,
 * throwaway virtual key scoped to two aliases.
 *   - THE LANE PASSES: one tool call (count=1, correct tool name) and a streaming turn
 *     (3 chunks, 31 chars). The AI SDK logs a warning that the model "heiberg-brain" is unknown
 *     and caps `maxOutputTokens` at 4096 in compatibility mode — expected, an alias is not a
 *     model id it can recognise, and harmless at these sizes.
 *   - CACHING, for LAR-85: `cache_control` IS forwarded. Call 3 wrote 10,286 cache tokens and
 *     plain input tokens fell to 2. But call 4, an identical request, wrote 10,286 AGAIN and
 *     read 0 — across three separate runs. `inference_geo` (global) and `service_tier`
 *     (standard) were identical on both calls, so neither explains the miss.
 *   - TWO MEASUREMENT BUGS IN THIS FILE WERE FOUND BY RUNNING IT, both of which had first
 *     reported a false "the gateway strips cache_control": the counts are NOT at the top of
 *     `providerMetadata.anthropic` but one level down in its `usage`; and they are SNAKE_CASE
 *     on the wire (`cache_creation_input_tokens`) even though the installed
 *     @ai-sdk/anthropic@4.0.37 `.d.ts` declares camelCase. The declared names are a fixture;
 *     the wire is the fact. Printing the keys actually present is what caught both.
 */
import { readFileSync } from "node:fs";
import { generateText, streamText, tool } from "ai";
import { z } from "zod";
import { createGatewayProvider } from "../../src/gateway-provider.js";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// ── guard: both calls below are real and billed ─────────────────────────────────────────────
if (process.env["I_UNDERSTAND_THIS_SPENDS_MONEY"] !== "1") {
  fail(
    "refusing to run: this probe makes two real, BILLED calls against the gateway (a tool " +
      "call and a streaming turn). Set I_UNDERSTAND_THIS_SPENDS_MONEY=1 to proceed.",
  );
}

const rawGatewayUrl = process.env["GATEWAY_URL"];
const keyFile = process.env["GATEWAY_KEY_FILE"];
const probeModel = process.env["PROBE_MODEL"];
if (!rawGatewayUrl) fail("GATEWAY_URL is not set. This probe needs a real, reachable gateway URL.");
if (!keyFile) fail("GATEWAY_KEY_FILE is not set. This probe reads the key from a file, exactly like a real agent does.");
if (!probeModel) fail("PROBE_MODEL is not set. Pass a real, working alias explicitly — this probe will not guess one.");

// Confirm the key file is readable up front — a clearer failure than letting the first request
// surface gatewayModel()'s own "secret file not readable" error mid-call.
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

let failed = false;
function report(ok: boolean, label: string): void {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  if (!ok) failed = true;
}

console.log(`Gateway: ${redactUrl(rawGatewayUrl)}`);
console.log(`Lane: anthropic`);
console.log(`Model alias under test: ${probeModel}\n`);

const { gatewayModel } = createGatewayProvider({
  defaultKeyFile: keyFile,
  defaultGatewayUrl: rawGatewayUrl,
  defaultLane: "anthropic",
});

// ── call 1: a real tool call ─────────────────────────────────────────────────────────────────
console.log("=== Call 1: a real tool call ===");
const toolResult = await generateText({
  model: gatewayModel(probeModel),
  tools: {
    probe_tool: tool({
      description: "A no-op probe tool. Call it with any short string value.",
      inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }) => `received:${value.length}`,
    }),
  },
  toolChoice: "required",
  prompt: "Call probe_tool with value set to the word test.",
});
report(toolResult.toolCalls.length > 0, `at least one tool call was made (count=${toolResult.toolCalls.length})`);
report(
  toolResult.toolCalls.every((c) => c.toolName === "probe_tool"),
  `every tool call named the one tool offered ("probe_tool")`,
);
console.log(`  tool call count: ${toolResult.toolCalls.length}`);

// ── call 2: a streaming turn ─────────────────────────────────────────────────────────────────
console.log("\n=== Call 2: a streaming turn ===");
const stream = streamText({
  model: gatewayModel(probeModel),
  prompt: "Reply with one short sentence.",
});
let chunkCount = 0;
let charCount = 0;
for await (const chunk of stream.textStream) {
  chunkCount += 1;
  charCount += chunk.length;
}
report(charCount > 0, `the accumulated stream text has non-zero length (chars=${charCount})`);
console.log(`  chunks received: ${chunkCount}`);
console.log(`  characters received: ${charCount}`);

// ── call 3 + 4: does prompt caching SURVIVE the gateway? (LAR-85) ───────────────────────────
// The engine sets `cache_control` NOWHERE today, and LAR-85 asks whether it would even work if
// it did. That question has two halves, and only this one is answerable from outside the box:
// does LiteLLM FORWARD an Anthropic `cache_control` breakpoint on `/v1/messages`, and does it
// hand the cache token counts BACK? (The other half — whether eve exposes a seam to set it on a
// real agent turn — is a code question, not a live one.)
//
// SIZE IS THE TRAP. A prefix below the model's minimum is not an error: it silently caches
// nothing and reports zero, which is indistinguishable from "the gateway stripped it". The
// minimum is model-dependent and NOT monotonic across generations — 512 tokens on Opus 5 and
// Fable 5.1, 1024 on Opus 4.8 and Sonnet 5, 2048 on Opus 4.7, and 4096 on Opus 4.6/4.5 and
// Haiku 4.5. This probe cannot know which real model an alias resolves to, so it builds a
// prefix far above the WORST case and says so, rather than risk reporting a false negative.
const PREFIX_PARAGRAPH =
  "This paragraph is deterministic filler whose only purpose is to push the cached prefix " +
  "comfortably past the largest per-model minimum, so that a zero cache count means the " +
  "gateway dropped the breakpoint rather than that the prefix was too short to cache. ";
// MEASURED: 400 repetitions came out at ~25.5k tokens, far more than needed. 130 repetitions is
// ~8k tokens — still twice the 4096-token worst case, at a third of the spend.
const CACHE_PREFIX = PREFIX_PARAGRAPH.repeat(130);
const approxPrefixTokens = Math.round(CACHE_PREFIX.length / 4);

/** MEASURED 2026-09-21 against the real gateway, and NOT what the installed
 *  @ai-sdk/anthropic@4.0.37 `.d.ts` advertises. The declarations name camelCase
 *  `cacheCreationInputTokens`/`cacheReadInputTokens`; the wire, under
 *  `providerMetadata.anthropic.usage`, carries Anthropic's own SNAKE_CASE
 *  `cache_creation_input_tokens`/`cache_read_input_tokens` passed straight through. Reading
 *  the declared names returned zero for both and looked exactly like "the gateway stripped
 *  cache_control". Both spellings are read here; the keys present are printed regardless. */
interface AnthropicCacheUsage {
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly input_tokens?: number;
  /** Neither is a secret; both can move a cache HIT to a MISS, so both are printed. */
  readonly inference_geo?: string;
  readonly service_tier?: string;
}

/** The counts are provider-specific, so they arrive under `providerMetadata.anthropic` rather
 *  than in the portable `usage`. Field names verified against the installed
 *  @ai-sdk/anthropic@4.0.37 type declarations — but the KEYS ACTUALLY PRESENT are printed too,
 *  so a rename in a later version shows up as data instead of a silent zero. */
function cacheUsageOf(meta: unknown): { write: number; read: number; input: number; geo: string; tier: string; keys: string[] } {
  // MEASURED 2026-09-21, not assumed: the counts are NOT at the top of
  // `providerMetadata.anthropic` — they sit one level down, inside its own `usage` object.
  // The first run of this probe read the top level, got zero for both, and would have been
  // reported as "LiteLLM strips cache_control" if it had not also printed the keys actually
  // present. Both levels are read here so the probe survives either shape, and the keys of
  // BOTH are printed for the same reason.
  const anthropic = (meta as { anthropic?: AnthropicCacheUsage & { usage?: AnthropicCacheUsage } } | undefined)
    ?.anthropic;
  const usage = anthropic?.usage;
  return {
    input: usage?.input_tokens ?? 0,
    geo: usage?.inference_geo ?? "«absent»",
    tier: usage?.service_tier ?? "«absent»",
    write: usage?.cache_creation_input_tokens ?? usage?.cacheCreationInputTokens ?? anthropic?.cacheCreationInputTokens ?? 0,
    read: usage?.cache_read_input_tokens ?? usage?.cacheReadInputTokens ?? anthropic?.cacheReadInputTokens ?? 0,
    keys: [
      ...(anthropic ? Object.keys(anthropic).sort() : []),
      ...(usage ? Object.keys(usage).sort().map((k) => `usage.${k}`) : []),
    ],
  };
}

async function cachedCall(alias: string): Promise<{ write: number; read: number; input: number; geo: string; tier: string; keys: string[] }> {
  const result = await generateText({
    model: gatewayModel(alias),
    system: CACHE_PREFIX,
    prompt: "Reply with the single word: ok.",
    maxOutputTokens: 16,
    // Top-level auto-caching: marks the last cacheable block, which with a system prompt this
    // large is the system prefix itself.
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  });
  return cacheUsageOf(result.providerMetadata);
}

console.log("\n=== Calls 3 and 4: does a cache_control breakpoint survive the gateway? (LAR-85) ===");
console.log(`  prefix sent: ~${approxPrefixTokens} tokens (worst-case model minimum is 4096)`);

const first = await cachedCall(probeModel);
console.log(`  call 3 — cache write tokens: ${first.write}, cache read tokens: ${first.read}, plain input tokens: ${first.input}`);
console.log(`  call 3 — inference_geo: ${first.geo}, service_tier: ${first.tier}`);
console.log(`  call 3 — keys present under providerMetadata.anthropic: ${first.keys.join(", ") || "«none»"}`);

const second = await cachedCall(probeModel);
console.log(`  call 4 — cache write tokens: ${second.write}, cache read tokens: ${second.read}, plain input tokens: ${second.input}`);
console.log(`  call 4 — inference_geo: ${second.geo}, service_tier: ${second.tier}`);

// A write on the first call and a read on the second is the only combination that proves the
// whole round trip: the breakpoint reached Anthropic, an entry was created, and the second
// identical request was served from it THROUGH the gateway.
const cachingWorks = first.write > 0 && second.read > 0;
// INFORMATIONAL, like litellm-key-info's step 4: the engine sets `cache_control` NOWHERE
// today, so this measurement cannot make the lane itself fail. The lane's own assertions above
// are what this probe's exit code is about. Record the numbers on LAR-85 either way.
console.log(`  [${cachingWorks ? "ok" : "measurement"}] cache entry created AND read back through the gateway: ${cachingWorks}`);
if (first.write > 0 && second.read === 0) {
  console.log(
    "  MEASURED 2026-09-21: the breakpoint IS forwarded — a cache entry is written every time\n" +
      "  (plain input tokens collapse to single digits) — but an identical follow-up request\n" +
      "  writes the entry AGAIN and never reads one. inference_geo and service_tier were\n" +
      "  identical on both calls, so neither explains it. Economically this is the WORST case:\n" +
      "  a cache write is billed at ~1.25x and a read at ~0.1x, so switching caching on in this\n" +
      "  shape would RAISE the bill, not lower it. Causes 3 and 4 below are ruled out; 1 and 2\n" +
      "  are not, and telling them apart needs a call that bypasses the gateway. That belongs to\n" +
      "  LAR-85's design pass, not to this probe.",
  );
}

if (!cachingWorks) {
  console.log(
    "\n  READ THIS BEFORE CONCLUDING LiteLLM STRIPS cache_control. Zero counts have four\n" +
      "  possible causes and this probe cannot tell them apart on its own:\n" +
      "    1. the gateway did not forward the breakpoint (the finding LAR-85 is looking for);\n" +
      "    2. the gateway forwarded it but did not pass the counts back, so caching may in\n" +
      "       fact be working and merely invisible — check the provider's own spend page;\n" +
      "    3. this alias does not resolve to an Anthropic model at all, in which case\n" +
      "       cache_control is meaningless and this result says nothing (re-run against an\n" +
      "       alias you know targets Claude);\n" +
      "    4. the two calls were far enough apart that the 5-minute entry had expired.\n" +
      "  Record which of these you ruled out, in the LAST RUN note and on LAR-85.",
  );
}

console.log(`\n=== ${failed ? "FAIL" : "PASS"} ===`);
process.exit(failed ? 1 : 0);
