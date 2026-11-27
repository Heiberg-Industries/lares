/**
 * The words the voice-learn schedule and the console's Writing style page share about a learning
 * run: each agent's job key and the reason codes a skip is recorded with (`recordRunSkipped`,
 * `schedule-heartbeat.ts`). The schedule writes them; the console turns each into its own plain
 * sentence and, where there is one, a link to the switch or setting that fixes it. Kept here so the
 * two cannot drift apart.
 */

import { scheduleKey } from "./schedule-heartbeat.js";

/** The schedule's name: the second half of every agent's record key. */
export const VOICE_LEARN_SCHEDULE = "voice-learn";

/**
 * The job key one agent records its learning outcomes under: `<agent name>/voice-learn`, the name
 * from the agent's definition. One record PER AGENT, so two chief-of-staff agents on one installation
 * never write over each other's outcome (the last writer used to win, and the page could say Finished
 * while the other agent was still learning). The console reads every agent's record and combines them.
 *
 * Not the heartbeat key: the schedule's heartbeat stays `chief-of-staff/voice-learn` for every agent
 * (pinned by the schedule's conformance test, read by monitoring). An agent whose definition name is
 * `chief-of-staff` (the neutral default) has a record key equal to that heartbeat key; the two live
 * in different tables.
 */
export function voiceLearnJob(agent: string): string {
  return scheduleKey(agent, VOICE_LEARN_SCHEDULE);
}

/** SQL `LIKE` pattern for every agent's record (no wildcard characters in the schedule's name). */
export const VOICE_LEARN_JOBS_LIKE = `%/${VOICE_LEARN_SCHEDULE}`;

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
