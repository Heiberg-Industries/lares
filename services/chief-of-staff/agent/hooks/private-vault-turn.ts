import { defineHook, type HookContext, type HookEvent } from 'eve/hooks';
import { consoleAdmission } from '@lares/agent-kit/console-turn-authority';
import { managedIdentity } from '@lares/agent-kit/door-authority';
import { vaultBrokerRequest } from '@lares/agent-kit/vault-broker-client';
import { thisAgent } from '../../lib/definition.js';
import { clearSessionVaultTurnCapabilities, closeVaultTurn, isVaultTurnActive, markVaultTurnActive, markVaultTurnClosed, setVaultTurnCapability, vaultTurnCapability } from '../lib/vault-turn.js';

type Context=HookContext & {session?:{id?:string;turn?:{id?:string;sequence?:number};auth?:{current?:unknown}|null}};
// eve 1.0's `turn.started` has no sequence: it comes from `ctx.session.turn`, and only when that is
// THIS event's turn. Anything else yields no capability (the Vault tools stay off for the turn).
function coords(event:unknown,ctx:Context){
 const e=(event as {data?:{turnId?:unknown}}|undefined)?.data,turnId=e?.turnId,sessionId=ctx.session?.id,sequence=ctx.session?.turn?.sequence;
 if(typeof turnId!=='string'||turnId.length<1||turnId.length>128||ctx.session?.turn?.id!==turnId||!Number.isSafeInteger(sequence)||typeof sessionId!=='string'||!sessionId)return undefined;
 const current=ctx.session?.auth?.current as {attributes?:Record<string,unknown>}|undefined,admission=consoleAdmission(current),own=managedIdentity(process.env),pending=current?.attributes?.lares_vault_pending;
 if(!admission||admission.purpose!=='human'||!own||typeof pending!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(pending))return undefined;
 return {turnId,sequence:sequence as number,sessionId,memberId:admission.memberId,admissionNonce:admission.admissionNonce,pending,agent:own.name,incarnation:own.incarnation};
}
// Closes every capability this process holds for the turn, whatever its sequence: a turn id names one
// turn, and the sequence is not needed to find it. Used for every settled outcome and when a turn pauses.
async function close(event:unknown,raw:HookContext){
 const ctx=raw as Context,own=managedIdentity(process.env),sessionId=ctx.session?.id,turnId=(event as {data?:{turnId?:unknown}}|undefined)?.data?.turnId;
 if(!own||typeof sessionId!=='string'||typeof turnId!=='string')return;
 for(const held of closeVaultTurn(sessionId,turnId,own.incarnation)){
  await vaultBrokerRequest('turn.close',{turnCapability:held.capability,turnId:held.turnId,sequence:held.sequence}).catch(()=>{});
 }
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
 // Every outcome of a settled turn, and a turn paused for a person (0.60 closed at that park point).
 'turn.settled':async(event,ctx)=>close(event,ctx),
 'turn.paused':async(event,ctx)=>close(event,ctx),
}});
