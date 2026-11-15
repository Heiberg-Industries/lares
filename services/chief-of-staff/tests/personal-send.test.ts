/** Real PostgreSQL authority, custody, immutable action and receipt; fake provider only.
 * Resolver contexts below are SYNTHETIC caller fixtures, not the installed Eve resolver.
 * Exact approval-response admission, catalogue enablement and model continuation are separate. */
const {purposeRequestMock}=vi.hoisted(()=>({purposeRequestMock:vi.fn()}));
vi.mock('@lares/agent-kit/model-purpose-client',()=>({modelPurposeRequest:purposeRequestMock}));
// eve keeps Lares's per-session marks in its durable session state, which only a running eve session
// can read; here those `lares.` states are held in memory (cleared by the tests that use them).
const eveState=vi.hoisted(()=>new Map<string,unknown>());
vi.mock('eve/context',async original=>{
 const real=await original<typeof import('eve/context')>();
 return {...real,defineState:(key:string,initial:()=>unknown)=>!key.startsWith('lares.')?(real.defineState as (k:string,i:()=>unknown)=>unknown)(key,initial):
  {get:()=>(eveState.has(key)?eveState.get(key):initial()),update:(fn:(v:unknown)=>unknown)=>{eveState.set(key,fn(eveState.has(key)?eveState.get(key):initial()));}}};
});
vi.mock('@lares/agent-kit/google-auth',async original=>({...await original<typeof import('@lares/agent-kit/google-auth')>(),readTokenEncKey:()=> '1'.repeat(64)}));
import { fileURLToPath,pathToFileURL } from 'node:url';
import { beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi,type Mock } from 'vitest';
import { PostgreSqlContainer,type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync,readdirSync } from 'node:fs';
import { Pool } from 'pg';
import { PgAccountStore,type TrustedAccountAdapter } from '@lares/agent-kit/account-store';
import { PgGrantStore } from '@lares/agent-kit/grant-store';
import {assertPrivateConsoleRequest} from '@lares/agent-kit/private-console-envelope';
import { bindConsoleSession,consoleRouteAdmission } from '@lares/agent-kit/console-turn-authority';
import { PgPersonalActionStore,personalActionApprovalDescriptor,PERSONAL_MAIL_SEND_TOOL,type PersonalActionApprovedReference } from '@lares/agent-kit/personal-action-store';
import { encryptSecret,decryptSecret } from '@lares/agent-box/lib/crypto.js';
import {getPool,closePool} from '@lares/agent-kit/db';
import { definitionModelResolver } from '@lares/agent-kit/definition-model';
import { emptySessionView } from 'eve/events';
import {personalSendApprovalRequest,personalSendInputRequested,personalSendApprovalResponse,personalSendInputResolved,requirePersonalSendCall,NEW_SEND_AFTER_ANSWER_REFUSED} from '../lib/personal-send-approval.js';
import {noteAnswerApplied} from '../lib/approval-card-turns.js';
import { claimModelPurposeForInvocation,closeModelPurposeTurn,openContinuationAfterSettle,prepareModelPurposeInvocation } from '../agent/lib/model-purpose.js';
import {requirePrivateConsoleResume,clearAcceptedAnswersForTests,settleAcceptedAnswer} from '@lares/agent-kit/private-console-resume';
import {readPersonalResource} from '../lib/personal-reads.js';
import { executeApprovedPersonalSend,requirePersonalSendPolicy,type PersonalSendRuntime } from '../lib/personal-send.js';
import { quiet } from './helpers/quiet-pool.js';
const incarnation='11111111-1111-4111-8111-111111111111',nonce='a'.repeat(43),key='1'.repeat(64);
const env={LARES_AGENT_NAME:'helper',LARES_AGENT_INCARNATION:incarnation,AGENT_OWNER_USER_ID:'member-a'};
const auth=(purpose='human',member='member-a')=>({authenticator:'lares-console',attributes:{lares_member_id:member,lares_admission_nonce:nonce,lares_purpose:purpose}});
const def={name:'helper',model:'fixture-brain',persona:'voice.md',role:'chief-of-staff',channels:[],grants:[{capability:'personal_mailbox',scope:'write-with-confirm'}],autonomy:{personal_mailbox:'autonomous'},skills:[]};
let container:StartedPostgreSqlContainer,pool:Pool,accounts:PgAccountStore,actions:PgPersonalActionStore;
let call=0,sends:Mock<(...a:any[])=>any>,opens:Mock<(...a:any[])=>any>,hold:(()=>Promise<void>)|undefined;
const crypto={encrypt:(text:string)=>encryptSecret(text,key),decrypt:(text:string)=>decryptSecret(text,key)};
const runtime:PersonalSendRuntime={open:async(selection,credential,signal,rotate)=>{
  opens();await hold?.();signal.throwIfAborted();await rotate(encryptSecret('rotated-refresh',key));
  return {adapter:{send:async payload=>{sends(payload);return {state:'accepted',providerStatus:202};}}};
}};
const resolverAuth=(requestId:string,option='approve',member='member-a')=>({authenticator:'lares-console',attributes:{lares_resolver_member_id:member,lares_resume_request_id:requestId,lares_resume_option:option,lares_purpose:'resolver'}});
const context=(ref:PersonalActionApprovedReference,purpose='resolver',member='member-a')=>({callId:ref.selection.originalCallId,
  session:{id:'wrun_send',turn:{id:'resolver-turn',sequence:1},auth:{current:purpose==='resolver'?resolverAuth(ref.requestId,'approve',member):auth(purpose,member),initiator:auth()}}});
