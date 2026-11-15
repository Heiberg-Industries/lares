import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseDefinition } from "@lares/agent-kit/definition";
import { currentTaint, resetTaintForTests } from "@lares/agent-kit/origin-taint";
import { makeOriginTaint, TAINTING_TOOLS } from "../agent/hooks/origin-taint.js";

import { eveSession } from "../../../packages/agent-kit/tests/helpers/eve-session.js";

const key = { sessionId: "s1", turnId: "t1" };
/** A real eve session view in which `toolName` was called and has just settled; returns the `call.settled` event and the context a hook gets. */
function settled(toolName: string, output: unknown = {}, outcome = "completed", kind = "tool") {
  const s = eveSession("t1");
  s.call("c1", toolName, {}, kind);
  const event = s.settleCall("c1", outcome, output);
  return { event: event as never, ctx: { session: { id: "s1" }, channel: { kind: "slack" }, view: s.view } as never };
}
const ctx = { session: { id: "s1" }, channel: { kind: "slack" } } as never;
const result = (toolName: string) => settled(toolName);
const turnEnd = (turnId: unknown, outcome = "completed") => ({ type: "turn.settled", data: { turnId, outcome }, scope: { turnId } }) as never;

beforeEach(() => resetTaintForTests());

describe("the taint hook", () => {
  it("names every tool that brings back somebody else's words", () => {
    // calendar_list_events is deliberately absent — its classification lives at the
    // tool's own call site, where the arguments (was a specific calendar named?) are in hand.
    expect([...TAINTING_TOOLS.keys()].sort()).toEqual(
      ["gmail_read", "gmail_search", "read_url"],
    );
  });

  it("taints the turn when a mail read comes back", async () => {
    const h = makeOriginTaint();
    { const r = result("gmail_read"); await h.onCallSettled(r.event, r.ctx); }
    expect(currentTaint(key)).toBe("third_party");
  });

  it("leaves an ordinary tool alone", async () => {
    const h = makeOriginTaint();
    { const r = result("deadline_list"); await h.onCallSettled(r.event, r.ctx); }
    expect(currentTaint(key)).toBeUndefined();
  });

  it("clears the taint when the turn settles", async () => {
    const h = makeOriginTaint();
    { const r = result("read_url"); await h.onCallSettled(r.event, r.ctx); }
    await h.onTurnEnded(turnEnd("t1"), ctx);
    expect(currentTaint(key)).toBeUndefined();
  });

  it("clears on a failed turn too (turn.settled, whatever its outcome)", async () => {
    const h = makeOriginTaint();
    { const r = result("read_url"); await h.onCallSettled(r.event, r.ctx); }
    await h.onTurnEnded(turnEnd("t1", "failed"), ctx);
    expect(currentTaint(key)).toBeUndefined();
  });

  it("clears at the start of a turn, so a leftover entry can never be inherited", async () => {
    const h = makeOriginTaint();
    { const r = result("read_url"); await h.onCallSettled(r.event, r.ctx); }
    await h.onTurnStarted({ data: { turnId: "t1" }, type: "turn.started" } as never, ctx);
    expect(currentTaint(key)).toBeUndefined();
  });

  it("never throws, whatever the event looks like", async () => {
    const h = makeOriginTaint();
    await expect(h.onCallSettled({} as never, null as never)).resolves.toBeUndefined();
    await expect(h.onTurnEnded({ data: {} } as never, ctx)).resolves.toBeUndefined();
  });
});

/**
 * PROPERTY 1, at the hook seam — the taint lands on the turn the EVENT names, not on whatever
 * turn the context happens to be sitting on, and it lands on nobody else's turn.
 */
describe("the hook taints exactly one turn", () => {
  it("keys on the event's turn id, not the context's", async () => {
    const h = makeOriginTaint();
    const r = settled("gmail_read");
    const ctxOnAnotherTurn = { ...(r.ctx as object), session: { id: "s1", turn: { id: "t-stale" } } } as never;
    await h.onCallSettled(r.event, ctxOnAnotherTurn);
    expect(currentTaint(key)).toBe("third_party");
    expect(currentTaint({ sessionId: "s1", turnId: "t-stale" })).toBeUndefined();
  });

  it("does not reach the next turn of the same session, or another session", async () => {
    const h = makeOriginTaint();
    { const r = result("gmail_read"); await h.onCallSettled(r.event, r.ctx); }
    expect(currentTaint({ sessionId: "s1", turnId: "t2" })).toBeUndefined();
    expect(currentTaint({ sessionId: "s2", turnId: "t1" })).toBeUndefined();
  });

  it("clears only the turn the boundary event names", async () => {
    const h = makeOriginTaint();
    { const r = result("gmail_read"); await h.onCallSettled(r.event, r.ctx); }
    await h.onTurnEnded(turnEnd("t2"), ctx);
    expect(currentTaint(key)).toBe("third_party");
  });
});

