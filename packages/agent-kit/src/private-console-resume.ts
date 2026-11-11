import {currentMember} from './member-store.js';
/** Bounded private approval continuation, not fresh-human authority. Personal mail resumes through
 * its immutable proposal. Every other card resumes through its exact reservation, which grants
 * only the surface and model phases here; its response and execution are checked in
 * approval-execution. Source-history guards remain independent. */
import { payloadFingerprint } from './approval-ledger.js';
import { exactCardForRequest } from './exact-approval-request.js';
import { PERSONAL_MAIL_SEND_TOOL,personalActionForRequest,personalMailPayloadSchema } from './personal-action-store.js';
import { authorityTransaction,consoleAdmission,requireConsoleSessionBinding,type AuthorityDatabase,type ConsoleAuthorityContext,type ConsoleBindingInput } from './console-turn-authority.js';
import { managedIdentity } from './door-authority.js';
export const PRIVATE_RESUME_REFUSED='Private approval continuation is unavailable or changed';
const refuse=():never=>{throw new Error(PRIVATE_RESUME_REFUSED);};
type ResumeReference={binding:ConsoleBindingInput;requestId:string;optionId:'approve'|'deny'};
/** The personal mail answer: resolver identity only, never a member or admission attribute. */
export function privateResolverAdmission(auth:unknown){
  const a=auth as {authenticator?:string;attributes?:Record<string,unknown>}|undefined,v=a?.attributes;
  if(a?.authenticator!=='lares-console'||!v||typeof v.lares_resolver_member_id!=='string'||!v.lares_resolver_member_id||
    typeof v.lares_resume_request_id!=='string'||!v.lares_resume_request_id||v.lares_purpose!=='resolver'||
    !['approve','deny'].includes(String(v.lares_resume_option))||'lares_member_id' in v||'lares_admission_nonce' in v)return undefined;
  return {memberId:v.lares_resolver_member_id,requestId:v.lares_resume_request_id,optionId:v.lares_resume_option as 'approve'|'deny'};
}
/** Any other card's answer: the original admission plus the one request and option it answered. */
export function exactResolverAdmission(auth:unknown){
  const admission=consoleAdmission(auth),v=(auth as {attributes?:Record<string,unknown>}|undefined)?.attributes;
  if(!admission||admission.purpose!=='resolver'||!v||typeof v.lares_resume_request_id!=='string'||!v.lares_resume_request_id||
    !['approve','deny'].includes(String(v.lares_resume_option))||'lares_resolver_member_id' in v)return undefined;
  return {memberId:admission.memberId,admissionNonce:admission.admissionNonce,requestId:v.lares_resume_request_id,optionId:v.lares_resume_option as 'approve'|'deny'};
}
/** Either kind of answer. Only code that handles both kinds may use this. */
export function privateResumeAdmission(auth:unknown){
  return privateResolverAdmission(auth)??exactResolverAdmission(auth);
}
export async function requirePrivateConsoleResume(ctx:ConsoleAuthorityContext,phase:'surface'|'response'|'model'|'action',
  options:{db?:AuthorityDatabase;env?:NodeJS.ProcessEnv;callId?:string;toolName?:string;input?:unknown}={}){
  const auth=privateResolverAdmission(ctx.session?.auth?.current),initial=consoleAdmission(ctx.session?.auth?.initiator),own=managedIdentity(options.env);
  if(!auth||!initial||initial.purpose!=='human'||auth.memberId!==initial.memberId||!own||!ctx.session?.id)refuse();
  return requireResumeReference({binding:{agent:own!.name,incarnation:own!.incarnation,sessionId:ctx.session!.id!,memberId:auth!.memberId,admissionNonce:initial!.admissionNonce},requestId:auth!.requestId,optionId:auth!.optionId},phase,options);
}
/** The checks both kinds of answer share, for the two phases that need no tool call. */
export async function requireConsoleResume(ctx:ConsoleAuthorityContext,phase:'surface'|'model',options:{db?:AuthorityDatabase;env?:NodeJS.ProcessEnv}={}){
  const auth=exactResolverAdmission(ctx.session?.auth?.current);
  if(!auth)return requirePrivateConsoleResume(ctx,phase,options);
  const initial=consoleAdmission(ctx.session?.auth?.initiator),own=managedIdentity(options.env);
  if(!initial||initial.purpose!=='human'||auth.memberId!==initial.memberId||auth.admissionNonce!==initial.admissionNonce||!own||!ctx.session?.id)refuse();
  const current=await requireExactResume({binding:{agent:own!.name,incarnation:own!.incarnation,sessionId:ctx.session!.id!,memberId:auth.memberId,admissionNonce:auth.admissionNonce},requestId:auth.requestId,optionId:auth.optionId},phase,options);
  return current??refuse();
}
/** Server-only replay of provenanced immutable prepared authority. The caller must load this
 * reference from a row created after authenticated requireConsoleResume succeeds.
 * Parsing client JSON, or knowing these coordinates, never establishes that provenance. */
