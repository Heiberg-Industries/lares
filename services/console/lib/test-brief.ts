/**
 * "Send a test brief now": the console's half. The owner presses a button next to a connected door;
 * this writes ONE request row into `workflow_jobs`, and the chief of staff's morning-brief schedule
 * claims it within a minute and sends this morning's brief into that door (the agent's half is
 * `services/chief-of-staff/lib/test-brief.ts`). The row is the whole record: the page polls it.
 *
 * Every refusal is a plain sentence. The console checks first so the owner gets a sentence instead
 * of an error in the chat; the agent and Keeper check again, and Keeper's owner-job refusal is the
 * real guard on who pays.
 */
import {
  DOOR_LABEL,
  TEST_BRIEF_DAILY_MAX,
  TEST_BRIEF_STALE_MINUTES,
  TEST_BRIEF_WORKFLOW_TYPE,
  type TestBriefDoor,
  type TestBriefOutcome,
} from "@lares/agent-kit/delivery";
import { ownerJobsMayRun } from "@lares/agent-kit/owner-only-agent";
import { loadSettings } from "@lares/agent-kit/proactivity";
import { pool } from "./db";
import { formatInOwnerTz, ownerDayIn } from "./proactivity";

/** A pending request this old is shown as not picked up (the agent waits out the minutes before
 *  the brief hour, so a healthy pick-up can take about four minutes). */
export const NOT_PICKED_UP_MINUTES = 5;

export const TEST_BRIEF_REFUSALS = {
  notChief: "Only a chief of staff sends a morning brief, so there is nothing to test here.",
  notRunning: "The agent is not running. Start it or apply the waiting changes first.",
  briefOff: "The morning brief is switched off for this agent.",
  shared: "This agent is shared with someone else, or not adopted by you, so it sends no briefs: a brief is always paid by you.",
  busy: "A test brief is already on its way.",
  tooMany: "That is ten test briefs today. Try again tomorrow.",
  unavailable: "Could not ask the agent just now. Reload the page and try again; nothing was sent.",
} as const;

export const doorNotConnected = (door: TestBriefDoor) => `${DOOR_LABEL[door]} is not connected to this agent yet.`;

/** What the page knows about the agent and the door when the button is pressed. */
export interface TestBriefFacts {
  role: string | undefined;
  running: boolean;
  pending: boolean;
  /** The definition's `schedules["morning-brief"].on`; missing means on. */
  morningBriefOn: boolean;
  /** The door reads "Connected": enabled, applied, claimed and nothing waiting. */
  doorConnected: boolean;
  /** Owner jobs may run for this agent (`ownerJobsMayRun`). */
  ownerOnly: boolean;
}

/** The first refusal that applies, in the order the owner can fix them, or null. */
export function testBriefRefusal(door: TestBriefDoor, f: TestBriefFacts): string | null {
  if (f.role !== "chief-of-staff") return TEST_BRIEF_REFUSALS.notChief;
  if (!f.running || f.pending) return TEST_BRIEF_REFUSALS.notRunning;
  if (!f.doorConnected) return doorNotConnected(door);
  if (!f.ownerOnly) return TEST_BRIEF_REFUSALS.shared;
  if (!f.morningBriefOn) return TEST_BRIEF_REFUSALS.briefOff;
  return null;
}

export async function agentIsOwnersAlone(owner: string, agent: string): Promise<boolean> {
  return ownerJobsMayRun(pool, owner, agent);
}

export type AskResult = { ok: true } | { ok: false; message: string };

/**
 * Write the request. ONE guarded insert: refused when a request for this agent is still on its way
 * (pending or running, and not stale), or when ten were asked for in the last 24 hours. A
 * transaction-scoped lock per agent makes two presses at the same moment queue up behind each
 * other, so the guard sees the first one's row.
 */
