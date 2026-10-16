// Per-mailbox poll watermark for the email watcher. Snake_case columns, unix-seconds bigint
// (pg returns bigint as a string — coerce with Number). Monotonic: advance never regresses.
import type { Queryable } from "./db.js";

export async function getEmailWatchCursor(
  db: Queryable, watcher: string, principal: string, emailAddress: string,
): Promise<number> {
  const { rows } = await db.query<{ last_polled_at: string }>(
    `SELECT last_polled_at FROM email_watch_cursors
      WHERE watcher=$1 AND principal=$2 AND email_address=$3`,
    [watcher, principal, emailAddress],
  );
  return rows[0] ? Number(rows[0].last_polled_at) : 0;
}

export async function advanceEmailWatchCursor(
  db: Queryable, watcher: string, principal: string, emailAddress: string, lastPolledAt: number,
): Promise<void> {
  await db.query(
    `INSERT INTO email_watch_cursors (watcher, principal, email_address, last_polled_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (watcher, principal, email_address) DO UPDATE
       SET last_polled_at = GREATEST(email_watch_cursors.last_polled_at, EXCLUDED.last_polled_at),
           updated_at = now()`,
    [watcher, principal, emailAddress, Math.trunc(lastPolledAt)],
  );
}
