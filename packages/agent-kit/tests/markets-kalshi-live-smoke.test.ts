// Live network smoke (opt-in): confirms Kalshi public read endpoints work WITHOUT auth — the
// assumption Plan 2b deferred. Skipped unless MARKETS_LIVE_SMOKE=1, so CI/offline runs stay green.
// (Gate renamed from TYCHE_LIVE_SMOKE with ORB-189 — the agent is retired, the capability is not.)
//
// The client is handed a fetch explicitly, as every caller now must: on the box that fetch is
// `createTelegramFetch()`, and the global would ignore the proxy and hang against the seal.
import { describe, it, expect } from "vitest";
import { makeKalshiClient } from "../src/markets/kalshi-client.js";

// ORB-214 (5): the old gate name still works, with a nudge — a muscle-memory `TYCHE_LIVE_SMOKE=1`
// used to silently run nothing.
if (process.env.TYCHE_LIVE_SMOKE === "1" && process.env.MARKETS_LIVE_SMOKE !== "1") {
  console.warn("markets live smoke: TYCHE_LIVE_SMOKE is the old name — honoured this once; use MARKETS_LIVE_SMOKE=1");
}
const live = process.env.MARKETS_LIVE_SMOKE === "1" || process.env.TYCHE_LIVE_SMOKE === "1";

describe.skipIf(!live)("Kalshi live read smoke", () => {
  it("lists open events with no auth header", async () => {
    const client = makeKalshiClient({ fetch });
    const events = await client.listEvents("status=open&limit=5");
    expect(Array.isArray(events)).toBe(true);
    if (events.length > 0) {
      expect(typeof events[0].event_ticker).toBe("string");
      const markets = await client.listMarketsForEvent(events[0].event_ticker);
      expect(Array.isArray(markets)).toBe(true);
    }
  }, 30_000);
});
