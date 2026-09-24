/**
 * Pure rules-based contact scorer: blends numeric signals (warmth, recency, ICP fit)
 * with configurable weights and floors. No I/O, no LLM, no Date — fully deterministic.
 *
 * Ported verbatim from `services/agent-runtime/lib/commercial/score.ts`.
 */

export interface Signals {
  warmth: number | null;
  daysSinceContact: number | null;
  icpFit: number | null;
  triggers?: string[];
}

export interface ScoreConfig {
  weights: {
    warmth: number;
    recency: number;
    icpFit: number;
  };
  floors: {
    warmth: number;
    recencyDays: number;
    icpFit: number;
  };
  recencyHalfLifeDays: number;
}

/** Render a fractional day count as a human string. No I/O, no Date — deterministic. */
export function formatDaysAgo(days: number): string {
  if (days < 1) return "today";
  if (days < 2) return "1d ago";
  return `${Math.round(days)}d ago`;
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  weights: {
    warmth: 1,
    recency: 1,
    icpFit: 1,
  },
  floors: {
    warmth: 50,
    recencyDays: 30,
    icpFit: 50,
  },
  recencyHalfLifeDays: 60,
};

export function scoreContact(
  signals: Signals,
  cfg: ScoreConfig = DEFAULT_SCORE_CONFIG,
): { score: number; passesFloor: boolean; reason: string } {
  // Compute individual contributions (null → 0, excluded from both numerator and denominator)
  let totalWeightedScore = 0;
  let totalWeight = 0;

  // Track contributions for reason
  const contributions: { label: string; value: number; weight: number }[] = [];

  // Warmth contribution
  if (signals.warmth !== null) {
    const contribution = signals.warmth * cfg.weights.warmth;
    totalWeightedScore += contribution;
    totalWeight += cfg.weights.warmth;
    contributions.push({
      label: "warmth",
      value: signals.warmth,
      weight: cfg.weights.warmth,
    });
  }

  // Recency contribution: exponential decay
  if (signals.daysSinceContact !== null) {
    const recencyScore =
      100 * Math.pow(0.5, signals.daysSinceContact / cfg.recencyHalfLifeDays);
    const contribution = recencyScore * cfg.weights.recency;
    totalWeightedScore += contribution;
    totalWeight += cfg.weights.recency;
    contributions.push({
      label: "recency",
      value: recencyScore,
      weight: cfg.weights.recency,
    });
  }

  // ICP Fit contribution
  if (signals.icpFit !== null) {
    const contribution = signals.icpFit * cfg.weights.icpFit;
    totalWeightedScore += contribution;
    totalWeight += cfg.weights.icpFit;
    contributions.push({
      label: "icpFit",
      value: signals.icpFit,
      weight: cfg.weights.icpFit,
    });
  }

  // Compute weighted average score
  const score = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;

  // Floor logic: passesFloor = warmth≥floor OR daysSinceContact≤recencyDays-floor OR icpFit≥floor OR triggers.length>0
  let passesFloor = false;

  if (signals.warmth !== null && signals.warmth >= cfg.floors.warmth) {
    passesFloor = true;
  }

  if (
    signals.daysSinceContact !== null &&
    signals.daysSinceContact <= cfg.floors.recencyDays
  ) {
    passesFloor = true;
  }

  if (signals.icpFit !== null && signals.icpFit >= cfg.floors.icpFit) {
    passesFloor = true;
  }

  if (signals.triggers && signals.triggers.length > 0) {
    passesFloor = true;
  }

  // Reason: the single highest-contributing factor (by weighted contribution)
  let reason = "no signals";
  if (contributions.length > 0) {
    let maxContribution = -Infinity;
    let maxLabel = "";

    for (const c of contributions) {
      const weightedContribution = c.value * c.weight;
      if (weightedContribution > maxContribution) {
        maxContribution = weightedContribution;
        maxLabel = c.label;
      }
    }

    if (maxLabel === "warmth") {
      reason = `warm — ${signals.warmth || 0} points`;
    } else if (maxLabel === "recency") {
      reason = `last contacted ${formatDaysAgo(signals.daysSinceContact || 0)}`;
    } else if (maxLabel === "icpFit") {
      reason = `strong ICP fit — ${signals.icpFit || 0} points`;
    }
  }

  return { score, passesFloor, reason };
}
