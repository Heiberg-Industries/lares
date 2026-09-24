/**
 * NOTE: services/crm-intelligence/lib/strength.ts is a temporary byte-for-byte
 * duplicate of this file (its Docker build can't consume workspace packages
 * yet — see plan Task 14). Until that migration runs, any change to weights,
 * thresholds, or math here MUST also be applied there.
 */
/**
 * Pure relationship-strength scoring.
 *
 * Derives two read-only attributes from a person's communication history:
 *   - "Last contacted" — the most recent interaction timestamp.
 *   - "Strength"       — a recency-decayed interaction count, bucketed into
 *                        Attio's six levels.
 *
 * Everything here is pure (no I/O, no clock) so it can be unit-tested with a
 * fixed `now`. The nightly job feeds it interactions fetched from Twenty.
 */

export type Interaction = {
  kind: "email" | "event";
  at: Date;
  /**
   * Salience of this single interaction before recency decay (default 1). Set
   * at mapping time from the channel + direction — a meeting or an inbound
   * reply says more about the relationship than being cc'd. See
   * INTERACTION_WEIGHTS.
   */
  weight?: number;
  /**
   * For emails: `inbound` = they wrote to you, `outbound` = you wrote to them.
   * Meetings leave this unset (a shared event is inherently mutual). Used by
   * `hasReciprocity` to tell relationships apart from one-way broadcasters.
   */
  direction?: "inbound" | "outbound";
};

/**
 * Per-interaction base weights — the "two-way" signal. Tunable constants, not
 * architecture; adjust freely after calibration.
 */
export const INTERACTION_WEIGHTS = {
  /** They emailed you (message participant role 'from') — they engaged back. */
  emailInbound: 1.5,
  /** You emailed them (role 'to'). */
  emailOutbound: 1.0,
  /** You/they were only cc'd or bcc'd — peripheral. */
  emailCc: 0.4,
  /** A shared calendar event — a meeting is a strong, inherently two-way signal. */
  meeting: 3.0,
} as const;

export type StrengthLevel =
  | "NO_CONNECTION"
  | "VERY_WEAK"
  | "WEAK"
  | "GOOD"
  | "STRONG"
  | "VERY_STRONG";

/** Strength levels from weakest to strongest — the canonical order. */
export const STRENGTH_LEVELS: StrengthLevel[] = [
  "NO_CONNECTION",
  "VERY_WEAK",
  "WEAK",
  "GOOD",
  "STRONG",
  "VERY_STRONG",
];

/** Days after which an interaction's weight halves. Shorter = more reactive to
 * silence (good for proactive follow-up triage). */
export const STRENGTH_HALFLIFE_DAYS = 30;

/** Interactions older than this are ignored entirely. */
export const STRENGTH_WINDOW_DAYS = 365;

/**
 * Score thresholds, descending. A score lands in the first bucket whose `min`
 * it meets. Calibrated 2026-06-04 against the live 758-person distribution
 * (positive-score percentiles: p25 0.03 · median 0.26 · p75 0.88 · p90 2.86 ·
 * max 57). Re-tune freely — these are constants, not architecture.
 */
export const STRENGTH_THRESHOLDS: { level: StrengthLevel; min: number }[] = [
  { level: "VERY_STRONG", min: 10 }, // inner circle — daily/active (~4 people)
  { level: "STRONG", min: 3.5 }, // close, recently active
  { level: "GOOD", min: 1.0 }, // solid, regular contact
  { level: "WEAK", min: 0.2 }, // occasional
  { level: "VERY_WEAK", min: 0 }, // barely (any contact in the last year)
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The most recent *past* interaction timestamp, or null if there are none.
 * Future-dated interactions (a scheduled meeting that hasn't happened) are
 * ignored — you haven't actually been in contact yet.
 */
export function computeLastContacted(
  interactions: Interaction[],
  now: Date,
): Date | null {
  let latest: Date | null = null;
  for (const { at } of interactions) {
    if (at.getTime() > now.getTime()) continue;
    if (latest === null || at.getTime() > latest.getTime()) latest = at;
  }
  return latest;
}

/**
 * Recency-decayed interaction count over the trailing window. Each interaction
 * contributes `0.5 ** (ageDays / halflife)`: ~1.0 today, ~0.5 at one half-life,
 * fading toward zero. Frequency and recency collapse into a single number.
 */
export function computeStrengthScore(
  interactions: Interaction[],
  now: Date,
  opts: { halflifeDays?: number; windowDays?: number } = {},
): number {
  const halflife = opts.halflifeDays ?? STRENGTH_HALFLIFE_DAYS;
  const window = opts.windowDays ?? STRENGTH_WINDOW_DAYS;
  let score = 0;
  for (const { at, weight } of interactions) {
    const ageDays = (now.getTime() - at.getTime()) / MS_PER_DAY;
    if (ageDays < 0 || ageDays > window) continue;
    score += (weight ?? 1) * Math.pow(0.5, ageDays / halflife);
  }
  return score;
}

/**
 * Is this a real, two-way relationship — or a one-way broadcaster?
 * True if you've ever emailed them (an outbound email) or shared a meeting.
 * An inbox full of receipts you never reply to (Fiken, no-reply@…) returns
 * false and is dropped from scoring. (Your own identities are excluded
 * separately, by email — reciprocity can't catch those.)
 */
export function hasReciprocity(interactions: Interaction[]): boolean {
  return interactions.some(
    (i) => i.kind === "event" || i.direction === "outbound",
  );
}

/** Bucket a strength score into one of the six levels. */
export function bucketStrength(score: number): StrengthLevel {
  if (score <= 0) return "NO_CONNECTION";
  for (const { level, min } of STRENGTH_THRESHOLDS) {
    if (score >= min) return level;
  }
  return "NO_CONNECTION";
}
