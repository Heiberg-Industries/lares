/** Real PostgreSQL authority, custody, immutable action and receipt; fake provider only.
 * Resolver contexts below are SYNTHETIC caller fixtures, not the installed Eve resolver.
 * Exact approval-response admission, catalogue enablement and model continuation are separate. */
import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from 'vitest';
import { PostgreSqlContainer,type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync,readdirSync } from 'node:fs';
import { Pool } from 'pg';
import { PgAccountStore,type TrustedAccountAdapter } from '@lares/agent-kit/account-store';
import { PgMemberStore } from '@lares/agent-kit/member-store';
import { PgGrantStore } from '@lares/agent-kit/grant-store';
import { bindConsoleSession } from '@lares/agent-kit/console-turn-authority';
import { PgPersonalActionStore,personalActionApprovalDescriptor,PERSONAL_MAIL_SEND_TOOL,type PersonalActionApprovedReference } from '@lares/agent-kit/personal-action-store';
import { encryptSecret,decryptSecret } from '@lares/agent-box/lib/crypto.js';
import { executeApprovedPersonalSend,type PersonalSendRuntime } from '../lib/personal-send.js';
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
const context=(ref:PersonalActionApprovedReference,purpose='resolver',member='member-a')=>({callId:ref.selection.originalCallId,
  session:{id:'wrun_send',turn:{id:'resolver-turn',sequence:1},auth:{current:auth(purpose,member),initiator:auth()}}});
async function connected(member='member-a'){
 const adapter:TrustedAccountAdapter={connectorId:'microsoft',verifyAccount:async()=>({issuer:'https://login.microsoftonline.com/fixture/v2.0',subject:member,label:'Own account'}),
   verifyResource:async()=>({resourceKind:'mailbox',externalId:member,providerLabel:'Own mailbox'})};
 const account=await accounts.forTrustedAdapter(adapter).createPersonalAccount(member,null,{persist:async(db,owner)=>{
   const {rows}=await db.query(`INSERT INTO oauth_tokens(principal,provider,org_id,email_address,scopes,refresh_token_enc)
     VALUES($1,$2,'microsoft','own@example.invalid',ARRAY['Mail.Send'],$3) RETURNING id`,[member,owner.connectorId,encryptSecret('original-refresh',key)]);return rows[0].id;
 }},['mailbox']);
 const [resource]=await accounts.listResources(member,account.id,account.generation);return {account,resource};
}
async function ready(approvalLifetimeMs=86_400_000,existing?:Awaited<ReturnType<typeof connected>>){
 const own=existing??await connected(),selection={actorMemberId:'member-a',agentId:'helper',incarnation,sessionId:'wrun_send',originalTurnId:'original-turn',
   originalCallId:`call-${++call}`,accountId:own.account.id,accountGeneration:own.account.generation,resourceBindingId:own.resource.id,connectorId:'microsoft',kind:'mail.send' as const};
 const payload={to:['recipient@example.invalid'],subject:'Exact subject',body:'Exact body'},action=await actions.prepareAction({...selection,payload}),requestId=`request-${call}`;
 await pool.query(`INSERT INTO approval_asks(call_id,request_id,agent,tool,payload_hash,original_authority,acting_member_id,resolved_by_member_id,session_id,outcome,answered_at,asked_at)
   VALUES($1,$2,'helper',$3,$4,$5::jsonb,'member-a','member-a','wrun_send','approved',clock_timestamp(),clock_timestamp()-interval '24 hours'+($6*interval '1 millisecond'))`,
   [selection.originalCallId,requestId,PERSONAL_MAIL_SEND_TOOL,action.payloadHash,JSON.stringify(personalActionApprovalDescriptor(action,selection)),approvalLifetimeMs]);
 await actions.attachApproval({actionId:action.actionId,actorMemberId:'member-a',approvalCallId:selection.originalCallId,requestId});
 return {own,payload,ref:{actionId:action.actionId,payloadHash:action.payloadHash,approvalCallId:selection.originalCallId,requestId,resolvedByMemberId:'member-a',selection} satisfies PersonalActionApprovedReference};
}
const execute=(ref:PersonalActionApprovedReference,extra:Partial<Parameters<typeof executeApprovedPersonalSend>[2]>={})=>executeApprovedPersonalSend(context(ref),ref,{pool,actions,runtime,env,...extra});
const stored=async(id:string)=>(await pool.query('SELECT * FROM personal_actions WHERE id=$1',[id])).rows[0];
beforeAll(async()=>{
 container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));
 const sql=new URL('../../box/sql/',import.meta.url);for(const name of readdirSync(sql).filter(n=>n.endsWith('.sql')).sort())await pool.query(readFileSync(new URL(name,sql),'utf8'));
 accounts=new PgAccountStore(pool);actions=new PgPersonalActionStore(pool,crypto);
},120_000);
afterAll(async()=>{await pool?.end();await container?.stop();});
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
     mutation=change==='member-removal'?new PgMemberStore(other).removeMember('member-b','member-a'):change==='reconnect'?
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
