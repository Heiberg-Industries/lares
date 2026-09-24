// The `markets` adapter capability: a live prediction-market price feed over Polymarket and
// Kalshi, read-only and region-free. This is Tyche's engine, folded into the kit (ORB-189) —
// the agent is retired; the engine is a capability Saga carries.
//
// `makeMarkets(cfg)` wires the whole read path in one call and returns the three verbs the old
// agent grounded every answer on, with their signatures unchanged:
//
//   findMarkets(query)  — search the watchlist by keyword. Never answer "do you have X?" from
//                         memory; this is the check.
//   marketState(idOrLabel) — one market's current state: per-venue ask and de-vigged fair
//                         (only where de-vig is valid), LIVE when the venues are reachable and
//                         the last stored snapshot otherwise. The result's `source` says which.
//   bestBets()          — every outcome with a RECORDED edge, ranked strongest |edge| first.
//                         Always the stored path, never live, so a wide watchlist cannot fan out
//                         into hundreds of serial fetches. Each entry carries `recordedAtIso`.
//
// Two things the caller must get right:
//
//   * `cfg.fetch` — pass `createTelegramFetch()` from `@lares/agent-kit/telegram-fetch`. Node's
//     built-in fetch ignores proxy env vars, so a default fetch works on a laptop and fails only
//     on the sealed box, which is the worst possible place to find out.
//   * `cfg.pool` — `getPool()` from `@lares/agent-kit/db`. The four `tyche_*` tables already
//     exist on the agent box (hand-applied DDL; the box has no auto-migrate).
//
// Only the refresh job writes, and it never posts. `makeMarkets` is read-only end to end; the
// one writer in this package is `makeMarketsRefresh(cfg).refresh(opts)` (./refresh.ts, ORB-214
// item 1) — the nightly watchlist job that discovers by liquidity, retires long-settled rows and
// re-quotes the open ones. It records a MEASUREMENT into `tyche_alert_state` and never an
// announcement: no alert, no card and no post originates in this package, and none can, because
// nothing here is handed a channel. Proactive output goes through the proactivity gate
// (ORB-193), from a schedule, never from a job.
import type { Pool } from "pg";
import { makeMarketsStore } from "./markets-store.js";
import { makeSnapshotsStore } from "./snapshots-store.js";
import { makeEdgeStateStore } from "./edge-state.js";
import { makeGammaClient } from "./polymarket-gamma-client.js";
import { makeClobClient } from "./polymarket-clob-client.js";
import { makePolymarketProducer } from "./polymarket-producer.js";
import { makeKalshiClient } from "./kalshi-client.js";
import { makeKalshiProducer } from "./kalshi-producer.js";
import { makeVenueQuotes } from "./venue-quotes.js";
import { makeLiveQuoteCache } from "./live-quotes.js";
import { makeMarketsRead } from "./read.js";
import { refreshWatchlist, type RefreshOptions, type RefreshReport } from "./refresh.js";
import type { MarketRow } from "./types.js";
import type { KalshiEvent } from "./kalshi-parse.js";

export interface MarketsConfig {
  /** MUST be a proxy-aware fetch on the box — `createTelegramFetch()`. */
  fetch: typeof fetch;
  /** `getPool()` from `@lares/agent-kit/db`. */
  pool: Pool;
  kalshiBase?: string;
  polymarketClobBase?: string;
  polymarketGammaBase?: string;
  /** Live-quote cache TTL; defaults to the cache's own 45s. */
  liveQuoteTtlMs?: number;
  /** Per-request bound on every venue call; defaults to each client's own 8s. `find` can make
   *  ~80 upstream requests in one turn, so an unbounded socket is a turn that never answers. */
  requestTimeoutMs?: number;
}

/** The wiring both entry points share: the three stores, the venue clients, and the live-quote
 *  cache over them. Kept in one place so the read surface and the refresh job cannot end up
 *  quoting through two differently-wired paths. */
