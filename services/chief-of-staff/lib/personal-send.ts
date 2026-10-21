/** Trusted own-account executor only; deliberately no catalogue tool is enabled by this slice.
 * Claim COMMIT is transaction A. Current authority, refresh, ONE mutation, rotation and receipt
 * are transaction B, using the custody callback's client throughout. Unknown never resends.
 * Caller fixtures currently describe a synthetic resolver context. Actual exact-response
 * admission and model continuation MUST land separately before any tool enables this path.
 */
import type { Pool,PoolClient } from 'pg';
import { PgAccountStore,type ResolvedPersonalResource } from '@lares/agent-kit/account-store';
import { rotateAccountCredential,type StoredAccountCredential } from '@lares/agent-kit/account-credentials';
import { PgPersonalActionStore,type PersonalActionApprovedReference,type PersonalActionOutcome,type PersonalActionReceipt } from '@lares/agent-kit/personal-action-store';
import { consoleAdmission,requireConsoleSessionBinding,type ConsoleAuthorityContext } from '@lares/agent-kit/console-turn-authority';
import { managedIdentity } from '@lares/agent-kit/door-authority';
import { callIdFrom } from '@lares/agent-kit/approval-ledger';
import { parseDefinition } from '@lares/agent-kit/definition';
import { grantFor,scopeAtLeast,autonomyOf } from '@lares/agent-kit/manifest';
import { googlePersonalSend } from './google-personal-send.js';
import { microsoftPersonalSend } from './microsoft-personal-send.js';
import { mountedPersonalReadRuntime,requirePersonalReadProxy } from './personal-read-runtime.js';
import { PersonalSendError,type PersonalSendAdapter } from './personal-send-contract.js';

export interface PersonalSendRuntime {
  open(selection:ResolvedPersonalResource,credential:StoredAccountCredential,signal:AbortSignal,
    rotate:(encrypted:string)=>Promise<void>):Promise<{adapter:PersonalSendAdapter;close?:()=>Promise<void>}>;
}
export const mountedPersonalSendRuntime:PersonalSendRuntime={async open({account},credential,signal,rotate){
  requirePersonalReadProxy();
  if(account.connectorId==='google')return {adapter:await googlePersonalSend({identity:account.providerAccount,credential,signal,persistRotation:rotate})};
  if(account.connectorId!=='microsoft')throw new PersonalSendError();
  const mounted=mountedPersonalReadRuntime.microsoft!();
  try{return {adapter:await microsoftPersonalSend({...mounted,identity:account.providerAccount,credential,signal,persistRotation:rotate}),close:mounted.close};}
  catch(error){await mounted.close?.();throw error;}
}};
/** Applied definition, explicit acting-member policy and current board always win. The table
 * lock also protects an ABSENT ratchet row from a concurrent first 'never' insertion. */
