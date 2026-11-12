/** Personal mail exact approval lifecycle. No provider mutation, native authority or approvedTools
 * shortcut. The only executor input is the immutable action already reserved for this call. */
import {z} from 'zod';
import {getPool} from '@lares/agent-kit/db';
import {encryptSecret,decryptSecret} from '@lares/agent-box/lib/crypto.js';
import {readTokenEncKey} from '@lares/agent-kit/google-auth';
import {PgAccountStore} from '@lares/agent-kit/account-store';
import {PgPersonalActionStore,personalMailPayloadSchema,PERSONAL_MAIL_SEND_TOOL} from '@lares/agent-kit/personal-action-store';
import {payloadFingerprint,callIdFrom} from '@lares/agent-kit/approval-ledger';
import {authorityTransaction,consoleAdmission,requireConsoleTurnAuthority,type ConsoleAuthorityContext} from '@lares/agent-kit/console-turn-authority';
import {isApprovalRecheck,approvalResponderOf} from '@lares/agent-kit/approval-execution';
import {requirePrivateConsoleResume,privateResolverAdmission,rememberAcceptedAnswer,acceptedAnswerFor} from '@lares/agent-kit/private-console-resume';
import {managedIdentity} from '@lares/agent-kit/door-authority';
import {personalReadSelectionSchema} from './personal-reads.js';
import {turnAppliedAnAnswer} from './approval-card-turns.js';
import {requirePersonalSendPolicy,requirePersonalSendApprovalPolicy,executeApprovedPersonalSend} from './personal-send.js';
export const personalSendInputSchema=personalMailPayloadSchema.extend({selection:personalReadSelectionSchema});
export function personalActions(){const key=readTokenEncKey();return new PgPersonalActionStore(getPool(),{encrypt:s=>encryptSecret(s,key),decrypt:s=>decryptSecret(s,key)});}
/** On eve 1.0 `session.auth.current` is the person who ASKED; the person who answered is
 *  `ctx.approval.responder` while an approved call runs. The shared resume checks read the answer from
 *  `session.auth.current`, so hand them a context whose `current` is the answerer (and nothing when nobody
 *  answered: that is refused). The requester must be the very member who answered. */
function answeredContext(ctx:ConsoleAuthorityContext):ConsoleAuthorityContext{
  const requester=consoleAdmission(ctx.session?.auth?.current),responder=privateResolverAdmission(approvalResponderOf(ctx));
  if(!responder||!requester||requester.purpose!=='human'||requester.memberId!==responder.memberId)throw new Error('Personal mail approval unavailable');
  return {...ctx,session:{...ctx.session,auth:{current:approvalResponderOf(ctx),initiator:ctx.session?.auth?.initiator}}} as ConsoleAuthorityContext;
}
/** The re-check before an approved call runs: eve asks the request policy again, as the requester, with no
 *  responder in the context. The card the response policy wrote (approved by this member) stands in for it. */
