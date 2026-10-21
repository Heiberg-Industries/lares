/** Real storage, pinned Eve approval coordinator and real durable catalogue callbacks.
 * No model/provider credentials or installation data. */
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getPool, closePool } from '@lares/agent-kit/db';
import { bindConsoleSession } from '@lares/agent-kit/console-turn-authority';
import { reserveExactApproval, attachExactApproval, approveExactResponse, requireApprovedExecution, settleExactInput } from '@lares/agent-kit/approval-execution';
import { recordAsk, recordAnswer, assertApprovedCall, approvalLedger, payloadFingerprint } from '@lares/agent-kit/approval-ledger';
import { readApprovalCounts } from '@lares/agent-kit/approval-stats';
import { makeApprovalRecord } from '@lares/agent-kit/approval-record-hook';
import { deadlineApprovalAdapter, dismissExactDeadline } from '../lib/deadlines-store.js';
import resolver from '../agent/tools/catalogue.js';
import { humanTurnRefusal } from '../lib/approvals.js';

const inc='11111111-1111-4111-8111-111111111111';
const env={LARES_AGENT_NAME:'helper',LARES_AGENT_INCARNATION:inc,AGENT_OWNER_USER_ID:'member-a'};
const auth=(purpose='human',member='member-a',nonce='a'.repeat(43))=>({authenticator:'lares-console',principalId:member,principalType:'user',attributes:{user_id:member,lares_member_id:member,lares_admission_nonce:nonce,lares_purpose:purpose}});
const input={id:'11111111-2222-4333-8444-555555555555',reason:'Duplicate filing'};
const context=(purpose='human',raw:unknown=input)=>({callId:'call-1',toolName:'deadline_dismiss',toolInput:raw,abortSignal:new AbortController().signal,approvedTools:new Set<string>(),session:{id:'wrun_exact',turn:{id:purpose==='human'?'turn-original':'turn-resolver',sequence:purpose==='human'?0:1},auth:{current:auth(purpose),initiator:auth()}}});
const def={name:'helper',model:'fixture-brain',persona:'voice.md',role:'chief-of-staff',channels:[],grants:[{capability:'deadline',scope:'write-with-confirm'}],autonomy:{deadline:'gated'},skills:[]};
const opts=()=>({adapter:deadlineApprovalAdapter});
let container:StartedPostgreSqlContainer;
const sqlDir=new URL('../../box/sql/',import.meta.url);
const eveDist=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/',import.meta.url))).href;

beforeAll(async()=>{
 container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
 vi.stubEnv('DATABASE_URL',container.getConnectionUri());
 for(const [k,v] of Object.entries(env))vi.stubEnv(k,v);
 const db=getPool();db.on('error',()=>undefined);db.on('connect',c=>c.on('error',()=>undefined));
 for(const f of readdirSync(sqlDir).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort())await db.query(readFileSync(new URL(f,sqlDir),'utf8'));
 await db.query("INSERT INTO orgs(id,display_name) VALUES('fixture-org','Fixture'); INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-a','A','fixture-org','owner','active'),('member-b','B','fixture-org','owner','active')");
 await db.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES('helper',$1,'fixture-hash','valid')",[def]);
 await db.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending,applied_definition) VALUES('helper','172.30.0.99','fixture','owned',$1,$1,'ready',false,$2)",[inc,def]);
},120_000);
afterAll(async()=>{await closePool();await container?.stop();vi.unstubAllEnvs();});
beforeEach(async()=>{
 const db=getPool();await db.query('DELETE FROM approval_asks; DELETE FROM console_session_bindings; DELETE FROM deadlines; DELETE FROM deadline_candidates; DELETE FROM ratchet');
 await db.query("UPDATE users SET status='active',org_role='owner' WHERE id IN ('member-a','member-b'); UPDATE agent_definitions SET status='valid' WHERE name='helper'");
 await db.query("UPDATE agent_resources SET pending=false,state='ready',ownership_token=$1,runtime_control_token=$1,applied_definition=$2 WHERE name='helper'",[inc,def]);
 await db.query("INSERT INTO deadlines(id,owner,entity,title,source,due_date,created_by) VALUES($1,'member-a','Fixture','Filing','manual','2026-12-01','member-a')",[input.id]);
 await bindConsoleSession({agent:'helper',incarnation:inc,sessionId:'wrun_exact',memberId:'member-a',admissionNonce:'a'.repeat(43)});
});
async function reserved(raw:unknown=input){await reserveExactApproval(context('human',raw),'deadline_dismiss',opts());await attachExactApproval({requestId:'request-1',callId:'call-1',tool:'deadline_dismiss',input:raw});}
const response=(raw:unknown=input)=>({request:{requestId:'request-1',callId:'call-1',toolName:'deadline_dismiss',toolInput:raw},responder:auth('resolver'),session:{id:'wrun_exact',initiator:auth(),turn:{id:'turn-resolver',sequence:1}}});
async function approved(raw:unknown=input){await reserved(raw);await approveExactResponse(response(raw),opts());}
async function stillOpen(){expect((await getPool().query('SELECT status FROM deadlines WHERE id=$1',[input.id])).rows[0].status).toBe('open');}

