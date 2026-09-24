import type { Db } from "./db.js";

const WINDOW_DAYS = 90;

/**
 * call_unreturned: ≥2 outbound unanswered calls in the trailing window with
 * no inbound interaction (any channel) after the FIRST of them. The inverse —
 * an unanswered outbound followed by a call/message back — is positive
 * evidence and needs no signal (the inbound row already carries it).
 * Returns the number of signals written.
 */
export function detectCallUnreturned(db: Db, now: Date): number {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const candidates = db
    .prepare(
      `SELECT contact_id, MIN(at) AS first_attempt, COUNT(*) AS attempts
       FROM interactions
       WHERE channel = 'call' AND direction = 'outbound' AND answered = 0 AND at >= ?
       GROUP BY contact_id
       HAVING COUNT(*) >= 2`,
    )
    .all(since) as { contact_id: number; first_attempt: string; attempts: number }[];

  const cameBack = db.prepare(
    "SELECT COUNT(*) AS n FROM interactions WHERE contact_id = ? AND direction = 'inbound' AND at > ?",
  );
  const alreadyFlagged = db.prepare(
    "SELECT COUNT(*) AS n FROM signals WHERE contact_id = ? AND kind = 'call_unreturned' AND at >= ?",
  );
  const ins = db.prepare("INSERT INTO signals (contact_id, kind, at, evidence) VALUES (?, 'call_unreturned', ?, ?)");

  let written = 0;
  const tx = db.transaction(() => {
    for (const c of candidates) {
      if ((cameBack.get(c.contact_id, c.first_attempt) as any).n > 0) continue;
      if ((alreadyFlagged.get(c.contact_id, since) as any).n > 0) continue;
      ins.run(c.contact_id, now.toISOString(), JSON.stringify({ attempts: c.attempts, firstAttempt: c.first_attempt }));
      written++;
    }
  });
  tx();
  return written;
}
