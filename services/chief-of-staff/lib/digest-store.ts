/**
 * The digest queue's CONSUMER half, plus the skip ledger.
 *
 * Ported VERBATIM (same SQL text, same column names) from
 * `services/box/lib/digest-store.ts` — the counterpart to this service's existing
 * `lib/digest-client.ts`, which writes the rows `claimDigestRequests` reads. The two must agree
 * exactly: `digest-client` is what `agent/tools/digest_run.ts` calls when Bendik asks for a
 * digest now, and it has been enqueueing into a queue only the old `saga-digest` container
 * could drain.
 *
 * `claimDigestRequests` is a DELETE … RETURNING, i.e. the claim IS the consumption — whichever
 * process runs it owns the row. That is why the cutover stops `saga-digest` and enables this
 * schedule in ONE change: with two live consumers an on-demand digest goes to whichever won the
 * race, and a scheduled pass fires twice.
 *
 * `enqueueDigestRequest` is deliberately NOT re-exported here; it already lives in
 * `lib/digest-client.ts` and duplicating it would give the row shape two definitions.
 */
import type { Pool } from "pg";

export interface DigestRequest {
  id: string;
  door: string;
  threadRef: string;
}

/** Atomically consume all pending requests for the agent (returns them, leaves none pending). */
export async function claimDigestRequests(db: Pool, agent: string): Promise<DigestRequest[]> {
  const { rows } = await db.query(
    `DELETE FROM digest_requests
     WHERE id IN (SELECT id FROM digest_requests WHERE agent=$1 AND status='pending')
     RETURNING id, door, thread_ref`,
    [agent],
  );
  return rows.map((r) => ({ id: r.id, door: r.door, threadRef: r.thread_ref }));
}

export async function recordDigestSkip(
  db: Pool,
  opts: { agent: string; path: string; reason: string },
): Promise<void> {
  await db.query(
    `INSERT INTO digest_skips (agent, path, reason) VALUES ($1,$2,$3)
     ON CONFLICT (agent, path) DO UPDATE SET reason=EXCLUDED.reason, asked_at=now()`,
    [opts.agent, opts.path, opts.reason],
  );
}

export async function listSkippedPaths(db: Pool, agent: string): Promise<string[]> {
  const { rows } = await db.query(`SELECT path FROM digest_skips WHERE agent=$1`, [agent]);
  return rows.map((r) => r.path);
}