export async function askForTestBrief(agent: string, owner: string, door: TestBriefDoor): Promise<AskResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${TEST_BRIEF_WORKFLOW_TYPE}:${agent}`]);
    const { rows } = await client.query<{ id: string; busy: boolean; recent: number }>(
      `WITH seen AS (
         SELECT EXISTS(SELECT 1 FROM workflow_jobs WHERE workflow_type=$3 AND agent=$1
                  AND ((status='pending' AND created_at > now() - make_interval(mins => $5))
                    OR (status='running' AND updated_at > now() - make_interval(mins => $5)))) AS busy,
                (SELECT count(*)::int FROM workflow_jobs WHERE workflow_type=$3 AND agent=$1
                  AND created_at > now() - interval '24 hours') AS recent),
       made AS (
         INSERT INTO workflow_jobs (agent, principal, workflow_type, state)
         SELECT $1, $2, $3, $4::jsonb FROM seen WHERE NOT seen.busy AND seen.recent < $6
         RETURNING id)
       SELECT (SELECT id FROM made) AS id, seen.busy, seen.recent FROM seen`,
      [agent, owner, TEST_BRIEF_WORKFLOW_TYPE, JSON.stringify({ kind: "morning-brief", door }), TEST_BRIEF_STALE_MINUTES, TEST_BRIEF_DAILY_MAX],
    );
    await client.query("COMMIT");
    const r = rows[0];
    if (r?.id) return { ok: true };
    if (r?.busy) return { ok: false, message: TEST_BRIEF_REFUSALS.busy };
    return { ok: false, message: TEST_BRIEF_REFUSALS.tooMany };
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, message: TEST_BRIEF_REFUSALS.unavailable };
  } finally {
    client.release();
  }
}

/** The newest request for an agent, as the page shows it. */
export interface TestBriefRow {
  status: string;
  door: string | null;
  result: { outcome?: TestBriefOutcome; sentAt?: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function latestTestBrief(agent: string): Promise<TestBriefRow | null> {
  const { rows } = await pool.query<{ status: string; state: { door?: string } | null; result: TestBriefRow["result"]; created_at: Date; updated_at: Date }>(
    `SELECT status, state, result, created_at, updated_at FROM workflow_jobs
      WHERE workflow_type=$1 AND agent=$2 ORDER BY created_at DESC LIMIT 1`,
    [TEST_BRIEF_WORKFLOW_TYPE, agent],
  );
  const r = rows[0];
  return r ? { status: r.status, door: r.state?.door ?? null, result: r.result, createdAt: r.created_at, updatedAt: r.updated_at } : null;
}

/** Whether do-not-disturb is on for this agent (everywhere, or for this agent). */
export async function dndOn(owner: string, agent: string): Promise<boolean> {
  return (await loadSettings(pool, owner, agent, "*")).dnd;
}

export interface TestBriefView {
  door: TestBriefDoor | null;
  /** Still on its way: the page keeps polling. */
  waiting: boolean;
  text: string;
}

const NOT_SENT: Record<Exclude<TestBriefOutcome, "sent" | "send-unknown">, (door: TestBriefDoor) => string> = {
  "door-not-connected": doorNotConnected,
  "too-slow": () => "Not sent: the brief took too long to prepare, so nothing was sent. Try again.",
  "send-failed": (door) => `Not sent: ${DOOR_LABEL[door]} did not accept it. Check the door above and try again.`,
  "pass-failed": () => "Not sent: something went wrong before it was sent. The agent's log says more.",
};
export const OUTCOME_UNKNOWN = "Outcome unknown. Check the chat; it will not be sent again.";
export const ASKED = "Asked. It arrives within about two minutes.";
export const NOT_PICKED_UP = "The agent did not pick this up, so nothing was sent. It may be stopped, or its schedules switched off on this server.";

const minutesSince = (at: Date, now: Date) => (now.getTime() - at.getTime()) / 60_000;
/** "at 10:42" today on the owner's clock, "on 2026-09-09 at 10:42" on any other day: the console's
 *  own ledger format (`formatInOwnerTz`, `YYYY-MM-DD HH:MM`), so an old line never reads as today's. */
const when = (at: Date, now: Date, tz: string) => {
  const [day, time] = formatInOwnerTz(at, tz).split(" ");
  return day === ownerDayIn(now, tz) ? `at ${time}` : `on ${day} at ${time}`;
};

/** The one status line for the newest request. `tz` is the owner's clock for the time shown. */
export function testBriefView(row: TestBriefRow | null, now: Date, tz: string): TestBriefView | null {
  if (!row) return null;
  const door = row.door === "slack" || row.door === "telegram" ? row.door : null;
  if (!door) return null;
  if (row.status === "pending") {
    return minutesSince(row.createdAt, now) < NOT_PICKED_UP_MINUTES
      ? { door, waiting: true, text: ASKED }
      : { door, waiting: minutesSince(row.createdAt, now) < TEST_BRIEF_STALE_MINUTES, text: NOT_PICKED_UP };
  }
  if (row.status === "running") {
    return minutesSince(row.updatedAt, now) < TEST_BRIEF_STALE_MINUTES
      ? { door, waiting: true, text: ASKED }
      : { door, waiting: false, text: OUTCOME_UNKNOWN };
  }
  const outcome = row.result?.outcome;
  if (row.status === "done" && outcome === "sent") {
    const at = row.result?.sentAt ? new Date(row.result.sentAt) : row.updatedAt;
    return { door, waiting: false, text: `Sent to ${DOOR_LABEL[door]} ${when(at, now, tz)}.` };
  }
  if (outcome === "send-unknown" || !outcome || outcome === "sent") return { door, waiting: false, text: OUTCOME_UNKNOWN };
  const sentence = NOT_SENT[outcome](door);
  return { door, waiting: false, text: sentence.startsWith("Not sent") ? sentence : `Not sent: ${sentence}` };
}
