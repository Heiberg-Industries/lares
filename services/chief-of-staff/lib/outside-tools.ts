import { consoleAdmission } from '@lares/agent-kit/console-turn-authority';
import { managedIdentity } from '@lares/agent-kit/door-authority';
import { executeApprovedOutsideCall, vaultBrokerRequest } from '@lares/agent-kit/vault-broker-client';
import type { AcceptedOutsideTool } from '@lares/agent-kit/outside-connections';
import { reserveExactApprovalOrDeny, approveExactResponse, requireApprovedExecution, requireApprovedRecheck, isApprovalRecheck, approvalResponderOf, type ExactResponseContext } from '@lares/agent-kit/approval-execution';
import { outsideApprovalAdapter } from '@lares/agent-kit/outside-approval';
import { outwardActionAfterAnswerRefusal } from './approval-card-turns.js';

type Context={callId?:string;toolName?:string;approval?:{responder?:unknown};session?:{id?:string;turn?:{id?:string;sequence?:number};auth?:{current?:unknown;initiator?:unknown}|null}};
function sessionIdentity(ctx:Context){
 const session=ctx.session,own=managedIdentity(process.env),admission=consoleAdmission(session?.auth?.current);
 if(!own||!session?.id||admission?.purpose!=='human')throw new Error('Outside tools require an authenticated private conversation');
 return {own,session,admission};
}
export async function acceptedOutsideTools(ctx:Context,connectionName:string):Promise<AcceptedOutsideTool[]>{
 const {session,admission}=sessionIdentity(ctx);
 const result=await vaultBrokerRequest<{tools:AcceptedOutsideTool[]}>('outside.tools',{
  sessionId:session.id,memberId:admission.memberId,admissionNonce:admission.admissionNonce,connectionName});
 return result.tools;
}
/** Reserve before Eve presents the card; answer with the actual authenticated resolver. On eve 1.0 the policy
 *  is asked again, as the requester, before an approved call runs: that re-check shows nothing new, it only
 *  confirms the call is approved on its card (a missing or unverifiable approval is denied). */
export async function requestOutsideApproval(connectionName:string,toolName:string,ctx:unknown){
 const name=`${connectionName}__${toolName}`,c=ctx as Context & {toolInput?:unknown};
 const options={adapter:outsideApprovalAdapter(connectionName,toolName)};
 if(isApprovalRecheck(c)){
  try{await requireApprovedRecheck(c,name,c.toolInput,options);}catch{return 'denied' as const;}
 }else{
  // Every outside call asks first, and its effect is the outside tool's own: in the reply to an answered
  // request it is refused before the reservation and before the tool or its connection is contacted
  // (lib/approval-card-turns.ts). The answered card's own approved call is the recheck above.
  const answered=outwardActionAfterAnswerRefusal(c.session as never);if(answered)return answered;
  const refused=await reserveExactApprovalOrDeny(c,name,options);if(refused)return refused;
 }
 return 'user-approval' as const;
}
export async function respondOutsideApproval(connectionName:string,toolName:string,ctx:unknown){
 return approveExactResponse(ctx as ExactResponseContext,{adapter:outsideApprovalAdapter(connectionName,toolName)});
}
/** Approval resumes grant one exact outside call, never a replacement human/Vault turn. The person who
 *  approved is `ctx.approval.responder` (`session.auth.current` is the person who asked). */
export async function runOutsideTool(connectionName:string,toolName:string,input:unknown,ctx:Context){
 const own=managedIdentity(process.env),session=ctx.session,responder=consoleAdmission(approvalResponderOf(ctx));
 const name=`${connectionName}__${toolName}`;
 if(!own||!session?.id||responder?.purpose!=='resolver'||!ctx.callId||ctx.toolName!==name)
  throw new Error('Outside execution is unavailable for this approval');
 await requireApprovedExecution(ctx,name,input,{adapter:outsideApprovalAdapter(connectionName,toolName)});
 const call={callId:ctx.callId,connectionName,toolName,input};
 const binding={sessionId:session.id,memberId:responder.memberId,admissionNonce:responder.admissionNonce};
 const approved=await vaultBrokerRequest<{outsideCapability:string}>('outside.approve',{...binding,call});
 return executeApprovedOutsideCall({...binding,outsideCapability:approved.outsideCapability},call);
}
