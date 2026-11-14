"use server";
import { cookies } from 'next/headers';
import { keeper, keeperFailureText, keeperReferenceText, KeeperFailedError, KeeperRefusedError, KeeperUnavailableError, type KeeperFailureState } from '../../lib/keeper-client';
import { verify } from '../../lib/auth';
import type { Capacity, DefinitionResult, RetirementResult, Role, RuntimeState } from '../../lib/builder';
import type { NotionSyncView } from '../../lib/notion-sync';
import { deliveryFollowingFirstChatDoor } from '../../lib/delivery';
async function actor(): Promise<string> {
  const email = await verify((await cookies()).get('lares_session')?.value);
  if (!email) throw new Error('unauthenticated');
  return email;
}
type ActionError = {message:string;findings?:{check:string;message:string}[];state?:KeeperFailureState;reference?:string;outcomeMayBeUnknown:boolean};
export type DefinitionActionResult<T> = {ok:true;result:T}|{ok:false;error:ActionError};
/** The pages show `message` and nothing else, so the state the agent is left in and the reference to quote are
 * written into it; `state` and `reference` are also passed on as they came. A failed action changed things on the
 * box (the saved definition may have been put back), so the page is told to reload before another write. */
function failedOrUnavailable(error:unknown):ActionError|undefined {
  if(error instanceof KeeperFailedError) return {message:keeperFailureText(error),state:error.state,reference:error.reference,outcomeMayBeUnknown:true};
  if(error instanceof KeeperUnavailableError) return {message:`${error.message}${keeperReferenceText(error.reference)}`,...(error.reference?{reference:error.reference}:{}),outcomeMayBeUnknown:error.outcomeMayBeUnknown};
  return undefined;
}
async function call<T>(action:string,input:unknown,email:string,timeoutMs?:number):Promise<DefinitionActionResult<T>> {
  try { return {ok:true,result:await (timeoutMs ? keeper<T>(action,input,email,{timeoutMs}) : keeper<T>(action,input,email))}; }
  catch(error) {
    // A door switched on without its credentials is refused before anything is stored: say why, and say nothing changed.
    if(error instanceof KeeperRefusedError) return {ok:false,error:{message:error.message,findings:error.findings,outcomeMayBeUnknown:!error.findings?.length&&!error.message.endsWith('before it can be turned on. Save the credentials first.')}};
    const known=failedOrUnavailable(error);
    if(known) return {ok:false,error:known};
    return {ok:false,error:{message:'Keeper action failed; its outcome may be unknown. Inspect the current state before trying again.',outcomeMayBeUnknown:true}};
  }
}
export interface DefinitionInput { name: string; definition: unknown; duties: string; voice: string }
export async function createAgent(input: DefinitionInput & { startingPoint: Role }): Promise<DefinitionActionResult<DefinitionResult>> {
  return call('definition.create', input, await actor(), 60_000);
}
/** A save that changes the doors, role, personal accounts or model of a started agent stops it until Apply, and the
 * stop alone can take Docker's ten-second grace period: saves get the same wait as Apply. */
const SAVE_TIMEOUT_MS = 90_000;
export async function saveDefinition(input: DefinitionInput): Promise<DefinitionActionResult<DefinitionResult>> {
  return call('definition.save', input, await actor(), SAVE_TIMEOUT_MS);
}
export async function setAgentLimit(input: {ceiling: number}): Promise<DefinitionActionResult<Capacity>> {
  return call('definition.capacity_set', {ceiling: input.ceiling}, await actor());
}
export interface MeetingsSourceResult { value: string | null; restarted: string[]; waiting: string[]; stopped: string[] }
export async function setMeetingsSource(input: {dataSource: string}): Promise<DefinitionActionResult<MeetingsSourceResult>> {
  return call('settings.notion_meetings_set', {dataSource: input.dataSource}, await actor(), 90_000);
}
export interface AgentSettingsResult { key: string; value: string | null; restarted: string[]; waiting: string[]; stopped: string[] }
export async function setAgentSetting(input: {key: string; value: string}): Promise<DefinitionActionResult<AgentSettingsResult>> {
  return call('settings.agent_environment_set', {key: input.key, value: input.value}, await actor(), 90_000);
}
export async function setNotionSync(input: {enabled: boolean; peopleDataSource: string}): Promise<DefinitionActionResult<NotionSyncView>> {
  return call('sync.notion_set', {enabled: input.enabled, peopleDataSource: input.peopleDataSource}, await actor(), 90_000);
}
/** Reads Notion and the calendar once, writes nothing; can take a few minutes. The wait is longer than the keeper's
 * own 10-minute limit for the one-shot run, so a slow preview that is stored is never reported as unknown. */
