import {
  computeLastContacted,
  computeStrengthScore,
  bucketStrength,
  STRENGTH_THRESHOLDS,
  type Interaction,
  type StrengthLevel,
} from "@lares/strength";

/** Minimum score to qualify as GOOD — used for strict comparison in isDormantWarm. */
const GOOD_MIN = STRENGTH_THRESHOLDS.find((t) => t.level === "GOOD")!.min;

/** A scored interaction as stored in the network db. */
export type InteractionRow = {
  channel: "linkedin" | "imessage" | "call" | "instagram" | "facebook" | "slack";
  direction: "inbound" | "outbound" | null;
  at: string; // ISO 8601
};

/**
 * Channel weights for personal-device channels, calibrated relative to the
 * shared model (meeting=3.0, emailInbound=1.5). A call is meeting-like; a
 * text is email-like; LinkedIn messages are slightly lighter than texts.
 * Slack is pinned to the same weight as LinkedIn, deliberately: a work-chat
 * message is lighter than a text (imessage 1.5/1.0) but heavier than an
 * Instagram DM (1.0/0.6) — a calibration choice, not an accident.
 * Tunable constants, not architecture.
 */
export const NETWORK_WEIGHTS = {
  call: 3.0,
  imessageInbound: 1.5,
  imessageOutbound: 1.0,
  linkedinInbound: 1.2,
  linkedinOutbound: 0.8,
  facebookInbound: 1.2,
  facebookOutbound: 0.8,
  instagramInbound: 1.0,
  instagramOutbound: 0.6,
  slackInbound: 1.2,
  slackOutbound: 0.8,
} as const;

/**
 * Network-local reciprocity rule (intentionally differs from @lares/strength's hasReciprocity,
 * which treats any single `kind:"event"` as reciprocal).
 *
 * A contact is reciprocal iff:
 *   - at least 1 outbound NON-call interaction (a real message Bendik sent), OR
 *   - at least 2 call interactions (a genuine call relationship).
 *
 * Rationale: newsletter/broadcast senders accumulate many inbound messages plus the
 * occasional stray answered call, and must not pollute the dormant-warm reactivation queue.
 */
function isReciprocal(rows: InteractionRow[]): boolean {
  const outboundMessages = rows.filter(
    (r) => r.direction === "outbound" && r.channel !== "call",
  );
  if (outboundMessages.length >= 1) return true;
  const calls = rows.filter((r) => r.channel === "call");
  return calls.length >= 2;
}

function toScoringInteraction(r: InteractionRow): Interaction {
  const at = new Date(r.at);
  if (r.channel === "call") return { kind: "event", at, weight: NETWORK_WEIGHTS.call };
  const inbound = r.direction === "inbound";
  let weight: number;
  if (r.channel === "imessage") weight = inbound ? NETWORK_WEIGHTS.imessageInbound : NETWORK_WEIGHTS.imessageOutbound;
  else if (r.channel === "facebook") weight = inbound ? NETWORK_WEIGHTS.facebookInbound : NETWORK_WEIGHTS.facebookOutbound;
  else if (r.channel === "instagram") weight = inbound ? NETWORK_WEIGHTS.instagramInbound : NETWORK_WEIGHTS.instagramOutbound;
  else if (r.channel === "slack") weight = inbound ? NETWORK_WEIGHTS.slackInbound : NETWORK_WEIGHTS.slackOutbound;
  else weight = inbound ? NETWORK_WEIGHTS.linkedinInbound : NETWORK_WEIGHTS.linkedinOutbound;
  return { kind: "email", at, weight, direction: inbound ? "inbound" : "outbound" };
}

export type Pulse = {
  score: number;
  band: StrengthLevel;
  dormantWarm: boolean;
  lastInteractionAt: string | null;
  /** score contribution per channel, for "why is this warm?" answers */
  components: Record<string, number>;
};

export const DORMANT_SILENCE_DAYS = 180;

/**
 * Compute the effective last-contact date: the later of the most recent
 * scored interaction and the CRM-sourced date from Twenty (twenty_last_contacted).
 * The CRM date is the authoritative source when it's more recent than local interactions
 * — e.g. a phone call logged in Twenty but not captured by the local call importer.
 */
function effectiveLastContacted(ints: ReturnType<typeof toScoringInteraction>[], now: Date, twentyLastContacted?: string | null): Date | null {
  const interactionLast = computeLastContacted(ints, now);
  if (!twentyLastContacted) return interactionLast;
  const crmDate = new Date(twentyLastContacted);
  if (isNaN(crmDate.getTime())) return interactionLast;
  if (!interactionLast) return crmDate;
  return crmDate > interactionLast ? crmDate : interactionLast;
}

/**
 * Dormant-warm: there was a real (reciprocal) relationship that scored GOOD
 * or better at the time of the last interaction, and it has been silent for
 * DORMANT_SILENCE_DAYS+. This is the reactivation queue.
 *
 * twentyLastContacted: CRM-sourced date of last contact (ISO string). When provided
 * and more recent than local interactions, it shortens the measured silence window —
 * preventing false positives for contacts Bendik reached out to via channels not
 * captured by local importers (e.g. a phone call logged only in Twenty/CRM).
 */
export function isDormantWarm(rows: InteractionRow[], now: Date, twentyLastContacted?: string | null): boolean {
  const ints = rows.map(toScoringInteraction);
  const last = effectiveLastContacted(ints, now, twentyLastContacted);
  if (!last) return false;
  const silenceDays = (now.getTime() - last.getTime()) / 86_400_000;
  if (silenceDays < DORMANT_SILENCE_DAYS) return false;
  if (!isReciprocal(rows)) return false;
  // Score the history as of the last interaction — "how warm was it then?"
  // Use the interaction-only last date for the peak score, so CRM dates don't
  // artificially inflate the score. The CRM date's role is recency-only.
  const scoreLast = computeLastContacted(ints, now) ?? last;
  // Strict inequality (> GOOD_MIN): a lone weight-1.0 message scored at its own
  // timestamp lands exactly on GOOD_MIN and must not count as "was warm".
  // Heavier single interactions (e.g. one call, weight 3.0) still qualify.
  const peak = computeStrengthScore(ints, scoreLast);
  return peak > GOOD_MIN;
}

export function computePulse(rows: InteractionRow[], now: Date, twentyLastContacted?: string | null): Pulse {
  const ints = rows.map(toScoringInteraction);
  const reciprocal = isReciprocal(rows);
  const score = reciprocal ? computeStrengthScore(ints, now) : 0;
  const last = effectiveLastContacted(ints, now, twentyLastContacted);
  const components: Record<string, number> = {};
  if (reciprocal) {
    for (const channel of ["linkedin", "imessage", "call", "instagram", "facebook", "slack"] as const) {
      const subset = rows.filter((r) => r.channel === channel).map(toScoringInteraction);
      if (subset.length > 0) components[channel] = computeStrengthScore(subset, now);
    }
  }
  return {
    score,
    band: bucketStrength(score),
    dormantWarm: isDormantWarm(rows, now, twentyLastContacted),
    lastInteractionAt: last ? last.toISOString() : null,
    components,
  };
}
