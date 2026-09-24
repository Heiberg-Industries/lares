// Installed eve runtime + real PostgreSQL. Disposable fixture, mock model, no provider calls.
import {mkdtempSync,cpSync,symlinkSync,readFileSync,writeFileSync,rmSync,existsSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {createHmac} from 'node:crypto';
import {PostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import assert from 'node:assert/strict';
import {registerDoorActions} from '../lib/doors.js';
import {resetActions,runAction} from '../lib/actions.js';
const run=promisify(execFile),repo=resolve('../..'),root=mkdtempSync(join(tmpdir(),'lares-door-proof-'));
const incarnation='11111111-1111-4111-8111-111111111111',signing='disposable-signing-secret';
let pg:any,db:Pool|undefined,server:ReturnType<typeof spawn>|undefined,logs='';
const model=join(root,'model.log'),outbound=join(root,'outbound.log');
try {
 cpSync(join(repo,'services/keeper/tests/fixtures/door-agent'),root,{recursive:true});symlinkSync(join(repo,'packages/board-evals/node_modules'),join(root,'node_modules'));
 pg=await new PostgreSqlContainer('postgres:16-alpine').start();db=new Pool({connectionString:pg.getConnectionUri()});
 for(const f of ['039_agent_definitions.sql','042_agent_resources.sql','044_agent_door_connections.sql','045_agent_runtime_control.sql'])await db.query(readFileSync(join(repo,'services/box/sql',f),'utf8'));
 await db.query(`CREATE TABLE ratchet(agent text,capability text,action text,level text); CREATE TABLE approval_events(agent text,capability text,tool text,decision text,reason text,call_id text); CREATE UNIQUE INDEX approval_events_call_idx ON approval_events(call_id) WHERE call_id IS NOT NULL`);
 const definition={name:'example',role:'creative',doors:[{kind:'slack',enabled:true}]};
 await db.query("INSERT INTO agent_definitions(name,hash,definition,status)VALUES('example','hash',$1,'valid')",[JSON.stringify(definition)]);
 await db.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,applied_definition,pending)VALUES('example','172.29.0.10','example','owned',$1,$1,'ready',$2,false)",[incarnation,JSON.stringify(definition)]);
 await db.query("INSERT INTO agent_doors(agent,kind,enabled)VALUES('example','slack',true)");
 resetActions();registerDoorActions({pool:db,secretsDir:'/unused'});
 const {code}=await runAction('door.claim_issue',{name:'example',kind:'slack'},{actor:'owner@example.test',audit:async()=>{}}) as {code:string};
 const env={...process.env,DATABASE_URL:pg.getConnectionUri(),LARES_AGENT_NAME:'example',LARES_AGENT_INCARNATION:incarnation,PROOF_MODEL_LOG:model,PROOF_OUTBOUND_LOG:outbound,PROOF_WRITE_LOG:join(root,'writes'),PROOF_SIGNING_SECRET:signing,NODE_ENV:'production'};
 const built=await run(join(repo,'packages/board-evals/node_modules/.bin/eve'),['build'],{cwd:root,env,maxBuffer:8*1024*1024});writeFileSync(join(root,'build.log'),built.stdout+built.stderr);
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as any).port;await new Promise<void>(r=>listener.close(()=>r()));
 const host=`http://127.0.0.1:${port}`;
 async function start(extra:Record<string,string>={}) {
  server=spawn(join(repo,'packages/board-evals/node_modules/.bin/eve'),['start','--host','127.0.0.1','--port',String(port)],{cwd:root,env:{...env,...extra},stdio:['ignore','pipe','pipe']});server.stdout?.on('data',c=>logs+=c);server.stderr?.on('data',c=>logs+=c);
  for(let i=0;i<100;i++){try{if((await fetch(host+'/eve/v1/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Fixture did not start '+logs);
 }
 async function stop(){if(server&&!server.killed){server.kill('SIGTERM');await new Promise<void>(r=>server!.once('exit',()=>r()));}server=undefined;}
 let id=0;
 async function send(text:string,user='U_OWNER',valid=true) {
  const body=JSON.stringify({type:'event_callback',team_id:'T_FIXTURE',api_app_id:'A_FIXTURE',event_id:`Ev${++id}`,event:{type:'message',channel:'D_FIXTURE',channel_type:'im',user,text,ts:`${Date.now()/1000}`}});
  const ts=String(Math.floor(Date.now()/1000));const signature='v0='+createHmac('sha256',signing).update(`v0:${ts}:${body}`).digest('hex');
  const response=await fetch(host+'/eve/v1/slack',{method:'POST',headers:{'content-type':'application/json','x-slack-request-timestamp':ts,'x-slack-signature':valid?signature:'v0='+'0'.repeat(64)},body});
  await new Promise(r=>setTimeout(r,350));return response.status;
 }
 async function approvalCallback() {
  const payload={type:'block_actions',team:{id:'T_FIXTURE'},user:{id:'U_OWNER'},channel:{id:'D_FIXTURE'},message:{ts:'1.0'},actions:[{type:'button',action_id:'eve:input',value:'approve',action_ts:'1.1'}]};
  const body=new URLSearchParams({payload:JSON.stringify(payload)}).toString(),ts=String(Math.floor(Date.now()/1000));
  const signature='v0='+createHmac('sha256',signing).update(`v0:${ts}:${body}`).digest('hex');
  return (await fetch(host+'/eve/v1/slack',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-slack-request-timestamp':ts,'x-slack-signature':signature},body})).status;
 }
 await start();assert.equal(await send(`claim ${code}`,'U_ATTACKER',false),401);
 await send('ordinary before claim');await send('/claim WRONG');await send('claim WRONG');assert.equal(existsSync(model),false);
 await db.query("UPDATE agent_door_connections SET expires_at=now()-interval '1 second'");await send(`claim ${code}`);assert.equal((await db.query('SELECT principal FROM agent_door_connections')).rows[0].principal,null);
 await db.query("UPDATE agent_door_connections SET expires_at=now()+interval '10 minutes'");await send(`claim ${code}`);
 const c=(await db.query('SELECT * FROM agent_door_connections')).rows[0];assert.equal(c.principal,'U_OWNER');assert.equal(existsSync(model),false);assert.equal(existsSync(outbound),false);
 assert.equal(await send('before explicit apply'),401);assert.equal(await approvalCallback(),401);assert.equal(await send(`claim ${code}`,'U_ATTACKER'),401);
 await stop();await db.query('UPDATE agent_door_connections SET applied_revision=revision');await db.query('UPDATE agent_resources SET pending=false');
 await start({LARES_SLACK_PRINCIPAL:'U_OWNER',LARES_SLACK_CLAIM_REVISION:c.revision});
 await send('wrong owner','U_LEGACY');assert.equal(existsSync(model),false);
 await send('accepted owner');for(let i=0;i<100&&!existsSync(model);i++)await new Promise(r=>setTimeout(r,100));
 assert.equal(existsSync(model),true,logs);const history=readFileSync(model,'utf8');assert.ok(history.includes('accepted owner'));assert.ok(!history.includes(code));assert.ok(!history.includes('wrong owner'));const tokenAttempts=existsSync(outbound)?readFileSync(outbound,'utf8'):'';
 const {Client}=await import(join(repo,'packages/board-evals/node_modules/eve/dist/src/client/index.js'));
 const client=new Client({host,auth:{basic:{username:'fixture',password:'disposable-fixture-only'}}});
 // A neutral image must consult the installed agent's board, never its compiled role name.
 await db.query("INSERT INTO ratchet(agent,capability,action,level) VALUES('example','gmail','','never'),('creative','gmail','','autonomous')");
 const refused=await client.sessions.create({message:'pending write'});const refusal=await refused.response.result();
 assert.equal(refusal.inputRequests.length,0,'Managed board denial became an approval card');
 assert.equal(existsSync(join(root,'writes')),false,'Managed board denial executed a write');
 assert.equal((await db.query("SELECT count(*)::int AS n FROM approval_events WHERE agent='example' AND tool='gmail_send' AND decision='denied'")).rows[0].n,1,'Denial not attributed to managed instance');
 assert.equal((await db.query("SELECT count(*)::int AS n FROM approval_events WHERE agent='creative'")).rows[0].n,0,'Neutral role received instance audit evidence');
 await db.query("DELETE FROM ratchet WHERE agent IN ('example','creative')");
 // Restart clears the documented 30-second policy cache before the existing approval cases.
 await stop();await start({LARES_SLACK_PRINCIPAL:'U_OWNER',LARES_SLACK_CLAIM_REVISION:c.revision});
 const control=await client.sessions.create({message:'pending write'});const controlPending=await control.response.result();assert.ok(controlPending.inputRequests.length>0);
 const approved=await control.session.respond([{requestId:controlPending.inputRequests[0].requestId,optionId:'approve'}]);await approved.result();
 assert.equal(existsSync(join(root,'writes')),true,'Current approved control did not execute');unlinkSync(join(root,'writes'));
 const parked=await client.sessions.create({message:'pending write'});const pending=await parked.response.result();assert.ok(pending.inputRequests.length>0);
 await db.query('UPDATE agent_resources SET pending=true');
 const resumed=await parked.session.respond([{requestId:pending.inputRequests[0].requestId,optionId:'approve'}]);await resumed.result();
 assert.equal(existsSync(join(root,'writes')),false,'Stale HTTP approval executed a write');
 await db.query('UPDATE agent_resources SET pending=false');
 await db.query('UPDATE agent_doors SET enabled=false');assert.equal(await send('disabled owner'),401);assert.equal(await approvalCallback(),401);assert.equal(existsSync(outbound)?readFileSync(outbound,'utf8'):'',tokenAttempts);
 console.log('PASS: neutral compiled manifest uses managed instance board denial and audit attribution; installed eve verifies signature before one-use claim; invalid/expired/replayed/pre-apply/wrong-owner/disabled rejected; native Slack form callback rejected by verifier while pending/disabled; current approved control executes; parked approval resumed through HTTP after pending change causes zero side effects; accepted owner reaches mock model only after apply; claim codes absent from model history; claim processing never resolves credentials; disabled ingress adds no credential calls; guarded fake token refuses before any outbound API call.');
 await stop();
} catch(e){console.error('Runtime logs:',logs);throw e;}
finally{if(server&&!server.killed){server.kill('SIGTERM');await new Promise<void>(r=>server!.once('exit',()=>r()));}await db?.end();await pg?.stop();rmSync(root,{recursive:true,force:true});}
