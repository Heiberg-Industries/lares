import { consoleAdmission } from '@lares/agent-kit/console-turn-authority';
import { managedIdentity } from '@lares/agent-kit/door-authority';
import { executeApprovedOutsideCall, vaultBrokerRequest } from '@lares/agent-kit/vault-broker-client';
import type { AcceptedOutsideTool } from '@lares/agent-kit/outside-connections';
import { reserveExactApproval, approveExactResponse, requireApprovedExecution, type ExactResponseContext } from '@lares/agent-kit/approval-execution';
import { outsideApprovalAdapter } from '@lares/agent-kit/outside-approval';

type Context={callId?:string;toolName?:string;session?:{id?:string;turn?:{id?:string;sequence?:number};auth?:{current?:unknown;initiator?:unknown}|null}};
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
/** Reserve before Eve presents the card; answer with the actual authenticated resolver. */
export async function requestOutsideApproval(connectionName:string,toolName:string,ctx:unknown){
 const name=`${connectionName}__${toolName}`,c=ctx as Context & {toolInput?:unknown};
 const options={adapter:outsideApprovalAdapter(connectionName,toolName)};
 if(consoleAdmission(c.session?.auth?.current)?.purpose==='resolver')await requireApprovedExecution(c,name,c.toolInput,options);
 else await reserveExactApproval(c,name,options);
 return 'user-approval' as const;
}
export async function respondOutsideApproval(connectionName:string,toolName:string,ctx:unknown){
 return approveExactResponse(ctx as ExactResponseContext,{adapter:outsideApprovalAdapter(connectionName,toolName)});
}
/** Approval resumes grant one exact outside call, never a replacement human/Vault turn. */
export async function runOutsideTool(connectionName:string,toolName:string,input:unknown,ctx:Context){
 const own=managedIdentity(process.env),session=ctx.session,admission=consoleAdmission(session?.auth?.current);
 const name=`${connectionName}__${toolName}`;
 if(!own||!session?.id||admission?.purpose!=='resolver'||!ctx.callId||ctx.toolName!==name)
  throw new Error('Outside execution is unavailable for this approval');
 await requireApprovedExecution(ctx,name,input,{adapter:outsideApprovalAdapter(connectionName,toolName)});
 const call={callId:ctx.callId,connectionName,toolName,input};
 const binding={sessionId:session.id,memberId:admission.memberId,admissionNonce:admission.admissionNonce};
 const approved=await vaultBrokerRequest<{outsideCapability:string}>('outside.approve',{...binding,call});
 return executeApprovedOutsideCall({...binding,outsideCapability:approved.outsideCapability},call);
}
