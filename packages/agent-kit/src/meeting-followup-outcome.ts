/**
 * The words the meeting follow-up schedule and the console's Meetings page share about a run: each
 * agent's job key and the reason codes a skip is recorded with (`recordRunSkipped`,
 * `schedule-heartbeat.ts`). The schedule writes them; the console turns each into its own plain
 * sentence and, where there is one, a link to the switch or setting that fixes it. Kept here so the
 * two cannot drift apart (ADR 0031).
 */

import { scheduleKey } from "./schedule-heartbeat.js";

/** The schedule's name: the second half of every agent's record key. */
export const MEETING_FOLLOWUP_SCHEDULE = "meeting-followup";

/**
 * The job key one agent records its follow-up outcomes under: `<agent name>/meeting-followup`, the
 * name from the agent's definition. One record per agent, so two chief-of-staff agents never write
 * over each other's outcome. Not necessarily the heartbeat key: the schedule's heartbeat stays
 * `chief-of-staff/meeting-followup` for every agent, as monitoring reads it.
 */
export function meetingFollowupJob(agent: string): string {
  return scheduleKey(agent, MEETING_FOLLOWUP_SCHEDULE);
}

/** Why a follow-up pass did not run. */
export const MEETING_FOLLOWUP_SKIPS = {
  /** The agent's own meeting follow-up schedule is switched off in its definition. */
  switchedOff: "switched-off",
  /** No place to send to: the chosen door (Slack by default) is not connected. */
  noDelivery: "no-delivery",
  /** No meetings database is chosen on the Meetings page. */
  noMeetingsDatabase: "no-meetings-database",
} as const;

export type MeetingFollowupSkip = (typeof MEETING_FOLLOWUP_SKIPS)[keyof typeof MEETING_FOLLOWUP_SKIPS];

/** The whole-number counts a finished pass records. Every one is optional for a reader: an older
 *  engine may not write them. */
export interface MeetingFollowupCounts {
  /** Follow-ups sent without asking (a series the owner let send on its own). */
  sent?: number;
  /** Follow-ups drafted and waiting for the owner's approval. */
  waitingForApproval?: number;
  /** Recent meetings whose notes have no summary (or no attendees) yet. */
  waitingForSummary?: number;
  /** Ready follow-ups held back for now (quiet hours, daily limit); a later pass sends them. */
  heldBack?: number;
  /** Follow-ups that failed this pass. */
  failed?: number;
}