async function recheckContext(ctx:ConsoleAuthorityContext&{callId?:string}):Promise<ConsoleAuthorityContext>{
  const requester=consoleAdmission(ctx.session?.auth?.current),initial=consoleAdmission(ctx.session?.auth?.initiator),own=managedIdentity();
  const callId=callIdFrom(ctx);
  if(!requester||requester.purpose!=='human'||!initial||initial.purpose!=='human'||initial.memberId!==requester.memberId||!own||!ctx.session?.id||!callId)throw new Error('Personal mail approval unavailable');
  const {rows}=await getPool().query('SELECT request_id FROM approval_asks WHERE call_id=$1 AND agent=$2 AND session_id=$3 AND acting_member_id=$4',[callId,own.name,ctx.session.id,requester.memberId]);
  if(rows.length!==1||typeof rows[0].request_id!=='string'||rows[0].request_id==='')throw new Error('Personal mail approval unavailable');
  const stored={authenticator:'lares-console',attributes:{lares_resolver_member_id:requester.memberId,lares_purpose:'resolver',lares_resume_request_id:rows[0].request_id,lares_resume_option:'approve'}};
  return {...ctx,session:{...ctx.session,auth:{current:stored,initiator:ctx.session?.auth?.initiator}}} as ConsoleAuthorityContext;
}
/** What the model is told, to pass on to the person. It says nothing about the earlier card. */
export const NEW_SEND_AFTER_ANSWER_REFUSED='A new send cannot be started in the reply to an answered request. Ask again in a new message.';
/**
 * NO NEW SEND IN THE REPLY TO AN ANSWERED REQUEST. A deliberate rule, the same at every door.
 *
 * On eve 1.0 an answered card (Approve or Deny) does not start a new turn: the paused turn carries
 * on as the person who ASKED, so the console authority check alone would let that continuation
 * prepare another send behind another card. Nothing caps that loop, each round is model calls
 * charged to that person, and a hurried Approve on the second card could send the same mail twice.
 * The older framework line could not do it (the continuation ran as the answerer, whom the console
 * authority check refuses); the owner ruled that the new line refuses it too, on purpose.
 *
 * So in a turn in which a person's answer to a card was applied, a NEW send is refused before
 * anything is read, stored or shown; the person asks again in a new message, which is a new turn.
 * The approved send of the answered card itself never reaches this: eve re-asks the policy as a
 * recheck (the branch above), which returns before this check.
 *
 * The turn is recognised from the durable mark the settle hook writes (`noteAnswerApplied`,
 * lib/approval-card-turns.ts), kept in eve's per-session state: it survives a restart between the
 * answer and the continuation, and it names one turn of one conversation only. FAILS CLOSED: a turn
 * with no id, or state that cannot be read, is refused like an answered one.
 */
export function newSendAfterAnswerRefusal(session:Parameters<typeof turnAppliedAnAnswer>[0]):{type:'denied';reason:string}|undefined{
  return turnAppliedAnAnswer(session)===false?undefined:{type:'denied',reason:NEW_SEND_AFTER_ANSWER_REFUSED};
}
export async function personalSendApprovalRequest(ctx:ConsoleAuthorityContext&{callId?:string;toolInput?:unknown}){
  const input=personalSendInputSchema.parse(ctx.toolInput),pool=getPool();
  if(isApprovalRecheck(ctx)){
    try{
      const rechecked=await recheckContext(ctx);
      await authorityTransaction(pool,async db=>{
        const approved=await requirePrivateConsoleResume(rechecked,'action',{db,callId:callIdFrom(ctx)??'',toolName:PERSONAL_MAIL_SEND_TOOL,input});
        await requirePersonalSendApprovalPolicy(db as never,approved.reference);
        await requirePrivateConsoleResume(rechecked,'action',{db,callId:callIdFrom(ctx)??'',toolName:PERSONAL_MAIL_SEND_TOOL,input});
      });
    return 'user-approval' as const;}catch{return 'denied' as const;}
  }
  // Before any authority read, credential, prepared draft or card.
  const refused=newSendAfterAnswerRefusal(ctx.session);
  if(refused)return refused;
  const authority=await requireConsoleTurnAuthority(ctx),own=managedIdentity();
  if(!own||!authority.actingMemberId||!ctx.callId)throw new Error('Personal mail approval unavailable');
  const actor=authority.actingMemberId;
  const account=await new PgAccountStore(pool).withPersonalResourceCredential(actor,input.selection,'mailbox',async(selected,_credential,db)=>{
    const policyHash=await requirePersonalSendPolicy(db,own.name,own.incarnation,actor);await requireConsoleTurnAuthority(ctx,db);
    if(selected.resource.externalId!==selected.account.providerAccount.subject)throw new Error('Personal mailbox unavailable');return {account:selected.account,policyHash};
  });
  const actions=personalActions(),{selection:_selection,...payload}=input;
  const action=await actions.prepareAction({actorMemberId:actor,agentId:own.name,incarnation:own.incarnation,sessionId:authority.sessionId,
    originalTurnId:authority.turnId,originalCallId:ctx.callId,accountId:account.account.id,accountGeneration:account.account.generation,
    resourceBindingId:input.selection.resourceBindingId,connectorId:account.account.connectorId,kind:'mail.send',payload});
  await actions.reserveApproval(action.actionId,actor,ctx.session!.turn!.sequence!,account.policyHash);
  return 'user-approval' as const;
}
export async function personalSendInputRequested(request:{requestId:string;callId:string;input:unknown},ctx:ConsoleAuthorityContext){
  const authority=await requireConsoleTurnAuthority(ctx);
  const row=(await getPool().query(`SELECT * FROM personal_actions WHERE original_call_id=$1 AND agent=$2 AND session_id=$3 AND actor_member_id=$4 AND original_turn_id=$5`,
    [request.callId,authority.agentId,authority.sessionId,authority.actingMemberId,authority.turnId])).rows[0];
  const {selection,...payload}=personalSendInputSchema.parse(request.input);
  if(!row||row.payload_hash!==payloadFingerprint('mail.send',payload)||payloadFingerprint('selection',selection)!==payloadFingerprint('selection',{accountId:row.account_id,generation:row.account_generation,resourceBindingId:row.resource_binding_id}))throw new Error('Personal mail proposal unavailable');
  await personalActions().attachApproval({actionId:row.id,actorMemberId:authority.actingMemberId!,approvalCallId:request.callId,requestId:request.requestId});
}
/** eve's response-policy context, as far as personal mail reads it. The person who answered is
 *  `response.principal`; `request.interactionId` is the card's id (stored as the request id). */
