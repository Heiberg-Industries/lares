/**
 * Enqueues a digest run request for `agent/tools/digest_run.ts`.
 *
 * Ported VERBATIM from `services/box/lib/digest-store.ts`'s `enqueueDigestRequest` —
 * table and column names must match exactly, because the row this writes is read by the
 * UNTOUCHED `saga-digest` container (`claimDigestRequests`, same file, polling the same
 * `digest_requests` table over the same `db` service). This is a queue-enqueue, not a
 * gated write: the plan's own TOOL verdict for `digest_run` carries no approval gate,
 * unlike the write tools in later tasks.
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
