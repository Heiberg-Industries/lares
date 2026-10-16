import type { Pool } from "pg";
import type { AuditRecord } from "./actions.js";
/** Errors never expose query parameters or database credentials. No best-effort writes. */
export async function writeAudit(pool: Pool, r: AuditRecord): Promise<void> {
  try {
    if (r.operationId && r.outcome !== "pending") {
      const result = await pool.query("UPDATE keeper_audit SET outcome=$2, detail=$3, completed_at=now() WHERE operation_id=$1 AND outcome='pending'", [r.operationId, r.outcome, r.detail ?? null]);
      if (result.rowCount !== 1)
        throw new Error("missing pending intent");
    }
    else {
      if (r.outcome === "pending" && !r.operationId)
        throw new Error("missing operation id");
      await pool.query("INSERT INTO keeper_audit (operation_id,action,actor,input,outcome,detail,completed_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,CASE WHEN $5='pending' THEN NULL ELSE now() END)", [r.operationId ?? null, r.action, r.actor, JSON.stringify(r.input ?? {}), r.outcome, r.detail ?? null]);
    }
  }
  catch {
    throw new Error("keeper: audit unavailable");
  }
}
export function auditor(pool: Pool): (r: AuditRecord) => Promise<void> {
  return r => writeAudit(pool, r);
}
