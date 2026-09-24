/**
 * Outreach-thread tracking (ORB-75) — services/box/sql/021_outreach_threads.sql.
 * One row per sent outreach email; the reply-watch schedule polls rows with
 * status='awaiting_reply' and stops tracking once a reply lands or the thread is dropped.
 */
import type { Pool } from "pg";
import { configuredOwnerId } from "./identity-client.js";

export type OutreachStatus = "awaiting_reply" | "replied" | "stopped";

export interface OutreachThread {
  id: string;
  threadId: string;
  account: string;
  personId: string | null;
  status: OutreachStatus;
  sentAt: Date;
}

interface Row { id: string; thread_id: string; account: string; person_id: string | null; status: OutreachStatus; sent_at: Date }

function fromRow(r: Row): OutreachThread {
  return { id: r.id, threadId: r.thread_id, account: r.account, personId: r.person_id, status: r.status, sentAt: r.sent_at };
}

/** Subtracted from a caller-supplied `sentAt` before it's stored — a small buffer against
 *  clock skew between Gmail's own send-time record and whatever assigned the Date header on
 *  a reply, so a genuinely-fast reply (autoresponder, a very quick human) a few seconds
 *  "before" our recorded send time still matches detectReply's strictly-after filter
 *  (ORB-93). */
const SEND_TIME_SKEW_ALLOWANCE_MS = 30_000;

/**
 * Starts tracking a sent thread. Idempotent on (threadId, account) — calling this twice for
 * the same send (e.g. a retried tool call) does not create a duplicate tracking row.
 *
 * ORB-93: re-tracking used to be a total no-op (`SET thread_id = thread_id`) — a follow-up
 * send on an already-replied thread left `status='replied'` standing, so the reply-watch
 * schedule's `listAwaitingReply` never saw it again and the next reply was never detected,
 * while the tool call that "sent the follow-up" still reported `{ok:true}`. Re-tracking now
 * re-arms the row: status back to 'awaiting_reply', sent_at to this new send, resolved_at
 * cleared, and any stale triage checkpoint (beginTriage, below) cleared so the next reply on
 * this thread isn't blocked by a leftover checkpoint from the previous round.
 *
 * ORB-93: `sentAt`, when given (the ISO timestamp `gmail_send` returned), replaces the
 * database's own `now()` default. Without it, a message's tracked send time was whenever
 * THIS tool call happened to run — a separate, LATER tool call than the actual send — so a
 * very fast reply (an autoresponder, a quick human) dated before that later moment could
 * never satisfy detectReply's strictly-after filter and was silently invisible.
 */
export async function trackOutreachThread(
  db: Pool, input: { threadId: string; account: string; personId?: string | null; sentAt?: string },
): Promise<OutreachThread> {
  const sentAt = input.sentAt ? new Date(Date.parse(input.sentAt) - SEND_TIME_SKEW_ALLOWANCE_MS) : null;
  const { rows } = await db.query<Row>(
    `INSERT INTO outreach_threads (thread_id, account, person_id, principal, sent_at)
     VALUES ($1,$2,$3,$4, COALESCE($5, now()))
     ON CONFLICT (thread_id, account) DO UPDATE
       SET status = 'awaiting_reply', sent_at = COALESCE($5, now()), resolved_at = NULL, triage_started_at = NULL
     RETURNING id, thread_id, account, person_id, status, sent_at`,
    [input.threadId, input.account, input.personId ?? null, configuredOwnerId(), sentAt],
  );
  return fromRow(rows[0]!);
}

export async function listAwaitingReply(db: Pool): Promise<OutreachThread[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, thread_id, account, person_id, status, sent_at FROM outreach_threads WHERE status = 'awaiting_reply' ORDER BY sent_at ASC`,
  );
  return rows.map(fromRow);
}

/** How long a triage checkpoint (see beginTriage) is honored before a retry is allowed —
 *  comfortably more than one POLL_INTERVAL_MINUTES cycle (15m) so a normal in-flight attempt
 *  is never mistaken for a crashed one by the very next poll, but bounded so a genuine crash
 *  recovers within roughly one extra cycle rather than being stuck forever. */
const TRIAGE_CHECKPOINT_STALE_AFTER = "20 minutes";

/**
 * Durable checkpoint set BEFORE a reply's triage starts (ORB-93). Without this, a restart or
 * DB error between detecting a reply and `markReplied` left the thread 'awaiting_reply', so
 * the NEXT poll (15 minutes later) re-detected the SAME reply and started an entirely
 * independent second triage — duplicate sessions, duplicate approval cards, two 👍 = two
 * replies sent. Returns true if this call may proceed (fresh, or the previous checkpoint has
 * gone stale — likely a crashed attempt); false if another attempt is still within its retry
 * window and this tick must skip it.
 */
export async function beginTriage(db: Pool, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE outreach_threads SET triage_started_at = now()
     WHERE id = $1 AND (triage_started_at IS NULL OR triage_started_at < now() - interval '${TRIAGE_CHECKPOINT_STALE_AFTER}')`,
    [id],
  );
  return rowCount === 1;
}

export async function markReplied(db: Pool, id: string): Promise<void> {
  await db.query(`UPDATE outreach_threads SET status = 'replied', resolved_at = now() WHERE id = $1`, [id]);
}

/** Stops tracking a thread without a reply — e.g. it's aged past the polling window. Does
 *  NOT touch Twenty; the caller decides separately whether that warrants its own CRM update. */
export async function stopTracking(db: Pool, id: string): Promise<void> {
  await db.query(`UPDATE outreach_threads SET status = 'stopped', resolved_at = now() WHERE id = $1`, [id]);
}
