/**
 * The installed Eve classifier still treats a gateway 429 budget refusal as retryable.
 * These assertions preserve that response classification; no budget-error rewriting is
 * implemented here. The invocation guard now refuses subsequent physical dispatch from a
 * reused selection. The compiled-role HTTP proof exercises Eve's outer retries and recovery
 * and verifies one upstream request, so classifier retries no longer imply another dispatch.
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
