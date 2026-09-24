import { describe, it, expect } from "vitest";
import { makeLiveQuoteCache } from "../src/markets/live-quotes.js";
import type { MarketRow } from "../src/markets/types.js";

const row = (over: Partial<MarketRow> = {}): MarketRow => ({
  id: "wc", label: "WC", pmMarketId: "wc-pm", kalshiEventTicker: null,
  outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive", ...over,
});
// A QuotedMarket-shaped stub; only the fields the cache passes through matter here.
const quoted = (id: string) => ({ row: { id, pmMarketId: "wc-pm", kalshiEventTicker: null, endDateIso: null },
  pmSpec: null, pmEstimate: null, kalshiSpec: null, kalshiEstimate: null, liquidityByOutcome: {} } as any);

describe("makeLiveQuoteCache", () => {
  it("serves a cache hit within TTL — quoteMarket runs once for repeat asks", async () => {
    let calls = 0;
    let t = 1000;
    const cache = makeLiveQuoteCache({
      quoteMarket: async (r: MarketRow) => { calls++; return quoted(r.id); },
      listKalshiEvents: async (_t: string) => [],
      ttlMs: 45000, now: () => t,
    });
    await cache.get(row());
    t = 1000 + 44999;            // still inside TTL
    await cache.get(row());
    expect(calls).toBe(1);       // second ask served from cache
  });

  it("re-fetches after the TTL expires", async () => {
    let calls = 0;
    let t = 1000;
    const cache = makeLiveQuoteCache({
      quoteMarket: async (r: MarketRow) => { calls++; return quoted(r.id); },
      listKalshiEvents: async (_t: string) => [],
      ttlMs: 45000, now: () => t,
    });
    await cache.get(row());
    t = 1000 + 45001;            // past TTL
    await cache.get(row());
    expect(calls).toBe(2);
  });

  it("fetches Kalshi only when the row is kalshi-paired, and BY THAT ROW'S TICKER", async () => {
    // The regression this guards: the ticker used to not cross this seam at all, and the kit
    // wired it to a generic `status=open&limit=100` listing that never contains the paired
    // event — so the Kalshi side silently vanished from every card.
    const asked: string[] = [];
    let passed: unknown = "unset";
    const cache = makeLiveQuoteCache({
      quoteMarket: async (_r: MarketRow, evs: unknown[]) => { passed = evs; return quoted("x"); },
      listKalshiEvents: async (ticker: string) => { asked.push(ticker); return [{ event_ticker: ticker } as any]; },
      now: () => 1,
    });
    await cache.get(row({ id: "pm-only", kalshiEventTicker: null }));
    expect(asked).toEqual([]);
    expect(passed).toEqual([]);  // pm-only → no kalshi fetch, empty array passed through
    await cache.get(row({ id: "paired", kalshiEventTicker: "KXWC" }));
    expect(asked).toEqual(["KXWC"]);           // asked for exactly the row's own event
    expect(passed).toEqual([{ event_ticker: "KXWC" }]);
  });
});
