'use server';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { agentAccessUpdateSchema, GrantStoreError } from '@lares/agent-kit/grant-store';
import { requireConsoleMember } from '../../lib/auth';
import { agentAccess } from '../../lib/agent-access';
import { ConsoleAdmissionUnavailableError } from '../../lib/admission-error';
export type AccessResult={error?:string;saved?:boolean};
function text(form:FormData,key:string):string|undefined {const value=form.get(key);return typeof value==='string'&&value.length>0&&value.length<=200?value:undefined;}
function failure(error:unknown):AccessResult {
  if(error instanceof GrantStoreError)return {error:error.code==='stale'?'Agent access changed. Reload before saving again.':error.code==='invalid'?'Check the selected members and expiry.':'Access was refused. Adoption needs your current owner capability policy; sharing needs current ownership and active members.'};
  throw new ConsoleAdmissionUnavailableError();
}
export async function adoptAgent(_previous:AccessResult,form:FormData):Promise<AccessResult> {
  const actor=await requireConsoleMember(),agentName=text(form,'agentName'),expectedDefinitionHash=text(form,'definitionHash');
  if(!agentName||!expectedDefinitionHash)return {error:'Reload the current agent definition before adopting.'};
  try {await agentAccess.adoptAgent(actor.id,{agentName,expectedDefinitionHash},{designatedOwnerMemberId:process.env.AGENT_OWNER_USER_ID?.trim()??'',sessionToken:(await cookies()).get('lares_session')?.value??''});revalidatePath(`/agents/${agentName}`);return {saved:true};}
  catch(error){return failure(error);}
}
export async function saveAgentAccess(_previous:AccessResult,form:FormData):Promise<AccessResult> {
  const actor=await requireConsoleMember(),agentName=text(form,'agentName'),rawRevision=text(form,'revision'),use=form.get('use');
  if(!agentName||!rawRevision||!/^\d+$/.test(rawRevision)||!['personal','named','organisation'].includes(String(use)))return {error:'Reload agent access before saving.'};
  const readers=form.getAll('readers'),editors=form.getAll('editors');
  if([...readers,...editors].some(value=>typeof value!=='string'||!value||value.length>200)||readers.length+editors.length>200)return {error:'Choose valid members.'};
  const expiry=form.get('expiresAt');
  if(expiry!==null&&typeof expiry!=='string')return {error:'Choose a valid expiry.'};
  if(expiry&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(expiry))return {error:'Choose a valid UTC expiry.'};
  const expiresAt=expiry?new Date(`${expiry}Z`):null;
  if(expiresAt&&!Number.isFinite(expiresAt.getTime()))return {error:'Choose a valid expiry.'};
  const grants=[...(use==='organisation'?[{principal:{kind:'organisation' as const,id:actor.organisationId},permission:'use' as const}]:use==='named'?readers.map(value=>({principal:{kind:'member' as const,id:value as string},permission:'use' as const})):[]),...editors.map(value=>({principal:{kind:'member' as const,id:value as string},permission:'edit' as const}))].map(g=>({...g,expiresAt:expiresAt?.toISOString()??null}));
  const parsed=agentAccessUpdateSchema.safeParse({agentName,expectedRevision:Number(rawRevision),grants});
  if(!parsed.success)return {error:'Check the members, access revision and expiry.'};
  try {await agentAccess.updateAgentAccess(actor.id,parsed.data,{sessionToken:(await cookies()).get('lares_session')?.value??''});revalidatePath(`/agents/${agentName}`);return {saved:true};}
  catch(error){return failure(error);}
}
