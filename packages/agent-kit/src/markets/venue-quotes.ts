// Resolve a curated markets-table row into BOTH venues' MarketSpec + SourceEstimate for one cycle.
// Copied from services/agent-runtime/lib/workflows/market-survey/venue-quotes.ts (ORB-189 Task 1),
// unchanged apart from import paths: it is pure composition over the two venue adapters, and it
// is what makes marketState's LIVE path possible.
// All network lives in injected deps (Gamma getEvent, the two producers, Kalshi list calls) so the
// workflow stays testable offline. A venue with no curated id — or whose fetch/parse fails — yields
// null for that venue: the cycle simply skips it. We never fabricate a quote.
//
// The Kalshi EVENT is passed in rather than fetched here, because the caller decides how it was
// obtained: `live-quotes.ts` fetches exactly this row's ticker (`GET /events/{ticker}`), and a
// batch caller could pass a set. What this function will not do either way is quote an event the
// row did not name — the match below is by `event_ticker`, with no positional fallback. Falling
// back to `kalshiEvents[0]` would silently price a DIFFERENT market against Polymarket's, which
// is worse than the missing side it would paper over.
import { parseEvent, type MarketSpec, type GammaEvent } from "./polymarket-parse.js";
import { parseKalshiEvent, type KalshiEvent, type KalshiMarket } from "./kalshi-parse.js";
import type { SourceEstimate } from "./probability/types.js";
import type { MarketRow } from "./types.js";

/** One cycle's worth of quotes for a paired market (both venues, or null if unavailable). */
export interface QuotedMarket {
  row: {
    id: string;
    pmMarketId: string | null;
    kalshiEventTicker: string | null;
    endDateIso: string | null;
  };
  pmSpec: MarketSpec | null;
  pmEstimate: SourceEstimate | null;
  kalshiSpec: MarketSpec | null;
  kalshiEstimate: SourceEstimate | null;
  /** Why the Kalshi side is missing, when it is missing BECAUSE IT COULD NOT BE READ — a failed
   *  fetch, a parse error, an event the venue did not return. null both when Kalshi answered and
   *  when the row was never paired to Kalshi at all.
   *
   *  This distinction is the whole point of the field: "this market is only on one venue" and
   *  "this market is on two venues and we could not reach one of them" are different facts, and
   *  a card that prints the first when the second is true is stating something false about our
   *  own coverage. */
  kalshiUnavailable: string | null;
  /** Liquidity in USD keyed by outcomeId. null = unknown for that outcome. */
  liquidityByOutcome: Record<string, number | null>;
}

export interface VenueQuoteDeps {
  getPmEvent(slug: string): Promise<GammaEvent[]>;
  pmEstimate(spec: MarketSpec): Promise<SourceEstimate>;
  listKalshiMarketsForEvent(ticker: string): Promise<KalshiMarket[]>;
  kalshiEstimate(spec: MarketSpec): Promise<SourceEstimate>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function makeVenueQuotes(deps: VenueQuoteDeps) {
  return {
    /** `kalshiUnavailable` is the CALLER's report: it fetched this row's event and could not get
     *  it. Passing it in rather than re-deriving it here keeps the reason the real one (a 404, a
     *  timeout) instead of a guess made from an empty array. */
    async quoteMarket(
      row: MarketRow,
      kalshiEvents: KalshiEvent[],
      kalshiUnavailable: string | null = null,
    ): Promise<QuotedMarket> {
      let pmSpec: MarketSpec | null = null;
      let pmEstimate: SourceEstimate | null = null;
      if (row.pmMarketId) {
        try {
          const events = await deps.getPmEvent(row.pmMarketId);
          if (events[0]) {
            pmSpec = parseEvent(events[0]);
            pmEstimate = await deps.pmEstimate(pmSpec);
          }
        } catch (e) {
          console.warn(`markets quoteMarket: polymarket fetch failed for ${row.id}`, e);
          pmSpec = null;
          pmEstimate = null;
        }
      }

      let kalshiSpec: MarketSpec | null = null;
      let kalshiEstimate: SourceEstimate | null = null;
      // A row with no Kalshi ticker is not "unavailable" — there is nothing there to read.
      let kalshiProblem: string | null = row.kalshiEventTicker ? kalshiUnavailable : null;
      if (row.kalshiEventTicker && !kalshiProblem) {
        try {
          const ev = kalshiEvents.find((e) => e.event_ticker === row.kalshiEventTicker);
          if (ev) {
            const markets = await deps.listKalshiMarketsForEvent(row.kalshiEventTicker);
            kalshiSpec = parseKalshiEvent(ev, markets);
            kalshiEstimate = await deps.kalshiEstimate(kalshiSpec);
          } else {
            // Not silent: an unmatched ticker is how the whole Kalshi side used to vanish while
            // every card still claimed to be a complete answer.
            kalshiProblem = `no event ${row.kalshiEventTicker} among the ${kalshiEvents.length} returned`;
            console.warn(`markets quoteMarket: ${kalshiProblem} for ${row.id} — quoting polymarket only`);
          }
        } catch (e) {
          console.warn(`markets quoteMarket: kalshi fetch failed for ${row.id}`, e);
          kalshiProblem = message(e);
          kalshiSpec = null;
          kalshiEstimate = null;
        }
      }

      const liquidityByOutcome: Record<string, number | null> = {};
      if (pmSpec) for (const o of pmSpec.outcomes) liquidityByOutcome[o.outcomeId] = pmSpec.liquidity ?? null;
      if (kalshiSpec) for (const o of kalshiSpec.outcomes) liquidityByOutcome[o.outcomeId] = null;

      return {
        row: { id: row.id, pmMarketId: row.pmMarketId, kalshiEventTicker: row.kalshiEventTicker, endDateIso: row.endDateIso },
        pmSpec, pmEstimate, kalshiSpec, kalshiEstimate,
        kalshiUnavailable: kalshiProblem,
        liquidityByOutcome,
      };
    },
  };
}
