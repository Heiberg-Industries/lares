// A short-TTL, in-memory cache over the per-market venue quote. marketState uses it to answer with
// LIVE prices on demand without hammering the venues on rapid repeat questions. Read-only: it only
// calls quoteMarket (which itself never writes).
//
// Copied from services/agent-runtime/lib/adapters/tyche/live-quotes.ts (ORB-189 Task 1); the one
// change from that copy is the shape of `listKalshiEvents`, which now takes the TICKER of the row
// being quoted. It used to take nothing, and the kit wired it to a generic
// `GET /events?status=open&limit=100`. Kalshi has thousands of open events, so that page never
// contained the one paired event this row names: `quoteMarket`'s lookup missed EVERY time, the
// Kalshi side came back null, and every card degraded to a single-venue quote carrying a false
// "one venue only — no cross-venue check" caveat — a wrong answer that looked like a correct one.
// The retired survey runner never had the bug because it fetched exactly the paired tickers
// (`market-survey/paired-kalshi-events.ts`); the ticker in this signature is what makes that
// impossible to lose again, and it also removes a wasted 100-event listing per quote.
import type { QuotedMarket } from "./venue-quotes.js";
import type { KalshiEvent } from "./kalshi-parse.js";
import type { MarketRow } from "./types.js";

export interface LiveQuoteDeps {
  quoteMarket(row: MarketRow, kalshiEvents: KalshiEvent[], kalshiUnavailable?: string | null): Promise<QuotedMarket>;
  /** The events for ONE ticker — the row being quoted. MAY THROW: the throw is caught here and
   *  turned into a REASON carried on the quote, so the card can say "Kalshi could not be read
   *  (…)" rather than the false "one venue only". Swallowing it to `[]` at the wiring site is
   *  what made those two cases indistinguishable. */
  listKalshiEvents(ticker: string): Promise<KalshiEvent[]>;
  ttlMs?: number;            // default 45_000
  now?: () => number;        // injectable clock for tests
}

export function makeLiveQuoteCache(deps: LiveQuoteDeps): { get(row: MarketRow): Promise<QuotedMarket> } {
  const ttl = deps.ttlMs ?? 45_000;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; value: QuotedMarket }>();
  return {
    async get(row: MarketRow): Promise<QuotedMarket> {
      const hit = cache.get(row.id);
      if (hit && now() - hit.at < ttl) return hit.value;
      // The row-level degradation decision lives HERE, not at the wiring site: one venue being
      // unreachable makes this row single-venue and SAYS SO — it never sinks the whole quote.
      let kalshiEvents: KalshiEvent[] = [];
      let kalshiUnavailable: string | null = null;
      if (row.kalshiEventTicker) {
        try {
          kalshiEvents = await deps.listKalshiEvents(row.kalshiEventTicker);
        } catch (e) {
          kalshiUnavailable = e instanceof Error ? e.message : String(e);
          console.warn(`markets live-quotes: kalshi read failed for ${row.kalshiEventTicker}`, e);
        }
      }
      const value = await deps.quoteMarket(row, kalshiEvents, kalshiUnavailable);
      cache.set(row.id, { at: now(), value });
      return value;
    },
  };
}
