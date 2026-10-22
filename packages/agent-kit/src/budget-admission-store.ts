import {consoleSourceTransaction,checkConsoleSourceDeadlines,SourceAuthorityDenied,noteBudgetFinancialChange,type SourceTransactionBoundary} from './console-source-transaction.js';
/** Server-only, inactive budget admission. Parsing a reference is NOT authentication.
 * Trusted request/gateway/recovery adapters must supply the observations below. No runtime
 * hook, HTTP endpoint, model tool, account opener or recovery reset is exported here. */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { type ConsoleAuthorityContext } from './console-turn-authority.js';
import { PgGrantStore } from './grant-store.js';
import { payloadFingerprint } from './approval-ledger.js';
import { currentModelInvocation, MODEL_INVOCATION_REFUSED } from './model-invocation.js';
import { captureBudgetAuthorityReference, validateBudgetAuthorityReference, type BudgetAuthorityReference } from './budget-model-authority.js';

const SCALE=10n**18n;
/** At most 18 integral and 18 fractional digits, no exponent/sign/nonfinite values. */
export function canonicalBudgetMoney(value:unknown):string {
  if(typeof value!=='string'||! /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/.test(value))throw new Error('Invalid budget amount');
  const [whole,fraction='']=value.split('.'),trimmed=fraction.replace(/0+$/,'');
  return whole+(trimmed?'.'+trimmed:'');
}
function totalUnits(value:string):bigint {const [a,b='']=value.split('.');return BigInt(a!)*SCALE+BigInt(b.padEnd(18,'0'));}
function units(value:unknown):bigint {return totalUnits(canonicalBudgetMoney(value));}
function decimal(value:bigint):string {const fraction=(value%SCALE).toString().padStart(18,'0').replace(/0+$/,'');return (value/SCALE).toString()+(fraction?'.'+fraction:'');}
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const validHash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
/** Inject the existing protected installation key; this creates no key store. Never use
 * unkeyed hashes for guessable canonical/provider identities. Exact issuer/subject/tenant,
 * never email, determines provider suppression. */
export function budgetIdentitySuppression(key:Uint8Array,identity:{canonicalMemberId:string;providers:{issuer:string;subject:string;tenantId:string}[]}) {
  if(key.byteLength<32||!identity.canonicalMemberId||!identity.providers.length)throw new Error('Budget identity proof required');
  const digest=(domain:string,value:unknown)=>createHmac('sha256',key).update(JSON.stringify(['lares.budget.suppression.v1',domain,value])).digest('hex');
  return {canonicalSuppressionHash:digest('canonical',identity.canonicalMemberId),providerSuppressionHashes:[...new Set(identity.providers.map(p=>{
    if(!p.issuer||!p.subject||typeof p.tenantId!=='string')throw new Error('Budget identity proof required');
    return digest('provider',[p.issuer,p.subject,p.tenantId]);
  }))].sort()};
}
export interface BudgetRequestReference {bindingId:string;requestHash:string;profileHash:string}
/** Obtained from the actual selected gateway request, never its user-supplied billing tags. */
export interface BudgetGatewayObservation {requestHash:string;profileHash:string;endpointHash:string;credentialGeneration:string;keyFingerprint:string;agent:string;incarnation:string;purposeAlias:string}
/** MUST come from the trusted non-rollback recovery witness, outside this transaction. A DB
 * epoch by itself does not prove restore safety. No witness integration is enabled here. */
