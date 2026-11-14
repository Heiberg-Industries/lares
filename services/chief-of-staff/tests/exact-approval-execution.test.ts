/** Real storage, eve's own session view and the real catalogue callbacks.
 * No model/provider credentials or installation data. */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getPool, closePool } from '@lares/agent-kit/db';
import { PgGrantStore } from '@lares/agent-kit/grant-store';
import { bindConsoleSession, consoleAdmission, consoleRouteAdmission, requireConsoleTurnAuthority } from '@lares/agent-kit/console-turn-authority';
import { assertPrivateConsoleRequest } from '@lares/agent-kit/private-console-envelope';
import { exactResolverAdmission, privateResolverAdmission, requireConsoleResume, requirePrivateConsoleResume } from '@lares/agent-kit/private-console-resume';
import { ApprovalRefusal, reserveExactApproval, attachExactApproval, approveExactResponse, requireApprovedExecution, settleExactInput } from '@lares/agent-kit/approval-execution';
import { recordAsk, recordAnswer, assertApprovedCall, approvalLedger, payloadFingerprint, APPROVAL_TTL_MS } from '@lares/agent-kit/approval-ledger';
import { readApprovalCounts } from '@lares/agent-kit/approval-stats';
import { makeApprovalRecord } from '@lares/agent-kit/approval-record-hook';
import { deadlineApprovalAdapter, dismissExactDeadline } from '../lib/deadlines-store.js';
import { twentyTracksApprovalAdapter } from '../lib/tracks-approval.js';
import resolver from '../agent/tools/catalogue.js';
import { driveAnswer } from './helpers/answer-check.js';
import { eveSession } from '../../../packages/agent-kit/tests/helpers/eve-session.js';
import { runDynamic, type MemoStore } from '../../../packages/agent-kit/tests/helpers/eve-dynamic.js';
import { assertApproval, catalogueApprovalRequest, catalogueApprovalResponse, guardCatalogueExecution, humanTurnRefusal, runApprovedTwentyTrackOnce } from '../lib/approvals.js';
import { TwentyTracksHome } from '../lib/twenty-tracks.js';

const inc='11111111-1111-4111-8111-111111111111';
const env={LARES_AGENT_NAME:'helper',LARES_AGENT_INCARNATION:inc,AGENT_OWNER_USER_ID:'member-a'};
const auth=(purpose='human',member='member-a',nonce='a'.repeat(43),option='approve')=>({authenticator:'lares-console',principalId:member,principalType:'user',attributes:{user_id:member,lares_member_id:member,lares_admission_nonce:nonce,lares_purpose:purpose,...(purpose==='resolver'?{lares_resume_request_id:'request-1',lares_resume_option:option}:{})}});
const input={id:'11111111-2222-4333-8444-555555555555',reason:'Duplicate filing'};
/** eve 1.0: a call that runs after Approve, and the policy re-check before it, run as the person who ASKED
 *  (`session.auth.current` stays the human requester, in the ORIGINAL turn). The person who answered is only
 *  `approval.responder`, present while the approved call runs. `context('resolver')` is that approved run. */
const context=(purpose='human',raw:unknown=input):any=>({callId:'call-1',toolName:'deadline_dismiss',toolInput:raw,abortSignal:new AbortController().signal,session:{id:'wrun_exact',turn:{id:'turn-original',sequence:0},auth:{current:auth('human'),initiator:auth()}},...(purpose==='resolver'?{approval:{responder:auth('resolver')}}:{})});
/** eve's own re-check: the real evaluateApproval with recheck on hands the policy the mark it checks for. */
const evalUrl=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/approval/evaluation.js',import.meta.url))).href;
const recheckOf=async(policy:(c:any)=>unknown,ctx:any,recheck=true)=>{const {evaluateApproval}=await import(evalUrl) as any;return evaluateApproval(policy,ctx,{recheck});};
const def={name:'helper',model:'fixture-brain',persona:'voice.md',role:'chief-of-staff',channels:[],grants:[{capability:'deadline',scope:'write-with-confirm'}],autonomy:{deadline:'gated'},skills:[]};
const opts=()=>({adapter:deadlineApprovalAdapter});
let container:StartedPostgreSqlContainer;
const sqlDir=new URL('../../box/sql/',import.meta.url);

