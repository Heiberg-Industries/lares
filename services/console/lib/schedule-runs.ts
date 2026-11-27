// When each of an agent's schedules last ran, and why it did not, for the agent page's Schedules tab.
//
// Two sources, best first (ADR 0031):
//   - the outcome record (`schedule_run`), for a schedule that writes one: running, finished,
//     failed with the message, or skipped with its reason. Today that is voice learning
//     (`<agent name>/voice-learn`).
//   - otherwise the schedule's heartbeat (`heartbeat`, key `<role>/<schedule>`): the last time it
//     finished a pass. It says nothing about why a pass did not happen, and with more than one agent
//     of the same kind it is shared by all of them (monitoring reads it that way).
// A schedule that is switched off is not looked up: a closed gate stamps nothing, so its last time
// would only be stale.
import type { PoolClient } from "pg";
import { readScheduleRuns, scheduleKey, type ScheduleRunRow } from "@lares/agent-kit/schedule-heartbeat";
import { VOICE_LEARN_SCHEDULE, voiceLearnJob } from "@lares/agent-kit/voice-learn-outcome";
import type { RunState } from "@lares/ui/patterns";
import { pool } from "./db";
import { homeTz } from "./proactivity";
import { runWhen } from "./run-when";

/** One schedule's last run, ready for `RunStatus`. */
export interface ScheduleLastRun { state: RunState; when?: string; why?: string }

/** Schedules whose run writes an outcome record, and the record's key for one agent. */
const OUTCOME_JOBS: Record<string, (agent: string) => string> = {
  [VOICE_LEARN_SCHEDULE]: voiceLearnJob,
};

/** A run that has said nothing for this long did not finish. */
export const SCHEDULE_RUN_STALE_MS = 2 * 60 * 60_000;

export interface ScheduleRunFacts {
  /** The outcome record per schedule name, when the schedule writes one and it has a row. */
  outcomes: Record<string, ScheduleRunRow>;
  /** The heartbeat's last pass per schedule name, when it has a row. */
  passes: Record<string, Date>;
  /** More than one agent of this kind: the heartbeat is theirs together. */
  shared: boolean;
}

/** Pure: one schedule's facts become words. null when nothing is known about it. */
export function scheduleLastRun(name: string, f: ScheduleRunFacts, now: Date, tz: string): ScheduleLastRun | null {
  const run = f.outcomes[name];
  if (run) {
    const when = runWhen(run.updatedAt, now, tz);
    if (run.state === "running") {
      if (now.getTime() - (run.startedAt ?? run.updatedAt).getTime() < SCHEDULE_RUN_STALE_MS) return { state: "running" };
      return { state: "failed", when, why: "It stopped before it finished. The agent may have restarted." };
    }
    if (run.state === "finished") return { state: "finished", when };
    if (run.state === "failed") return { state: "failed", when, why: run.detail ? `The error was: ${run.detail}` : undefined };
    return { state: "skipped", when, why: run.detail || undefined };
  }
  const pass = f.passes[name];
  if (pass) return { state: "finished", when: runWhen(pass, now, tz), why: f.shared ? "That is the last pass by any agent of this kind." : undefined };
  return null;
}

/** An invalid key is left out of the read instead of failing it. */
function keyOr(make: () => string): string | null {
  try { return make(); } catch { return null; }
}

/** The tab's read: every schedule that is on, for one agent. Throws when either source cannot be read, so
 *  the tab keeps its saved-setting caveat instead of showing a partial or older answer as the last run. */
/** `started`: whether this agent has ever been started. One that has not has no pass of its own, so the
 *  heartbeat (shared by every agent of its kind) is not shown for it. How many agents share the
 *  heartbeat is counted from the saved definitions that are not retired, started or not. */
export async function readScheduleLastRuns(
  agent: { name: string; role: string; started: boolean },
  on: readonly string[],
  now: Date = new Date(),
  db: Pick<PoolClient, "query"> = pool,
): Promise<Record<string, ScheduleLastRun | null>> {
  const jobs = new Map<string, string>();
  const beats = new Map<string, string>();
  for (const name of on) {
    const job = OUTCOME_JOBS[name] ? keyOr(() => OUTCOME_JOBS[name]!(agent.name)) : null;
    if (job) jobs.set(job, name);
    const beat = agent.started ? keyOr(() => scheduleKey(agent.role, name)) : null;
    if (beat) beats.set(beat, name);
  }
  const [runs, passes, sameKind] = await Promise.all([
    readScheduleRuns(db, [...jobs.keys()]),
    beats.size === 0 ? [] : db.query<{ agent: string; updated_at: Date | string }>(
      "SELECT agent, updated_at FROM heartbeat WHERE agent = ANY($1::text[])", [[...beats.keys()]],
    ).then((r) => r.rows),
    beats.size === 0 ? 0 : db.query<{ n: string | number }>(
      "SELECT count(*) AS n FROM agent_definitions WHERE definition->>'role' = $1 AND status <> 'retired'", [agent.role],
    ).then((r) => Number(r.rows[0]?.n ?? 0)),
  ]);
  const facts: ScheduleRunFacts = { outcomes: {}, passes: {}, shared: sameKind > 1 };
  for (const r of runs) { const name = jobs.get(r.job); if (name) facts.outcomes[name] = r; }
  for (const p of passes) { const name = beats.get(p.agent); if (name) facts.passes[name] = new Date(p.updated_at); }
  const tz = homeTz();
  return Object.fromEntries(on.map((name) => [name, scheduleLastRun(name, facts, now, tz)]));
}
