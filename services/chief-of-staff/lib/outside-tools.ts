import { consoleAdmission } from '@lares/agent-kit/console-turn-authority';
import { managedIdentity } from '@lares/agent-kit/door-authority';
import { executeApprovedOutsideCall, vaultBrokerRequest } from '@lares/agent-kit/vault-broker-client';
import type { AcceptedOutsideTool } from '@lares/agent-kit/outside-connections';
import { vaultTurnCapability } from '../agent/lib/vault-turn.js';

type Context={callId?:string;toolName?:string;session?:{id?:string;turn?:{id?:string;sequence?:number};auth?:{current?:unknown}|null}};
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
/** The framework supplies the call ID; the existing hook supplies admitted turn authority. */
export async function runOutsideTool(connectionName:string,toolName:string,input:unknown,ctx:Context){
 const {own,session,admission}=sessionIdentity(ctx),turnId=session.turn?.id,sequence=session.turn?.sequence;
 if(typeof turnId!=='string'||!Number.isSafeInteger(sequence)||!ctx.callId||ctx.toolName!==`${connectionName}__${toolName}`)
  throw new Error('Outside execution is unavailable for this turn');
 const turn=vaultTurnCapability({sessionId:session.id!,turnId,sequence:sequence as number,incarnation:own.incarnation});
 if(!turn||turn.expiresAt<=Date.now()||turn.turnId!==turnId||turn.sequence!==sequence)
  throw new Error('Outside execution is unavailable for this turn');
 return executeApprovedOutsideCall({turnCapability:turn.capability,turnId,sequence:sequence as number,
  sessionId:session.id!,memberId:admission.memberId,admissionNonce:admission.admissionNonce},
  {callId:ctx.callId,connectionName,toolName,input});
}
