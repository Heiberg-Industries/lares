/** Personal mail exact approval lifecycle. No provider mutation, native authority or approvedTools
 * shortcut. The only executor input is the immutable action already reserved for this call. */
import {z} from 'zod';
import {getPool} from '@lares/agent-kit/db';
import {encryptSecret,decryptSecret} from '@lares/agent-box/lib/crypto.js';
import {readTokenEncKey} from '@lares/agent-kit/google-auth';
import {PgAccountStore} from '@lares/agent-kit/account-store';
import {PgPersonalActionStore,personalMailPayloadSchema,PERSONAL_MAIL_SEND_TOOL} from '@lares/agent-kit/personal-action-store';
import {payloadFingerprint,callIdFrom} from '@lares/agent-kit/approval-ledger';
import {authorityTransaction,requireConsoleTurnAuthority,type ConsoleAuthorityContext} from '@lares/agent-kit/console-turn-authority';
import {requirePrivateConsoleResume,privateResolverAdmission} from '@lares/agent-kit/private-console-resume';
import {managedIdentity} from '@lares/agent-kit/door-authority';
import {personalReadSelectionSchema} from './personal-reads.js';
import {requirePersonalSendPolicy,requirePersonalSendApprovalPolicy,executeApprovedPersonalSend} from './personal-send.js';
export const personalSendInputSchema=personalMailPayloadSchema.extend({selection:personalReadSelectionSchema});
export function personalActions(){const key=readTokenEncKey();return new PgPersonalActionStore(getPool(),{encrypt:s=>encryptSecret(s,key),decrypt:s=>decryptSecret(s,key)});}
export async function personalSendApprovalRequest(ctx:ConsoleAuthorityContext&{callId?:string;toolInput?:unknown}){
  const input=personalSendInputSchema.parse(ctx.toolInput),pool=getPool();
  if(privateResolverAdmission(ctx.session?.auth?.current)){
    try{await authorityTransaction(pool,async db=>{
      const approved=await requirePrivateConsoleResume(ctx,'action',{db,callId:callIdFrom(ctx)??'',toolName:PERSONAL_MAIL_SEND_TOOL,input});
      await requirePersonalSendApprovalPolicy(db as never,approved.reference);
      await requirePrivateConsoleResume(ctx,'action',{db,callId:callIdFrom(ctx)??'',toolName:PERSONAL_MAIL_SEND_TOOL,input});
    });
    return 'user-approval' as const;}catch{return 'denied' as const;}
  }
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
export async function personalSendApprovalResponse(ctx:{request:{requestId:string;callId:string;toolName:string;toolInput?:unknown};responder:unknown;session:{id:string;initiator:unknown}}){
  const context={session:{id:ctx.session.id,auth:{current:ctx.responder,initiator:ctx.session.initiator}}};
  return authorityTransaction(getPool(),async db=>{
    const options={db,callId:ctx.request.callId,toolName:ctx.request.toolName,input:ctx.request.toolInput};
    const current=await requirePrivateConsoleResume(context,'response',options);
    if(current.reference.requestId!==ctx.request.requestId)throw new Error('Approval request changed');
    await requirePersonalSendApprovalPolicy(db as never,current.reference);
    await requirePrivateConsoleResume(context,'response',options);
    const updated=await db.query(`UPDATE approval_asks SET outcome='approved',answered_at=COALESCE(answered_at,clock_timestamp()),answered_via='console',resolved_by_member_id=$3
      WHERE call_id=$1 AND request_id=$2 AND (outcome IS NULL OR (outcome='approved' AND resolved_by_member_id=$3)) RETURNING call_id`,
      [ctx.request.callId,ctx.request.requestId,current.binding.memberId]);
    if(updated.rows.length!==1)throw new Error('Approval changed');return {status:'allowed' as const};
  });
}
export async function personalSendInputResolved(requestId:string,outcome:string,ctx:ConsoleAuthorityContext):Promise<boolean>{
  const auth=privateResolverAdmission(ctx.session?.auth?.current);if(!auth||auth.requestId!==requestId)return false;
  const current=await requirePrivateConsoleResume(ctx,'surface');
  if(outcome==='approved')return true; // The independent response authorizer already wrote approval.
  if(!['cancelled','ignored','invalid'].includes(outcome))throw new Error('Unsupported personal approval outcome');
  if(auth.optionId!=='cancel')throw new Error('Approval answer changed');
  await personalActions().cancelApprovalRequest(auth.memberId,current.reference.requestId,outcome as 'cancelled'|'ignored'|'invalid');
  return true;
}
export async function requirePersonalSendCall(ctx:ConsoleAuthorityContext,input:unknown){
  return requirePrivateConsoleResume(ctx,'action',{callId:callIdFrom(ctx)??'',toolName:PERSONAL_MAIL_SEND_TOOL,input});
}
export async function sendApprovedPersonalMail(ctx:ConsoleAuthorityContext,input:unknown){
  const approved=await requirePersonalSendCall(ctx,input);
  return executeApprovedPersonalSend(ctx,approved.reference,{pool:getPool(),actions:personalActions()});
}