/**
 * PROPERTY 3 — a failure inside the hook costs the owner nothing, and costs trust nothing either.
 * eve turns a thrown hook into `turn.failed`; nothing here may throw. And where the hook cannot
 * do its bookkeeping, the write side is what fails closed (`stampFor` with no key is
 * `third_party`), so the hook's job is to be silent and total, never to guess a turn.
 */
describe("the hook is total", () => {
  const junk: ReadonlyArray<readonly [string, unknown]> = [
    ["a null event", null],
    ["an event with no data", { type: "call.settled" }],
    ["an event whose data is not an object", { data: "nope", type: "call.settled" }],
    ["a settled call with no call id", { data: { outcome: "completed" }, type: "call.settled" }],
    ["a call id that is not a string", { data: { callId: 7, outcome: "completed" }, type: "call.settled" }],
    ["a skill load (not a tool result)", settled("deadline_list", {}, "completed", "skill").event],
    ["a task wait (not a tool result)", settled("read_url", {}, "completed", "control").event],
  ];

  for (const [what, event] of junk) {
    it(`survives ${what} without throwing or tainting`, async () => {
      const h = makeOriginTaint();
      // The skill load and the task wait are real events in a view that names them.
      const withView = what.startsWith("a skill") ? settled("deadline_list", {}, "completed", "skill").ctx
        : what.startsWith("a task wait") ? settled("read_url", {}, "completed", "control").ctx : ctx;
      await expect(h.onCallSettled(event as never, withView)).resolves.toBeUndefined();
      expect(currentTaint(key)).toBeUndefined();
    });
  }

  it("survives a context with no session at all, and taints nothing it cannot name", async () => {
    const h = makeOriginTaint();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = result("gmail_read");
    await expect(h.onCallSettled(r.event, { view: (r.ctx as { view: unknown }).view } as never)).resolves.toBeUndefined();
    expect(currentTaint(key)).toBeUndefined();
    warn.mockRestore();
  });

  it("survives every turn-boundary event shape", async () => {
    const h = makeOriginTaint();
    await expect(h.onTurnStarted(null as never, ctx)).resolves.toBeUndefined();
    await expect(h.onTurnEnded(null as never, null as never)).resolves.toBeUndefined();
    await expect(h.onTurnEnded({ data: { turnId: 7 } } as never, ctx)).resolves.toBeUndefined();
  });

  /**
   * A tool that failed or was rejected still taints. We cannot tell from `call.settled` whether
   * a partial body reached the model before the failure, and over-tainting only ever costs a write
   * a trust level it can re-earn next turn.
   */
  it("taints on a failed or rejected tool result too — we cannot know what reached the model", async () => {
    for (const outcome of ["failed", "rejected", "interrupted"]) {
      resetTaintForTests();
      const h = makeOriginTaint();
      const r = settled("read_url", {}, outcome);
      await h.onCallSettled(r.event, r.ctx);
      expect(currentTaint(key), outcome).toBe("third_party");
    }
  });

  it("taints when the view cannot name the call (fail closed: not knowing which tool returned is the unsafe state)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = makeOriginTaint();
    const r = settled("deadline_list");
    const unknownCall = { ...(r.event as object), data: { callId: "never-requested", outcome: "completed" } } as never;
    await h.onCallSettled(unknownCall, r.ctx);
    expect(currentTaint(key)).toBe("third_party");
    resetTaintForTests();
    await h.onCallSettled(r.event, { session: { id: "s1" } } as never); // a context with no view at all
    expect(currentTaint(key)).toBe("third_party");
    warn.mockRestore();
  });

  it("reads the name from the view, so a call made through eve__tool is judged by the entry's own name", async () => {
    // The view records the entry the model reached (here gmail_read), never the wrapper tool.
    const h = makeOriginTaint();
    const r = settled("gmail_read");
    await h.onCallSettled(r.event, r.ctx);
    expect(currentTaint(key)).toBe("third_party");
    resetTaintForTests();
    const wrapper = settled("eve__tool");
    await h.onCallSettled(wrapper.event, wrapper.ctx);
    expect(currentTaint(key)).toBeUndefined(); // an unrelated wrapper name is not itself a reading tool
  });

  it("a paused turn keeps its mark: only turn.settled clears it", async () => {
    const h = makeOriginTaint();
    const r = settled("gmail_read");
    await h.onCallSettled(r.event, r.ctx);
    // A turn parked on an approval card continues with the same turn id: nothing clears it.
    expect(currentTaint(key)).toBe("third_party");
    await h.onTurnEnded(turnEnd("t1", "cancelled"), ctx);
    expect(currentTaint(key)).toBeUndefined();
  });
});

