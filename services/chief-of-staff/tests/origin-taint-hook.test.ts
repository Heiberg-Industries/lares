import { describe, it, expect, beforeEach, vi } from "vitest";
import { currentTaint, resetTaintForTests } from "@lares/agent-kit/origin-taint";
import { makeOriginTaint, TAINTING_TOOLS } from "../agent/hooks/origin-taint.js";

const ctx = { session: { id: "s1" }, channel: { kind: "slack" } } as never;
const key = { sessionId: "s1", turnId: "t1" };
const result = (toolName: string) => ({
  data: { turnId: "t1", sequence: 0, stepIndex: 0, status: "completed", result: { kind: "tool-result", callId: "c1", toolName, output: {} } },
  type: "action.result",
}) as never;

beforeEach(() => resetTaintForTests());

describe("the taint hook", () => {
  it("names every tool that brings back somebody else's words", () => {
    // calendar_list_events is deliberately absent — W3A-s5 moved its classification to the
    // tool's own call site, where the arguments (was a specific calendar named?) are in hand.
    expect([...TAINTING_TOOLS.keys()].sort()).toEqual(
      ["gmail_read", "gmail_search", "read_url"],
    );
  });

  it("taints the turn when a mail read comes back", async () => {
    const h = makeOriginTaint();
    await h.onActionResult(result("gmail_read"), ctx);
    expect(currentTaint(key)).toBe("third_party");
  });

  it("leaves an ordinary tool alone", async () => {
    const h = makeOriginTaint();
    await h.onActionResult(result("deadline_list"), ctx);
    expect(currentTaint(key)).toBeUndefined();
  });

  it("clears the taint when the turn ends", async () => {
    const h = makeOriginTaint();
    await h.onActionResult(result("read_url"), ctx);
    await h.onTurnEnded({ data: { turnId: "t1" }, type: "turn.completed" } as never, ctx);
    expect(currentTaint(key)).toBeUndefined();
  });

  it("clears on a failed turn too", async () => {
    const h = makeOriginTaint();
    await h.onActionResult(result("read_url"), ctx);
    await h.onTurnEnded({ data: { turnId: "t1" }, type: "turn.failed" } as never, ctx);
    expect(currentTaint(key)).toBeUndefined();
  });

  it("clears at the start of a turn, so a leftover entry can never be inherited", async () => {
    const h = makeOriginTaint();
    await h.onActionResult(result("read_url"), ctx);
    await h.onTurnStarted({ data: { turnId: "t1" }, type: "turn.started" } as never, ctx);
    expect(currentTaint(key)).toBeUndefined();
  });

  it("never throws, whatever the event looks like", async () => {
    const h = makeOriginTaint();
    await expect(h.onActionResult({} as never, null as never)).resolves.toBeUndefined();
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
    const ctxOnAnotherTurn = { session: { id: "s1", turn: { id: "t-stale" } }, channel: { kind: "slack" } } as never;
    await h.onActionResult(result("gmail_read"), ctxOnAnotherTurn);
    expect(currentTaint(key)).toBe("third_party");
    expect(currentTaint({ sessionId: "s1", turnId: "t-stale" })).toBeUndefined();
  });

  it("does not reach the next turn of the same session, or another session", async () => {
    const h = makeOriginTaint();
    await h.onActionResult(result("gmail_read"), ctx);
    expect(currentTaint({ sessionId: "s1", turnId: "t2" })).toBeUndefined();
    expect(currentTaint({ sessionId: "s2", turnId: "t1" })).toBeUndefined();
  });

  it("clears only the turn the boundary event names", async () => {
    const h = makeOriginTaint();
    await h.onActionResult(result("gmail_read"), ctx);
    await h.onTurnEnded({ data: { turnId: "t2" }, type: "turn.completed" } as never, ctx);
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
    ["an event with no data", { type: "action.result" }],
    ["an event whose data is not an object", { data: "nope", type: "action.result" }],
    ["a result that is not a tool result", { data: { turnId: "t1", result: { kind: "load-skill" } }, type: "action.result" }],
    ["a tool result with no name", { data: { turnId: "t1", result: { kind: "tool-result", callId: "c1", output: {} } }, type: "action.result" }],
    ["a tool name that is not a string", { data: { turnId: "t1", result: { kind: "tool-result", toolName: 7, output: {} } }, type: "action.result" }],
  ];

  for (const [what, event] of junk) {
    it(`survives ${what} without throwing or tainting`, async () => {
      const h = makeOriginTaint();
      await expect(h.onActionResult(event as never, ctx)).resolves.toBeUndefined();
      expect(currentTaint(key)).toBeUndefined();
    });
  }

  it("survives a context with no session at all, and taints nothing it cannot name", async () => {
    const h = makeOriginTaint();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(h.onActionResult(result("gmail_read"), {} as never)).resolves.toBeUndefined();
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
   * A tool that failed or was rejected still taints. We cannot tell from `action.result` whether
   * a partial body reached the model before the failure, and over-tainting only ever costs a write
   * a trust level it can re-earn next turn.
   */
  it("taints on a failed tool result too — we cannot know what reached the model", async () => {
    const h = makeOriginTaint();
    await h.onActionResult({
      data: { turnId: "t1", sequence: 0, stepIndex: 0, status: "failed", result: { kind: "tool-result", callId: "c1", toolName: "read_url", isError: true, output: {} } },
      type: "action.result",
    } as never, ctx);
    expect(currentTaint(key)).toBe("third_party");
  });
});
