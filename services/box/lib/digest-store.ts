import type { Pool } from "pg";

export interface DigestRequest {
  id: string;
  door: string;
  threadRef: string;
}

export async function enqueueDigestRequest(
  db: Pool,
  opts: { agent: string; requestedBy: string; door: string; threadRef: string },
): Promise<{ id: string }> {
  const { rows } = await db.query(
    `INSERT INTO digest_requests (agent, requested_by, door, thread_ref)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [opts.agent, opts.requestedBy, opts.door, opts.threadRef],
  );
  return { id: rows[0].id };
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
