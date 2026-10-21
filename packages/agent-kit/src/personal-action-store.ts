/** Server-only encrypted personal proposals. Parsing never authenticates an actor. Only trusted
 * admission code may prepare/link/claim actions. This is NOT current dispatch authority: a future
 * executor must revalidate org/member/account/resource/credential, then action→approval→binding
 * on ONE checked-out client, in a separate transaction after the durable claim has committed.
 * No tools, provider calls, leases, retries of dispatch, or missing-action creation live here.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { APPROVAL_TTL_MS, payloadFingerprint } from './approval-ledger.js';
import { currentMember } from './member-store.js';
import { cutoffFor, readRetentionMonths, EARLIEST_SANE_CLOCK, PRUNE_FLOOR_DAYS } from './conversation-record.js';

export const PERSONAL_MAIL_SEND_TOOL = 'personal_mailbox_send';
const PURPOSE = 'lares.personal-action.v1';
const id = z.string().min(1).max(512).refine(s => !/[\x00-\x1f\x7f]/.test(s));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const header = z.string().max(998).refine(s => Buffer.byteLength(s,'utf8')<=998 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(s));
const mailSchema = z.strictObject({
  to: z.array(z.email().max(254).refine(s => !/[\x00-\x20\x7f]/.test(s))).min(1).max(50),
  subject: header,
  body: z.string().max(100_000).refine(s => Buffer.byteLength(s,'utf8')<=100_000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(s)),
});
export type PersonalMailPayload = z.infer<typeof mailSchema>;
const selectionSchema = z.strictObject({ actorMemberId: id, agentId: id, incarnation: z.uuid(),
  sessionId: id, originalTurnId: id, originalCallId: id, accountId: id,
  accountGeneration: z.number().int().nonnegative(), resourceBindingId: id, connectorId: id,
  kind: z.literal('mail.send') });
export type PersonalActionSelection = z.infer<typeof selectionSchema>;
const prepareSchema = selectionSchema.extend({ payload: mailSchema });
export type TrustedPersonalActionEnvelope = z.infer<typeof prepareSchema>;
const approvalReferenceSchema = z.strictObject({ actionId: z.uuid(), payloadHash: hash,
  approvalCallId: id, requestId: id, resolvedByMemberId: id, selection: selectionSchema });
export type PersonalActionApprovedReference = z.infer<typeof approvalReferenceSchema>;
const receiptSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('accepted'), providerReceiptId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:@/+=-]+$/) }),
  z.strictObject({ state: z.literal('rejected'), code: z.enum(['provider_refused','invalid_recipient','rate_limited']) }),
  z.strictObject({ state: z.literal('not_dispatched'), code: z.enum(['authority_changed','expired','policy_refused','credential_unavailable']) }),
  z.strictObject({ state: z.literal('unknown'), code: z.enum(['transport_uncertain','process_interrupted']) }),
]);
export type PersonalActionReceipt = z.infer<typeof receiptSchema>;
export type PersonalActionState = 'awaiting_approval'|'awaiting_dispatch'|'claimed'|'cancelled'|'expired'|PersonalActionReceipt['state'];
export interface PersonalActionOutcome { actionId: string; payloadHash: string; expiresAt: string;
  state: PersonalActionState; attemptId: string|null; receipt: PersonalActionReceipt|null }
/** The pair is already bound to the existing server key by trusted composition code. No key
 * configuration, key path, secret reference or crypto implementation enters this package. */
export interface PersonalActionCrypto { encrypt(plaintext: string): string; decrypt(ciphertext: string): string }
export class PersonalActionError extends Error {
  constructor() { super('Personal action unavailable or changed'); this.name='PersonalActionError'; }
}
function refuse():never { throw new PersonalActionError(); }
interface Row { id:string; payload_version:1; actor_member_id:string; agent:string; incarnation:string;
  session_id:string; original_turn_id:string; original_call_id:string; original_call_hash:string;
  account_id:string; account_generation:number; resource_binding_id:string; connector_id:string;
  kind:'mail.send'; payload_hash:string; payload_ciphertext:string; approval_call_id:string|null;
  approval_request_id:string|null; created_at:Date; expires_at:Date; state:PersonalActionState;
  attempt_id:string|null; claimed_at:Date|null; receipt:PersonalActionReceipt|null }