export interface PersonalSendResponseContext {
  request:{interactionId:string;callId:string;toolName:string;toolInput?:unknown};
  response:{decision:'approve'|'deny';principal:unknown};
  session:{id:string;initiator:unknown;turn?:unknown};
}
/** eve asks this policy about a Deny as well as an Approve. One rule: only the person who may
 *  approve this card may deny it. A Deny runs the same member, binding and policy checks as an
 *  Approve, and then writes nothing; the Deny itself is recorded when eve settles the card
 *  (`personalSendInputResolved`). Anyone else is refused the same way and the card stays pending. */
export async function personalSendApprovalResponse(ctx:PersonalSendResponseContext){
  const decision=ctx.response?.decision;
  if(decision!=='approve'&&decision!=='deny')throw new Error('Approval answer changed');
  const context={session:{id:ctx.session.id,auth:{current:ctx.response.principal,initiator:ctx.session.initiator}}};
  const requestId=ctx.request.interactionId;
  return authorityTransaction(getPool(),async db=>{
    if(decision==='deny'){
      if(privateResolverAdmission(ctx.response.principal)?.optionId!=='deny')throw new Error('Approval answer changed');
      const current=await requirePrivateConsoleResume(context,'surface',{db});
      if(current.reference.requestId!==requestId||ctx.request.toolName!==PERSONAL_MAIL_SEND_TOOL||
        ctx.request.callId!==current.reference.selection.originalCallId||current.approvalOutcome!==null)throw new Error('Approval request changed');
      await requirePersonalSendApprovalPolicy(db as never,current.reference);
      await requirePrivateConsoleResume(context,'surface',{db});
      rememberAcceptedAnswer(ctx,{memberId:current.binding.memberId,admissionNonce:current.binding.admissionNonce});
      return {status:'allowed' as const};
    }
    const options={db,callId:ctx.request.callId,toolName:ctx.request.toolName,input:ctx.request.toolInput};
    const current=await requirePrivateConsoleResume(context,'response',options);
    if(current.reference.requestId!==requestId)throw new Error('Approval request changed');
    await requirePersonalSendApprovalPolicy(db as never,current.reference);
    await requirePrivateConsoleResume(context,'response',options);
    const updated=await db.query(`UPDATE approval_asks SET outcome='approved',answered_at=COALESCE(answered_at,clock_timestamp()),answered_via='console',resolved_by_member_id=$3
      WHERE call_id=$1 AND request_id=$2 AND (outcome IS NULL OR (outcome='approved' AND resolved_by_member_id=$3)) RETURNING call_id`,
      [ctx.request.callId,requestId,current.binding.memberId]);
    if(updated.rows.length!==1)throw new Error('Approval changed');
    rememberAcceptedAnswer(ctx,{memberId:current.binding.memberId,admissionNonce:current.binding.admissionNonce});
    return {status:'allowed' as const};
  });
}
/** The card settled. On eve 1.0 the settle hook's `session.auth.current` is the person who ASKED, so
 *  the answer comes from what the response policy accepted for this card (`acceptedAnswerFor`).
 *
 *  With no accepted answer here (nobody answered, eve applied another answer, or the agent restarted
 *  since the answer), a card that did not end approved still closes its prepared send: closing widens
 *  nothing, so it needs no answerer, only the person who asked, whose send it is
 *  (`closeUnansweredPersonalSend`). An approved card needs nothing here: its approval row is what the
 *  send itself is checked against. */
