/**
 * lib/test-brief.ts - the agent's half of "Send a test brief now": take a request the console wrote
 * into `workflow_jobs`, and write back what happened. The morning brief's own run does the sending
 * (`agent/schedules/morning-brief.ts`), so the brief turn runs under the schedule's identity and is
 * paid as an owner job, exactly like a real brief.
 *
 * Every claim is ONE statement: two ticks can never both take a row. A claimed row is never put
 * back: a test brief is sent at most once, whatever happens after the claim.
 */
import {
  TEST_BRIEF_DAILY_MAX,
  TEST_BRIEF_STALE_MINUTES,
  TEST_BRIEF_WORKFLOW_TYPE,
  isTestBriefDoor,
  type TestBriefDoor,
  type TestBriefOutcome,
} from "@lares/agent-kit/delivery";
import { partsIn } from "./recurrence.js";

export interface TestBriefDb {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface ClaimedTestBrief {
  id: string;
  door: TestBriefDoor;
}

/** Minutes before the morning-brief hour in which no test is claimed: the real brief's minute must
 *  find the schedule idle, and a test claimed now could still be running then. */
export const TEST_BRIEF_QUIET_MINUTES_BEFORE = 3;

/** True unless `now` is minute 0 of the brief hour or one of the three minutes before it, on the
 *  owner's clock. A request asked for then stays pending and is claimed after the hour. */
export function testBriefClaimable(now: Date, tz: string, briefHour: number): boolean {
  const { hour, minute } = partsIn(now, tz);
  const until = (briefHour * 60 - (hour * 60 + minute) + 1440) % 1440;
  return until > TEST_BRIEF_QUIET_MINUTES_BEFORE;
}

/**
 * Claim the oldest fresh request for THIS agent asked by THE owner, if none is running and the
 * agent is still within its daily limit. Returns null when there is nothing to do. A row for another
 * agent, another principal, another workflow type, or older than the stale limit is never touched.
 */
export async function claimTestBrief(db: TestBriefDb, agent: string, owner: string): Promise<ClaimedTestBrief | null> {
  const { rows } = await db.query(
    `UPDATE workflow_jobs SET status='running', step_index=1, last_step_at=now(), updated_at=now()
      WHERE id = (
        SELECT id FROM workflow_jobs
         WHERE workflow_type=$1 AND agent=$2 AND principal=$3 AND status='pending'
           AND created_at > now() - make_interval(mins => $4)
         ORDER BY created_at LIMIT 1
         FOR UPDATE SKIP LOCKED)
        AND NOT EXISTS (SELECT 1 FROM workflow_jobs
         WHERE workflow_type=$1 AND agent=$2 AND status='running'
           AND updated_at > now() - make_interval(mins => $4))
        AND (SELECT count(*) FROM workflow_jobs
         WHERE workflow_type=$1 AND agent=$2 AND created_at > now() - interval '24 hours') <= $5
      RETURNING id, state`,
    [TEST_BRIEF_WORKFLOW_TYPE, agent, owner, TEST_BRIEF_STALE_MINUTES, TEST_BRIEF_DAILY_MAX],
  );
  const row = rows[0] as { id: string; state: { door?: unknown } | null } | undefined;
  if (!row) return null;
  const door = row.state?.door;
  if (!isTestBriefDoor(door)) {
    // Written by something other than the console: never sent, and never claimed again.
    await finishTestBrief(db, row.id, { outcome: "door-not-connected" });
    return null;
  }
  return { id: row.id, door };
}

/** Write the outcome into the claimed row. `sent` is `done`; every other outcome is `failed`. */
export async function finishTestBrief(
  db: TestBriefDb,
  id: string,
  r: { outcome: TestBriefOutcome; door?: TestBriefDoor; sentAt?: string },
): Promise<void> {
  const status = r.outcome === "sent" ? "done" : "failed";
  await db.query(
    `UPDATE workflow_jobs SET status=$2, result=$3::jsonb, error=$4, last_step_at=now(), updated_at=now()
      WHERE id=$1 AND workflow_type=$5 AND status='running'`,
    [id, status, JSON.stringify(r), status === "failed" ? r.outcome : null, TEST_BRIEF_WORKFLOW_TYPE],
  );
}
