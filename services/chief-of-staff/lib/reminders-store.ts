/**
 * Reminders store — ported VERBATIM from `services/box/lib/reminders.ts`'s
 * `createReminder`, `dueReminders`, `markDelivered`, `listPending`, `cancelReminder`. Table
 * and column names must match exactly: eve-saga shares the box's `db` service and its
 * `lares_state` database (the same Postgres `services/box/sql/001_init.sql` already
 * provisioned the `reminders` table on), so this reads and writes the SAME rows the old
 * daemon's delivery loop does — no new SQL migration needed here, matching the precedent set
 * by `lib/identity-client.ts` reading the box's existing `user_aliases` table.
 *
 * The payload shape is `{ text, door, threadRef }` — this file's own ground truth, not
 * `services/agent-runtime/lib/adapters/hands/remind.ts`'s older, inconsistent
 * `{message, channel}` shape (that hand predates the current loop+store pairing and is
 * vestigial; its field names are never used here).
 *
 * `owner` defaults to `CANONICAL_USER_ID` (`lib/identity-client.ts`) rather than a second
 * hardcoded `"bendik"` literal — the identity registry fixes the canonical id there, and this
 * store must never drift from it.
 */
import type { Pool } from "pg";

import { configuredOwnerId } from "./identity-client.js";

export interface ReminderPayload {
  text: string;
  door: string;
  threadRef: string;
}

export interface NewReminder {
  agent: string;
  owner?: string;
  dueAt: Date;
  recurrence?: string | null;
  payload: ReminderPayload;
  createdBy: string;
}

export interface Reminder extends Required<Pick<NewReminder, "agent" | "dueAt" | "payload" | "createdBy">> {
  id: string;
  owner: string;
  recurrence: string | null;
  status: string;
}

/** A pending reminder row as returned by dueReminders (the delivery schedule's shape). */
export interface DueReminder {
  id: string;
  agent: string;
  owner: string;
  due_at: Date;
  recurrence: string | null;
  payload: ReminderPayload;
}

export async function createReminder(db: Pool, r: NewReminder): Promise<Reminder> {
  const owner = r.owner ?? configuredOwnerId();
  const { rows } = await db.query(
    `INSERT INTO reminders (agent, owner, due_at, recurrence, payload, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status`,
    [r.agent, owner, r.dueAt, r.recurrence ?? null, r.payload, r.createdBy],
  );
  return {
    agent: r.agent,
    owner,
    dueAt: r.dueAt,
    recurrence: r.recurrence ?? null,
    payload: r.payload,
    createdBy: r.createdBy,
    id: rows[0].id,
    status: rows[0].status,
  };
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

/** A pending reminder as returned by listPending (the remind_list tool's shape). */
export interface PendingReminder {
  id: string;
  due_at: Date;
  recurrence: string | null;
  payload: ReminderPayload;
  /** Who or what created this reminder — "user" for Bendik-set, a loop name (e.g.
   *  "loop:re-arm") for agent-generated recurrences. */
  created_by: string;
}

export async function listPending(db: Pool, owner: string = configuredOwnerId()): Promise<PendingReminder[]> {
  const { rows } = await db.query<PendingReminder>(
    `SELECT id, due_at, recurrence, payload, created_by FROM reminders
     WHERE status = 'pending' AND owner = $1 ORDER BY due_at`,
    [owner],
  );
  return rows;
}

export async function cancelReminder(db: Pool, id: string, owner: string = configuredOwnerId()): Promise<void> {
  await db.query(
    `UPDATE reminders SET status='cancelled' WHERE id=$1 AND owner=$2`,
    [id, owner],
  );
}
