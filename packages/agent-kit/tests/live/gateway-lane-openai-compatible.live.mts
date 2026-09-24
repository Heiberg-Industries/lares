/**
 * packages/agent-kit/tests/live/gateway-lane-openai-compatible.live.mts — the LIVE probe for
 * the OPENAI-COMPATIBLE lane of `../../src/gateway-provider.js`'s `gatewayModel()` (F8, wave
 * 8F: the two-lane ruling in
 * `.claude/plans/2026-09-20-prelaunch-wave-8f-neutral-stack.md`, "RULED: vendor-agnostic, and
 * the two lanes").
 *
 * NOT part of `pnpm test` (this file's `.live.mts` extension is not vitest's `*.test.*` glob,
 * the same convention every other file under a `tests/live/` directory in this repository
 * already uses). NOT runnable from this worktree — it needs a real, reachable gateway, which
 * nothing in this repository's CI or dev environment has. Run it BY HAND against a real
 * installation's gateway, once after this file lands and again whenever LiteLLM or
 * `@ai-sdk/openai-compatible` is upgraded:
 *
 *     I_UNDERSTAND_THIS_SPENDS_MONEY=1 \
 *     GATEWAY_URL=https://gateway.example \
 *     GATEWAY_KEY_FILE=/run/secrets/gateway-key \
 *     PROBE_MODEL=<a non-Anthropic alias this lane is meant for> \
 *       npx tsx packages/agent-kit/tests/live/gateway-lane-openai-compatible.live.mts
 *
 * This file does not guess or hard-code a model — the owner supplies a real, non-Anthropic
 * alias from his own gateway when he runs it by hand.
 *
 * WHY THIS FILE EXISTS. Per the root CLAUDE.md's fixture rule ("a fixture is what we believe an
 * API does; only a live call is what it does"), `tests/gateway-provider.test.ts` only asserts on
 * the shape of the request this lane BUILDS (the Authorization header injected via the fetch
 * closure, the `/v1/chat/completions` route, the provider name) — it never sends one, and it
 * cannot prove the gateway actually accepts and translates this wire format the way
 * `createOpenAICompatible` expects. This file sends two real ones: a tool call and a streaming
 * turn, the owner's own PROOF requirement ("one live probe PER LANE — a real tool call + a
 * streaming turn — not per vendor").
 *
 * SAY THIS OUT LOUD RATHER THAN LEAVE IT IMPLICIT (per the plan's own note): `doctor
 * --test-model` always exercises the gateway's Anthropic-format route directly, regardless of
 * which lane a real agent's own calls use — it does NOT prove this lane. This probe is what
 * actually proves it, for whichever alias is passed.
 *
 * WHAT THIS PRINTS: shapes, booleans and counts only — never the key, never a tool argument's
 * value, never the completion or stream text itself.
 *
 * LAST RUN: **2026-09-21**, LiteLLM **v1.101.0**, alias `heiberg-utility` ->
 * `mistral/mistral-small-latest`. **PASS** — one tool call (count=1, correct tool name) and a
 * streaming turn (2 chunks, 6 chars). This is the first time this lane has ever been spoken to
 * a real gateway: before this run it was shipped, typed and unit-tested but never exercised.
 * A non-Anthropic vendor is reachable through the gateway in OpenAI format, which is the whole
 * claim F8 exists to make. NOTE ON ALIAS CHOICE: do NOT point this probe at a very small model
 * (e.g. a 3B) — the tool-call assertion would then be testing the model's competence rather
 * than the lane, and a failure would be unreadable. mistral-small handles it and costs little.
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
if (!probeModel) {
  fail(
    "PROBE_MODEL is not set. Pass a real, non-Anthropic alias this lane is meant for — this " +
      "probe will not guess or hard-code one.",
  );
}

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
console.log(`Lane: openai-compatible`);
console.log(`Model alias under test: ${probeModel}\n`);

const { gatewayModel } = createGatewayProvider({
  defaultKeyFile: keyFile,
  defaultGatewayUrl: rawGatewayUrl,
  defaultLane: "openai-compatible",
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

console.log(`\n=== ${failed ? "FAIL" : "PASS"} ===`);
process.exit(failed ? 1 : 0);
