// Durable workflow jobs: one row per running multi-step job. Mirrors the reminders
// data-layer style (snake_case columns mapped to camelCase via AS "...").
import type { Queryable } from "./db.js";
export type { Queryable } from "./db.js";

export type WorkflowStatus = "pending" | "running" | "waiting" | "done" | "failed";

export interface NewWorkflowJob {
  agent: string;
  principal?: string | null;
  workflowType: string;
  state?: Record<string, unknown>;
}

export interface EventWorkflowStart {
  agent: string;
  principal?: string | null;
  workflowType: string;
  correlationKey: string;
  state?: Record<string, unknown>;
}

export interface WorkflowJob {
  id: string;
  agent: string;
  principal: string | null;
  workflowType: string;
  state: Record<string, unknown>;
  stepIndex: number;
  status: WorkflowStatus;
  dueAt: Date;
  waitEvent: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

const COLS = `id, agent, principal, workflow_type AS "workflowType", state,
  step_index AS "stepIndex", status, due_at AS "dueAt",
  wait_event AS "waitEvent", result, error`;

export async function createJob(db: Queryable, j: NewWorkflowJob): Promise<WorkflowJob> {
  const { rows } = await db.query<WorkflowJob>(
    `INSERT INTO workflow_jobs (agent, principal, workflow_type, state)
     VALUES ($1,$2,$3,$4) RETURNING ${COLS}`,
    [j.agent, j.principal ?? null, j.workflowType, j.state ?? {}],
  );
  return rows[0];
}

/** The event-trigger primitive: start a workflow for an external event, EXACTLY ONCE.
 *  Atomic via the (agent, workflow_type, correlation_key) partial unique index — safe across
 *  watcher restarts and overlapping polls. started=false means a job already existed. */
export async function startWorkflowForEvent(
  db: Queryable, s: EventWorkflowStart,
): Promise<{ started: boolean; jobId: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO workflow_jobs (agent, principal, workflow_type, state, correlation_key)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (agent, workflow_type, correlation_key) WHERE correlation_key IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [s.agent, s.principal ?? null, s.workflowType, s.state ?? {}, s.correlationKey],
  );
  if (rows[0]) return { started: true, jobId: rows[0].id };
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM workflow_jobs WHERE agent=$1 AND workflow_type=$2 AND correlation_key=$3`,
    [s.agent, s.workflowType, s.correlationKey],
  );
  return { started: false, jobId: existing.rows[0]?.id ?? "" };
}

export async function getJob(db: Queryable, id: string): Promise<WorkflowJob | null> {
  const { rows } = await db.query<WorkflowJob>(
    `SELECT ${COLS} FROM workflow_jobs WHERE id = $1`, [id],
  );
  return rows[0] ?? null;
}

/** Jobs runnable now for ONE agent: pending, or a timed wait whose time has come. Never
 *  event-blocked. Scoped by agent so multiple agents' runners can share this table without
 *  stealing (and failing) each other's jobs — a runner only ever claims its own agent's work. */
export async function dueJobs(db: Queryable, now: Date, agent: string, limit = 20): Promise<WorkflowJob[]> {
  const { rows } = await db.query<WorkflowJob>(
    `SELECT ${COLS} FROM workflow_jobs
      WHERE agent = $1 AND wait_event IS NULL AND status IN ('pending','waiting') AND due_at <= $2
      ORDER BY due_at LIMIT $3`,
    [agent, now, limit],
  );
  return rows;
}

/** Atomically take ownership. Returns true if this caller won the claim. */
export async function claimJob(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE workflow_jobs SET status='running', updated_at=now()
      WHERE id=$1 AND status IN ('pending','waiting')`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function advanceJob(
  db: Queryable, id: string, state: Record<string, unknown>, nextStepIndex: number,
): Promise<void> {
  await db.query(
    `UPDATE workflow_jobs
        SET state=$2, step_index=$3, status='pending', due_at=now(),
            wait_event=NULL, last_step_at=now(), updated_at=now()
      WHERE id=$1`,
    [id, state, nextStepIndex],
  );
}

export async function waitJob(
  db: Queryable, id: string, state: Record<string, unknown>, resumeAt: Date,
): Promise<void> {
  await db.query(
    `UPDATE workflow_jobs
        SET state=$2, status='waiting', due_at=$3, wait_event=NULL,
            last_step_at=now(), updated_at=now()
      WHERE id=$1`,
    [id, state, resumeAt],
  );
}

export async function waitForEventJob(
  db: Queryable, id: string, state: Record<string, unknown>, event: string,
): Promise<void> {
  await db.query(
    `UPDATE workflow_jobs
        SET state=$2, status='waiting', wait_event=$3,
            last_step_at=now(), updated_at=now()
      WHERE id=$1`,
    [id, state, event],
  );
}

/** Wake the job waiting on (agent, event). Returns its id, or null if none waits. */
export async function resumeByEvent(db: Queryable, agent: string, event: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE workflow_jobs
        SET status='pending', due_at=now(), wait_event=NULL, updated_at=now()
      WHERE agent=$1 AND wait_event=$2 AND status='waiting'
      RETURNING id`,
    [agent, event],
  );
  return rows[0]?.id ?? null;
}

export async function completeJob(db: Queryable, id: string, result: Record<string, unknown>): Promise<void> {
  await db.query(
    `UPDATE workflow_jobs SET status='done', result=$2, last_step_at=now(), updated_at=now()
      WHERE id=$1`,
    [id, result],
  );
}

export async function failJob(db: Queryable, id: string, error: string): Promise<void> {
  await db.query(
    `UPDATE workflow_jobs SET status='failed', error=$2, last_step_at=now(), updated_at=now()
      WHERE id=$1`,
    [id, error],
  );
}

/** Read-only: the id of the job currently waiting on (agent, event), or null.
 *  Used to discriminate a workflow confirmation from a conversational one before
 *  any status is flipped — it must not mutate the job. */
export async function findJobWaitingOnEvent(
  db: Queryable, agent: string, event: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM workflow_jobs
      WHERE agent=$1 AND wait_event=$2 AND status='waiting' LIMIT 1`,
    [agent, event],
  );
  return rows[0]?.id ?? null;
}

/** Keep a long-running step alive: bump updated_at so reclaimStalledJobs won't reclaim it. */
export async function heartbeatJob(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE workflow_jobs SET updated_at=now() WHERE id=$1 AND status='running'`, [id]);
}

/** Return jobs stuck in 'running' since before `olderThan` back to 'pending'
 *  (crash recovery — a claimed job whose process died never wrote an outcome).
 *  Returns the number reclaimed. */
export async function reclaimStalledJobs(db: Queryable, olderThan: Date): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE workflow_jobs SET status='pending', updated_at=now()
      WHERE status='running' AND updated_at < $1`,
    [olderThan],
  );
  return rowCount ?? 0;
}
