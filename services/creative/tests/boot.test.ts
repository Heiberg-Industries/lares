/**
 * The Task-1 gate, in test form: the app is a real eve app, it routes through the LiteLLM
 * gateway rather than a bare model-id string, and its agent declaration (ORB-144) is valid.
 *
 * Task 1 kept the agent.json checks here too, explicitly as a holding position: there were no
 * tools and no extension yet, so a full `tests/agent-declaration.test.ts` had no capability→tool
 * map and no class-vs-scope cross-check to run. Task 5 gave it both, so those checks MOVED to
 * that file rather than being duplicated — including the two this file used to carry alone
 * (the persona path resolving, and the boot model matching the declared one), which now sit
 * beside the conformance checks they belong with.
 */
import { describe, it, expect, vi } from "vitest";

import declaration from "../agent.json";

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

describe("agent definition", () => {
  it("compiles and exports a step-scoped model resolver, with the window on the selection", async () => {
    const mod = await import("../agent/agent.js");
    expect(mod.default).toBeDefined();
    // eve 0.60 types an agent-level `modelContextWindowTokens` as `never` beside a dynamic
    // model (the dynamic branch of PublicAgentDefinition,
    // node_modules/eve/dist/src/shared/agent-definition.d.ts): the window now travels with each
    // concrete selection, which agent-kit's `sessionGatewayModel` supplies. It is still
    // hand-set, and still silently WRONG for any smaller-window model — pointing
    // EVE_CALLIOPE_MODEL at one mis-tunes compaction rather than failing.
    expect((mod.default as { modelContextWindowTokens?: number }).modelContextWindowTokens).toBeUndefined();
    // `step.started` and nothing else: the durable scopes accept only a model-id string, and a
    // bare id string is routed through the Vercel AI Gateway rather than the LiteLLM one.
    const model = mod.default.model as { events?: Record<string, unknown>; fallback?: unknown };
    expect(Object.keys(model.events ?? {})).toEqual(["step.started"]);
    expect(model.fallback).toBeUndefined();
  });

  it("pins the declared alias on the first step and reuses it, as a constructed provider", async () => {
    sessionState.clear();
    const model = (await import("../agent/agent.js")).default.model as {
      events: { "step.started": (event: unknown, ctx: unknown) => Promise<{ model: { modelId?: string }; modelContextWindowTokens: number }> };
    };
    const first = await model.events["step.started"](undefined, { session: { id: "calliope-model-test" } });
    expect(first.model).not.toBeTypeOf("string");
    expect(first.modelContextWindowTokens).toBe(200_000);
    // The env override still wins, and this file clears no environment — so the expected value
    // has to account for it, or the case goes red on any machine exporting EVE_CALLIOPE_MODEL
    // (the owner's included).
    expect(first.model.modelId).toBe(process.env["EVE_CALLIOPE_MODEL"] ?? declaration.model);
    const second = await model.events["step.started"](undefined, { session: { id: "calliope-model-test" } });
    expect(second.model.modelId).toBe(first.model.modelId);
  });

  it("routes through the gateway, not a bare model-id string", async () => {
    const { gatewayModel } = await import("../lib/gateway-provider.js");
    const m = gatewayModel("heiberg-brain");
    // A bare id string would be a string; the gateway path returns a constructed model object.
    expect(typeof m).not.toBe("string");
  });
});
