/**
 * A cold-start compact cannot reach any model provider but the gateway.
 *
 * The path, read from the installed eve 1.0 (`dist/src/…`):
 *  1. `POST …/compact` between turns runs `harness/compaction/step.js` `compactHistory`, which asks
 *     `resolveEffectiveRuntimeModel` (`harness/model-call/model.js`) for the model.
 *  2. That reads the chosen model with `stepModel` → `contributionsOf(…, 'read')` →
 *     `definitions/kernel.js` `keepOne` in RESTORE mode. The engine's model function refuses to run
 *     between turns (`definition-model.ts`, `MODEL_SELECTION_REFUSED`), and a fresh process holds no
 *     live provider object, so `keepOne` returns the kept value alone, and
 *     `definitions/model.js` answers `{ reference: { id } }` with no `model`.
 *  3. `resolveEffectiveRuntimeModel` then calls `config.resolveModel(reference)`;
 *     `runtime/agent/resolve-model.js` `resolveRuntimeModelReference` returns the bare id string.
 *  4. `summaryExecutor` hands the string to `streamText`, and the AI SDK resolves a string with
 *     `globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway`: Vercel's AI Gateway.
 * Steps 1-3 are read from the code; steps 3-4 are exercised below against the installed eve and AI SDK.
 *
 * The first test is the "before": without the refusing provider the string reaches the AI SDK's
 * gateway (it fails only for lack of a key, not for lack of a path). The tests after it install
 * the refusing provider, which locks the global for the rest of this file's process, so the
 * order matters and the "before" is first.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_REFUSED, installRefusingDefaultProvider, refusingDefaultProvider,
} from "../src/gateway-budget.js";

const require = createRequire(import.meta.url);
function eveRoot(): string {
  let dir = path.dirname(require.resolve("eve"));
  while (path.basename(dir) !== "eve" && dir !== path.dirname(dir)) dir = path.dirname(dir);
  return dir;
}

/** What eve resolves a saved model reference to, with eve's test-mode mock models switched off. */
async function savedReferenceResolved(id: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(path.join(eveRoot(), "dist", "src", "runtime", "agent", "resolve-model.js")).href)) as {
    resolveRuntimeModelReference(reference: { id: string }): Promise<unknown>;
  };
  return mod.resolveRuntimeModelReference({ id });
}

/** Everything a stream of this model produces, and every network request it made. */
async function run(model: unknown): Promise<{ errors: Array<{ name: string; message: string }>; fetched: string[] }> {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => { fetched.push(String(url)); throw new Error("network blocked by test"); });
  const errors: Array<{ name: string; message: string }> = [];
  try {
    const result = streamText({ model: model as never, prompt: "summarise", onError: () => undefined });
    for await (const part of result.fullStream) {
      if (part.type === "error") {
        const error = part.error as { name?: string; message?: string };
        errors.push({ name: String(error.name), message: String(error.message) });
      }
    }
  } catch (error) {
    errors.push({ name: (error as Error).name, message: (error as Error).message });
  }
  return { errors, fetched };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production"); // eve returns mock models under NODE_ENV=test
  vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
  for (const key of ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"]) vi.stubEnv(key, "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("a saved model id resolved again by eve (the cold-start compact)", () => {
  it("BEFORE the guard: the saved id becomes a bare string, and the AI SDK sends a string to its own gateway", async () => {
    const resolved = await savedReferenceResolved("lares-brain");
    expect(resolved).toBe("lares-brain");
    const { errors } = await run(resolved);
    // It reached Vercel's AI Gateway provider; only the missing credential stopped it.
    expect(errors.map((e) => e.name)).toContain("GatewayAuthenticationError");
    expect(errors.map((e) => e.message).join("\n")).not.toContain(DEFAULT_PROVIDER_REFUSED);
  });

  it("AFTER the guard: the same saved id is refused, and nothing is fetched, with or without credentials", async () => {
    installRefusingDefaultProvider();
    for (const withKey of [false, true]) {
      vi.stubEnv("AI_GATEWAY_API_KEY", withKey ? "a-key-that-would-work" : "");
      const resolved = await savedReferenceResolved("lares-brain");
      expect(resolved).toBe("lares-brain");
      const { errors, fetched } = await run(resolved);
      expect(fetched).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.message.includes(DEFAULT_PROVIDER_REFUSED)), JSON.stringify(errors)).toBe(true);
    }
  });

  it("the gateway's own provider object is unaffected: it never asks the default provider", async () => {
    installRefusingDefaultProvider();
    const { MockLanguageModelV3 } = await import("ai/test");
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({ type: "text-delta", id: "1", delta: "ok" });
            controller.enqueue({ type: "text-end", id: "1" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
            controller.close();
          },
        }),
      }),
    });
    const { errors } = await run(model);
    expect(errors).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("the guard is locked: nothing in this process can swap in another default provider", () => {
    installRefusingDefaultProvider();
    const reachable = { languageModel: () => { throw new Error("would reach a network"); } };
    expect(() => { (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER = reachable; }).toThrow();
    expect(() => Object.defineProperty(globalThis, "AI_SDK_DEFAULT_PROVIDER", { value: reachable })).toThrow();
    expect((globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER).not.toBe(reachable);
    expect(() => installRefusingDefaultProvider()).not.toThrow(); // idempotent
  });
});

describe("the refusing provider itself", () => {
  it("answers a request for any kind of model with a model that refuses every call", async () => {
    const provider = refusingDefaultProvider() as Record<string, (id: string) => Record<string, () => unknown>>;
    for (const kind of ["languageModel", "embeddingModel", "textEmbeddingModel", "imageModel", "speechModel", "transcriptionModel", "rerankingModel", "videoModel", "somethingEveAddsLater"]) {
      const model = provider[kind]!("any-id");
      expect(model.modelId ?? "any-id").toBeTruthy();
      for (const call of ["doGenerate", "doStream", "doEmbed", "doRerank"]) expect(() => model[call]!(), `${kind}.${call}`).toThrow(DEFAULT_PROVIDER_REFUSED);
    }
  });

  it("is not mistaken for a promise or a symbol-keyed thing", () => {
    const provider = refusingDefaultProvider() as unknown as { then?: unknown; [Symbol.iterator]?: unknown };
    expect(provider.then).toBeUndefined();
    expect(provider[Symbol.iterator]).toBeUndefined();
  });

  it("installs on a plain target and locks it", () => {
    const target: { AI_SDK_DEFAULT_PROVIDER?: unknown } = {};
    installRefusingDefaultProvider(target);
    const first = target.AI_SDK_DEFAULT_PROVIDER;
    expect(first).toBeDefined();
    expect(() => { target.AI_SDK_DEFAULT_PROVIDER = {}; }).toThrow();
    installRefusingDefaultProvider(target);
    expect(target.AI_SDK_DEFAULT_PROVIDER).toBe(first);
  });
});
