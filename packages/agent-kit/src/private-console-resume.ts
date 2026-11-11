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

/**
 * THE ANSWER A TURN CONTINUES FROM (eve 1.0).
 *
 * On eve 1.0 an answered card starts no new turn: the paused turn carries on with the same turn id,
 * and `session.auth.current` stays the person who ASKED. The person who answered is only
 * `response.principal`, inside eve's response policy. So once that policy has accepted an answer,
 * it hands the answer here, and the code that continues the turn (the model seam, the settle hook)
 * reads it back. The turn's own identity and attributes never stand in for it.
 *
 * - One entry per card, keyed by conversation, turn, turn position, this run's incarnation and the
 *   card's request id. A different turn, conversation, run or card finds nothing.
 * - The continuation TAKES the entries of its own turn position: each answer opens at most one
 *   continuation. The settle hook only reads.
 * - In memory only, bounded, and gone after 30 seconds, the life of the Keeper resume receipt it
 *   carries. A restart between the answer and the continuation finds nothing, so the continuation
 *   is refused (fails closed).
 */
export type AcceptedAnswer=Readonly<{sessionId:string;turnId:string;sequence:number;incarnation:string;requestId:string;
  optionId:'approve'|'deny';memberId:string;admissionNonce:string;principal:unknown;receipt?:string;expiresAt:number}>;
export type AnswerPoint=Readonly<{sessionId:string;turnId:string;sequence:number;incarnation:string}>;
const ACCEPTED_MS=30_000,MAX_ACCEPTED=512;
const accepted=new Map<string,AcceptedAnswer>();
const pointKey=(p:AnswerPoint)=>`${p.sessionId}\0${p.turnId}\0${p.sequence}\0${p.incarnation}\0`;
function pruneAccepted(now:number){for(const [k,v] of accepted)if(v.expiresAt<=now)accepted.delete(k);}
/** The Keeper resume receipt the console's answer was admitted with, if any. */
function resumeReceiptOf(principal:unknown){
  const v=(principal as {attributes?:Record<string,unknown>}|undefined)?.attributes?.lares_model_pending_receipt;
  return typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v)?v:undefined;
}
/** Called by a response policy only after it has fully accepted the answer. A second accept of the
 *  same card (eve may ask again) replaces nothing: the first answer stands. */
export function rememberAcceptedAnswer(ctx:{request:{interactionId:string};response:{decision:'approve'|'deny';principal:unknown};session:{id:string;turn?:unknown}},
  who:{memberId:string;admissionNonce:string},env:NodeJS.ProcessEnv=process.env,now=Date.now()):void{
  const own=managedIdentity(env),turn=ctx.session?.turn as {id?:unknown;sequence?:unknown}|undefined;
  if(!own||typeof ctx.session?.id!=='string'||typeof turn?.id!=='string'||!turn.id||!Number.isSafeInteger(turn.sequence)||Number(turn.sequence)<0||
    typeof ctx.request?.interactionId!=='string'||!ctx.request.interactionId||(ctx.response?.decision!=='approve'&&ctx.response?.decision!=='deny'))return;
  pruneAccepted(now);
  const point={sessionId:ctx.session.id,turnId:turn.id,sequence:Number(turn.sequence),incarnation:own.incarnation};
  const id=pointKey(point)+ctx.request.interactionId;
  if(accepted.has(id))return;
  if(accepted.size>=MAX_ACCEPTED)return; // Full: this answer opens no continuation (refused, never guessed).
  const receipt=resumeReceiptOf(ctx.response.principal);
  accepted.set(id,Object.freeze({...point,requestId:ctx.request.interactionId,optionId:ctx.response.decision,memberId:who.memberId,
    admissionNonce:who.admissionNonce,principal:ctx.response.principal,...(receipt?{receipt}:{}),expiresAt:now+ACCEPTED_MS}));
}
/** Read one card's accepted answer without using it up (the settle hook: who answered, and how). */
export function acceptedAnswerFor(requestId:string,sessionId:string,env:NodeJS.ProcessEnv=process.env,now=Date.now()):AcceptedAnswer|undefined{
  const own=managedIdentity(env);if(!own)return undefined;
  pruneAccepted(now);
  for(const v of accepted.values())if(v.requestId===requestId&&v.sessionId===sessionId&&v.incarnation===own.incarnation)return v;
  return undefined;
}
/** Take (use up) every accepted answer for this exact turn position. */
export function takeAcceptedAnswers(point:AnswerPoint,now=Date.now()):AcceptedAnswer[]{
  pruneAccepted(now);
  const prefix=pointKey(point),out:AcceptedAnswer[]=[];
  for(const [k,v] of accepted)if(k.startsWith(prefix)){accepted.delete(k);out.push(v);}
  return out.sort((a,b)=>a.requestId<b.requestId?-1:a.requestId>b.requestId?1:0);
}
/** Tests only. */
export function clearAcceptedAnswersForTests(){accepted.clear();}