export async function runNotionSyncPreview(): Promise<DefinitionActionResult<NotionSyncView>> {
  return call('sync.notion_preview', {}, await actor(), 660_000);
}
export async function acceptNotionSyncPreview(input: {hash: string}): Promise<DefinitionActionResult<NotionSyncView>> {
  return call('sync.notion_accept', {hash: input.hash}, await actor(), 90_000);
}
export async function retireAgent(input: {name: string}): Promise<DefinitionActionResult<RetirementResult>> {
  return call('definition.retire', input, await actor());
}
export async function deleteAgent(input: {name: string; confirm: boolean}): Promise<DefinitionActionResult<unknown>> {
  const email = await actor();
  if (input.confirm !== true) throw new Error('Explicit deletion confirmation is required.');
  return call('definition.delete', {name:input.name,confirm:true}, email);
}
/** A stored token is not proof of a connected or active door. */
export async function connectDoor(input: {name: string; kind:'slack'|'telegram'; secret: string; signingSecret?:string}): Promise<DefinitionActionResult<unknown>> {
  return call('door.connect', input, await actor());
}
export async function applyConnections(input: {name: string; hash: string}): Promise<DefinitionActionResult<RuntimeState>> {
  return call('definition.reconcile', input, await actor(), 90_000);
}
export async function listConversations(input:{name:string}):Promise<DefinitionActionResult<{sessionId:string;incarnation:string;door:string;observedAt:string;terminal:boolean}[]>> {
  return call('conversation.list',input,await actor());
}
export async function startFreshConversation(input:{name:string;sessionId:string;incarnation:string;confirm:boolean}):Promise<DefinitionActionResult<{status:string}>> {
  const email=await actor();
  if(input.confirm!==true)throw new Error('Explicit conversation reset confirmation is required.');
  return call('conversation.reset',input,email);
}

/** Accepts an outside tool's new descriptions. `expectedHash` is the fingerprint the page showed;
 *  the keeper refuses if the agent has since seen another one. */
export async function acceptOutsideDescriptions(input:{name:string;tool:string;expectedHash:string}):Promise<DefinitionActionResult<{name:string;tool:string;pinHash:string}>> {
  return call('outside.accept_fingerprint',{name:input.name,tool:input.tool,expectedHash:input.expectedHash},await actor());
}

/** The agent's runtime state as the keeper sees it now (pending, running, healthy), for the page's Status box. */
export async function agentRuntime(name:string):Promise<DefinitionActionResult<RuntimeState|undefined>> {
  const read=await call<{runtime?:RuntimeState}>('definition.get',{name},await actor());
  return read.ok?{ok:true,result:read.result.runtime}:read;
}
export async function doorStatus(name:string):Promise<DefinitionActionResult<import('../../components/DoorSetup').DoorStatus[]>> {
  return call('door.status',{name},await actor());
}
export async function verifyDoor(name:string,kind:'slack'|'telegram'):Promise<DefinitionActionResult<{kind:string;username?:string;team?:string;user?:string}>> {
  return call('door.verify',{name,kind},await actor());
}
export async function claimCode(name:string,kind:'slack'|'telegram'):Promise<DefinitionActionResult<{code:string;expiresAt:string;instruction:string}>> {
  return call('door.claim_issue',{name,kind},await actor());
}
export async function registerTelegram(name:string):Promise<DefinitionActionResult<{registered:boolean}>> {
  return call('telegram.webhook_set',{name},await actor());
}
/** `messagesFollow` is set when this save also moved "Where messages go" to this door (the agent's first chat app). */
export async function setDoorEnabled(name:string,kind:'slack'|'telegram',enabled:boolean):Promise<DefinitionActionResult<DefinitionResult&{messagesFollow?:'slack'|'telegram'}>> {
  const email=await actor();
  try {
  const saved=await keeper<{definition:string;duties:string;voice:string}>('definition.get',{name},email);
  const definition=JSON.parse(saved.definition);
  // In the same save as the door: a new chief of staff's starting list follows its first chat app.
  const followed=enabled?deliveryFollowingFirstChatDoor(definition,kind):undefined;
  if(followed)definition.delivery=followed;
  const doors=definition.doors??definition.channels.map((kind:string)=>({kind,enabled:true,settings:{}}));
  definition.doors=[...doors.filter((d:{kind:string})=>d.kind!==kind),{kind,enabled,settings:doors.find((d:{kind:string})=>d.kind===kind)?.settings??{}}];
  definition.channels=definition.doors.filter((d:{enabled:boolean})=>d.enabled).map((d:{kind:string})=>d.kind);
  const result=await call<DefinitionResult>('definition.save',{name,definition,duties:saved.duties,voice:saved.voice},email,SAVE_TIMEOUT_MS);
  return result.ok&&followed?{ok:true,result:{...result.result,messagesFollow:kind}}:result;
  } catch(error) {
    if(error instanceof KeeperRefusedError)return {ok:false,error:{message:error.message,findings:error.findings,outcomeMayBeUnknown:!error.findings?.length}};
    const known=failedOrUnavailable(error);
    if(known)return {ok:false,error:known};
    return {ok:false,error:{message:'Could not read the current agent definition. Reload before changing this door.',outcomeMayBeUnknown:false}};
  }
}
