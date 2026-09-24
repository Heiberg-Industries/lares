// The Kalshi market→probability seam: a MarketSpec → the engine's SourceEstimate.
// Kalshi prices ride inline (parsed into each outcome's laggedPrice), so there is no
// separate price call here — unlike Polymarket. De-vig is the engine's job, not ours.
import { prob, type Probability, type OutcomeId, type SourceEstimate } from "./probability/types.js";
import type { MarketSpec } from "./polymarket-parse.js";

export interface KalshiProducerDeps {
  now?: () => number;
}

export function makeKalshiProducer(deps: KalshiProducerDeps = {}) {
  const now = deps.now ?? (() => Date.now());

  async function estimate(spec: MarketSpec): Promise<SourceEstimate> {
    const raw: Record<OutcomeId, Probability> = {};
    const labels: Record<string, string> = {};
    for (const o of spec.outcomes) {
      if (o.unpriced) continue;            // placeholder leg — keep it out of the book / de-vig
      raw[o.outcomeId] = prob(o.laggedPrice);
      labels[o.outcomeId] = o.label;
    }
    return {
      source: "kalshi",
      raw,
      meta: {
        marketId: spec.marketId,
        question: spec.question,
        kind: spec.kind,
        labels,
        liquidity: spec.liquidity,
        endDateIso: spec.endDateIso,
        // ORB-214 (5): explicit, not the engine's default — this now feeds a user-facing `fair`,
        // and Kalshi's own `mutually_exclusive` flag (default true, kalshi-parse.ts) is the fact.
        mutuallyExclusive: spec.mutuallyExclusive,
        ts: now(),
      },
    };
  }

  return { estimate };
}