export async function personalSendInputResolved(requestId:string,outcome:string,ctx:ConsoleAuthorityContext):Promise<boolean>{
  const answer=typeof ctx.session?.id==='string'?acceptedAnswerFor(requestId,ctx.session.id):undefined;
  const auth=privateResolverAdmission(answer?.principal);
  if(!answer||!auth||auth.requestId!==requestId)return outcome==='approved'?false:closeUnansweredPersonalSend(requestId,outcome,ctx);
  const answered={...ctx,session:{...ctx.session,auth:{current:answer.principal,initiator:ctx.session?.auth?.initiator}}} as ConsoleAuthorityContext;
  const current=await requirePrivateConsoleResume(answered,'surface');
  if(outcome==='approved')return true; // The independent response authorizer already wrote approval.
  if(!['cancelled','ignored','invalid'].includes(outcome))throw new Error('Unsupported personal approval outcome');
  if(auth.optionId!=='deny')throw new Error('Approval answer changed');
  await personalActions().cancelApprovalRequest(auth.memberId,current.reference.requestId,outcome as 'cancelled'|'ignored'|'invalid');
  return true;
}
/** Closes the prepared send of exactly this card, when it belongs to the person who asked in this
 *  conversation. False when the card is not a personal send (every other card passes through here). */
async function closeUnansweredPersonalSend(requestId:string,outcome:string,ctx:ConsoleAuthorityContext):Promise<boolean>{
  const asker=consoleAdmission(ctx.session?.auth?.initiator),own=managedIdentity(process.env);
  if(!asker||asker.purpose!=='human'||!own||typeof ctx.session?.id!=='string')return false;
  const {rows}=await getPool().query('SELECT 1 FROM personal_actions WHERE approval_request_id=$1 AND actor_member_id=$2 AND agent=$3 AND session_id=$4',
    [requestId,asker.memberId,own.name,ctx.session.id]);
  if(rows.length!==1)return false;
  if(!['cancelled','ignored','invalid'].includes(outcome))throw new Error('Unsupported personal approval outcome');
  await personalActions().cancelApprovalRequest(asker.memberId,requestId,outcome as 'cancelled'|'ignored'|'invalid');
  return true;
}
export async function requirePersonalSendCall(ctx:ConsoleAuthorityContext,input:unknown){
  return requirePrivateConsoleResume(answeredContext(ctx),'action',{callId:callIdFrom(ctx)??'',toolName:PERSONAL_MAIL_SEND_TOOL,input});
}
export async function sendApprovedPersonalMail(ctx:ConsoleAuthorityContext,input:unknown){
  const approved=await requirePersonalSendCall(ctx,input);
  return executeApprovedPersonalSend(answeredContext(ctx),approved.reference,{pool:getPool(),actions:personalActions()});
}
