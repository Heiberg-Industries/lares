// The market→probability seam: a MarketSpec + live CLOB asks → the engine's SourceEstimate.
// raw values are live asks (fallback: Gamma lagged price). De-vig is the engine's job, not ours.
import { prob, type Probability, type OutcomeId, type SourceEstimate } from "./probability/types.js";
import { parseEvent, type MarketSpec, type GammaEvent } from "./polymarket-parse.js";
import { isPlaceholderQuote } from "./probability/placeholder.js";

export interface ClobAskSource {
  fetchAsks(tokenIds: string[]): Promise<Map<string, number>>;
}

export interface ProducerDeps {
  clob: ClobAskSource;
  now?: () => number;
}

export function makePolymarketProducer(deps: ProducerDeps) {
  const now = deps.now ?? (() => Date.now());

  async function estimate(spec: MarketSpec): Promise<SourceEstimate> {
    const tokenIds = spec.outcomes.map((o) => o.tokenId);
    const asks = await deps.clob.fetchAsks(tokenIds);
    const raw: Record<OutcomeId, Probability> = {};
    const labels: Record<string, string> = {};
    for (const o of spec.outcomes) {
      // ORB-214 (7): `unpriced` is a PARSE-time verdict on Gamma's lagged display price. A real
      // live CLOB ask for the same outcome wins over it; the flag only decides whether the lagged
      // price may stand in when no live ask came back. Placeholders are refused either way.
      const live = asks.get(o.tokenId);
      const candidate = live ?? (o.unpriced ? undefined : o.laggedPrice);
      if (candidate === undefined || isPlaceholderQuote(candidate, undefined)) continue;  // placeholder leg — keep it out of the book / de-vig
      raw[o.outcomeId] = prob(candidate);
      labels[o.outcomeId] = o.label;
    }
    return {
      source: "polymarket",
      raw,
      meta: {
        marketId: spec.marketId,
        question: spec.question,
        kind: spec.kind,
        labels,
        liquidity: spec.liquidity,
        endDateIso: spec.endDateIso,
        mutuallyExclusive: spec.mutuallyExclusive, // drives engine de-vig vs raw-ask (independent books)
        ts: now(),
      },
    };
  }

  return { estimate };
}

export interface EventLister {
  listEvents(query?: string): Promise<GammaEvent[]>;
}

export interface DiscoverOpts {
  query?: string;
  minLiquidityUsd?: number;
}

export async function discoverCandidateEvents(lister: EventLister, opts: DiscoverOpts = {}): Promise<MarketSpec[]> {
  const floor = opts.minLiquidityUsd ?? 0;
  const events = await lister.listEvents(opts.query);
  return events.map(parseEvent).filter((s) => (s.liquidity ?? 0) >= floor);
}
