/** Real PostgreSQL authority, custody, immutable action and receipt; fake provider only.
 * Resolver contexts below are SYNTHETIC caller fixtures, not the installed Eve resolver.
 * Exact approval-response admission, catalogue enablement and model continuation are separate. */
const {purposeRequestMock}=vi.hoisted(()=>({purposeRequestMock:vi.fn()}));
vi.mock('@lares/agent-kit/model-purpose-client',()=>({modelPurposeRequest:purposeRequestMock}));
vi.mock('@lares/agent-kit/google-auth',async original=>({...await original<typeof import('@lares/agent-kit/google-auth')>(),readTokenEncKey:()=> '1'.repeat(64)}));
import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from 'vitest';
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
import { definitionModel } from '@lares/agent-kit/definition-model';
import { markPrivateConsoleSurface } from '@lares/agent-kit/private-console-surface';
import {personalSendApprovalRequest,personalSendInputRequested,personalSendApprovalResponse,personalSendInputResolved,requirePersonalSendCall} from '../lib/personal-send-approval.js';
import { claimModelPurposeForInvocation,closeModelPurposeTurn,prepareModelPurposeInvocation } from '../agent/lib/model-purpose.js';
import {requirePrivateConsoleResume} from '@lares/agent-kit/private-console-resume';
import {readPersonalResource} from '../lib/personal-reads.js';
import { executeApprovedPersonalSend,requirePersonalSendPolicy,type PersonalSendRuntime } from '../lib/personal-send.js';
import { quiet } from './helpers/quiet-pool.js';
const incarnation='11111111-1111-4111-8111-111111111111',nonce='a'.repeat(43),key='1'.repeat(64);
const env={LARES_AGENT_NAME:'helper',LARES_AGENT_INCARNATION:incarnation,AGENT_OWNER_USER_ID:'member-a'};
const auth=(purpose='human',member='member-a')=>({authenticator:'lares-console',attributes:{lares_member_id:member,lares_admission_nonce:nonce,lares_purpose:purpose}});
const def={name:'helper',model:'fixture-brain',persona:'voice.md',role:'chief-of-staff',channels:[],grants:[{capability:'personal_mailbox',scope:'write-with-confirm'}],autonomy:{personal_mailbox:'autonomous'},skills:[]};
let container:StartedPostgreSqlContainer,pool:Pool,accounts:PgAccountStore,actions:PgPersonalActionStore;
let call=0,sends:ReturnType<typeof vi.fn>,opens:ReturnType<typeof vi.fn>,hold:(()=>Promise<void>)|undefined;
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

