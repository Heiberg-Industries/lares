// Pure, domain-agnostic probability-divergence math. No I/O, no zod, no opinion.
import { prob, type Probability, type OutcomeId, type SourceEstimate, type NormalizedSource, type SourceId } from "./types.js";

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Remove the vig: scale raw implied probabilities so they sum to 1.
 *  overround = sum(raw) - 1 (negative ⇒ a sub-100% book = potential arb; see computeConsistency). */
export function deVig(raw: Record<OutcomeId, Probability>): {
  fair: Record<OutcomeId, Probability>;
  overround: number;
} {
  const ids = Object.keys(raw);
  if (ids.length === 0) throw new Error("deVig: market has no outcomes");
  const total = sum(ids.map((id) => raw[id] as number));
  if (total <= 0) throw new Error("deVig: non-positive probability mass");
  const fair: Record<OutcomeId, Probability> = {};
  for (const id of ids) fair[id] = prob((raw[id] as number) / total);
  return { fair, overround: total - 1 };
}

export function normalizeSource(estimate: SourceEstimate): NormalizedSource {
  // Absent flag ⇒ default true (back-compat: existing one-winner sources de-vig as before).
  const me = (estimate.meta as { mutuallyExclusive?: boolean } | undefined)?.mutuallyExclusive ?? true;
  if (!me) {
    // Independent yes/no book: each raw ask already IS the outcome's probability. Do not normalize.
    const fair: Record<OutcomeId, Probability> = {};
    for (const [id, p] of Object.entries(estimate.raw)) fair[id] = p;
    const overround = sum(Object.values(estimate.raw).map((p) => p as number)) - 1;
    return { source: estimate.source, fair, raw: estimate.raw, overround, mutuallyExclusive: false };
  }
  const { fair, overround } = deVig(estimate.raw);
  return { source: estimate.source, fair, raw: estimate.raw, overround, mutuallyExclusive: true };
}

export type CombineMode = "best" | "mean" | "weighted";

export function combineSources(
  sources: NormalizedSource[],
  mode: CombineMode,
  weights: Record<SourceId, number> = {},
): Record<OutcomeId, Probability> {
  if (sources.length === 0) throw new Error("combineSources: no sources");
  const w = (s: NormalizedSource): number => weights[s.source] ?? 1;
  const ids = Array.from(new Set(sources.flatMap((s) => Object.keys(s.fair))));

  if (mode === "best") {
    const top = sources.reduce((a, b) => (w(b) > w(a) ? b : a));
    return { ...top.fair };
  }

  const out: Record<OutcomeId, Probability> = {};
  for (const id of ids) {
    const present = sources.filter((s) => id in s.fair);
    if (mode === "mean") {
      const mean = present.reduce((acc, s) => acc + (s.fair[id] as number), 0) / present.length;
      out[id] = prob(mean);
    } else {
      const wsum = present.reduce((acc, s) => acc + w(s), 0);
      const val = present.reduce((acc, s) => acc + (s.fair[id] as number) * w(s), 0) / wsum;
      out[id] = prob(val);
    }
  }
  return out;
}

export interface OutcomeDivergence {
  outcomeId: OutcomeId;
  subject: Probability;
  anchor: Probability;
  gapPoints: number; // anchor - subject, in probability points
}

export function computeDivergence(args: {
  subject: NormalizedSource;
  anchor: Record<OutcomeId, Probability>;
}): OutcomeDivergence[] {
  const { subject, anchor } = args;
  const ids = Object.keys(subject.fair).filter((id) => id in anchor);
  return ids.map((id) => {
    const s = subject.fair[id] as number;
    const a = anchor[id] as number;
    return { outcomeId: id, subject: subject.fair[id], anchor: anchor[id], gapPoints: a - s };
  });
}

export interface OutcomeDispersion {
  outcomeId: OutcomeId;
  mean: Probability;
  spreadPoints: number; // max - min across sources
  stdevPoints: number;  // population stdev across sources
  bySource: Record<SourceId, Probability>;
}

export function computeDispersion(sources: NormalizedSource[]): OutcomeDispersion[] {
  if (sources.length === 0) return [];
  const ids = Array.from(new Set(sources.flatMap((s) => Object.keys(s.fair))));
  return ids.map((id) => {
    const present = sources.filter((s) => id in s.fair);
    const vals = present.map((s) => s.fair[id] as number);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
    const bySource: Record<SourceId, Probability> = {};
    for (const s of present) bySource[s.source] = s.fair[id];
    return {
      outcomeId: id,
      mean: prob(mean),
      spreadPoints: Math.max(...vals) - Math.min(...vals),
      stdevPoints: Math.sqrt(variance),
      bySource,
    };
  });
}

export interface OutcomeConsistency {
  outcomeIds: OutcomeId[];
  impliedSum: number;      // sum of raw implied probabilities (1 + overround)
  overround: number;       // impliedSum - 1
  arbProfitPoints: number; // max(0, 1 - impliedSum): guaranteed profit from buying every outcome
}

export function computeConsistency(raw: Record<OutcomeId, Probability>): OutcomeConsistency {
  const outcomeIds = Object.keys(raw);
  if (outcomeIds.length === 0) throw new Error("computeConsistency: market has no outcomes");
  const impliedSum = sum(outcomeIds.map((id) => raw[id] as number));
  return {
    outcomeIds,
    impliedSum,
    overround: impliedSum - 1,
    arbProfitPoints: Math.max(0, 1 - impliedSum),
  };
}
