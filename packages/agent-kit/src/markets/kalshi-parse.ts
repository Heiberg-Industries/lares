// Pure parsing of Kalshi event/market shapes into the shared MarketSpec. No I/O.
// Kalshi prices are dollar-strings already in 0..1 (e.g. "0.0510") — Number() them, no /100.
// The backable ASK rides inline as yes_ask_dollars; last_price_dollars is the fallback.
import type { MarketSpec, OutcomeSpec } from "./polymarket-parse.js";
import { isPlaceholderQuote } from "./probability/placeholder.js";

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  yes_sub_title?: string;   // candidate/outcome name
  no_sub_title?: string;
  yes_ask_dollars: string;  // inline live ask, 0..1 dollar-string
  yes_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  liquidity_dollars?: string;
  volume_fp?: string;
  status?: string;
  close_time?: string;
  market_type?: string;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker?: string;
  title: string;
  sub_title?: string;
  category?: string;
  mutually_exclusive?: boolean;
}

/** A finite number from a dollar-string, or undefined if it isn't parseable. */
function dollars(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** A Kalshi event + its binary candidate markets → MarketSpec (one outcome per market, the Yes leg). */
export function parseKalshiEvent(event: KalshiEvent, markets: KalshiMarket[]): MarketSpec {
  if (markets.length === 0) throw new Error(`kalshi parse: ${event.event_ticker} has no markets`);
  const outcomes: OutcomeSpec[] = markets.map((m) => {
    const ask = dollars(m.yes_ask_dollars);
    const bid = dollars(m.yes_bid_dollars);
    const last = dollars(m.last_price_dollars);
    const price = ask ?? last ?? 0;
    const unpriced = isPlaceholderQuote(ask ?? last, bid);
    return { outcomeId: m.ticker, label: (m.yes_sub_title ?? m.title).trim(), tokenId: m.ticker, laggedPrice: price, unpriced };
  });
  const liquidity = markets.reduce((a, m) => a + (dollars(m.liquidity_dollars) ?? 0), 0);
  return {
    marketId: event.event_ticker,
    kind: "event",
    question: event.title.trim(),
    endDateIso: markets[0].close_time,
    liquidity,
    // Kalshi candidate-market bundles are one-winner; explicit flag honored when present.
    mutuallyExclusive: event.mutually_exclusive ?? true,
    outcomes,
  };
}
