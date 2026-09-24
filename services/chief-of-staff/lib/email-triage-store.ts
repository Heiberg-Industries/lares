/**
 * Email-triage dedup store (ORB-76) — services/box/sql/022_email_triage.sql. The
 * primary key on (mailbox, gmail_message_id) IS the exactly-once guarantee: this schedule
 * re-scans a short rolling window every tick rather than tracking a cursor, and relies
 * entirely on `claimMessage`'s claim logic to skip anything already handled — matching the
 * old watcher's guarantee (services/box/sql/011_workflow_correlation_key.sql) without
 * needing a second table to track "how far we've scanned."
 *
 * ORB-92: `claimMessage` used to be a bare ON CONFLICT DO NOTHING, so ANY failure after
 * claim — a Gmail 503 on the read, a flaky triage call — left the seeded 'error' outcome
 * standing forever: "already claimed" and "permanently failed" were indistinguishable, and a
 * transient hiccup silently dropped a human email. `attempts` (services/box/sql/
 * 024_email_triage_retry.sql) lets a still-'error' row be re-claimed up to MAX_ATTEMPTS
 * times; the schedule emits a spine signal when the final attempt also fails, so a drop is
 * loud, never silent.
 */
import type { Pool } from "pg";
import { configuredOwnerId } from "./identity-client.js";

export type TriageOutcome = "drafted" | "fyi" | "automated" | "error";

/** How many times a message that keeps failing (read or triage) gets re-claimed before the
 *  schedule gives up and reports it loudly instead of retrying again. Small on purpose — a
 *  billed triage call may already have happened by a later attempt, so this bounds worst-case
 *  re-billing the same way the Aug 14/15 incident's fix bounds retry loops generally
 *  (docs/solutions/2026-08-15-api-cost-leak-proposal-retry-loop.md). */
export const MAX_ATTEMPTS = 3;

export interface ClaimResult {
  /** Whether THIS call is the one that gets to process the message this tick. */
  claimed: boolean;
  /** The attempt number this claim represents (1-indexed); 0 when not claimed. */
  attempt: number;
  /** True when this is the last attempt allowed — if it also fails, the caller must report
   *  it loudly (emitSignal) rather than let it fall silent. */
  isFinalAttempt: boolean;
}

/** A re-claim only becomes eligible once a full tick could plausibly have finished — without
 *  this, two claims racing on a brand-new message (the original "only one wins" guarantee)
 *  would both succeed: the INSERT's loser falls into the ON CONFLICT branch and would
 *  otherwise see a fresh attempts=1, 'error' row and happily claim it as attempt 2, even
 *  though the winner hasn't even started processing yet. Comfortably above the 1-minute
 *  cron cadence so a genuinely in-flight attempt is never mistaken for a stale one. */
const RETRY_ELIGIBLE_AFTER = "90 seconds";

/** Atomically claims a message for processing: a fresh row (attempt 1), or a re-claim of a
 *  still-'error' row below MAX_ATTEMPTS that's old enough to be stale rather than in-flight
 *  (attempt N). Returns `claimed: false` once the real outcome has been recorded
 *  (recordOutcome overwrote 'error'), once MAX_ATTEMPTS is reached, or while a previous
 *  attempt could still be in flight — either way, the caller must skip it. */
export async function claimMessage(db: Pool, mailbox: string, gmailMessageId: string): Promise<ClaimResult> {
  const { rows } = await db.query<{ attempts: number }>(
    `INSERT INTO email_triage_processed (mailbox, gmail_message_id, principal, outcome, attempts)
     VALUES ($1, $2, $3, 'error', 1)
     ON CONFLICT (mailbox, gmail_message_id) DO UPDATE
       SET attempts = email_triage_processed.attempts + 1, processed_at = now()
       WHERE email_triage_processed.outcome = 'error'
         AND email_triage_processed.attempts < $4
         AND email_triage_processed.processed_at < now() - interval '${RETRY_ELIGIBLE_AFTER}'
     RETURNING attempts`,
    [mailbox, gmailMessageId, configuredOwnerId(), MAX_ATTEMPTS],
  );
  if (rows.length === 0) return { claimed: false, attempt: 0, isFinalAttempt: false };
  const attempt = rows[0]!.attempts;
  return { claimed: true, attempt, isFinalAttempt: attempt >= MAX_ATTEMPTS };
}

/** Records the real outcome once triage actually finishes — `claimMessage` seeds 'error' so
 *  a crash mid-triage (process killed between claim and this call) leaves an honest trail
 *  instead of silently looking like a successful skip; a genuinely different outcome always
 *  overwrites it. */
export async function recordOutcome(db: Pool, mailbox: string, gmailMessageId: string, outcome: TriageOutcome): Promise<void> {
  await db.query(
    `UPDATE email_triage_processed SET outcome = $3 WHERE mailbox = $1 AND gmail_message_id = $2`,
    [mailbox, gmailMessageId, outcome],
  );
}

/** sql/034 — remember which Gmail draft this triage row created, so "the reply to Stefan" can be
 *  resolved to a draft later (gmail_draft_recipients). Only ever called after a `drafted` outcome. */
export async function recordDraft(
  db: Pool, mailbox: string, gmailMessageId: string, draft: { draftId: string; threadId: string },
): Promise<void> {
  await db.query(
    `UPDATE email_triage_processed SET draft_id = $3, thread_id = $4 WHERE mailbox = $1 AND gmail_message_id = $2`,
    [mailbox, gmailMessageId, draft.draftId, draft.threadId],
  );
}

export interface DraftRef { draftId: string; threadId: string; gmailMessageId: string }

/** The latest draft this mailbox's triage created on a thread, or null. Scoped to the mailbox —
 *  another mailbox's draft on the same thread id is not this one's. */
export async function findDraft(db: Pool, mailbox: string, by: { threadId: string }): Promise<DraftRef | null> {
  const { rows } = await db.query<{ draft_id: string; thread_id: string; gmail_message_id: string }>(
    `SELECT draft_id, thread_id, gmail_message_id FROM email_triage_processed
      WHERE mailbox = $1 AND thread_id = $2 AND draft_id IS NOT NULL
      ORDER BY processed_at DESC LIMIT 1`,
    [mailbox, by.threadId],
  );
  const r = rows[0];
  return r ? { draftId: r.draft_id, threadId: r.thread_id, gmailMessageId: r.gmail_message_id } : null;
}

const RETENTION = "30 days";

/** This table exists to fix unbounded growth (the whole point of ORB-76's exactly-once
 *  guarantee) — it must not become a second instance of the problem it fixes. */
export async function pruneOldRecords(db: Pool): Promise<void> {
  await db.query(`DELETE FROM email_triage_processed WHERE processed_at < now() - interval '${RETENTION}'`);
}