async function proposed(){
 const own=await connected(),input={selection:{accountId:own.account.id,generation:own.account.generation,resourceBindingId:own.resource.id},to:['recipient@example.invalid'],subject:'Exact review',body:'Whole body'},callId=`human-${++call}`;
 const human={callId,toolInput:input,approvedTools:new Set([PERSONAL_MAIL_SEND_TOOL]),session:{id:'wrun_send',turn:{id:'original-human',sequence:0},auth:{current:auth(),initiator:auth()}}};
 expect(await personalSendApprovalRequest(human)).toBe('user-approval');
 const row=(await pool.query('SELECT * FROM personal_actions WHERE original_call_id=$1',[callId])).rows[0];
 expect(row.state).toBe('awaiting_approval');expect((await pool.query('SELECT request_id FROM approval_asks WHERE call_id=$1',[callId])).rows[0].request_id).toBeNull();
 const requestId=`framework-${call}`;await personalSendInputRequested({requestId,callId,input},human);
 const resume={callId,toolInput:input,approvedTools:new Set([PERSONAL_MAIL_SEND_TOOL]),session:{id:'wrun_send',turn:{id:'resolver-only',sequence:1},auth:{current:resolverAuth(requestId),initiator:auth()}}};
 const response={request:{requestId,callId,toolName:PERSONAL_MAIL_SEND_TOOL,toolInput:input},responder:resume.session.auth.current,session:{id:'wrun_send',initiator:auth()}};
 return {own,input,callId,requestId,row,resume,response};
}
describe('exact personal approval lifecycle through authenticated resolver references',()=>{
 it('admits one exact raw response into resolver-only attributes without human authority',async()=>{
  const p=await proposed();
  const request=()=>new Request('http://runtime.invalid/eve/v1/session/wrun_send',{method:'POST',headers:{'x-lares-member-id':'member-a','x-lares-admission':nonce,'x-lares-purpose':'resolver'},body:JSON.stringify({inputResponses:[{requestId:p.requestId,optionId:'approve'}]})});
  await expect(consoleRouteAdmission(request(),pool,env)).rejects.toThrow();
  const exact=request();await assertPrivateConsoleRequest(exact);
  expect(await consoleRouteAdmission(exact,pool,env)).toEqual(resolverAuth(p.requestId).attributes);
  await expect(consoleRouteAdmission(exact.clone(),pool,env)).rejects.toThrow();
 });
 it('prepares before a card, authenticates the actual response, revalidates SDK policy and returns the original action only',async()=>{
  const p=await proposed();await expect(requirePrivateConsoleResume(p.resume,'model')).rejects.toThrow();
  expect(await personalSendApprovalResponse(p.response)).toEqual({status:'allowed'});
  expect(await personalSendApprovalRequest(p.resume)).toBe('user-approval');
  expect((await requirePersonalSendCall(p.resume,p.input)).reference.actionId).toBe(p.row.id);
  expect((await requirePrivateConsoleResume(p.resume,'model')).reference.requestId).toBe(p.requestId);
  expect(p.resume.session.auth.current.attributes).not.toHaveProperty('lares_member_id');
  expect(p.resume.session.auth.current.attributes).not.toHaveProperty('lares_admission_nonce');
 });
 it.each(['member','request','call','session','payload','selection'] as const)('refuses changed response %s before recording approval',async changed=>{
  const p=await proposed(),response=structuredClone(p.response);
  if(changed==='member')response.responder=resolverAuth(p.requestId,'approve','member-b');
  if(changed==='request')response.request.requestId='other';if(changed==='call')response.request.callId='other';if(changed==='session')response.session.id='other';
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
  expect(await personalSendApprovalRequest(p.resume)).toBe('denied');expect(opens).not.toHaveBeenCalled();expect(sends).not.toHaveBeenCalled();
 });
 it('refuses restored board policy after response approval and after claim before provider open',async()=>{
  const p=await proposed();await personalSendApprovalResponse(p.response);
  const ref=(await requirePersonalSendCall(p.resume,p.input)).reference;
  const claim=actions.claimAction.bind(actions);vi.spyOn(actions,'claimAction').mockImplementationOnce(async input=>{
   const result=await claim(input);
   await pool.query("INSERT INTO ratchet(agent,capability,action,level,updated_by) VALUES('helper','personal_mailbox','send','never','fixture')");await pool.query("DELETE FROM ratchet WHERE agent='helper'");return result;
  });
  expect((await execute(ref)).state).toBe('not_dispatched');expect(opens).not.toHaveBeenCalled();expect(sends).not.toHaveBeenCalled();
 });
 it('cancels exactly the unclaimed proposal and permits only its bounded model response',async()=>{
  const p=await proposed();p.resume.session.auth.current=resolverAuth(p.requestId,'cancel');
  expect(await personalSendInputResolved(p.requestId,'cancelled',p.resume)).toBe(true);
  expect((await stored(p.row.id)).state).toBe('cancelled');await requirePrivateConsoleResume(p.resume,'model');
  await expect(requirePersonalSendCall(p.resume,p.input)).rejects.toThrow();
  expect(await personalSendApprovalRequest({...p.resume,callId:'cancel-second'})).toBe('denied');await expect(readPersonalResource(p.resume,p.input.selection,{kind:'readMail',id:'mail'})).rejects.toThrow();expect(opens).not.toHaveBeenCalled();expect(sends).not.toHaveBeenCalled();
 });
 it('never treats inherited approvedTools or a previous ledger row as a new call/read/draft instruction',async()=>{
  const p=await proposed();await personalSendApprovalResponse(p.response);
  expect(await personalSendApprovalRequest({...p.resume,callId:'second-call'})).toBe('denied');
  await expect(requirePersonalSendCall({...p.resume,callId:'second-call'},p.input)).rejects.toThrow();
  await expect(readPersonalResource(p.resume,p.input.selection,{kind:'readMail',id:'mail'})).rejects.toThrow();
  expect((await pool.query('SELECT count(*)::int AS n FROM personal_actions')).rows[0].n).toBe(1);expect(sends).not.toHaveBeenCalled();
 });
});

