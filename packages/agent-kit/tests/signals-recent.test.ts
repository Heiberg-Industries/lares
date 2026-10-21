import { describe, expect, it, vi } from "vitest";
import { createSignalsRecentTool } from "../extension/tools/signals_recent.js";
import { makeSignalsClient, SignalsNotConfiguredError, SignalsUnavailableError, type SignalRow } from "../src/signals-client.js";

import { clearTurn, currentTaint } from "../src/origin-taint.js";

const CTX = {} as never;
const signal: SignalRow = {
  fingerprint: "x", occurrence: 1, kind: "alert", severity: "error", state: "recovered",
  title: "Worker failed", project: "acme", source: "inngest", type: "job", description: null,
  url: null, firstSeen: "2026-09-16T06:00:00Z", lastSeen: "2026-09-16T07:00:00Z", count: 3,
  linearRef: "TASK-999",
};

describe("signals_recent tool", () => {
  it("returns compact cards with count and recovered state", async () => {
    const tool = createSignalsRecentTool({ recent: async () => [signal] });
    const result = await tool.execute({ limit: 50 }, CTX) as { cards: Array<Record<string, unknown>> };
    expect(result.cards).toEqual([{ text: "error · [acme] Worker failed · 2026-09-16T07:00:00Z · TASK-999", count: 3, state: "recovered" }]);
  });

  it("keeps a typed unavailable distinct from an empty list", async () => {
    const unavailable = createSignalsRecentTool({ recent: async () => { throw new SignalsUnavailableError("signal read token is not readable"); } });
    expect(await unavailable.execute({ limit: 50 }, CTX)).toMatchObject({ cards: [], unavailable: "signal read token is not readable" });
    const empty = createSignalsRecentTool({ recent: async () => [] });
    expect(await empty.execute({ limit: 50 }, CTX)).toEqual({ cards: [] });
  });

  it("says plainly that no signal source is configured, without a permanent error", async () => {
    const noUrl = makeSignalsClient(() => ({ tokenFile: "/nonexistent/token", fetch }));
    await expect(noUrl.signalsRecent()).rejects.toBeInstanceOf(SignalsNotConfiguredError);
    const noToken = makeSignalsClient(() => ({ tokenFile: "/nonexistent/token", baseUrl: "https://spine.example.test", fetch }));
    await expect(noToken.signalsRecent()).rejects.toBeInstanceOf(SignalsNotConfiguredError);
    const tool = createSignalsRecentTool({ recent: (q) => noToken.signalsRecent(q) });
    const result = await tool.execute({ limit: 50 }, CTX) as { cards: unknown[]; unavailable: string };
    expect(result.cards).toEqual([]);
    expect(result.unavailable).toMatch(/No signal source is configured/);
  });
});

it("taints provider labels and unavailable responses but refuses private reads before source access", async () => {
  const key={sessionId:"signals-taint",turnId:"one"};
  const ctx={session:{id:key.sessionId,turn:{id:key.turnId}}} as never;
  const recent=vi.fn(async()=>[signal]);const tool=createSignalsRecentTool({recent});
  clearTurn(key);await tool.execute({limit:50},ctx);expect(currentTaint(key)).toBe("third_party");
  clearTurn(key);recent.mockResolvedValueOnce([]);await tool.execute({limit:50},ctx);expect(currentTaint(key)).toBe("third_party");
  clearTurn(key);recent.mockRejectedValueOnce(new Error("unavailable"));await tool.execute({limit:50},ctx);expect(currentTaint(key)).toBe("third_party");
  clearTurn(key);recent.mockClear();
  await expect(tool.execute({limit:50},{session:{auth:{current:{attributes:{lares_member_id:"member"}}}}} as never)).rejects.toThrow("Conversation authority");
  expect(recent).not.toHaveBeenCalled();expect(currentTaint(key)).toBeUndefined();
});
