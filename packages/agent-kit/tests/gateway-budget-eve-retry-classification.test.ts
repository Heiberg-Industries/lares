/**
 * Documents (does not fix — out of scope for LAR "429 recognition" work) a gap this module
 * cannot close from where it sits: on current LiteLLM, a REAL production budget refusal is a
 * 429, and eve's own retry loop retries a 429 up to twice more before `turn.failed` ever
 * fires — so `isBudgetExceeded` in `../src/gateway-budget.js` never even gets a chance to run
 * against it until after the retries have already spent more of the (already-exhausted)
 * budget.
 *
 * `src/gateway-budget.ts`'s own header explains why this module cannot prevent that itself:
 * it deliberately never throws inside `createGatewayProvider`'s request path (see that
 * header), so it never sees the raw `AI_APICallError` the gateway call actually throws — only
 * eve's `turn.failed`/`session.failed` event data, composed AFTER eve's retry loop has already
 * run its course.
 *
 * This test proves the gap by executing the INSTALLED eve's own classifier — not by guessing
 * at its source — the same "read the real dependency" pattern
 * `gateway-budget-eve-default-text.test.ts` uses for eve's default failure text. eve exports
 * `classifyModelCallError` from `dist/src/harness/model-call-error.js` (no package.json
 * "exports" entry for that path, so it is reached by resolving the installed file directly,
 * the same way `gateway-budget-eve-default-text.test.ts` reaches `defaults.js`).
 *
 * Traced call path for the real 429 case: `runOneModelCall` -> `runModelCallWithRetries`
 * (`dist/src/harness/tool-loop.js`) catches the thrown `AI_APICallError`, calls
 * `classifyModelCallError(error)`, and retries (up to attempt 3, exponential backoff) whenever
 * the result is `"retry"`. `classifyModelCallError` has no allow-list entry for LiteLLM's
 * `budget_exceeded` type (`isRetryableGatewayType`/`isTerminalGatewayType` in the same file
 * list neither it), so it falls through to a bare-status check where `429` is hard-coded into
 * the transient branch alongside 408/409/5xx — hence `"retry"`.
 *
 * eve version: 0.32.0 (matches `gateway-budget-eve-default-text.test.ts` and the version this
 * repo has installed at the time this test was written, 2026-09-18).
 *
 * PROPOSED FOLLOW-UP (not built here — out of scope for this slice; retry configuration is
 * explicitly excluded): the smallest fix is in `createGatewayProvider`'s fetch seam
 * (`packages/agent-kit/src/gateway-provider.ts`) — recognise a budget refusal on the response
 * BEFORE returning it to the AI SDK, and throw a `GatewayBudgetExceededError` there instead of
 * letting the raw response reach eve's classifier. `GatewayBudgetExceededError` already
 * presents a fixed 400 to a `Gateway*`-named-error status read (see its own doc comment), so
 * eve would classify it as terminal on the first attempt, no retries. That is a request-path
 * change to a file this slice was told not to widen scope into, and touches the exact seam
 * `gateway-budget.ts`'s header currently says deliberately stays a pass-through — worth a
 * dedicated ticket, not a rider on this one.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** The installed eve package root, resolved through Node rather than guessed from a path. */
function eveRoot(): string {
  let dir = path.dirname(require.resolve("eve"));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "package.json")) && path.basename(dir) === "eve") return dir;
    dir = path.dirname(dir);
  }
  throw new Error("could not locate the installed eve package root from require.resolve('eve')");
}

interface ModelCallErrorModule {
  classifyModelCallError(error: unknown): "retry" | "recoverable" | "terminal";
}

async function loadInstalledClassifier(): Promise<ModelCallErrorModule["classifyModelCallError"]> {
  const file = path.join(eveRoot(), "dist", "src", "harness", "model-call-error.js");
  if (!existsSync(file)) {
    throw new Error(
      `eve's model-call-error module is no longer at ${file}. eve moved its harness layout; ` +
        "re-check this test (and this file's header) before deleting it.",
    );
  }
  const mod = (await import(pathToFileURL(file).href)) as ModelCallErrorModule;
  if (typeof mod.classifyModelCallError !== "function") {
    throw new Error(`${file} no longer exports classifyModelCallError — re-check this test.`);
  }
  return mod.classifyModelCallError;
}

/** Shaped the way `@ai-sdk/anthropic` builds an `AI_APICallError` around a gateway body —
 *  mirrors `aiSdkApiCallError` in `gateway-budget.test.ts`, reproduced here rather than
 *  imported so this test has no dependency on that file's internals. */
function budgetRefusalApiCallError(statusCode: number): Error {
  const body = {
    error: {
      message: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
      type: "budget_exceeded",
      param: null,
      code: String(statusCode),
    },
  };
  const err = new Error(JSON.stringify(body)) as Error & Record<string, unknown>;
  err["name"] = "AI_APICallError";
  err["statusCode"] = statusCode;
  err["responseBody"] = JSON.stringify(body);
  err["data"] = body;
  return err;
}

describe("eve's own retry classification of a budget refusal (documented, not fixed here)", () => {
  it("a 400 budget refusal classifies as terminal — no retry, matches the measured 2026-09-01 status", async () => {
    const classify = await loadInstalledClassifier();
    expect(classify(budgetRefusalApiCallError(400))).toBe("terminal");
  });

  it("a 429 budget refusal classifies as retry — current LiteLLM's status makes eve retry a capped call", async () => {
    const classify = await loadInstalledClassifier();
    expect(classify(budgetRefusalApiCallError(429))).toBe("retry");
  });
});