export interface BudgetRecoveryReference {installationAccountId:string;epoch:string;endpointGeneration:string;state:'reconciled'|'unreconciled'}
export interface BudgetTerminalReceipt {attemptId:string;bindingId:string;requestHash:string;endpointHash:string;credentialGeneration:string;profileHash:string;receiptHash:string;actualAmount:string;kind:'terminal-usage'|'affirmative-nondispatch'}
export interface BudgetStatus {state:string;reason:string;cap:string|null;liability:string|null;windowId:string|null}
export interface BudgetDispatchPermit {readonly kind:'budget-dispatch-permit'}
/** Discovery is not authority. admit() independently revalidates the persisted reference. */
export interface BudgetGatewayTicket {
  agent:string;incarnation:string;credentialGeneration:string;installationAccountId:string;
  epoch:string;endpointGeneration:string;bindingId:string;requestHash:string;profileHash:string;
  endpointHash:string;maximumLiability:string;pricingProfile:unknown;
}
export interface BudgetGatewaySettlement {
  attemptId:string;bindingId:string;requestHash:string;profileHash:string;endpointHash:string;
  credentialGeneration:string;grantHash:string;pricingProfile:unknown;
}
export type BudgetAdmission = {state:'allowed';permit:BudgetDispatchPermit;attemptId:string}|{state:'denied'|'unavailable';reason:string};
export type BudgetFinancialOperation='prepare'|'provision'|'admit'|'grant'|'unknown'|'settle'|'member-remove';
export interface BudgetFinancialWriter {
  run<T>(operation:BudgetFinancialOperation,work:(boundary:SourceTransactionBoundary,operationId:string)=>Promise<T>):Promise<T>;
}
type Ref=BudgetAuthorityReference;
const permits=new WeakMap<object,{attemptId:string;bindingId:string;requestHash:string}>();
/** Burn synchronously BEFORE the first await/transport call; a thrown transport consumes it. */
export function consumeDispatchPermit(permit:BudgetDispatchPermit):{attemptId:string;bindingId:string;requestHash:string}|undefined {
  const result=permits.get(permit);permits.delete(permit);return result;
}
const DENIED={state:'denied',reason:'Budget authority is unavailable or changed'} as const;
type Row=Record<string,any>;
export class PgBudgetAdmissionStore {
  constructor(private readonly pool:Pool,private readonly env:NodeJS.ProcessEnv=process.env,private readonly intentLifetimeMs=30_000,private readonly financialWriter?:BudgetFinancialWriter) {
    if(!Number.isSafeInteger(intentLifetimeMs)||intentLifetimeMs<1||intentLifetimeMs>30_000)throw new Error('Invalid intent lifetime');
  }
  private async transaction<T>(fn:(db:PoolClient)=>Promise<T>,operation?:BudgetFinancialOperation):Promise<T> {
    const work=(boundary?:SourceTransactionBoundary)=>consoleSourceTransaction(this.pool,db=>fn(db as PoolClient),boundary);
    return operation&&this.financialWriter?this.financialWriter.run(operation,work):work();
  }
  /** Unlocked routing only; the pool query releases its client before owned admission. */
  async discoverGatewayTicket(ticket:string):Promise<BudgetGatewayTicket|undefined> {
    if(typeof ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ticket))return undefined;
    const r=(await this.pool.query(`SELECT a.*,b.agent,b.incarnation,b.maximum_liability,b.pricing_profile
      FROM budget_attempts a JOIN budget_gateway_bindings b ON b.id=a.binding_id WHERE a.ticket_hash=$1 AND a.state='prepared'`,[hash(ticket)])).rows[0];
    if(!r)return undefined;
    return {agent:r.agent,incarnation:r.incarnation,credentialGeneration:r.credential_generation,installationAccountId:r.installation_account_id,epoch:r.recovery_epoch,endpointGeneration:r.endpoint_generation,bindingId:r.binding_id,requestHash:r.request_hash,profileHash:r.profile_hash,endpointHash:r.endpoint_hash,maximumLiability:r.maximum_liability,pricingProfile:r.pricing_profile};
  }
  /** Called AFTER acknowledged admission and synchronous permit consumption. A duplicate or
   * uncertain COMMIT never recovers a grant or reissues an allow. No client is borrowed. */
  async recordGatewayGrant(reference:{attemptId:string;bindingId:string;requestHash:string},grantHash:string):Promise<boolean> {
    if(!uuid(reference.attemptId)||!uuid(reference.bindingId)||!validHash(reference.requestHash)||!validHash(grantHash))return false;
    return this.transaction(async db=>{
      const found=(await db.query('SELECT * FROM budget_attempts WHERE id=$1',[reference.attemptId])).rows[0];if(!found)return false;
      await this.locks(db,found.installation_account_id,found.member_account_id,found.binding_id);
      const a=(await db.query('SELECT * FROM budget_attempts WHERE id=$1 FOR UPDATE',[found.id])).rows[0];
      if(a.state!=='admitted'||a.binding_id!==reference.bindingId||a.request_hash!==reference.requestHash)return false;
      const inserted=(await db.query('INSERT INTO budget_gateway_grants(attempt_id,grant_hash) VALUES($1,$2) ON CONFLICT(attempt_id) DO NOTHING RETURNING attempt_id',[a.id,grantHash])).rows.length===1;
      if(inserted)noteBudgetFinancialChange(db,'budget_gateway_grants',a.id);return inserted;
    },'grant');
  }
  /** Immutable financial correlation survives current identity redaction and key rotation. */
  async gatewaySettlement(attemptId:string):Promise<BudgetGatewaySettlement|undefined> {
    if(!uuid(attemptId))return undefined;
    const a=(await this.pool.query(`SELECT a.*,g.grant_hash,b.pricing_profile FROM budget_attempts a
      JOIN budget_gateway_grants g ON g.attempt_id=a.id JOIN budget_gateway_bindings b ON b.id=a.binding_id WHERE a.id=$1`,[attemptId])).rows[0];
    return a?{attemptId:a.id,bindingId:a.binding_id,requestHash:a.request_hash,profileHash:a.profile_hash,endpointHash:a.endpoint_hash,credentialGeneration:a.credential_generation,grantHash:a.grant_hash,pricingProfile:a.pricing_profile}:undefined;
  }

  private async locks(db:PoolClient,installationId:string,memberId:string,bindingId?:string):Promise<{installation:Row;member:Row;binding?:Row}> {
    const installation=(await db.query('SELECT * FROM budget_accounts WHERE id=$1 AND kind=\'installation\' FOR UPDATE',[installationId])).rows[0];
    const member=(await db.query('SELECT * FROM budget_accounts WHERE id=$1 AND kind=\'member\' AND installation_account_id=$2 FOR UPDATE',[memberId,installationId])).rows[0];
    const binding=bindingId?(await db.query('SELECT * FROM budget_gateway_bindings WHERE id=$1 FOR UPDATE',[bindingId])).rows[0]:undefined;
    if(!installation||!member||bindingId&&!binding)throw new Error('Budget account unavailable');
    return {installation,member,binding};
  }
  private async cap(db:PoolClient,account:Row):Promise<string|null> {
    const value=account.kind==='installation'?account.installation_cap:(await db.query('SELECT spend_cap_usd_month FROM org_member_policy WHERE user_id=$1',[account.live_member_id])).rows[0]?.spend_cap_usd_month;
    try{return canonicalBudgetMoney(value);}catch{return null;}
  }
  private async liability(db:PoolClient,account:Row):Promise<string|null> {
    const window=(await db.query('SELECT * FROM budget_windows WHERE id=$1 AND account_id=$2',[account.active_window_id,account.id])).rows[0];
    if(!window)return null;
    const scope=account.kind==='installation'?'installation':'member';
    const rows=(await db.query(`SELECT state,reserved_amount,actual_amount,highest_observed_liability,${scope}_window_id AS window_id FROM budget_attempts WHERE ${scope}_account_id=$1 AND (state IN ('admitted','unknown','conflict') OR(state='settled' AND ${scope}_window_id=$2))`,[account.id,window.id])).rows;
    let total=units(window.opening_liability);
    for(const r of rows){
      if(r.state==='admitted'||r.state==='unknown')total+=units(r.reserved_amount);
      else if(r.state==='conflict')total+=[units(r.reserved_amount),units(r.actual_amount??'0'),units(r.highest_observed_liability)].reduce((a,b)=>a>b?a:b);
      else if(r.window_id===window.id)total+=units(r.actual_amount);
    }
    return decimal(total);
  }
  private async ready(db:PoolClient,account:Row):Promise<boolean>{
    return account.state==='open'&&(await db.query('SELECT 1 FROM budget_windows WHERE id=$1 AND account_id=$2 AND starts_at<=clock_timestamp() AND ends_at>clock_timestamp()',[account.active_window_id,account.id])).rows.length===1;
  }
  /** Called only by authenticated current console runtime. The random ticket can cross a
   * process boundary while prepared; its hash and authenticated provenance are durable. */
  async prepareIntent(request:BudgetRequestReference):Promise<string> {
    // Read the registered, frozen scope synchronously. Caller context cannot choose a step.
    const invocation=currentModelInvocation();
    if(!invocation)throw new Error(MODEL_INVOCATION_REFUSED);
    const {turnId,sequence,stepIndex}=invocation.event.data;
    const ctx:ConsoleAuthorityContext={session:{...invocation.session,turn:{id:turnId,sequence}}};
    if(!uuid(request.bindingId)||!validHash(request.requestHash)||!validHash(request.profileHash))throw new Error('Invalid budget request');
    const raw=randomBytes(32).toString('base64url');
    await this.transaction(async db=>{
      const reference=await captureBudgetAuthorityReference(db,ctx,this.env); // Authority locks always precede budget locks.
      // Agent use locks its owner's policy; a delegated member's separate cap row also
      // needs a lock BEFORE the budget locks, including a concurrent deletion/reduction.
      await db.query('SELECT user_id FROM org_member_policy WHERE user_id=$1 FOR SHARE',[reference.binding.memberId]);
      const discovered=(await db.query('SELECT installation_account_id,member_account_id FROM budget_gateway_bindings WHERE id=$1',[request.bindingId])).rows[0];
      if(!discovered)throw new Error('Budget binding unavailable');
      const {installation,member,binding:b}=await this.locks(db,discovered.installation_account_id,discovered.member_account_id,request.bindingId);
      const iCap=await this.cap(db,installation),mCap=await this.cap(db,member);
      if(!b||b.state!=='active'||member.live_member_id!==reference.binding.memberId||b.live_member_id!==member.live_member_id||b.agent!==reference.binding.agent||b.incarnation!==reference.binding.incarnation||b.purpose_alias!==invocation.alias||b.profile_hash!==request.profileHash||b.endpoint_hash!==installation.selected_endpoint||!installation.recovery_epoch||!iCap||!mCap||!await this.ready(db,installation)||!await this.ready(db,member))throw new Error('Budget policy unavailable');
      // The retained canonical digest is a pseudorandom namespace, not an auth secret.
      // Fresh verified authority above grants access; routing/body/window changes cannot rearm.
      const invocationHash=createHmac('sha256',Buffer.from(member.canonical_suppression_hash,'hex')).update(JSON.stringify([
        'lares.budget.invocation.v1','conversation-step',installation.id,member.id,reference.binding.memberId,
        reference.binding.agent,reference.binding.incarnation,reference.binding.sessionId,reference.binding.admissionNonce,turnId,sequence,stepIndex,
      ])).digest('hex');
      const inserted=await db.query(`INSERT INTO budget_attempts(invocation_hash,id,ticket_hash,installation_account_id,member_account_id,binding_id,live_member_id,installation_window_id,member_window_id,endpoint_hash,credential_generation,installation_policy_generation,member_policy_generation,endpoint_generation,recovery_epoch,request_hash,authority_hash,authority_reference,profile_hash,reserved_amount,installation_cap_snapshot,member_cap_snapshot,created_at,expires_at)
        SELECT $23,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,t,t+($22::int*interval '1 millisecond') FROM(SELECT clock_timestamp() AS t) c ON CONFLICT(invocation_hash) DO NOTHING RETURNING id`,
        [randomUUID(),hash(raw),installation.id,member.id,b.id,member.live_member_id,installation.active_window_id,member.active_window_id,b.endpoint_hash,b.credential_generation,installation.policy_generation,member.policy_generation,installation.endpoint_generation,installation.recovery_epoch,request.requestHash,payloadFingerprint('budget-authority',reference),JSON.stringify(reference),b.profile_hash,b.maximum_liability,iCap,mCap,this.intentLifetimeMs,invocationHash]);
      if(inserted.rows.length!==1)throw new Error('Budget authority is unavailable or changed');
      noteBudgetFinancialChange(db,'budget_attempts',inserted.rows[0].id);
    },'prepare');return raw;
  }
  async admit(ticket:string,observation:BudgetGatewayObservation,recovery:BudgetRecoveryReference):Promise<BudgetAdmission> {
    if(typeof ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ticket))return DENIED;
    try{
      const admitted=await this.transaction(async db=>{
        const discovered=(await db.query('SELECT * FROM budget_attempts WHERE ticket_hash=$1',[hash(ticket)])).rows[0];
        if(!discovered||discovered.state!=='prepared'||!discovered.authority_reference)return undefined;
        const ref=discovered.authority_reference as Ref;
        if(payloadFingerprint('budget-authority',ref)!==discovered.authority_hash)return undefined;
        let authorityValidUntil:string|null;
        try{authorityValidUntil=await validateBudgetAuthorityReference(db,ref,this.env);}catch{
          await db.query("UPDATE budget_attempts SET state='retired' WHERE id=$1 AND state='prepared'",[discovered.id]);noteBudgetFinancialChange(db,'budget_attempts',discovered.id);return undefined;
        }
        await db.query('SELECT user_id FROM org_member_policy WHERE user_id=$1 FOR SHARE',[ref.binding.memberId]);
        const {installation:i,member:m,binding:b}=await this.locks(db,discovered.installation_account_id,discovered.member_account_id,discovered.binding_id);
        await db.query('SELECT id FROM budget_attempts WHERE id=$1 FOR UPDATE',[discovered.id]);
        const a=(await db.query('SELECT *,expires_at>clock_timestamp() AS fresh FROM budget_attempts WHERE id=$1',[discovered.id])).rows[0];
        if(a.state!=='prepared')return undefined;
        const deny=async()=>{await db.query("UPDATE budget_attempts SET state='retired' WHERE id=$1",[a.id]);noteBudgetFinancialChange(db,'budget_attempts',a.id);return undefined;};
        if(!a.fresh||!b||b.state!=='active'||m.live_member_id!==ref.binding.memberId||b.live_member_id!==m.live_member_id||!await this.ready(db,i)||!await this.ready(db,m)||
          i.policy_generation!==a.installation_policy_generation||m.policy_generation!==a.member_policy_generation||i.active_window_id!==a.installation_window_id||m.active_window_id!==a.member_window_id||
          i.selected_endpoint!==a.endpoint_hash||i.endpoint_generation!==a.endpoint_generation||i.recovery_epoch!==a.recovery_epoch||
          recovery.state!=='reconciled'||recovery.installationAccountId!==i.id||recovery.epoch!==i.recovery_epoch||recovery.endpointGeneration!==i.endpoint_generation||
          observation.requestHash!==a.request_hash||observation.profileHash!==a.profile_hash||observation.endpointHash!==a.endpoint_hash||observation.credentialGeneration!==a.credential_generation||observation.keyFingerprint!==b.key_fingerprint||
          observation.agent!==b.agent||observation.incarnation!==b.incarnation||observation.purposeAlias!==b.purpose_alias||b.profile_hash!==a.profile_hash||b.endpoint_hash!==a.endpoint_hash||b.credential_generation!==a.credential_generation)return deny();
        const iCap=await this.cap(db,i),mCap=await this.cap(db,m),iLiability=await this.liability(db,i),mLiability=await this.liability(db,m);
        if(iCap===null||mCap===null||iLiability===null||mLiability===null)return deny();
        if(totalUnits(mLiability)+units(a.reserved_amount)>units(mCap))return deny();
        if(totalUnits(iLiability)+units(a.reserved_amount)>units(iCap))return deny();
        await checkConsoleSourceDeadlines(db);
        const admitted=await db.query(`UPDATE budget_attempts SET state='admitted',admitted_at=clock_timestamp() WHERE id=$1 AND expires_at>clock_timestamp()
          AND ($4::timestamptz IS NULL OR $4::timestamptz>clock_timestamp())
          AND EXISTS(SELECT 1 FROM budget_windows WHERE id=$2 AND starts_at<=clock_timestamp() AND ends_at>clock_timestamp())
          AND EXISTS(SELECT 1 FROM budget_windows WHERE id=$3 AND starts_at<=clock_timestamp() AND ends_at>clock_timestamp()) RETURNING id`,[a.id,i.active_window_id,m.active_window_id,authorityValidUntil]);
        if(admitted.rows.length!==1){await checkConsoleSourceDeadlines(db);return deny();}
        noteBudgetFinancialChange(db,'budget_attempts',a.id);
        return {attemptId:a.id as string,bindingId:b.id as string,requestHash:a.request_hash as string};
      },'admit');
      if(!admitted)return DENIED;
      // Denial carries no account/aggregate metadata. The caller may separately ask
      // readStatus using its current authenticated context and authorised scope.
      // Only acknowledged COMMIT reaches this statement. An admitted retry NEVER mints again.
      const permit=Object.freeze({kind:'budget-dispatch-permit' as const});permits.set(permit,admitted);
      return {state:'allowed',permit,attemptId:admitted.attemptId};
    }catch(error){return error instanceof SourceAuthorityDenied?DENIED:{state:'unavailable',reason:'Budget admission could not be confirmed'};}
  }
  async markUnknown(attemptId:string):Promise<void>{
    if(!uuid(attemptId))throw new Error('Invalid attempt');
    await this.transaction(async db=>{const result=await db.query("UPDATE budget_attempts SET state='unknown' WHERE id=$1 AND state='admitted' RETURNING id",[attemptId]);if(result.rows.length)noteBudgetFinancialChange(db,'budget_attempts',attemptId);},'unknown');
  }
  /** Receipt verification/correlation belongs to the trusted gateway adapter. Cancellation,
   * timeouts, missing logs and zero log rows are never affirmative nondispatch evidence. */
  async settle(receipt:BudgetTerminalReceipt):Promise<'settled'|'conflict'|'denied'> {
    const actual=canonicalBudgetMoney(receipt.actualAmount);
    if(!uuid(receipt.attemptId)||!uuid(receipt.bindingId)||!validHash(receipt.receiptHash)||!['terminal-usage','affirmative-nondispatch'].includes(receipt.kind)||receipt.kind==='affirmative-nondispatch'&&actual!=='0')return 'denied';
    return this.transaction(async db=>{
      const found=(await db.query('SELECT * FROM budget_attempts WHERE id=$1',[receipt.attemptId])).rows[0];if(!found)return 'denied';
      await this.locks(db,found.installation_account_id,found.member_account_id,found.binding_id);
      const a=(await db.query('SELECT * FROM budget_attempts WHERE id=$1 FOR UPDATE',[found.id])).rows[0];
      if(!['admitted','unknown','settled','conflict'].includes(a.state)||receipt.bindingId!==a.binding_id||receipt.requestHash!==a.request_hash||receipt.endpointHash!==a.endpoint_hash||receipt.credentialGeneration!==a.credential_generation||receipt.profileHash!==a.profile_hash)return 'denied';
      const same=a.settlement_hash===receipt.receiptHash&&a.actual_amount!==null&&units(a.actual_amount)===units(actual);
      if(same)return a.state==='conflict'?'conflict':'settled';
      const reason=a.settlement_hash!==null?'receipt_conflict':units(actual)>units(a.reserved_amount)?'over_reservation':null;
      const conflict=reason!==null||a.state==='conflict';
      const high=[units(a.highest_observed_liability),units(actual)].reduce((x,y)=>x>y?x:y);
      await db.query(`UPDATE budget_attempts SET state=$2,actual_amount=COALESCE(actual_amount,$3),settlement_hash=COALESCE(settlement_hash,$4),
        conflict_reason=COALESCE(conflict_reason,$5),conflict_hash=CASE WHEN $5::text IS NOT NULL THEN $4 ELSE conflict_hash END,highest_observed_liability=$6 WHERE id=$1`,[a.id,conflict?'conflict':'settled',actual,receipt.receiptHash,reason,decimal(high)]);
      if(conflict)await db.query("UPDATE budget_accounts SET state='frozen',reason=$2 WHERE id=$1 AND state<>'retired'",[a.installation_account_id,reason??'receipt_conflict']);
      noteBudgetFinancialChange(db,'budget_attempts',a.id);
      return conflict?'conflict':'settled';
    },'settle');
  }
  /** Authorisation uses the same current private-console authority, before account locks.
   * Members can read only their own account; installation scope requires a current owner. */
  async readStatus(ctx:ConsoleAuthorityContext,scope:'member'|'installation'='member'):Promise<BudgetStatus> {
    return this.transaction(async db=>{
      const ref=await captureBudgetAuthorityReference(db,ctx,this.env);
      if(scope==='installation'){
        const owner=(await db.query("SELECT 1 FROM users WHERE id=$1 AND org_role='owner' AND status='active'",[ref.binding.memberId])).rows.length;
        if(!owner)throw new Error('Budget scope denied');
      }
      const account=(await db.query(scope==='member'?"SELECT * FROM budget_accounts WHERE live_member_id=$1 AND kind='member' FOR SHARE":"SELECT * FROM budget_accounts WHERE kind='installation' FOR SHARE",scope==='member'?[ref.binding.memberId]:[])).rows[0];
      if(!account)throw new Error('Budget scope unavailable');
      return {state:account.state,reason:account.reason,cap:await this.cap(db,account),liability:await this.liability(db,account),windowId:account.active_window_id};
    });
  }
}
