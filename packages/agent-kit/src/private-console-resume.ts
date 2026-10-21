import {currentMember} from './member-store.js';
/** Bounded private approval continuation, not fresh-human authority. The only supported action
 * is the existing immutable personal mail proposal. Source-history guards remain independent. */
import { payloadFingerprint } from './approval-ledger.js';
import { PERSONAL_MAIL_SEND_TOOL,personalActionForRequest,personalMailPayloadSchema } from './personal-action-store.js';
import { authorityTransaction,consoleAdmission,requireConsoleSessionBinding,type AuthorityDatabase,type ConsoleAuthorityContext } from './console-turn-authority.js';
import { managedIdentity } from './door-authority.js';
export const PRIVATE_RESUME_REFUSED='Private approval continuation is unavailable or changed';
const refuse=():never=>{throw new Error(PRIVATE_RESUME_REFUSED);};
export function privateResolverAdmission(auth:unknown){
  const a=auth as {authenticator?:string;attributes?:Record<string,unknown>}|undefined,v=a?.attributes;
  if(a?.authenticator!=='lares-console'||!v||typeof v.lares_resolver_member_id!=='string'||!v.lares_resolver_member_id||
    typeof v.lares_resume_request_id!=='string'||!v.lares_resume_request_id||v.lares_purpose!=='resolver'||
    !['approve','cancel'].includes(String(v.lares_resume_option))||'lares_member_id' in v||'lares_admission_nonce' in v)return undefined;
  return {memberId:v.lares_resolver_member_id,requestId:v.lares_resume_request_id,optionId:v.lares_resume_option as 'approve'|'cancel'};
}
export async function requirePrivateConsoleResume(ctx:ConsoleAuthorityContext,phase:'surface'|'response'|'model'|'action',
  options:{db?:AuthorityDatabase;env?:NodeJS.ProcessEnv;callId?:string;toolName?:string;input?:unknown}={}){
  const auth=privateResolverAdmission(ctx.session?.auth?.current),initial=consoleAdmission(ctx.session?.auth?.initiator),own=managedIdentity(options.env);
  if(!auth||!initial||initial.purpose!=='human'||auth.memberId!==initial.memberId||!own||!ctx.session?.id)refuse();
  return authorityTransaction(options.db,async db=>{
    const member=await currentMember(db as never,auth!.memberId);if(!member)refuse();
    await db.query('SELECT id FROM orgs WHERE id=$1 FOR SHARE',[member!.organisationId]);
    const locked=await currentMember(db as never,auth!.memberId,{lock:'share'});if(!locked||locked.organisationId!==member!.organisationId)refuse();
    const read=()=>personalActionForRequest(db,{requestId:auth!.requestId,memberId:auth!.memberId,agentId:own!.name,sessionId:ctx.session!.id!});
    const before=await read(),s=before.reference.selection;
    if(!before.reference.policyHash||s.incarnation!==own!.incarnation)refuse();
    const binding={agent:own!.name,incarnation:own!.incarnation,sessionId:ctx.session!.id!,memberId:auth!.memberId,admissionNonce:initial!.admissionNonce};
    await requireConsoleSessionBinding(binding,db,options.env);
    const current=await read(); // DB-clock freshness after grant/binding lock waits.
    if(auth!.optionId==='approve'&&!current.alive)refuse();
    if(phase==='model'||phase==='action'){
      if(auth!.optionId==='approve'&&(current.approvalOutcome!=='approved'||current.resolvedByMemberId!==auth!.memberId))refuse();
      if(auth!.optionId==='cancel'&&!['cancelled','ignored','invalid'].includes(current.approvalOutcome??''))refuse();
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