describe("outside tools", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    name: "registry", url: "https://tools.example.org/mcp", description: "Looks up companies.",
    token: true, tools: { allow: ["lookup"], read: ["lookup"] }, ...over,
  });
  const def = (over: Record<string, unknown> = {}) =>
    parseDefinition({
      name: "bookkeeper", display: "Bookkeeper", model: "lares-utility", persona: "agent/instructions.md", role: "chief-of-staff",
      grants: [{ capability: "outside", scope: "write-with-confirm" }], autonomy: { outside: "gated" },
      outsideTools: [entry()], ...over,
    });
  const withDef = (d: ReturnType<typeof def>) => {
    const signals: string[] = [];
    const lookups: Array<string | undefined> = [];
    const h = makeOriginTaint({
      definitionFor: async (id) => { lookups.push(id); return d; },
      signal: async (event, summary) => { signals.push(`${event} | ${summary}`); },
    });
    return { h, signals, lookups };
  };
  const resultWith = (toolName: string, output: unknown, outcome = "completed") => settled(toolName, output, outcome);
  const feed = async (h: ReturnType<typeof makeOriginTaint>, r: ReturnType<typeof settled>) => h.onCallSettled(r.event, r.ctx);

  it("taints the turn when an untrusted connection's tool answers", async () => {
    const { h, lookups } = withDef(def());
    await feed(h, resultWith("registry__lookup", "Acme: 12 employees"));
    expect(currentTaint(key)).toBe("third_party");
    expect(lookups).toEqual(["s1"]);
  });

  it("does not taint for a trusted connection or a look-alike name", async () => {
    const { h } = withDef(def({ outsideTools: [entry({ trusted: true })] }));
    await feed(h, resultWith("registry__lookup", "x"));
    await feed(h, resultWith("registry2__lookup", "x"));
    expect(currentTaint(key)).toBeUndefined();
  });

  it("treats eve__search output as outside text while an untrusted connection is present", async () => {
    const { h } = withDef(def());
    await feed(h, resultWith("eve__search", [{ connection: "registry", tools: [] }]));
    expect(currentTaint(key)).toBe("third_party");
  });

  it("does not even read the definition for ordinary tools", async () => {
    const { h, lookups } = withDef(def());
    await feed(h, resultWith("deadline_list", {}));
    expect(lookups).toEqual([]);
  });

  it("raises one plain signal for a refused key, and stays quiet on a repeat", async () => {
    const { h, signals } = withDef(def());
    const refused = resultWith("eve__search", [{ connection: "registry", needsAuthorization: true }]);
    await feed(h, refused);
    await feed(h, refused);
    expect(signals).toEqual(["outside-tool:bookkeeper:registry:key-refused | bookkeeper: the key for outside tool registry was refused"]);
  });

  it("raises a signal when eve__search reports the server as down (eve's real shape)", async () => {
    const { h, signals } = withDef(def());
    await feed(h, resultWith("eve__search", [{ connection: "registry", description: "x", error: "Failed to load tools for registry" }]));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toContain("did not answer");
  });

  it("raises a signal when eve__search says authorization failed", async () => {
    const { h, signals } = withDef(def());
    await feed(h, resultWith("eve__search", [{ connection: "registry", description: "x", error: "Authorization failed for registry" }]));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toContain("was refused");
  });

  it("raises a signal when the server did not answer", async () => {
    const { h, signals } = withDef(def());
    await feed(h, resultWith("registry__lookup", "", "failed"));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toContain("did not answer");
  });

  it("never throws when the definition cannot be read", async () => {
    const h = makeOriginTaint({ definitionFor: async () => { throw new Error("no definition"); } });
    await expect(feed(h, resultWith("registry__lookup", "x"))).resolves.toBeUndefined();
    expect(currentTaint(key)).toBeUndefined();
  });
});
