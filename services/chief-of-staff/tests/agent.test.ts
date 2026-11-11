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
vi.mock('@lares/agent-kit/private-console-surface', () => ({ verifyPrivateConsoleModel: async () => undefined, verifyPrivateConsoleSession: async () => false }));
// The resolver reads the stream position off eve's session view, which only a live session has.
// The stand-in view below carries its own position.
vi.mock('eve/events', async (actual) => ({ ...(await actual<typeof import('eve/events')>()), position: (view: { line: number }) => view.line }));
vi.mock('../agent/lib/model-purpose.js', () => ({
  claimModelPurposeForInvocation: async () => undefined,
  prepareModelPurposeInvocation: () => undefined,
}));

type Selection = { model: { modelId?: string }; modelContextWindowTokens: number };
/** The function eve 1.0 calls before every model call: a `defineDynamic()` value keeps it under
 *  this symbol (node_modules/eve/dist/src/dynamic/definition.js). */
const selectorOf = (model: unknown) => Reflect.get(model as object, Symbol.for("eve.dynamic")) as (ctx: unknown) => Promise<Selection>;
/** What eve hands a dynamic model: the session, its latest turn and the session view. */
const modelContext = (sessionId: string, line: number, current: unknown = null, turnId = "turn_0") => ({
  session: { id: sessionId, auth: { current, initiator: null } },
  turn: { id: turnId, status: "running", input: [] },
  view: { line },
});

describe("chief-of-staff agent config", () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chief-of-staff-agent-"));
    keyPath = join(dir, "gateway-key");
    writeFileSync(keyPath, "test-gateway-key\n", "utf8");
    process.env["GATEWAY_KEY_FILE"] = keyPath;
    delete process.env["GATEWAY_URL"];
    delete process.env["AGENT_MODEL"];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["GATEWAY_KEY_FILE"];
    delete process.env["GATEWAY_URL"];
    delete process.env["AGENT_MODEL"];
  });

  it("selects @workflow/world-postgres as the durable workflow world", async () => {
    const agent = await freshAgentConfig();
    expect(agent.experimental?.workflow?.world).toBe("@workflow/world-postgres");
  });

  it("declares no agent-level modelContextWindowTokens — the window travels with the selection", async () => {
    // eve types this key as `never` beside a dynamic model
    // (node_modules/eve/dist/src/shared/agent-definition.d.ts, the dynamic branch of
    // PublicAgentDefinition) because a dynamic model returns metadata with each concrete
    // selection instead. agent-kit's `sessionGatewayModel` supplies the 200k window per call;
    // putting it back here is a compile error, and the reason is this test.
    const agent = await freshAgentConfig();
    expect((agent as { modelContextWindowTokens?: number }).modelContextWindowTokens).toBeUndefined();
  });

  // `model` is dynamic — the definition picks the model per conversation. The chief of staff is
  // the owner's daily driver; every constraint below fails INVISIBLY if it regresses.
  it("the model is one function eve calls per model call, with no events map and no fallback", async () => {
    // eve 1.0's dynamic form. The whole safety argument of this wiring is what that function
    // returns: a constructed provider object, never a model-id string, because eve routes a bare
    // id through the Vercel AI Gateway, past the self-hosted LiteLLM gateway every model call
    // here must use. Prompt caches are per model, and the alias is pinned for the conversation
    // on its first call, so this is still one model per conversation.
    const agent = await freshAgentConfig();
    expect(typeof selectorOf(agent.model)).toBe("function");
    const model = agent.model as { events?: unknown; fallback?: unknown };
    expect(model.events).toBeUndefined();
    expect(model.fallback).toBeUndefined();
    expect(typeof agent.model).not.toBe("string");
  });

  it("pins the declared alias on the first model call and returns a constructed provider, never an id", async () => {
    sessionState.clear();
    const select = selectorOf((await freshAgentConfig()).model);
    const first = await select(modelContext("agent-a-model-test", 3));
    expect(first.model).not.toBeTypeOf("string");
    expect(first.modelContextWindowTokens).toBe(200_000);
    // The env override still wins, and `beforeEach` clears it — but this is spelled out rather
    // than assumed, so the case cannot go red on a machine that exports AGENT_MODEL.
    expect(first.model.modelId).toBe(process.env["AGENT_MODEL"] ?? declaration.model);
    // ...and a later call reuses the pin: same alias, even though the override has changed.
    process.env["AGENT_MODEL"] = "changed-mid-conversation";
    const second = await select(modelContext("agent-a-model-test", 8));
    expect(second.model.modelId).toBe(first.model.modelId);
    const nextTurn = await select(modelContext("agent-a-model-test", 21, null, "turn_1"));
    expect(nextTurn.model.modelId).toBe(first.model.modelId);
  });

  it("keeps ordinary Console chats on the env override but binds custody-tagged turns to the validated definition", async () => {
    sessionState.clear();
    process.env["AGENT_MODEL"] = "ordinary-override";
    const select = selectorOf((await freshAgentConfig()).model);
    const selectFor = (name: string, attributes: Record<string, unknown>) => {
      sessionState.clear(); // eve scopes this state per session; the fixture map is process-wide.
      return select(modelContext(`agent-purpose-${name}`, 1, { attributes }));
    };
    const ordinary = await selectFor("ordinary-console", { lares_member_id: "member-1" });
    expect(ordinary.model.modelId).toBe("ordinary-override");
    const configuredHuman = await selectFor("custody-human", { lares_member_id: "member-1", lares_model_purpose_required: "1" });
    expect(configuredHuman.model.modelId).toBe(declaration.model);
    const configuredResume = await selectFor("custody-resume", { lares_resolver_member_id: "member-1", lares_model_pending_receipt: "p".repeat(43) });
    expect(configuredResume.model.modelId).toBe(declaration.model);
  });

  it("turns every framework default tool away, the delegating agent tool by name as well", async () => {
    const agent = await freshAgentConfig();
    expect(agent.defaultTools).toBe(false);
    expect(agent.tool).toBe(false);
  });

  it("keeps eve's own copy of a finished conversation, private ones included", async () => {
    // Unset, eve 1.0 asks for a private conversation's run data to be deleted when it ends
    // (node_modules/eve/docs/agent-config.md, "Run data retention"). "default" is today's
    // behaviour: the workflow world keeps it.
    const agent = await freshAgentConfig();
    expect(agent.experimental?.workflow?.retention).toBe("default");
  });

  it("states eve's per-conversation token cap in the open, at eve's documented default", async () => {
    const agent = await freshAgentConfig();
    const limit = agent.limits?.sessionUsage;
    if (typeof limit !== "function") throw new Error("limits.sessionUsage is not a function");
    const usage = (inputTokens: number, cacheReadTokens: number) => {
      const window = { inputTokens, cacheReadTokens, cacheWriteTokens: 0, outputTokens: 0 };
      return { window, total: window } as Parameters<typeof limit>[0];
    };
    // New input is what counts: input the provider replayed from its cache is subtracted.
    expect(limit(usage(39_999_999, 0))).toBe(false);
    expect(limit(usage(40_000_000, 0))).toBe(true);
    expect(limit(usage(900_000_000, 870_000_000))).toBe(false);
    expect(limit(usage(900_000_000, 860_000_000))).toBe(true);
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
});