async function connected(member='member-a'){
 const adapter:TrustedAccountAdapter={connectorId:'microsoft',verifyAccount:async()=>({issuer:'https://login.microsoftonline.com/fixture/v2.0',subject:member,label:'Own account'}),
   verifyResource:async()=>({resourceKind:'mailbox',externalId:member,providerLabel:'Own mailbox'})};
 const account=await accounts.forTrustedAdapter(adapter).createPersonalAccount(member,null,{persist:async(db,owner)=>{
   const {rows}=await db.query(`INSERT INTO oauth_tokens(principal,provider,org_id,email_address,scopes,refresh_token_enc)
     VALUES($1,$2,'microsoft','own@example.invalid',ARRAY['Mail.Send'],$3) RETURNING id`,[member,owner.connectorId,encryptSecret('original-refresh',key)]);return rows[0].id;
 }},['mailbox']);
 const [resource]=await accounts.listResources(member,account.id,account.generation);return {account,resource};
}
async function policyHash(){const db=await pool.connect();try{await db.query('BEGIN');const value=await requirePersonalSendPolicy(db,'helper',incarnation,'member-a');await db.query('COMMIT');return value;}finally{db.release();}}
async function ready(approvalLifetimeMs=86_400_000,existing?:Awaited<ReturnType<typeof connected>>){
 const own=existing??await connected(),selection={actorMemberId:'member-a',agentId:'helper',incarnation,sessionId:'wrun_send',originalTurnId:'original-turn',
   originalCallId:`call-${++call}`,accountId:own.account.id,accountGeneration:own.account.generation,resourceBindingId:own.resource.id,connectorId:'microsoft',kind:'mail.send' as const};
 const capturedPolicy=await policyHash();
 const payload={to:['recipient@example.invalid'],subject:'Exact subject',body:'Exact body'},action=await actions.prepareAction({...selection,payload}),requestId=`request-${call}`;
 await pool.query(`INSERT INTO approval_asks(call_id,request_id,agent,tool,payload_hash,original_authority,acting_member_id,resolved_by_member_id,session_id,outcome,answered_at,asked_at)
   VALUES($1,$2,'helper',$3,$4,$5::jsonb,'member-a','member-a','wrun_send','approved',clock_timestamp(),clock_timestamp()-interval '24 hours'+($6*interval '1 millisecond'))`,
   [selection.originalCallId,requestId,PERSONAL_MAIL_SEND_TOOL,action.payloadHash,JSON.stringify(personalActionApprovalDescriptor(action,selection,capturedPolicy)),approvalLifetimeMs]);
 await actions.attachApproval({actionId:action.actionId,actorMemberId:'member-a',approvalCallId:selection.originalCallId,requestId});
 return {own,payload,ref:{actionId:action.actionId,payloadHash:action.payloadHash,approvalCallId:selection.originalCallId,requestId,resolvedByMemberId:'member-a',policyHash:capturedPolicy,selection} satisfies PersonalActionApprovedReference};
}
const execute=(ref:PersonalActionApprovedReference,extra:Partial<Parameters<typeof executeApprovedPersonalSend>[2]>={})=>executeApprovedPersonalSend(context(ref),ref,{pool,actions,runtime,env,...extra});
const stored=async(id:string)=>(await pool.query('SELECT * FROM personal_actions WHERE id=$1',[id])).rows[0];
beforeAll(async()=>{
 container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();vi.stubEnv('DATABASE_URL',container.getConnectionUri());for(const [k,v]of Object.entries(env))vi.stubEnv(k,v);quiet(getPool());pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));
 const sql=new URL('../../box/sql/',import.meta.url);for(const name of readdirSync(sql).filter(n=>n.endsWith('.sql')).sort())await pool.query(readFileSync(new URL(name,sql),'utf8'));
 accounts=new PgAccountStore(pool);actions=new PgPersonalActionStore(pool,crypto);
},120_000);
afterAll(async()=>{await closePool();await pool?.end();await container?.stop();vi.unstubAllEnvs();});
beforeEach(async()=>{
 await pool.query('DELETE FROM personal_actions; DELETE FROM approval_asks; DELETE FROM console_session_bindings; DELETE FROM connected_accounts; DELETE FROM oauth_tokens; DELETE FROM agent_resources; DELETE FROM agent_definitions; DELETE FROM ratchet');
 await pool.query(`INSERT INTO orgs(id,display_name) VALUES('fixture-org','Fixture') ON CONFLICT DO NOTHING;
   INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-a','A','fixture-org','owner','active'),('member-b','B','fixture-org','owner','active') ON CONFLICT(id) DO UPDATE SET status='active',org_role='owner';
   INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES('member-a',NULL) ON CONFLICT(user_id) DO UPDATE SET allowed_capabilities=NULL;`);
 await pool.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES('helper',$1,'fixture','valid')",[def]);
 await pool.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending,applied_definition) VALUES('helper','127.0.0.2','fixture','owned',$1,$1,'ready',false,$2)`,[incarnation,def]);
 await new PgGrantStore(pool).adoptAgent('member-a',{agentName:'helper',expectedDefinitionHash:'fixture'},{designatedOwnerMemberId:'member-a'});
 await bindConsoleSession({agent:'helper',incarnation,sessionId:'wrun_send',memberId:'member-a',admissionNonce:nonce},pool,env);
 sends=vi.fn();opens=vi.fn();hold=undefined;
});
describe('personal mail current authority executor',()=>{
 it('commits exactly one claim, uses immutable payload, settles202 and encrypted rotation; cold replay never sends',async()=>{
   const {ref,payload}=await ready(),result=await execute(ref);
   expect(result).toMatchObject({state:'accepted',receipt:{state:'accepted',providerStatus:202}});expect(sends).toHaveBeenCalledExactlyOnceWith(payload);
   expect((await stored(ref.actionId)).receipt).toEqual({state:'accepted',providerStatus:202});
   expect(decryptSecret((await pool.query('SELECT refresh_token_enc FROM oauth_tokens')).rows[0].refresh_token_enc,key)).toBe('rotated-refresh');
   expect(await execute(ref,{actions:new PgPersonalActionStore(pool,crypto)})).toEqual(result);expect(sends).toHaveBeenCalledOnce();
 });
 it('has no nested acquisition with a one-connection pool across claim, authority, rotation and settlement',async()=>{
   const {ref}=await ready(),single=quiet(new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:500}));
   try{expect((await execute(ref,{pool:single,actions:new PgPersonalActionStore(single,crypto)})).state).toBe('accepted');}finally{await single.end();}
 });
 it('simultaneous exact requests invoke the provider once',async()=>{
   const {ref}=await ready();await Promise.all([execute(ref),execute(ref)]);expect(sends).toHaveBeenCalledOnce();
 });
 it.each(['removed','revoked','reconnected','binding','policy','definition','board','custody','resource'] as const)('refuses changed %s before opening a provider',async change=>{
   const {ref,own}=await ready();
   if(change==='removed')await pool.query("UPDATE users SET status='removed' WHERE id='member-a'");
   if(change==='revoked')await accounts.setStatus('member-a',await accounts.beginUpdate('member-a',own.account.id,0),'revoked');
   if(change==='reconnected')await pool.query('UPDATE connected_accounts SET generation=generation+1 WHERE id=$1',[own.account.id]);
   if(change==='binding')await pool.query('UPDATE console_session_bindings SET revoked_at=clock_timestamp()');
   if(change==='policy')await pool.query("UPDATE org_member_policy SET allowed_capabilities=ARRAY[]::text[] WHERE user_id='member-a'");
   if(change==='definition')await pool.query("UPDATE agent_resources SET applied_definition=$1 WHERE name='helper'",[{...def,grants:[{capability:'personal_mailbox',scope:'read'}]}]);
   if(change==='board')await pool.query("INSERT INTO ratchet(agent,capability,level,updated_by) VALUES('helper','personal_mailbox','never','fixture')");
   if(change==='custody')await pool.query('UPDATE connected_account_credentials SET account_generation=99');
   if(change==='resource')await pool.query('DELETE FROM connected_resource_bindings');
   expect((await execute(ref)).state).toBe('not_dispatched');expect(opens).not.toHaveBeenCalled();expect(sends).not.toHaveBeenCalled();
 });
 it.each([['','gated'],['','autonomous'],['send','gated'],['send','autonomous']])('definition never overrides permissive board action=%j level=%s after approval',async(action,level)=>{
   const {ref}=await ready();
   await pool.query("INSERT INTO ratchet(agent,capability,action,level,updated_by) VALUES('helper','personal_mailbox',$1,$2,'fixture')",[action,level]);
   await pool.query("UPDATE agent_resources SET applied_definition=$1 WHERE name='helper'",[{...def,autonomy:{personal_mailbox:'never'}}]);
   expect((await execute(ref)).state).toBe('not_dispatched');expect(opens).not.toHaveBeenCalled();expect(sends).not.toHaveBeenCalled();
   expect((await stored(ref.actionId)).state).toBe('not_dispatched');
 });
 it('refuses a definition changed to never after the durable claim, despite a permissive send board',async()=>{
   const {ref}=await ready();
   await pool.query("INSERT INTO ratchet(agent,capability,action,level,updated_by) VALUES('helper','personal_mailbox','send','autonomous','fixture')");
   const claim=actions.claimAction.bind(actions);
   const replacement=vi.spyOn(actions,'claimAction').mockImplementationOnce(async input=>{
     const claimed=await claim(input);expect(claimed.permit).toBeDefined();
     await pool.query("UPDATE agent_resources SET applied_definition=$1 WHERE name='helper'",[{...def,autonomy:{personal_mailbox:'never'}}]);
     return claimed;
   });
   try{expect((await execute(ref)).state).toBe('not_dispatched');}finally{replacement.mockRestore();}
   expect(opens).not.toHaveBeenCalled();expect(sends).not.toHaveBeenCalled();expect((await stored(ref.actionId)).state).toBe('not_dispatched');
 });
 it('does not treat resolver-only identity as a fresh human binding or executable resume',async()=>{
   const {ref}=await ready(),ctx=context(ref);
   ctx.session.auth.current={authenticator:'lares-console',attributes:{lares_resolver_member_id:'member-a',lares_purpose:'resolver'}} as never;
   await expect(executeApprovedPersonalSend(ctx,ref,{pool,actions,runtime,env})).rejects.toThrow();expect(sends).not.toHaveBeenCalled();
 });
 it.each(['human','cross-member','call','session','hash','cancelled','resolver'] as const)('refuses wrong %s or approval before dispatch',async change=>{
   const {ref}=await ready(),ctx=context(ref);
   if(change==='human')ctx.session.auth.current=auth();if(change==='cross-member')ctx.session.auth.current=auth('resolver','member-b');
   if(change==='call')ctx.callId='other';if(change==='session')ctx.session.id='other';if(change==='hash')ref.payloadHash='b'.repeat(64);
   if(change==='cancelled')await pool.query("UPDATE approval_asks SET outcome='cancelled' WHERE call_id=$1",[ref.approvalCallId]);
   if(change==='resolver')ref.resolvedByMemberId='member-b';
   await expect(executeApprovedPersonalSend(ctx,ref,{pool,actions,runtime,env})).rejects.toThrow();expect(sends).not.toHaveBeenCalled();
 });
 it('checks DB-clock approval expiry again after asynchronous identity work',async()=>{
   const {ref}=await ready(500);hold=()=>new Promise(resolve=>setTimeout(resolve,650));
   expect((await execute(ref)).state).toBe('not_dispatched');expect(sends).not.toHaveBeenCalled();
   expect(decryptSecret((await pool.query('SELECT refresh_token_enc FROM oauth_tokens')).rows[0].refresh_token_enc,key)).toBe('original-refresh');
 });
 it('treats synchronously thrown and rejected post-invocation errors as unknown, never nothing sent',async()=>{
   const {ref}=await ready();const uncertain:PersonalSendRuntime={open:async()=>({adapter:{send:()=>{sends();throw new Error('PRIVATE TRANSPORT');}}})};
   const result=await execute(ref,{runtime:uncertain});expect(result).toMatchObject({state:'unknown',receipt:{code:'transport_uncertain'}});
   expect(JSON.stringify(result)).not.toContain('PRIVATE');await execute(ref,{runtime:uncertain});expect(sends).toHaveBeenCalledOnce();
 });
 it('rolls back acceptance and rotation when the caller transaction fails after invocation; preserves unknown forever',async()=>{
   const {ref}=await ready();const failing:PersonalSendRuntime={open:async(...args)=>({...await runtime.open(...args),close:async()=>{throw new Error('PRIVATE CLOSE');}})};
   expect((await execute(ref,{runtime:failing})).state).toBe('unknown');expect(sends).toHaveBeenCalledOnce();
   expect(decryptSecret((await pool.query('SELECT refresh_token_enc FROM oauth_tokens')).rows[0].refresh_token_enc,key)).toBe('original-refresh');
   await execute(ref);expect(sends).toHaveBeenCalledOnce();
 });
 it.each(['member-removal','reconnect','ratchet-first-never'] as const)('serializes %s behind the bounded send, including an absent ratchet row',async change=>{
   const {ref,own}=await ready();let entered!:()=>void,release!:()=>void;
   const readyToWrite=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});hold=async()=>{entered();await wait;};
   const other=quiet(new Pool({connectionString:container.getConnectionUri(),application_name:'send-lock-proof',max:1}));
   const running=execute(ref);let mutation:Promise<unknown>|undefined;
   try{
     await readyToWrite;
     mutation=change==='member-removal'?other.query("UPDATE users SET status='removed' WHERE id='member-a'"):change==='reconnect'?
       new PgAccountStore(other).beginUpdate('member-a',own.account.id,0).then(update=>new PgAccountStore(other).setStatus('member-a',update,'needs_reconsent')):
       other.query("INSERT INTO ratchet(agent,capability,level,updated_by) VALUES('helper','personal_mailbox','never','fixture')");
     const settled=mutation.then(()=>({ok:true}),error=>({error}));let blocked=false;
     for(let n=0;n<100;n++){blocked=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name='send-lock-proof' AND wait_event_type='Lock'")).rows.length>0;if(blocked)break;await new Promise(r=>setTimeout(r,10));}
     expect(blocked).toBe(true);release();expect((await running).state).toBe('accepted');expect(await settled).toEqual({ok:true});expect(sends).toHaveBeenCalledOnce();
   }finally{release();await running.catch(()=>undefined);await mutation?.catch(()=>undefined);await other.end();}
 },10_000);
 it.each([1,2])('never dispatches again after uncertain transaction%s COMMIT acknowledgement',async loseCommit=>{
   const {ref}=await ready();let commits=0;
   const uncertain={query:pool.query.bind(pool),connect:async()=>{
     const client=await pool.connect();return {release:()=>client.release(),query:async(sql:string,values?:unknown[])=>{
       const result=await client.query(sql,values);if(sql==='COMMIT'&&++commits===loseCommit)throw new Error('PRIVATE COMMIT ACK');return result;
     }};
   }} as unknown as Pool;
   const operation=execute(ref,{pool:uncertain,actions:new PgPersonalActionStore(uncertain,crypto)});
   if(loseCommit===1){await expect(operation).rejects.toThrow();expect(sends).not.toHaveBeenCalled();}
   else expect((await operation).state).toBe('unknown');
   const replay=await execute(ref,{actions:new PgPersonalActionStore(pool,crypto)});
   expect(replay.state).toBe(loseCommit===1?'unknown':'accepted');expect(sends).toHaveBeenCalledTimes(loseCommit===1?0:1);
 });
 it('SQL021 refuses an unknown receipt schema without replacing it',async()=>{
   const client=await pool.connect();
   try{
     await client.query('BEGIN');await client.query('ALTER TABLE personal_actions DROP CONSTRAINT personal_actions_receipt_check_v2');
     await client.query("ALTER TABLE personal_actions ADD CONSTRAINT unexpected_receipt CHECK(receipt IS NULL OR receipt->>'state'='accepted')");
     await expect(client.query(readFileSync(new URL('../../box/sql/021_personal_action_acceptance.sql',import.meta.url),'utf8'))).rejects.toThrow('Unknown personal action receipt contract');
   }finally{await client.query('ROLLBACK');client.release();}
 });
 it('SQL021 replays without changing receipt or pending action and refuses malformed/extra receipt fields',async()=>{
   const {ref,own}=await ready();await execute(ref);
   await pool.query(readFileSync(new URL('../../box/sql/021_personal_action_acceptance.sql',import.meta.url),'utf8'));
   expect((await stored(ref.actionId)).receipt).toEqual({state:'accepted',providerStatus:202});
   const next=await ready(86_400_000,own),claim=await actions.claimAction(next.ref);
   for(const receipt of [{state:'accepted',providerStatus:200},{state:'accepted',providerStatus:202,providerReceiptId:''},{state:'accepted',providerStatus:202,raw:'private'}])
     await expect(pool.query("UPDATE personal_actions SET state='accepted',receipt=$2::jsonb,completed_at=clock_timestamp() WHERE id=$1",[next.ref.actionId,JSON.stringify(receipt)])).rejects.toThrow();
   expect(claim.permit).toBeDefined();
 });
});

/** eve's own re-check before an approved call: the real evaluateApproval with recheck on. */
const evalUrl=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/approval/evaluation.js',import.meta.url))).href;
const recheckOf=async(ctx:any)=>((await import(evalUrl)) as any).evaluateApproval((c:any)=>personalSendApprovalRequest(c),ctx,{recheck:true});
async function proposed(){
 const own=await connected(),input={selection:{accountId:own.account.id,generation:own.account.generation,resourceBindingId:own.resource.id},to:['recipient@example.invalid'],subject:'Exact review',body:'Whole body'},callId=`human-${++call}`;
 const human={callId,toolInput:input,session:{id:'wrun_send',turn:{id:'original-human',sequence:0},auth:{current:auth(),initiator:auth()}}};
 expect(await personalSendApprovalRequest(human)).toBe('user-approval');
 const row=(await pool.query('SELECT * FROM personal_actions WHERE original_call_id=$1',[callId])).rows[0];
 expect(row.state).toBe('awaiting_approval');expect((await pool.query('SELECT request_id FROM approval_asks WHERE call_id=$1',[callId])).rows[0].request_id).toBeNull();
 const requestId=`framework-${call}`;await personalSendInputRequested({requestId,callId,input},human);
 const resume={callId,toolInput:input,session:{id:'wrun_send',turn:{id:'resolver-only',sequence:1},auth:{current:resolverAuth(requestId),initiator:auth()}}};
 const response={request:{interactionId:requestId,callId,toolName:PERSONAL_MAIL_SEND_TOOL,toolInput:input},response:{decision:'approve' as 'approve'|'deny',principal:resume.session.auth.current as unknown},session:{id:'wrun_send',initiator:auth()}};
 // eve 1.0: the approved call runs (and its policy is asked again) as the person who ASKED, in the original turn;
 // the person who answered is only `approval.responder`.
 const run={...human,approval:{responder:resolverAuth(requestId)}};
 return {own,input,callId,requestId,row,resume,response,human,run};
}
describe('exact personal approval lifecycle through authenticated resolver references',()=>{
 it('admits one exact raw response into resolver-only attributes without human authority',async()=>{
  const p=await proposed();
  const request=()=>new Request('http://runtime.invalid/eve/v1/session/wrun_send',{method:'POST',headers:{'x-lares-member-id':'member-a','x-lares-admission':nonce,'x-lares-purpose':'resolver'},body:JSON.stringify({answers:[{interactionId:p.requestId,optionId:'approve'}]})});
  await expect(consoleRouteAdmission(request(),pool,env)).rejects.toThrow();
  const exact=request();await assertPrivateConsoleRequest(exact);
  expect(await consoleRouteAdmission(exact,pool,env)).toEqual(resolverAuth(p.requestId).attributes);
  await expect(consoleRouteAdmission(exact.clone(),pool,env)).rejects.toThrow();
 });
 it('prepares before a card, authenticates the actual response, revalidates SDK policy and returns the original action only',async()=>{
  const p=await proposed();await expect(requirePrivateConsoleResume(p.resume,'model')).rejects.toThrow();
  expect(await personalSendApprovalResponse(p.response)).toEqual({status:'allowed'});
  expect(await recheckOf(p.human)).toMatchObject({denied:false}); // the re-check, as the requester
  await expect(requirePersonalSendCall(p.human,p.input)).rejects.toThrow(); // no responder on the run: not approved
  expect((await requirePersonalSendCall(p.run,p.input)).reference.actionId).toBe(p.row.id);
  expect((await requirePrivateConsoleResume(p.resume,'model')).reference.requestId).toBe(p.requestId);
  expect(p.resume.session.auth.current.attributes).not.toHaveProperty('lares_member_id');
  expect(p.resume.session.auth.current.attributes).not.toHaveProperty('lares_admission_nonce');
 });
 it.each(['member','request','call','session','payload','selection'] as const)('refuses changed response %s before recording approval',async changed=>{
  const p=await proposed(),response=structuredClone(p.response);
  if(changed==='member')response.response.principal=resolverAuth(p.requestId,'approve','member-b');
  if(changed==='request')response.request.interactionId='other';if(changed==='call')response.request.callId='other';if(changed==='session')response.session.id='other';
  if(changed==='payload')response.request.toolInput.body='Changed';if(changed==='selection')response.request.toolInput.selection.generation++;
  await expect(personalSendApprovalResponse(response)).rejects.toThrow();
  expect((await pool.query('SELECT outcome FROM approval_asks WHERE call_id=$1',[p.callId])).rows[0].outcome).toBeNull();expect(sends).not.toHaveBeenCalled();
 });
 it.each(['deny-restore','absent-never-absent'] as const)('invalidates an enabled pending approval after %s board history',async change=>{
  if(change==='deny-restore')await pool.query("INSERT INTO ratchet(agent,capability,action,level,updated_by) VALUES('helper','personal_mailbox','send','gated','fixture')");
  const p=await proposed();
  if(change==='deny-restore'){
   await pool.query("UPDATE ratchet SET level='never' WHERE agent='helper'");await pool.query("UPDATE ratchet SET level='gated' WHERE agent='helper'");
  }else{
   await pool.query("INSERT INTO ratchet(agent,capability,action,level,updated_by) VALUES('helper','personal_mailbox','send','never','fixture')");await pool.query("DELETE FROM ratchet WHERE agent='helper'");
  }
  await expect(personalSendApprovalResponse(p.response)).rejects.toThrow();
  expect(await recheckOf(p.human)).toMatchObject({denied:true});expect(opens).not.toHaveBeenCalled();expect(sends).not.toHaveBeenCalled();
 });
 it('refuses restored board policy after response approval and after claim before provider open',async()=>{
  const p=await proposed();await personalSendApprovalResponse(p.response);
  const ref=(await requirePersonalSendCall(p.run,p.input)).reference;
  const claim=actions.claimAction.bind(actions);vi.spyOn(actions,'claimAction').mockImplementationOnce(async input=>{
   const result=await claim(input);
   await pool.query("INSERT INTO ratchet(agent,capability,action,level,updated_by) VALUES('helper','personal_mailbox','send','never','fixture')");await pool.query("DELETE FROM ratchet WHERE agent='helper'");return result;
  });
  expect((await execute(ref)).state).toBe('not_dispatched');expect(opens).not.toHaveBeenCalled();expect(sends).not.toHaveBeenCalled();
 });
 it('refuses a Deny from anyone but the person who may approve, and the proposal stays pending',async()=>{
  const p=await proposed(),deny=(principal:unknown,over:Record<string,unknown>={})=>({...structuredClone(p.response),response:{decision:'deny' as const,principal},...over});
  const pending=async()=>({ask:(await pool.query('SELECT outcome FROM approval_asks WHERE call_id=$1',[p.callId])).rows[0].outcome,state:(await stored(p.row.id)).state});
  const before=await pending();expect(before.ask).toBeNull();
  // Another member, the owner's Approve dressed as a Deny, a human turn, nobody, the wrong card or conversation.
  await expect(personalSendApprovalResponse(deny(resolverAuth(p.requestId,'deny','member-b')))).rejects.toThrow();
  await expect(personalSendApprovalResponse(deny(resolverAuth(p.requestId,'approve')))).rejects.toThrow();
  await expect(personalSendApprovalResponse(deny(auth()))).rejects.toThrow();
  await expect(personalSendApprovalResponse(deny(null))).rejects.toThrow();
  await expect(personalSendApprovalResponse(deny(resolverAuth('other','deny')))).rejects.toThrow();
  await expect(personalSendApprovalResponse({...deny(resolverAuth(p.requestId,'deny')),session:{id:'other',initiator:auth()}})).rejects.toThrow();
  await expect(personalSendApprovalResponse({...deny(resolverAuth(p.requestId,'deny')),request:{...p.response.request,callId:'other'}})).rejects.toThrow();
  // A decision that is neither approve nor deny.
  await expect(personalSendApprovalResponse({...deny(resolverAuth(p.requestId,'deny')),response:{decision:'cancel' as never,principal:resolverAuth(p.requestId,'deny')}})).rejects.toThrow();
  expect(await pending()).toEqual(before);
  // The owner's own Deny is allowed and records nothing by itself; eve's settlement records it.
  expect(await personalSendApprovalResponse(deny(resolverAuth(p.requestId,'deny')))).toEqual({status:'allowed'});
  expect(await pending()).toEqual(before);
  expect(sends).not.toHaveBeenCalled();
 });
 it('an Approve whose option says Deny, and a Deny whose option says Approve, are both refused',async()=>{
  const p=await proposed();
  await expect(personalSendApprovalResponse({...p.response,response:{decision:'approve',principal:resolverAuth(p.requestId,'deny')}})).rejects.toThrow();
  await expect(personalSendApprovalResponse({...p.response,response:{decision:'deny',principal:resolverAuth(p.requestId,'approve')}})).rejects.toThrow();
  expect((await pool.query('SELECT outcome FROM approval_asks WHERE call_id=$1',[p.callId])).rows[0].outcome).toBeNull();
 });
 // eve 1.0: the settle hook runs in the original turn as the person who ASKED; the answer is only
 // what the response policy recorded in memory, and nothing is recorded when nobody answered.
 const settling=()=>({session:{id:'wrun_send',turn:{id:'original-human',sequence:0},auth:{current:auth(),initiator:auth()}}}) as never;
 const denied=(p:Awaited<ReturnType<typeof proposed>>)=>({...structuredClone(p.response),response:{decision:'deny' as const,principal:resolverAuth(p.requestId,'deny')},
   session:{...p.response.session,turn:{id:'original-human',sequence:0}}});
 it.each(['ignored','invalid'] as const)('nothing is sent, and the prepared send closes, when the card ended with nobody deciding (%s)',async outcome=>{
  clearAcceptedAnswersForTests();const p=await proposed();
  expect(await personalSendInputResolved(p.requestId,outcome,settling())).toBe(true);
  expect((await stored(p.row.id)).state).toBe('cancelled');
  expect((await pool.query('SELECT outcome FROM approval_asks WHERE call_id=$1',[p.callId])).rows[0].outcome).toBe(outcome);
  await expect(requirePersonalSendCall({...p.run,approval:{responder:resolverAuth(p.requestId,'deny')}} as never,p.input)).rejects.toThrow();
  expect(sends).not.toHaveBeenCalled();
 });
 it('a Deny closes the prepared send even when its recorded answer was lost to a restart',async()=>{
  const p=await proposed();
  expect(await personalSendApprovalResponse(denied(p))).toEqual({status:'allowed'});
  clearAcceptedAnswersForTests(); // the restart
  expect(await personalSendInputResolved(p.requestId,'cancelled',settling())).toBe(true);
  expect((await stored(p.row.id)).state).toBe('cancelled');
  expect(sends).not.toHaveBeenCalled();
 });
 it('leaves every other card, and another conversation, alone',async()=>{
  clearAcceptedAnswersForTests();const p=await proposed();
  expect(await personalSendInputResolved('some-other-card','cancelled',settling())).toBe(false);
  expect(await personalSendInputResolved(p.requestId,'cancelled',{session:{id:'wrun_other',turn:{id:'turn_0',sequence:0},auth:{current:auth(),initiator:auth()}}} as never)).toBe(false);
  expect(await personalSendInputResolved(p.requestId,'cancelled',{session:{id:'wrun_send',turn:{id:'turn_0',sequence:0},auth:{current:auth('human','member-b'),initiator:auth('human','member-b')}}} as never)).toBe(false);
  expect(await personalSendInputResolved(p.requestId,'approved',settling())).toBe(false);
  expect((await stored(p.row.id)).state).toBe('awaiting_dispatch');
 });
 it('cancels exactly the unclaimed proposal and permits only its bounded model response',async()=>{
  const p=await proposed();p.resume.session.auth.current=resolverAuth(p.requestId,'deny');
  expect(await personalSendApprovalResponse(denied(p))).toEqual({status:'allowed'});
  expect(await personalSendInputResolved(p.requestId,'cancelled',settling())).toBe(true);
  expect((await stored(p.row.id)).state).toBe('cancelled');await requirePrivateConsoleResume(p.resume,'model');
  await expect(requirePersonalSendCall({...p.run,approval:{responder:resolverAuth(p.requestId,'deny')}} as never,p.input)).rejects.toThrow();
  expect(await recheckOf({...p.human,callId:'cancel-second'})).toMatchObject({denied:true});await expect(readPersonalResource(p.resume,p.input.selection,{kind:'readMail',id:'mail'})).rejects.toThrow();expect(opens).not.toHaveBeenCalled();expect(sends).not.toHaveBeenCalled();
 });
 it('never treats a previous ledger row as a new call/read/draft instruction',async()=>{
  const p=await proposed();await personalSendApprovalResponse(p.response);
  expect(await recheckOf({...p.human,callId:'second-call'})).toMatchObject({denied:true});
  await expect(requirePersonalSendCall({...p.run,callId:'second-call'} as never,p.input)).rejects.toThrow();
  await expect(readPersonalResource(p.resume,p.input.selection,{kind:'readMail',id:'mail'})).rejects.toThrow();
  expect((await pool.query('SELECT count(*)::int AS n FROM personal_actions')).rows[0].n).toBe(1);expect(sends).not.toHaveBeenCalled();
 });
});

// eve 1.0 starts no new turn after an answered card: the paused turn carries on as the member who
// ASKED, and the answer is known only from what the response policy accepted. These drive the real
// response policy, the settle step and the agent's real model resolver (`definitionModelResolver`)
// with the real database gate; only the Keeper socket is a stub (its side is the box test
// "charges the continuation after an answered card…" and Keeper's model-purpose-authority tests).
describe('the reply after an answered personal-mail card (eve 1.0)',()=>{
 const MESSAGE_RECEIPT='r'.repeat(43),ANSWER_RECEIPT='a'.repeat(43),CAPABILITY='c'.repeat(43),CLAIM='k'.repeat(43);
 const asker={authenticator:'lares-console',attributes:{...auth().attributes,lares_model_purpose_required:'1',lares_model_pending_receipt:MESSAGE_RECEIPT}};
 const session=(current:unknown=asker)=>({id:'wrun_send',turn:{id:turnId(),sequence:n},auth:{current,initiator:asker}});
 const resolver=()=>definitionModelResolver({resolveAlias:async()=>'fixture-brain',preparePurpose:prepareModelPurposeInvocation,
   claimPurpose:claimModelPurposeForInvocation,provider:()=>({} as never)});
 /** The continuation's model call, as eve's resolver context gives it (no turn on the session). */
 const modelCall=(current:unknown=asker)=>resolver()({session:{id:'wrun_send',auth:{current,initiator:asker}},turn:{id:turnId(),status:'running'},view:emptySessionView()} as never);
 const ops=()=>purposeRequestMock.mock.calls.map(([op])=>op);
 // Each test is its own turn of the conversation, as eve numbers them.
 let n=0;const turnId=()=>`turn_${n}`;
 beforeEach(()=>{
  n++;
  vi.stubEnv('LARES_AGENT_NAME',env.LARES_AGENT_NAME);vi.stubEnv('LARES_AGENT_INCARNATION',env.LARES_AGENT_INCARNATION);
  clearAcceptedAnswersForTests();eveState.clear();purposeRequestMock.mockReset();
  purposeRequestMock.mockImplementation(async(op:string)=>{
   if(op==='turn.open')return {capability:CAPABILITY,expiresAt:Date.now()+30_000} as never;
   if(op==='step.claim')return {claim:CLAIM,expiresAt:Date.now()+30_000} as never;
   return {closed:true} as never;
  });
 });
 // The turn settles after each test, as eve settles it: its continuation slot closes.
 afterEach(async()=>{await closeModelPurposeTurn({type:'turn.settled',data:{turnId:turnId()}},session());vi.unstubAllEnvs();clearAcceptedAnswersForTests();});
 const answered=async(decision:'approve'|'deny')=>{
  const p=await proposed();
  const principal={...resolverAuth(p.requestId,decision),attributes:{...resolverAuth(p.requestId,decision).attributes,lares_model_pending_receipt:ANSWER_RECEIPT}};
  expect(await personalSendApprovalResponse({...p.response,response:{decision,principal},session:{id:'wrun_send',turn:{id:turnId(),sequence:n},initiator:asker}} as never)).toEqual({status:'allowed'});
  return p;
 };
 /** What the settle hook does once eve has settled the card (agent/hooks/approval-record.ts). */
 const settle=async(requestId:string,outcome:'approved'|'cancelled',applied:'approve'|'deny')=>{
  expect(await personalSendInputResolved(requestId,outcome,{session:session()})).toBe(true);
  settleAcceptedAnswer(requestId,'wrun_send',applied);
  await openContinuationAfterSettle(turnId(),session());
 };
 it('an approved card opens the reply once, for the member who asked, under the answer\'s receipt',async()=>{
  const p=await answered('approve');
  await settle(p.requestId,'approved','approve');
  expect(ops()).toEqual(['turn.open']);
  expect(purposeRequestMock.mock.calls[0]![1]).toEqual({pendingReceipt:ANSWER_RECEIPT,context:{session:{id:'wrun_send',turn:{id:turnId(),sequence:n},auth:{current:asker,initiator:asker}}}});
  await expect(modelCall()).resolves.toMatchObject({modelContextWindowTokens:expect.any(Number)});
  expect(ops()).toEqual(['turn.open','step.claim']);
  expect(purposeRequestMock.mock.calls[1]![1]).toEqual({turnCapability:CAPABILITY,purposeAlias:'fixture-brain',event:{type:'step.started',data:{turnId:turnId(),sequence:n,stepIndex:0}}});
  // Another member in the same conversation gets nothing: the real database gate refuses them.
  await expect(modelCall({...asker,attributes:{...asker.attributes,lares_member_id:'member-b'}})).rejects.toThrow();
  // The answer was used up: a second settle opens nothing more.
  await openContinuationAfterSettle(turnId(),session());
  expect(ops()).toEqual(['turn.open','step.claim']);
  expect((await pool.query('SELECT outcome,resolved_by_member_id FROM approval_asks WHERE request_id=$1',[p.requestId])).rows[0]).toEqual({outcome:'approved',resolved_by_member_id:'member-a'});
 });
 it('an answer eve did not apply opens nothing, and the reply is refused',async()=>{
  const p=await answered('approve');
  settleAcceptedAnswer(p.requestId,'wrun_send','deny');
  await openContinuationAfterSettle(turnId(),session());
  expect(ops()).toEqual([]);
  await expect(modelCall()).rejects.toThrow();
  expect(ops()).toEqual([]);
 });
 it('a Deny closes the prepared send and still opens the reply',async()=>{
  const p=await answered('deny');
  await settle(p.requestId,'cancelled','deny');
  expect((await stored(p.row.id)).state).toBe('cancelled');
  expect(ops()).toEqual(['turn.open']);
  await expect(modelCall()).resolves.toBeDefined();
  expect(ops()).toEqual(['turn.open','step.claim']);
 });
 it('a Deny closes the prepared send with the answer store empty (after a restart), and nothing reopens',async()=>{
  const p=await proposed();
  // Another member's conversation cannot close it.
  const before=(await stored(p.row.id)).state;expect(before).not.toBe('cancelled');
  const other={session:{id:'wrun_send',turn:{id:turnId(),sequence:n},auth:{current:auth('human','member-b'),initiator:auth('human','member-b')}}};
  expect(await personalSendInputResolved(p.requestId,'cancelled',other)).toBe(false);
  expect((await stored(p.row.id)).state).toBe(before);
  expect(await personalSendInputResolved(p.requestId,'cancelled',{session:session()})).toBe(true);
  expect((await stored(p.row.id)).state).toBe('cancelled');
  await openContinuationAfterSettle(turnId(),session());
  expect(ops()).toEqual([]);
  await expect(modelCall()).rejects.toThrow();
 });
});
/** The owner's ruling: in the turn an answer to a card was applied in, a NEW send is refused before
 *  any draft, card or provider call; the answered card's own approved send still goes out once; the
 *  next message (a new turn) sends as before. The settle hook's durable mark is written here the way
 *  agent/hooks/approval-record.ts writes it (`noteAnswerApplied`); tests/turn-after-answered-card.test.ts
 *  drives the hooks themselves, the restart and the doors. */
describe('no new send in the reply to an answered request',()=>{
 // The describe above ends each of its tests by removing every stubbed variable; put this agent's back.
 beforeEach(()=>{for(const [k,v]of Object.entries(env))vi.stubEnv(k,v);vi.stubEnv('DATABASE_URL',container.getConnectionUri());eveState.clear();clearAcceptedAnswersForTests();});
 const refusal={type:'denied',reason:NEW_SEND_AFTER_ANSWER_REFUSED};
 const counts=async()=>(await pool.query('SELECT (SELECT count(*) FROM personal_actions)::int AS actions,(SELECT count(*) FROM approval_asks)::int AS asks')).rows[0];
 /** The model asks for another send in the same (continued) turn, as the same member. */
 const another=(p:Awaited<ReturnType<typeof proposed>>,session=p.human.session)=>({callId:`again-${++call}`,toolInput:{...structuredClone(p.input),subject:'Another send'},session});
 const answer=async(p:Awaited<ReturnType<typeof proposed>>,decision:'approve'|'deny')=>{
  expect(await personalSendApprovalResponse(decision==='approve'?p.response:{...p.response,response:{decision:'deny',principal:resolverAuth(p.requestId,'deny')}})).toEqual({status:'allowed'});
  noteAnswerApplied(p.human.session.turn.id);
 };
 it.each(['approve','deny'] as const)('after %s: a new send in the continued turn is refused, with no draft, no card and no provider call',async decision=>{
  const p=await proposed();await answer(p,decision);
  const before=await counts();
  expect(await personalSendApprovalRequest(another(p))).toEqual(refusal);
  expect(await counts()).toEqual(before);
  expect(opens).not.toHaveBeenCalled();expect(sends).not.toHaveBeenCalled();
 });
 it('the approved send of the answered card still goes out exactly once; a new send next to it is refused; the next message can send',async()=>{
  const p=await proposed();await answer(p,'approve');
  expect(await recheckOf(p.human)).toMatchObject({denied:false}); // eve's re-check of the approved call, same turn
  const approved=await requirePersonalSendCall(p.run,p.input);expect(approved.reference.actionId).toBe(p.row.id);
  await expect(executeApprovedPersonalSend(context(approved.reference),approved.reference,{pool,actions,runtime,env})).resolves.toMatchObject({state:'accepted'});
  expect(sends).toHaveBeenCalledExactlyOnceWith({to:p.input.to,subject:p.input.subject,body:p.input.body});
  const before=await counts();
  expect(await personalSendApprovalRequest(another(p))).toEqual(refusal);
  expect(await counts()).toEqual(before);expect(sends).toHaveBeenCalledOnce();
  // A new message is a new turn: the send is prepared behind its own card, as before.
  const next=another(p,{...p.human.session,turn:{id:'next-human',sequence:2}});
  expect(await personalSendApprovalRequest(next)).toBe('user-approval');
  expect((await pool.query('SELECT state FROM personal_actions WHERE original_call_id=$1',[next.callId])).rows[0].state).toBe('awaiting_approval');
  expect(sends).toHaveBeenCalledOnce();
 });
 it('fails closed when the turn cannot be told: no turn id is refused, with nothing stored',async()=>{
  const p=await proposed(),before=await counts();
  const {turn:_turn,...noTurn}=p.human.session;
  expect(await personalSendApprovalRequest(another(p,noTurn as never))).toEqual(refusal);
  expect(await counts()).toEqual(before);
 });
});
