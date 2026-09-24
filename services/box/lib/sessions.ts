import type { Pool } from "pg";

export interface Session {
  id: string;
  agent: string;
  door: string;
  threadRef: string;
  sdkSession: string | null;
  /** last_seen_at as it was BEFORE this resolve touched it — null on first create.
   *  The rotation trigger compares this to "now" (a new Oslo day ⇒ rotate). */
  prevSeenAt: Date | null;
}

/** Find the session for (agent, door, thread) or create it. Touches last_seen_at;
 *  the CTE reads the PRE-statement snapshot so prevSeenAt survives the touch. */
export async function findOrCreateSession(
  db: Pool, agent: string, door: string, threadRef: string,
): Promise<Session> {
  const { rows } = await db.query(
    `WITH prev AS (
       SELECT last_seen_at FROM sessions
        WHERE agent = $1 AND door = $2 AND thread_ref = $3
     )
     INSERT INTO sessions (agent, door, thread_ref)
       VALUES ($1,$2,$3)
     ON CONFLICT (agent, door, thread_ref)
       DO UPDATE SET last_seen_at = now()
     RETURNING id, agent, door, thread_ref AS "threadRef", sdk_session AS "sdkSession",
       (SELECT last_seen_at FROM prev) AS "prevSeenAt"`,
    [agent, door, threadRef],
  );
  return rows[0];
}

export async function setSdkSession(db: Pool, id: string, sdkSession: string): Promise<void> {
  await db.query(`UPDATE sessions SET sdk_session = $2 WHERE id = $1`, [id, sdkSession]);
}

export async function touchSession(db: Pool, id: string): Promise<void> {
  await db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [id]);
}
