import type { Pool } from "pg";

export interface AuditEntry {
  agent: string;
  sessionId?: string;
  action: string;            // "<capability>.<action>"
  credential?: string;       // key/scope NAME only — never the secret
  argsSummary?: string;      // redacted human summary — never the raw payload
  confirmId?: string;        // the confirmation that authorised it, if any
  principal?: string;        // ADR-0009 user attribution
}

/** Append one row to the append-only audit log. */
export async function appendAudit(db: Pool, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit (agent, session_id, action, credential, args_summary, confirm_id, principal)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.agent, e.sessionId ?? null, e.action, e.credential ?? null,
     e.argsSummary ?? null, e.confirmId ?? null, e.principal ?? null],
  );
}
