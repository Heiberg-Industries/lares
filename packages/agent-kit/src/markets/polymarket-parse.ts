// Pure parsing of Polymarket Gamma shapes into typed MarketSpecs. No I/O.
// Gamma encodes outcomes/outcomePrices/clobTokenIds as JSON-STRING fields → JSON.parse each.
import { isPlaceholderQuote } from "./probability/placeholder.js";

export interface GammaMarket {
  question: string;
  slug: string;
  conditionId: string;
  outcomes: string;        // JSON string, e.g. "[\"Yes\", \"No\"]"
  outcomePrices: string;   // JSON string, e.g. "[\"0.62\", \"0.38\"]"
  clobTokenIds: string;    // JSON string of uint256 token-id strings
  groupItemTitle?: string; // present on negRisk sub-markets (the outcome name)
  liquidityNum?: number;
  volume24hr?: number;
  endDateIso?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  negRisk?: boolean;
}

export interface GammaEvent {
  slug: string;
  title: string;
  negRisk?: boolean;
  endDate?: string;
  markets: GammaMarket[];
}

export interface OutcomeSpec {
  outcomeId: string;   // canonical key = the CLOB token to price for this outcome
  label: string;       // "Spain" | "Yes" | ...
  tokenId: string;     // CLOB token; side=sell on it = this outcome's backable ask
  laggedPrice: number; // Gamma display price (0..1); fallback when no live ask
  unpriced?: boolean;  // true ⇒ placeholder/stuck quote, excluded from de-vig
}

export interface MarketSpec {
  marketId: string;    // event slug, or binary market conditionId
  kind: "binary" | "event";
  question: string;
  endDateIso?: string;
  liquidity?: number;
  // true ⇒ outcomes are mutually exclusive (one winner; de-vig is valid).
  // false ⇒ independent yes/no bundle (many winners; each raw ask IS its probability, never normalize).
  mutuallyExclusive: boolean;
  outcomes: OutcomeSpec[];
}

function parseJsonArray<T>(s: string): T[] {
  if (typeof s !== "string") throw new Error("expected a JSON-array string, got " + typeof s);
  const v = JSON.parse(s);
  if (!Array.isArray(v)) throw new Error("polymarket parse: expected a JSON array string");
  return v as T[];
}

/** A standalone Yes/No market → one outcome per leg, each keyed by its own token. */
export function parseBinaryMarket(m: GammaMarket): MarketSpec {
  const labels = parseJsonArray<string>(m.outcomes);
  const prices = parseJsonArray<string>(m.outcomePrices).map(Number);
  const tokens = parseJsonArray<string>(m.clobTokenIds);
  if (labels.length !== tokens.length || labels.length !== prices.length) {
    throw new Error(`polymarket parse: ${m.slug} outcomes/prices/tokens length mismatch`);
  }
  const outcomes: OutcomeSpec[] = labels.map((label, i) => {
    const unpriced = isPlaceholderQuote(prices[i], undefined);
    return { outcomeId: tokens[i], label, tokenId: tokens[i], laggedPrice: prices[i], unpriced };
  });
  return { marketId: m.conditionId, kind: "binary", question: m.question, endDateIso: m.endDateIso, liquidity: m.liquidityNum, mutuallyExclusive: true, outcomes };
}

/** A negRisk event (bundle of Yes/No sub-markets) → one outcome per sub-market (the Yes leg). */
export function parseEvent(e: GammaEvent): MarketSpec {
  // Best-effort per sub-market: a sub-market with a missing/invalid clobTokenIds or outcomePrices is
  // skipped and logged, never thrown — so one broken leg can't drop the whole (often large) event.
  // Mirrors the per-chunk best-effort policy one layer down (CLOB pricing), but at the Gamma-parse layer.
  const outcomes: OutcomeSpec[] = [];
  for (const m of e.markets) {
    try {
      const tokens = parseJsonArray<string>(m.clobTokenIds);
      const prices = parseJsonArray<string>(m.outcomePrices).map(Number);
      if (tokens.length === 0 || prices.length === 0) throw new Error("empty sub-market");
      if (tokens.length !== prices.length) throw new Error("tokens/prices length mismatch");
      const unpriced = isPlaceholderQuote(prices[0], undefined);
      outcomes.push({ outcomeId: tokens[0], label: (m.groupItemTitle ?? m.question).trim(), tokenId: tokens[0], laggedPrice: prices[0], unpriced });
    } catch (err) {
      console.warn(`polymarket parseEvent: skipping sub-market ${m.slug ?? "?"} of ${e.slug} (${(err as Error).message})`);
    }
  }
  const liquidity = e.markets.reduce((a, m) => a + (m.liquidityNum ?? 0), 0);
  // negRisk bundles enforce sum-to-1 (one winner); independent yes/no bundles do not.
  return { marketId: e.slug, kind: "event", question: e.title.trim(), endDateIso: e.endDate, liquidity, mutuallyExclusive: e.negRisk === true, outcomes };
}
