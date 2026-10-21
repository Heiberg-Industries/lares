/** Exact-call authority for bound private console approvals. Legacy evidence stays separate.
 * Only reviewed local adapters participate. No inferred account or provider authority.
 */
import { z } from 'zod';
import { getPool } from './db.js';
import { payloadFingerprint, callIdFrom, APPROVAL_TTL_MS } from './approval-ledger.js';
import { turnAuthoritySchema, type TurnAuthority } from './authority-contract.js';
import { consoleAdmission, hasConsoleTurnAuthorityTag, requireConsoleTurnAuthority, requireConsoleSessionBinding,
  type AuthorityDatabase, type ConsoleAuthorityContext } from './console-turn-authority.js';
import { managedIdentity } from './door-authority.js';
import { parseDefinition } from './definition.js';
import { autonomyOf, grantFor, scopeAtLeast } from './manifest.js';

export const EXACT_APPROVAL_REFUSED = 'Exact approval authority is unavailable or has changed';
const refuse = (): never => { throw new Error(EXACT_APPROVAL_REFUSED); };
const targetSchema = z.strictObject({ kind: z.enum(['deadline','deadline-candidate']), id: z.string().min(1),
  ownerMemberId: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export type ExactApprovalTarget = z.infer<typeof targetSchema>;
const reservationSchema = z.strictObject({ version: z.literal(1), original: turnAuthoritySchema,
  incarnation: z.string().uuid(), admissionHash: z.string(), target: targetSchema,
  policyHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.iso.datetime() });
type Reservation = z.infer<typeof reservationSchema>;
export interface ExactApprovalAdapter {
  /** Read current content and stable ownership; lock the row when using a transaction client. */
  readTarget(db: AuthorityDatabase, input: unknown, memberId: string): Promise<ExactApprovalTarget>;
}
export interface ExactApprovalOptions {
  adapter?: ExactApprovalAdapter; db?: AuthorityDatabase; env?: NodeJS.ProcessEnv; now?: Date;
}
interface Row { request_id: string | null; call_id: string; agent: string; tool: string; payload_hash: string;
  original_authority: unknown; acting_member_id: string | null; resolved_by_member_id: string | null; outcome: string | null }
interface Execution { authority: Extract<TurnAuthority,{origin:'approval-resume'}>; target: ExactApprovalTarget }
const database = (o: ExactApprovalOptions) => o.db ?? getPool();
const same = (a: unknown, b: unknown) => payloadFingerprint('authority',a) === payloadFingerprint('authority',b);
const supported = (tool: string, o: ExactApprovalOptions): ExactApprovalAdapter => {
  // Refuse before any authored policy can perform a provider-dependent lookup.
  if (tool !== 'deadline_dismiss' || !o.adapter) throw new Error('Exact approval is unavailable for this action target');
  return o.adapter!;
};
export function isExactApprovalContext(ctx: unknown): boolean { return hasConsoleTurnAuthorityTag(ctx); }
export function isExactApprovalResponse(ctx: unknown): boolean {
  const c = ctx as { responder?: unknown; session?: { initiator?: unknown } };
  return hasConsoleTurnAuthorityTag({session:{auth:{current:c?.responder,initiator:c?.session?.initiator}}});
}
/** Fresh effective board plus APPLIED valid definition. No session or 30-second board cache.
 * These share locks last through a caller's transaction; a standalone policy read is a snapshot.
 */
export async function freshExactApprovalPolicy(db: AuthorityDatabase, agent: string, incarnation: string): Promise<string> {
  const {rows} = await db.query(`SELECT r.applied_definition FROM agent_resources r JOIN agent_definitions a ON a.name=r.name
    WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token
    AND r.state='ready' AND NOT r.pending AND a.status='valid' AND r.applied_definition IS NOT NULL FOR SHARE OF r,a`,[agent,incarnation]);
  if (rows.length !== 1) refuse();
  const d = parseDefinition(rows[0].applied_definition);
  if (d.name !== agent || !scopeAtLeast(grantFor(d,'deadline')?.scope ?? 'none','write-with-confirm')) refuse();
  const board = await db.query("SELECT level,updated_at FROM ratchet WHERE agent=$1 AND capability='deadline' AND action='' FOR SHARE",[agent]);
  const level = board.rows[0]?.level ?? autonomyOf(d,'deadline');
  if (!['gated','autonomous'].includes(level)) refuse();
  return payloadFingerprint('deadline_dismiss-policy-v1',{appliedDefinition:d,board:board.rows[0] ?? null,level,alwaysAsk:true});
}
async function rowForCall(db: AuthorityDatabase, callId: string): Promise<Row> {
  if (!callId) refuse();
  const {rows} = await db.query('SELECT * FROM approval_asks WHERE call_id=$1 FOR SHARE',[callId]);
  if (rows.length !== 1 || !rows[0].original_authority) refuse();
  return rows[0] as Row;
}
function exact(row: Row, tool: string, input: unknown, o: ExactApprovalOptions): Reservation {
  const r = reservationSchema.parse(row.original_authority);
  if (r.original.origin !== 'human' || !r.original.actingMemberId || r.original.spokenByMemberId !== r.original.actingMemberId ||
      row.acting_member_id !== r.original.actingMemberId || row.agent !== r.original.agentId || row.tool !== tool ||
      row.payload_hash !== payloadFingerprint(tool,input) || Date.parse(r.expiresAt) <= (o.now ?? new Date()).getTime()) refuse();
  return r;
}
async function current(r: Reservation, memberId: string, admissionNonce: string, sessionId: string, tool: string, input: unknown, o: ExactApprovalOptions) {
  const db = database(o), own = managedIdentity(o.env);
  if (!own || own.name !== r.original.agentId || own.incarnation !== r.incarnation || sessionId !== r.original.sessionId ||
      memberId !== r.original.actingMemberId || payloadFingerprint('admission',admissionNonce) !== r.admissionHash) refuse();
  const b = await requireConsoleSessionBinding({agent:own!.name,incarnation:own!.incarnation,sessionId,memberId,admissionNonce},db,o.env);
  // Binding revocation must wait until a protected local mutation commits.
  const locked = await db.query(`SELECT 1 FROM console_session_bindings WHERE agent=$1 AND incarnation=$2::uuid
    AND session_id=$3 AND member_id=$4 AND admission_nonce=$5 AND revoked_at IS NULL FOR SHARE`,
    [own!.name,own!.incarnation,sessionId,memberId,admissionNonce]);
  if (locked.rows.length !== 1) refuse();
  if (b.placeId !== r.original.placeId || b.audienceRevision !== r.original.audience.revision ||
      b.policyRevision !== r.original.policyRevision) refuse();
  if (await freshExactApprovalPolicy(db,own!.name,own!.incarnation) !== r.policyHash) refuse();
  const target = await supported(tool,o).readTarget(db,input,memberId);
  if (target.ownerMemberId !== memberId || !same(target,r.target)) refuse();
}
/** Called synchronously BEFORE returning user-approval. A conflict cannot rewrite a reservation. */
export async function reserveExactApproval(ctx: ConsoleAuthorityContext & {callId?:string;toolInput?:unknown}, tool: string, o: ExactApprovalOptions = {}): Promise<void> {
  const adapter = supported(tool,o), db = database(o);
  const original = await requireConsoleTurnAuthority(ctx,db,o.env), own = managedIdentity(o.env);
  const admission = consoleAdmission(ctx.session?.auth?.current), callId = callIdFrom(ctx);
  if (!own || !admission || !callId || !original.actingMemberId) refuse();
  const target = targetSchema.parse(await adapter.readTarget(db,ctx.toolInput,original.actingMemberId!));
  if (target.ownerMemberId !== original.actingMemberId) refuse();
  const policyHash = await freshExactApprovalPolicy(db,own!.name,own!.incarnation);
  const r: Reservation = {version:1,original,incarnation:own!.incarnation,
    admissionHash:payloadFingerprint('admission',admission!.admissionNonce),target,policyHash,
    expiresAt:new Date((o.now ?? new Date()).getTime()+APPROVAL_TTL_MS).toISOString()};
  await db.query(`INSERT INTO approval_asks(call_id,agent,tool,payload_hash,original_authority,acting_member_id,session_id,turn_sequence)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [callId,own!.name,tool,payloadFingerprint(tool,ctx.toolInput),JSON.stringify(r),original.actingMemberId,original.sessionId,ctx.session!.turn!.sequence]);
  const row = await rowForCall(db,callId!);
  const existing = exact(row,tool,ctx.toolInput,o);
  // Expiry belongs to the FIRST reservation and is never extended by a retry.
  if (!same({...existing,expiresAt:r.expiresAt},r) || row.outcome !== null) refuse();
}
/** input.requested is the first framework event that contains requestId. Strict failures throw. */
export async function attachExactApproval(a: {requestId:string;callId:string;tool:string;input:unknown}, db: AuthorityDatabase = getPool()): Promise<void> {
  const row = await rowForCall(db,a.callId);
  if (row.tool !== a.tool || row.payload_hash !== payloadFingerprint(a.tool,a.input)) refuse();
  const {rows} = await db.query(`UPDATE approval_asks SET request_id=$2 WHERE call_id=$1 AND original_authority IS NOT NULL
    AND (request_id IS NULL OR request_id=$2) RETURNING request_id`,[a.callId,a.requestId]);
  if (rows.length !== 1) refuse();
}
export interface ExactResponseContext {
  request: {requestId:string;callId:string;toolName:string;toolInput?:unknown}; responder: unknown;
  session: {id:string;initiator:unknown;turn?:unknown};
}
/** The actual responder is authenticated independently. Never borrow session.initiator. */
export async function approveExactResponse(ctx: ExactResponseContext, o: ExactApprovalOptions = {}): Promise<{status:'allowed'}> {
  supported(ctx.request.toolName,o);
  const db = database(o), row = await rowForCall(db,ctx.request.callId);
  const r = exact(row,ctx.request.toolName,ctx.request.toolInput,o);
  const responder = consoleAdmission(ctx.responder), initial = consoleAdmission(ctx.session.initiator);
  if (!row.request_id || row.request_id !== ctx.request.requestId || !responder || responder.purpose !== 'resolver' ||
      !initial || initial.purpose !== 'human' || initial.memberId !== responder.memberId || initial.admissionNonce !== responder.admissionNonce ||
      (row.outcome !== null && row.outcome !== 'approved')) refuse();
  await current(r,responder!.memberId,responder!.admissionNonce,ctx.session.id,ctx.request.toolName,ctx.request.toolInput,o);
  const result = await db.query(`UPDATE approval_asks SET outcome='approved',answered_at=COALESCE(answered_at,now()),
    answered_via='console',resolved_by_member_id=$3 WHERE call_id=$1 AND request_id=$2 AND original_authority IS NOT NULL
    AND (outcome IS NULL OR (outcome='approved' AND resolved_by_member_id=$3)) RETURNING call_id`,[row.call_id,row.request_id,responder!.memberId]);
  if (result.rows.length !== 1) refuse();
  return {status:'allowed'};
}
/** Exact call only. Returns provenance without mutating session.auth or conferring fresh-human authority. */
export async function requireApprovedExecution(ctx: ConsoleAuthorityContext, tool: string, input: unknown, o: ExactApprovalOptions = {}): Promise<Execution> {
  supported(tool,o);
  const row = await rowForCall(database(o),callIdFrom(ctx) ?? ''), r = exact(row,tool,input,o);
  const responder = consoleAdmission(ctx.session?.auth?.current), initial = consoleAdmission(ctx.session?.auth?.initiator);
  if (!row.request_id || row.outcome !== 'approved' || !responder || responder.purpose !== 'resolver' ||
      row.resolved_by_member_id !== responder.memberId || !initial || initial.purpose !== 'human' ||
      initial.memberId !== responder.memberId || initial.admissionNonce !== responder.admissionNonce) refuse();
  await current(r,responder!.memberId,responder!.admissionNonce,ctx.session?.id ?? '',tool,input,o);
  return {authority:{...r.original,origin:'approval-resume',actingMemberId:r.original.actingMemberId!,
    resolvedByMemberId:responder!.memberId,requestId:row.request_id!},target:r.target};
}
/** Terminal cancellation remains a refusal; legacy recorder cannot approve strict reservations. */
export async function settleExactInput(requestId: string, outcome: string, db: AuthorityDatabase = getPool()): Promise<void> {
  if (!['cancelled','ignored','invalid'].includes(outcome)) return;
  await db.query(`UPDATE approval_asks SET outcome=$2,answered_at=COALESCE(answered_at,now())
    WHERE request_id=$1 AND original_authority IS NOT NULL AND (outcome IS NULL OR outcome='approved')`,[requestId,outcome]);
}
