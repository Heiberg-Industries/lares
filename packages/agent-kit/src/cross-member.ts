// Tier 2 of the cross-member access model (spec Part 7): standing grants a member makes TO
// THE ORG'S AGENTS, checked here, audited here. Tier 1 (free/busy) deliberately bypasses
// this module — it is policy-per-source on the calendar side. Tier 3 (per-request consent
// cards) is not built in v1, by ruling.
import type { Pool } from "pg";

export class CrossMemberDeniedError extends Error {
  constructor(grantor: string, capability: string) {
    super(`no standing grant from ${grantor} for ${capability}`);
    this.name = "CrossMemberDeniedError";
  }
}

export interface CrossMemberRead {
  grantorUserId: string;
  capability: string;
  requestedByUserId: string;
  agent: string;
}

export async function hasStandingGrant(db: Pool, grantorUserId: string, capability: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM cross_member_grants WHERE grantor_user_id = $1 AND capability = $2 AND revoked_at IS NULL LIMIT 1`,
    [grantorUserId, capability],
  );
  return rows.length > 0;
}

export async function recordCrossMemberRead(db: Pool, r: CrossMemberRead): Promise<void> {
  await db.query(
    `INSERT INTO cross_member_reads (grantor_user_id, capability, requested_by_user_id, agent) VALUES ($1, $2, $3, $4)`,
    [r.grantorUserId, r.capability, r.requestedByUserId, r.agent],
  );
}

export async function readWithGrant<T>(db: Pool, r: CrossMemberRead, read: () => Promise<T>): Promise<T> {
  if (!(await hasStandingGrant(db, r.grantorUserId, r.capability))) {
    throw new CrossMemberDeniedError(r.grantorUserId, r.capability);
  }
  // Audit BEFORE the read: an audit row for a read that then failed is noise; a read that
  // happened without its audit row is a hole. Noise is the safe direction.
  await recordCrossMemberRead(db, r);
  return read();
}