function selection(r:Row):PersonalActionSelection { return {actorMemberId:r.actor_member_id,agentId:r.agent,
  incarnation:r.incarnation,sessionId:r.session_id,originalTurnId:r.original_turn_id,originalCallId:r.original_call_id,
  accountId:r.account_id,accountGeneration:r.account_generation,resourceBindingId:r.resource_binding_id,
  connectorId:r.connector_id,kind:r.kind}; }
const same=(a:unknown,b:unknown)=>payloadFingerprint(PURPOSE,a)===payloadFingerprint(PURPOSE,b);
function outcome(r:Row):PersonalActionOutcome { return {actionId:r.id,payloadHash:r.payload_hash,expiresAt:r.expires_at.toISOString(),
  state:r.state,attemptId:r.attempt_id,receipt:r.receipt===null?null:receiptSchema.parse(r.receipt)}; }
function originalHash(s:PersonalActionSelection):string {
  return createHash('sha256').update([s.agentId,s.incarnation.toLowerCase(),s.sessionId,s.originalTurnId,s.originalCallId]
    .map(v=>`${[...v].length}:${v}`).join('')).digest('hex');
}
/** The ledger descriptor contains identifiers and a hash, never plaintext or custody coordinates. */
export function personalActionApprovalDescriptor(action:PersonalActionOutcome, s:PersonalActionSelection) {
  return {purpose:PURPOSE,version:1,actionId:action.actionId,payloadHash:action.payloadHash,
    selection:selectionSchema.parse(s),expiresAt:action.expiresAt};
}
// Only a live winning claim can mint these process-local opaque values. Durable replay cannot.
declare const claimBrand:unique symbol;
export type PersonalActionClaimPermit = Readonly<{[claimBrand]:true}>;
interface PermitData { row:Row; payload:PersonalMailPayload; consumed:boolean }

