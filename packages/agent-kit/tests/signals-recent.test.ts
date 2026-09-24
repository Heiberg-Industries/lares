import { describe, expect, it } from "vitest";
import { createSignalsRecentTool } from "../extension/tools/signals_recent.js";
import { SignalsUnavailableError, type SignalRow } from "../src/signals-client.js";

const CTX = {} as never;
const signal: SignalRow = {
  fingerprint: "x", occurrence: 1, kind: "alert", severity: "error", state: "recovered",
  title: "Worker failed", project: "orakel", source: "inngest", type: "job", description: null,
  url: null, firstSeen: "2026-09-16T06:00:00Z", lastSeen: "2026-09-16T07:00:00Z", count: 3,
  linearRef: "ORB-999",
};

describe("signals_recent tool", () => {
  it("returns compact cards with count and recovered state", async () => {
    const tool = createSignalsRecentTool({ recent: async () => [signal] });
    const result = await tool.execute({ limit: 50 }, CTX) as { cards: Array<Record<string, unknown>> };
    expect(result.cards).toEqual([{ text: "error · [orakel] Worker failed · 2026-09-16T07:00:00Z · ORB-999", count: 3, state: "recovered" }]);
  });

  it("keeps a typed unavailable distinct from an empty list", async () => {
    const unavailable = createSignalsRecentTool({ recent: async () => { throw new SignalsUnavailableError("signal read token is not readable"); } });
    expect(await unavailable.execute({ limit: 50 }, CTX)).toMatchObject({ cards: [], unavailable: "signal read token is not readable" });
    const empty = createSignalsRecentTool({ recent: async () => [] });
    expect(await empty.execute({ limit: 50 }, CTX)).toEqual({ cards: [] });
  });
});