export async function requirePersonalSendPolicy(db:PoolClient,agent:string,incarnation:string,member:string):Promise<void> {
  await db.query('LOCK TABLE ratchet IN SHARE MODE');
  const {rows}=await db.query(`SELECT r.applied_definition FROM agent_resources r JOIN agent_definitions d ON d.name=r.name
    WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token
    AND r.state='ready' AND NOT r.pending AND d.status='valid' AND r.applied_definition IS NOT NULL FOR SHARE OF r,d`,[agent,incarnation]);
  if(rows.length!==1)throw new PersonalSendError();
  const definition=parseDefinition(rows[0].applied_definition);
  if(definition.name!==agent||!scopeAtLeast(grantFor(definition,'personal_mailbox')?.scope??'none','write-with-confirm'))throw new PersonalSendError();
  const policy=await db.query('SELECT allowed_capabilities FROM org_member_policy WHERE user_id=$1 FOR SHARE',[member]);
  if(!policy.rows[0]||(policy.rows[0].allowed_capabilities!==null&&!policy.rows[0].allowed_capabilities.includes('personal_mailbox')))throw new PersonalSendError();
  const board=await db.query("SELECT action,level FROM ratchet WHERE agent=$1 AND capability='personal_mailbox' AND action IN ('','send') FOR SHARE",[agent]);
  const level=board.rows.find(r=>r.action==='send')?.level??board.rows.find(r=>r.action==='')?.level??autonomyOf(definition,'personal_mailbox');
  if(!['gated','autonomous'].includes(level))throw new PersonalSendError();
}
function caller(ctx:ConsoleAuthorityContext,ref:PersonalActionApprovedReference,env:NodeJS.ProcessEnv) {
  const current=consoleAdmission(ctx.session?.auth?.current),initial=consoleAdmission(ctx.session?.auth?.initiator),own=managedIdentity(env),s=ref.selection;
  if(!current||current.purpose!=='resolver'||!initial||initial.purpose!=='human'||current.memberId!==initial.memberId||
    current.admissionNonce!==initial.admissionNonce||current.memberId!==s.actorMemberId||ref.resolvedByMemberId!==s.actorMemberId||
    !own||own.name!==s.agentId||own.incarnation!==s.incarnation||ctx.session?.id!==s.sessionId||
    callIdFrom(ctx)!==s.originalCallId||ref.approvalCallId!==s.originalCallId)throw new PersonalSendError();
  return {agent:own.name,incarnation:own.incarnation,sessionId:s.sessionId,memberId:s.actorMemberId,admissionNonce:current.admissionNonce};
}
export async function executeApprovedPersonalSend(ctx:ConsoleAuthorityContext,ref:PersonalActionApprovedReference,
  options:{pool:Pool;actions:PgPersonalActionStore;runtime?:PersonalSendRuntime;env?:NodeJS.ProcessEnv}):Promise<PersonalActionOutcome> {
  const env=options.env??process.env,binding=caller(ctx,ref,env),actions=options.actions;
  // No catch may turn an uncertain claim COMMIT into dispatch authority. The store returns a
  // permit only after successful acknowledgement, and the connection is released before B.
  const claimed=await actions.claimAction(ref);
  if(!claimed.permit){
    await requireConsoleSessionBinding(binding,options.pool,env);
    return claimed.outcome.state==='claimed'?{...claimed.outcome,state:'unknown',receipt:{state:'unknown',code:'process_interrupted'}}:claimed.outcome;
  }
  const permit=claimed.permit;
  let writeInvoked=false;
  try {
    return await new PgAccountStore(options.pool).withPersonalResourceCredential(binding.memberId,
      {accountId:ref.selection.accountId,generation:ref.selection.accountGeneration,resourceBindingId:ref.selection.resourceBindingId},'mailbox',
      async(selection,credential,db)=>{
        if(selection.account.connectorId!==ref.selection.connectorId||selection.resource.externalId!==selection.account.providerAccount.subject)throw new PersonalSendError();
        await actions.validateClaimInTransaction(permit,db); // action BEFORE approval, binding last
        await requirePersonalSendPolicy(db,binding.agent,binding.incarnation,binding.memberId);
        await requireConsoleSessionBinding(binding,db,env);
        const signal=AbortSignal.timeout(15_000);
        let opened:Awaited<ReturnType<PersonalSendRuntime['open']>>|undefined;
        try {
          opened=await (options.runtime??mountedPersonalSendRuntime).open(selection,credential,signal,
            encrypted=>rotateAccountCredential(db,{id:selection.account.id,ownerMemberId:binding.memberId,
              connectorId:selection.account.connectorId,generation:selection.account.generation},credential,encrypted));
          // Recheck DB-clock TTL and grant expiry AFTER identity/refresh and all lock waits.
          await requirePersonalSendPolicy(db,binding.agent,binding.incarnation,binding.memberId);
          await requireConsoleSessionBinding(binding,db,env);
          await actions.validateClaimInTransaction(permit,db);
          signal.throwIfAborted();
          const command=actions.consumeClaimPermit(permit);
          writeInvoked=true; // MUST precede calling even a synchronously throwing adapter.
          let receipt:PersonalActionReceipt;
          try{
            const accepted=await opened.adapter.send(command.payload);
            if(accepted.state!=='accepted')throw new PersonalSendError();
            receipt=accepted;
          }
          catch{receipt={state:'unknown',code:'transport_uncertain'};}
          return await actions.recordOutcomeInTransaction(permit,receipt,db);
        }finally{await opened?.close?.();}
      }); // Exposes accepted only AFTER the custody transaction COMMIT is acknowledged.
  }catch {
    const receipt:PersonalActionReceipt=writeInvoked?{state:'unknown',code:'transport_uncertain'}:{state:'not_dispatched',code:'authority_changed'};
    // Outside B, after release. Never overwrite an accepted/rejected receipt following an
    // uncertain COMMIT. A failed settlement leaves the durable claimed state nonretryable.
    try{return await actions.recordOutcome(permit,receipt);}
    catch{return {...claimed.outcome,state:'unknown',receipt:{state:'unknown',code:'process_interrupted'}};}
  }
}
