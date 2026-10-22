import { defineHook, type HookContext, type HookEvent } from 'eve/hooks';
import { consoleAdmission } from '@lares/agent-kit/console-turn-authority';
import { managedIdentity } from '@lares/agent-kit/door-authority';
import { vaultBrokerRequest } from '@lares/agent-kit/vault-broker-client';
import { thisAgent } from '../../lib/definition.js';
import { clearSessionVaultTurnCapabilities, isVaultTurnActive, markVaultTurnActive, markVaultTurnClosed, setVaultTurnCapability, vaultTurnCapability } from '../lib/vault-turn.js';

type Context=HookContext & {session?:{id?:string;turn?:{id?:string;sequence?:number};auth?:{current?:unknown}|null}};
function coords(event:unknown,ctx:Context){
 const e=(event as {data?:{turnId?:unknown;sequence?:unknown}}|undefined)?.data,turnId=e?.turnId,sequence=e?.sequence,sessionId=ctx.session?.id;
 if(typeof turnId!=='string'||turnId.length<1||turnId.length>128||!Number.isSafeInteger(sequence)||typeof sessionId!=='string'||!sessionId)return undefined;
 const current=ctx.session?.auth?.current as {attributes?:Record<string,unknown>}|undefined,admission=consoleAdmission(current),own=managedIdentity(process.env),pending=current?.attributes?.lares_vault_pending;
 if(!admission||admission.purpose!=='human'||!own||typeof pending!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(pending))return undefined;
 if(ctx.session?.turn?.id&&ctx.session.turn.id!==turnId)return undefined;
 if(Number.isSafeInteger(ctx.session?.turn?.sequence)&&ctx.session!.turn!.sequence!==sequence)return undefined;
 return {turnId,sequence:sequence as number,sessionId,memberId:admission.memberId,admissionNonce:admission.admissionNonce,pending,agent:own.name,incarnation:own.incarnation};
}
async function close(event:unknown,raw:HookContext){
 const ctx=raw as Context,own=managedIdentity(process.env),sessionId=ctx.session?.id,data=(event as {data?:{turnId?:unknown;sequence?:unknown}}|undefined)?.data;
 if(!own||typeof sessionId!=='string'||typeof data?.turnId!=='string'||!Number.isSafeInteger(data.sequence))return;
 const key={sessionId,turnId:data.turnId,sequence:data.sequence as number,incarnation:own.incarnation},current=vaultTurnCapability(key);markVaultTurnClosed(key);
 if(current)await vaultBrokerRequest('turn.close',{turnCapability:current.capability,turnId:current.turnId,sequence:current.sequence}).catch(()=>{});
}
export default defineHook({events:{
 'turn.started':async(event:HookEvent<'turn.started'>,raw:HookContext)=>{
  const ctx=raw as Context,point=coords(event,ctx);if(!point)return;clearSessionVaultTurnCapabilities(point.sessionId,point.incarnation);const key={sessionId:point.sessionId,turnId:point.turnId,sequence:point.sequence,incarnation:point.incarnation};
  try{
   markVaultTurnActive(key);
   const {loaded}=await thisAgent(point.sessionId);
   const result=await vaultBrokerRequest<{turnCapability?:unknown;expiresAt?:unknown}>('turn.open',{pendingReceipt:point.pending,sessionId:point.sessionId,memberId:point.memberId,admissionNonce:point.admissionNonce,turnId:point.turnId,sequence:point.sequence,definition:{definition:loaded.definition,dutiesMd:loaded.dutiesMd,voiceMd:loaded.voiceMd,hash:loaded.hash}});
   if(typeof result.turnCapability==='string'&&/^[A-Za-z0-9_-]{43}$/.test(result.turnCapability)&&typeof result.expiresAt==='number'){
    if(isVaultTurnActive(key))setVaultTurnCapability(key,{turnId:point.turnId,sequence:point.sequence,capability:result.turnCapability,expiresAt:result.expiresAt});
    else await vaultBrokerRequest('turn.close',{turnCapability:result.turnCapability,turnId:point.turnId,sequence:point.sequence}).catch(()=>{});
   }
  }catch{markVaultTurnClosed(key);/* Missing Keeper custody disables only the private Vault tools. */}
 },
 'turn.completed':async(event,ctx)=>close(event,ctx),
 'turn.failed':async(event,ctx)=>close(event,ctx),
 'turn.cancelled':async(event,ctx)=>close(event,ctx),
}});
