/**
 * The words the morning brief and the console's Deadlines page share about the mail scan that finds
 * due notices (the "deadline candidates" the page lists): each agent's job key and the reason codes
 * a skip is recorded with (`recordRunSkipped`, `schedule-heartbeat.ts`). The schedule writes them;
 * the console turns each into its own plain sentence and, where there is one, a link to the setting
 * that fixes it. Kept here so the two cannot drift apart (ADR 0031).
 *
 * The scan is not a schedule of its own: it is the mail pass inside the morning brief
 * (`gatherOpenObligations`, which records each due notice before the brief's selection drops it).
 * So it runs once a day, at the brief's hour, and only when the morning brief runs.
 */

import { scheduleKey } from "./schedule-heartbeat.js";

/** The job's name: the second half of every agent's record key. */
export const DEADLINE_SCAN_SCHEDULE = "deadline-scan";

/** The schedule whose pass carries the scan. Switched off, the scan does not run either. */
export const DEADLINE_SCAN_CARRIER = "morning-brief";

/**
 * The job key one agent records its scan outcomes under: `<agent name>/deadline-scan`, the name from
 * the agent's definition. One record per agent, like voice learning (`voiceLearnJob`), so two
 * chief-of-staff agents never write over each other's outcome. Not a heartbeat key: the morning
 * brief's heartbeat stays `chief-of-staff/morning-brief`.
 */
export function deadlineScanJob(agent: string): string {
  return scheduleKey(agent, DEADLINE_SCAN_SCHEDULE);
}

/** Why a scan did not run. Switched off is not recorded: the console reads it from the definition. */
export const DEADLINE_SCAN_SKIPS = {
  /** No mailbox is chosen for the agent. */
  noMailbox: "no-mailbox",
  /** A mailbox is chosen but cannot be used right now (disconnected, needs permission again, …). */
  mailboxUnusable: "mailbox-unusable",
} as const;

export type DeadlineScanSkip = (typeof DEADLINE_SCAN_SKIPS)[keyof typeof DEADLINE_SCAN_SKIPS];
