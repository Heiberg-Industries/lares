// services/console/lib/meeting-followup-status.ts
//
// Where the meeting follow-up schedule is, for the Meetings page's status line (ADR 0031). Each
// chief-of-staff agent's schedule records its last pass under `<agent name>/meeting-followup`
// (`schedule_run`, written through `@lares/agent-kit/schedule-heartbeat`), with the reason codes in
// `@lares/agent-kit/meeting-followup-outcome`. Combined here as the Writing style page does: a pass
// that is going wins, otherwise the newest outcome, named by the agent's display name.
import type { PoolClient } from "pg";
import { readScheduleRuns, type ScheduleRunRow } from "@lares/agent-kit/schedule-heartbeat";
import { MEETING_FOLLOWUP_SKIPS, meetingFollowupJob } from "@lares/agent-kit/meeting-followup-outcome";
import type { RunState } from "@lares/ui/patterns";
import { pool } from "./db";
import { formatInOwnerTz, homeTz, ownerDayIn } from "./proactivity";
import { notionAgents } from "./notion-agents";
import type { NotionAgent } from "./notion-connection";

export interface FollowupStatusView {
  state: RunState;
  when?: string;
  why?: string;
  fix?: { href: string; label: string };
  /** A pass is going: the page keeps itself up to date. */
  active: boolean;
}

/** A pass silent for this long did not finish (the schedule runs every five minutes). */
export const FOLLOWUP_STALE_MS = 30 * 60_000;

function whenText(at: Date, now: Date, tz: string): string {
  const [day, time] = formatInOwnerTz(at, tz).split(" ");
  return day === ownerDayIn(now, tz) ? `today at ${time}` : `on ${day} at ${time}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const recordAgent = (r: ScheduleRunRow): string => r.job.slice(0, r.job.indexOf("/"));

/** "Checked the meeting notes: 1 follow-up sent, 2 waiting for your approval, …" from a pass's counts. */
export function countsSentence(counts: Record<string, number>): string {
  const parts: string[] = [];
  if (counts.sent) parts.push(`${plural(counts.sent, "follow-up", "follow-ups")} sent`);
  if (counts.waitingForApproval) parts.push(`${plural(counts.waitingForApproval, "follow-up", "follow-ups")} waiting for your approval`);
  if (counts.waitingForSummary) parts.push(`${plural(counts.waitingForSummary, "meeting", "meetings")} waiting for a summary`);
  if (counts.heldBack) parts.push(`${plural(counts.heldBack, "follow-up", "follow-ups")} held back for now (quiet hours or a daily limit)`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return parts.length ? `Checked the meeting notes: ${parts.join(", ")}.` : "Checked the meeting notes: nothing new to follow up.";
}

/** Pure: one outcome out of every agent's, then the words. Null when no agent has recorded one. */
export function followupStatus(runs: readonly ScheduleRunRow[], agents: readonly NotionAgent[], now: Date, tz: string): FollowupStatusView | null {
  const newestFirst = [...runs].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const fresh = (r: ScheduleRunRow) => now.getTime() - (r.startedAt ?? r.updatedAt).getTime() < FOLLOWUP_STALE_MS;
  const run = newestFirst.find((r) => r.state === "running" && fresh(r)) ?? newestFirst[0];
  if (!run) return null;
  const agent = agents.find((a) => a.name === recordAgent(run));
  const named = agent?.displayName ?? "the agent";
  const byWhom = agents.length > 1 ? `By ${named}. ` : "";
  const when = whenText(run.updatedAt, now, tz);
  if (run.state === "running") {
    return fresh(run)
      ? { state: "running", why: "Reading the meeting notes now.", active: true }
      : { state: "failed", when, why: `${byWhom}It stopped before it finished. The agent may have restarted; the next pass tries again.`, active: false };
  }
  if (run.state === "finished") return { state: "finished", when, why: `${byWhom}${countsSentence(run.counts)}`, active: false };
  if (run.state === "failed") return { state: "failed", when, why: `${byWhom}${run.detail ? `The error was: ${run.detail}` : ""}`.trim() || undefined, active: false };
  const agentPage = agent ? `/agents/${encodeURIComponent(agent.name)}` : null;
  switch (run.reason) {
    case MEETING_FOLLOWUP_SKIPS.switchedOff:
      return { state: "skipped", when, why: `Meeting follow-ups are switched off for ${named}.`, ...(agentPage ? { fix: { href: `${agentPage}/edit`, label: "Switch them on in Edit agent" } } : {}), active: false };
    case MEETING_FOLLOWUP_SKIPS.noDelivery:
      return { state: "skipped", when, why: `${named[0]!.toUpperCase()}${named.slice(1)} has nowhere to send follow-ups: the chat it uses is not connected.`, ...(agentPage ? { fix: { href: agentPage, label: "Open the agent" } } : {}), active: false };
    case MEETING_FOLLOWUP_SKIPS.noMeetingsDatabase:
      return { state: "skipped", when, why: "No meetings database is chosen yet. Choose one above.", active: false };
    default:
      return { state: "skipped", when, why: run.detail || undefined, active: false };
  }
}

/** Every chief-of-staff agent's last pass, from one read. Null when it could not be read. */
export async function getFollowupStatus(now: Date = new Date(), db: Pick<PoolClient, "query"> = pool): Promise<FollowupStatusView | null | "unavailable"> {
  try {
    const agents = await notionAgents(db);
    const runs = await readScheduleRuns(db, agents.map((a) => meetingFollowupJob(a.name)));
    return followupStatus(runs, agents, now, homeTz());
  } catch {
    return "unavailable";
  }
}