export class PgPersonalActionStore {
  private readonly permits=new WeakMap<object,PermitData>();
  constructor(private readonly pool:Pool, private readonly crypto:PersonalActionCrypto) {}
  private async transaction<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T> {
    const db=await this.pool.connect();
    try { await db.query('BEGIN'); const result=await fn(db); await db.query('COMMIT'); return result; }
    catch(e) { try { await db.query('ROLLBACK'); } catch { /* An uncertain COMMIT never returns a permit. */ } throw e; }
    finally { db.release(); }
  }
  private async row(db:PoolClient,actionId:string,actorMemberId:string):Promise<Row> {
    const {rows}=await db.query<Row>('SELECT * FROM personal_actions WHERE id=$1 AND actor_member_id=$2 FOR UPDATE',[actionId,actorMemberId]);
    if (!rows[0]) refuse(); return rows[0];
  }
  private payload(r:Row):PersonalMailPayload {
    try {
      const sealed=z.strictObject({purpose:z.literal(PURPOSE),version:z.literal(1),actionId:z.uuid(),
        selection:selectionSchema,payload:mailSchema}).parse(JSON.parse(this.crypto.decrypt(r.payload_ciphertext)));
      if (r.payload_version!==1 || sealed.actionId!==r.id || !same(sealed.selection,selection(r)) ||
          payloadFingerprint(r.kind,sealed.payload)!==r.payload_hash) refuse();
      return sealed.payload;
    } catch { return refuse(); }
  }
  async prepareAction(input:TrustedPersonalActionEnvelope):Promise<PersonalActionOutcome> {
    const {payload,...s}=prepareSchema.parse(input); s.incarnation=s.incarnation.toLowerCase();
    const original=originalHash(s), fingerprint=payloadFingerprint(s.kind,payload);
    return this.transaction(async db=>{
      // Serialise preparation even when no action row exists; tombstones survive content erasure.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[original]);
      if (!await currentMember(db,s.actorMemberId)) refuse();
      const found=await db.query<Row>('SELECT * FROM personal_actions WHERE original_call_hash=$1 FOR UPDATE',[original]);
      if(found.rows[0]) {
        const r=found.rows[0];
        if(!same(selection(r),s)||r.payload_hash!==fingerprint||!same(this.payload(r),payload)) refuse();
        return outcome(r);
      }
      if((await db.query('SELECT 1 FROM personal_action_calls WHERE original_call_hash=$1',[original])).rowCount) refuse();
      const actionId=randomUUID();
      const ciphertext=this.crypto.encrypt(JSON.stringify({purpose:PURPOSE,version:1,actionId,selection:s,payload}));
      const {rows}=await db.query<Row>(`INSERT INTO personal_actions(id,payload_version,actor_member_id,agent,incarnation,
        session_id,original_turn_id,original_call_id,original_call_hash,account_id,account_generation,resource_binding_id,
        connector_id,kind,payload_hash,payload_ciphertext,created_at,expires_at)
        SELECT $1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,t,t+($16*interval '1 millisecond')
        FROM (SELECT clock_timestamp() AS t) clock RETURNING *`,[actionId,s.actorMemberId,s.agentId,s.incarnation,
        s.sessionId,s.originalTurnId,s.originalCallId,original,s.accountId,s.accountGeneration,s.resourceBindingId,
        s.connectorId,s.kind,fingerprint,ciphertext,APPROVAL_TTL_MS]);
      return outcome(rows[0]);
    });
  }
  private async approval(db:PoolClient,r:Row,callId:string,requestId:string,approvedBy?:string):Promise<void> {
    const {rows}=await db.query(`SELECT * FROM approval_asks WHERE call_id=$1 FOR UPDATE`,[callId]);
    const a=rows[0];
    if(!a||a.request_id!==requestId||a.tool!==PERSONAL_MAIL_SEND_TOOL||a.agent!==r.agent||
      a.acting_member_id!==r.actor_member_id||a.session_id!==r.session_id||a.payload_hash!==r.payload_hash||
      !same(a.original_authority,personalActionApprovalDescriptor(outcome(r),selection(r)))) refuse();
    if(approvedBy!==undefined&&(approvedBy!==r.actor_member_id||a.resolved_by_member_id!==approvedBy||a.outcome!=='approved'||!a.answered_at)) refuse();
    // Exact reservation expiry AND the existing ledger TTL use the DB clock after lock waits.
    const alive=await db.query('SELECT $1::timestamptz>clock_timestamp() AND $2::timestamptz+($3*interval \'1 millisecond\')>clock_timestamp() AS alive',
      [r.expires_at,a.asked_at,APPROVAL_TTL_MS]);
    if(!alive.rows[0].alive) refuse();
  }
  async attachApproval(input:{actionId:string;actorMemberId:string;approvalCallId:string;requestId:string}):Promise<PersonalActionOutcome> {
    const a=z.strictObject({actionId:z.uuid(),actorMemberId:id,approvalCallId:id,requestId:id}).parse(input);
    return this.transaction(async db=>{
      const r=await this.row(db,a.actionId,a.actorMemberId);
      if(r.state!=='awaiting_approval'&&!(r.state==='awaiting_dispatch'&&r.approval_call_id===a.approvalCallId&&r.approval_request_id===a.requestId)) refuse();
      await this.approval(db,r,a.approvalCallId,a.requestId);
      const {rows}=await db.query<Row>(`UPDATE personal_actions SET approval_call_id=$2,approval_request_id=$3,state='awaiting_dispatch' WHERE id=$1 RETURNING *`,[r.id,a.approvalCallId,a.requestId]);
      return outcome(rows[0]);
    });
  }
  async claimAction(input:PersonalActionApprovedReference):Promise<{outcome:PersonalActionOutcome;permit?:PersonalActionClaimPermit}> {
    const a=approvalReferenceSchema.parse(input);
    const result=await this.transaction(async db=>{
      const r=await this.row(db,a.actionId,a.selection.actorMemberId);
      if(!same(selection(r),a.selection)||r.payload_hash!==a.payloadHash||r.approval_call_id!==a.approvalCallId||r.approval_request_id!==a.requestId) refuse();
      if(r.state!=='awaiting_dispatch') return {row:r}; // No attempt, payload or permit on replay.
      const expired=await db.query('SELECT $1::timestamptz<=clock_timestamp() AS expired',[r.expires_at]);
      if(expired.rows[0].expired) {
        const {rows}=await db.query<Row>("UPDATE personal_actions SET state='expired' WHERE id=$1 RETURNING *",[r.id]);
        return {row:rows[0]};
      }
      await this.approval(db,r,a.approvalCallId,a.requestId,a.resolvedByMemberId);
      const payload=this.payload(r),attempt=randomUUID();
      const {rows}=await db.query<Row>(`UPDATE personal_actions SET state='claimed',attempt_id=$2,claimed_at=clock_timestamp()
        WHERE id=$1 AND state='awaiting_dispatch' AND expires_at>clock_timestamp()
        AND EXISTS(SELECT 1 FROM approval_asks WHERE call_id=$3 AND outcome='approved'
          AND asked_at+($4*interval '1 millisecond')>clock_timestamp()) RETURNING *`,[r.id,attempt,a.approvalCallId,APPROVAL_TTL_MS]);
      if(!rows[0]) refuse();
      return {row:rows[0],payload};
    });
    if(!result.payload) return {outcome:outcome(result.row)};
    const permit=Object.freeze({}) as PersonalActionClaimPermit;
    this.permits.set(permit,{row:result.row,payload:result.payload,consumed:false});
    return {outcome:outcome(result.row),permit};
  }
  /** Future executor only, AFTER fresh dispatch-authority validation. This does not validate
   * that authority. Consumption is process-local and one-time; there is no durable recovery. */
  consumeClaimPermit(permit:PersonalActionClaimPermit):{actionId:string;attemptId:string;selection:PersonalActionSelection;payload:PersonalMailPayload} {
    const p=this.permits.get(permit); if(!p||p.consumed) refuse(); p.consumed=true;
    return {actionId:p.row.id,attemptId:p.row.attempt_id!,selection:selection(p.row),payload:structuredClone(p.payload)};
  }
  async recordOutcome(permit:PersonalActionClaimPermit,input:PersonalActionReceipt):Promise<PersonalActionOutcome> {
    const receipt=receiptSchema.parse(input),p=this.permits.get(permit); if(!p) refuse();
    const result=await this.transaction(async db=>{
      const r=await this.row(db,p.row.id,p.row.actor_member_id);
      if(r.attempt_id!==p.row.attempt_id) refuse();
      if(r.state!=='claimed') { if(!same(r.receipt,receipt)) refuse(); return outcome(r); }
      const {rows}=await db.query<Row>(`UPDATE personal_actions SET state=$2,receipt=$3::jsonb,completed_at=clock_timestamp()
        WHERE id=$1 AND state='claimed' AND attempt_id=$4 RETURNING *`,[r.id,receipt.state,JSON.stringify(receipt),r.attempt_id]);
      if(!rows[0]) refuse(); return outcome(rows[0]);
    });
    p.consumed=true;
    return result;
  }
  async readOutcome(actorMemberId:string,actionId:string):Promise<PersonalActionOutcome> {
    return this.transaction(async db=>{
      if(!await currentMember(db,id.parse(actorMemberId))) refuse();
      return outcome(await this.row(db,z.uuid().parse(actionId),actorMemberId));
    });
  }
  async cancelUnclaimedAction(actorMemberId:string,actionId:string):Promise<PersonalActionOutcome> {
    return this.transaction(async db=>{
      if(!await currentMember(db,id.parse(actorMemberId))) refuse();
      const r=await this.row(db,z.uuid().parse(actionId),actorMemberId);
      if(r.state==='cancelled') return outcome(r);
      if(!['awaiting_approval','awaiting_dispatch'].includes(r.state)) refuse();
      const {rows}=await db.query<Row>("UPDATE personal_actions SET state='cancelled' WHERE id=$1 RETURNING *",[r.id]);
      return outcome(rows[0]);
    });
  }
  /** Same conversation-retention setting/default. Removing ciphertext never removes suppression.
   * A missing action is always refused by claim; only trusted admission may prepare new calls. */
  async pruneForMember(actorMemberId:string,now:Date):Promise<number> {
    id.parse(actorMemberId);
    if(!Number.isFinite(now.getTime())||now<EARLIEST_SANE_CLOCK) refuse();
    const window=cutoffFor(await readRetentionMonths(this.pool,actorMemberId),now);
    if(!window) return 0;
    const floor=new Date(now);floor.setUTCDate(floor.getUTCDate()-PRUNE_FLOOR_DAYS);
    const cutoff=window<floor?window:floor;
    const r=await this.pool.query('DELETE FROM personal_actions WHERE actor_member_id=$1 AND created_at<$2',[actorMemberId,cutoff]);
    return r.rowCount??0;
  }
}