function wireMarkets(cfg: MarketsConfig) {
  const markets = makeMarketsStore(cfg.pool);
  const snapshots = makeSnapshotsStore(cfg.pool);
  const alertState = makeEdgeStateStore(cfg.pool);

  const timeoutMs = cfg.requestTimeoutMs;
  const gamma = makeGammaClient({ baseUrl: cfg.polymarketGammaBase, fetch: cfg.fetch, timeoutMs });
  const clob = makeClobClient({ baseUrl: cfg.polymarketClobBase, fetch: cfg.fetch, timeoutMs });
  const kalshi = makeKalshiClient({ baseUrl: cfg.kalshiBase, fetch: cfg.fetch, timeoutMs });

  const pmProducer = makePolymarketProducer({ clob });
  const kalshiProducer = makeKalshiProducer();

  const venueQuotes = makeVenueQuotes({
    getPmEvent: (slug: string) => gamma.getEvent(slug),
    pmEstimate: (spec) => pmProducer.estimate(spec),
    listKalshiMarketsForEvent: (ticker: string) => kalshi.listMarketsForEvent(ticker),
    kalshiEstimate: (spec) => kalshiProducer.estimate(spec),
  });

  const liveQuotes = makeLiveQuoteCache({
    quoteMarket: (row: MarketRow, events: KalshiEvent[], kalshiUnavailable?: string | null) =>
      venueQuotes.quoteMarket(row, events, kalshiUnavailable),
    // BY TICKER, never a listing. `kalshi.listEvents()` is `status=open&limit=100` over a venue
    // with thousands of open events: the paired event is essentially never on that page, so the
    // lookup in venue-quotes.ts missed every time and every card silently degraded to a
    // single-venue quote that then CLAIMED "one venue only — no cross-venue check". This is the
    // retired survey runner's own logic (`market-survey/paired-kalshi-events.ts`), scoped to the
    // one row being quoted. The throw is NOT swallowed here: `makeLiveQuoteCache` catches it and
    // carries the reason onto the quote, so a card can say "Kalshi could not be read (…)" instead
    // of the false "one venue only — no cross-venue check". Catching it here would erase the
    // reason and make an outage indistinguishable from an unpaired market.
    //
    // The shape is CHECKED, not trusted: `getEvent` returns `body.event`, and a 200 whose body
    // carries no `event` (or one with no `event_ticker`) would hand `[undefined]` down to
    // venue-quotes.ts, whose `find` then throws — surfacing to the reader as a caveat reading
    // "Cannot read properties of undefined (reading 'event_ticker')". A venue that answered with
    // nothing usable is an outage, and it should read like one.
    listKalshiEvents: async (ticker: string) => {
      const event = await kalshi.getEvent(ticker);
      if (!event || typeof event.event_ticker !== "string" || event.event_ticker === "") {
        throw new Error(`Kalshi returned no event for ${ticker}`);
      }
      return [event];
    },
    ttlMs: cfg.liveQuoteTtlMs,
  });

  return { markets, snapshots, alertState, gamma, liveQuotes };
}

export function makeMarkets(cfg: MarketsConfig): ReturnType<typeof makeMarketsRead> {
  const { markets, snapshots, alertState, liveQuotes } = wireMarkets(cfg);
  // No emitCard: nothing in this package posts anywhere. bestBets returns its ranking and the
  // caller decides what, if anything, to say.
  return makeMarketsRead({ markets, snapshots, alertState, liveQuotes });
}

/**
 * The watchlist refresh job — the ONE writer in this package (ORB-214 item 1). Same stores as
 * `makeMarkets`, now with their write halves, and the SAME `marketState` a conversation calls, so
 * a nightly re-quote and an answer in chat can never disagree about what a market is worth.
 *
 * The returned object has exactly one member. There is nothing here to post with: no channel, no
 * `initiate`, no card formatter. A refresh is a job, not an initiation — what Saga says about
 * markets goes through the proactivity gate from a schedule, never from this package.
 */
export function makeMarketsRefresh(cfg: MarketsConfig): {
  refresh(opts: RefreshOptions): Promise<RefreshReport>;
} {
  const { markets, snapshots, alertState, gamma, liveQuotes } = wireMarkets(cfg);
  const read = makeMarketsRead({ markets, snapshots, alertState, liveQuotes });
  return {
    refresh: (opts: RefreshOptions) =>
      refreshWatchlist(
        {
          now: () => new Date(),
          listTopByLiquidity: (limit: number) => gamma.listTopByLiquidity(limit),
          markets,
          // The store hands back the new row's id; the job has no use for it and says so in its
          // dep type, so the id is dropped here rather than threaded through a report nobody reads.
          snapshots: { append: async (s) => { await snapshots.append(s); } },
          alertState,
          marketState: (id: string) => read.marketState(id),
        },
        opts,
      ),
  };
}

export { makeMarketsRead } from "./read.js";
export {
  refreshWatchlist,
  REFRESH_QUOTE_MAX,
  RETIRE_AFTER_DAYS,
  type RefreshDeps,
  type RefreshOptions,
  type RefreshReport,
} from "./refresh.js";
export { makeMarketsStore } from "./markets-store.js";
export { makeSnapshotsStore } from "./snapshots-store.js";
export { makeEdgeStateStore } from "./edge-state.js";
export { makeLiveQuoteCache } from "./live-quotes.js";
export { makeVenueQuotes, type QuotedMarket, type VenueQuoteDeps } from "./venue-quotes.js";
export { canonicalMarketId } from "./canonical-id.js";
export { makeGammaClient } from "./polymarket-gamma-client.js";
export { makeClobClient } from "./polymarket-clob-client.js";
export { makePolymarketProducer, discoverCandidateEvents } from "./polymarket-producer.js";
export { parseEvent, parseBinaryMarket, type MarketSpec, type OutcomeSpec, type GammaEvent, type GammaMarket } from "./polymarket-parse.js";
export { makeKalshiClient } from "./kalshi-client.js";
export { makeKalshiProducer } from "./kalshi-producer.js";
export { parseKalshiEvent, type KalshiEvent, type KalshiMarket } from "./kalshi-parse.js";
export { deVig, normalizeSource, combineSources, computeDivergence, computeDispersion, computeConsistency } from "./probability/engine.js";
export { prob, type Probability, type OutcomeId, type SourceId, type SourceEstimate, type NormalizedSource } from "./probability/types.js";
export { isPlaceholderQuote, PLACEHOLDER_ASK } from "./probability/placeholder.js";
export type * from "./types.js";
