import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import declaration from "../agent.json";

// agent.ts calls gatewayModel() at module scope (inside defineAgent({ model: ... })), which
// reads the gateway key from disk once and caches it — same "read once at startup" shape
// gateway-provider.test.ts isolates with vi.resetModules() + a fresh dynamic import. A key
// file has to exist before the import runs, or module load throws before we ever see the
// config object.
async function freshAgentConfig() {
  vi.resetModules();
  return (await import("../agent/agent.js")).default;
}

// The resolver keeps its pinned alias in eve session state, which only exists inside a live
// eve step. Standing in an in-memory store is what lets this file exercise the REAL resolver
// — agent-kit's, unmocked — rather than a stub that would assert nothing about the wiring.
// `definition-model.ts` is the only module in agent.ts's graph that touches `eve/context`.
const sessionState = vi.hoisted(() => new Map<string, unknown>());
vi.mock('eve/context', () => ({
  defineState: (key: string, initial: () => unknown) => ({
    get: () => (sessionState.has(key) ? sessionState.get(key) : initial()),
    update: (fn: (value: unknown) => unknown) => { sessionState.set(key, fn(sessionState.has(key) ? sessionState.get(key) : initial())); },
  }),
}));

describe("eve-saga agent config", () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eve-saga-agent-"));
    keyPath = join(dir, "gateway-key");
    writeFileSync(keyPath, "test-gateway-key\n", "utf8");
    process.env["GATEWAY_KEY_FILE"] = keyPath;
    delete process.env["GATEWAY_URL"];
    delete process.env["EVE_SAGA_MODEL"];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["GATEWAY_KEY_FILE"];
    delete process.env["GATEWAY_URL"];
    delete process.env["EVE_SAGA_MODEL"];
  });

  it("selects @workflow/world-postgres as the durable workflow world", async () => {
    const agent = await freshAgentConfig();
    expect(agent.experimental?.workflow?.world).toBe("@workflow/world-postgres");
  });

  it("declares no agent-level modelContextWindowTokens — the window travels with the selection", async () => {
    // eve 0.60 types this key as `never` beside a dynamic model
    // (node_modules/eve/dist/src/shared/agent-definition.d.ts, the dynamic branch of
    // PublicAgentDefinition) because a dynamic resolver returns metadata with each concrete
    // selection instead. agent-kit's `sessionGatewayModel` supplies the 200k window per step;
    // putting it back here is a compile error, and the reason is this test.
    const agent = await freshAgentConfig();
    expect(agent.modelContextWindowTokens).toBeUndefined();
  });

  // ORB-278 step 2: `model` is a dynamic resolver — the definition picks the model per
  // conversation. Saga is the owner's daily driver and, until this review, nothing touched her
  // model wiring at all; every constraint below fails INVISIBLY if it regresses.
  it("declares step.started and NOTHING else, so no scope can hand eve a routable model id", async () => {
    // The whole safety argument of this wiring. eve resolves `session.started` and
    // `turn.started` with `durability: "durable"`, which refuses a provider object and accepts
    // only a model-id STRING — and a bare id string is routed through the Vercel AI Gateway,
    // past the self-hosted LiteLLM gateway every model call here must use. `step.started` is
    // the only scope that takes the constructed provider. Prompt caches are per model, and the
    // alias is pinned for the conversation on the first step, so this is still one model per
    // conversation — the $250 retry-loop incident's rule, not a tuning choice.
    const agent = await freshAgentConfig();
    const model = agent.model as { events?: Record<string, unknown>; fallback?: unknown };
    expect(Object.keys(model.events ?? {})).toEqual(["step.started"]);
    // eve 0.33.0 removed `fallback`; a reintroduced one would be a silently-ignored key.
    expect(model.fallback).toBeUndefined();
  });

  it("pins the declared alias on the first step and returns a constructed provider, never an id", async () => {
    sessionState.clear();
    const agent = await freshAgentConfig();
    const model = agent.model as {
      events: { "step.started": (event: unknown, ctx: unknown) => Promise<{ model: { modelId?: string }; modelContextWindowTokens: number }> };
    };
    const first = await model.events["step.started"](undefined, { session: { id: "saga-model-test" } });
    expect(first.model).not.toBeTypeOf("string");
    expect(first.modelContextWindowTokens).toBe(200_000);
    // The env override still wins, and `beforeEach` clears it — but this is spelled out rather
    // than assumed, so the case cannot go red on a machine that exports EVE_SAGA_MODEL.
    expect(first.model.modelId).toBe(process.env["EVE_SAGA_MODEL"] ?? declaration.model);
    // ...and a second step reuses the pin: same alias, no second read of the definition folder.
    const second = await model.events["step.started"](undefined, { session: { id: "saga-model-test" } });
    expect(second.model.modelId).toBe(first.model.modelId);
  });
});
