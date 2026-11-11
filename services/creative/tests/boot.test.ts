/**
 * The boot gate, in test form: the app is a real eve app, it routes through the LiteLLM
 * gateway rather than a bare model-id string, and its agent declaration is valid.
 *
 * The agent.json conformance checks live in `tests/agent-declaration.test.ts`, which has the
 * capability→tool map and the class-vs-scope cross-check they need — including the persona path
 * resolving and the boot model matching the declared one.
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

// The private-console checks read the database and are another module's subject; and the
// resolver reads the stream position off eve's session view, which only a live session has.
vi.mock('@lares/agent-kit/private-console-surface', () => ({ verifyPrivateConsoleModel: async () => undefined, verifyPrivateConsoleSession: async () => false }));
vi.mock('eve/events', async (actual) => ({ ...(await actual<typeof import('eve/events')>()), position: (view: { line: number }) => view.line }));

type Selection = { model: { modelId?: string }; modelContextWindowTokens: number };
/** The function eve 1.0 calls before every model call: a `defineDynamic()` value keeps it under
 *  this symbol (node_modules/eve/dist/src/dynamic/definition.js). */
const selectorOf = (model: unknown) => Reflect.get(model as object, Symbol.for("eve.dynamic")) as (ctx: unknown) => Promise<Selection>;
/** What eve hands a dynamic model: the session, its latest turn and the session view. */
const modelContext = (sessionId: string, line: number, turnId = "turn_0") => ({
  session: { id: sessionId, auth: { current: null, initiator: null } },
  turn: { id: turnId, status: "running", input: [] },
  view: { line },
});

describe("agent definition", () => {
  it("compiles and exports a one-function dynamic model, with the window on the selection", async () => {
    const mod = await import("../agent/agent.js");
    expect(mod.default).toBeDefined();
    // eve types an agent-level `modelContextWindowTokens` as `never` beside a dynamic model
    // (the dynamic branch of PublicAgentDefinition,
    // node_modules/eve/dist/src/shared/agent-definition.d.ts): the window travels with each
    // concrete selection, which agent-kit's `sessionGatewayModel` supplies. It is still
    // hand-set, and still silently WRONG for any smaller-window model — pointing
    // AGENT_MODEL at one mis-tunes compaction rather than failing.
    expect((mod.default as { modelContextWindowTokens?: number }).modelContextWindowTokens).toBeUndefined();
    // One function, no events map, no fallback, and never a model-id string: eve routes a bare
    // id through the Vercel AI Gateway rather than the LiteLLM one.
    const model = mod.default.model as { events?: unknown; fallback?: unknown };
    expect(typeof selectorOf(model)).toBe("function");
    expect(model.events).toBeUndefined();
    expect(model.fallback).toBeUndefined();
    expect(typeof mod.default.model).not.toBe("string");
  });

  it("pins the declared alias on the first model call and reuses it, as a constructed provider", async () => {
    sessionState.clear();
    const select = selectorOf((await import("../agent/agent.js")).default.model);
    const first = await select(modelContext("creative-agent-model-test", 2));
    expect(first.model).not.toBeTypeOf("string");
    expect(first.modelContextWindowTokens).toBe(200_000);
    // The env override still wins, and this file clears no environment — so the expected value
    // has to account for it, or the case goes red on any machine exporting AGENT_MODEL
    // (the owner's included).
    expect(first.model.modelId).toBe(process.env["AGENT_MODEL"] ?? declaration.model);
    const second = await select(modelContext("creative-agent-model-test", 9));
    expect(second.model.modelId).toBe(first.model.modelId);
    const nextTurn = await select(modelContext("creative-agent-model-test", 30, "turn_1"));
    expect(nextTurn.model.modelId).toBe(first.model.modelId);
  });

  it("turns every framework default tool away, the delegating agent tool by name as well", async () => {
    const agent = (await import("../agent/agent.js")).default;
    expect(agent.defaultTools).toBe(false);
    expect(agent.tool).toBe(false);
  });

  it("keeps eve's own copy of a finished conversation, private ones included", async () => {
    // Unset, eve 1.0 asks for a private conversation's run data to be deleted when it ends
    // (node_modules/eve/docs/agent-config.md, "Run data retention"). "default" is today's
    // behaviour: the workflow world keeps it.
    const agent = (await import("../agent/agent.js")).default;
    expect(agent.experimental?.workflow?.retention).toBe("default");
    expect(agent.experimental?.workflow?.world).toBe("@workflow/world-postgres");
  });

  it("states eve's per-conversation token cap in the open, at eve's documented default", async () => {
    const limit = (await import("../agent/agent.js")).default.limits?.sessionUsage;
    if (typeof limit !== "function") throw new Error("limits.sessionUsage is not a function");
    const usage = (inputTokens: number, cacheReadTokens: number) => {
      const window = { inputTokens, cacheReadTokens, cacheWriteTokens: 0, outputTokens: 0 };
      return { window, total: window } as Parameters<typeof limit>[0];
    };
    // New input is what counts: input the provider replayed from its cache is subtracted.
    expect(limit(usage(39_999_999, 0))).toBe(false);
    expect(limit(usage(40_000_000, 0))).toBe(true);
    expect(limit(usage(900_000_000, 870_000_000))).toBe(false);
  });

  it("selects eve's in-process sandbox by name, so an image built without Docker still has one", async () => {
    // A production `eve build` with neither Vercel nor Docker records NO sandbox unless the
    // agent names one (node_modules/eve/docs/sandbox/default.mdx). Only a real build shows what
    // it records; what this pins is that the agent's sandbox file names the provider.
    const sandbox = await import("../agent/sandbox.js");
    expect(sandbox.environment.provider).toBe("just-bash");
    expect(typeof sandbox.default).toBe("function");
    expect(Object.getOwnPropertySymbols(sandbox.default).map(String)).toContain("Symbol(eve.sandbox-selector)");
  });

  it("routes through the gateway, not a bare model-id string", async () => {
    const { gatewayModel } = await import("../lib/gateway-provider.js");
    const m = gatewayModel("lares-brain");
    // A bare id string would be a string; the gateway path returns a constructed model object.
    expect(typeof m).not.toBe("string");
  });
});
