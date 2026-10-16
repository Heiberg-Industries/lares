/**
 * the durable trace every schedule leaves, generalised from the digest's
 * `recordDigestHeartbeat`.
 *
 * Three outages in one month were invisible to process monitoring: conversation capture
 * stopped for 6 days (container up), the dream cycle reflected on nothing for 6 days (log line
 * healthy), the digest ran nowhere for 10 days (container gone, no log at all). What they share
 * is a durable OUTPUT that stopped aging forward — and nine of the chief of staff's thirteen schedules leave
 * NO output on a quiet pass by design (a brief with nothing to say sends nothing). So the fact
 * that a pass completed is recorded here, whether or not it produced a message.
 *
 * Two rows per slot-based schedule, one per polling schedule:
 *   `<agent>/<schedule>`       — stamped at every pass-complete point (the schedule did its work
 *                                or found nothing to do). Threshold = the schedule's own period
 *                                plus the ≥2× slack the box's Kuma rules require.
 *   `<agent>/<schedule>/tick`  — stamped right after the gate on every tick of a slot-based
 *                                schedule (every completed tick stamps),
 *                                so "the process is alive but this schedule's loop died" is
 *                                caught at the 2 h tick threshold, not at the 26 h pass one.
 * A closed gate stamps NOTHING — that is the ten-day digest shape (`EVE_DIGEST_LIVE=0`), and it
 * must page.
 *
 * The migration's seed list
 * (`sql/001_baseline.sql`) is pinned to the schedule code by
 * `services/chief-of-staff/tests/schedule-heartbeat-conformance.test.ts`, so the string a check greps
 * for cannot drift from the string a schedule writes — the exact drift warned about.
 *
 * A stamp NEVER throws and NEVER hangs the tick: bounded to 5 s, failure is a warning that names
 * the consequence. A heartbeat that fails must never cost the schedule its real work.
 */
import type { Pool } from "pg";

export type HeartbeatDb = Pick<Pool, "query">;

const SEGMENT = /^[a-z0-9-]+$/;
const KEY = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const STAMP_TIMEOUT_MS = 5_000;

function assertKey(key: string): void {
  if (!KEY.test(key)) {
    throw new Error(`schedule-heartbeat: invalid key ${JSON.stringify(key)} — expected "<agent>/<schedule>", lower-case, digits and dashes`);
  }
}

/** `"<agent>/<schedule>"` — agent = agent.json's `name`, schedule = the schedule file's basename. */
export function scheduleKey(agent: string, schedule: string): string {
  if (!SEGMENT.test(agent) || !SEGMENT.test(schedule)) {
    throw new Error(`schedule-heartbeat: invalid key segments ${JSON.stringify(agent)} / ${JSON.stringify(schedule)}`);
  }
  return `${agent}/${schedule}`;
}

/** The row a slot-based schedule stamps on every completed tick. */
export function tickKey(key: string): string {
  assertKey(key);
  return `${key}/tick`;
}

async function stamp(db: HeartbeatDb, row: string, what: "pass" | "tick"): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.query(
        `INSERT INTO heartbeat (agent, updated_at) VALUES ($1, now())
         ON CONFLICT (agent) DO UPDATE SET updated_at = now()`,
        [row],
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${STAMP_TIMEOUT_MS} ms`)), STAMP_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (e) {
    console.warn(
      `schedule-heartbeat: ${what} stamp for ${row} failed — the health check will read this ${what} as missing`,
      e,
    );
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Call at every pass-complete point: the schedule did its work, or found nothing to do. Not
 *  after a configuration warning, a thrown error or a failed send — those are not passes. */
export async function recordSchedulePass(db: HeartbeatDb, key: string): Promise<boolean> {
  assertKey(key);
  return stamp(db, key, "pass");
}

/** Call right after the gate check in a slot-based schedule, every tick. */
export async function recordScheduleTick(db: HeartbeatDb, key: string): Promise<boolean> {
  return stamp(db, tickKey(key), "tick");
}