export async function requirePersistedPrivateConsoleModelResume(reference:ResumeReference,options:{db:AuthorityDatabase;env?:NodeJS.ProcessEnv}){
  return requireResumeReference(reference,'model',options);
}
/** The same replay for either kind of answer: the persisted request says which card it was. */
export async function requirePersistedConsoleModelResume(reference:ResumeReference,options:{db:AuthorityDatabase;env?:NodeJS.ProcessEnv}){
  return await requireExactResume(reference,'model',options)??await requirePersistedPrivateConsoleModelResume(reference,options);
}
/** Undefined when the request is not an exact card, so the caller can try personal mail. The
 * immutable reservation already proves member, session and admission; this adds the outcome. */
async function requireExactResume(reference:ResumeReference,phase:'surface'|'model',options:{db?:AuthorityDatabase;env?:NodeJS.ProcessEnv}){
  const own=managedIdentity(options.env);
  if(!own||own.name!==reference.binding.agent||own.incarnation!==reference.binding.incarnation||!['approve','deny'].includes(reference.optionId))refuse();
  return authorityTransaction(options.db,async db=>{
    const binding=await requireConsoleSessionBinding(reference.binding,db,options.env);
    const member=await currentMember(db as never,reference.binding.memberId);if(!member)refuse();
    await db.query('SELECT id FROM orgs WHERE id=$1 FOR SHARE',[member!.organisationId]);
    const locked=await currentMember(db as never,reference.binding.memberId,{lock:'share'});if(!locked||locked.organisationId!==member!.organisationId)refuse();
    const card=await exactCardForRequest(db,{requestId:reference.requestId,agent:own!.name,incarnation:own!.incarnation,sessionId:reference.binding.sessionId,memberId:reference.binding.memberId,admissionNonce:reference.binding.admissionNonce});
    if(!card)return undefined;
    if(reference.optionId==='approve'&&!card.alive)refuse();
    if(phase==='model'){
      if(reference.optionId==='approve'&&(card.outcome!=='approved'||card.resolvedByMemberId!==reference.binding.memberId))refuse();
      if(reference.optionId==='deny'&&!['cancelled','ignored','invalid'].includes(card.outcome??''))refuse();
    }
    return {binding,validUntil:card.validUntil};
  });
}
async function requireResumeReference(reference:{binding:ConsoleBindingInput;requestId:string;optionId:'approve'|'deny'},phase:'surface'|'response'|'model'|'action',
  options:{db?:AuthorityDatabase;env?:NodeJS.ProcessEnv;callId?:string;toolName?:string;input?:unknown}){
  const own=managedIdentity(options.env),auth={memberId:reference.binding.memberId,requestId:reference.requestId,optionId:reference.optionId};
  if(!own||own.name!==reference.binding.agent||own.incarnation!==reference.binding.incarnation||!['approve','deny'].includes(auth.optionId))refuse();
  return authorityTransaction(options.db,async db=>{
    const binding=await requireConsoleSessionBinding(reference.binding,db,options.env);
    const member=await currentMember(db as never,auth!.memberId);if(!member)refuse();
    await db.query('SELECT id FROM orgs WHERE id=$1 FOR SHARE',[member!.organisationId]);
    const locked=await currentMember(db as never,auth!.memberId,{lock:'share'});if(!locked||locked.organisationId!==member!.organisationId)refuse();
    const read=()=>personalActionForRequest(db,{requestId:auth!.requestId,memberId:auth!.memberId,agentId:own!.name,sessionId:reference.binding.sessionId});
    const before=await read(),s=before.reference.selection;
    if(!before.reference.policyHash||s.incarnation!==own!.incarnation)refuse();
    const current=await read(); // DB-clock freshness after grant/binding lock waits.
    if(auth!.optionId==='approve'&&!current.alive)refuse();
    if(phase==='model'||phase==='action'){
      if(auth!.optionId==='approve'&&(current.approvalOutcome!=='approved'||current.resolvedByMemberId!==auth!.memberId))refuse();
      if(auth!.optionId==='deny'&&!['cancelled','ignored','invalid'].includes(current.approvalOutcome??''))refuse();
    }
    if(phase==='response'||phase==='action'){
      if((phase==='response'&&current.approvalOutcome!==null&&current.approvalOutcome!=='approved')||auth!.optionId!=='approve'||options.callId!==s.originalCallId||options.toolName!==PERSONAL_MAIL_SEND_TOOL)refuse();
      const input=options.input as {selection?:unknown;to?:unknown;subject?:unknown;body?:unknown}|undefined;
      const selected={accountId:s.accountId,generation:s.accountGeneration,resourceBindingId:s.resourceBindingId};
      if(!input||payloadFingerprint('selection',input.selection)!==payloadFingerprint('selection',selected)||
        payloadFingerprint('mail.send',personalMailPayloadSchema.parse({to:input.to,subject:input.subject,body:input.body}))!==current.reference.payloadHash)refuse();
    }
    return {...current,binding};
  });
}
