// Smoke test for agent/agent.ts's exported config shape. `defineAgent()` is eve's own identity
// function (it returns exactly what it's given, typed) — so this is really asserting that the
// object built in agent.ts has the fields eve's compiler and runtime require, without needing
// `eve build` or any credentials (gatewayModel() construction reads no secrets — see
// lib/gateway-provider.ts's own doc comment).
import { describe, it, expect, vi } from "vitest";
import agent from "../agent/agent.js";

// The resolver keeps its pinned alias in eve session state, which only exists inside a live
// eve step. Standing in an in-memory store is what lets this file exercise the REAL resolver
// — agent-kit's, unmocked. `definition-model.ts` is the only module in agent.ts's graph that
// touches `eve/context`.
const sessionState = vi.hoisted(() => new Map<string, unknown>());
vi.mock('eve/context', () => ({
  defineState: (key: string, initial: () => unknown) => ({
    get: () => (sessionState.has(key) ? sessionState.get(key) : initial()),
    update: (fn: (value: unknown) => unknown) => { sessionState.set(key, fn(sessionState.has(key) ? sessionState.get(key) : initial())); },
  }),
}));

describe("agent/agent.ts", () => {
  it("declares no agent-level modelContextWindowTokens — the window travels with the selection", () => {
    // eve 0.60 types this key as `never` beside a dynamic model (the dynamic branch of
    // PublicAgentDefinition, node_modules/eve/dist/src/shared/agent-definition.d.ts): a dynamic
    // resolver returns metadata with each concrete selection instead, and agent-kit's
    // `sessionGatewayModel` supplies the 200k window per step.
    expect(agent.modelContextWindowTokens).toBeUndefined();
  });

  it("wires the Postgres-backed workflow world, not eve's default local-disk world", () => {
    expect(agent.experimental?.workflow?.world).toBe("@workflow/world-postgres");
  });

  it("declares step.started and NOTHING else, so no scope can hand eve a routable model id", () => {
    // eve resolves `session.started` and `turn.started` durably, which refuses a provider
    // object and accepts only a model-id STRING — and a bare id string is routed through the
    // Vercel AI Gateway, past the LiteLLM gateway every model call here must use. `step.started`
    // is the only scope that takes the constructed provider. The alias is pinned for the
    // conversation on the first step, so this is still one model per conversation: prompt caches
    // are per model, and re-picking per turn re-ingests the whole conversation at uncached
    // prices.
    const model = agent.model as { fallback?: unknown; events?: Record<string, unknown> };
    expect(Object.keys(model.events ?? {})).toEqual(["step.started"]);
    // eve 0.33.0 removed `fallback`; a reintroduced one would be a silently-ignored key.
    expect(model.fallback).toBeUndefined();
  });

  it("pins the declared alias on the first step and reuses it, as a constructed provider", async () => {
    sessionState.clear();
    const model = agent.model as {
      events: { "step.started": (event: unknown, ctx: unknown) => Promise<{ model: { modelId?: string }; modelContextWindowTokens: number }> };
    };
    const first = await model.events["step.started"](undefined, { session: { id: "marcel-model-test" } });
    expect(first.model).not.toBeTypeOf("string");
    expect(first.modelContextWindowTokens).toBe(200_000);
    // Matches agent.json's `model`. The env override still wins, and this file clears no
    // environment — so the expected value has to account for it rather than going red on a
    // machine exporting MARCEL_MODEL_BRAIN.
    expect(first.model.modelId).toBe(process.env["MARCEL_MODEL_BRAIN"] ?? "heiberg-brain");
    const second = await model.events["step.started"](undefined, { session: { id: "marcel-model-test" } });
    expect(second.model.modelId).toBe(first.model.modelId);
  });
});
