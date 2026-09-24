"use server";
import { cookies } from 'next/headers';
import { keeper, KeeperRefusedError, KeeperUnavailableError } from '../../lib/keeper-client';
import { verify } from '../../lib/auth';
import type { DefinitionResult, RetirementResult, Role, RuntimeState } from '../../lib/builder';
async function actor(): Promise<string> {
  const email = await verify((await cookies()).get('lares_session')?.value);
  if (!email) throw new Error('unauthenticated');
  return email;
}
export type DefinitionActionResult<T> = {ok:true;result:T}|{ok:false;error:{message:string;findings?:{check:string;message:string}[];outcomeMayBeUnknown:boolean}};
async function call<T>(action:string,input:unknown,email:string):Promise<DefinitionActionResult<T>> {
  try { return {ok:true,result:await keeper<T>(action,input,email)}; }
  catch(error) {
    if(error instanceof KeeperRefusedError) return {ok:false,error:{message:error.message,findings:error.findings,outcomeMayBeUnknown:!error.findings?.length}};
    if(error instanceof KeeperUnavailableError) return {ok:false,error:{message:error.message,outcomeMayBeUnknown:error.outcomeMayBeUnknown}};
    return {ok:false,error:{message:'Keeper action failed; its outcome may be unknown. Inspect the current state before trying again.',outcomeMayBeUnknown:true}};
  }
}
export interface DefinitionInput { name: string; definition: unknown; duties: string; voice: string }
export async function createAgent(input: DefinitionInput & { startingPoint: Role }): Promise<DefinitionActionResult<DefinitionResult>> {
  return call('definition.create', input, await actor());
}
export async function saveDefinition(input: DefinitionInput): Promise<DefinitionActionResult<DefinitionResult>> {
  return call('definition.save', input, await actor());
}
export async function retireAgent(input: {name: string}): Promise<DefinitionActionResult<RetirementResult>> {
  return call('definition.retire', input, await actor());
}
export async function deleteAgent(input: {name: string; confirm: boolean}): Promise<DefinitionActionResult<unknown>> {
  const email = await actor();
  if (input.confirm !== true) throw new Error('Explicit deletion confirmation is required.');
  return call('definition.delete', {name:input.name,confirm:true}, email);
}
/** Task17 hook. A stored token is not proof of a connected or active door. */
export async function connectDoor(input: {name: string; kind:'slack'|'telegram'; secret: string; signingSecret?:string}): Promise<DefinitionActionResult<unknown>> {
  return call('door.connect', input, await actor());
}
export async function applyConnections(input: {name: string; hash: string}): Promise<DefinitionActionResult<RuntimeState>> {
  return call('definition.reconcile', input, await actor());
}
export async function listConversations(input:{name:string}):Promise<DefinitionActionResult<{sessionId:string;incarnation:string;door:string;observedAt:string;terminal:boolean}[]>> {
  return call('conversation.list',input,await actor());
}
export async function startFreshConversation(input:{name:string;sessionId:string;incarnation:string;confirm:boolean}):Promise<DefinitionActionResult<{status:string}>> {
  const email=await actor();
  if(input.confirm!==true)throw new Error('Explicit conversation reset confirmation is required.');
  return call('conversation.reset',input,email);
}

export async function doorStatus(name:string):Promise<DefinitionActionResult<import('../../components/DoorSetup').DoorStatus[]>> {
  return call('door.status',{name},await actor());
}
export async function claimCode(name:string,kind:'slack'|'telegram'):Promise<DefinitionActionResult<{code:string;expiresAt:string;instruction:string}>> {
  return call('door.claim_issue',{name,kind},await actor());
}
export async function registerTelegram(name:string):Promise<DefinitionActionResult<{registered:boolean}>> {
  return call('telegram.webhook_set',{name},await actor());
}
export async function setDoorEnabled(name:string,kind:'slack'|'telegram'|'email',enabled:boolean):Promise<DefinitionActionResult<DefinitionResult>> {
  const email=await actor();
  try {
  const saved=await keeper<{definition:string;duties:string;voice:string}>('definition.get',{name},email);
  const definition=JSON.parse(saved.definition);
  const doors=definition.doors??definition.channels.map((kind:string)=>({kind,enabled:true,settings:{}}));
  definition.doors=[...doors.filter((d:{kind:string})=>d.kind!==kind),{kind,enabled,settings:doors.find((d:{kind:string})=>d.kind===kind)?.settings??{}}];
  definition.channels=definition.doors.filter((d:{enabled:boolean})=>d.enabled).map((d:{kind:string})=>d.kind);
  return call('definition.save',{name,definition,duties:saved.duties,voice:saved.voice},email);
  } catch(error) {
    if(error instanceof KeeperRefusedError)return {ok:false,error:{message:error.message,findings:error.findings,outcomeMayBeUnknown:!error.findings?.length}};
    if(error instanceof KeeperUnavailableError)return {ok:false,error:{message:error.message,outcomeMayBeUnknown:error.outcomeMayBeUnknown}};
    return {ok:false,error:{message:'Could not read the current agent definition. Reload before changing this door.',outcomeMayBeUnknown:false}};
  }
}
