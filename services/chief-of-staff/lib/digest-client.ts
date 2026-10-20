/**
 * Enqueues a digest run request for `catalogue/digest_run.ts`.
 *
 * Table and column names must match exactly, because the row this writes is read by the digest
 * consumer (`claimDigestRequests` in `lib/digest-store.ts`, polling the same
 * `digest_requests` table over the same `db` service). This is a queue-enqueue, not a
 * gated write: the `digest_run` tool carries no approval gate.
 */
import type { Pool } from "pg";

export async function enqueueDigestRequest(
  db: Pool,
  opts: { agent: string; requestedBy: string; door: string; threadRef: string },
): Promise<{ id: string }> {
  const { rows } = await db.query(
    `INSERT INTO digest_requests (agent, requested_by, door, thread_ref) VALUES ($1,$2,$3,$4) RETURNING id`,
    [opts.agent, opts.requestedBy, opts.door, opts.threadRef],
  );
  return { id: rows[0].id };
}
