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
import { exactReservationSchema as reservationSchema, exactTargetSchema as targetSchema } from './exact-approval-request.js';
import { autonomyOf, grantFor, scopeAtLeast } from './manifest.js';
import { exactResolverAdmission, rememberAcceptedAnswer } from './private-console-resume.js';

export const EXACT_APPROVAL_REFUSED = 'Exact approval authority is unavailable or has changed';
const refuse = (): never => { throw new Error(EXACT_APPROVAL_REFUSED); };
/** A refusal an adapter writes for the model to read, such as a note title already in use. */
export class ApprovalRefusal extends Error {}
const NOT_PREPARED = 'This action could not be prepared for approval, so nothing was changed. Tell the person it is not available right now.';
export type ExactApprovalTarget = z.infer<typeof targetSchema>;
type Reservation = z.infer<typeof reservationSchema>;
export interface ExactApprovalAdapter {
  /** Tool names this purpose-built adapter can authorize. */
  toolNames: readonly string[];
  /** Read current content and stable ownership; lock the row when using a transaction client. */
  readTarget(db: AuthorityDatabase, input: unknown, memberId: string, tool?: string, ctx?: ConsoleAuthorityContext,
    reservedTarget?: ExactApprovalTarget): Promise<ExactApprovalTarget>;
  /** Hash the current, narrowly scoped policy under the same transaction/locks as target reads. */
  readPolicyHash(db: AuthorityDatabase, agent: string, incarnation: string): Promise<string>;
}
export interface ExactApprovalOptions {
  adapter?: ExactApprovalAdapter; db?: AuthorityDatabase; env?: NodeJS.ProcessEnv; now?: Date;
}
interface Row { request_id: string | null; call_id: string; agent: string; tool: string; payload_hash: string;
  used_at: unknown; session_id: string; original_authority: unknown; acting_member_id: string | null; resolved_by_member_id: string | null; outcome: string | null }
export interface ApprovedExecution {
  authority: Extract<TurnAuthority,{origin:'approval-resume'}>;
  target: ExactApprovalTarget;
  callId: string;
  toolName: string;
  payloadHash: string;
}
const database = (o: ExactApprovalOptions) => o.db ?? getPool();
const same = (a: unknown, b: unknown) => payloadFingerprint('authority',a) === payloadFingerprint('authority',b);
const supported = (tool: string, o: ExactApprovalOptions): ExactApprovalAdapter => {
  // Refuse before any authored policy can perform a provider-dependent lookup.
  if (!o.adapter || !o.adapter.toolNames.includes(tool)) throw new Error('Exact approval is unavailable for this action target');
  return o.adapter!;
};
export function isExactApprovalContext(ctx: unknown): boolean { return hasConsoleTurnAuthorityTag(ctx); }
/** Whether an approval ANSWER (eve's response-policy context) belongs to a bound console card.
 *  The person who answered is `ctx.response.principal`; the session's pinned opener is
 *  `ctx.session.initiator`. */