beforeAll(async()=>{
 container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
 vi.stubEnv('DATABASE_URL',container.getConnectionUri());
 for(const [k,v] of Object.entries(env))vi.stubEnv(k,v);
 const db=getPool();db.on('error',()=>undefined);db.on('connect',c=>c.on('error',()=>undefined));
 for(const f of readdirSync(sqlDir).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort())await db.query(readFileSync(new URL(f,sqlDir),'utf8'));
 await db.query("INSERT INTO orgs(id,display_name) VALUES('fixture-org','Fixture'); INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-a','A','fixture-org','owner','active'),('member-b','B','fixture-org','owner','active')");
 await db.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES('helper',$1,'fixture-hash','valid')",[def]);
 await db.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending,applied_definition) VALUES('helper','172.30.0.99','fixture','owned',$1,$1,'ready',false,$2)",[inc,def]);
 await db.query("INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES('member-a',NULL)");
 await new PgGrantStore(db).adoptAgent('member-a',{agentName:'helper',expectedDefinitionHash:'fixture-hash'},{designatedOwnerMemberId:'member-a'});
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
const response=(raw:unknown=input,decision:'approve'|'deny'='approve',principal:unknown=auth('resolver','member-a','a'.repeat(43),decision))=>({request:{interactionId:'request-1',callId:'call-1',toolName:'deadline_dismiss',toolInput:raw},response:{decision,principal},session:{id:'wrun_exact',initiator:auth(),turn:{id:'turn-resolver',sequence:1}}});
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
  expect(c.approval.responder.attributes.lares_purpose).toBe('resolver');
  expect(c.session.auth.current.attributes.lares_purpose).toBe('human');
  expect(humanTurnRefusal({...c.session,auth:{current:c.approval.responder,initiator:c.session.auth.initiator}},'Refused')).toContain('no new human instruction');
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
  const hook=makeApprovalRecord();
  const card=(interactionId:string)=>{const e=eveSession();e.call('call-1','deadline_dismiss',input);return {event:e.open(interactionId,'call-1'),ctx:{...context(),view:e.view}};};
  const good=card('request-1');
  await hook['interaction.opened'](good.event,good.ctx);
  expect((await getPool().query("SELECT request_id FROM approval_asks WHERE call_id='call-1'")).rows[0].request_id).toBe('request-1');
  const wrong=card('wrong');
  await expect(hook['interaction.opened'](wrong.event,wrong.ctx)).rejects.toThrow();
 });
 for(const [label,change] of [
  ['payload',async()=>undefined],
  ['member removed',async()=>getPool().query("UPDATE users SET status='removed' WHERE id='member-a'")],
  ['member demoted',async()=>getPool().query("UPDATE users SET org_role='member' WHERE id='member-a'")],
  ['access revision changed and restored sharing',async()=>{const store=new PgGrantStore(getPool());const a=await store.agentAccess('member-a','helper');await store.updateAgentAccess('member-a',{agentName:'helper',expectedRevision:a!.accessRevision,grants:[]});}],
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
 for(const revision of ['same-level rewrite','disabled and restored']){
  for(const stage of ['response','execution']){
   it(`refuses an existing board ${revision} before ${stage}`,async()=>{
    await getPool().query("INSERT INTO ratchet(agent,capability,level,updated_by,updated_at) VALUES('helper','deadline','gated','fixture','2026-10-21T10:00:00.000001Z')");
    if(stage==='execution')await approved();else await reserved();
    if(revision==='disabled and restored')await getPool().query("UPDATE ratchet SET level='never',updated_at=updated_at+interval '1 microsecond' WHERE agent='helper'");
    await getPool().query("UPDATE ratchet SET level='gated',updated_at=updated_at+interval '1 microsecond' WHERE agent='helper'");
    if(stage==='execution')await expect(dismissExactDeadline(getPool(),context('resolver'),input)).rejects.toThrow();
    else await expect(approveExactResponse(response(),opts())).rejects.toThrow();
    await stillOpen();
   });
  }
 }
 it('rechecks expiry after waiting for the target lock, immediately before mutation',async()=>{
  const justBeforeExpiry={...opts(),now:new Date(Date.now()-APPROVAL_TTL_MS+1200)};
  await reserveExactApproval(context(),'deadline_dismiss',justBeforeExpiry);
  await attachExactApproval({requestId:'request-1',callId:'call-1',tool:'deadline_dismiss',input});
  await approveExactResponse(response(),opts());
  const locked=await getPool().connect();let executing:Promise<unknown>|undefined;
  try{
   await locked.query('BEGIN');await deadlineApprovalAdapter.readTarget(locked,input,'member-a');
   const pid=(await locked.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   executing=dismissExactDeadline(getPool(),context('resolver'),input);
   // Consume rejection immediately while the assertions inspect the deliberate lock wait.
   const outcome=executing.then(()=>({ok:true,error:undefined as unknown}),error=>({ok:false,error}));
   let blocked=false;
   for(let n=0;n<100;n++){
    blocked=(await getPool().query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked;
    if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(blocked).toBe(true);
   const expiry=(await getPool().query("SELECT original_authority->>'expiresAt' AS expiry FROM approval_asks WHERE call_id='call-1'")).rows[0].expiry;
   await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(expiry)-Date.now()+50)));
   await locked.query('ROLLBACK');
   const result=await outcome;expect(result.ok).toBe(false);expect((result.error as Error).message).toContain('Exact approval');await stillOpen();
  }finally{await locked.query('ROLLBACK');locked.release();await executing?.catch(()=>undefined);}
 },10_000);
 it('refuses when a named use grant expires while the approved target is locked',async()=>{
  const db=getPool(),store=new PgGrantStore(db);
  const locked=await db.connect();let executing:Promise<unknown>|undefined;
  try{
   await db.query('DELETE FROM console_session_bindings; DELETE FROM agent_access');
   await db.query("INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES('member-b',NULL) ON CONFLICT(user_id) DO NOTHING");
   const owner=await store.adoptAgent('member-b',{agentName:'helper',expectedDefinitionHash:'fixture-hash'},{designatedOwnerMemberId:'member-b'});
   const expiry=new Date(Date.now()+1800).toISOString();
   await store.updateAgentAccess('member-b',{agentName:'helper',expectedRevision:owner.accessRevision,grants:[{principal:{kind:'member',id:'member-a'},permission:'use',expiresAt:expiry}]});
   await bindConsoleSession({agent:'helper',incarnation:inc,sessionId:'wrun_exact',memberId:'member-a',admissionNonce:'a'.repeat(43)});
   await approved();
   await locked.query('BEGIN');await deadlineApprovalAdapter.readTarget(locked,input,'member-a');
   const pid=(await locked.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   executing=dismissExactDeadline(db,context('resolver'),input);
   const outcome=executing.then(()=>({ok:true,error:undefined as unknown}),error=>({ok:false,error}));
   let blocked=false;
   for(let n=0;n<100;n++){
    blocked=(await db.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked;
    if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(blocked).toBe(true);
   await db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)',[expiry]);
   const approval=(await db.query("SELECT original_authority->>'expiresAt' AS expiry FROM approval_asks WHERE call_id='call-1'")).rows[0];
   expect(Date.parse(approval.expiry)).toBeGreaterThan(Date.now());
   await locked.query('ROLLBACK');
   const result=await outcome;expect(result.ok).toBe(false);expect((result.error as Error).message).toMatch(/authority/i);
   await stillOpen();
   expect((await db.query("SELECT use_count FROM approval_asks WHERE call_id='call-1'")).rows[0].use_count).toBe(0);
  }finally{
   await locked.query('ROLLBACK');locked.release();await executing?.catch(()=>undefined);
   await db.query('DELETE FROM console_session_bindings; DELETE FROM agent_access');
   await store.adoptAgent('member-a',{agentName:'helper',expectedDefinitionHash:'fixture-hash'},{designatedOwnerMemberId:'member-a'});
  }
 },10_000);
 it('serializes concurrent exact-call executions without a lock-upgrade deadlock',async()=>{
  await approved();const results=await Promise.allSettled([
   dismissExactDeadline(getPool(),context('resolver'),input),dismissExactDeadline(getPool(),context('resolver'),input),
  ]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
  expect(failed.reason).not.toMatchObject({code:'40P01'});
  expect((await getPool().query('SELECT status FROM deadlines WHERE id=$1',[input.id])).rows[0].status).toBe('dismissed');
  expect((await getPool().query("SELECT use_count FROM approval_asks WHERE call_id='call-1'")).rows[0].use_count).toBe(1);
 });
 it('refuses expiry, a different responder, an initiator fallback, wrong call, audience/place or nonce',async()=>{
  await reserved();const later={...opts(),now:new Date(Date.now()+24*3600_000)};
  await expect(approveExactResponse(response(),later)).rejects.toThrow();
  await expect(approveExactResponse(response(input,'approve',auth('resolver','member-b')),opts())).rejects.toThrow();
  await expect(approveExactResponse(response(input,'approve',null),opts())).rejects.toThrow();
  await expect(approveExactResponse(response(input,'approve',auth('resolver','member-a','b'.repeat(43))),opts())).rejects.toThrow();
  await expect(approveExactResponse({...response(),session:{...response().session,id:'another-place'}},opts())).rejects.toThrow();
  await approveExactResponse(response(),opts());
  await expect(requireApprovedExecution({...context('resolver'),callId:'different'} as never,'deadline_dismiss',input,opts())).rejects.toThrow();
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
 it('omits private deadlines from a private conversation, also after a cold start (a fresh memo), and refuses reconstructed native callbacks',async()=>{
  const privateCtx={session:{id:'wrun_exact',auth:{current:auth('human'),initiator:auth('human')}}};
  const store:MemoStore=new Map();
  const tools=await runDynamic(resolver,privateCtx,store);
  expect(tools.deadline_dismiss).toBeUndefined();expect(tools.set_language).toBeUndefined();expect(tools.remember).toBeUndefined();
  // A new process has no memo: the decision is made again from the definition and comes out the same.
  const cold=await runDynamic(resolver,privateCtx,new Map());
  expect(Object.keys(cold).sort()).toEqual(Object.keys(tools).sort());
  const native=await runDynamic(resolver,{session:{id:'wrun_exact',auth:{current:null,initiator:null}}});
  const tool=native.deadline_dismiss;
  expect(typeof tool.approval).toBe('object');expect(typeof tool.approval.request).toBe('function');expect(typeof tool.approval.prompt).toBe('function');
  await expect(tool.approval.request(context())).rejects.toThrow('Conversation authority');
  await expect(tool.execute(input,context())).rejects.toThrow('Conversation authority');
  await expect(tool.execute(input,context('resolver'))).rejects.toThrow('Conversation authority');
  await stillOpen();
 });
 it('a fresh process (cold start: no memo, no module state) runs the approved call only with its responder',async()=>{
  await approved();
  const payload={context:context('resolver'),input};
  const result=await new Promise<any>((resolve,reject)=>{
   const p=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./helpers/cold-process.mts',import.meta.url))],{
    cwd:process.cwd(),env:{PATH:process.env.PATH,DATABASE_URL:process.env.DATABASE_URL,...env,EVE_TELEMETRY_DISABLED:'1'},stdio:['pipe','pipe','pipe']});
   let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);
   p.on('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error(`Cold start exited ${code}: ${err} ${out}`)));
   p.stdin.end(JSON.stringify(payload));
  });
  expect(result.pid).not.toBe(process.pid);
  expect(result.hasResponder).toBe(true);
  expect(result.withResponder).toBe('ran');                // approved card + its responder: allowed
  expect(result.withoutResponder).toMatch(/^refused/);     // the same call with no responder on ctx.approval: refused
  expect(result.guardWithoutResponder).toMatch(/^refused/);
  await stillOpen();
 },60_000);
 it('refuses a Deny from anyone but the person who may approve the card, and the card stays pending',async()=>{
  await reserved();
  const pending=async()=>(await getPool().query("SELECT outcome,resolved_by_member_id FROM approval_asks WHERE call_id='call-1'")).rows[0];
  // Another member, another admission, no identity at all, another conversation: refused like an Approve.
  await expect(approveExactResponse(response(input,'deny',auth('resolver','member-b','a'.repeat(43),'deny')),opts())).rejects.toThrow();
  await expect(approveExactResponse(response(input,'deny',auth('resolver','member-a','b'.repeat(43),'deny')),opts())).rejects.toThrow();
  await expect(approveExactResponse(response(input,'deny',null),opts())).rejects.toThrow();
  await expect(approveExactResponse({...response(input,'deny'),session:{...response().session,id:'another-place'}},opts())).rejects.toThrow();
  // A human turn (not a resolver answer) is not an answer at all.
  await expect(approveExactResponse(response(input,'deny',auth('human')),opts())).rejects.toThrow();
  expect(await pending()).toEqual({outcome:null,resolved_by_member_id:null});
  // The decision eve is acting on and the option the console named must agree, both ways.
  await expect(approveExactResponse(response(input,'deny',auth('resolver','member-a','a'.repeat(43),'approve')),opts())).rejects.toThrow();
  await expect(approveExactResponse(response(input,'approve',auth('resolver','member-a','a'.repeat(43),'deny')),opts())).rejects.toThrow();
  // A decision that is neither is refused.
  await expect(approveExactResponse({...response(),response:{decision:'cancel' as never,principal:auth('resolver','member-a','a'.repeat(43),'deny')}},opts())).rejects.toThrow();
  expect(await pending()).toEqual({outcome:null,resolved_by_member_id:null});
  // The person who may approve may deny; a Deny writes no approval, and the card is still usable only through eve settling it.
  await expect(approveExactResponse(response(input,'deny'),opts())).resolves.toEqual({status:'allowed'});
  expect(await pending()).toEqual({outcome:null,resolved_by_member_id:null});
  await stillOpen();
 });
 it('a Deny after the card was approved or settled is refused, and an expired card cannot be denied either',async()=>{
  await approved();
  await expect(approveExactResponse(response(input,'deny'),opts())).rejects.toThrow();
  await getPool().query('DELETE FROM approval_asks');await reserved();
  await expect(approveExactResponse(response(input,'deny'),{...opts(),now:new Date(Date.now()+24*3600_000)})).rejects.toThrow();
 });
 for(const [outcome,settledAs] of [['declined','cancelled'],['withdrawn','ignored'],['interrupted','ignored'],['expired','ignored'],['accepted-deny','invalid']] as const){
  it(`nothing executes when the card ended ${outcome}, and the record says so`,async()=>{
   await reserved();
   const hook=makeApprovalRecord();const e=eveSession();e.call('call-1','deadline_dismiss',input);e.open('request-1','call-1');
   const settled=outcome==='accepted-deny'?e.settle('request-1','accepted','deny'):e.settle('request-1',outcome,outcome==='declined'?'deny':undefined);
   await hook['interaction.settled'](settled,{...context('resolver'),view:e.view});
   expect((await getPool().query("SELECT outcome FROM approval_asks WHERE call_id='call-1'")).rows[0].outcome).toBe(settledAs);
   await expect(requireApprovedExecution(context('resolver'),'deadline_dismiss',input,opts())).rejects.toThrow();
   await expect(dismissExactDeadline(getPool(),context('resolver'),input)).rejects.toThrow();
   await stillOpen();
  });
 }
 it('records an accepted Approve only as the answer the response policy already wrote',async()=>{
  await approved();
  const hook=makeApprovalRecord();const e=eveSession();e.call('call-1','deadline_dismiss',input);e.open('request-1','call-1');
  await hook['interaction.settled'](e.settle('request-1','accepted','approve'),{...context('resolver'),view:e.view});
  expect((await getPool().query("SELECT outcome,resolved_by_member_id FROM approval_asks WHERE call_id='call-1'")).rows[0]).toEqual({outcome:'approved',resolved_by_member_id:'member-a'});
 });
});

describe('answering an exact card through the private route',()=>{
 const body=(requestId='request-1',optionId='approve')=>JSON.stringify({answers:[{interactionId:requestId,optionId}]});
 async function answer(o:{member?:string;nonce?:string;session?:string;requestId?:string;optionId?:string}={}){
  const r=new Request(`http://runtime.invalid/eve/v1/session/${o.session??'wrun_exact'}`,{method:'POST',body:body(o.requestId,o.optionId),
   headers:{'x-lares-member-id':o.member??'member-a','x-lares-admission':o.nonce??'a'.repeat(43),'x-lares-purpose':'resolver'}});
  await assertPrivateConsoleRequest(r);return consoleRouteAdmission(r,getPool(),env);
 }
 const answered=(requestId='request-1',optionId='approve',nonce='a'.repeat(43))=>({authenticator:'lares-console',attributes:{lares_member_id:'member-a',lares_admission_nonce:nonce,lares_purpose:'resolver',lares_resume_request_id:requestId,lares_resume_option:optionId}});
 const resumed=(current:unknown)=>({session:{id:'wrun_exact',turn:{id:'',sequence:1},auth:{current,initiator:auth()}}});
 async function backdate(){
  const ask=(await getPool().query("SELECT * FROM approval_asks WHERE request_id='request-1'")).rows[0];
  await getPool().query("DELETE FROM approval_asks WHERE request_id='request-1'");
  await getPool().query("INSERT INTO approval_asks(call_id,request_id,agent,tool,payload_hash,original_authority,acting_member_id,session_id,asked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()-interval '25 hours')",[ask.call_id,ask.request_id,ask.agent,ask.tool,ask.payload_hash,ask.original_authority,ask.acting_member_id,ask.session_id]);
 }
 it('admits the member who started the conversation, with their original admission and this card only',async()=>{
  await reserved();
  const attrs=await answer();
  expect(attrs).toEqual({lares_member_id:'member-a',lares_admission_nonce:'a'.repeat(43),lares_purpose:'resolver',lares_resume_request_id:'request-1',lares_resume_option:'approve'});
  expect(consoleAdmission({authenticator:'lares-console',attributes:attrs})).toEqual({memberId:'member-a',admissionNonce:'a'.repeat(43),purpose:'resolver'});
  expect(privateResolverAdmission({authenticator:'lares-console',attributes:attrs})).toBeUndefined();
  expect(exactResolverAdmission({authenticator:'lares-console',attributes:attrs})).toMatchObject({memberId:'member-a',requestId:'request-1',optionId:'approve'});
  await expect(requireConsoleTurnAuthority({session:{id:'wrun_exact',turn:{id:'t',sequence:1},auth:{current:{authenticator:'lares-console',attributes:attrs},initiator:auth()}}})).rejects.toThrow('Conversation authority');
 });
 it('refuses another member, another admission, another conversation and an unknown card',async()=>{
  await reserved();
  await getPool().query("INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES('member-b',NULL) ON CONFLICT DO NOTHING");
  await expect(answer({member:'member-b'})).rejects.toThrow();
  await expect(answer({nonce:'z'.repeat(43)})).rejects.toThrow();
  await bindConsoleSession({agent:'helper',incarnation:inc,sessionId:'wrun_other',memberId:'member-a',admissionNonce:'b'.repeat(43)});
  await expect(answer({session:'wrun_other',nonce:'b'.repeat(43)})).rejects.toThrow();
  await expect(answer({session:'wrun_other'})).rejects.toThrow();
  await expect(answer({requestId:'forged-request'})).rejects.toThrow();
 });
 it('takes no answer to a settled or spent card',async()=>{
  await approved();
  await expect(answer()).resolves.toMatchObject({lares_resume_request_id:'request-1'});
  await expect(answer({optionId:'deny'})).rejects.toThrow();
  await getPool().query("UPDATE approval_asks SET used_at=clock_timestamp(),use_count=1 WHERE request_id='request-1'");
  await expect(answer()).rejects.toThrow();
  await expect(answer({optionId:'deny'})).rejects.toThrow();
  await getPool().query("DELETE FROM approval_asks");await reserved();
  await settleExactInput('request-1','cancelled');
  await expect(answer()).rejects.toThrow();
  await expect(answer({optionId:'deny'})).rejects.toThrow();
 });
 it('refuses an approval once the card has expired, and still lets it be denied',async()=>{
  await reserved();await backdate();
  await expect(answer()).rejects.toThrow();
  await expect(answer({optionId:'deny'})).resolves.toMatchObject({lares_resume_option:'deny'});
 });
 it('uses the earlier of the two lifetimes the reservation carries',async()=>{
  await reserveExactApproval(context(),'deadline_dismiss',{...opts(),now:new Date(Date.now()-25*60*60_000)});
  await attachExactApproval({requestId:'request-1',callId:'call-1',tool:'deadline_dismiss',input});
  await expect(answer()).rejects.toThrow();
 });
 it('refuses a tampered reservation rather than treating it as absent',async()=>{
  await reserved();
  await getPool().query("ALTER TABLE approval_asks DISABLE TRIGGER exact_approval_authority_guard");
  try{
   await getPool().query("UPDATE approval_asks SET original_authority=original_authority||'{\"admissionHash\":\"changed\"}'::jsonb WHERE request_id='request-1'");
   await expect(answer()).rejects.toThrow();
  }finally{await getPool().query("ALTER TABLE approval_asks ENABLE TRIGGER exact_approval_authority_guard");}
 });
 it('approves only the card this answer named, and only an approve answer',async()=>{
  await reserved();
  const respond=(responder:unknown)=>approveExactResponse(response(input,'approve',responder),opts());
  await expect(respond(answered('another-request'))).rejects.toThrow();
  await expect(respond(answered('request-1','deny'))).rejects.toThrow();
  await expect(respond(auth('human'))).rejects.toThrow();
  await expect(respond({authenticator:'lares-console',attributes:{lares_member_id:'member-a',lares_admission_nonce:'a'.repeat(43),lares_purpose:'resolver'}})).rejects.toThrow();
  await expect(respond(answered('request-1','approve','z'.repeat(43)))).rejects.toThrow();
  expect((await getPool().query("SELECT outcome FROM approval_asks WHERE request_id='request-1'")).rows[0].outcome).toBeNull();
  await expect(respond(answered())).resolves.toEqual({status:'allowed'});
 });
 it('lets the model continue only after this member answered, and never past expiry',async()=>{
  await reserved();
  await expect(requireConsoleResume(resumed(answered()),'surface',{env})).resolves.toMatchObject({binding:{memberId:'member-a'}});
  await expect(requireConsoleResume(resumed(answered()),'model',{env})).rejects.toThrow();
  await expect(requireConsoleResume(resumed(answered('request-1','deny')),'model',{env})).rejects.toThrow();
  await approveExactResponse(response(),opts());
  await expect(requireConsoleResume(resumed(answered()),'model',{env})).resolves.toMatchObject({validUntil:expect.any(String)});
  await expect(requireConsoleResume(resumed(answered('request-1','approve','z'.repeat(43))),'model',{env})).rejects.toThrow();
  await expect(requirePrivateConsoleResume(resumed(answered()),'action',{env})).rejects.toThrow();
  await settleExactInput('request-1','cancelled');
  await expect(requireConsoleResume(resumed(answered()),'model',{env})).rejects.toThrow();
  await expect(requireConsoleResume(resumed(answered('request-1','deny')),'model',{env})).resolves.toBeDefined();
 });
 it('runs only with an authenticated responder on ctx.approval: none, the requester themself, another card, member, admission or option is refused',async()=>{
  await approved();
  const withResponder=(responder:unknown)=>{const c=context();if(responder!==undefined)c.approval={responder};return c;};
  for(const bad of [undefined,null,auth('human'),auth('resolver','member-b'),auth('resolver','member-a','b'.repeat(43)),auth('resolver','member-a','a'.repeat(43),'deny'),
      {...auth('resolver'),attributes:{...auth('resolver').attributes,lares_resume_request_id:'another-request'}},{authenticator:'slack-webhook',attributes:{user_id:'U1'}}])
    await expect(requireApprovedExecution(withResponder(bad),'deadline_dismiss',input,opts())).rejects.toThrow();
  // The responder is read from ctx.approval only: a resolver identity in session.auth.current is not an answer.
  const asCurrent=context();asCurrent.session.auth.current=auth('resolver');
  await expect(requireApprovedExecution(asCurrent,'deadline_dismiss',input,opts())).rejects.toThrow();
  await expect(requireApprovedExecution(withResponder(auth('resolver')),'deadline_dismiss',input,opts())).resolves.toMatchObject({callId:'call-1'});
  // A requester who is not the member who approved, or whose admission differs, is refused too.
  const otherAsker=withResponder(auth('resolver'));otherAsker.session.auth={current:auth('human','member-b'),initiator:auth()};
  await expect(requireApprovedExecution(otherAsker,'deadline_dismiss',input,opts())).rejects.toThrow();
 });
 it('runs nothing under a deny answer, even a call approved earlier',async()=>{
  await approved();
  const cancelling=context('resolver');
  (cancelling.approval.responder.attributes as Record<string,unknown>).lares_resume_option='deny';
  await expect(requireApprovedExecution(cancelling,'deadline_dismiss',input,opts())).rejects.toThrow();
  const unnamed=context('resolver');
  delete (unnamed.approval.responder.attributes as Record<string,unknown>).lares_resume_option;
  await expect(requireApprovedExecution(unnamed,'deadline_dismiss',input,opts())).rejects.toThrow();
  await expect(requireApprovedExecution(context('resolver'),'deadline_dismiss',input,opts())).resolves.toMatchObject({callId:'call-1'});
 });
 describe('a card that writes to the company CRM',()=>{
  const twenty={home:'twenty',trackId:'sales',who:{personId:'person-1'},step:'Open',note:'n',sourceSignal:'s'};
  const crm=(member='member-a')=>({...context('human',twenty),toolName:'track_add_item',session:{...context('human',twenty).session,auth:{current:auth('human',member),initiator:auth('human',member)}}});
  const answerCard=(raw:unknown=twenty,decision:'approve'|'deny'='approve',principal:unknown=auth('resolver','member-a','a'.repeat(43),decision))=>({request:{interactionId:'request-1',callId:'call-1',toolName:'track_add_item',toolInput:raw},response:{decision,principal},session:{id:'wrun_exact',initiator:auth(),turn:{id:'t',sequence:1}}});
  const running=()=>({...context('resolver',twenty),toolName:'track_add_item'});
  let listTracks:ReturnType<typeof vi.spyOn>;
  beforeEach(async()=>{
   await getPool().query("UPDATE agent_resources SET applied_definition=$1 WHERE name='helper'",[{...def,grants:[{capability:'twenty',scope:'write-with-confirm'}],autonomy:{twenty:'gated'}}]);
   listTracks=vi.spyOn(TwentyTracksHome.prototype,'listTracks').mockResolvedValue([{id:'sales',name:'Sales',purpose:'Work',steps:['Open','Won'],closingSteps:['Won']}]);
  });
  afterEach(()=>{listTracks.mockRestore();});
  async function raise(){
   expect(await catalogueApprovalRequest('track_add_item',crm(),()=>'user-approval')).toBe('user-approval');
   await attachExactApproval({requestId:'request-1',callId:'call-1',tool:'track_add_item',input:twenty});
  }
  it('lets the designated owner raise, answer and run it once',async()=>{
   await raise();
   await expect(catalogueApprovalResponse('track_add_item',answerCard())).resolves.toEqual({status:'allowed'});
   await expect(guardCatalogueExecution(running(),'track_add_item',twenty)).resolves.toBeUndefined();
   const approved=await assertApproval(running(),'track_add_item',twenty);
   const write=vi.fn(async()=>'written');
   await expect(runApprovedTwentyTrackOnce(approved,write)).resolves.toBe('written');
   await expect(runApprovedTwentyTrackOnce(approved,write)).rejects.toThrow();
   expect(write).toHaveBeenCalledOnce();
  });
  it('answers a refusal while the card is built as a reason the model reads, never a failed turn',async()=>{
   // A target that cannot be read (here: a track the CRM does not have) used to throw out of the
   // approval policy, and a thrown policy parks the conversation on "is running…".
   const missing={...crm(),toolInput:{...twenty,trackId:'no-such-track'}};
   await expect(catalogueApprovalRequest('track_add_item',missing,()=>'user-approval'))
    .resolves.toEqual({type:'denied',reason:expect.stringMatching(/could not be prepared for approval.*nothing was changed/i)});
   // A refusal written for the model, such as a note title already in use, reaches it word for word.
   const said='A private note with this title already exists. Choose another title: this tool saves new notes only.';
   const target=vi.spyOn(twentyTracksApprovalAdapter,'readTarget').mockRejectedValueOnce(new ApprovalRefusal(said));
   try{
    await expect(catalogueApprovalRequest('track_add_item',crm(),()=>'user-approval')).resolves.toEqual({type:'denied',reason:said});
   }finally{target.mockRestore();}
   expect((await getPool().query("SELECT count(*)::int n FROM approval_asks")).rows[0].n).toBe(0);
  });
  it('refuses every other member before a card or a CRM read, including another with the owner role',async()=>{
   await bindConsoleSession({agent:'helper',incarnation:inc,sessionId:'wrun_b',memberId:'member-b',admissionNonce:'b'.repeat(43)}).catch(()=>undefined);
   const other=crm('member-b');
   await expect(catalogueApprovalRequest('track_add_item',other,()=>'user-approval')).resolves.toMatchObject({type:'denied'});
   expect((await getPool().query("SELECT count(*)::int n FROM approval_asks")).rows[0].n).toBe(0);
   expect(listTracks).not.toHaveBeenCalled();
  });
  it("web chat through eve's real answer check: the owner's Approve and Deny are admitted; a stranger, a human turn, a missing card requester and no identity are refused",async()=>{
   const tool=(await runDynamic(resolver,{session:{id:'wrun_exact',auth:{current:auth('human'),initiator:auth()}}})).track_add_item;
   expect(typeof tool.approval.response).toBe('function');
   const verdict=(o:{responder:unknown;optionId:string;requester?:unknown})=>driveAnswer({tool,toolName:'track_add_item',input:twenty,sessionId:'wrun_exact',callId:'call-1',cardId:'request-1',requester:'requester' in o?o.requester:auth('human'),responder:o.responder,optionId:o.optionId});
   const outcome=async()=>(await getPool().query("SELECT outcome FROM approval_asks WHERE call_id='call-1'")).rows[0].outcome;
   await raise();
   for(const optionId of ['approve','deny']){
    for(const bad of [auth('resolver','member-b','a'.repeat(43),optionId),auth('resolver','member-a','b'.repeat(43),optionId),auth('human'),null,{authenticator:'slack-webhook',principalId:'U1',principalType:'user',attributes:{user_id:'U1'}}]){
     const r=await verdict({responder:bad,optionId});
     expect(r.stage,optionId).not.toBe('admitted');
    }
    expect((await verdict({responder:auth('resolver','member-a','a'.repeat(43),optionId),optionId,requester:null})).stage,optionId).not.toBe('admitted');
    expect(await outcome()).toBeNull(); // nothing was recorded by a refused answer
   }
   // The owner's own answers are admitted; a Deny writes nothing, an Approve records the approval.
   expect((await verdict({responder:auth('resolver','member-a','a'.repeat(43),'deny'),optionId:'deny'})).stage).toBe('admitted');
   expect(await outcome()).toBeNull();
   expect((await verdict({responder:auth('resolver','member-a','a'.repeat(43),'approve'),optionId:'approve'})).stage).toBe('admitted');
   expect(await outcome()).toBe('approved');
  });
  it('the re-check before an approved call: eve marks it, the approved card passes, anything else is denied',async()=>{
   const policy=(c:any)=>catalogueApprovalRequest('track_add_item',c,()=>'user-approval');
   await raise();
   // Not approved yet: the re-check is denied, and nothing is reserved again or changed.
   expect(await recheckOf(policy,crm())).toMatchObject({denied:true});
   await catalogueApprovalResponse('track_add_item',answerCard());
   // Approved by this member on this card: the re-check passes (eve then runs the call).
   expect(await recheckOf(policy,crm())).toMatchObject({denied:false});
   // The same call asked as a FIRST request (no mark) finds a settled card and is denied, not re-asked.
   expect(await recheckOf(policy,crm(),false)).toMatchObject({denied:true});
   // Another member, another call or a changed input: denied.
   expect(await recheckOf(policy,crm('member-b'))).toMatchObject({denied:true});
   expect(await recheckOf(policy,{...crm(),callId:'different'})).toMatchObject({denied:true});
   expect(await recheckOf(policy,{...crm(),toolInput:{...twenty,note:'changed'}})).toMatchObject({denied:true});
   expect((await getPool().query("SELECT count(*)::int n FROM approval_asks")).rows[0].n).toBe(1);
  });
  it('a card that was denied, withdrawn or never approved never passes the re-check',async()=>{
   const policy=(c:any)=>catalogueApprovalRequest('track_add_item',c,()=>'user-approval');
   for(const outcome of ['cancelled','ignored'] as const){
    await getPool().query('DELETE FROM approval_asks');
    await raise();await settleExactInput('request-1',outcome);
    expect(await recheckOf(policy,crm()),outcome).toMatchObject({denied:true});
   }
  });
  it('the guard: an approved change runs only with its approval; without one it is refused',async()=>{
   await raise();
   await expect(guardCatalogueExecution(crm(),'track_add_item',twenty)).rejects.toThrow();
   await expect(guardCatalogueExecution(running(),'track_add_item',twenty)).rejects.toThrow(); // asked, not yet approved
   await catalogueApprovalResponse('track_add_item',answerCard());
   await expect(guardCatalogueExecution(crm(),'track_add_item',twenty)).rejects.toThrow(); // approved, but this run carries no approval
   await expect(guardCatalogueExecution(running(),'track_add_item',twenty)).resolves.toBeUndefined();
  });
  it('refuses the answer once the owner has lost the role',async()=>{
   await raise();
   await getPool().query("UPDATE users SET org_role='member' WHERE id='member-a'");
   await expect(catalogueApprovalResponse('track_add_item',answerCard())).rejects.toThrow();
  });
  it('refuses the execution once there is no designated owner',async()=>{
   await raise();
   await catalogueApprovalResponse('track_add_item',answerCard());
   vi.stubEnv('AGENT_OWNER_USER_ID','');
   try{await expect(assertApproval(running(),'track_add_item',twenty)).rejects.toThrow();}
   finally{vi.stubEnv('AGENT_OWNER_USER_ID','member-a');}
  });
 });
 it('gives an approval resume no reading rights',async()=>{
  await approved();
  await expect(guardCatalogueExecution(context('resolver'),'tracks_list',{})).rejects.toThrow();
  await expect(guardCatalogueExecution(context('resolver'),'gmail_read',{id:'x'})).rejects.toThrow();
  await expect(guardCatalogueExecution({...context('resolver'),callId:'another-call'},'deadline_dismiss',input)).rejects.toThrow();
 });
});
