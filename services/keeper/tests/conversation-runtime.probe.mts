// Real installed eve runtime, disposable PostgreSQL projection and local workflow world.
// No provider/gateway access: mockModel reports its actual session-pinned instructions.
import {mkdtempSync,cpSync,symlinkSync,writeFileSync,readFileSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {PostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import assert from 'node:assert/strict';
const run=promisify(execFile),repo=resolve('../..'),root=mkdtempSync(join(tmpdir(),'lares-conversation-proof-'));
let pg:any,db:Pool|undefined,server:ReturnType<typeof spawn>|undefined;
const incarnation='11111111-1111-4111-8111-111111111111',secret='disposable-control-secret-'.repeat(3);
try {
 cpSync(join(repo,'services/keeper/tests/fixtures/conversation-agent'),root,{recursive:true});
 symlinkSync(join(repo,'packages/board-evals/node_modules'),join(root,'node_modules'));
 mkdirSync(join(root,'definition'));const definition=JSON.parse(readFileSync(join(repo,'packages/agent-kit/templates/creative/definition.json'),'utf8'));
 writeFileSync(join(root,'definition/agent.json'),JSON.stringify({...definition,name:'example'}));writeFileSync(join(root,'definition/voice.md'),'');writeFileSync(join(root,'definition/duties.md'),'UNIQUE_OLD_DUTIES');writeFileSync(join(root,'control-secret'),secret);
 pg=await new PostgreSqlContainer('postgres:16-alpine').start();db=new Pool({connectionString:pg.getConnectionUri()});
 await db.query("CREATE TABLE agent_resources(name text PRIMARY KEY,ownership_token uuid,runtime_control_token uuid,pending boolean DEFAULT false,state text)");
 await db.query("INSERT INTO agent_resources VALUES('example',$1,$1,false,'ready')",[incarnation]);
 await db.query(readFileSync(join(repo,'services/box/sql/043_agent_conversations.sql'),'utf8'));
 const env={...process.env,DATABASE_URL:pg.getConnectionUri(),LARES_AGENT_NAME:'example',LARES_AGENT_INCARNATION:incarnation,LARES_DEFINITION_DIR:join(root,'definition'),LARES_RUNTIME_CONTROL_SECRET_FILE:join(root,'control-secret'),PROOF_WRITE_LOG:join(root,'writes'),NODE_ENV:'production'};
 const build=await run(join(repo,'packages/board-evals/node_modules/.bin/eve'),['build'],{cwd:root,env,maxBuffer:8*1024*1024});writeFileSync(join(root,'build.log'),build.stdout+build.stderr);
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as any).port;await new Promise<void>(r=>listener.close(()=>r()));
 server=spawn(join(repo,'packages/board-evals/node_modules/.bin/eve'),['start','--host','127.0.0.1','--port',String(port)],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 let logs='';server.stdout?.on('data',c=>logs+=c);server.stderr?.on('data',c=>logs+=c);
 const host=`http://127.0.0.1:${port}`;
 for(let i=0;i<100;i++){try{if((await fetch(host+'/eve/v1/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===99)throw new Error('Runtime did not start: '+logs);}
 const {Client}=await import(join(repo,'packages/board-evals/node_modules/eve/dist/src/client/index.js'));
 const client=new Client({host,auth:{basic:{username:'fixture',password:'disposable-fixture-only'}}});
 const chat=async(message:string)=>{
   const reply=await fetch(host+'/proof/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message})});assert.equal(reply.status,200);
   const {sessionId,startIndex}=await reply.json();let text='',started=false;const events=[];
   for await(const event of client.sessions.attach(sessionId).stream({startIndex,signal:AbortSignal.timeout(20000)})){events.push(event);if(event.type==='turn.started')started=true;if(event.type==='message.completed')text+=event.data.message;if(event.type==='session.waiting'&&started)break;}
   return {sessionId,text,events};
 };
 const addressed=await chat('show original chat duties');assert.match(addressed.text,/UNIQUE_OLD_DUTIES/);
 const one=await client.sessions.create({message:'show duties'});const first=await one.response.result();assert.match(first.message,/UNIQUE_OLD_DUTIES/);
 const id=one.session.state.sessionId;const projected=await db.query('SELECT * FROM agent_conversations');if(!projected.rows.length)console.error('Runtime logs:',logs);assert.equal(projected.rows.find(r=>r.session_id===id)?.session_id,id);assert.equal(projected.rows.find(r=>r.session_id===id)?.incarnation,incarnation);
 writeFileSync(join(root,'definition/duties.md'),'UNIQUE_NEW_DUTIES');
 writeFileSync(join(root,'definition/agent.json'),JSON.stringify({...definition,name:'example',model:'installation-writer'}));
 const same=await (await one.session.send('show duties again')).result();assert.match(same.message,/UNIQUE_OLD_DUTIES/);assert.doesNotMatch(same.message,/UNIQUE_NEW_DUTIES/);
 assert.match(same.message,/installation-brain/);assert.doesNotMatch(same.message,/installation-writer/);
 const sameAddress=await chat('still old chat duties');assert.equal(sameAddress.sessionId,addressed.sessionId);assert.match(sameAddress.text,/UNIQUE_OLD_DUTIES/);
 const endpoint=host+'/lares/runtime/conversations/reset';const body=JSON.stringify({sessionId:id,incarnation,confirm:true});
 assert.equal((await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body})).status,401);
 const headers={'content-type':'application/json',authorization:'Basic '+Buffer.from('keeper:'+secret).toString('base64')};
 assert.equal((await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({sessionId:id,incarnation:'22222222-2222-4222-8222-222222222222',confirm:true})})).status,409);
 await db.query('UPDATE agent_resources SET runtime_control_token=NULL');
 assert.equal((await fetch(endpoint,{method:'POST',headers,body})).status,409);
 await db.query('UPDATE agent_resources SET runtime_control_token=ownership_token,pending=true');
 assert.equal((await fetch(endpoint,{method:'POST',headers,body})).status,409);
 await db.query('UPDATE agent_resources SET pending=false');
 const reset=await fetch(endpoint,{method:'POST',headers,body});assert.equal(reset.status,200);assert.equal((await reset.json()).status,'reset');
 await assert.rejects(()=>one.session.send('old id must refuse'));
 const two=await client.sessions.create({message:'show fresh duties'});const second=await two.response.result();assert.match(second.message,/UNIQUE_NEW_DUTIES/);assert.notEqual(two.session.state.sessionId,id);
 // The fixture's provider (agent.ts:6) echoes the alias it was CONSTRUCTED with as the message's
 // first line, so anchoring to the start proves the turn was served by exactly the alias the
 // edited definition pinned — no turn is ever served by a model other than the one the definition
 // pinned. This replaces a `doesNotMatch(/compiled-fallback-must-not-run/)` check: eve 0.33 removed
 // the compiled fallback that string named, so that string exists nowhere any more and the old
 // assertion could never fail.
 assert.match(second.message,/^installation-writer\n/,'turn served by a model other than the one the definition pinned');
 const duplicate=await fetch(endpoint,{method:'POST',headers,body});assert.equal((await duplicate.json()).status,'no_active_session');
 const untouched=await (await two.session.send('still here')).result();assert.match(untouched.message,/UNIQUE_NEW_DUTIES/);
 const resetAddress=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({sessionId:addressed.sessionId,incarnation,confirm:true})});assert.equal((await resetAddress.json()).status,'reset');
 const newAddress=await chat('new chat duties');assert.notEqual(newAddress.sessionId,addressed.sessionId);assert.match(newAddress.text,/UNIQUE_NEW_DUTIES/);
 const parked=await client.sessions.create({message:'pending write'});const pending=await parked.response.result();assert.ok(pending.inputRequests.length>0);
 const cancelled=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({sessionId:parked.session.state.sessionId,incarnation,confirm:true})});assert.equal((await cancelled.json()).status,'reset');
 await assert.rejects(()=>parked.session.respond([{requestId:pending.inputRequests[0].requestId,optionId:'approve'}]),(error:any)=>error.code==='session_not_active');
 assert.equal(existsSync(join(root,'writes')),false);
 console.log('PASS: session-pinned direct provider aliases, new-session model edit, real eve hook projection, dedicated auth, runtime-control revocation and pending refusal, incarnation refusal, exact reset, old ID refusal, new session reads edited duties, delayed duplicate preserves new session, raw chat address releases and reads new duties, pending approval reset cannot execute write.');
} catch(e){console.error('Probe artifact:',root);throw e;}
finally {if(server&&!server.killed){server.kill('SIGTERM');await new Promise<void>(r=>server!.once('exit',()=>r()));}await db?.end();await pg?.stop();rmSync(root,{recursive:true,force:true});}
