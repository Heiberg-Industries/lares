// services/agent-runtime/tests/market-survey-venue-quotes.test.ts
// Fixtures use real minimal GammaEvent / KalshiEvent+KalshiMarket shapes so the real
// parseEvent / parseKalshiEvent paths run (not mocked). Copied from fixtures/polymarket/
// event-worldcup.json and fixtures/kalshi/event-worldcup.json (reduced to one outcome each).
import { describe, it, expect } from "vitest";
import { makeVenueQuotes, type VenueQuoteDeps } from "../src/markets/venue-quotes.js";
import type { MarketRow } from "../src/markets/types.js";
import type { GammaEvent } from "../src/markets/polymarket-parse.js";
import type { KalshiEvent, KalshiMarket } from "../src/markets/kalshi-parse.js";
import { prob } from "../src/markets/probability/types.js";

// Minimal but parser-valid GammaEvent (one sub-market, JSON-string fields required by parseEvent).
const minimalGammaEvent: GammaEvent = {
  slug: "wc-pm",
  title: "World Cup Winner",
  negRisk: true,
  endDate: "2026-07-20",
  markets: [
    {
      question: "Will Spain win the 2026 FIFA World Cup?",
      slug: "will-spain-win",
      conditionId: "0xspain",
      groupItemTitle: "Spain",
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.30", "0.70"]',
      clobTokenIds: '["tok-spain-yes", "tok-spain-no"]',
      liquidityNum: 5000,
      active: true,
      closed: false,
    },
  ],
};

// Minimal but parser-valid KalshiEvent + KalshiMarket (one market, yes_ask_dollars required).
const minimalKalshiEvent: KalshiEvent = {
  event_ticker: "KXWC",
  title: "World Cup Winner",
};

const minimalKalshiMarket: KalshiMarket = {
  ticker: "KXWC-ESP",
  event_ticker: "KXWC",
  title: "Will Spain win the 2026 World Cup?",
  yes_sub_title: "Spain",
  yes_ask_dollars: "0.4000",
  last_price_dollars: "0.3800",
  liquidity_dollars: "10000.00",
  close_time: "2026-07-20T15:00:00Z",
};

function deps(over: Partial<VenueQuoteDeps> = {}): VenueQuoteDeps {
  return {
    getPmEvent: async () => [minimalGammaEvent],
    pmEstimate: async () => ({ source: "polymarket", raw: { "tok-spain-yes": prob(0.3) } }),
    listKalshiMarketsForEvent: async () => [minimalKalshiMarket],
    kalshiEstimate: async () => ({ source: "kalshi", raw: { "KXWC-ESP": prob(0.4) } }),
    ...over,
  };
}

const row = (over: Partial<MarketRow> = {}): MarketRow => ({
  id: "m1",
  label: "WC",
  pmMarketId: "wc-pm",
  kalshiEventTicker: "KXWC",
  outcomeAliases: {},
  endDateIso: "2026-07-20T00:00:00.000Z",
  marketType: "mutually_exclusive",
  ...over,
});

describe("makeVenueQuotes", () => {
  it("quotes both venues for a fully-paired row", async () => {
    const vq = makeVenueQuotes(deps());
    const q = await vq.quoteMarket(row(), [minimalKalshiEvent]);
    expect(q.pmEstimate).not.toBeNull();
    expect(q.kalshiEstimate).not.toBeNull();
    expect(q.row.id).toBe("m1");
  });

  it("yields null for a venue whose fetch throws (never fabricates)", async () => {
    const vq = makeVenueQuotes(deps({ getPmEvent: async () => { throw new Error("gamma down"); } }));
    const q = await vq.quoteMarket(row(), [minimalKalshiEvent]);
    expect(q.pmSpec).toBeNull();
    expect(q.pmEstimate).toBeNull();
    expect(q.kalshiEstimate).not.toBeNull(); // other venue unaffected
  });

  it("yields null for a venue with no curated id", async () => {
    const vq = makeVenueQuotes(deps());
    const q = await vq.quoteMarket(row({ kalshiEventTicker: null }), [minimalKalshiEvent]);
    expect(q.kalshiSpec).toBeNull();
    expect(q.kalshiEstimate).toBeNull();
  });

  it("never quotes an event the row did not name — no positional fallback", async () => {
    // The caller (live-quotes.ts) now fetches this row's ticker directly, so a mismatch here
    // means something upstream handed over the wrong event. Falling back to `kalshiEvents[0]`
    // would price a DIFFERENT market against Polymarket's and call the result a cross-venue
    // check; a missing Kalshi side, which the card admits to, is the honest answer.
    let listed = 0;
    const vq = makeVenueQuotes(deps({ listKalshiMarketsForEvent: async () => { listed++; return [minimalKalshiMarket]; } }));
    const q = await vq.quoteMarket(row({ kalshiEventTicker: "KXOTHER" }), [minimalKalshiEvent]);
    expect(q.kalshiSpec).toBeNull();
    expect(q.kalshiEstimate).toBeNull();
    expect(listed).toBe(0);              // and no wasted markets call for an event it does not have
    expect(q.pmEstimate).not.toBeNull(); // the other venue is unaffected
  });
});
