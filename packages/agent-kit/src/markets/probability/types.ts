// Pure, vendor-neutral probability types. Everything is probability space (0..1).
// No zod, no I/O — this file lives in core lib/ and must pass tests/neutrality.test.ts.

export type Probability = number & { readonly __brand: "Probability" };
export const prob = (n: number): Probability => n as Probability;

export type SourceId = string;   // 'polymarket' | 'kalshi' | 'model:opta' | 'internal'
export type OutcomeId = string;  // canonical key for one outcome within a question

/** One source's view of a question (mutually exclusive outcomes). `raw` holds implied
 *  probabilities BEFORE de-vig: a model may already sum to ~1; a market sums to >1. */
export interface SourceEstimate {
  source: SourceId;
  raw: Record<OutcomeId, Probability>;
  weight?: number;                 // for 'weighted' combine; default 1
  meta?: Record<string, unknown>;  // engine-opaque (liquidity, ts, model version, ...)
}

export interface NormalizedSource {
  source: SourceId;
  fair: Record<OutcomeId, Probability>; // de-vigged (mutually-exclusive) or raw asks (independent)
  raw: Record<OutcomeId, Probability>;  // kept for transparency/logging
  overround: number;                    // sum(raw) - 1
  mutuallyExclusive: boolean;           // true ⇒ one-winner book (de-vigged); false ⇒ independent yes/no (raw=fair)
}