describe('exact private approval execution',()=>{
 it('reserves before a request ID exists and preserves exact idempotency without extending expiry',async()=>{
  await reserveExactApproval(context(),'deadline_dismiss',opts());
  const before=(await getPool().query("SELECT * FROM approval_asks WHERE call_id='call-1'")).rows[0];
  expect(await readApprovalCounts(getPool())).toEqual([]);
  expect(before.request_id).toBeNull();expect(before.original_authority.original).toMatchObject({origin:'human',actingMemberId:'member-a',spokenByMemberId:'member-a',turnId:'turn-original'});
  await reserveExactApproval(context(),'deadline_dismiss',opts());
  expect((await getPool().query("SELECT original_authority FROM approval_asks WHERE call_id='call-1'")).rows[0].original_authority).toEqual(before.original_authority);
  await expect(reserveExactApproval(context('human',{...input,reason:'Changed'}),'deadline_dismiss',opts())).rejects.toThrow();
 });
 it('preserves original actor, speaker and turn with a separate authenticated resolver',async()=>{
  await approved();const c=context('resolver');
  const r=await requireApprovedExecution(c,'deadline_dismiss',input,opts());
  expect(r.authority).toMatchObject({origin:'approval-resume',actingMemberId:'member-a',spokenByMemberId:'member-a',resolvedByMemberId:'member-a',turnId:'turn-original',requestId:'request-1'});
  expect(c.session.auth.current.attributes.lares_purpose).toBe('resolver');
  expect(humanTurnRefusal(c.session.auth,'Refused')).toContain('no new human instruction');
  await dismissExactDeadline(getPool(),c,input);
  expect((await getPool().query('SELECT status,owner,status_reason FROM deadlines WHERE id=$1',[input.id])).rows[0]).toEqual({status:'dismissed',owner:'member-a',status_reason:input.reason});
 });
 it('rechecks every authority coordinate on the mutation transaction with a one-connection pool',async()=>{
  await approved();const single=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:500});
  try{await dismissExactDeadline(single,context('resolver'),input);}
  finally{await single.end();}
  expect((await getPool().query('SELECT status FROM deadlines WHERE id=$1',[input.id])).rows[0].status).toBe('dismissed');
 });
 it('handles an explicitly owned candidate through the same target binding',async()=>{
  await getPool().query("INSERT INTO deadline_candidates(owner,thread_id,subject,sender,seen_at) VALUES('member-a','candidate','Fixture','sender@example.invalid',now())");
  const raw={candidateThreadId:'candidate',reason:'Not a deadline'};await approved(raw);
  await dismissExactDeadline(getPool(),context('resolver',raw),raw);
  expect((await getPool().query("SELECT resolution FROM deadline_candidates WHERE thread_id='candidate'")).rows[0].resolution).toBe('ignored');
 });
 it('legacy recorders cannot attach, approve or overwrite strict rows; legacy cards still work',async()=>{
  await reserveExactApproval(context(),'deadline_dismiss',opts());
  await recordAsk(getPool(),{requestId:'wrong',callId:'call-1',agent:'helper',tool:'deadline_dismiss',payloadHash:payloadFingerprint('deadline_dismiss',input)});
  expect((await getPool().query("SELECT request_id FROM approval_asks WHERE call_id='call-1'")).rows[0].request_id).toBeNull();
  await attachExactApproval({requestId:'request-1',callId:'call-1',tool:'deadline_dismiss',input});
  await recordAnswer(getPool(),{requestId:'request-1',outcome:'approved'});
  expect((await getPool().query("SELECT outcome FROM approval_asks WHERE call_id='call-1'")).rows[0].outcome).toBeNull();
  await recordAsk(getPool(),{requestId:'legacy',callId:'legacy',agent:'helper',tool:'fixture',payloadHash:payloadFingerprint('fixture',{})});
  await recordAnswer(getPool(),{requestId:'legacy',outcome:'approved'});
  await expect(assertApprovedCall(approvalLedger(),{callId:'legacy',toolName:'fixture',input:{}})).resolves.toBeUndefined();
  await expect(assertApprovedCall(approvalLedger(),{callId:'call-1',toolName:'deadline_dismiss',input})).rejects.toThrow('Exact approval');
 });
 it('migration can reapply with reserved and legacy rows intact and does not permit changing authority',async()=>{
  await reserved();await getPool().query(readFileSync(new URL('015_exact_approval_execution.sql',sqlDir),'utf8'));
  await expect(getPool().query("UPDATE approval_asks SET original_authority='{}' WHERE call_id='call-1'")).rejects.toThrow('immutable');
  await expect(attachExactApproval({requestId:'different',callId:'call-1',tool:'deadline_dismiss',input})).rejects.toThrow();
 });
 it('strict input hook attaches synchronously and propagates storage failure',async()=>{
  await reserveExactApproval(context(),'deadline_dismiss',opts());
  const hook=makeApprovalRecord();const event={data:{requests:[{kind:'tool-approval',requestId:'request-1',action:{callId:'call-1',toolName:'deadline_dismiss',input}}]}};
  await hook['input.requested'](event,context());
  expect((await getPool().query("SELECT request_id FROM approval_asks WHERE call_id='call-1'")).rows[0].request_id).toBe('request-1');
  await expect(hook['input.requested']({data:{requests:[{...event.data.requests[0],requestId:'wrong'}]}},context())).rejects.toThrow();
 });
 for(const [label,change] of [
  ['payload',async()=>undefined],
  ['member removed',async()=>getPool().query("UPDATE users SET status='removed' WHERE id='member-a'")],
  ['member demoted',async()=>getPool().query("UPDATE users SET org_role='member' WHERE id='member-a'")],
  ['binding revoked',async()=>getPool().query('UPDATE console_session_bindings SET revoked_at=now()')],
  ['incarnation replaced',async()=>getPool().query("UPDATE agent_resources SET runtime_control_token=NULL,ownership_token='22222222-2222-4222-8222-222222222222' WHERE name='helper'")],
  ['pending desired definition',async()=>getPool().query("UPDATE agent_resources SET pending=true WHERE name='helper'")],
  ['invalid definition',async()=>getPool().query("UPDATE agent_definitions SET status='invalid' WHERE name='helper'")],
  ['target changed',async()=>getPool().query('UPDATE deadlines SET title=\'Different filing\' WHERE id=$1',[input.id])],
  ['target owner changed',async()=>getPool().query("UPDATE deadlines SET owner='member-b' WHERE id=$1",[input.id])],
  ['board disabled',async()=>getPool().query("INSERT INTO ratchet(agent,capability,level,updated_by) VALUES('helper','deadline','never','fixture')")],
  ['board changed',async()=>getPool().query("INSERT INTO ratchet(agent,capability,level,updated_by) VALUES('helper','deadline','autonomous','fixture')")],
  ['applied definition changed',async()=>getPool().query("UPDATE agent_resources SET applied_definition=jsonb_set(applied_definition,'{autonomy,deadline}','\"autonomous\"') WHERE name='helper'")],
  ['cancelled',async()=>settleExactInput('request-1','cancelled')],
  ['missing row',async()=>getPool().query('DELETE FROM approval_asks')],
 ] as const){
  it(`refuses ${label} before resolution and again before mutation`,async()=>{
   await reserved();await change();
   const raw=label==='payload'?{...input,reason:'Changed'}:input;
   await expect(approveExactResponse(response(raw),opts())).rejects.toThrow();await stillOpen();
  });
  it(`refuses ${label} after approval, without touching the deadline`,async()=>{
   await approved();await change();const raw=label==='payload'?{...input,reason:'Changed'}:input;
   await expect(dismissExactDeadline(getPool(),context('resolver',raw),raw)).rejects.toThrow();await stillOpen();
  });
 }
 it('refuses expiry, a different responder, an initiator fallback, wrong call, audience/place or nonce',async()=>{
  await reserved();const later={...opts(),now:new Date(Date.now()+24*3600_000)};
  await expect(approveExactResponse(response(),later)).rejects.toThrow();
  await expect(approveExactResponse({...response(),responder:auth('resolver','member-b')},opts())).rejects.toThrow();
  await expect(approveExactResponse({...response(),responder:null},opts())).rejects.toThrow();
  await expect(approveExactResponse({...response(),responder:auth('resolver','member-a','b'.repeat(43))},opts())).rejects.toThrow();
  await expect(approveExactResponse({...response(),session:{...response().session,id:'another-place'}},opts())).rejects.toThrow();
  await approveExactResponse(response(),opts());
  await expect(requireApprovedExecution({...context('resolver'),callId:'different'},'deadline_dismiss',input,opts())).rejects.toThrow();
 });
 it('refuses an approval that expires between response and execution',async()=>{
  const past={...opts(),now:new Date(Date.now()-24*3600_000)};
  await reserveExactApproval(context(),'deadline_dismiss',past);
  await attachExactApproval({requestId:'request-1',callId:'call-1',tool:'deadline_dismiss',input});
  await approveExactResponse(response(),past);
  await expect(dismissExactDeadline(getPool(),context('resolver'),input)).rejects.toThrow();await stillOpen();
 });
 it('locks the target content until its protected transaction ends',async()=>{
  const locked=await getPool().connect(),other=await getPool().connect();
  try{
   await locked.query('BEGIN');await deadlineApprovalAdapter.readTarget(locked,input,'member-a');
   await other.query("SET lock_timeout='100ms'");
   await expect(other.query('UPDATE deadlines SET title=\'Changed\' WHERE id=$1',[input.id])).rejects.toMatchObject({code:'55P03'});
   await locked.query('ROLLBACK');
   await expect(other.query('UPDATE deadlines SET title=\'Changed\' WHERE id=$1',[input.id])).resolves.toMatchObject({rowCount:1});
  }finally{await locked.query('ROLLBACK');locked.release();other.release();}
 });
 it('storage absence or failure never grants execution; unknown targets refuse before any database/provider lookup',async()=>{
  const db={query:vi.fn().mockRejectedValue(new Error('unavailable'))};
  await expect(reserveExactApproval(context(),'gmail_send',{db,adapter:deadlineApprovalAdapter})).rejects.toThrow();expect(db.query).not.toHaveBeenCalled();
  await expect(requireApprovedExecution(context('resolver'),'deadline_dismiss',input,{db,adapter:deadlineApprovalAdapter})).rejects.toThrow();
  await expect(approveExactResponse(response(),{db,adapter:deadlineApprovalAdapter})).rejects.toThrow();
  await approved();await getPool().query('ALTER TABLE approval_asks RENAME TO approval_asks_off');
  try{await expect(dismissExactDeadline(getPool(),context('resolver'),input)).rejects.toThrow();await stillOpen();}
  finally{await getPool().query('ALTER TABLE approval_asks_off RENAME TO approval_asks');}
 });
 it('cold processes rebind persisted Eve descriptors, authorize the actual responder, then execute the exact call',async()=>{
  const {ContextContainer}=await import(`${eveDist}context/container.js`);
  const keys=await import(`${eveDist}context/keys.js`);
  const {dispatchDynamicToolEvent,replayDynamicSessionTools}=await import(`${eveDist}context/dynamic-tool-lifecycle.js`);
  const ctx=new ContextContainer();ctx.set(keys.StaticModelReferenceKey,null);ctx.set(keys.SessionIdKey,'wrun_exact');ctx.set(keys.AuthKey,auth());ctx.set(keys.InitiatorAuthKey,auth());
  const resolvers=[{slug:'catalogue',eventNames:['session.started'],events:resolver.events}];
  await dispatchDynamicToolEvent({ctx,resolvers,event:{type:'session.started',data:{}},messages:[]});
  const metadata=ctx.get(keys.SessionDynamicToolMetadataKey).filter((m:any)=>m.name==='deadline_dismiss');
  const tool=replayDynamicSessionTools(metadata,resolvers,'wrun_exact')[0];
  expect(await tool.approval.request(context())).toBe('user-approval');
  const request={kind:'tool-approval',requestId:'request-1',prompt:'Dismiss filing',options:[{id:'approve',label:'Approve'},{id:'cancel',label:'Cancel'}],action:{kind:'tool-call',callId:'call-1',toolName:'deadline_dismiss',input}};
  await makeApprovalRecord()['input.requested']({data:{requests:[request]}},context());
  const payload={metadata:JSON.parse(JSON.stringify(metadata)),context:context('resolver'),input,
   session:{state:{'eve.runtime.pendingInputBatches':[{requests:[request],responseMessages:[],responseAuthRequiredRequestIds:['request-1']}]}},
   stepInput:{attributedInputResponses:[{auth:auth('resolver'),response:{requestId:'request-1',optionId:'approve'}}]}};
  const child=(mode:string)=>new Promise<any>((resolve,reject)=>{
   const p=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./helpers/exact-approval-process.mts',import.meta.url)),mode],{
    cwd:process.cwd(),env:{PATH:process.env.PATH,DATABASE_URL:process.env.DATABASE_URL,...env,EVE_TELEMETRY_DISABLED:'1'},stdio:['pipe','pipe','pipe']});
   let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);
   p.on('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error(`Cold ${mode} exited ${code}: ${err} ${out}`)));
   p.stdin.end(JSON.stringify(payload));
  });
  const responseProcess=await child('response');await stillOpen();
  const executeProcess=await child('execute');
  expect(responseProcess.pid).not.toBe(executeProcess.pid);expect(responseProcess.pid).not.toBe(process.pid);
  expect((await getPool().query('SELECT status FROM deadlines WHERE id=$1',[input.id])).rows[0].status).toBe('dismissed');
 },30_000);
 it('the actual durable role tool survives callback rebinding and Eve authorizes before execution',async()=>{
  const tools=await (resolver.events['session.started'] as any)({},context());const tool=tools.deadline_dismiss;
  const {validateDurableDynamicToolCallbacks}=await import(`${eveDist}context/dynamic-tool-lifecycle.js`);
  const owner={sessionId:'wrun_exact',scope:'session',resolverSlug:'catalogue',entryKey:'deadline_dismiss',name:'deadline_dismiss'};
  const callbacks=validateDurableDynamicToolCallbacks('deadline_dismiss',tool,owner);
  expect(callbacks.approvalRequest).toBeDefined();expect(callbacks.approvalResponse).toBeDefined();
  expect(await tool.approval.request(context())).toBe('user-approval');
  const request={kind:'tool-approval',requestId:'request-1',prompt:'Dismiss filing',options:[{id:'approve',label:'Approve'},{id:'cancel',label:'Cancel'}],action:{kind:'tool-call',callId:'call-1',toolName:'deadline_dismiss',input}};
  await makeApprovalRecord()['input.requested']({data:{requests:[request]}},context());
  // Simulate loss of all framework callback bindings, then let the actual resolver rebind them.
  const {clearDurableDynamicCallbacks}=await import(`${eveDist}tools/durable-callbacks.js`);clearDurableDynamicCallbacks('wrun_exact');
  const rebound=(await (resolver.events['session.started'] as any)({},context('resolver'))).deadline_dismiss;
  validateDurableDynamicToolCallbacks('deadline_dismiss',rebound,owner);
  const {ContextContainer,contextStorage}=await import(`${eveDist}context/container.js`);
  const {coordinateApprovalDelivery}=await import(`${eveDist}harness/approval-delivery-coordinator.js`);
  const {getApprovalAuditState}=await import(`${eveDist}harness/approval-candidates.js`);
  const container=new ContextContainer();container.set({name:'eve.session'},{sessionId:'wrun_exact',auth:context('resolver').session.auth,turn:context('resolver').session.turn});
  let session={state:{'eve.runtime.pendingInputBatches':[{requests:[request],responseMessages:[],responseAuthRequiredRequestIds:['request-1']}]}};
  let stepInput:any={attributedInputResponses:[{auth:auth('resolver'),response:{requestId:'request-1',optionId:'approve'}}]};
  for(let n=0;n<4;n++){
   const r=await contextStorage.run(container,()=>coordinateApprovalDelivery({session,stepInput,tools:new Map([['deadline_dismiss',rebound]])}));session=r.session;stepInput=r.stepInput;
  }
  expect(getApprovalAuditState(session.state).settlements).toMatchObject([{outcome:'allowed',requestId:'request-1'}]);
  expect((await getPool().query("SELECT outcome,resolved_by_member_id FROM approval_asks WHERE call_id='call-1'")).rows[0]).toEqual({outcome:'approved',resolved_by_member_id:'member-a'});
  expect(await rebound.execute(input,context('resolver'))).toMatchObject({dismissed:true});
  await expect(tools.set_language.execute({language:'en'},context('resolver'))).rejects.toThrow();
  await expect(tools.remember.execute({fact:'Must not be written'},context('resolver'))).rejects.toThrow();
  await expect(rebound.execute({...input,reason:'Another'},context('resolver'))).rejects.toThrow();
 });
});
