/** Offline acceptance: compile/start actual role sources and use the real console proxy.
 * Only the model and Gmail API are fake. A preload maps fixed container secret paths to
 * disposable files; all grant, session, generation, custody and model guards stay real.
 * Use PRIVATE_CHAT_PROOF_ROLE=chief-of-staff or creative for a serial subset.
 * PRIVATE_CHAT_PROOF_BUDGET=1 adds inactive preparation/cold-replay proof to chief/Anthropic + SEND.
 * Run: pnpm -C packages/board-evals exec tsx scripts/member-private-chat-proof.mjs
 */
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,symlinkSync,writeFileSync,readFileSync,readdirSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,createCipheriv,randomBytes,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {PostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {PgGrantStore} from '@lares/agent-kit/grant-store';
import {PgMemberStore} from '@lares/agent-kit/member-store';
import {budgetIdentitySuppression} from '@lares/agent-kit/budget-admission-store';
import {requireConsoleTurnAuthority} from '@lares/agent-kit/console-turn-authority';
import {requirePrivateConsoleResume} from '@lares/agent-kit/private-console-resume';
import {PgAccountStore} from '@lares/agent-kit/account-store';
import {loadDefinition} from '@lares/agent-kit/definition';
import {forwardChat} from '../../../services/console/lib/chat-proxy.ts';
import {run} from './proof-harness.mjs';
import {compactionHookSource,gatewayModelSource,startGatewayFixture} from './gateway-invocation-fixture.mjs';
const repo=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const root=mkdtempSync(join(tmpdir(),'lares-member-chat-proof-'));
const password='disposable-fixture-only',incarnation='11111111-1111-4111-8111-111111111111';
const key='1'.repeat(64),owner='proof-owner',a='Member-A',b='member-a',outsider='ungranted-member';
const canaries={owner:'OWNER_PRIVATE_CANARY',a:'MEMBER_A_INPUT_CANARY',b:'MEMBER_B_INPUT_CANARY'};
let container,db,child,logs='',port;
const withSend=process.env.PRIVATE_CHAT_PROOF_SEND==='1';
const gatewayLane=process.env.PRIVATE_CHAT_PROOF_GATEWAY_LANE;
const withBudget=process.env.PRIVATE_CHAT_PROOF_BUDGET==='1';
if(withBudget)assert.ok(gatewayLane==='anthropic'&&process.env.PRIVATE_CHAT_PROOF_ROLE==='chief-of-staff'&&withSend,'Durable proof uses the bounded chief/Anthropic approval fixture');
let gateway;
const observedSteps=new Set();
const snapshots=[],ownedSessionIds=new Set();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise(done=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>done(p));});});
function encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]).toString('base64');}
function hashOutput(path){const h=createHash('sha256');for(const file of readdirSync(join(path,'.output'),{recursive:true,withFileTypes:true}).filter(d=>d.isFile()).map(d=>join(d.parentPath,d.name)).sort()){h.update(relative(path,file));h.update(readFileSync(file));}return h.digest('hex');}
function modelSource(role){const source = `
import {mockModel} from 'eve/evals';
import {appendFileSync} from 'node:fs';
${role==='chief-of-staff'?`import {mountedPersonalSendRuntime} from './personal-send.js';
mountedPersonalSendRuntime.open=async()=>({adapter:{send:async()=>{appendFileSync(process.env.PROOF_PROVIDER_LOG,'SEND_ACCEPTED\\n');return {state:'accepted',providerReceiptId:'synthetic-message'};}}});
import {__setTestGmailApiFactory} from './google.js';
__setTestGmailApiFactory((_config,token)=>{
  const member=token==='refresh-Member-A'?'MEMBER_A_MAIL_CANARY':token==='refresh-member-a'?'MEMBER_B_MAIL_CANARY':null;
  if(!member)throw new Error('Unknown synthetic credential');
  return {users:{messages:{list:async()=>{appendFileSync(process.env.PROOF_PROVIDER_LOG,member+'\\n');return {data:{messages:[{id:'proof-message'}]}};},get:async()=>{appendFileSync(process.env.PROOF_PROVIDER_LOG,member+'\\n');return {data:{id:'proof-message',payload:{mimeType:'text/plain',headers:[],body:{data:Buffer.from(member).toString('base64url')}}}};}}}} as never;
});`:''}
const attacked=new Set<string>();
const scripted=mockModel(({lastUserMessage,messages,tools,toolResults})=>{
  appendFileSync(process.env.PROOF_MODEL_LOG,JSON.stringify({message:lastUserMessage,messages,tools,toolResults})+'\\n');
  const lastHuman=messages.findLastIndex(message=>message.role==='user'&&message.text===lastUserMessage);
  const currentResults=messages.slice(lastHuman+1).some(message=>message.role==='tool');
  if(lastUserMessage?.startsWith('SEND ')&&!currentResults)return {toolCalls:[{name:'personal_mailbox_send',input:JSON.parse(lastUserMessage.slice(5))}]};
  if(lastUserMessage?.startsWith('SEND_ATTACK ')&&!currentResults)return {toolCalls:[{name:'personal_mailbox_send',input:JSON.parse(lastUserMessage.slice(12))}]};
  if(lastUserMessage?.startsWith('SEND_ATTACK ')&&currentResults&&!attacked.has(lastUserMessage)){attacked.add(lastUserMessage);const input=JSON.parse(lastUserMessage.slice(12));return {toolCalls:[{name:'personal_mailbox_send',input},{name:'personal_mailbox_read',input:{selection:input.selection,id:'proof-message'}}]};}
  if(lastUserMessage?.startsWith('MAIL ')&&!toolResults.length)return {toolCalls:[{name:'gmail_read',input:{id:'proof-message',selection:JSON.parse(lastUserMessage.slice(5))}}]};
  if(lastUserMessage?.startsWith('SKILL ')&&!toolResults.length)return {toolCalls:[{name:'load_skill',input:{skill:lastUserMessage.slice(6)}}]};
  if(lastUserMessage==='question')return 'Which topic would you like to discuss?';
  return 'ANSWER '+lastUserMessage+' '+JSON.stringify(toolResults);
});
export const gatewayModel=(_alias:string)=>scripted;
export const gatewayUrl=()=>{throw new Error('No live gateway in proof');};
export const gatewayKey=()=>{throw new Error('No live gateway in proof');};
export const IDENTITY_ENCODING_HEADERS={'Accept-Encoding':'identity'};
`;return gatewayLane?gatewayModelSource(source):source;}
async function stop(){if(!child)return;const process=child;child=undefined;if(process.exitCode!==null||process.signalCode!==null)return;try{globalThis.process.kill(-process.pid,'SIGKILL');}catch{try{process.kill('SIGKILL');}catch{}}await new Promise(resolve=>process.once('close',resolve));}
async function start(app){port=await freePort();child=spawn(app.eve,['start','--host','127.0.0.1','--port',String(port)],{cwd:app.cwd,env:app.env,detached:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>{logs+=d;});child.stderr.on('data',d=>{logs+=d;});for(let i=0;i<600;i++){if(child.exitCode!==null)throw new Error('Role exited: '+logs.slice(-4000));try{if((await fetch(`http://127.0.0.1:${port}/eve/v1/health`)).ok)return;}catch{}await sleep(100);}throw new Error('Role did not become healthy within60s (pid='+child.pid+', exit='+child.exitCode+', signal='+child.signalCode+'): '+logs.slice(-4000));}
async function makeRole(role){
 logs='';
 const cwd=join(root,'services',role);mkdirSync(join(root,'services'),{recursive:true});
 cpSync(join(repo,'services',role),cwd,{recursive:true,filter:path=>!['node_modules','.output','.eve','tests'].includes(basename(path))});
 symlinkSync(join(repo,'services',role,'node_modules'),join(cwd,'node_modules'));
 const definition=join(root,role+'-definition');mkdirSync(definition);
 const declaration={...JSON.parse(readFileSync(join(cwd,'agent.json'),'utf8')),name:'proof-'+(role==='creative'?'creative':'chief'),model:'fixture-brain',role,display:'Proof agent',grants:role==='creative'?[]:[{capability:'gmail',scope:'read'},...(withSend?[{capability:'personal_mailbox',scope:'write-with-confirm'}]:[])],autonomy:role==='creative'?{}:{gmail:'autonomous',...(withSend?{personal_mailbox:'autonomous'}:{})},skills:[]};
 writeFileSync(join(definition,'agent.json'),JSON.stringify(declaration));writeFileSync(join(definition,'voice.md'),canaries.owner);writeFileSync(join(definition,'duties.md'),canaries.owner);
 const modelLog=join(root,role+'-model.jsonl'),providerLog=join(root,role+'-provider.log');writeFileSync(modelLog,'');writeFileSync(providerLog,'');
 if(gatewayLane){gateway.setRole(role);writeFileSync(modelLog+'.scope','');writeFileSync(modelLog+'.compaction','');if(withBudget)writeFileSync(modelLog+'.budget','');
   const hook=join(cwd,'agent/hooks/model-invocation.ts');writeFileSync(hook,compactionHookSource(readFileSync(hook,'utf8')));
 }
 writeFileSync(join(cwd,'lib/gateway-provider.ts'),modelSource(role));
 const inherited=Object.fromEntries(['PATH','HOME','TMPDIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 const env={...inherited,EVE_TELEMETRY_DISABLED:'1',NODE_ENV:'production',EVE_SCHEDULES_LIVE:'0',EGRESS_PROXY_URL:'http://synthetic-proxy.invalid:8888',LARES_AGENT_NAME:declaration.name,LARES_AGENT_INCARNATION:incarnation,AGENT_OWNER_USER_ID:owner,OWNER_HOME_TZ:'UTC',LARES_DEFINITION_DIR:definition,EVE_ROUTE_PASSWORD_FILE:join(root,'password'),PROOF_MODEL_LOG:modelLog,PROOF_PROVIDER_LOG:providerLog,VAULT_PATH:join(root,'vault'),TOKEN_ENC_KEY_FILE:'/run/secrets/google-token-key',LARES_PERSONAL_GOOGLE_CLIENTS:JSON.stringify({proof:{clientIdFile:'/run/secrets/personal-google-proof-id',clientSecretFile:'/run/secrets/personal-google-proof-secret'}}),NODE_OPTIONS:`--import=${join(root,'mounts.mjs')}`};
 const eve=join(cwd,'node_modules/.bin/eve');
 console.log(role+': building actual role with synthetic provider');
 await run(eve,['build'],{cwd,env,timeout:300000});
 env.DATABASE_URL=container.getConnectionUri();
 const workflowName=role==='creative'?'proof_creative_workflow':'proof_chief_workflow';
 await db.query(`CREATE DATABASE ${workflowName}`);const workflowUrl=new URL(container.getConnectionUri());workflowUrl.pathname='/'+workflowName;env.WORKFLOW_POSTGRES_URL=workflowUrl.href;
 if(gatewayLane)Object.assign(env,{GATEWAY_LANE:gatewayLane,GATEWAY_URL:gateway.url,PROOF_GATEWAY_KEY:join(root,'gateway-key'),PROOF_COMPACTION_LOG:modelLog+'.compaction'});
 if(withBudget)env.PROOF_BUDGET='1';
 const workflowDb=new Pool({connectionString:workflowUrl.href});try{await workflowDb.query(readFileSync(join(repo,'services',role,'sql/001-eve-workflow.sql'),'utf8'));}finally{await workflowDb.end();}
 const loaded=await loadDefinition({serviceDir:cwd,env});
 const address=role==='creative'?'10.0.0.8':'10.0.0.7';
 await db.query('INSERT INTO agent_definitions(name,definition,hash,status,duties,voice) VALUES($1,$2,$3,\'valid\',$4,$4)',[declaration.name,declaration,loaded.hash,canaries.owner]);
 await db.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending,applied_definition) VALUES($1,$5,$2,'owned',$3,$3,'ready',false,$4)",[declaration.name,workflowName,incarnation,declaration,address]);
 const grants=new PgGrantStore(db);const access=await grants.adoptAgent(owner,{agentName:declaration.name,expectedDefinitionHash:loaded.hash},{designatedOwnerMemberId:owner});
 await grants.updateAgentAccess(owner,{agentName:declaration.name,expectedRevision:access.accessRevision,grants:[a,b].map(id=>({principal:{kind:'member',id},permission:'use',expiresAt:null}))});
 const app={cwd,env,eve,name:declaration.name,address,modelLog,providerLog,grants};
 if(withBudget)await provisionBudgetFixture(app);
 return app;
}
let upstreamCalls=0;const members=new Map();
function request(app,member,method,path,body,cookie=''){
 const deps={query:(sql,values)=>db.query(sql,values),connect:()=>db.connect(),routePassword:()=>password,signedInMember:()=>new PgMemberStore(db).sessionMember(members.get(member)),fetch:async(url,options)=>{assert.ok(String(url).startsWith(`http://${app.address}:3000/`));assert.equal(new Headers(options.headers).get('x-lares-member'),null);upstreamCalls++;return fetch(`http://127.0.0.1:${port}/`+String(url).split(':3000/')[1],options);}};
 return forwardChat(new Request(`https://console.example.invalid/api/chat/${app.name}/${path}`,{method,headers:{'content-type':'application/json',cookie},...(body===undefined?{}:{body:JSON.stringify(body)})}),app.name,path.split('?')[0],deps);
}
async function create(app,member,message,operationId){const response=await request(app,member,'POST','eve/v1/session',{message,...(operationId?{operationId}:{})});assert.ok(response.ok,`create ${member}: ${response.status} ${await response.clone().text()}`);const id=response.headers.get('x-eve-session-id');assert.ok(id);ownedSessionIds.add(id);return {id,cookie:response.headers.get('set-cookie')?.split(';')[0]??'',index:0};}
const terminal=new Set(['session.completed','session.failed','session.waiting']);
async function stream(app,member,session){const lines=[];for(let retry=0;retry<80;retry++){
 const response=await request(app,member,'GET',`eve/v1/session/${session.id}/stream?streamControlVersion=1&startIndex=${session.index}&includeTailIndex=1`,undefined,session.cookie);
 if(!response.ok){if([404,409,425,500,502,503,504].includes(response.status)){await sleep(100);continue;}throw new Error('stream '+response.status+' '+await response.text());}
 const raw=await response.text();for(const line of raw.split('\n').filter(Boolean)){const event=JSON.parse(line);lines.push(line);session.index++;if(event.type==='step.started')observedSteps.add(JSON.stringify([session.id,event.data.turnId,event.data.sequence,event.data.stepIndex]));if(terminal.has(event.type)){assert.notEqual(event.type,'session.failed',raw);return lines.join('\n');}}
 await sleep(100);
 }throw new Error('Turn never completed '+logs.slice(-1800));}
async function send(app,member,session,message){const response=await request(app,member,'POST',`eve/v1/session/${session.id}`,{message},session.cookie);assert.ok(response.ok,'continue '+response.status+' '+await response.clone().text());return stream(app,member,session);}
const models=app=>readFileSync(app.modelLog,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
async function denyOld(app,member,session){const budgetBefore=withBudget?(await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n:null;const before=models(app).length,providers=readFileSync(app.providerLog,'utf8');for(const [method,path,body]of [['POST',`eve/v1/session/${session.id}`,{message:'reuse old private context'}],['GET',`eve/v1/session/${session.id}/stream`,undefined],['POST',`eve/v1/session/${session.id}/compact`,{}]]){const response=await request(app,member,method,path,body,session.cookie);assert.equal(response.ok,false,`${path} revived`);}await sleep(100);assert.equal(models(app).length,before);assert.equal(readFileSync(app.providerLog,'utf8'),providers);if(withBudget)assert.equal((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n,budgetBefore);}
// Synthetic request/profile/endpoint fixtures exercise preparation only. This is not
// production wire-request correlation, gateway admission, provider usage or settlement.
async function provisionBudgetFixture(app){
 const installation=randomUUID(),endpoint='e'.repeat(64),profile='f'.repeat(64);
 await db.query("UPDATE org_member_policy SET spend_cap_usd_month=1 WHERE user_id=ANY($1)",[[a,b]]);
 await db.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,installation_cap,selected_endpoint,recovery_epoch) VALUES($1,'proof-installation','installation',$1,1,$2,'proof-epoch')",[installation,endpoint]);
 async function open(account,member){
  const window=randomUUID();await db.query("INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision) VALUES($1,$2,$3,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 day',0,1,0)",[window,account,member]);
  await db.query("UPDATE budget_accounts SET active_window_id=$2,state='open',reason='approved' WHERE id=$1",[account,window]);
 }
 await open(installation,null);
 for(const member of [a,b]){
  const id=randomUUID(),suppression=budgetIdentitySuppression(Buffer.alloc(32,1),{canonicalMemberId:member,providers:[{issuer:'https://identity.example.invalid',subject:member,tenantId:''}]});
  await db.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,live_member_id,organisation_id,canonical_suppression_hash,provider_suppression_hashes) VALUES($1,'proof-installation','member',$2,$3,'proof-org',$4,$5)",[id,installation,member,suppression.canonicalSuppressionHash,suppression.providerSuppressionHashes]);
  await open(id,member);
  await db.query("INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,purpose_alias,profile_hash,maximum_liability,state) VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,'fixture-brain',$9,0.001,'active')",[randomUUID(),installation,id,member,endpoint,'d'.repeat(64),app.name,incarnation,profile]);
 }
}
async function proveDurableBudget(app){
 const scopes=readFileSync(app.modelLog+'.scope','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 const receipts=readFileSync(app.modelLog+'.budget','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 const rows=async()=>(await db.query('SELECT id,invocation_hash FROM budget_attempts ORDER BY id')).rows;
 const before=await rows();assert.equal(before.length,scopes.length);assert.equal(receipts.length,scopes.length);
 assert.equal(new Set(before.map(row=>row.invocation_hash)).size,before.length);assert.deepEqual(new Set(receipts.map(row=>row.id)),new Set(before.map(row=>row.id)));
 const selected=[scopes.find(s=>s.session.auth.current.attributes.lares_purpose==='human'),...['approve','cancel'].map(option=>scopes.find(s=>s.event.data.turnId===''&&s.session.auth.current.attributes.lares_resume_option===option))];
 assert.ok(selected.every(Boolean),'Missing actual human or exact blank approval/cancel invocation');
 const code=`import {Pool} from 'pg';
 import {PgBudgetAdmissionStore} from '${new URL('../../../packages/agent-kit/src/budget-admission-store.ts',import.meta.url).href}';
 import {captureModelInvocation,runModelInvocation} from '${new URL('../../../packages/agent-kit/src/model-invocation.ts',import.meta.url).href}';
 const f=JSON.parse(process.env.BUDGET_PROOF_FIXTURE),pool=new Pool({connectionString:f.databaseUrl});
 try{const invocation=captureModelInvocation(f.scope.event,f.scope.session,f.scope.alias);let denied=false;
  try{await runModelInvocation(invocation,()=>new PgBudgetAdmissionStore(pool,f.env).prepareIntent(f.request));}catch{denied=true;}
  process.stdout.write(JSON.stringify({denied}));
 }finally{await pool.end();}`;
 for(const scope of selected){
  const ctx={session:{...scope.session,turn:{id:scope.event.data.turnId,sequence:scope.event.data.sequence}}};
  // Confirm fresh authority independently while it is still valid, before revocation tests.
  if(scope.session.auth.current.attributes.lares_purpose==='resolver')await requirePrivateConsoleResume(ctx,'model',{db,env:app.env});else await requireConsoleTurnAuthority(ctx,db,app.env);
  const binding=(await db.query("SELECT id,profile_hash FROM budget_gateway_bindings WHERE agent=$1 AND live_member_id=$2 AND state='active'",[app.name,scope.session.auth.initiator.attributes.lares_member_id])).rows[0];
  const fixture={databaseUrl:container.getConnectionUri(),scope,env:{LARES_AGENT_NAME:app.name,LARES_AGENT_INCARNATION:incarnation,AGENT_OWNER_USER_ID:owner},request:{bindingId:binding.id,profileHash:binding.profile_hash,requestHash:'b'.repeat(64)}};
  const result=await run(process.execPath,['--import',join(repo,'services/box/node_modules/tsx/dist/loader.mjs'),'--input-type=module','--eval',code],{cwd:join(repo,'services/box'),env:{...process.env,BUDGET_PROOF_FIXTURE:JSON.stringify(fixture)},timeout:15000});
  assert.deepEqual(JSON.parse(result.stdout),{denied:true});
 }
 assert.deepEqual(await rows(),before,'Cold reconstruction changed retained invocation hashes or attempt count');
 console.log(app.name+': actual human and blank approve/cancel preparation, unchanged hashes/count after valid-authority cold replay PASS (preparation only)');
}
function assertGatewayScopes(app){
  gateway.assertHealthy();
  const scopes=()=>readFileSync(app.modelLog+'.scope','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  for(const scope of scopes()){
    assert.equal(scope.alias,'fixture-brain');assert.equal(scope.event.type,'step.started');
    assert.ok(observedSteps.has(JSON.stringify([scope.session.id,scope.event.data.turnId,scope.event.data.sequence,scope.event.data.stepIndex])),'Scope did not capture actual emitted coordinates');
    assert.equal(scope.session.auth.initiator.attributes.lares_purpose,'human');
    assert.ok(['human','resolver'].includes(scope.session.auth.current.attributes.lares_purpose));
  }
  if(app.name==='proof-chief'&&withSend)for(const option of ['approve','cancel'])assert.ok(scopes().some(s=>s.session.auth.current.attributes.lares_purpose==='resolver'&&s.session.auth.current.attributes.lares_resume_option===option&&s.event.data.turnId===''),'Exact '+option+' resume did not preserve actual blank turn and resolver auth');
  assert.equal(scopes().length,gateway.calls.filter(c=>c.role===app.name.replace(/^proof-/, '').replace(/^chief$/, 'chief-of-staff')).length,'Scoped model calls and actual HTTP requests differ');
}
async function proveGatewayInvocation(app){
  assertGatewayScopes(app);
  const manual=await create(app,a,'Before manual compaction');await stream(app,a,manual);
  const beforeManual=gateway.calls.length,manualLogOffset=logs.length;
  const response=await request(app,a,'POST',`eve/v1/session/${manual.id}/compact`,{},manual.cookie);assert.ok(response.ok);
  await stream(app,a,manual);await sleep(50);assert.equal(gateway.calls.length,beforeManual,'Manual compaction dispatched HTTP');
  const manualLogs=logs.slice(manualLogOffset);
  assert.ok(manualLogs.includes('manual session compaction failed'),'Manual compaction did not report its failure');
  const manualCause=manualLogs.includes('Model compaction requires a fresh trusted invocation')?'authored-hook':manualLogs.includes('Dynamic model selection is required before model-dependent work begins')?'no-current-model-selection':null;
  assert.ok(manualCause,'Manual compaction failed outside the proven refusal paths');
  console.log(app.name+': manual compaction zero HTTP; exact cause '+manualCause+(manualCause==='no-current-model-selection'?' (before authored hook)':''));
  for(const failure of ['TRANSIENT_ERROR','STREAM_TRANSIENT_ERROR','EMPTY_RESPONSE','UNSUPPORTED_TOOL']){
    const logOffset=logs.length;
    const before=gateway.calls.length,attempt=await create(app,a,failure);
    const transcript=await stream(app,a,attempt).catch(error=>String(error));
    await sleep(200);assert.equal(gateway.calls.length,before+1,failure+' dispatched duplicate HTTP');
    assert.ok(transcript.includes('failed')||transcript.includes('error')||transcript.includes('fresh trusted'),failure+' did not visibly fail');
    const recovery={STREAM_TRANSIENT_ERROR:'model call failed transiently',EMPTY_RESPONSE:'empty model response; reissuing',UNSUPPORTED_TOOL:'disabling unsupported provider tool(s)'}[failure];
    if(recovery)assert.ok(logs.slice(logOffset).includes(recovery),failure+' did not exercise actual Eve recovery');
  }
  const long=await create(app,a,'Before automatic compaction');await stream(app,a,long);
  let denied=false;
  for(let i=0;i<6;i++){
    const before=gateway.calls.length;
    const receiptOffset=readFileSync(app.modelLog+'.compaction','utf8').length;
    const transcript=await send(app,a,long,'LONG '+String(i)+' '+('x'.repeat(240000))).catch(error=>String(error));
    if(gateway.calls.length===before){
      const receipts=readFileSync(app.modelLog+'.compaction','utf8').slice(receiptOffset).trim().split('\n').filter(Boolean).map(JSON.parse);
      assert.ok(receipts.length>0,'Automatic refusal did not reach awaited compaction hook');
      assert.ok(receipts.every(r=>r.sessionId===long.id&&r.event.type==='compaction.requested'&&r.error==='Model compaction requires a fresh trusted invocation'),'Compaction receipt did not identify this actual attempt and exact refusal');
      assert.ok(transcript.includes('session.failed'),'Authored compaction refusal did not terminally stop the workflow');
      denied=true;break;
    }
    assert.equal(gateway.calls.length,before+1,'Long turn dispatched duplicate HTTP');
  }
  assert.ok(denied,'Automatic compaction scenario never reached its awaited refusal hook');
  assertGatewayScopes(app);console.log(app.name+': '+gatewayLane+' actual event/session scopes, cold fresh turn, exact resume, retry/recovery single dispatch and manual/automatic compaction zero HTTP PASS (no durable crash-replay claim)');
}
try{
 mkdirSync(join(root,'packages'),{recursive:true});symlinkSync(join(repo,'packages/agent-kit'),join(root,'packages/agent-kit'));symlinkSync(join(repo,'node_modules'),join(root,'node_modules'));mkdirSync(join(root,'vault'));writeFileSync(join(root,'vault/owner.md'),canaries.owner);writeFileSync(join(root,'password'),password);
 for(const [name,value]of [['google-token-key',key],['personal-google-proof-id','fixture-client'],['personal-google-proof-secret','fixture-secret']])writeFileSync(join(root,name),value);
 writeFileSync(join(root,'mounts.mjs'),`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const read=fs.readFileSync;const allowed=new Set(['google-token-key','personal-google-proof-id','personal-google-proof-secret']);fs.readFileSync=function(path,...args){if(typeof path==='string'&&path.startsWith('/run/secrets/')&&allowed.has(path.slice(13)))return read(${JSON.stringify(root)}+'/'+path.slice(13),...args);return read(path,...args);};syncBuiltinESMExports();`);
 if(gatewayLane){writeFileSync(join(root,'gateway-key'),'fixture-gateway-key');gateway=await startGatewayFixture(root,gatewayLane);}
 container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();db=new Pool({connectionString:container.getConnectionUri()});
 for(const name of readdirSync(join(repo,'services/box/sql')).filter(n=>/^\d{3}.*sql$/.test(n)).sort())await db.query(readFileSync(join(repo,'services/box/sql',name),'utf8'));
 await db.query("INSERT INTO orgs(id,display_name) VALUES('proof-org','Proof')");
 await db.query("INSERT INTO users(id,display_name,org_id,org_role) VALUES($1,'Owner','proof-org','owner'),($2,'A','proof-org','member'),($3,'B','proof-org','member'),($4,'Ungrant','proof-org','member')",[owner,a,b,outsider]);
 await db.query('INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES($1,NULL)',[owner]);
 const memberStore=new PgMemberStore(db);for(const id of [a,b])await db.query('INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES($1,NULL)',[id]);
 for(const id of [owner,a,b,outsider]){await db.query('INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES($1,\'https://identity.example.invalid\',$1,\'\')',[id]);const session=await memberStore.createSession({identity:{issuer:'https://identity.example.invalid',subject:id},verifiedAt:new Date()},new Date(Date.now()+3600000));members.set(id,session.token);}
 const accounts=new PgAccountStore(db);const selections=new Map();const adapter=accounts.forTrustedAdapter({connectorId:'google',verifyAccount:async evidence=>({issuer:'https://accounts.google.com',subject:evidence,label:'Personal mailbox'}),verifyResource:async(account)=>({resourceKind:'mailbox',externalId:account.providerAccount.subject,providerLabel:'Inbox'})});
 for(const id of [a,b]){const account=await adapter.createPersonalAccount(id,id,{persist:async client=>{const result=await client.query("INSERT INTO oauth_tokens(principal,provider,org_id,email_address,scopes,refresh_token_enc) VALUES($1,'google','proof','proof@example.invalid',ARRAY['openid','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/calendar.readonly','https://www.googleapis.com/auth/gmail.send'],$2) RETURNING id",[id,encrypt('refresh-'+id)]);return result.rows[0].id;}},['mailbox']);const [resource]=await accounts.listResources(id,account.id,account.generation);selections.set(id,{accountId:account.id,generation:account.generation,resourceBindingId:resource.id});}
 for(const role of (process.env.PRIVATE_CHAT_PROOF_ROLE?[process.env.PRIVATE_CHAT_PROOF_ROLE]:['chief-of-staff','creative'])){
  assert.ok(['chief-of-staff','creative'].includes(role),'Unknown proof role');
  const app=await makeRole(role);await start(app);const outputHash=hashOutput(app.cwd);
  const malformed=[{message:[{type:'text',text:'not plain text'}]},{message:'bad',clientContext:['injected']},{message:'bad',callback:{url:'https://example.invalid'}},{message:'bad',capabilities:{tools:true}}];
  for(const body of malformed){
   const response=await fetch(`http://127.0.0.1:${port}/eve/v1/session`,{method:'POST',headers:{authorization:'Basic '+Buffer.from('eve:'+password).toString('base64'),'content-type':'application/json','x-lares-member-id':a,'x-lares-admission':'m'.repeat(43),'x-lares-purpose':'human'},body:JSON.stringify(body)});
   assert.ok(!response.ok,'Actual role admitted forbidden private envelope');
  }
  assert.equal(models(app).length,0);if(withBudget)assert.equal((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM console_session_bindings WHERE agent=$1',[app.name])).rows[0].n,0);
  console.log(role+': actual compiled channel refused malformed/forbidden envelopes before dispatch');
  let sendProof;
  const sa=await create(app,a,canaries.a,'same-operation'),sb=await create(app,b,canaries.b,'same-operation');assert.notEqual(sa.id,sb.id,'operationId crossed members');console.log(role+': first-message creates accepted; same operationId isolated by member');
  const ra=await stream(app,a,sa),rb=await stream(app,b,sb);assert.ok(ra.includes(canaries.a));assert.ok(rb.includes(canaries.b));assert.ok(!ra.includes(canaries.b)&&!rb.includes(canaries.a));
  const before=upstreamCalls;assert.equal((await request(app,b,'GET',`eve/v1/session/${sa.id}/stream`,undefined,sa.cookie)).ok,false);assert.equal((await request(app,outsider,'POST','eve/v1/session',{message:'no grant'})).ok,false);assert.equal((await request(app,a,'GET','eve/v1/info')).status,404);assert.equal(upstreamCalls,before);
  const crossControl=await request(app,b,'POST',`eve/v1/session/${sa.id}/cancel`,{},sa.cookie);assert.equal(crossControl.ok,false);assert.equal(upstreamCalls,before);
  const controlCalls=models(app).length;assert.ok((await request(app,a,'POST',`eve/v1/session/${sa.id}/cancel`,{},sa.cookie)).ok);assert.equal(models(app).length,controlCalls);
  await send(app,a,sa,'question');assert.ok((await send(app,a,sa,'A private planning question')).includes('ANSWER'));console.log(role+': plain-text question continuation accepted');
  if(role==='chief-of-staff'){const mailA=await send(app,a,sa,'MAIL '+JSON.stringify(selections.get(a)));const mailB=await send(app,b,sb,'MAIL '+JSON.stringify(selections.get(b)));assert.ok(mailA.includes('MEMBER_A_MAIL_CANARY'));assert.ok(!mailA.includes('MEMBER_B_MAIL_CANARY'));assert.ok(mailB.includes('MEMBER_B_MAIL_CANARY'));}
  if(role==='creative')for(const skill of ['private-owner-skill','/vault/owner.md','../../agent/voice.md']){const result=await send(app,a,sa,'SKILL '+skill);assert.ok(result.includes('No skill named'),result);assert.ok(!result.includes(canaries.owner));}
  if(role==='chief-of-staff'&&withSend){
    const sendCount=()=>readFileSync(app.providerLog,'utf8').split('\n').filter(line=>line==='SEND_ACCEPTED').length;
    const input={selection:selections.get(a),to:['recipient@example.invalid','second@example.invalid'],subject:'Exact own mail',body:'Whole plaintext body\nSecond line'};
    async function proposal(session,message='SEND '+JSON.stringify(input)){
      const transcript=await send(app,a,session,message);
      const row=(await db.query("SELECT p.*,a.request_id FROM personal_actions p JOIN approval_asks a ON a.call_id=p.original_call_id WHERE p.session_id=$1 ORDER BY p.created_at DESC LIMIT 1",[session.id])).rows[0];
      assert.ok(row?.request_id,'Prepared action must exist before the framework card is answered: '+transcript);assert.equal(row.state,'awaiting_dispatch');
      assert.ok(!row.payload_ciphertext.includes(input.body));return row;
    }
    async function answer(session,row,option='approve'){
      const response=await request(app,a,'POST',`eve/v1/session/${session.id}`,{inputResponses:[{requestId:row.request_id,optionId:option}]},session.cookie);
      assert.ok(response.ok,'exact answer '+response.status+' '+await response.clone().text());return stream(app,a,session);
    }
    sendProof={proposal,sendCount};
    const cancelled=await proposal(sa,'SEND_ATTACK '+JSON.stringify({...input,subject:'Cancelled continuation attack'}));await answer(sa,cancelled,'cancel');assert.equal(sendCount(),0);
    assert.equal((await db.query('SELECT state FROM personal_actions WHERE id=$1',[cancelled.id])).rows[0].state,'cancelled');
    const approved=await proposal(sa);const before=models(app).length;
    await stop();await start(app);assert.equal(hashOutput(app.cwd),outputHash);
    assert.ok((await answer(sa,approved)).includes('ANSWER'));assert.equal(sendCount(),1);assert.ok(models(app).length>before,'Approved call must continue to the actual model');
    assert.equal((await db.query('SELECT state FROM personal_actions WHERE id=$1',[approved.id])).rows[0].state,'accepted');
    await answer(sa,approved);assert.equal(sendCount(),1);await stop();await start(app);await answer(sa,approved);assert.equal(sendCount(),1);
    const attack=await proposal(sa,'SEND_ATTACK '+JSON.stringify(input));await answer(sa,attack);assert.equal(sendCount(),2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM personal_actions WHERE session_id=$1',[sa.id])).rows[0].n,3,'Resolver model created another proposal');
    assert.equal(readFileSync(app.providerLog,'utf8').split('\n').filter(line=>line.includes('MAIL_CANARY')).length,2,'Resolver model read a private source');
    const wrongSelection=await create(app,a,'Wrong personal selection');await stream(app,a,wrongSelection);
    await send(app,a,wrongSelection,'SEND '+JSON.stringify({...input,selection:selections.get(b)})).catch(()=>{});
    assert.equal((await db.query('SELECT count(*)::int AS n FROM personal_actions WHERE session_id=$1',[wrongSelection.id])).rows[0].n,0,'Other member account created a proposal');assert.equal(sendCount(),2);
    const pending=await proposal(sa);
    const beforeWrong=models(app).length,callsBeforeWrong=sendCount();
    for(const [member,session,requestId]of [[b,sa,pending.request_id],[a,sb,pending.request_id],[a,sa,'forged-request']]){
      const response=await request(app,member,'POST',`eve/v1/session/${session.id}`,{inputResponses:[{requestId,optionId:'approve'}]},session.cookie);assert.equal(response.ok,false,'Wrong member/session/request reached runtime');
    }
    assert.equal(models(app).length,beforeWrong);assert.equal(sendCount(),callsBeforeWrong);await answer(sa,pending,'cancel');
    const expired=await proposal(sa);
    const ask=(await db.query('SELECT * FROM approval_asks WHERE request_id=$1',[expired.request_id])).rows[0];
    await db.query('DELETE FROM approval_asks WHERE request_id=$1',[expired.request_id]);
    await db.query(`INSERT INTO approval_asks(call_id,request_id,agent,tool,payload_hash,original_authority,acting_member_id,session_id,asked_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()-interval '25 hours')`,[ask.call_id,ask.request_id,ask.agent,ask.tool,ask.payload_hash,ask.original_authority,ask.acting_member_id,ask.session_id]);
    const refused=await request(app,a,'POST',`eve/v1/session/${sa.id}`,{inputResponses:[{requestId:expired.request_id,optionId:'approve'}]},sa.cookie);assert.equal(refused.ok,false);assert.equal(sendCount(),callsBeforeWrong);
    await answer(sa,expired,'cancel');
    console.log('chief-of-staff: exact prepare/approve/cancel/replay/cold-restart and second-call refusal PASS');
  }
  const record=models(app);for(const frame of record){const text=JSON.stringify(frame);assert.ok(!text.includes(canaries.owner));assert.ok(frame.messages.filter(message=>message.text?.startsWith('Available skills:')).every(message=>message.text==='Available skills: none'));const names=frame.tools.map(t=>t.name).sort();assert.deepEqual(names,role==='creative'?['ask_question','load_skill','todo']:['ask_question','gmail_accounts','gmail_read','gmail_search','todo',...(withSend?['personal_mailbox_accounts','personal_mailbox_list','personal_mailbox_read','personal_mailbox_send']:[])].sort());assert.ok(!(text.includes(canaries.a)&&text.includes(canaries.b)));}
  const beforeCold=gatewayLane?readFileSync(app.modelLog+'.scope','utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(s=>s.session.id===sa.id):[];
  await stop();await start(app);assert.equal(hashOutput(app.cwd),outputHash);assert.ok((await send(app,a,sa,'After cold restart')).includes('ANSWER'));
  if(gatewayLane){const after=readFileSync(app.modelLog+'.scope','utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(s=>s.session.id===sa.id);assert.ok(after.at(-1).event.data.sequence>Math.max(...beforeCold.map(s=>s.event.data.sequence)),'Cold fresh human turn reused previous sequence');assert.ok(after.at(-1).event.data.turnId,'Cold fresh human turn did not retain actual nonempty turn');}

  if(gatewayLane)await proveGatewayInvocation(app);
  if(withBudget)await proveDurableBudget(app);
  const current=await app.grants.agentAccess(owner,app.name);await app.grants.updateAgentAccess(owner,{agentName:app.name,expectedRevision:current.accessRevision,grants:[{principal:{kind:'member',id:b},permission:'use',expiresAt:null}]});await denyOld(app,a,sa);
  const revoked=await app.grants.agentAccess(owner,app.name);await app.grants.updateAgentAccess(owner,{agentName:app.name,expectedRevision:revoked.accessRevision,grants:[a,b].map(id=>({principal:{kind:'member',id},permission:'use',expiresAt:null}))});await denyOld(app,a,sa);await denyOld(app,b,sb);
  const fresh=await create(app,a,'New empty private context');await stream(app,a,fresh);assert.ok(!JSON.stringify(models(app).at(-1)).includes(canaries.a));
  const ac=await accounts.read(a,selections.get(a).accountId),ticket=await accounts.beginUpdate(a,ac.id,ac.generation);await accounts.setStatus(a,ticket,'revoked');await denyOld(app,a,fresh);
  const stopped=await accounts.read(a,ac.id);const renewed=await adapter.renew(a,await accounts.beginUpdate(a,ac.id,stopped.generation),a,{persist:async client=>(await client.query("SELECT id FROM oauth_tokens WHERE principal=$1 AND provider='google'",[a])).rows[0].id});assert.ok(renewed.generation>stopped.generation);await denyOld(app,a,fresh);
  const renewedSession=await create(app,a,'Healthy reconnect session');await stream(app,a,renewedSession);
  const [renewedResource]=await accounts.listResources(a,ac.id,renewed.generation);
  const generationPending=sendProof?await sendProof.proposal(renewedSession,'SEND '+JSON.stringify({selection:{accountId:ac.id,generation:renewed.generation,resourceBindingId:renewedResource.id},to:['recipient@example.invalid'],subject:'Pending generation',body:'Pending immutable body'})):null;
  const generationCalls=sendProof?.sendCount(),generationModels=models(app).length;
  const healthy=await adapter.renew(a,await accounts.beginUpdate(a,ac.id,renewed.generation),a);assert.ok(healthy.generation>renewed.generation);await denyOld(app,a,renewedSession);
  if(generationPending){const refused=await request(app,a,'POST',`eve/v1/session/${renewedSession.id}`,{inputResponses:[{requestId:generationPending.request_id,optionId:'approve'}]},renewedSession.cookie);assert.equal(refused.ok,false);assert.equal(sendProof.sendCount(),generationCalls);assert.equal(models(app).length,generationModels);console.log('chief-of-staff: pending account generation approval refused before model/provider PASS');}
  const departure=await create(app,b,'Before removal');await stream(app,b,departure);await memberStore.removeMember(owner,b);await denyOld(app,b,departure);await db.query("UPDATE users SET status='active' WHERE id=$1",[b]);const rejoined=await memberStore.createSession({identity:{issuer:'https://identity.example.invalid',subject:b},verifiedAt:new Date()},new Date(Date.now()+3600000));members.set(b,rejoined.token);await denyOld(app,b,departure);
  const oldInc=await create(app,a,'Before incarnation change');await stream(app,a,oldInc);await db.query("UPDATE agent_resources SET ownership_token='22222222-2222-4222-8222-222222222222',runtime_control_token='22222222-2222-4222-8222-222222222222' WHERE name=$1",[app.name]);await denyOld(app,a,oldInc);
  if(gatewayLane)assertGatewayScopes(app);
  const projection=await db.query('SELECT (SELECT count(*) FROM model_steps)::int AS models,(SELECT count(*) FROM conversation_entries)::int AS entries');assert.deepEqual(projection.rows[0],{models:0,entries:0});assert.equal(readFileSync(join(root,'vault/owner.md'),'utf8'),canaries.owner);
  assert.ok(!logs.includes(canaries.owner)&&!logs.includes(canaries.a)&&!logs.includes(canaries.b));
  snapshots.push({role,modelCalls:models(app).length,providerCalls:readFileSync(app.providerLog,'utf8').trim().split('\n').filter(Boolean).length,compiledHash:outputHash});
  console.log(JSON.stringify({roleResult:'PASS',...snapshots.at(-1)}));
  await stop();
 }
 console.log(JSON.stringify({result:'PASS',proof:'actual compiled role + actual proxy + migrated PostgreSQL + two opaque members',snapshots}));
}catch(error){writeFileSync(join(root,'server.log'),logs);console.error(logs.slice(-6000));throw error;}finally{await stop();
 // Eve's session sandboxes outlive its server. Remove only exact synthetic session labels.
 for(const id of ownedSessionIds){try{const ids=execFileSync('docker',['ps','-aq','--filter','label=eve.sandbox=1','--filter',`label=eve.sandbox.tag.sessionId=${id}`],{encoding:'utf8'}).trim().split('\n').filter(Boolean);if(ids.length){assert.ok(ids.every(value=>/^[a-f0-9]{12,64}$/.test(value)));execFileSync('docker',['rm','-f',...ids],{stdio:'ignore'});}}catch{console.warn('Synthetic sandbox cleanup needs attention for '+id);}}
 await gateway?.close();await db?.end();await container?.stop();if(process.env.PRIVATE_CHAT_PROOF_KEEP)console.log('Kept synthetic fixture: '+root);else rmSync(root,{recursive:true,force:true});}
