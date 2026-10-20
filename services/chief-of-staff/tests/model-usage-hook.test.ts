import { describe, expect, it, vi } from "vitest";
import { makeModelUsage } from "../agent/hooks/model-usage.js";

const ctx = { agent: { name: "fixture-agent" }, session: { id: "s1" } };
const event = (over: Record<string, unknown> = {}) => ({
  type: "step.completed",
  meta: { id: "evt-1", at: "2026-10-01T10:00:00.000Z" },
  data: {
    finishReason: "stop", sequence: 3, stepIndex: 2, turnId: "t1",
    usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, costUsd: 0.01 },
    ...over,
  },
});

describe("the model-usage hook", () => {
  it("records the token counts of a completed step, keyed by the event id", async () => {
    const seen: unknown[] = [];
    await makeModelUsage({ record: (s) => seen.push(s) })["step.completed"](event(), ctx);
    expect(seen).toEqual([{
      eventId: "evt-1", agent: "fixture-agent", sessionId: "s1", turnId: "t1", stepIndex: 2,
      inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, costUsd: 0.01,
      at: "2026-10-01T10:00:00.000Z",
    }]);
  });

  it("still records a step the provider gave no usage for", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await makeModelUsage({ record: (s) => seen.push(s as never) })["step.completed"](event({ usage: undefined }), ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ eventId: "evt-1", inputTokens: undefined, cacheReadTokens: undefined });
  });

  it("skips an event with no id (a stream from before ids were stamped) and malformed events", async () => {
    const seen: unknown[] = [];
    const h = makeModelUsage({ record: (s) => seen.push(s) });
    await h["step.completed"]({ ...event(), meta: {} }, ctx);
    await h["step.completed"]({ type: "step.completed" }, ctx);
    await h["step.completed"](null, ctx);
    expect(seen).toEqual([]);
  });

  it("never throws, and warns once, when recording fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = makeModelUsage({ record: () => { throw new Error("boom"); } });
    await expect(h["step.completed"](event(), ctx)).resolves.toBeUndefined();
    await expect(h["step.completed"](event(), ctx)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
