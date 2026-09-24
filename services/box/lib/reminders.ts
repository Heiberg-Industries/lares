import type { Pool } from "pg";

export interface NewReminder {
  agent: string;
  owner: string;
  dueAt: Date;
  recurrence?: string | null;
  payload: { text: string; door: string; threadRef: string };
  createdBy: string;
}
export interface Reminder extends NewReminder {
  id: string;
  status: string;
}

/** A pending reminder row as returned by dueReminders (the daemon's delivery shape). */
export interface DueReminder {
  id: string;
  agent: string;
  owner: string;
  due_at: Date;
  recurrence: string | null;
  /** DB shape: { text, door, threadRef }. Loop reads payload.text (message), payload.door (channel), payload.threadRef (delivery thread). */
  payload: { text: string; door: string; threadRef: string };
}

export async function createReminder(db: Pool, r: NewReminder): Promise<Reminder> {
  const { rows } = await db.query(
    `INSERT INTO reminders (agent, owner, due_at, recurrence, payload, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status`,
    [r.agent, r.owner, r.dueAt, r.recurrence ?? null, r.payload, r.createdBy],
  );
  return { ...r, id: rows[0].id, status: rows[0].status };
}

export async function dueReminders(db: Pool, now: Date): Promise<DueReminder[]> {
  const { rows } = await db.query<DueReminder>(
    `SELECT id, agent, owner, due_at, recurrence, payload FROM reminders
     WHERE status = 'pending' AND due_at <= $1 ORDER BY due_at`,
    [now],
  );
  return rows;
}

export async function markDelivered(db: Pool, id: string): Promise<void> {
  await db.query(
    `UPDATE reminders SET status='delivered', delivered_at=now() WHERE id=$1`,
    [id],
  );
}

/** A pending reminder as returned by listPending (the hand's list shape). */
export interface PendingReminder {
  id: string;
  due_at: Date;
  recurrence: string | null;
  /** DB shape: { text, door, threadRef }. The delivery loop reads payload.text (message), payload.door (channel), payload.threadRef (delivery thread). */
  payload: { text: string; door: string; threadRef: string };
  /** Who or what created this reminder — "user" for Bendik-set, loop names (e.g. "saga-dream") for agent-generated items. */
  created_by: string;
}

export async function listPending(db: Pool, owner: string): Promise<PendingReminder[]> {
  const { rows } = await db.query<PendingReminder>(
    `SELECT id, due_at, recurrence, payload, created_by FROM reminders
     WHERE status = 'pending' AND owner = $1 ORDER BY due_at`,
    [owner],
  );
  return rows;
}

export async function cancelReminder(db: Pool, id: string, owner: string): Promise<void> {
  await db.query(
    `UPDATE reminders SET status='cancelled' WHERE id=$1 AND owner=$2`,
    [id, owner],
  );
}
