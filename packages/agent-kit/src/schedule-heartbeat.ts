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
 *                                plus the ≥2× slack the monitoring rules require.
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

/* ---------------------------------------------------------------------------------------------
 * The outcome record: what the last run of a job did, and why — kept NEXT TO the heartbeat, not
 * instead of it.
 *
 * The heartbeat answers "is this schedule alive?" for monitoring, and its rules above stay exactly
 * as they are: a closed gate still stamps nothing, so a dark schedule still pages. What it never
 * said is what a person in the console needs: the owner asked for a run, and it was skipped
 * because the schedule is switched off, or there is no mailbox, or it failed with a message. Until
 * now those reasons went to the log only. This record is the one place they land, one row per
 * job key (`schedule_run`, sql/041_schedule_run.sql), overwritten by each new outcome:
 *
 *   running  — started (`started_at` is set now)
 *   finished — done, with optional whole-number counts (kept, dropped, …)
 *   failed   — did not finish, with the error message
 *   skipped  — did not start, with a short reason code (lower-case words and dashes) the console
 *              maps to its own wording and link, plus a plain sentence for any other reader
 *
 * No person data: the row is keyed by the job, `agent` is the agent's definition name, and callers
 * must not put an address or a message text into `detail` beyond an error's own message.
 *
 * Same contract as a stamp: it NEVER throws and NEVER hangs the run (bounded to 5 s), and a failed
 * write is a warning. A record that fails must never cost the schedule its real work — and the
 * outcome is written to the log as well, so nothing is lost that was there before.
 * ------------------------------------------------------------------------------------------- */

export type ScheduleRunState = "running" | "finished" | "failed" | "skipped";

export interface ScheduleRunRow {
  job: string;
  agent: string;
  state: ScheduleRunState;
  /** A skip's reason code; empty for the other states. */
  reason: string;
  /** A skip's plain sentence, a failure's message, or a short note on a run. */
  detail: string;
  counts: Record<string, number>;
  /** When the current (or last) run started; null for a skip. */
  startedAt: Date | null;
  /** When this outcome was recorded. */
  updatedAt: Date;
}

const REASON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COUNT_NAME = /^[a-z][a-zA-Z0-9]*$/;
const DETAIL_MAX = 2_000;

/** The agent recording the outcome (its definition name), when the caller knows it. */
export interface RunOutcomeOptions { agent?: string }

function cleanCounts(counts: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(counts ?? {})) {
    if (COUNT_NAME.test(name) && Number.isSafeInteger(value) && value >= 0) out[name] = value;
  }
  return out;
}

async function writeOutcome(
  db: HeartbeatDb, key: string, state: ScheduleRunState,
  fields: { reason?: string; detail?: string; counts?: Record<string, number>; agent?: string },
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const detail = (fields.detail ?? "").slice(0, DETAIL_MAX);
  try {
    await Promise.race([
      db.query(
        // `started_at`: a start sets it, a skip clears it, a finish or failure keeps the start it ends.
        `INSERT INTO schedule_run (job, agent, state, reason, detail, counts, started_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, CASE WHEN $3 = 'running' THEN clock_timestamp() END, clock_timestamp())
         ON CONFLICT (job) DO UPDATE SET
           agent = CASE WHEN EXCLUDED.agent = '' THEN schedule_run.agent ELSE EXCLUDED.agent END,
           state = EXCLUDED.state, reason = EXCLUDED.reason, detail = EXCLUDED.detail, counts = EXCLUDED.counts,
           started_at = CASE EXCLUDED.state WHEN 'running' THEN EXCLUDED.started_at
                                            WHEN 'skipped' THEN NULL
                                            ELSE schedule_run.started_at END,
           updated_at = EXCLUDED.updated_at`,
        [key, fields.agent ?? "", state, fields.reason ?? "", detail, JSON.stringify(cleanCounts(fields.counts))],
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${STAMP_TIMEOUT_MS} ms`)), STAMP_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (e) {
    console.warn(
      `schedule-heartbeat: the ${state} outcome for ${key} could not be recorded — the console will show the previous outcome`,
      e,
    );
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A run started. */
export async function recordRunStarted(db: HeartbeatDb, key: string, opts: RunOutcomeOptions & { detail?: string } = {}): Promise<boolean> {
  assertKey(key);
  return writeOutcome(db, key, "running", { detail: opts.detail, agent: opts.agent });
}

/** A run finished. `counts` are whole numbers ≥ 0 under camelCase names; anything else is dropped. */
export async function recordRunFinished(
  db: HeartbeatDb, key: string, opts: RunOutcomeOptions & { counts?: Record<string, number>; detail?: string } = {},
): Promise<boolean> {
  assertKey(key);
  return writeOutcome(db, key, "finished", { counts: opts.counts, detail: opts.detail, agent: opts.agent });
}

/** A run did not finish. `message` is the error's own message. */
export async function recordRunFailed(db: HeartbeatDb, key: string, message: string, opts: RunOutcomeOptions = {}): Promise<boolean> {
  assertKey(key);
  return writeOutcome(db, key, "failed", { detail: message, agent: opts.agent });
}

/** A run did not start. `reason` is a short code (`switched-off`, `no-mailbox`); `sentence` says
 *  it plainly for any reader that does not know the code. An invalid code is a programming error. */
export async function recordRunSkipped(
  db: HeartbeatDb, key: string, reason: string, sentence: string, opts: RunOutcomeOptions = {},
): Promise<boolean> {
  assertKey(key);
  if (!REASON.test(reason)) throw new Error(`schedule-heartbeat: invalid skip reason ${JSON.stringify(reason)} — lower-case words and dashes`);
  return writeOutcome(db, key, "skipped", { reason, detail: sentence, agent: opts.agent });
}

/** The last recorded outcome of a job, or null when it has none (or the table cannot be read).
 *  The console reads through this, so the row's shape is decided here once. */
export async function readScheduleRun(db: HeartbeatDb, key: string): Promise<ScheduleRunRow | null> {
  assertKey(key);
  const { rows } = await db.query<{
    job: string; agent: string; state: ScheduleRunState; reason: string; detail: string;
    counts: Record<string, unknown> | null; started_at: Date | string | null; updated_at: Date | string;
  }>(
    `SELECT job, agent, state, reason, detail, counts, started_at, updated_at FROM schedule_run WHERE job = $1`,
    [key],
  );
  const r = rows[0];
  if (!r) return null;
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.counts ?? {})) if (typeof v === "number") counts[k] = v;
  return {
    job: r.job, agent: r.agent, state: r.state, reason: r.reason, detail: r.detail, counts,
    startedAt: r.started_at === null ? null : new Date(r.started_at),
    updatedAt: new Date(r.updated_at),
  };
}