export function isExactApprovalResponse(ctx: unknown): boolean {
  const c = ctx as { response?: { principal?: unknown }; session?: { initiator?: unknown } };
  return hasConsoleTurnAuthorityTag({session:{auth:{current:c?.response?.principal,initiator:c?.session?.initiator}}});
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
  const board = await db.query("SELECT level,updated_at::text AS updated_at FROM ratchet WHERE agent=$1 AND capability='deadline' AND action='' FOR SHARE",[agent]);
  const level = board.rows[0]?.level ?? autonomyOf(d,'deadline');
  if (!['gated','autonomous'].includes(level)) refuse();
  return payloadFingerprint('deadline_dismiss-policy-v1',{appliedDefinition:d,board:board.rows[0] ?? null,level,alwaysAsk:true});
}
async function rowForCall(db: AuthorityDatabase, callId: string): Promise<Row> {
  if (!callId) refuse();
  const {rows} = await db.query('SELECT * FROM approval_asks WHERE call_id=$1 FOR UPDATE',[callId]);
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
async function current(r: Reservation, memberId: string, admissionNonce: string, sessionId: string, tool: string, input: unknown, o: ExactApprovalOptions, ctx?: ConsoleAuthorityContext) {
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
  if (await supported(tool,o).readPolicyHash(db,own!.name,own!.incarnation) !== r.policyHash) refuse();
  const target = await supported(tool,o).readTarget(db,input,memberId,tool,ctx,r.target);
  if (target.ownerMemberId !== memberId || !same(target,r.target)) refuse();
  // A grant can expire while policy/target locks are busy even when the approval still lives.
  // Recheck the same immutable binding and captured revision; never mint replacement authority.
  const finalBinding = await requireConsoleSessionBinding({agent:own!.name,incarnation:own!.incarnation,sessionId,memberId,admissionNonce},db,o.env);
  if (!same(finalBinding,b)) refuse();
  // Check approval time after the final authority read, immediately before approval/mutation.
  if (Date.parse(r.expiresAt) <= (o.now ?? new Date()).getTime()) refuse();
}
/** Called synchronously BEFORE returning user-approval. A conflict cannot rewrite a reservation. */
export async function reserveExactApproval(ctx: ConsoleAuthorityContext & {callId?:string;toolInput?:unknown}, tool: string, o: ExactApprovalOptions = {}): Promise<void> {
  const adapter = supported(tool,o), db = database(o);
  const original = await requireConsoleTurnAuthority(ctx,db,o.env), own = managedIdentity(o.env);
  const admission = consoleAdmission(ctx.session?.auth?.current), callId = callIdFrom(ctx);
  if (!own || !admission || !callId || !original.actingMemberId) refuse();
  const target = targetSchema.parse(await adapter.readTarget(db,ctx.toolInput,original.actingMemberId!,tool,ctx));
  if (target.ownerMemberId !== original.actingMemberId) refuse();
  const policyHash = await adapter.readPolicyHash(db,own!.name,own!.incarnation);
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
/** reserveExactApproval for an approval policy. eve parks a conversation whose policy throws,
 * leaving it on "is running…", so a refusal here becomes a denial with a reason the model reads:
 * an ApprovalRefusal's own words, anything else a plain "could not be prepared". Null: reserved. */
export async function reserveExactApprovalOrDeny(ctx: ConsoleAuthorityContext & {callId?:string;toolInput?:unknown}, tool: string,
  o: ExactApprovalOptions = {}): Promise<{type:'denied';reason:string} | null> {
  try { await reserveExactApproval(ctx,tool,o); return null; }
  catch (error) { return { type: 'denied', reason: error instanceof ApprovalRefusal ? error.message : NOT_PREPARED }; }
}
/** `interaction.opened` is the first framework event that names the card (`interactionId`, stored as the
 * request id). Strict failures throw. */
export async function attachExactApproval(a: {requestId:string;callId:string;tool:string;input:unknown}, db: AuthorityDatabase = getPool()): Promise<void> {
  const row = await rowForCall(db,a.callId);
  if (row.tool !== a.tool || row.payload_hash !== payloadFingerprint(a.tool,a.input)) refuse();
  const {rows} = await db.query(`UPDATE approval_asks SET request_id=$2 WHERE call_id=$1 AND original_authority IS NOT NULL
    AND (request_id IS NULL OR request_id=$2) RETURNING request_id`,[a.callId,a.requestId]);
  if (rows.length !== 1) refuse();
}
/** What eve's response policy hands over (`ApprovalResponseContext`), as far as this file reads it. */
export interface ExactResponseContext {
  request: {interactionId:string;callId:string;toolName:string;toolInput?:unknown};
  response: {decision:'approve'|'deny'; principal: unknown};
  session: {id:string;initiator:unknown;turn?:unknown};
}
/** The actual responder is authenticated independently. Never borrow session.initiator.
 *
 * eve 1.0 asks this policy about a DENY as well as an APPROVE. The rule is one rule: only the
 * person who may approve this card may deny it. Every check below runs for both; they differ in
 * exactly two ways. The option the console named must match the decision eve is acting on, and a
 * Deny writes nothing (no approval is recorded; `settleExactInput` records the Deny when eve
 * settles the card). A Deny from anyone else is refused exactly like their Approve, the card stays
 * pending, and nothing is recorded. A decision that is neither `approve` nor `deny` is refused. */
export async function approveExactResponse(ctx: ExactResponseContext, o: ExactApprovalOptions = {}): Promise<{status:'allowed'}> {
  const decision = ctx.response?.decision;
  if (decision !== 'approve' && decision !== 'deny') refuse();
  supported(ctx.request.toolName,o);
  const db = database(o), row = await rowForCall(db,ctx.request.callId);
  const r = exact(row,ctx.request.toolName,ctx.request.toolInput,o);
  const principal = ctx.response.principal;
  const responder = consoleAdmission(principal), initial = consoleAdmission(ctx.session.initiator), answered = exactResolverAdmission(principal);
  if (!row.request_id || row.request_id !== ctx.request.interactionId || !responder || responder.purpose !== 'resolver' ||
      answered?.requestId !== row.request_id || answered.optionId !== decision ||
      !initial || initial.purpose !== 'human' || initial.memberId !== responder.memberId || initial.admissionNonce !== responder.admissionNonce ||
      (decision === 'approve' ? (row.outcome !== null && row.outcome !== 'approved') : row.outcome !== null)) refuse();
  await current(r,responder!.memberId,responder!.admissionNonce,ctx.session.id,ctx.request.toolName,ctx.request.toolInput,o,
    {toolName:ctx.request.toolName,session:{id:ctx.session.id,turn:ctx.session.turn as never,auth:{current:principal,initiator:ctx.session.initiator}}} as ConsoleAuthorityContext);
  // The turn continues as the person who asked; it finds this answer only through this record.
  const who = {memberId:responder!.memberId,admissionNonce:responder!.admissionNonce};
  if (decision === 'deny') { rememberAcceptedAnswer(ctx,who,o.env); return {status:'allowed'}; }
  const result = await db.query(`UPDATE approval_asks SET outcome='approved',answered_at=COALESCE(answered_at,now()),
    answered_via='console',resolved_by_member_id=$3 WHERE call_id=$1 AND request_id=$2 AND original_authority IS NOT NULL
    AND (outcome IS NULL OR (outcome='approved' AND resolved_by_member_id=$3)) RETURNING call_id`,[row.call_id,row.request_id,responder!.memberId]);
  if (result.rows.length !== 1) refuse();
  rememberAcceptedAnswer(ctx,who,o.env);
  return {status:'allowed'};
}
/**
 * WHO IS WHO ON eve 1.0. An approved call runs, and its request policy is asked again before it,
 * as the person who ASKED: `ctx.session.auth.current` is the requester, never the person who
 * answered (`docs/tools/human-in-the-loop.md`, "Act as the approver"; `harness/hitl/approved-calls.js`
 * runs the call with the requester's context). The answerer is only `ctx.approval.responder`, and it
 * exists only while the approved call runs. The policy RE-CHECK before it sees no responder at all.
 * So this file never looks for the answerer in `session.auth.current`:
 *   - at execution: `requireApprovedExecution` reads the answerer from `ctx.approval.responder`;
 *     a missing or unverifiable responder means NOT approved;
 *   - at the re-check: `requireApprovedRecheck` has no responder to read, so it relies on the card
 *     the response policy wrote (`outcome = 'approved'`, `resolved_by_member_id`), which only
 *     `approveExactResponse` writes after verifying the authenticated resolver.
 */

/** The framework's own mark on a policy context during the re-check before an approved call runs
 *  (`dist/src/approval/evaluation.js`, `Symbol.for("eve.approval-evaluation")`). Pinned by a test
 *  that drives the real `evaluateApproval`. Anything else is a first request. */
export function isApprovalRecheck(ctx: unknown): boolean {
  const mark = (ctx as Record<symbol, { recheck?: unknown } | undefined> | null | undefined)?.[Symbol.for('eve.approval-evaluation')];
  return mark?.recheck === true;
}
/** The person who approved the call that is running, as eve gives it to the tool (`ctx.approval.responder`). */
export function approvalResponderOf(ctx: unknown): unknown {
  return (ctx as { approval?: { responder?: unknown } } | null | undefined)?.approval?.responder;
}
/** The requester's human admission and the pinned initiator's must be the same member and admission. */
function humanRequester(ctx: ConsoleAuthorityContext) {
  const requester = consoleAdmission(ctx.session?.auth?.current), initial = consoleAdmission(ctx.session?.auth?.initiator);
  if (!requester || requester.purpose !== 'human' || !initial || initial.purpose !== 'human' ||
      initial.memberId !== requester.memberId || initial.admissionNonce !== requester.admissionNonce) refuse();
  return requester!;
}
/** Exact call only, at execution. Returns provenance without mutating session.auth or conferring fresh-human authority.
 *  The answerer must be `ctx.approval.responder`: an authenticated resolver admission for this card, naming Approve,
 *  of the very member (and admission) who asked. */
export async function requireApprovedExecution(ctx: ConsoleAuthorityContext, tool: string, input: unknown, o: ExactApprovalOptions = {}): Promise<ApprovedExecution> {
  supported(tool,o);
  const row = await rowForCall(database(o),callIdFrom(ctx) ?? ''), r = exact(row,tool,input,o);
  const requester = humanRequester(ctx);
  const answer = approvalResponderOf(ctx), responder = consoleAdmission(answer), answered = exactResolverAdmission(answer);
  // Cards raised in one step settle together under the last answer, so this answer may name a
  // sibling card. Each call still needs its own approved row. A Deny never runs anything.
  if (!row.request_id || row.outcome !== 'approved' || !responder || responder.purpose !== 'resolver' ||
      answered?.requestId !== row.request_id || answered.optionId !== 'approve' ||
      row.resolved_by_member_id !== responder.memberId ||
      requester.memberId !== responder.memberId || requester.admissionNonce !== responder.admissionNonce) refuse();
  await current(r,responder!.memberId,responder!.admissionNonce,ctx.session?.id ?? '',tool,input,o,ctx);
  return {authority:{...r.original,origin:'approval-resume',actingMemberId:r.original.actingMemberId!,
    resolvedByMemberId:responder!.memberId,requestId:row.request_id!},target:r.target,
    callId:row.call_id,toolName:row.tool,payloadHash:row.payload_hash};
}
/** The re-check before an approved call runs: the call must already be approved by the requester, on the
 *  card the response policy wrote. It sees no responder, so it checks the stored card, not the context. */
export async function requireApprovedRecheck(ctx: ConsoleAuthorityContext & {callId?:string}, tool: string, input: unknown, o: ExactApprovalOptions = {}): Promise<void> {
  supported(tool,o);
  const row = await rowForCall(database(o),callIdFrom(ctx) ?? ''), r = exact(row,tool,input,o);
  const requester = humanRequester(ctx);
  if (!row.request_id || row.outcome !== 'approved' || row.resolved_by_member_id !== requester.memberId) refuse();
  await current(r,requester.memberId,requester.admissionNonce,ctx.session?.id ?? '',tool,input,o,ctx);
}
/** Trusted broker seam. Identity comes from the signed runtime and the current session binding;
 * approval comes only from the immutable ask and its independently authenticated resolver.
 * This returns exact-call provenance, never human-turn or general Vault authority. Call inside
 * authorityTransaction; the caller must atomically claim used_at before issuing a capability. */
export async function requireBoundExactApproval(binding: {agent:string;incarnation:string;sessionId:string;memberId:string;admissionNonce:string;callId:string},
  tool:string,input:unknown,o:ExactApprovalOptions & {claimed?:boolean} = {}):Promise<ApprovedExecution & {expiresAt:number}> {
  const row=await rowForCall(database(o),binding.callId),r=exact(row,tool,input,o);
  if(!row.request_id||row.outcome!=='approved'||row.acting_member_id!==binding.memberId||row.resolved_by_member_id!==binding.memberId||
      row.session_id!==binding.sessionId||row.agent!==binding.agent||r.incarnation!==binding.incarnation||
      (o.claimed ? row.used_at == null : row.used_at != null))refuse();
  await current(r,binding.memberId,binding.admissionNonce,binding.sessionId,tool,input,{...o,
    env:{...o.env,LARES_AGENT_NAME:binding.agent,LARES_AGENT_INCARNATION:binding.incarnation}});
  return {authority:{...r.original,origin:'approval-resume',actingMemberId:binding.memberId,
    resolvedByMemberId:binding.memberId,requestId:row.request_id!},target:r.target,callId:row.call_id,
    toolName:row.tool,payloadHash:row.payload_hash,expiresAt:Date.parse(r.expiresAt)};
}
/** Terminal cancellation remains a refusal; legacy recorder cannot approve strict reservations. */
export async function settleExactInput(requestId: string, outcome: string, db: AuthorityDatabase = getPool()): Promise<void> {
  if (!['cancelled','ignored','invalid'].includes(outcome)) return;
  await db.query(`UPDATE approval_asks SET outcome=$2,answered_at=COALESCE(answered_at,now())
    WHERE request_id=$1 AND original_authority IS NOT NULL AND (outcome IS NULL OR outcome='approved')`,[requestId,outcome]);
}
