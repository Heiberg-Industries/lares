/**
 * The words the voice-learn schedule and the console's Writing style page share about a learning
 * run: the job's key and the reason codes a skip is recorded with (`recordRunSkipped`,
 * `schedule-heartbeat.ts`). The schedule writes them; the console turns each into its own plain
 * sentence and, where there is one, a link to the switch or setting that fixes it. Kept here so the
 * two cannot drift apart.
 */

/** The job key. Equal to the schedule's own `HEARTBEAT_KEY` (pinned by the schedule's test). */
export const VOICE_LEARN_JOB = "chief-of-staff/voice-learn";

/** Why a learning run did not start. */
export const VOICE_LEARN_SKIPS = {
  /** The agent's own Voice Learn schedule is switched off in its definition. */
  switchedOff: "switched-off",
  /** Every schedule is switched off on this server (the box-level switch). */
  schedulesOff: "schedules-off",
  /** No mailbox is chosen for the agent. */
  noMailbox: "no-mailbox",
  /** A mailbox is chosen but cannot be used right now (disconnected, needs permission again, …). */
  mailboxUnusable: "mailbox-unusable",
  /** No model for comparing texts (the embedding model) answered. */
  noCompareModel: "no-compare-model",
  /** A learning run was already going; the request is answered by that run. */
  alreadyRunning: "already-running",
} as const;

export type VoiceLearnSkip = (typeof VOICE_LEARN_SKIPS)[keyof typeof VOICE_LEARN_SKIPS];
