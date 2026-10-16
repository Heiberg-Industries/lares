// lib/task-state.ts — per-task checkpoint accessors.
import type { Pool } from "pg";

export async function setTaskState(
  db: Pool,
  sessionId: string,
  state: Record<string, unknown>,
): Promise<void> {
  await db.query(`UPDATE sessions SET task_state = $2 WHERE id = $1`, [sessionId, state]);
}

export async function getTaskState(
  db: Pool,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query(`SELECT task_state FROM sessions WHERE id = $1`, [sessionId]);
  return rows[0]?.task_state ?? null;
}
