import {parseDefinition,hashOf,type LoadedDefinition} from '../../../packages/agent-kit/src/definition.js';
import {PgVaultStore} from '../../../packages/agent-kit/src/vault-area-store.js';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect} from 'vitest';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {captureModelInvocation,runModelInvocation} from '../../../packages/agent-kit/src/model-invocation.js';
import type {ConsoleAuthorityContext} from '../../../packages/agent-kit/src/console-turn-authority.js';
import type {BudgetRequestReference,BudgetFinancialWriter} from '../../../packages/agent-kit/src/budget-admission-store.js';
import {readFileSync,readdirSync,mkdtempSync,rmSync,fsyncSync,realpathSync,mkdirSync,writeFileSync,chmodSync} from 'node:fs';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PgBudgetAdmissionStore,consumeDispatchPermit,budgetIdentitySuppression,type BudgetGatewayObservation,type BudgetTerminalReceipt} from '../../../packages/agent-kit/src/budget-admission-store.js';
import {PgGrantStore} from '../../../packages/agent-kit/src/grant-store.js';
import {bindConsoleSession,captureConsoleVaultSources} from '../../../packages/agent-kit/src/console-turn-authority.js';
import {requirePrivateConsoleResume,requirePersistedPrivateConsoleModelResume} from '../../../packages/agent-kit/src/private-console-resume.js';
import {PgPersonalActionStore,PERSONAL_MAIL_SEND_TOOL,personalActionApprovalDescriptor} from '../../../packages/agent-kit/src/personal-action-store.js';
import {encryptSecret,decryptSecret} from '../lib/crypto.js';
import {exportPerson} from '../lib/export-person.js';
import {erasePerson,eraseHandlingFor} from '../lib/erase-person.js';
import {runErase} from '../lib/run-erase.js';
import {scopeOf} from '../lib/member-scope.js';
import {quiet} from './helpers/quiet-pool.js';
import {OUTSIDE_CUSTODY_FIXTURE_POLICY_HASH,OUTSIDE_CUSTODY_FIXTURE_POLICY_JSON} from './helpers/three-spellings.js';
import {GatewayBudgetAuthority,productionGatewayBudgetAuthority,type GatewayRecoveryWitness} from '../../keeper/lib/gateway-budget.js';
import {GATEWAY_ADMIT_PATH,GATEWAY_SETTLE_PATH,gatewayCanonical,gatewaySignature,gatewayHash,gatewayGrantHash,gatewayRawRequestHash,verifyGatewaySignature} from '../../../packages/agent-kit/src/gateway-admission-protocol.js';
import {consoleSourceTransaction,noteBudgetFinancialChange,retainConsoleSourceDeadline,sourceTransactionBoundary,type SourceDatabase,type SourcePool} from '../../../packages/agent-kit/src/console-source-transaction.js';
import {captureBudgetAuthorityReference} from '../../../packages/agent-kit/src/budget-model-authority.js';
import {requireConsoleSessionBinding} from '../../../packages/agent-kit/src/console-turn-authority.js';
import {JournalBudgetFinancialWriter} from '../../keeper/lib/budget-financial-writer.js';
import {HostFinancialJournal} from '../../keeper/lib/financial-journal.js';
import {serveModelPurposeBroker,modelPurposeDigest,modelPurposeMac,signModelPurposeRequest,type ModelPurposeRequest} from '../../keeper/lib/model-purpose-broker.js';
import {MODEL_PURPOSE_EMPTY_DIGEST,modelPurposeAckFields,modelPurposeEqualMac,modelPurposeRuntimeRequestFields,parseModelPurposeAdmissionResponse} from '../../../packages/agent-kit/src/model-purpose-protocol.js';
import {journalFixture,platformTestJournalLock,testJournalUid} from '../../keeper/tests/helpers/financial-journal.js';
import {observeFinancialDatabase} from '../../keeper/lib/financial-continuity.js';
const incarnation='11111111-1111-4111-8111-111111111111',endpoint='e'.repeat(64),profile='f'.repeat(64),fingerprint='d'.repeat(64);
const pricing={version:1,capabilityHash:profile,format:'openai',limits:{inputTokens:1000,outputTokens:1000},usdPerMillionTokens:{input:'10',output:'90',cacheRead:'5',cacheWrite:'0'}};
let sessionGeneration=0;
const nonce=(member:string)=>createHash('sha256').update(`${member}:${sessionGeneration}`).digest('base64url');
const env=(agent='helper')=>({LARES_AGENT_NAME:agent,LARES_AGENT_INCARNATION:incarnation,AGENT_OWNER_USER_ID:'member-a'});
const context=(member='member-a',agent='helper')=>{
  const auth={authenticator:'lares-console',attributes:{lares_member_id:member,lares_admission_nonce:nonce(member),lares_purpose:'human'}};
  return {session:{id:`session-${member}-${agent}-${sessionGeneration}`,turn:{id:'turn-1',sequence:0},auth:{current:auth,initiator:auth}}};
};
let container:StartedPostgreSqlContainer,db:Pool,store:PgBudgetAdmissionStore,installation:string;
let accounts:Record<string,string>,bindings:Record<string,string>;
const fixtureOwner=randomUUID();
const sql=new URL('../sql/',import.meta.url);
const h=(s:string)=>createHash('sha256').update(s).digest('hex');
const recovery=()=>({installationAccountId:installation,epoch:'epoch-1',endpointGeneration:'0',state:'reconciled' as const});
async function gatewayCustody(pool:Pool,failOn?:'proposal'|'control',existingDirectory?:string){
  const directory=existingDirectory??join(realpathSync(tmpdir()),`lares-gateway-financial-${randomUUID()}`);let armed=false;
  const sync=(fd:number)=>{
    fsyncSync(fd);
    if(armed&&failOn){
      const last=readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').at(-1);
      if(last&&JSON.parse(last).record.kind===failOn)throw new Error(`synthetic ${failOn} fsync failure`);
    }
  };
  const options={ownershipUid:testJournalUid,lock:platformTestJournalLock,sync};
  let journal:HostFinancialJournal;
  if(existingDirectory)journal=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true});
  else{
    const preparation=HostFinancialJournal.prepareFresh(directory,await observeFinancialDatabase(pool),options);
    try{preparation.complete();}finally{preparation.close();}
    journal=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true});
  }
  armed=true;
  return {directory,journal,writer:new JournalBudgetFinancialWriter(journal),records:()=>readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line))};
}
const purposeEmptyDigest=MODEL_PURPOSE_EMPTY_DIGEST;
function purposeRuntimeEnvelope(op:string,input:Record<string,unknown>,key:Buffer,overrides:Record<string,unknown>={}){
  const requestId=randomBytes(32).toString('base64url');
  const unsigned={agent:'helper',incarnation,requestId,timestamp:Date.now(),op,input,outcomeDigest:purposeEmptyDigest,
    payloadDigest:op==='step.claim'?modelPurposeDigest(input.event):modelPurposeDigest(input),...overrides};
  const fields=modelPurposeRuntimeRequestFields(unsigned as never);
  return {...unsigned,mac:modelPurposeMac(key,fields).toString('base64url')};
}
async function purposeSocketRequest(path:string,request:unknown,key?:Buffer,onConnect?:(socket:ReturnType<typeof createConnection>)=>void):Promise<Record<string,unknown>>{
  return new Promise((resolve,reject)=>{
    const socket=createConnection(path);let buffer='',settled=false;const timer=setTimeout(()=>{socket.destroy();if(!settled)reject(new Error('socket timeout'));},2500);
    socket.setEncoding('utf8');socket.on('connect',()=>{socket.write(JSON.stringify(request)+'\n');onConnect?.(socket);});
    socket.on('data',chunk=>{buffer+=chunk;const newline=buffer.indexOf('\n');if(newline>=0){clearTimeout(timer);socket.end();try{
      const response=JSON.parse(buffer.slice(0,newline)) as Record<string,unknown>;
      if(response.ok===true&&typeof response.responseMac==='string'){
        const {ok:_ok,responseMac,responseRequestDigest,responseOutcomeDigest,responsePayloadDigest,...result}=response;
        const fields=modelPurposeAckFields(request as never,result);
        if(responseRequestDigest!==fields.requestDigest||responseOutcomeDigest!==fields.outcomeDigest||responsePayloadDigest!==fields.payloadDigest||
          !key||!modelPurposeEqualMac(responseMac,modelPurposeMac(key,fields)))throw new Error('Invalid signed purpose ACK');
      }
      settled=true;resolve(response);
    }catch(error){reject(error);}}});
    socket.on('error',error=>{clearTimeout(timer);reject(error);});
    socket.on('close',()=>{clearTimeout(timer);if(!settled)reject(new Error('socket closed before response'));});
  });
}
function purposeBrokerFiles(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-purpose-consumer-')),secrets=join(root,'secrets');mkdirSync(secrets,{mode:0o700});
  const consoleKey=Buffer.alloc(32,7),runtimeKey=Buffer.alloc(32,9),consolePath=join(secrets,'console-key');
  writeFileSync(consolePath,consoleKey.toString('hex')+'\n',{mode:0o440});writeFileSync(join(secrets,'helper-runtime-control'),runtimeKey.toString('hex')+'\n',{mode:0o440});
  chmodSync(consolePath,0o440);chmodSync(join(secrets,'helper-runtime-control'),0o440);chmodSync(secrets,0o700);
  return {root,secrets,consoleKey,runtimeKey,consolePath,consoleSocket:join(root,'console.sock'),runtimeSocket:join(root,'runtime.sock')};
}
async function startPurposeBroker(files:ReturnType<typeof purposeBrokerFiles>,writer:BudgetFinancialWriter,consumerPool:Pool=db){
  const uid=process.getuid?.()??0,gid=process.getgid?.()??0;
  return serveModelPurposeBroker(db as unknown as SourcePool,{consoleSigningKeyFile:files.consolePath,runtimeSecretsDir:files.secrets,
    consoleSocket:files.consoleSocket,runtimeSocket:files.runtimeSocket,rootUid:uid,consoleKeyUid:uid,consoleKeyGid:gid,
    runtimeKeyUid:uid,runtimeKeyGid:gid,socketUid:uid,socketGid:gid},{pool:consumerPool,writer});
}
async function selectPurposeModel(definitionHash:string){
  const sessionId=`${context().session.id}-model-purpose-${randomBytes(8).toString('hex')}`;
  const admissionNonce=createHash('sha256').update(sessionId).digest('base64url');
  await db.query('UPDATE agent_definitions SET definition=$1::jsonb,hash=$2 WHERE name=$3',[JSON.stringify({model:'standard',grants:[]}),definitionHash,'helper']);
  await db.query("DELETE FROM resource_grants WHERE resource_kind='agent' AND resource_id='helper'; DELETE FROM agent_access WHERE agent_name='helper'");
  const grants=new PgGrantStore(db),adopted=await grants.adoptAgent('member-a',{agentName:'helper',expectedDefinitionHash:definitionHash},{designatedOwnerMemberId:'member-a'});
  await grants.updateAgentAccess('member-a',{agentName:'helper',expectedRevision:adopted.accessRevision,grants:[{principal:{kind:'organisation',id:'org'},permission:'use',expiresAt:null}]});
  expect(await grants.captureUse('member-a','helper',{db})).toBeDefined();
  expect((await db.query('SELECT 1 FROM agent_resources WHERE name=$1 AND ownership_token=$2::uuid AND runtime_control_token=ownership_token AND state=\'ready\' AND NOT pending',['helper',incarnation])).rowCount).toBe(1);
  await bindConsoleSession({agent:'helper',incarnation,memberId:'member-a',admissionNonce,sessionId},db,env());
  return {sessionId,admissionNonce};
}
async function purposeRequestAdmission(files:ReturnType<typeof purposeBrokerFiles>,request:ModelPurposeRequest){
  const challenge=await purposeSocketRequest(files.consoleSocket,{op:'request.challenge',input:request});
  expect(challenge.ok).toBe(true);
  const capsule=signModelPurposeRequest(files.consoleKey,request,String(challenge.challenge),String(challenge.challengeMac),Number(challenge.expiresAt));
  const receipt={method:request.method,path:request.path,rawBodyHash:request.rawBodyHash,requestId:request.requestId,purpose:request.purpose,...(request.resume?{resume:request.resume}:{})};
  const admitted=await purposeSocketRequest(files.runtimeSocket,purposeRuntimeEnvelope('request.admit',{capsule,receipt},files.runtimeKey),files.runtimeKey);
  expect(admitted.ok).toBe(true);
  expect(Object.keys(admitted).sort()).toEqual(['expiresAt','ok','pendingReceipt','responseMac','responseOutcomeDigest','responsePayloadDigest','responseRequestDigest']);
  expect(admitted.receipt).toBeUndefined();
  const {ok:_ok,responseMac:_mac,responseRequestDigest:_requestDigest,responseOutcomeDigest:_outcomeDigest,responsePayloadDigest:_payloadDigest,...result}=admitted;
  expect(Object.keys(result).sort()).toEqual(['expiresAt','pendingReceipt']);
  const parsed=parseModelPurposeAdmissionResponse(result);expect(parsed).toEqual(result);return parsed!.pendingReceipt;
}
function purposeRequest(overrides:Partial<ModelPurposeRequest>={}):ModelPurposeRequest{
  return {agent:'helper',incarnation,session:context().session.id,member:'member-a',admissionNonce:nonce('member-a'),method:'POST',path:'/eve/v1/session',
    rawBodyHash:h('private-console-request'),policyRevision:2,definitionHash:h('model-purpose-definition'),purpose:'human',requestId:randomBytes(32).toString('base64url'),...overrides};
}
let gatewayPreparedStore:PgBudgetAdmissionStore|undefined;
async function journalGatewayFixture(writer:JournalBudgetFinancialWriter,work:(source:SourceDatabase)=>Promise<void>):Promise<void>{
  await writer.run('provision',boundary=>consoleSourceTransaction(db as unknown as SourcePool,work,boundary));
}
async function journalGatewayWindow(writer:JournalBudgetFinancialWriter,accountId:string,memberId:string|null,opening='0'):Promise<string>{
  const id=randomUUID();
  await journalGatewayFixture(writer,async source=>{
    await source.query("INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision) VALUES($1,$2,$3,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 day',$4,1,0)",[id,accountId,memberId,opening]);
    noteBudgetFinancialChange(source,'budget_windows',id);
    await source.query('UPDATE budget_accounts SET active_window_id=$2 WHERE id=$1',[accountId,id]);
    noteBudgetFinancialChange(source,'budget_accounts',accountId);
  });
  return id;
}
async function seedGatewayFinancialFixture(writer:JournalBudgetFinancialWriter):Promise<void>{
  await journalGatewayFixture(writer,async source=>{
    await source.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,installation_cap,selected_endpoint,recovery_epoch) VALUES($1,'installation','installation',$1,1,$2,'epoch-1')",[installation,endpoint]);
    noteBudgetFinancialChange(source,'budget_accounts',installation);
    const makeWindow=async(id:string,accountId:string,memberId:string|null)=>{
      await source.query("INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision) VALUES($1,$2,$3,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 day',0,1,0)",[id,accountId,memberId]);
      noteBudgetFinancialChange(source,'budget_windows',id);
      await source.query('UPDATE budget_accounts SET active_window_id=$2 WHERE id=$1',[accountId,id]);
      noteBudgetFinancialChange(source,'budget_accounts',accountId);
    };
    await makeWindow(randomUUID(),installation,null);
    await source.query("UPDATE budget_accounts SET state='open',reason='approved' WHERE id=$1",[installation]);
    noteBudgetFinancialChange(source,'budget_accounts',installation);
    for(const member of ['member-a','member-b']){
      const id=accounts[member]!,suppression=budgetIdentitySuppression(Buffer.alloc(32,1),{canonicalMemberId:member,providers:[{issuer:'https://issuer.invalid',subject:member,tenantId:'tenant'}]});
      await source.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,live_member_id,organisation_id,canonical_suppression_hash,provider_suppression_hashes) VALUES($1,'installation','member',$2,$3,'org',$4,$5)",[id,installation,member,suppression.canonicalSuppressionHash,suppression.providerSuppressionHashes]);
      noteBudgetFinancialChange(source,'budget_accounts',id);
      await makeWindow(randomUUID(),id,member);
      await source.query("UPDATE budget_accounts SET state='open',reason='approved' WHERE id=$1",[id]);
      noteBudgetFinancialChange(source,'budget_accounts',id);
      for(const agent of ['helper','helper-two']){
        const bindingId=bindings[`${member}:${agent}`]!;
        await source.query("INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,purpose_alias,profile_hash,maximum_liability,pricing_profile,state) VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,'standard',$9,0.1,$10::jsonb,'active')",[bindingId,installation,id,member,endpoint,fingerprint,agent,incarnation,profile,JSON.stringify(pricing)]);
        noteBudgetFinancialChange(source,'budget_gateway_bindings',bindingId);
      }
    }
  });
}
let invocationSequence=0;
function prepare(selected:PgBudgetAdmissionStore,ctx:ConsoleAuthorityContext,request:BudgetRequestReference,coordinates={turnId:ctx.session!.turn!.id!,sequence:ctx.session!.turn!.sequence!,stepIndex:invocationSequence++},alias='standard'){
  const invocation=captureModelInvocation({type:'step.started',data:coordinates},ctx.session as never,alias);
  return runModelInvocation(invocation,()=>selected.prepareIntent(request));
}
// A fresh Node process reconstructs only trusted event/session capture; no caller hash or
// store bypass. This proves the database suppression independently of process tombstones.
async function coldPrepare(ctx:ConsoleAuthorityContext,request:BudgetRequestReference,coordinates:{turnId:string;sequence:number;stepIndex:number},alias='standard'){
  const moduleUrl=new URL('../../../packages/agent-kit/src/',import.meta.url).href;
  const code=`import {Pool} from 'pg';
    import {PgBudgetAdmissionStore} from '${moduleUrl}budget-admission-store.ts';
    import {captureModelInvocation,runModelInvocation} from '${moduleUrl}model-invocation.ts';
    const f=JSON.parse(process.env.BUDGET_TEST_FIXTURE);
    const pool=new Pool({connectionString:f.connectionString,max:1});
    try { const invocation=captureModelInvocation({type:'step.started',data:f.coordinates},f.ctx.session,f.alias);
      const ticket=await runModelInvocation(invocation,()=>new PgBudgetAdmissionStore(pool,f.env).prepareIntent(f.request));
      process.stdout.write(JSON.stringify({ticket}));
    } catch {process.stdout.write(JSON.stringify({denied:true}));} finally {await pool.end();}`;
  const result=await promisify(execFile)(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),'--input-type=module','--eval',code],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,BUDGET_TEST_FIXTURE:JSON.stringify({ctx,request,coordinates,alias,env:env(),connectionString:container.getConnectionUri()})},timeout:15_000,
  });
  return JSON.parse(result.stdout) as {ticket?:string;denied?:boolean};
}
async function prepared(member='member-a',agent='helper',selected?:PgBudgetAdmissionStore){
  selected??=gatewayPreparedStore??store;
  const requestHash=h(randomUUID()),bindingId=bindings[`${member}:${agent}`]!;
  const ticket=await prepare(selected,context(member,agent),{bindingId,requestHash,profileHash:profile});
  const observation:BudgetGatewayObservation={requestHash,profileHash:profile,endpointHash:endpoint,credentialGeneration:'0',keyFingerprint:fingerprint,agent,incarnation,purposeAlias:'standard'};
  return {ticket,observation,bindingId};
}
async function admitted(member='member-a',agent='helper'){
  const p=await prepared(member,agent,agent==='helper'?store:new PgBudgetAdmissionStore(db,env(agent)));
  const a=await (agent==='helper'?store:new PgBudgetAdmissionStore(db,env(agent))).admit(p.ticket,p.observation,recovery());
  expect(a.state).toBe('allowed');if(a.state!=='allowed')throw new Error(JSON.stringify(a));return {...p,...a};
}
const receipt=(a:Awaited<ReturnType<typeof admitted>>,amount='0.05'):BudgetTerminalReceipt=>({attemptId:a.attemptId,bindingId:a.bindingId,requestHash:a.observation.requestHash,endpointHash:endpoint,credentialGeneration:'0',profileHash:profile,receiptHash:h(`receipt-${a.attemptId}`),actualAmount:amount,kind:'terminal-usage'});
async function freshConsoleSessions(){
  // Policy/membership writes correctly revoke old captures. A later human request uses
  // freshly admitted sessions, while previously prepared references remain unchanged.
  sessionGeneration++;
  for(const agent of ['helper','helper-two'])for(const memberId of ['member-a','member-b'])
    await bindConsoleSession({agent,incarnation,memberId,admissionNonce:nonce(memberId),sessionId:context(memberId,agent).session.id},db,env(agent));
}
async function cap(member:string,amount:string|null){
  await db.query('UPDATE org_member_policy SET spend_cap_usd_month=$2 WHERE user_id=$1',[member,amount]);
  await freshConsoleSessions();
}
async function window(accountId:string,member:string|null,opening='0'){
  const id=randomUUID();await db.query(`INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision) VALUES($1,$2,$3,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 day',$4,1,0)`,[id,accountId,member,opening]);
  await db.query('UPDATE budget_accounts SET active_window_id=$2 WHERE id=$1',[accountId,id]);return id;
}
/** Observe entry to the budget lock only after the real authority checks completed. */
async function admitAcrossDeadline(p:Awaited<ReturnType<typeof prepared>>,validUntil:string){
  const other=quiet(new Pool({connectionString:container.getConnectionUri(),max:1})),locker=await other.connect();
  let entered!:()=>void;const budgetLock=new Promise<void>(resolve=>{entered=resolve;});
  const observed={connect:async()=>{const client=await db.connect();return {release:()=>client.release(),query:(sql:string,values?:unknown[])=>{
    if(sql.startsWith("SELECT * FROM budget_accounts WHERE id=$1 AND kind='installation' FOR UPDATE"))entered();
    return client.query(sql,values);
  }};}} as unknown as Pool;
  let pending:ReturnType<PgBudgetAdmissionStore['admit']>|undefined;
  try{
    await locker.query('BEGIN');await locker.query('SELECT id FROM budget_accounts WHERE id=$1 FOR UPDATE',[installation]);
    pending=new PgBudgetAdmissionStore(observed,env()).admit(p.ticket,p.observation,recovery());
    await Promise.race([budgetLock,pending.then(()=>{throw new Error('Admission stopped before the budget lock');})]);
    await locker.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.025)",[validUntil]);
    await locker.query('COMMIT');return await pending;
  }finally{
    await locker.query('ROLLBACK');locker.release();await pending;await other.end();
  }
}
async function resumeFixture(deadline:'action'|'approval',option:'approve'|'cancel'='approve'){
  const callId=randomUUID(),requestId=randomUUID(),actionId=randomUUID(),payloadHash=h('expiry-payload');
  const selection={actorMemberId:'member-a',agentId:'helper',incarnation,sessionId:context().session.id,originalTurnId:'turn-1',originalCallId:callId,accountId:'expiry-account',accountGeneration:0,resourceBindingId:'mailbox',connectorId:'example',kind:'mail.send' as const};
  const delay=option==='approve'?1500:-1000;
  // This immutable fixture is born with a short deadline; no evidence/clock is rewritten.
  const row=(await db.query(`INSERT INTO personal_actions(id,payload_version,actor_member_id,agent,incarnation,session_id,original_turn_id,original_call_id,original_call_hash,account_id,account_generation,resource_binding_id,connector_id,kind,payload_hash,payload_ciphertext,approval_call_id,approval_request_id,state,created_at,expires_at)
    SELECT $1,1,'member-a','helper',$2,$3,'turn-1',$4,$5,'expiry-account',0,'mailbox','example','mail.send',$6,'opaque-fixture',NULL,NULL,'awaiting_approval',t-interval '1 hour',t+(CASE WHEN $7='action' THEN $8 ELSE 3600000 END*interval '1 millisecond') FROM(SELECT clock_timestamp() AS t)c RETURNING *`,
    [actionId,incarnation,selection.sessionId,callId,h(callId),payloadHash,deadline,delay])).rows[0];
  const action={actionId,payloadHash,expiresAt:row.expires_at.toISOString(),state:row.state,attemptId:null,receipt:null};
  await db.query(`INSERT INTO approval_asks(call_id,request_id,agent,tool,payload_hash,original_authority,acting_member_id,resolved_by_member_id,session_id,outcome,asked_at,answered_at)
    SELECT $1,$2,'helper',$3,$4,$5::jsonb,'member-a','member-a',$6,$7,clock_timestamp()-interval '24 hours'+(CASE WHEN $8='approval' THEN $9 ELSE 3600000 END*interval '1 millisecond'),clock_timestamp()`,
    [callId,requestId,PERSONAL_MAIL_SEND_TOOL,payloadHash,JSON.stringify(personalActionApprovalDescriptor(action,selection,h('policy'))),selection.sessionId,option==='approve'?'approved':'cancelled',deadline,delay]);
  await db.query('UPDATE personal_actions SET approval_call_id=$2,approval_request_id=$3,state=$4 WHERE id=$1',[actionId,callId,requestId,option==='approve'?'awaiting_dispatch':'cancelled']);
  const human=context(),resume={session:{...human.session,turn:{id:'',sequence:1},auth:{initiator:human.session.auth.initiator,current:{authenticator:'lares-console',attributes:{lares_resolver_member_id:'member-a',lares_resume_request_id:requestId,lares_resume_option:option,lares_purpose:'resolver'}}}}};
  const current=await requirePrivateConsoleResume(resume,'model',{db,env:env()}),requestHash=h(randomUUID()),bindingId=bindings['member-a:helper']!;
  const ticket=await prepare(store,resume,{bindingId,requestHash,profileHash:profile});
  return {ticket,bindingId,validUntil:current.validUntil,observation:{requestHash,profileHash:profile,endpointHash:endpoint,credentialGeneration:'0',keyFingerprint:fingerprint,agent:'helper',incarnation,purposeAlias:'standard'}};
}
beforeAll(async()=>{
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  db=quiet(new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1000}));
  for(const file of readdirSync(sql).filter(f=>f.endsWith('.sql')).sort())await db.query(readFileSync(new URL(file,sql),'utf8'));
  // Migration 026 owns the real dream tables used by the shared identity inventory.
  await db.query('CREATE TABLE budget_test_owner(marker text NOT NULL)');
  await db.query('INSERT INTO budget_test_owner VALUES($1)',[fixtureOwner]);
},120_000);
afterAll(async()=>{await db?.end();await container?.stop();});
beforeEach(async()=>{
  sessionGeneration++;
  // Destructive cleanup is confined to this owned, disposable container. Never accept an
  // environment connection string or run this through production store helpers.
  expect((await db.query('SELECT marker,current_database() AS database FROM budget_test_owner')).rows).toEqual([{marker:fixtureOwner,database:'test'}]);
  await db.query('TRUNCATE users,orgs,agent_definitions,agent_resources,personal_action_calls,dream_observations,dream_preferences,budget_financial_checkpoints RESTART IDENTITY CASCADE');
  await db.query(`INSERT INTO orgs(id,display_name) VALUES('org','Example');
    INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-a','A','org','owner','active'),('member-b','B','org','owner','active');
    INSERT INTO org_member_policy(user_id,allowed_capabilities,spend_cap_usd_month) VALUES('member-a',NULL,1),('member-b',NULL,1);`);
  const grants=new PgGrantStore(db);
  for(const agent of ['helper','helper-two']){
    await db.query("INSERT INTO agent_definitions(name,definition,hash) VALUES($1,'{\"grants\":[]}','fixture')",[agent]);
    await db.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending) VALUES($1,$3,$1,'owned',$2,$2,'ready',false)",[agent,incarnation,agent==='helper'?'127.0.0.2':'127.0.0.3']);
    const adopted=await grants.adoptAgent('member-a',{agentName:agent,expectedDefinitionHash:'fixture'},{designatedOwnerMemberId:'member-a'});
    await grants.updateAgentAccess('member-a',{agentName:agent,expectedRevision:adopted.accessRevision,grants:[{principal:{kind:'organisation',id:'org'},permission:'use',expiresAt:null}]});
    for(const memberId of ['member-a','member-b'])await bindConsoleSession({agent,incarnation,memberId,admissionNonce:nonce(memberId),sessionId:context(memberId,agent).session.id},db,env(agent));
  }
  installation=randomUUID();accounts={};bindings={};
  await db.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,installation_cap,selected_endpoint,recovery_epoch) VALUES($1,'installation','installation',$1,1,$2,'epoch-1')",[installation,endpoint]);
  await window(installation,null);
  await db.query("UPDATE budget_accounts SET state='open',reason='approved' WHERE id=$1",[installation]);
  for(const member of ['member-a','member-b']){
    const id=randomUUID(),suppression=budgetIdentitySuppression(Buffer.alloc(32,1),{canonicalMemberId:member,providers:[{issuer:'https://issuer.invalid',subject:member,tenantId:'tenant'}]});accounts[member]=id;
    await db.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,live_member_id,organisation_id,canonical_suppression_hash,provider_suppression_hashes) VALUES($1,'installation','member',$2,$3,'org',$4,$5)",[id,installation,member,suppression.canonicalSuppressionHash,suppression.providerSuppressionHashes]);
    await window(id,member);await db.query("UPDATE budget_accounts SET state='open',reason='approved' WHERE id=$1",[id]);
    for(const agent of ['helper','helper-two']){
      const bindingId=randomUUID();bindings[`${member}:${agent}`]=bindingId;
      await db.query("INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,purpose_alias,profile_hash,maximum_liability,pricing_profile,state) VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,'standard',$9,0.1,$10::jsonb,'active')",[bindingId,installation,id,member,endpoint,fingerprint,agent,incarnation,profile,JSON.stringify(pricing)]);
    }
  }
  store=new PgBudgetAdmissionStore(db,env());
});
describe('signed keeper gateway admission on the one-connection PostgreSQL pool',()=>{
  const serviceKey=Buffer.alloc(32,9);
  const witness:GatewayRecoveryWitness={observe:async()=>recovery()};
  let files:{directory:string;journal:HostFinancialJournal;writer:JournalBudgetFinancialWriter;records:()=>any[]};
  beforeEach(async()=>{
    // The shared test setup populates raw financial rows for non-journalled store tests.
    // This prepared-custody integration starts from an empty financial ledger and recreates
    // the same fixtures through the real writer, so no row is silently adopted.
    await db.query('TRUNCATE budget_gateway_grants,budget_attempts,budget_gateway_bindings,budget_windows,budget_accounts,budget_financial_checkpoints CASCADE');
    files=await gatewayCustody(db);
    await seedGatewayFinancialFixture(files.writer);
    gatewayPreparedStore=new PgBudgetAdmissionStore(db,env(),30_000,files.writer);
  });
  afterEach(()=>{gatewayPreparedStore=undefined;files.journal.close();rmSync(files.directory,{recursive:true,force:true});});
  function authority(pool=db,source:GatewayRecoveryWitness|undefined=witness,writer:JournalBudgetFinancialWriter|undefined=files.writer){return new GatewayBudgetAuthority(pool,serviceKey,writer,source);}
  function admitDocument(p:Awaited<ReturnType<typeof prepared>>){return {version:1,nonce:h(randomUUID()),ticket:p.ticket,requestHash:p.observation.requestHash,profileHash:profile,endpointHash:endpoint,keyFingerprint:fingerprint,purposeAlias:'standard'};}
  async function rpc(selected:GatewayBudgetAuthority,path:string,document:unknown){
    const raw=gatewayCanonical(document),reply=await selected.handle(path,gatewaySignature(serviceKey,'request',path,raw),raw);
    if(reply.status===200)expect(verifyGatewaySignature(serviceKey,reply.headers['x-lares-signature'],'response',path,reply.body)).toBe(true);
    return {reply,document:JSON.parse(reply.body.toString())};
  }
  async function allowed(selected=authority()){
    const p=await prepared(),request=admitDocument(p),result=await rpc(selected,GATEWAY_ADMIT_PATH,request);
    expect(result.reply.status).toBe(200);expect(result.document.state).toBe('allowed');return {selected,request,grant:result.document,p};
  }
  function terminal(grant:any,outputTokens=100,changes:Record<string,unknown>={}){
    const {state,validForMs,...echoes}=grant;
    const evidence={...echoes,kind:'terminal-usage',format:'openai',usage:{inputTokens:100,outputTokens,cacheReadTokens:40,cacheWriteTokens:0},...changes};
    return {...evidence,receiptHash:gatewayHash(gatewayCanonical(evidence))};
  }
  it('consumes a signed Console human step through the real Keeper socket and prepared journal',async()=>{
    const definitionHash=h('model-purpose-definition'),selected=await selectPurposeModel(definitionHash),{sessionId,admissionNonce}=selected;
    const bound=await requireConsoleSessionBinding({agent:'helper',incarnation,sessionId,memberId:'member-a',admissionNonce},db,env());
    const purposeFiles=purposeBrokerFiles();let stop:(()=>Promise<void>)|undefined,closeAfterPrepare=false,capability='';
    try{
      const writer:BudgetFinancialWriter={run:async<T>(operation:'prepare'|'provision'|'admit'|'grant'|'unknown'|'settle'|'member-remove'|'erase-person',work:(boundary:ReturnType<typeof sourceTransactionBoundary>,operationId:string)=>Promise<T>)=>{
        const result=await files.writer.run(operation,work);
        if(operation==='prepare'&&closeAfterPrepare){closeAfterPrepare=false;
          const closed=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('turn.close',{turnCapability:capability,turnId:'turn-1',sequence:0},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
          expect(closed.ok).toBe(true);
        }
        return result;
      }};
      stop=await startPurposeBroker(purposeFiles,writer);
      const request=purposeRequest({session:sessionId,admissionNonce,policyRevision:bound.policyRevision,definitionHash});
      const pendingReceipt=await purposeRequestAdmission(purposeFiles,request);
      const originalContext=context(),humanAuth={...originalContext.session.auth.current,attributes:{...originalContext.session.auth.current.attributes,lares_admission_nonce:admissionNonce}};
      const humanContext={session:{...originalContext.session,id:sessionId,auth:{current:humanAuth,initiator:humanAuth}}};
      const turn=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('turn.open',{pendingReceipt,context:humanContext},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(turn.ok).toBe(true);
      capability=String(turn.capability);
      const event={type:'step.started',data:{turnId:'turn-1',sequence:0,stepIndex:0}};
      const claimed=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('step.claim',{
        turnCapability:turn.capability,purposeAlias:'standard',event,
      },purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(claimed.ok).toBe(true);
      const body=Buffer.from('{"model":"standard","messages":[]}'),identity={method:'POST',path:'/v1/chat/completions',requestHash:gatewayRawRequestHash('POST','/v1/chat/completions',body)};
      const validConsume=purposeRuntimeEnvelope('step.consume',{claim:claimed.claim,request:identity},purposeFiles.runtimeKey),validMac=String(validConsume.mac);
      const badMac={...validConsume,mac:`${validMac.startsWith('A')?'B':'A'}${validMac.slice(1)}`};
      expect((await purposeSocketRequest(purposeFiles.runtimeSocket,badMac,purposeFiles.runtimeKey)).ok).toBe(false);
      // The authenticated retry uses the same request id; bad MACs never reserve the claim.
      const consumed=await purposeSocketRequest(purposeFiles.runtimeSocket,validConsume,purposeFiles.runtimeKey);
      expect(consumed).toMatchObject({ok:true,ticket:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),expiresAt:expect.any(Number)});
      const attempt=(await db.query('SELECT state,request_hash,profile_hash,authority_reference,invocation_hash FROM budget_attempts')).rows[0];
      expect(attempt).toMatchObject({state:'prepared',request_hash:identity.requestHash,profile_hash:profile});
      expect(attempt.authority_reference).toMatchObject({kind:'human',binding:{memberId:'member-a',agent:'helper',incarnation},turnId:'turn-1',turnSequence:0});
      expect(attempt.invocation_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(files.records().some(frame=>frame.record.kind==='begin'&&frame.record.operation==='prepare')).toBe(true);
      const nextEvent={type:'step.started',data:{turnId:'turn-1',sequence:0,stepIndex:1}};
      const nextClaim=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('step.claim',{turnCapability:capability,purposeAlias:'standard',event:nextEvent},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(nextClaim.ok).toBe(true);closeAfterPrepare=true;
      // The writer completes the real COMMIT, observer and journal publication before the
      // injected terminal close. Keeper must withhold the late ACK while retaining that truth.
      const late=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('step.consume',{claim:nextClaim.claim,request:identity},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(late.ok).toBe(false);
      expect((await db.query("SELECT state FROM budget_attempts ORDER BY created_at,id")).rows.map(row=>row.state)).toEqual(['prepared','prepared']);
      const preparedOperationIds=files.records().filter(frame=>frame.record.kind==='begin'&&frame.record.operation==='prepare').map(frame=>frame.record.operationId);
      expect(files.records().filter(frame=>frame.record.kind==='commit'&&preparedOperationIds.includes(frame.record.operationId))).toHaveLength(2);
      expect((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n).toBe(2);
      const replay=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('step.consume',{claim:claimed.claim,request:{...identity,requestHash:h('changed-body')}},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(replay.ok).toBe(false);
      await stop();stop=undefined;
      const restartedFiles=purposeBrokerFiles();
      try{
        stop=await startPurposeBroker(restartedFiles,files.writer);
        const restartedRequest=purposeRequest({session:sessionId,admissionNonce,policyRevision:bound.policyRevision,definitionHash,rawBodyHash:h('new-console-body')});
        const restartedReceipt=await purposeRequestAdmission(restartedFiles,restartedRequest);
        const restartedTurn=await purposeSocketRequest(restartedFiles.runtimeSocket,purposeRuntimeEnvelope('turn.open',{pendingReceipt:restartedReceipt,context:humanContext},restartedFiles.runtimeKey),restartedFiles.runtimeKey);
        expect(restartedTurn.ok).toBe(true);
        const sameStep={type:'step.started',data:{turnId:'turn-1',sequence:0,stepIndex:0}};
        const restartedClaim=await purposeSocketRequest(restartedFiles.runtimeSocket,purposeRuntimeEnvelope('step.claim',{
          turnCapability:restartedTurn.capability,purposeAlias:'standard',event:sameStep,
        },restartedFiles.runtimeKey),restartedFiles.runtimeKey);
        expect(restartedClaim.ok).toBe(true);
        const changedBody=Buffer.from('{"model":"standard","messages":[{"content":"changed"}]}');
        const refused=await purposeSocketRequest(restartedFiles.runtimeSocket,purposeRuntimeEnvelope('step.consume',{claim:restartedClaim.claim,
          request:{...identity,requestHash:gatewayRawRequestHash('POST','/v1/chat/completions',changedBody)}},restartedFiles.runtimeKey),restartedFiles.runtimeKey);
        expect(refused.ok).toBe(false);
        expect((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n).toBe(2);
      expect(files.records().filter(frame=>frame.record.kind==='commit'&&preparedOperationIds.includes(frame.record.operationId))).toHaveLength(2);
      }finally{await stop?.();stop=undefined;rmSync(restartedFiles.root,{recursive:true,force:true});}
    }finally{await stop?.();rmSync(purposeFiles.root,{recursive:true,force:true});}
  });
  it('consumes the real empty approval-resume step with resolver and human initiator preserved',async()=>{
    const definitionHash=h('model-purpose-definition'),requestId=randomBytes(32).toString('base64url'),key='1'.repeat(64),selected=await selectPurposeModel(definitionHash),{sessionId,admissionNonce}=selected;
    await db.query("INSERT INTO connected_accounts(id,owner_member_id,connector_id,provider_issuer,provider_subject,provider_label,status) VALUES('purpose-account','member-a','example','https://issuer.invalid','purpose-subject','Example','ok')");
    const selection={actorMemberId:'member-a',agentId:'helper',incarnation,sessionId,originalTurnId:'turn-1',originalCallId:'purpose-original-call',accountId:'purpose-account',accountGeneration:0,resourceBindingId:'purpose-mailbox',connectorId:'example',kind:'mail.send' as const};
    const actions=new PgPersonalActionStore(db,{encrypt:s=>encryptSecret(s,key),decrypt:s=>decryptSecret(s,key)});
    const action=await actions.prepareAction({...selection,payload:{to:['recipient@example.invalid'],subject:'Approval fixture',body:'Private fixture'}});
    await db.query(`INSERT INTO approval_asks(call_id,request_id,agent,tool,payload_hash,original_authority,acting_member_id,resolved_by_member_id,session_id,outcome,answered_at)
      VALUES($1,$2,'helper',$3,$4,$5::jsonb,'member-a','member-a',$6,'approved',clock_timestamp())`,
      [selection.originalCallId,requestId,PERSONAL_MAIL_SEND_TOOL,action.payloadHash,JSON.stringify(personalActionApprovalDescriptor(action,selection,h('purpose-policy'))),selection.sessionId]);
    await actions.attachApproval({actionId:action.actionId,actorMemberId:'member-a',approvalCallId:selection.originalCallId,requestId});
    const originalContext=context(),humanAuth={...originalContext.session.auth.current,attributes:{...originalContext.session.auth.current.attributes,lares_admission_nonce:admissionNonce}};
    const human={session:{...originalContext.session,id:sessionId,auth:{current:humanAuth,initiator:humanAuth}}},resume={session:{...human.session,turn:{id:'',sequence:1},auth:{initiator:human.session.auth.initiator,current:{authenticator:'lares-console',attributes:{lares_resolver_member_id:'member-a',lares_resume_request_id:requestId,lares_resume_option:'approve',lares_purpose:'resolver'}}}}};
    expect(resume.session.auth.current).not.toBe(resume.session.auth.initiator);
    const bound=await requireConsoleSessionBinding({agent:'helper',incarnation,sessionId,memberId:'member-a',admissionNonce},db,env());
    const purposeFiles=purposeBrokerFiles();let stop:(()=>Promise<void>)|undefined;
    try{
      stop=await startPurposeBroker(purposeFiles,files.writer);
      const request=purposeRequest({session:sessionId,admissionNonce,policyRevision:bound.policyRevision,definitionHash,purpose:'resume',resume:{requestId,optionId:'approve'}});
      const pendingReceipt=await purposeRequestAdmission(purposeFiles,request);
      const turn=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('turn.open',{pendingReceipt,context:resume},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(turn.ok).toBe(true);
      // Run the actual pinned Eve coordinator to obtain its approval continuation event.
      // Its resolver context normalizes to turn_1 while the emitted event has raw turnId ''.
      const eveRoot=new URL('../../chief-of-staff/node_modules/eve/dist/src/',import.meta.url);
      const [{ContextContainer,contextStorage},keys,{sessionProvider},{createToolLoopHarness}]=await Promise.all([
        import(new URL('context/container.js',eveRoot).href),import(new URL('context/keys.js',eveRoot).href),
        import(new URL('context/providers/session.js',eveRoot).href),import(new URL('harness/tool-loop.js',eveRoot).href),
      ]) as any;
      const humanAuth=human.session.auth.initiator,resolverAuth={...resume.session.auth.current,attributes:{...resume.session.auth.current.attributes,
        lares_model_purpose_required:'1',lares_model_pending_receipt:pendingReceipt}},contextStore=new ContextContainer();
      contextStore.set(keys.AuthKey,resolverAuth);contextStore.set(keys.InitiatorAuthKey,humanAuth);contextStore.set(keys.SessionIdKey,human.session.id);
      const harnessSession={agent:{dynamicModel:true,system:'',tools:[]},compaction:{recentWindowSize:10,threshold:100_000},
        continuationToken:'eve:budget-purpose-resume',history:[],sessionId:human.session.id,state:{
          'eve.harness.emission':{sessionStarted:true,sequence:1,stepIndex:0,turnId:''},
          'eve.runtime.pendingInputBatches':[{event:{sequence:0,stepIndex:0,turnId:'turn_0'},requests:[{kind:'tool-approval',requestId,
            prompt:'Approval fixture',options:[{id:'approve',label:'Approve'},{id:'cancel',label:'Cancel'}],
            action:{kind:'tool-call',callId:selection.originalCallId,toolName:PERSONAL_MAIL_SEND_TOOL,input:{}}}],responseMessages:[],responseAuthRequiredRequestIds:[requestId]}],
        }};
      contextStore.set(keys.SessionKey,sessionProvider.create(contextStore,{state:harnessSession.state}).value);
      const emitted:Array<{type:string;data?:any}>=[];
      const harness=createToolLoopHarness({mode:'conversation',tools:new Map([[PERSONAL_MAIL_SEND_TOOL,{description:'Fixture',inputSchema:{type:'object'},approval:{response:async()=>({status:'allowed'})}}]]),
        handleEvent:async(event:{type:string;data?:unknown})=>{emitted.push(event as never);},resolveModel:async()=>{throw new Error('No provider expected');},
        dispatchDynamicModelEvent:async({event}:{event:{type:string;data?:any}})=>{emitted.push(event);throw new Error('Stop after actual SDK event');}});
      const approvalInput={attributedInputResponses:[{auth:resolverAuth,response:{requestId,optionId:'approve'}}]};
      const first=await contextStorage.run(contextStore,()=>harness(harnessSession,approvalInput));
      expect(typeof first.next).toBe('function');
      const second=await contextStorage.run(contextStore,()=>first.next!(first.session));
      expect(second.next).toMatchObject({done:true});
      const event=emitted.find(value=>value.type==='step.started');
      expect(event).toMatchObject({type:'step.started',data:{turnId:'',sequence:1,stepIndex:0}});
      const claimed=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('step.claim',{
        turnCapability:turn.capability,purposeAlias:'standard',event,
      },purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(claimed.ok).toBe(true);
      const body=Buffer.from('{"model":"standard","messages":[]}'),identity={method:'POST',path:'/v1/chat/completions',requestHash:gatewayRawRequestHash('POST','/v1/chat/completions',body)};
      const consumed=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('step.consume',{claim:claimed.claim,request:identity},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(consumed).toMatchObject({ok:true,ticket:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)});
      const reference=(await db.query('SELECT authority_reference FROM budget_attempts')).rows[0].authority_reference;
      expect(reference).toMatchObject({kind:'resume',binding:{memberId:'member-a',agent:'helper',incarnation},turnId:'',turnSequence:1,resume:{requestId,optionId:'approve'}});
      const close=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('turn.close',{turnCapability:turn.capability,turnId:'',sequence:1},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(close.ok).toBe(true);
      const duplicate=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('step.consume',{claim:claimed.claim,request:identity},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(duplicate.ok).toBe(false);
      expect((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n).toBe(1);
    }finally{await stop?.();rmSync(purposeFiles.root,{recursive:true,force:true});}
  });
  it('rolls back and withholds the ticket when the turn closes and socket aborts before COMMIT',async()=>{
    const definitionHash=h('model-purpose-precommit-abort'),selected=await selectPurposeModel(definitionHash),{sessionId,admissionNonce}=selected;
    const bound=await requireConsoleSessionBinding({agent:'helper',incarnation,sessionId,memberId:'member-a',admissionNonce},db,env());
    const purposeFiles=purposeBrokerFiles();let stop:(()=>Promise<void>)|undefined,capability='',pendingSocket:ReturnType<typeof createConnection>|undefined,armed=false;
    const consumerPool={query:db.query.bind(db),connect:async()=>{
      const client=await db.connect();
      return {release:(error?:boolean)=>client.release(error),query:async(sql:string,values?:unknown[])=>{
        const result=await client.query(sql,values);
        if(armed&&sql.includes('INSERT INTO budget_financial_checkpoints')){
          armed=false;
          const closed=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('turn.close',{turnCapability:capability,turnId:'turn-1',sequence:0},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
          expect(closed.ok).toBe(true);
          pendingSocket?.destroy();
          await new Promise<void>(resolve=>setImmediate(resolve));
        }
        return result;
      }};
    }} as unknown as Pool;
    try{
      stop=await startPurposeBroker(purposeFiles,files.writer,consumerPool);
      const request=purposeRequest({session:sessionId,admissionNonce,policyRevision:bound.policyRevision,definitionHash});
      const pending=await purposeRequestAdmission(purposeFiles,request);
      const original=context(),humanAuth={...original.session.auth.current,attributes:{...original.session.auth.current.attributes,lares_admission_nonce:admissionNonce}};
      const humanContext={session:{...original.session,id:sessionId,auth:{current:humanAuth,initiator:humanAuth}}};
      const turn=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('turn.open',{pendingReceipt:pending,context:humanContext},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(turn.ok).toBe(true);capability=String(turn.capability);
      const event={type:'step.started',data:{turnId:'turn-1',sequence:0,stepIndex:0}};
      const claimed=await purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('step.claim',{turnCapability:capability,purposeAlias:'standard',event},purposeFiles.runtimeKey),purposeFiles.runtimeKey);
      expect(claimed.ok).toBe(true);
      const rawBody=Buffer.from('{"model":"standard","messages":[]}'),identity={method:'POST',path:'/v1/chat/completions',requestHash:gatewayRawRequestHash('POST','/v1/chat/completions',rawBody)};
      armed=true;
      const pendingConsume=purposeSocketRequest(purposeFiles.runtimeSocket,purposeRuntimeEnvelope('step.consume',{claim:claimed.claim,request:identity},purposeFiles.runtimeKey),purposeFiles.runtimeKey,
        socket=>{pendingSocket=socket;});
      await expect(pendingConsume).rejects.toThrow('socket closed before response');
      expect((await db.query('SELECT count(*)::int AS n FROM budget_attempts')).rows[0].n).toBe(0);
      const records=files.records(),preparedIds=records.filter(frame=>frame.record.kind==='begin'&&frame.record.operation==='prepare').map(frame=>frame.record.operationId);
      expect(preparedIds).toHaveLength(1);
      expect(records.some(frame=>frame.record.kind==='commit'&&preparedIds.includes(frame.record.operationId))).toBe(false);
      expect(records.some(frame=>frame.record.kind==='abort'&&preparedIds.includes(frame.record.operationId))).toBe(true);
    }finally{await stop?.();rmSync(purposeFiles.root,{recursive:true,force:true});}
  });
  function lostCommit(nth:number):Pool {
    let commits=0;
    return {query:(text:string,values?:unknown[])=>db.query(text,values),connect:async()=>{
      const client=await db.connect();return {release:(broken?:boolean)=>client.release(broken),query:async(text:string,values?:unknown[])=>{const value=await client.query(text,values);if(text==='COMMIT'&&++commits===nth)throw new Error('lost commit acknowledgement');return value;}};
    }} as unknown as Pool;
  }
  it('derives identities from the ticket, durably binds an allow, and burns lost replies',async()=>{
    const a=await allowed();expect((await db.query('SELECT count(*)::int n FROM budget_gateway_grants')).rows[0].n).toBe(1);
    expect((await rpc(a.selected,GATEWAY_ADMIT_PATH,a.request)).reply.status).toBe(503);
    expect((await rpc(authority(),GATEWAY_ADMIT_PATH,{...a.request,nonce:h('replay')})).reply.status).toBe(503);
    expect((await store.readStatus(context())).liability).toBe('0.1');
    const rows=(await db.query('SELECT * FROM budget_gateway_grants')).rows;
    expect(Object.keys(rows[0]).sort()).toEqual(['attempt_id','grant_hash']);expect(JSON.stringify(rows)).not.toMatch(/standard|helper|member-a|keyFingerprint|nonce/);
  });
  it('journals signed admission, grant and settlement through prepared Keeper custody',async()=>{
    const a=await allowed(),receipt=terminal(a.grant);
    expect((await rpc(a.selected,GATEWAY_SETTLE_PATH,receipt)).document.state).toBe('settled');
    const frames=files.records(),proposals=frames.filter(frame=>frame.record.kind==='proposal'),begins=frames.filter(frame=>frame.record.kind==='begin'),commits=frames.filter(frame=>frame.record.kind==='commit');
    expect(begins.map(frame=>frame.record.operation)).toEqual(['provision','prepare','admit','grant','settle']);expect(proposals).toHaveLength(5);
    expect(commits).toHaveLength(5);
    for(const frame of proposals){
      const row=(await db.query('SELECT * FROM budget_financial_checkpoints WHERE operation_id=$1',[frame.record.operationId])).rows[0];
      expect(row).toMatchObject({journal_id:frames.find(value=>value.record.kind==='control').record.control.journalId,proposal_sequence:String(frame.record.sequence),proposal_digest:frame.digest});
    }
    const grant={...a.grant};delete grant.state;delete grant.validForMs;
    expect(proposals.at(-1).record.atoms).toEqual(expect.arrayContaining([expect.objectContaining({kind:'attempt',state:'settled',actualAmount:'0.0098'}),expect.objectContaining({kind:'grant',grantHash:gatewayGrantHash(grant)})]));
  });
  it('refuses settlement without a writer and leaves the admitted liability unchanged',async()=>{
    const a=await allowed(),before=(await db.query('SELECT state,actual_amount FROM budget_attempts')).rows[0];
    const closed=new GatewayBudgetAuthority(db,serviceKey,undefined,witness);
    expect((await rpc(closed,GATEWAY_SETTLE_PATH,terminal(a.grant))).reply.status).toBe(503);
    expect((await db.query('SELECT state,actual_amount FROM budget_attempts')).rows[0]).toEqual(before);
    expect((await store.readStatus(context())).liability).toBe('0.1');
  });
  it.each([1,2])('retains R without issuing allow after lost transaction %s acknowledgement',async which=>{
    const p=await prepared(),request=admitDocument(p);
    expect((await rpc(authority(lostCommit(which)),GATEWAY_ADMIT_PATH,request)).reply.status).toBe(503);
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('admitted');
    expect((await db.query('SELECT count(*)::int n FROM budget_gateway_grants')).rows[0].n).toBe(which===2?1:0);
    expect((await rpc(authority(),GATEWAY_ADMIT_PATH,request)).reply.status).toBe(503);
    expect((await store.readStatus(context())).liability).toBe('0.1');
  });
  it('admits only once concurrently and cannot issue another grant for an admitted attempt',async()=>{
    const p=await prepared(),request=admitDocument(p),selected=authority();
    const results=await Promise.all([rpc(selected,GATEWAY_ADMIT_PATH,request),rpc(selected,GATEWAY_ADMIT_PATH,request)]);
    expect(results.map(r=>r.reply.status).sort()).toEqual([200,503]);
    const a=(await db.query('SELECT * FROM budget_attempts')).rows[0];
    expect(await store.recordGatewayGrant({attemptId:a.id,bindingId:a.binding_id,requestHash:a.request_hash},h('another grant'))).toBe(false);
  });
  it('serializes the shared cap across distinct simultaneous signed tickets',async()=>{
    await journalGatewayFixture(files.writer,async source=>{
      await source.query('UPDATE budget_accounts SET installation_cap=0.1 WHERE id=$1',[installation]);
      noteBudgetFinancialChange(source,'budget_accounts',installation);
    });
    const p=await prepared(),q=await prepared('member-b');
    const results=await Promise.all([rpc(authority(),GATEWAY_ADMIT_PATH,admitDocument(p)),rpc(authority(),GATEWAY_ADMIT_PATH,admitDocument(q))]);
    expect(results.map(r=>r.reply.status).sort()).toEqual([200,503]);
  });
  it('freshly denies revoked authority rather than trusting ticket discovery',async()=>{
    const p=await prepared();await db.query("UPDATE console_session_bindings SET revoked_at=clock_timestamp() WHERE member_id='member-a'");
    expect((await rpc(authority(),GATEWAY_ADMIT_PATH,admitDocument(p))).reply.status).toBe(503);
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('retired');
  });
  it('keeps production closed without a real witness, even when the database says open',async()=>{
    const p=await prepared(),request=admitDocument(p),raw=gatewayCanonical(request);
    for(const selected of [new GatewayBudgetAuthority(db,serviceKey,files.writer),productionGatewayBudgetAuthority(db,undefined,files.journal)])expect((await selected.handle(GATEWAY_ADMIT_PATH,gatewaySignature(serviceKey,'request',GATEWAY_ADMIT_PATH,raw),raw)).status).toBe(503);
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('prepared');
  });
  it('returns unavailable by its whole-call deadline when an injected witness stalls',async()=>{
    const p=await prepared(),request=admitDocument(p),raw=gatewayCanonical(request),before=performance.now();
    const selected=authority(db,{observe:()=>new Promise(()=>{})});
    expect((await selected.handle(GATEWAY_ADMIT_PATH,gatewaySignature(serviceKey,'request',GATEWAY_ADMIT_PATH,raw),raw,performance.now()+30)).status).toBe(503);
    expect(performance.now()-before).toBeLessThan(300);
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('prepared');
  });
  it.each(['proposal','control'] as const)('does not allow when the journal %s fsync fails',async failure=>{
    const p=await prepared(),request=admitDocument(p),directory=files.directory;
    files.journal.close();files=await gatewayCustody(db,failure,directory);
    const selected=authority(db,witness,files.writer);
    expect((await rpc(selected,GATEWAY_ADMIT_PATH,request)).reply.status).toBe(503);
    const state=(await db.query('SELECT state FROM budget_attempts')).rows[0].state;
    expect(state).toBe(failure==='control'?'admitted':'prepared');
    expect((await db.query('SELECT count(*)::int n FROM budget_gateway_grants')).rows[0].n).toBe(0);
    expect((await rpc(selected,GATEWAY_ADMIT_PATH,request)).reply.status).toBe(503);
    if(failure==='control')expect((await store.readStatus(context())).liability).toBe('0.1');
  });
  it.each([{epoch:'later-epoch'},{state:'unreconciled'},{endpointGeneration:'1'}])('cannot allow restored or unreconciled witness state %#',async changes=>{
    const p=await prepared(),selected=authority(db,{observe:async()=>({...recovery(),...changes}) as ReturnType<typeof recovery>});
    expect((await rpc(selected,GATEWAY_ADMIT_PATH,admitDocument(p))).reply.status).toBe(503);
    expect((await db.query("SELECT count(*)::int n FROM budget_attempts WHERE state='admitted'")).rows[0].n).toBe(0);
  });
  it('refuses missing or mismatched immutable reviewed pricing',async()=>{
    const old=bindings['member-a:helper'],next=randomUUID();
    await journalGatewayFixture(files.writer,async source=>{
      await source.query("UPDATE budget_gateway_bindings SET state='revoked' WHERE id=$1",[old]);noteBudgetFinancialChange(source,'budget_gateway_bindings',old);
      await source.query(`INSERT INTO budget_gateway_bindings SELECT(jsonb_populate_record(NULL::budget_gateway_bindings,to_jsonb(b)||jsonb_build_object('id',$2::text,'state','active','pricing_profile',NULL))).* FROM budget_gateway_bindings b WHERE id=$1`,[old,next]);noteBudgetFinancialChange(source,'budget_gateway_bindings',next);
    });
    bindings['member-a:helper']=next;
    const p=await prepared();expect((await rpc(authority(),GATEWAY_ADMIT_PATH,admitDocument(p))).reply.status).toBe(503);
    await expect(db.query('UPDATE budget_gateway_bindings SET pricing_profile=$2::jsonb WHERE id=$1',[next,JSON.stringify(pricing)])).rejects.toThrow('immutable');
  });
  it.each([{maximum_liability:'0.09'},{pricing_profile:{...pricing,capabilityHash:h('unrelated capability')}}])('refuses a price maximum or capability mismatch %#',async change=>{
    const old=bindings['member-a:helper'],next=randomUUID();
    await journalGatewayFixture(files.writer,async source=>{
      await source.query("UPDATE budget_gateway_bindings SET state='revoked' WHERE id=$1",[old]);noteBudgetFinancialChange(source,'budget_gateway_bindings',old);
      await source.query(`INSERT INTO budget_gateway_bindings SELECT(jsonb_populate_record(NULL::budget_gateway_bindings,to_jsonb(b)||$3::jsonb||jsonb_build_object('id',$2::text,'state','active'))).* FROM budget_gateway_bindings b WHERE id=$1`,[old,next,JSON.stringify(change)]);noteBudgetFinancialChange(source,'budget_gateway_bindings',next);
    });
    bindings['member-a:helper']=next;const p=await prepared();expect((await rpc(authority(),GATEWAY_ADMIT_PATH,admitDocument(p))).reply.status).toBe(503);
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('prepared');
  });
  it('uses immutable Anthropic pricing for its separate native cache categories',async()=>{
    const old=bindings['member-a:helper'],next=randomUUID(),anthropic={...pricing,format:'anthropic',usdPerMillionTokens:{...pricing.usdPerMillionTokens,output:'80',cacheWrite:'20'}};
    await journalGatewayFixture(files.writer,async source=>{
      await source.query("UPDATE budget_gateway_bindings SET state='revoked' WHERE id=$1",[old]);noteBudgetFinancialChange(source,'budget_gateway_bindings',old);
      await source.query(`INSERT INTO budget_gateway_bindings SELECT(jsonb_populate_record(NULL::budget_gateway_bindings,to_jsonb(b)||jsonb_build_object('id',$2::text,'state','active','pricing_profile',$3::jsonb))).* FROM budget_gateway_bindings b WHERE id=$1`,[old,next,JSON.stringify(anthropic)]);noteBudgetFinancialChange(source,'budget_gateway_bindings',next);
    });
    bindings['member-a:helper']=next;const a=await allowed();
    expect((await rpc(a.selected,GATEWAY_SETTLE_PATH,terminal(a.grant,100,{format:'anthropic',usage:{inputTokens:100,outputTokens:100,cacheReadTokens:40,cacheWriteTokens:20}}))).document.state).toBe('settled');
    expect((await db.query('SELECT actual_amount FROM budget_attempts')).rows[0].actual_amount).toBe('0.0096');
  });
  it('retains the reservation when the reply deadline expires after the grant commits',async()=>{
    let commits=0;
    const slow={query:(text:string,values?:unknown[])=>db.query(text,values),connect:async()=>{
      const client=await db.connect();return {release:(broken?:boolean)=>client.release(broken),query:async(text:string,values?:unknown[])=>{const r=await client.query(text,values);if(text==='COMMIT'&&++commits===2)await new Promise(resolve=>setTimeout(resolve,150));return r;}};
    }} as unknown as Pool;
    const p=await prepared(),request=admitDocument(p),raw=gatewayCanonical(request);
    expect((await authority(slow).handle(GATEWAY_ADMIT_PATH,gatewaySignature(serviceKey,'request',GATEWAY_ADMIT_PATH,raw),raw,performance.now()+100)).status).toBe(503);
    expect((await db.query('SELECT count(*)::int n FROM budget_gateway_grants')).rows[0].n).toBe(1);
    expect((await store.readStatus(context())).liability).toBe('0.1');
    expect((await rpc(authority(),GATEWAY_ADMIT_PATH,request)).reply.status).toBe(503);
  });
  it('freezes financial custody after a lost settlement acknowledgement',async()=>{
    const selected=authority(lostCommit(3)),a=await allowed(selected),receipt=terminal(a.grant);
    expect((await rpc(selected,GATEWAY_SETTLE_PATH,receipt)).reply.status).toBe(503);
    expect((await db.query('SELECT state,actual_amount FROM budget_attempts')).rows[0]).toMatchObject({state:'settled',actual_amount:'0.0098'});
    expect(files.records().filter(frame=>frame.record.kind==='commit')).toHaveLength(4);
    expect(files.records().at(-1).record.kind).toBe('freeze');
    expect((await rpc(authority(),GATEWAY_SETTLE_PATH,receipt)).reply.status).toBe(503);
    expect((await rpc(authority(),GATEWAY_SETTLE_PATH,terminal(a.grant,200))).reply.status).toBe(503);
    expect((await db.query('SELECT state FROM budget_accounts WHERE id=$1',[installation])).rows[0].state).toBe('open');
  });
  it('preserves valid financial overages above reviewed bounds and freezes the installation',async()=>{
    const a=await allowed();expect((await rpc(a.selected,GATEWAY_SETTLE_PATH,terminal(a.grant,2000))).document.state).toBe('conflict');
    expect((await db.query('SELECT actual_amount,highest_observed_liability FROM budget_attempts')).rows[0]).toEqual({actual_amount:'0.1808',highest_observed_liability:'0.1808'});
    expect((await db.query('SELECT state FROM budget_accounts WHERE id=$1',[installation])).rows[0].state).toBe('frozen');
  });
  it('retains late exact grant correlation after rotation, old-window carry and member erasure',async()=>{
    const a=await allowed();await gatewayPreparedStore!.markUnknown(a.grant.attemptId);
    await journalGatewayFixture(files.writer,async source=>{
      await source.query("UPDATE budget_gateway_bindings SET state='revoked' WHERE id=$1",[a.grant.bindingId]);
      noteBudgetFinancialChange(source,'budget_gateway_bindings',a.grant.bindingId);
    });
    await journalGatewayWindow(files.writer,installation,null);await journalGatewayWindow(files.writer,accounts['member-a']!,'member-a');
    expect((await store.readStatus(context())).liability).toBe('0.1');
    await files.writer.run('member-remove',boundary=>consoleSourceTransaction(db as unknown as SourcePool,async source=>{
      for(const table of ['budget_accounts','budget_windows','budget_gateway_bindings','budget_attempts'] as const){
        const rows=await source.query(`SELECT id FROM ${table} WHERE live_member_id=$1`,['member-a']);
        for(const row of rows.rows)noteBudgetFinancialChange(source,table,row.id);
      }
      await source.query("DELETE FROM users WHERE id='member-a'");
    },boundary));
    const binding=(await db.query('SELECT key_fingerprint,purpose_alias,pricing_profile FROM budget_gateway_bindings WHERE id=$1',[a.grant.bindingId])).rows[0];
    expect(binding).toMatchObject({key_fingerprint:null,purpose_alias:null,pricing_profile:pricing});
    for(const changes of [{nonce:h('different nonce')},{purposeAlias:'different'},{keyFingerprint:h('different key')},{endpointHash:h('different endpoint')},{bindingId:randomUUID()},{profileHash:h('different profile')}])expect((await rpc(authority(),GATEWAY_SETTLE_PATH,terminal(a.grant,100,changes))).reply.status).toBe(503);
    expect((await db.query('SELECT state,reserved_amount FROM budget_attempts')).rows[0]).toEqual({state:'unknown',reserved_amount:'0.1'});
    expect((await rpc(authority(),GATEWAY_SETTLE_PATH,terminal(a.grant))).document.state).toBe('settled');
    expect((await db.query('SELECT a.state,a.installation_window_id<>i.active_window_id AS old_window FROM budget_attempts a JOIN budget_accounts i ON i.id=a.installation_account_id')).rows[0]).toEqual({state:'settled',old_window:true});
  });
  it('rejects forged totals, nondispatch refunds, invalid usage and mismatched receipt hashes',async()=>{
    const a=await allowed();
    for(const change of [{actualAmount:'0'},{kind:'affirmative-nondispatch'},{usage:{inputTokens:10,outputTokens:0,cacheReadTokens:11,cacheWriteTokens:0}},{receiptHash:h('wrong')}]){
      const receipt=terminal(a.grant,100,change);if('receiptHash'in change)receipt.receiptHash=change.receiptHash;
      expect((await rpc(authority(),GATEWAY_SETTLE_PATH,receipt)).reply.status).toBe(503);
    }
    expect((await store.readStatus(context())).liability).toBe('0.1');
  });
  it('reapplies all ordered SQL without altering opaque grants, prices or reservations',async()=>{
    const a=await allowed(),before=(await db.query('SELECT * FROM budget_gateway_grants')).rows;
    for(const [index,owner] of ['member-a','member-b'].entries()){
      const accountId=randomUUID(),operationId=randomUUID(),encrypted=Buffer.from(encryptSecret(`outside custody reapply ${owner}`,'4'.repeat(64)),'base64');
      await db.query(`INSERT INTO outside_custody_accounts(account_id,owner_member_id,resource_id,connection_name,generation,active_revision,consent_generation,state)
        VALUES($1,$2,$3,$4,1,1,1,'active')`,[accountId,owner,index===0?'helper':'helper-two',`reapply-${index}`]);
      await db.query(`INSERT INTO outside_custody_revisions(account_id,owner_member_id,credential_revision,generation,consent_generation,revision_purpose,policy_json,policy_hash,operation_id,nonce,ciphertext)
        VALUES($1,$2,1,1,1,'discovery',$3::jsonb,$4,$5,$6,$7)`,[accountId,owner,OUTSIDE_CUSTODY_FIXTURE_POLICY_JSON,OUTSIDE_CUSTODY_FIXTURE_POLICY_HASH,operationId,encrypted.subarray(0,12),encrypted.subarray(12)]);
      await db.query(`INSERT INTO outside_custody_operations(operation_id,account_id,owner_member_id,operation_kind,request_hash,expected_generation,result_generation,credential_revision,outcome)
        VALUES($1,$2,$3,'stage',$4,0,1,1,'staged')`,[operationId,accountId,owner,createHash('sha256').update(`outside custody reapply ${index}`).digest()]);
    }
    const custodyBefore=await Promise.all([
      db.query('SELECT * FROM outside_custody_accounts ORDER BY owner_member_id'),
      db.query('SELECT * FROM outside_custody_revisions ORDER BY owner_member_id'),
      db.query('SELECT * FROM outside_custody_operations ORDER BY owner_member_id'),
    ]);
    // Baseline runs once through the runner; later additive migrations support reapply.
    for(const file of readdirSync(sql).filter(f=>f.endsWith('.sql')&&f!=='001_baseline.sql').sort())await db.query(readFileSync(new URL(file,sql),'utf8'));
    expect((await db.query('SELECT * FROM budget_gateway_grants')).rows).toEqual(before);
    const custodyAfter=await Promise.all([
      db.query('SELECT * FROM outside_custody_accounts ORDER BY owner_member_id'),
      db.query('SELECT * FROM outside_custody_revisions ORDER BY owner_member_id'),
      db.query('SELECT * FROM outside_custody_operations ORDER BY owner_member_id'),
    ]);
    expect(custodyAfter.map(result=>result.rows)).toEqual(custodyBefore.map(result=>result.rows));
    for(const text of ["UPDATE budget_gateway_grants SET grant_hash=repeat('a',64)",'DELETE FROM budget_gateway_grants',"UPDATE budget_gateway_bindings SET pricing_profile='{}'"])await expect(db.query(text)).rejects.toThrow('immutable');
    expect((await rpc(authority(),GATEWAY_SETTLE_PATH,terminal(a.grant))).document.state).toBe('settled');
  });
});
describe('inactive journal-owned financial transactions on real PostgreSQL',()=>{
  const expectUncertainHistory=(kind:'begin'|'proposal')=>{
    const records=files.records(),firstFreeze=records.findIndex(frame=>frame.record.kind==='freeze');
    expect(firstFreeze).toBeGreaterThanOrEqual(0);
    const freezeTail=records.slice(firstFreeze);
    expect(freezeTail.length).toBeGreaterThan(0);
    expect(freezeTail.every(frame=>frame.record.kind==='freeze')).toBe(true);
    for(const frame of freezeTail)expect(frame.record).toMatchObject({kind:'freeze',reason:'uncertain'});
    expect(records.slice(0,firstFreeze).at(-1)?.record.kind).toBe(kind);
    expect(records.some(frame=>frame.record.kind==='commit'||frame.record.kind==='abort')).toBe(false);
  };
  let files:ReturnType<typeof journalFixture>,journal:HostFinancialJournal,writer:JournalBudgetFinancialWriter,selected:PgBudgetAdmissionStore;
  let faultKind:'proposal'|'commit'|undefined,delayProposal=false;
  beforeEach(()=>{
    faultKind=undefined;delayProposal=false;
    files=journalFixture({sync:fd=>{
      fsyncSync(fd);const kind=files.records().at(-1)?.record.kind;
      if(kind===faultKind)throw new Error('synthetic fsync failure');
      if(delayProposal&&kind==='proposal')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);
    }});
    journal=files.open();writer=new JournalBudgetFinancialWriter(journal);selected=new PgBudgetAdmissionStore(db,env(),30_000,writer);
  });
  afterEach(()=>{faultKind=undefined;journal.close();rmSync(files.directory,{recursive:true,force:true});});
  const preparedOwned=()=>prepared('member-a','helper',selected);
  function loseAck(command:'BEGIN'|'COMMIT'|'ROLLBACK'){
    let releasedBroken:unknown;
    db.once('release',error=>{releasedBroken=error;});
    // Fault the ACTUAL checked-out PoolClient. Ownership and pool-one behavior remain
    // real; no fake pool/client is lent to the transaction owner.
    db.once('acquire',client=>{
      const original=client.query;
      client.query=(async function(this:typeof client,...args:any[]){
        const result=await (original as any).apply(this,args);
        if(args[0]===command){client.query=original;throw new Error('synthetic lost acknowledgement');}
        return result;
      }) as typeof client.query;
    });
    return ()=>releasedBroken;
  }
  async function expiringFinancialWrite(){
    const p=await prepared(),attempt=(await db.query('SELECT id FROM budget_attempts WHERE ticket_hash=$1',[h(p.ticket)])).rows[0].id;
    const c=context(),reference={agent:'helper',incarnation,sessionId:c.session.id,memberId:'member-a',admissionNonce:nonce('member-a')};
    delayProposal=true;
    await writer.run('admit',boundary=>consoleSourceTransaction(db,async client=>{
      await requireConsoleSessionBinding(reference,client,env());
      const deadline=(await client.query("SELECT(clock_timestamp()+interval '300 milliseconds')::text deadline")).rows[0].deadline;
      retainConsoleSourceDeadline(client,reference,deadline);
      await client.query("UPDATE budget_attempts SET state='admitted',admitted_at=clock_timestamp() WHERE id=$1",[attempt]);noteBudgetFinancialChange(client,'budget_attempts',attempt);
      return 'must never escape';
    },boundary));
  }
  it('journals actual store prepare/admit/grant/unknown/settle atoms and matching same-TX checkpoints',async()=>{
    const p=await preparedOwned(),a=await selected.admit(p.ticket,p.observation,recovery());expect(a.state).toBe('allowed');if(a.state!=='allowed')throw new Error('denied');
    const consumed=consumeDispatchPermit(a.permit)!;expect(await selected.recordGatewayGrant(consumed,h('opaque-grant'))).toBe(true);
    await selected.markUnknown(a.attemptId);
    expect(await selected.settle({attemptId:a.attemptId,bindingId:p.bindingId,requestHash:p.observation.requestHash,profileHash:profile,endpointHash:endpoint,credentialGeneration:'0',receiptHash:h('opaque-receipt'),actualAmount:'0.05',kind:'terminal-usage'})).toBe('settled');
    const records=files.records(),proposals=records.filter(f=>f.record.kind==='proposal'),commits=records.filter(f=>f.record.kind==='commit');expect(proposals).toHaveLength(5);expect(commits).toHaveLength(5);
    for(const p of proposals){
      const row=(await db.query('SELECT * FROM budget_financial_checkpoints WHERE operation_id=$1',[p.record.operationId])).rows[0];
      expect(row).toMatchObject({journal_id:files.journalId,proposal_sequence:String(p.record.sequence),proposal_digest:p.digest});
    }
    const serialized=JSON.stringify(records);expect(serialized).not.toMatch(/member-a|helper|authority_reference|authority_hash|ticket_hash|admission_nonce|native_user|native_team|key_fingerprint|purpose_alias|session-/);
    expect(proposals.at(-1).record.atoms).toEqual(expect.arrayContaining([expect.objectContaining({kind:'attempt',state:'settled',actualAmount:'0.05'}),expect.objectContaining({kind:'grant',grantHash:h('opaque-grant')}),expect.objectContaining({kind:'binding',pricingProfile:pricing}),expect.objectContaining({kind:'account',canonicalSuppressionHash:expect.stringMatching(/^[a-f0-9]{64}$/)})]));
  });
  it('aborts only after acknowledged rollback and remains usable for a later operation',async()=>{
    const p=await prepared(),attempt=(await db.query('SELECT id FROM budget_attempts')).rows[0].id;
    await expect(writer.run('admit',boundary=>consoleSourceTransaction(db,async client=>{
      await client.query("UPDATE budget_attempts SET state='admitted',admitted_at=clock_timestamp() WHERE id=$1",[attempt]);noteBudgetFinancialChange(client,'budget_attempts',attempt);throw new Error('ordinary work failure');
    },boundary))).rejects.toThrow('ordinary work failure');
    expect(files.records().at(-1).record).toMatchObject({kind:'abort',reason:'rollback-acknowledged',proposalDigest:null});
    expect((await selected.admit(p.ticket,p.observation,recovery())).state).toBe('allowed');
  });
  it('rechecks source expiry after proposal fsync/checkpoint, rolls back finances and commits only revocation',async()=>{
    await expect(expiringFinancialWrite()).rejects.toThrow('Conversation authority');
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('prepared');expect((await db.query('SELECT * FROM budget_financial_checkpoints')).rows).toEqual([]);
    expect((await db.query("SELECT revoked_at IS NOT NULL revoked FROM console_session_bindings WHERE member_id='member-a' AND agent='helper'")).rows[0].revoked).toBe(true);
    expect(files.records().at(-1).record).toMatchObject({kind:'abort',reason:'source-retirement-acknowledged',proposalDigest:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(files.records().some(f=>f.record.kind==='commit')).toBe(false);
  });
  it('keeps an unacknowledged financial COMMIT frozen, never returning a permit',async()=>{
    const p=await prepared(),broken=loseAck('COMMIT');
    expect((await selected.admit(p.ticket,p.observation,recovery())).state).toBe('unavailable');expect(broken()).toBeTruthy();
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('admitted');expect((await db.query('SELECT * FROM budget_financial_checkpoints')).rows).toHaveLength(1);
    expectUncertainHistory('proposal');
    await expect(selected.markUnknown((await db.query('SELECT id FROM budget_attempts')).rows[0].id)).rejects.toThrow('closed');
    journal.close();expect(()=>files.open()).toThrow('unavailable');
  });
  it('does not turn an uncertain BEGIN into a known abort after cleanup',async()=>{
    const p=await prepared(),broken=loseAck('BEGIN');expect((await selected.admit(p.ticket,p.observation,recovery())).state).toBe('unavailable');
    expect(broken()).toBeTruthy();expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('prepared');
    expectUncertainHistory('begin');expect(files.records().some(f=>f.record.kind==='proposal')).toBe(false);
    journal.close();expect(()=>files.open()).toThrow('unavailable');
  });
  it('records a known not-started abort when the actual pool refuses checkout',async()=>{
    const p=await prepared(),closedPool=quiet(new Pool({connectionString:container.getConnectionUri(),max:1}));await closedPool.end();
    const unavailable=new PgBudgetAdmissionStore(closedPool,env(),30_000,writer);expect((await unavailable.admit(p.ticket,p.observation,recovery())).state).toBe('unavailable');
    expect(files.records().at(-1).record).toMatchObject({kind:'abort',reason:'not-started',proposalDigest:null});
    expect((await selected.admit(p.ticket,p.observation,recovery())).state).toBe('allowed');
  });
  it('does not call a later cleanup ROLLBACK proof that the earlier lost rollback was acknowledged',async()=>{
    const p=await prepared(),attempt=(await db.query('SELECT id FROM budget_attempts')).rows[0].id,broken=loseAck('ROLLBACK');
    await expect(writer.run('admit',boundary=>consoleSourceTransaction(db,async client=>{
      await client.query("UPDATE budget_attempts SET state='admitted',admitted_at=clock_timestamp() WHERE id=$1",[attempt]);noteBudgetFinancialChange(client,'budget_attempts',attempt);throw new Error('work failure');
    },boundary))).rejects.toThrow();
    expect(broken()).toBeTruthy();expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('prepared');
    expectUncertainHistory('begin');expect(files.records().some(f=>f.record.kind==='proposal')).toBe(false);
    expect((await selected.admit(p.ticket,p.observation,recovery())).state).toBe('unavailable');
  });
  it('a lost revoke-only COMMIT never finishes the financial proposal',async()=>{
    // expiringFinancialWrite first prepares outside the adapted transaction. Arm the
    // actual client fault only once its original financial UPDATE starts.
    const originalRun=writer.run.bind(writer);
    writer.run=(async(operation,work)=>{loseAck('COMMIT');return originalRun(operation,work);}) as typeof writer.run;
    await expect(expiringFinancialWrite()).rejects.toThrow('could not be confirmed');
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('prepared');expect((await db.query('SELECT * FROM budget_financial_checkpoints')).rows).toEqual([]);
    expectUncertainHistory('proposal');
    journal.close();expect(()=>files.open()).toThrow('unavailable');
  });
  it.each(['proposal','commit'] as const)('exposes no result after %s fsync failure',async phase=>{
    const p=await prepared();faultKind=phase;
    expect((await selected.admit(p.ticket,p.observation,recovery())).state).toBe('unavailable');faultKind=undefined;
    const row=(await db.query('SELECT state FROM budget_attempts')).rows[0];expect(row.state).toBe(phase==='commit'?'admitted':'prepared');
    expect((await db.query('SELECT * FROM budget_financial_checkpoints')).rows).toHaveLength(phase==='commit'?1:0);
    journal.close();expect(()=>files.open()).toThrow('unavailable');
  });
  it('rejects a missing checkpoint integration before commit and preserves a durable abort',async()=>{
    const p=await prepared();await db.query('ALTER TABLE budget_financial_checkpoints ADD CONSTRAINT financial_test_reject CHECK(false)');
    try{expect((await selected.admit(p.ticket,p.observation,recovery())).state).toBe('unavailable');}finally{await db.query('ALTER TABLE budget_financial_checkpoints DROP CONSTRAINT financial_test_reject');}
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('prepared');expect(files.records().at(-1).record).toMatchObject({kind:'abort',reason:'rollback-acknowledged'});
    expect((await selected.admit(p.ticket,p.observation,recovery())).state).toBe('allowed');
  });
  it('takes its barrier before pool checkout and rejects nesting rather than borrowing another owner',async()=>{
    let resume!:()=>void;const paused=new Promise<void>(resolve=>{resume=resolve;});let checkedOut=0;const observe=()=>{checkedOut++;};db.on('acquire',observe);
    const running=writer.run('unknown',async boundary=>{await paused;return consoleSourceTransaction(db,async client=>{
      await expect(writer.run('unknown',async()=>undefined)).rejects.toThrow('busy');
      await expect(consoleSourceTransaction(client,async()=>undefined,sourceTransactionBoundary({beforeCommit:async()=>{},settled:async()=>{}}))).rejects.toThrow();
      return 42;
    },boundary);});
    try{await expect(selected.markUnknown(randomUUID())).rejects.toThrow('busy');expect(checkedOut).toBe(0);expect(()=>journal.close()).toThrow('still owns');resume();expect(await running).toBe(42);expect(checkedOut).toBe(1);}
    finally{resume();await running.catch(()=>{});db.off('acquire',observe);}
  });
});
describe('inactive budget admission on real PostgreSQL',()=>{
  it('requires an already-owned source transaction for authority capture',async()=>{
    await expect(captureBudgetAuthorityReference(db,context(),env())).rejects.toThrow();
  });
  it('requires registered invocation authority and the actual selected alias',async()=>{
    const request={bindingId:bindings['member-a:helper']!,requestHash:h('request'),profileHash:profile};
    await expect(store.prepareIntent(request)).rejects.toThrow('fresh trusted');
    await expect(prepare(store,context(),request,undefined,'different-alias')).rejects.toThrow('Budget policy unavailable');
    const blank=context();blank.session.turn.id='';await expect(prepare(store,blank,request)).rejects.toThrow();
    expect((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n).toBe(0);
    expect((await store.readStatus(context())).liability).toBe('0');
  });
  it('gives exactly one ticket to concurrent independent processes for the same actual step',async()=>{
    const ctx=context(),coordinates={turnId:'same-turn',sequence:5,stepIndex:2};
    const request={bindingId:bindings['member-a:helper']!,requestHash:h('same-request'),profileHash:profile};
    const results=await Promise.all([coldPrepare(ctx,request,coordinates),coldPrepare(ctx,request,coordinates),coldPrepare(ctx,request,coordinates)]);
    expect(results.filter(r=>r.ticket)).toHaveLength(1);expect(results.filter(r=>r.denied)).toHaveLength(2);
    expect((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n).toBe(1);
  },30_000);
  it.each(['prepared','expired','retired','admitted','unknown','settled','conflict'] as const)('keeps %s invocation suppression across a cold process',async state=>{
    const ctx=context(),coordinates={turnId:'durable-turn',sequence:2,stepIndex:4};
    const request={bindingId:bindings['member-a:helper']!,requestHash:h('durable-request'),profileHash:profile};
    const selected=state==='expired'?new PgBudgetAdmissionStore(db,env(),1):store;
    const ticket=await prepare(selected,ctx,request,coordinates);
    const observation={requestHash:request.requestHash,profileHash:profile,endpointHash:endpoint,credentialGeneration:'0',keyFingerprint:fingerprint,agent:'helper',incarnation,purposeAlias:'standard'};
    if(state==='expired')await new Promise(resolve=>setTimeout(resolve,10));
    if(state==='retired')await db.query("UPDATE budget_attempts SET state='retired'");
    if(['admitted','unknown','settled','conflict'].includes(state)){
      const admitted=await store.admit(ticket,observation,recovery());expect(admitted.state).toBe('allowed');
      if(admitted.state!=='allowed')throw new Error('Fixture admission failed');
      if(state==='unknown')await store.markUnknown(admitted.attemptId);
      if(state==='settled'||state==='conflict')await store.settle({attemptId:admitted.attemptId,bindingId:request.bindingId,requestHash:request.requestHash,endpointHash:endpoint,credentialGeneration:'0',profileHash:profile,receiptHash:h('durable-receipt'),actualAmount:state==='conflict'?'0.2':'0.05',kind:'terminal-usage'});
    }
    expect(await coldPrepare(ctx,{...request,requestHash:h('changed-body')},coordinates)).toEqual({denied:true});
    expect((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n).toBe(1);
  },20_000);
  it('preserves old invocation suppression after revoke/regrant and admits a fresh turn and step',async()=>{
    const ctx=context('member-b'),coordinates={turnId:'before-regrant',sequence:3,stepIndex:1};
    const request={bindingId:bindings['member-b:helper']!,requestHash:h('regrant-request'),profileHash:profile};
    await prepare(store,ctx,request,coordinates);
    const retained=(await db.query('SELECT invocation_hash FROM budget_attempts')).rows[0].invocation_hash;
    const grants=new PgGrantStore(db),access=await grants.agentAccess('member-a','helper');
    const revoked=await grants.updateAgentAccess('member-a',{agentName:'helper',expectedRevision:access!.accessRevision,grants:[]});
    await grants.updateAgentAccess('member-a',{agentName:'helper',expectedRevision:revoked.accessRevision,grants:[{principal:{kind:'organisation',id:'org'},permission:'use',expiresAt:null}]});
    expect(await coldPrepare(ctx,request,coordinates)).toEqual({denied:true});
    await freshConsoleSessions();
    expect(await coldPrepare(context('member-b'),request,{turnId:'fresh-turn',sequence:4,stepIndex:2})).toHaveProperty('ticket');
    expect((await db.query('SELECT invocation_hash FROM budget_attempts')).rows.map(r=>r.invocation_hash)).toContain(retained);
    expect((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n).toBe(2);
  });
  it('does not rearm after alias, key, profile, window and recovery replacement',async()=>{
    const ctx=context(),coordinates={turnId:'rotating-turn',sequence:2,stepIndex:4};
    const request={bindingId:bindings['member-a:helper']!,requestHash:h('request'),profileHash:profile};
    await prepare(store,ctx,request,coordinates);
    const replacement=randomUUID(),changedProfile=h('changed-profile');
    await db.query("UPDATE budget_gateway_bindings SET state='revoked' WHERE id=$1",[request.bindingId]);
    await db.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,purpose_alias,profile_hash,maximum_liability,state)
      SELECT $2,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation+1,$3,agent,incarnation,'changed-alias',$4,maximum_liability,'active' FROM budget_gateway_bindings WHERE id=$1`,[request.bindingId,replacement,h('changed-key'),changedProfile]);
    await window(installation,null);await window(accounts['member-a']!,'member-a');
    await db.query("UPDATE budget_accounts SET recovery_epoch='epoch-2' WHERE id=$1",[installation]);
    expect(await coldPrepare(ctx,{bindingId:replacement,requestHash:h('changed-body'),profileHash:changedProfile},coordinates,'changed-alias')).toEqual({denied:true});
    expect((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n).toBe(1);
  });
  it('returns no ticket after a lost commit acknowledgement and preserves durable suppression',async()=>{
    const ctx=context(),coordinates={turnId:'lost-commit',sequence:2,stepIndex:4},request={bindingId:bindings['member-a:helper']!,requestHash:h('lost-request'),profileHash:profile};
    const lost={connect:async()=>{const client=await db.connect();return {release:()=>client.release(),query:async(sql:string,values?:unknown[])=>{const result=await client.query(sql,values);if(sql==='COMMIT')throw new Error('lost acknowledgement');return result;}};}} as unknown as Pool;
    await expect(prepare(new PgBudgetAdmissionStore(lost,env()),ctx,request,coordinates)).rejects.toThrow('could not be confirmed');
    expect(await coldPrepare(ctx,request,coordinates)).toEqual({denied:true});
    expect((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n).toBe(1);
  });
  it('rolls an ordinary failed prepare back without persisting suppression',async()=>{
    const ctx=context(),coordinates={turnId:'rollback-turn',sequence:2,stepIndex:4},request={bindingId:bindings['member-a:helper']!,requestHash:h('rollback-request'),profileHash:profile};
    const rollback={connect:async()=>{const client=await db.connect();return {release:()=>client.release(),query:async(sql:string,values?:unknown[])=>{const result=await client.query(sql,values);if(sql.startsWith('INSERT INTO budget_attempts'))throw new Error('ordinary rollback');return result;}};}} as unknown as Pool;
    await expect(prepare(new PgBudgetAdmissionStore(rollback,env()),ctx,request,coordinates)).rejects.toThrow('ordinary rollback');
    expect((await db.query('SELECT count(*)::int n FROM budget_attempts')).rows[0].n).toBe(0);
    expect(await coldPrepare(ctx,request,coordinates)).toHaveProperty('ticket');
  });
  it('rolls the entire cutover back rather than deadlocking a policy INSERT that owns console first',async()=>{
    await prepared();
    await db.query("DELETE FROM org_member_policy WHERE user_id='member-a'");
    await db.query('DROP TRIGGER budget_invocation_insert_guard ON budget_attempts; ALTER TABLE budget_attempts DROP COLUMN invocation_hash');
    const before=(await db.query('SELECT * FROM budget_attempts')).rows;
    const bindingsBefore=(await db.query('SELECT * FROM console_session_bindings ORDER BY session_id')).rows;
    const other=quiet(new Pool({connectionString:container.getConnectionUri(),max:1})),writer=await other.connect();
    const pausePool=quiet(new Pool({connectionString:container.getConnectionUri(),max:1})),pause=await pausePool.connect();
    let inserting:Promise<unknown>|undefined;
    try{
      // This test-only trigger pauses an actual INSERT after SQL 014's BEFORE trigger
      // has acquired console locks, but before the users FK acquires its table lock.
      await db.query(`CREATE FUNCTION budget_test_policy_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(230023); RETURN NEW; END $$;
        CREATE TRIGGER z_budget_test_policy_pause BEFORE INSERT ON org_member_policy FOR EACH ROW EXECUTE FUNCTION budget_test_policy_pause()`);
      await pause.query('BEGIN');await pause.query('SELECT pg_advisory_xact_lock(230023)');
      const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      inserting=writer.query("INSERT INTO org_member_policy(user_id,allowed_capabilities,spend_cap_usd_month) VALUES('member-a',NULL,1)");
      const until=Date.now()+3000;let blocked=false;
      while(Date.now()<until){
        if((await db.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='advisory'",[pid])).rows.length){blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      await expect(db.query(readFileSync(new URL('023_budget_invocation_suppression.sql',sql),'utf8'))).rejects.toMatchObject({code:'55P03'});
      await db.query('ROLLBACK');
      expect((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='budget_attempts' AND column_name='invocation_hash'")).rows).toEqual([]);
      expect((await db.query("SELECT 1 FROM pg_trigger WHERE tgname='budget_invocation_insert_guard'")).rows).toEqual([]);
      expect((await db.query('SELECT * FROM budget_attempts')).rows).toEqual(before);
      await pause.query('COMMIT');await inserting;
      // Policy writes can revoke captures, but a failed migration must add no cutover.
      expect((await db.query('SELECT * FROM console_session_bindings ORDER BY session_id')).rows).toEqual(bindingsBefore);
      await db.query(readFileSync(new URL('023_budget_invocation_suppression.sql',sql),'utf8'));
      expect((await db.query('SELECT state,invocation_hash FROM budget_attempts')).rows).toEqual([{state:'retired',invocation_hash:null}]);
    }finally{
      await db.query('ROLLBACK');await pause.query('ROLLBACK');await inserting;writer.release();pause.release();await other.end();await pausePool.end();
      await db.query('DROP TRIGGER IF EXISTS z_budget_test_policy_pause ON org_member_policy; DROP FUNCTION IF EXISTS budget_test_policy_pause()');
      await db.query(readFileSync(new URL('023_budget_invocation_suppression.sql',sql),'utf8'));
    }
  });
  it.each(['remove','delete'] as const)('drains existing %s member transactions before the migration console lock',async operation=>{
    await prepared();
    const other=quiet(new Pool({connectionString:container.getConnectionUri(),max:1})),writer=await other.connect();
    const migrationPool=quiet(new Pool({connectionString:container.getConnectionUri(),max:1})),migrator=await migrationPool.connect();
    let pending:Promise<unknown>|undefined;
    try{
      await writer.query('BEGIN');await writer.query('SET LOCAL lock_timeout=1000');
      await writer.query("SELECT id FROM users WHERE id='member-a' FOR UPDATE");
      // The removal/erasure path can already own budgets before its later console revoke.
      await writer.query('LOCK TABLE budget_attempts IN ROW EXCLUSIVE MODE');
      const pid=(await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending=migrator.query(readFileSync(new URL('023_budget_invocation_suppression.sql',sql),'utf8'));
      const until=Date.now()+3000;let blocked=false;
      while(Date.now()<until){
        if((await db.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rows.length){blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      await writer.query(operation==='remove'?"UPDATE users SET status='removed' WHERE id='member-a'":"DELETE FROM users WHERE id='member-a'");
      await writer.query('COMMIT');await pending;
      expect((await db.query("SELECT state FROM budget_attempts")).rows[0].state).toBe('retired');
    }finally{await writer.query('ROLLBACK');writer.release();await pending;migrator.release();await migrationPool.end();await other.end();}
  });
  it('refuses a busy authority lock before touching budget tables and succeeds on retry',async()=>{
    const other=quiet(new Pool({connectionString:container.getConnectionUri(),max:1})),locker=await other.connect();
    const migrationPool=quiet(new Pool({connectionString:container.getConnectionUri(),max:1})),migrator=await migrationPool.connect();
    try{
      await locker.query('BEGIN');await locker.query('SET LOCAL lock_timeout=1000');
      await locker.query("SELECT session_id FROM console_session_bindings WHERE member_id='member-a' FOR SHARE");
      await expect(migrator.query(readFileSync(new URL('023_budget_invocation_suppression.sql',sql),'utf8'))).rejects.toMatchObject({code:'55P03'});
      await migrator.query('ROLLBACK');
      // Refusal cannot leave a conflicting budget/DDL lock behind.
      await locker.query('SELECT id FROM budget_accounts WHERE id=$1 FOR UPDATE',[installation]);
      await locker.query('SELECT id FROM budget_attempts FOR UPDATE');await locker.query('COMMIT');
      await migrator.query(readFileSync(new URL('023_budget_invocation_suppression.sql',sql),'utf8'));
    }finally{await locker.query('ROLLBACK');await migrator.query('ROLLBACK');locker.release();migrator.release();await migrationPool.end();await other.end();}
  });
  it('requires new insert hashes, protects retained hashes, and preserves legacy NULL settlement after one-time cutover',async()=>{
    const legacy=await admitted();await prepared();
    // Reconstruct the pre-023 schema in this disposable database, retaining genuine rows.
    await db.query('DROP TRIGGER budget_invocation_insert_guard ON budget_attempts; ALTER TABLE budget_attempts DROP COLUMN invocation_hash');
    await db.query(readFileSync(new URL('023_budget_invocation_suppression.sql',sql),'utf8'));
    expect((await db.query('SELECT state,invocation_hash FROM budget_attempts ORDER BY state')).rows).toEqual([{state:'admitted',invocation_hash:null},{state:'retired',invocation_hash:null}]);
    await expect(store.readStatus(context())).rejects.toThrow();
    await freshConsoleSessions();const fresh=await prepared();
    // Whole-directory reapply recreates SQL 011 functions too; the separate insert guard stays.
    for(const file of readdirSync(sql).filter(f=>f.endsWith('.sql')&&f>'006_approval_session.sql').sort())await db.query(readFileSync(new URL(file,sql),'utf8'));
    expect((await store.readStatus(context())).liability).toBe('0.1');
    expect((await store.admit(fresh.ticket,fresh.observation,recovery())).state).toBe('allowed');
    const copy=(digest:string|null)=>db.query(`INSERT INTO budget_attempts SELECT (jsonb_populate_record(NULL::budget_attempts,to_jsonb(a)||jsonb_build_object('id',$1::text,'ticket_hash',$2::text,'invocation_hash',$3::text))).* FROM budget_attempts a LIMIT 1`,[randomUUID(),h(randomUUID()),digest]);
    await expect(copy(null)).rejects.toThrow('Budget invocation is required');await expect(copy('A'.repeat(64))).rejects.toThrow();
    await expect(db.query("UPDATE budget_attempts SET invocation_hash=repeat('a',64) WHERE invocation_hash IS NOT NULL")).rejects.toThrow('immutable');
    await db.query("DELETE FROM users WHERE id='member-a'");expect(await store.settle(receipt(legacy))).toBe('settled');
    expect((await db.query('SELECT count(*)::int n FROM budget_attempts WHERE invocation_hash IS NULL AND live_member_id IS NULL')).rows[0].n).toBe(2);
  });
  it('reserves exact money on a one-connection pool and burns only acknowledged commits',async()=>{
    await cap('member-a','0.100000000000000001');
    const a=await admitted();expect((await store.readStatus(context())).liability).toBe('0.1');
    const dispatch=consumeDispatchPermit(a.permit);expect(dispatch).toEqual({attemptId:a.attemptId,bindingId:a.bindingId,requestHash:a.observation.requestHash});
    expect(consumeDispatchPermit(a.permit)).toBeUndefined();
    expect((await store.admit(a.ticket,a.observation,recovery())).state).toBe('denied');
    expect((await new PgBudgetAdmissionStore(db,env()).admit(a.ticket,a.observation,recovery())).state).toBe('denied');
  });
  it('retires retained source history when source expiry passes behind the final budget lock',async()=>{
    const definition=parseDefinition({name:'helper',model:'fixture-brain',persona:'voice.md',role:'chief-of-staff',channels:[],grants:[{capability:'vault',scope:'read',areas:['shared']}],autonomy:{vault:'gated'},skills:[]});
    const loaded:LoadedDefinition={definition,dutiesMd:'',voiceMd:'',source:'service',dir:'<fixture>',hash:''};loaded.hash=hashOf(loaded);
    await db.query("UPDATE agent_definitions SET definition=$1,hash=$2 WHERE name='helper'",[definition,loaded.hash]);await freshConsoleSessions();
    const vault=new PgVaultStore(db),authority={designatedOwnerMemberId:'member-a'};
    await vault.provisionBacking('member-a',{id:'source-backing',kind:'git'},authority);
    const area=await vault.provisionArea('member-a',{id:'source-area',kind:'shared',owner:{kind:'organisation',id:'org'},backingStoreId:'source-backing',relativePath:'shared'},authority);
    const validUntil=(await db.query("SELECT (clock_timestamp()+interval '1500 millisecond')::text AS deadline")).rows[0].deadline;
    await vault.configureAccess('member-a',{areaId:area.areaId,expectedRevision:area.accessRevision,grants:[{principal:{kind:'member',id:'member-a'},permission:'use',expiresAt:new Date(validUntil).toISOString()}]},authority);
    await captureConsoleVaultSources({agent:'helper',incarnation,sessionId:context().session.id,memberId:'member-a',admissionNonce:nonce('member-a')},{sessionDefinition:loaded,areaIds:[area.areaId]},db,env());
    const p=await prepared();expect((await admitAcrossDeadline(p,validUntil)).state).toBe('denied');
    expect((await db.query("SELECT revoked_at FROM console_session_bindings WHERE agent='helper' AND session_id=$1",[context().session.id])).rows[0].revoked_at).not.toBeNull();
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('prepared');
    await expect(store.readStatus(context())).rejects.toThrow();
  });
  it('permits a prepared ticket to cross process/restart before its one winning admission',async()=>{
    const p=await prepared(),cold=new PgBudgetAdmissionStore(db,env());
    expect((await cold.admit(p.ticket,p.observation,recovery())).state).toBe('allowed');
    expect((await store.admit(p.ticket,p.observation,recovery())).state).toBe('denied');
    const row=(await db.query('SELECT ticket_hash FROM budget_attempts')).rows[0];expect(row.ticket_hash).not.toBe(p.ticket);
  });
  it('preserves exact original actor/request/outcome for persisted model-only approval continuation',async()=>{
    const key='1'.repeat(64),actions=new PgPersonalActionStore(db,{encrypt:s=>encryptSecret(s,key),decrypt:s=>decryptSecret(s,key)});
    await db.query("INSERT INTO connected_accounts(id,owner_member_id,connector_id,provider_issuer,provider_subject,provider_label,status) VALUES('account-a','member-a','example','https://issuer.invalid','subject-a','Example','ok')");
    const selection={actorMemberId:'member-a',agentId:'helper',incarnation,sessionId:context().session.id,originalTurnId:'turn-1',originalCallId:'original-call',accountId:'account-a',accountGeneration:0,resourceBindingId:'mailbox-a',connectorId:'example',kind:'mail.send' as const};
    const action=await actions.prepareAction({...selection,payload:{to:['recipient@example.invalid'],subject:'Example',body:'Private example'}}),requestId='exact-request';
    await db.query(`INSERT INTO approval_asks(call_id,request_id,agent,tool,payload_hash,original_authority,acting_member_id,resolved_by_member_id,session_id,outcome,answered_at)
      VALUES($1,$2,'helper',$3,$4,$5::jsonb,'member-a','member-a',$6,'approved',clock_timestamp())`,[selection.originalCallId,requestId,PERSONAL_MAIL_SEND_TOOL,action.payloadHash,JSON.stringify(personalActionApprovalDescriptor(action,selection,h('policy'))),selection.sessionId]);
    await actions.attachApproval({actionId:action.actionId,actorMemberId:'member-a',approvalCallId:selection.originalCallId,requestId});
    const current=context(),resume={session:{...current.session,turn:{id:'',sequence:1},auth:{initiator:current.session.auth.initiator,current:{authenticator:'lares-console',attributes:{lares_resolver_member_id:'member-a',lares_resume_request_id:requestId,lares_resume_option:'approve',lares_purpose:'resolver'}}}}};
    const checked=await requirePrivateConsoleResume(resume,'model',{db,env:env()});
    expect((await requirePersistedPrivateConsoleModelResume({binding:checked.binding,requestId,optionId:'approve'},{db,env:env()})).reference.actionId).toBe(action.actionId);
    const requestHash=h('resume-model'),ticket=await prepare(store,resume,{bindingId:bindings['member-a:helper']!,requestHash,profileHash:profile});
    const row=(await db.query('SELECT authority_reference FROM budget_attempts')).rows[0];expect(row.authority_reference).toMatchObject({kind:'resume',binding:{memberId:'member-a'},resume:{requestId,optionId:'approve'}});
    const wrong=structuredClone(resume);wrong.session.auth.current.attributes.lares_resolver_member_id='member-b';await expect(prepare(store,wrong,{bindingId:bindings['member-a:helper']!,requestHash,profileHash:profile})).rejects.toThrow();
    await expect(requirePersistedPrivateConsoleModelResume({binding:checked.binding,requestId:'other',optionId:'approve'},{db,env:env()})).rejects.toThrow();
    await expect(db.query("UPDATE approval_asks SET resolved_by_member_id='member-b' WHERE call_id=$1",[selection.originalCallId])).rejects.toThrow('immutable');
    await db.query("UPDATE connected_accounts SET generation=generation+1 WHERE id='account-a'");
    await expect(requirePrivateConsoleResume(resume,'model',{db,env:env()})).rejects.toThrow();
    await expect(requirePersistedPrivateConsoleModelResume({binding:checked.binding,requestId,optionId:'approve'},{db,env:env()})).rejects.toThrow();
    const observation={requestHash,profileHash:profile,endpointHash:endpoint,credentialGeneration:'0',keyFingerprint:fingerprint,agent:'helper',incarnation,purposeAlias:'standard'};
    expect((await new PgBudgetAdmissionStore(db,env()).admit(ticket,observation,recovery())).state).toBe('denied');
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('retired');
  });
  it.each([null,'NaN','Infinity','-1','0'])('denies missing/invalid/zero member cap %s',async amount=>{
    await cap('member-a',amount);
    if(amount==='0'){
      const p=await prepared();expect((await store.admit(p.ticket,p.observation,recovery())).state).toBe('denied');
    }else await expect(prepared()).rejects.toThrow();
    expect((await db.query("SELECT count(*)::int n FROM budget_attempts WHERE state='admitted'")).rows[0].n).toBe(0);
  });
  it('denies absent member policy, closed installation, unselected endpoint and unsupported authority',async()=>{
    const bad=context();bad.session.auth.current={authenticator:'native',attributes:{}} as never;
    await expect(prepare(store,bad,{bindingId:bindings['member-a:helper']!,requestHash:h('request'),profileHash:profile})).rejects.toThrow();
    await db.query("DELETE FROM org_member_policy WHERE user_id='member-a'");await expect(prepared()).rejects.toThrow();
    await db.query("INSERT INTO org_member_policy(user_id,allowed_capabilities,spend_cap_usd_month) VALUES('member-a',NULL,1)");
    await db.query("UPDATE budget_accounts SET state='closed' WHERE id=$1",[installation]);await expect(prepared()).rejects.toThrow();
  });
  it('keeps financial status scoped to the current member and installation totals owner-only',async()=>{
    await db.query("UPDATE users SET org_role='member' WHERE id='member-b'");await freshConsoleSessions();
    const own=await store.readStatus(context('member-b'));expect(own.liability).toBe('0');
    await expect(store.readStatus(context('member-b'),'installation')).rejects.toThrow('scope denied');
    expect((await store.admit('forged',{} as never,{} as never))).toEqual({state:'denied',reason:'Budget authority is unavailable or changed'});
  });
  it('shares member reservations across agents and installation reservations across members',async()=>{
    await cap('member-a','0.1');await admitted();
    const second=new PgBudgetAdmissionStore(db,env('helper-two')),p=await prepared('member-a','helper-two',second);
    expect((await second.admit(p.ticket,p.observation,recovery())).state).toBe('denied');
    await db.query('UPDATE budget_accounts SET installation_cap=0.1 WHERE id=$1',[installation]);
    const b=await prepared('member-b');expect((await store.admit(b.ticket,b.observation,recovery())).state).toBe('denied');
  });
  it('admits exactly two concurrent reservations at the aggregate boundary',async()=>{
    await db.query('UPDATE budget_accounts SET installation_cap=0.2 WHERE id=$1',[installation]);
    const p=await Promise.all([prepared(),prepared('member-b'),prepared(),prepared('member-b')]);
    const concurrent=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));
    try{
      const s=new PgBudgetAdmissionStore(concurrent,env()),results=await Promise.all(p.map(x=>s.admit(x.ticket,x.observation,recovery())));
      expect(results.filter(r=>r.state==='allowed')).toHaveLength(2);
      expect(results.filter(r=>r.state==='denied')).toHaveLength(2);
      expect((await store.readStatus(context(),'installation')).liability).toBe('0.2');
    }finally{await concurrent.end();}
  });
  it.each(['requestHash','profileHash','endpointHash','credentialGeneration','keyFingerprint','agent','incarnation','purposeAlias'] as const)('rejects actual gateway %s mismatch durably',async field=>{
    const p=await prepared(),obs={...p.observation,[field]:'changed'};
    expect((await store.admit(p.ticket,obs,recovery())).state).toBe('denied');
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('retired');
    expect((await store.admit(p.ticket,p.observation,recovery())).state).toBe('denied');
  });
  it('invalidates away-and-back cap changes and denies cap below an existing reservation',async()=>{
    const staleContext=context(),p=await prepared();await cap('member-a','0');await cap('member-a','1');
    await expect(store.readStatus(staleContext)).rejects.toThrow('Conversation authority');
    expect((await store.admit(p.ticket,p.observation,recovery())).state).toBe('denied');
    await admitted();await cap('member-a','0.05');const next=await prepared();expect((await store.admit(next.ticket,next.observation,recovery())).state).toBe('denied');
  });
  it('requires revocation before immutable credential/profile replacement and retires the old ticket',async()=>{
    const p=await prepared();
    const replacement=randomUUID();
    const insert=()=>db.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,purpose_alias,profile_hash,maximum_liability,state)
      SELECT $2,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation+1,$3,agent,incarnation,purpose_alias,profile_hash,maximum_liability,'active' FROM budget_gateway_bindings WHERE id=$1`,[p.bindingId,replacement,h('replacement-key')]);
    await expect(insert()).rejects.toThrow();await db.query("UPDATE budget_gateway_bindings SET state='revoked' WHERE id=$1",[p.bindingId]);await insert();
    expect((await store.admit(p.ticket,p.observation,recovery())).state).toBe('denied');
    const q=await prepare(store,context(),{bindingId:replacement,requestHash:h('replacement-request'),profileHash:profile});
    expect((await store.admit(q,{...p.observation,requestHash:h('replacement-request'),credentialGeneration:'1',keyFingerprint:h('replacement-key')},recovery())).state).toBe('allowed');
  });
  it('rechecks expiry after lock waits and current cap after authority waits',async()=>{
    const other=quiet(new Pool({connectionString:container.getConnectionUri(),max:1}));
    try{
      const short=new PgBudgetAdmissionStore(db,env(),100),p=await prepared('member-a','helper',short),locker=await other.connect();
      await locker.query('BEGIN');await locker.query('SELECT id FROM budget_accounts WHERE id=$1 FOR UPDATE',[installation]);
      const waiting=short.admit(p.ticket,p.observation,recovery());await new Promise(r=>setTimeout(r,150));await locker.query('COMMIT');locker.release();
      expect((await waiting).state).toBe('denied');
      const q=await prepared(),writer=await other.connect();await writer.query('BEGIN');await writer.query("SELECT id FROM orgs WHERE id='org' FOR UPDATE");
      const pending=store.admit(q.ticket,q.observation,recovery());await writer.query("UPDATE org_member_policy SET spend_cap_usd_month=0 WHERE user_id='member-a'");await writer.query('COMMIT');writer.release();expect((await pending).state).toBe('denied');
    }finally{await other.end();}
  });
  it('refuses a delegated member whose locked grant expires during the installation lock wait',async()=>{
    const grants=new PgGrantStore(db),current=await grants.agentAccess('member-a','helper');
    await grants.updateAgentAccess('member-a',{agentName:'helper',expectedRevision:current!.accessRevision,grants:[{principal:{kind:'member',id:'member-b'},permission:'use',expiresAt:new Date(Date.now()+1500).toISOString()}]});
    await freshConsoleSessions();const p=await prepared('member-b');
    const deadline=(await db.query("SELECT expires_at::text FROM resource_grants WHERE principal_member_id='member-b' AND revoked_at IS NULL")).rows[0].expires_at;
    expect(await admitAcrossDeadline(p,deadline)).toEqual({state:'denied',reason:'Budget authority is unavailable or changed'});
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('retired');
    expect((await store.readStatus(context('member-a'),'installation')).liability).toBe('0');
  });
  it.each(['action','approval'] as const)('refuses model approval continuation when its locked %s expires during the budget wait',async deadline=>{
    const p=await resumeFixture(deadline);
    expect(await admitAcrossDeadline(p,p.validUntil)).toEqual({state:'denied',reason:'Budget authority is unavailable or changed'});
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('retired');
  });
  it.each(['action','approval'] as const)('preserves model cancellation continuation after %s expiry',async deadline=>{
    const p=await resumeFixture(deadline,'cancel');expect((await store.admit(p.ticket,p.observation,recovery())).state).toBe('allowed');
  });
  it('gives the same generic denial for member and installation cap exhaustion',async()=>{
    await db.query("UPDATE users SET org_role='member' WHERE id='member-b'");await freshConsoleSessions();
    await db.query('UPDATE budget_accounts SET installation_cap=0.1 WHERE id=$1',[installation]);
    await admitted('member-a');const p=await prepared('member-b');
    const denied={state:'denied',reason:'Budget authority is unavailable or changed'};
    expect(await store.admit(p.ticket,p.observation,recovery())).toEqual(denied);
    await expect(store.readStatus(context('member-b'),'installation')).rejects.toThrow('scope denied');
    await cap('member-b','0');const q=await prepared('member-b');expect(await store.admit(q.ticket,q.observation,recovery())).toEqual(denied);
  });
  it('never mints a permit when commit succeeded but its acknowledgement was lost',async()=>{
    const p=await prepared();
    const lost={connect:async()=>{const client=await db.connect();return {release:()=>client.release(),query:async(sql:string,values?:unknown[])=>{const r=await client.query(sql,values);if(sql==='COMMIT')throw new Error('lost acknowledgement');return r;}};}} as unknown as Pool;
    expect((await new PgBudgetAdmissionStore(lost,env()).admit(p.ticket,p.observation,recovery())).state).toBe('unavailable');
    expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('admitted');
    expect((await store.admit(p.ticket,p.observation,recovery())).state).toBe('denied');
    expect((await store.readStatus(context())).liability).toBe('0.1');
  });
  it('a throwing downstream consumes the permit without refunding',async()=>{
    const a=await admitted();expect(()=>{expect(consumeDispatchPermit(a.permit)).toBeDefined();throw new Error('transport failed');}).toThrow();
    expect(consumeDispatchPermit(a.permit)).toBeUndefined();await store.markUnknown(a.attemptId);
    expect((await store.readStatus(context())).liability).toBe('0.1');
  });
  it('requires a correlated affirmative terminal receipt; cancellation and missing evidence never refund',async()=>{
    const a=await admitted(),r=receipt(a,'0');await store.markUnknown(a.attemptId);
    expect(await store.settle({...r,requestHash:h('unrelated')})).toBe('denied');
    expect(await store.settle({...r,kind:'cancelled' as never})).toBe('denied');
    expect(await store.settle({...r,actualAmount:'0.01',kind:'affirmative-nondispatch'})).toBe('denied');
    expect((await store.readStatus(context())).liability).toBe('0.1');
    expect(await store.settle({...r,kind:'affirmative-nondispatch'})).toBe('settled');
    expect((await store.readStatus(context())).liability).toBe('0');
  });
  it('settles identical terminal receipts idempotently and persists conflicting full liability/freeze',async()=>{
    const a=await admitted(),r=receipt(a);expect(await store.settle(r)).toBe('settled');expect(await store.settle(r)).toBe('settled');
    expect((await store.readStatus(context())).liability).toBe('0.05');
    expect(await store.settle({...r,receiptHash:h('different'),actualAmount:'0.25'})).toBe('conflict');
    const row=(await db.query('SELECT * FROM budget_attempts')).rows[0];expect(row.actual_amount).toBe('0.05');expect(row.highest_observed_liability).toBe('0.25');
    expect((await store.readStatus(context(),'installation')).state).toBe('frozen');expect((await store.readStatus(context())).liability).toBe('0.25');
    expect(await store.settle({...r,receiptHash:h('third'),actualAmount:'0.01'})).toBe('conflict');expect((await store.readStatus(context())).liability).toBe('0.25');
  });
  it('an initial over-reservation terminal charge preserves the full amount and freezes installation',async()=>{
    const a=await admitted();expect(await store.settle(receipt(a,'0.123456789123456789'))).toBe('conflict');
    expect((await db.query('SELECT actual_amount FROM budget_attempts')).rows[0].actual_amount).toBe('0.123456789123456789');
    expect((await store.readStatus(context(),'installation')).state).toBe('frozen');
  });
  it('carries unknown reservations across explicit windows; old verified settlement never double-charges the new window',async()=>{
    const a=await admitted();await store.markUnknown(a.attemptId);
    await window(installation,null);await window(accounts['member-a']!,'member-a');
    expect((await store.readStatus(context())).liability).toBe('0.1');
    expect(await store.settle(receipt(a,'0.05'))).toBe('settled');
    expect((await store.readStatus(context())).liability).toBe('0');expect((await store.readStatus(context(),'installation')).liability).toBe('0');
    const original=(await db.query('SELECT member_window_id FROM budget_attempts')).rows[0].member_window_id;
    expect(original).not.toBe((await store.readStatus(context())).windowId);
  });
  it('counts opening liability, and never silently advances an expired window',async()=>{
    await window(accounts['member-a']!,'member-a','0.95');const p=await prepared();expect((await store.admit(p.ticket,p.observation,recovery())).state).toBe('denied');
    const id=randomUUID();await db.query("INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision) VALUES($1,$2,'member-a',clock_timestamp()-interval '2 day',clock_timestamp()-interval '1 day',0,1,0)",[id,accounts['member-a']]);
    await db.query('UPDATE budget_accounts SET active_window_id=$2 WHERE id=$1',[accounts['member-a'],id]);await expect(prepared()).rejects.toThrow();
  });
  it('requires the trusted non-rollback witness to match, including after restored DB state',async()=>{
    for(const changed of [{epoch:'epoch-2'},{state:'unreconciled' as const},{endpointGeneration:'1'},{installationAccountId:randomUUID()}]){
      const p=await prepared();expect((await store.admit(p.ticket,p.observation,{...recovery(),...changed})).state).toBe('denied');
    }
    expect((await db.query("SELECT count(*)::int n FROM budget_attempts WHERE state='admitted'")).rows[0].n).toBe(0);
  });
  it('exports financial data without credential/ticket/suppression values and erases metadata while retaining late settlement',async()=>{
    await db.query('TRUNCATE budget_gateway_grants,budget_attempts,budget_gateway_bindings,budget_windows,budget_accounts,budget_financial_checkpoints CASCADE');
    const custody=await gatewayCustody(db);
    try{
    await seedGatewayFinancialFixture(custody.writer);
    const journalStore=new PgBudgetAdmissionStore(db,env(),30_000,custody.writer);
    const makeAdmitted=async()=>{
      const p=await prepared('member-a','helper',journalStore),result=await journalStore.admit(p.ticket,p.observation,recovery());
      expect(result.state).toBe('allowed');if(result.state!=='allowed')throw new Error('Fixture admission failed');return {...p,...result};
    };
    const a=await makeAdmitted(),unknown=await makeAdmitted(),settled=await makeAdmitted();
    await journalStore.markUnknown(unknown.attemptId);
    expect(await journalStore.settle(receipt(settled,'0.03'))).toBe('settled');
    const retainedHash=(await db.query('SELECT invocation_hash FROM budget_attempts WHERE id=$1',[a.attemptId])).rows[0].invocation_hash;
    const historicalWindows=(await db.query('SELECT id,opening_liability::text,opening_cap::text FROM budget_windows WHERE account_id=$1 ORDER BY id',[accounts['member-a']])).rows;
    const historicalGrants=(await db.query('SELECT count(*)::int n FROM budget_gateway_grants WHERE attempt_id=ANY($1::uuid[])',[[a.attemptId,unknown.attemptId,settled.attemptId]])).rows[0].n;
    const root=mkdtempSync(join(tmpdir(),'budget-export-'));
    try{
      const report=await exportPerson(db,{person:'member-a',outDir:join(root,'export')});expect(report.refusals).toEqual([]);
      for(const table of ['budget_accounts','budget_windows','budget_gateway_bindings','budget_attempts']){
        expect(scopeOf(table)).toMatchObject({scope:'member',column:'live_member_id',idKind:'registry'});expect(eraseHandlingFor(scopeOf(table)!)).toBe('retire-and-redact-budget-liability');
        const body=readFileSync(join(root,'export','data',`${table}.json`),'utf8');expect(body).not.toMatch(/ticket_hash|invocation_hash|key_fingerprint|suppression|authority_reference|authority_hash|request_hash|session-/);
      }
      const erased=await runErase({db,person:'member-a',vaults:[],apply:true,journal:custody.journal});expect(erased.dbReport.refusals).toEqual([]);
      const account=(await db.query('SELECT * FROM budget_accounts WHERE id=$1',[accounts['member-a']])).rows[0];expect(account).toMatchObject({state:'retired',live_member_id:null,organisation_id:null});expect(account.provider_suppression_hashes).toHaveLength(1);
      const binding=(await db.query('SELECT * FROM budget_gateway_bindings WHERE id=$1',[a.bindingId])).rows[0];expect(binding).toMatchObject({state:'revoked',live_member_id:null,agent:null,key_fingerprint:null});
      const attempts=(await db.query('SELECT id,state,reserved_amount,actual_amount,authority_reference,live_member_id,invocation_hash FROM budget_attempts WHERE id=ANY($1::uuid[])',[[a.attemptId,unknown.attemptId,settled.attemptId]])).rows;
      expect(attempts).toHaveLength(3);
      for(const attempt of attempts)expect(attempt).toMatchObject({authority_reference:null,live_member_id:null});
      expect(attempts.find(attempt=>attempt.id===a.attemptId)).toMatchObject({state:'admitted',reserved_amount:'0.1',invocation_hash:retainedHash});
      expect(attempts.find(attempt=>attempt.id===unknown.attemptId)).toMatchObject({state:'unknown'});
      expect(attempts.find(attempt=>attempt.id===settled.attemptId)).toMatchObject({state:'settled',actual_amount:'0.03'});
      expect((await db.query('SELECT id,opening_liability::text,opening_cap::text FROM budget_windows WHERE account_id=$1 ORDER BY id',[accounts['member-a']])).rows).toEqual(historicalWindows);
      expect((await db.query('SELECT count(*)::int n FROM budget_gateway_grants WHERE attempt_id=ANY($1::uuid[])',[[a.attemptId,unknown.attemptId,settled.attemptId]])).rows[0].n).toBe(historicalGrants);
      // Erasure cannot turn the same opaque invocation hash into a new attempt.
      await expect(db.query(`INSERT INTO budget_attempts SELECT (jsonb_populate_record(NULL::budget_attempts,to_jsonb(a)||jsonb_build_object('id',$1::text,'ticket_hash',$2::text))).* FROM budget_attempts a LIMIT 1`,[randomUUID(),h(randomUUID())])).rejects.toThrow('invocation_hash');
      expect(await journalStore.settle(receipt(a,'0.05'))).toBe('settled');
      await expect(db.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,canonical_suppression_hash,provider_suppression_hashes) VALUES($1,'installation','member',$2,$3,$4)",[randomUUID(),installation,h('new-canonical'),account.provider_suppression_hashes])).rejects.toThrow('reconciliation');
      expect((await db.query('SELECT count(*)::int n FROM budget_accounts WHERE live_member_id=\'member-b\'')).rows[0].n).toBe(1);
    }finally{rmSync(root,{recursive:true,force:true});}
    }finally{custody.journal.close();rmSync(custody.directory,{recursive:true,force:true});}
  });
  it('direct user deletion also retires authority, preserves liabilities, and redacts raw references',async()=>{
    const a=await admitted();await db.query("DELETE FROM users WHERE id='member-a'");
    expect((await db.query('SELECT state,authority_reference,live_member_id FROM budget_attempts')).rows[0]).toEqual({state:'admitted',authority_reference:null,live_member_id:null});
    expect((await db.query('SELECT state FROM budget_accounts WHERE id=$1',[accounts['member-a']])).rows[0].state).toBe('retired');
    expect(await store.settle(receipt(a))).toBe('settled');
  });
  it('retirement after revoked console authority commits a prepared denial',async()=>{
    const p=await prepared();await db.query("UPDATE console_session_bindings SET revoked_at=clock_timestamp() WHERE member_id='member-a'");
    expect((await store.admit(p.ticket,p.observation,recovery())).state).toBe('denied');expect((await db.query('SELECT state FROM budget_attempts')).rows[0].state).toBe('retired');
  });
  it('reapplies the migration without resetting evidence and forbids financial/identity rewrites',async()=>{
    const a=await admitted();await db.query(readFileSync(new URL('011_budget_admission.sql',sql),'utf8'));
    expect((await store.readStatus(context())).liability).toBe('0.1');
    for(const statement of ["UPDATE budget_windows SET opening_liability=0.5","UPDATE budget_gateway_bindings SET maximum_liability=0.01","UPDATE budget_attempts SET reserved_amount=0.01","DELETE FROM budget_attempts","UPDATE budget_accounts SET live_member_id='member-b' WHERE live_member_id='member-a'"])await expect(db.query(statement)).rejects.toThrow();
    expect(await store.settle(receipt(a))).toBe('settled');
  });
});
