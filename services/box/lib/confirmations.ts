import type { Queryable } from "./db.js";

export interface Confirmation {
  id: string;
  sessionId: string | null;
  action: string;                 // "<capability>.<action>"
  args: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "expired" | "consuming" | "consumed";
  effectResult: Record<string, unknown> | null;
}

const COLS = `id, session_id AS "sessionId", action, args, status, effect_result AS "effectResult"`;

export async function createConfirmation(
  db: Queryable, sessionId: string | null, action: string, args: Record<string, unknown>,
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO confirmations (session_id, action, args) VALUES ($1,$2,$3) RETURNING id`,
    [sessionId, action, args],
  );
  return rows[0].id;
}

export async function getConfirmation(db: Queryable, id: string): Promise<Confirmation | null> {
  const { rows } = await db.query(`SELECT ${COLS} FROM confirmations WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Flip a still-pending row to approved/rejected. Returns the row, or null if it was not pending. */
export async function resolveConfirmation(
  db: Queryable, id: string, approved: boolean,
): Promise<Confirmation | null> {
  const { rows } = await db.query(
    `UPDATE confirmations
        SET status = $2, resolved_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING ${COLS}`,
    [id, approved ? "approved" : "rejected"],
  );
  return rows[0] ?? null;
}

/** Mark every still-pending row requested before `olderThan` as expired. Returns the count. */
export async function expireConfirmations(db: Queryable, olderThan: Date): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE confirmations SET status = 'expired', resolved_at = now()
      WHERE status = 'pending' AND requested_at < $1`,
    [olderThan],
  );
  return rowCount ?? 0;
}

/** Record that this confirmation was posted as a specific Slack message. */
export async function setConfirmationSlackRef(
  db: Queryable, confirmId: string, channel: string, ts: string,
): Promise<void> {
  await db.query(
    `UPDATE confirmations SET slack_channel = $2, slack_ts = $3 WHERE id = $1`,
    [confirmId, channel, ts],
  );
}

/** Look up a confirmation id by the Slack message that proposed it. Returns null if not found. */
export async function findConfirmationBySlackRef(
  db: Queryable, channel: string, ts: string,
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT id FROM confirmations WHERE slack_channel = $1 AND slack_ts = $2 LIMIT 1`,
    [channel, ts],
  );
  return rows[0]?.id ?? null;
}

/** Atomically claim an approved confirmation for execution. Returns the row to the
 *  single winner; null if it was not 'approved' (already consuming/consumed/etc.). */
export async function consumeConfirmation(db: Queryable, id: string): Promise<Confirmation | null> {
  const { rows } = await db.query<Confirmation>(
    `UPDATE confirmations SET status='consuming'
       WHERE id=$1 AND status='approved'
       RETURNING ${COLS}`,
    [id],
  );
  return rows[0] ?? null;
}

/** Record that the effect ran: consuming → consumed, storing the result for idempotent replay. */
export async function markConfirmationConsumed(db: Queryable, id: string, result: Record<string, unknown>): Promise<void> {
  await db.query(
    `UPDATE confirmations SET status='consumed', effect_result=$2, consumed_at=now()
       WHERE id=$1 AND status='consuming'`,
    [id, JSON.stringify(result)],
  );
}