describe('real Eve model selection for an approved private resume',()=>{
 it('runs the pinned response-resume coordinator through the actual definitionModel and DB authority gate',async()=>{
   vi.stubEnv('LARES_AGENT_NAME',env.LARES_AGENT_NAME);vi.stubEnv('LARES_AGENT_INCARNATION',env.LARES_AGENT_INCARNATION);
   purposeRequestMock.mockReset();
   const {ref}=await ready();
   const purposeReceipt='p'.repeat(43);
   purposeRequestMock.mockImplementation(async(op:string)=>{
     if(op==='request.admit')return {pendingReceipt:purposeReceipt} as never;
     if(op==='turn.open')return {capability:'c'.repeat(43),expiresAt:Date.now()+30_000} as never;
     if(op==='step.claim')return {claim:'k'.repeat(43),expiresAt:Date.now()+30_000} as never;
     return {closed:true} as never;
   });
   const {modelPurposeRequest}=await import('@lares/agent-kit/model-purpose-client');
   const admitted=await modelPurposeRequest<{pendingReceipt?:string}>('request.admit',{capsule:'verified-fixture-capsule',receipt:{kind:'resume'}});
   expect(admitted.pendingReceipt).toBe(purposeReceipt);

   const eveRoot=new URL('../node_modules/eve/dist/src/',import.meta.url);
   const [{ContextContainer,contextStorage},keys,{sessionProvider},{createToolLoopHarness}]=await Promise.all([
     import(new URL('context/container.js',eveRoot).href),import(new URL('context/keys.js',eveRoot).href),
     import(new URL('context/providers/session.js',eveRoot).href),import(new URL('harness/tool-loop.js',eveRoot).href),
   ]) as any;
   const initial=auth();
   const resolver={authenticator:'lares-console',attributes:{lares_resolver_member_id:'member-a',lares_resume_request_id:ref.requestId,
     lares_resume_option:'approve',lares_purpose:'resolver',lares_model_purpose_required:'1',lares_model_pending_receipt:admitted.pendingReceipt}};
   const context=new ContextContainer();context.set(keys.AuthKey,resolver);context.set(keys.InitiatorAuthKey,initial);context.set(keys.SessionIdKey,'wrun_send');
   const session={agent:{dynamicModel:true,system:'',tools:[]},compaction:{recentWindowSize:10,threshold:100_000},
     continuationToken:'eve:db-backed-resume-proof',history:[],sessionId:'wrun_send',state:{
       'eve.harness.emission':{sessionStarted:true,sequence:1,stepIndex:0,turnId:''},
       'eve.runtime.pendingInputBatches':[{event:{sequence:0,stepIndex:0,turnId:'turn_0'},requests:[{kind:'tool-approval',requestId:ref.requestId,
         prompt:'Fixture approval',options:[{id:'approve',label:'Approve'},{id:'cancel',label:'Cancel'}],
         action:{kind:'tool-call',callId:ref.selection.originalCallId,toolName:PERSONAL_MAIL_SEND_TOOL,input:{}}}],responseMessages:[],responseAuthRequiredRequestIds:[ref.requestId]}],
     }};
   context.set(keys.SessionKey,sessionProvider.create(context,{state:session.state}).value);
   await contextStorage.run(context,()=>markPrivateConsoleSurface());
   const events:Array<{type:string;data?:unknown}>=[];let adapterSession:any,actualStepEvent:any,reservedBeforeVerification=false;
   const model=definitionModel({resolveAlias:async()=>{expect(reservedBeforeVerification).toBe(true);return 'fixture-brain';},
     preparePurpose:(event,session)=>{prepareModelPurposeInvocation(event,session);reservedBeforeVerification=true;},
     claimPurpose:claimModelPurposeForInvocation,provider:()=>({} as never)});
   const originalConnect=Pool.prototype.connect;
   vi.spyOn(Pool.prototype,'connect').mockImplementation(function(this:Pool,...args:unknown[]){
     expect(reservedBeforeVerification).toBe(true);
     return originalConnect.apply(this,args as never);
   } as never);
   const harness=createToolLoopHarness({mode:'conversation',
     tools:new Map([[PERSONAL_MAIL_SEND_TOOL,{description:'Fixture',inputSchema:{type:'object'},approval:{response:async()=>({status:'allowed'})}}]]),
     handleEvent:async(event:{type:string;data?:unknown})=>{
       events.push({type:event.type,data:event.data});
       if(['turn.completed','turn.failed','turn.cancelled'].includes(event.type))await closeModelPurposeTurn(event,adapterSession);
     },resolveModel:async()=>{throw new Error('No provider expected');},
     dispatchDynamicModelEvent:async({ctx,event}:{ctx:any;event:any})=>{
       const frameworkSession=ctx.get(keys.SessionKey);
       actualStepEvent=event;
       // Eve's public DynamicResolveContext exposes identity and auth, but no turn object.
       // The real step.started event is the sole source of the raw empty turn coordinate.
       adapterSession={id:frameworkSession.sessionId,auth:{current:ctx.get(keys.AuthKey),initiator:ctx.get(keys.InitiatorAuthKey)}};
       await model.events['step.started'](event,{session:adapterSession});
       throw new Error('Regression stops before provider invocation');
     }});
   const input={attributedInputResponses:[{auth:resolver,response:{requestId:ref.requestId,optionId:'approve'}}]};
   const first=await contextStorage.run(context,()=>harness(session,input));
   expect(typeof first.next).toBe('function');
   const second=await contextStorage.run(context,()=>first.next!(first.session));
   expect(second.next).toMatchObject({done:true});
   expect(events.map(event=>event.type)).toEqual(expect.arrayContaining(['approval.settled','input.resolved','step.failed','turn.failed']));
   expect(sessionProvider.create(context,{state:session.state}).value.turn).toEqual({id:'turn_1',sequence:1});
   const calls=purposeRequestMock.mock.calls;
   expect(calls.map(([op])=>op)).toEqual(['request.admit','turn.open','step.claim','turn.close']);
   expect(calls[1]![1]).toMatchObject({pendingReceipt:purposeReceipt,context:{session:{id:'wrun_send',turn:{id:'',sequence:1},auth:{current:resolver,initiator:initial}}}});
   expect(calls[2]![1]).toMatchObject({event:{type:'step.started',data:{turnId:'',sequence:1,stepIndex:0}},purposeAlias:'fixture-brain'});
   expect(calls[3]![1]).toEqual({turnCapability:'c'.repeat(43),turnId:'',sequence:1});
   expect(adapterSession.auth.current).not.toBe(adapterSession.auth.initiator);
   expect(adapterSession.auth.current.attributes.lares_resolver_member_id).toBe(adapterSession.auth.initiator.attributes.lares_member_id);
   await expect(model.events['step.started'](actualStepEvent,{session:adapterSession} as never)).rejects.toThrow('Model purpose authority');
   expect(purposeRequestMock.mock.calls.map(([op])=>op)).toEqual(['request.admit','turn.open','step.claim','turn.close']);
   // This approval is checked by the real private-resume database gate before the broker's
   // open/claim ACKs; the fixture row remains an approved exact action for this request.
   expect((await pool.query('SELECT outcome,resolved_by_member_id FROM approval_asks WHERE request_id=$1',[ref.requestId])).rows[0])
     .toEqual({outcome:'approved',resolved_by_member_id:'member-a'});
 });
});
