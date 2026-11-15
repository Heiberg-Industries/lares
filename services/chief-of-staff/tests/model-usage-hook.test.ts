import { describe, expect, it, vi } from "vitest";
import { emptySessionView, foldEvents } from "eve/events";
import { makeModelUsage } from "../agent/hooks/model-usage.js";

// eve 1.0 events (node_modules/eve/dist/src/protocol/session-events/families/usage.d.ts): usage is the
// `usage.recorded` fact; its turn is `scope.turnId`; its place on the stream is `ctx.position`.
const ctx = (over: Record<string, unknown> = {}) => ({
  agent: { name: "fixture-agent" }, session: { id: "s1" }, position: { line: 7, index: 1 },
  now: new Date("2026-10-01T10:00:00.000Z"), ...over,
});
const event = (over: Record<string, unknown> = {}) => ({
  type: "usage.recorded",
  scope: { turnId: "t1" },
  data: {
    kind: "model", owner: { runId: "run_a" },
    usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, costUsd: 0.01 },
    ...over,
  },
});

describe("the model-usage hook", () => {
  it("is keyed on usage.recorded and on nothing else (the 0.60 step events are gone)", async () => {
    const hook = (await import("../agent/hooks/model-usage.js")).default as { events: Record<string, unknown> };
    expect(Object.keys(hook.events)).toEqual(["usage.recorded"]);
    expect(Object.keys(makeModelUsage({ record: () => undefined }))).toEqual(["usage.recorded"]);
  });

  it("records the token counts of a usage.recorded event, keyed by its place on the stream", async () => {
    const seen: unknown[] = [];
    await makeModelUsage({ record: (s) => seen.push(s) })["usage.recorded"](event(), ctx());
    expect(seen).toEqual([{
      eventId: "s1:7:1", agent: "fixture-agent", sessionId: "s1", turnId: "t1", stepIndex: 0,
      inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, costUsd: 0.01,
      at: "2026-10-01T10:00:00.000Z",
    }]);
  });

  it("gives one event the same key every time it is seen, and two events different keys", async () => {
    const seen: Array<{ eventId: string }> = [];
    const h = makeModelUsage({ record: (s) => seen.push(s) });
    await h["usage.recorded"](event(), ctx());
    await h["usage.recorded"](event(), ctx());
    await h["usage.recorded"](event(), ctx({ position: { line: 7, index: 2 } }));
    await h["usage.recorded"](event(), ctx({ position: { line: 8, index: 1 } }));
    expect(seen.map((s) => s.eventId)).toEqual(["s1:7:1", "s1:7:1", "s1:7:2", "s1:8:1"]);
    expect(new Set(seen.map((s) => s.eventId)).size).toBe(3);
  });

  it("still records usage the provider gave no counts for", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await makeModelUsage({ record: (s) => seen.push(s as never) })["usage.recorded"](event({ usage: undefined }), ctx());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ eventId: "s1:7:1", inputTokens: undefined, cacheReadTokens: undefined });
  });

  it("counts model usage only: other kinds of usage, and events with no place or no data, record nothing", async () => {
    const seen: unknown[] = [];
    const h = makeModelUsage({ record: (s) => seen.push(s) });
    await h["usage.recorded"](event({ kind: "something-eve-adds-later" }), ctx());
    await h["usage.recorded"](event({ kind: undefined }), ctx());
    await h["usage.recorded"](event(), ctx({ position: undefined }));
    await h["usage.recorded"](event(), ctx({ position: { line: 1.5, index: 0 } }));
    await h["usage.recorded"](event(), ctx({ session: {} }));
    await h["usage.recorded"]({ type: "usage.recorded" }, ctx());
    await h["usage.recorded"](null, ctx());
    await h["usage.recorded"](event(), undefined);
    expect(seen).toEqual([]);
  });

  it("does not read tokens from any other event: a turn or session event with usage fields records nothing", async () => {
    const seen: unknown[] = [];
    const h = makeModelUsage({ record: (s) => seen.push(s) }) as Record<string, unknown>;
    // The hook has no handler for these, so eve never calls it; and even if called with one it would not record.
    expect(h["turn.settled"]).toBeUndefined();
    expect(h["session.ended"]).toBeUndefined();
    expect(h["model.settled"]).toBeUndefined();
    await makeModelUsage({ record: (s) => seen.push(s) })["usage.recorded"]({ type: "turn.settled", scope: { turnId: "t1" }, data: { outcome: "completed", usage: { inputTokens: 5 } } }, ctx());
    expect(seen).toEqual([]);
  });

  it("numbers the model runs of a turn from the session view", async () => {
    const run = (runId: string, line: number) => ({
      type: "model.requested", scope: { turnId: "t1", runId },
      data: { runId, owner: { turnId: "t1" } },
      meta: { position: { line, index: 0 }, at: "2026-10-01T10:00:00.000Z" },
    });
    const view = foldEvents(emptySessionView(), [run("run_a", 0), run("run_b", 1)] as never);
    const seen: Array<{ stepIndex: number }> = [];
    const h = makeModelUsage({ record: (s) => seen.push(s) });
    await h["usage.recorded"](event({ owner: { runId: "run_a" } }), ctx({ view }));
    await h["usage.recorded"](event({ owner: { runId: "run_b" } }), ctx({ view, position: { line: 9, index: 0 } }));
    await h["usage.recorded"](event({ owner: { runId: "run_unknown" } }), ctx({ view, position: { line: 10, index: 0 } }));
    await h["usage.recorded"](event({ owner: { callId: "c" } }), ctx({ view, position: { line: 11, index: 0 } }));
    expect(seen.map((s) => s.stepIndex).slice(0, 4)).toEqual([0, 1, 0, 0]);
    // A view that cannot be read never stops the record.
    await h["usage.recorded"](event(), ctx({ view: { broken: true }, position: { line: 12, index: 0 } }));
    expect(seen).toHaveLength(5);
  });

  it("never throws, and warns once, when recording fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = makeModelUsage({ record: () => { throw new Error("boom"); } });
    await expect(h["usage.recorded"](event(), ctx())).resolves.toBeUndefined();
    await expect(h["usage.recorded"](event(), ctx())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("leaves private console conversations out", async () => {
    const seen: unknown[] = [];
    const auth = { authenticator: "lares-console", attributes: { lares_member_id: "m", lares_admission_nonce: "a".repeat(43), lares_purpose: "human" } };
    await makeModelUsage({ record: (s) => seen.push(s) })["usage.recorded"](event(), ctx({ session: { id: "s1", auth: { current: auth, initiator: auth } } }));
    expect(seen).toEqual([]);
  });
});
