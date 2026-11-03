/** The immutable reservation behind one exact approval card, found by its request id. Route
 * admission needs this before any tool callback runs, and approval-execution depends on
 * console-turn-authority, so it lives apart from both. Personal mail keeps its own record. */
import { z } from 'zod';
import { APPROVAL_TTL_MS, payloadFingerprint } from './approval-ledger.js';
import { turnAuthoritySchema } from './authority-contract.js';
import { PERSONAL_MAIL_SEND_TOOL } from './personal-action-store.js';

export const EXACT_CARD_REFUSED = 'Exact approval card is unavailable or changed';
const refuse = (): never => { throw new Error(EXACT_CARD_REFUSED); };
export const exactTargetSchema = z.strictObject({ kind: z.enum(['deadline','deadline-candidate','track','track-item','track-create','vault-note','outside-call']), id: z.string().min(1),
  ownerMemberId: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  approvedOrigin: z.enum(['agent','synced','third_party']).optional() });
export const exactReservationSchema = z.strictObject({ version: z.literal(1), original: turnAuthoritySchema,
  incarnation: z.string().uuid(), admissionHash: z.string(), target: exactTargetSchema,
  policyHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.iso.datetime() });
export interface ExactCardCoordinates { requestId: string; agent: string; incarnation: string; sessionId: string; memberId: string; admissionNonce: string }
export interface ExactCard { callId: string; tool: string; outcome: string | null; resolvedByMemberId: string | null; used: boolean; alive: boolean; validUntil: string }
/** Undefined means this request is not an exact card for this member and session: no row, or
 * personal mail. A row that exists but disagrees with its own reservation always refuses. */
export async function exactCardForRequest(db: { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> }, input: ExactCardCoordinates): Promise<ExactCard | undefined> {
  const row = (await db.query(`SELECT call_id,tool,original_authority,outcome,resolved_by_member_id,used_at FROM approval_asks
    WHERE request_id=$1 AND agent=$2 AND session_id=$3 AND acting_member_id=$4 FOR SHARE`,[input.requestId,input.agent,input.sessionId,input.memberId])).rows[0];
  if (!row || row.tool === PERSONAL_MAIL_SEND_TOOL) return undefined;
  const parsed = exactReservationSchema.safeParse(row.original_authority);
  if (!parsed.success) return refuse();
  const r = parsed.data, o = r.original;
  if (o.origin !== 'human' || o.agentId !== input.agent || o.sessionId !== input.sessionId || o.actingMemberId !== input.memberId ||
      o.spokenByMemberId !== input.memberId || r.target.ownerMemberId !== input.memberId || r.incarnation !== input.incarnation ||
      r.admissionHash !== payloadFingerprint('admission',input.admissionNonce)) return refuse();
  // Database clock, after any lock wait, and the earlier of the card's two lifetimes.
  const validity = (await db.query(`SELECT valid_until::text,valid_until>clock_timestamp() AS alive FROM
    (SELECT LEAST($2::timestamptz,asked_at+($3*interval '1 millisecond')) AS valid_until FROM approval_asks WHERE call_id=$1) deadline`,[row.call_id,r.expiresAt,APPROVAL_TTL_MS])).rows[0];
  if (!validity) return refuse();
  return { callId: row.call_id, tool: row.tool, outcome: row.outcome, resolvedByMemberId: row.resolved_by_member_id,
    used: row.used_at !== null, alive: validity.alive === true, validUntil: validity.valid_until };
}
