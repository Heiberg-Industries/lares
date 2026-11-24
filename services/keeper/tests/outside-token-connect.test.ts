// The whole "connect an outside tool with a token" flow, in the order the Connect screen presses it, against a real
// database, the real grant store, the restricted custody role and a fake MCP server (no network). The agent's
// outside grant is read-only. Nothing about grants, routes or the keeper is replaced except the network itself.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {quiet} from './helpers/quiet-pool.js';
import {PgMemberStore} from '@lares/agent-kit/member-store';
import {provisionEngineDatabasePrivileges} from '../../box/lib/database-privileges.js';

const http=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('undici',()=>({request:http.request,ProxyAgent:class{destroy(){return Promise.resolve();}},Client:class{}}));
import {OutsideCustodyStore,OutsideRefusal} from '../lib/outside-custody.js';
import {KeeperRefusedError} from '../lib/actions.js';
import {plainOutsideRefusal} from '../lib/outside-refusals.js';

const SESSION_MAX_AGE=7*24*60*60;
const KEY=Buffer.alloc(32,41),owner='token-connect-owner',org='token-connect-org';
let token='';
const incarnation='00000000-0000-4000-8000-000000000204',admissionNonce='N'.repeat(43),sessionId='token-connect-session';
const appPassword=Buffer.from('token-connect-app-role-disposable');
const custodyPassword=Buffer.from('token-connect-custody-role-disposable');
const financialPassword=Buffer.from('token-connect-financial-role-disposable');
const URL_OF_SERVER='https://mcp.example.com/api/mcp';
const PENDING='connect-pending';
const route={policyHash:'d'.repeat(64),sourceAddress:'198.51.100.10',proxyUrl:'http://lares-egress-proxy:8888/'};
let container:StartedPostgreSqlContainer,admin:Pool,app:Pool,custody:Pool,store:OutsideCustodyStore;
let version=0,refuseServer=false,serverCalls=0,routeReview:(()=>Promise<typeof route>)|undefined;
const deadline=()=>({deadlineAtMs:Date.now()+10000});
const hashOf=(n:number)=>createHash('sha256').update(`definition-${n}`).digest('hex');

const definition=(allow:string[],read:string[])=>({name:'worker',model:'lares-brain',grants:[{capability:'outside',scope:'read'}],
  outsideTools:[{name:'connector',url:URL_OF_SERVER,description:'Company lookups',token:true,tools:{allow,read}}]});
/** What "Save the connection" does to the agent: a new definition, a new hash and a new access revision. */
async function saveDefinition(allow:string[],read:string[]):Promise<void>{
  version++;
  await admin.query('UPDATE agent_definitions SET definition=$1::jsonb,hash=$2,status=\'valid\' WHERE name=\'worker\'',[JSON.stringify(definition(allow,read)),hashOf(version)]);
  await admin.query('UPDATE agent_access SET revision=nextval(\'resource_access_revision_seq\') WHERE agent_name=\'worker\'');
}
async function removeDefinition():Promise<void>{
  version++;
  await admin.query('UPDATE agent_definitions SET definition=$1::jsonb,hash=$2,status=\'valid\' WHERE name=\'worker\'',
    [JSON.stringify({name:'worker',model:'lares-brain',grants:[{capability:'outside',scope:'read'}]}),hashOf(version)]);
  await admin.query('UPDATE agent_access SET revision=nextval(\'resource_access_revision_seq\') WHERE agent_name=\'worker\'');
}

function fakeServer(){
  http.request.mockImplementation(async(_url:string,options:{body:Buffer;headers?:Record<string,string>})=>{
    serverCalls++;
    if(refuseServer)return {statusCode:401,headers:{'content-type':'application/json'},body:Readable.from([Buffer.from('{"error":"bad token"}')])};
    const message=JSON.parse(options.body.toString()) as {id?:number;method:string};
    let result:unknown;
    if(message.method==='initialize')result={protocolVersion:'2025-06-18',serverInfo:{name:'Example directory',version:'1'},capabilities:{tools:{}}};
    else if(message.method==='tools/list')result={tools:[{name:'lookup-company',description:'Look up a company',inputSchema:{type:'object'}}]};
    else result={content:[{type:'text',text:'Example company AS'}]};
    return {statusCode:message.id===undefined?202:200,headers:{'content-type':'application/json','mcp-session-id':'fixture-session'},
      body:Readable.from(message.id===undefined?[]:[Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))])};
  });
}

beforeEach(async()=>{
  version=0;refuseServer=false;serverCalls=0;routeReview=undefined;
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  admin=quiet(new Pool({connectionString:container.getConnectionUri()}));
  const sqlDir=new URL('../../box/sql',import.meta.url).pathname;
  const fs=await import('node:fs/promises');
  for(const name of (await fs.readdir(sqlDir)).filter(file=>/^\d+.*\.sql$/.test(file)).sort((a,b)=>Number(a.match(/^\d+/)![0])-Number(b.match(/^\d+/)![0])||a.localeCompare(b)))
    await admin.query(await fs.readFile(`${sqlDir}/${name}`,'utf8'));
  const setup=await admin.connect();
  try{await provisionEngineDatabasePrivileges(setup,{expectedDatabase:container.getDatabase(),passwords:{application:appPassword,financial:financialPassword,outsideCustody:custodyPassword}});}
  finally{setup.release();}
  const appUrl=new URL(container.getConnectionUri());appUrl.username='lares_app';appUrl.password=appPassword.toString();
  app=quiet(new Pool({connectionString:appUrl.toString()}));
  const custodyUrl=new URL(container.getConnectionUri());custodyUrl.username='lares_outside_custody';custodyUrl.password=custodyPassword.toString();
  custody=quiet(new Pool({connectionString:custodyUrl.toString()}));
  await admin.query('INSERT INTO orgs(id,display_name) VALUES($1,\'fixture\')',[org]);
  await admin.query(`INSERT INTO users(id,display_name,org_id,org_role,status,automation_mode) VALUES($1,'owner',$2,'owner','active','draft-and-ask')`,[owner,org]);
  await admin.query('INSERT INTO org_member_policy(user_id) VALUES($1)',[owner]);
  // The session is made by the console's own sign-in code (the member store), on the console's own database role,
  // exactly as the real sign-in callback does, not by a hand-written INSERT.
  await admin.query("INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES($1,'https://identity.example.invalid',$1,'')",[owner]);
  token=(await new PgMemberStore(app).createSession({identity:{issuer:'https://identity.example.invalid',subject:owner},verifiedAt:new Date()},
    new Date(Date.now()+SESSION_MAX_AGE*1000))).token;
  // The agent exists with no outside connection yet, owned by the member, outside grant read-only.
  await admin.query(`INSERT INTO agent_definitions(name,definition,hash,status) VALUES('worker',$1::jsonb,$2,'valid')`,
    [JSON.stringify({name:'worker',model:'lares-brain',grants:[{capability:'outside',scope:'read'}]}),hashOf(0)]);
  await admin.query(`INSERT INTO agent_access(agent_name,owner_member_id,organisation_id) VALUES('worker',$1,$2)`,[owner,org]);
  await admin.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,applied_definition,pending)
    VALUES('worker','127.0.0.1'::inet,'fixture','owned',$1,$1,'ready','{}'::jsonb,false)`,[incarnation]);
  const lifecycle={reviewOutsideRoute:async()=>routeReview?routeReview():route,withAppliedOutsideRoute:async(_endpoint:string,_hash:string,_deadline:number,
    work:(lease:{assertCurrent:()=>Promise<typeof route>})=>Promise<unknown>)=>work({assertCurrent:async()=>route})};
  store=new OutsideCustodyStore(custody as never,KEY,{mainPool:app as never,lifecycle:lifecycle as never});
  fakeServer();
},180_000);
afterEach(async()=>{http.request.mockReset();store?.close();await custody?.end();await app?.end();await admin?.end();await container?.stop();});

/** The steps behind the Connect screen, in its order. Each returns what the next one needs. */
async function lookUpTools(name:string,secret:string){
  const preview=await store.previewHumanDiscovery(token,{agentName:'worker',connectionName:name},deadline());
  const document=await store.consentAndDiscover(token,{requestId:preview.requestId,operationId:preview.claimOperationId,accountId:preview.accountId,
    agentName:'worker',connectionName:name,expectedGeneration:preview.expectedGeneration,expectedCandidateRevision:preview.expectedCandidateRevision,
    expectedDefinitionHash:preview.definitionHash,expectedAccessRevision:preview.accessRevision,expectedDestinationHash:preview.destinationHash,
    expectedRoutePolicyHash:preview.routePolicyHash,consentGeneration:preview.consentGeneration,credential:Buffer.from(secret)},deadline());
  return {preview,document};
}
async function reviewAndStage(name:string,preview:Awaited<ReturnType<typeof lookUpTools>>['preview']){
  const base={accountId:preview.accountId,agentName:'worker',connectionName:name,requestId:preview.requestId,claimOperationId:preview.claimOperationId};
  const review=await store.previewHumanDescriptorReview(token,base,deadline());
  const published=await store.publishDiscoveredDescriptorReview(token,{...base,operationId:randomUUID(),expectedGeneration:review.expectedGeneration,
    expectedDescriptorHash:review.descriptorHash},deadline());
  const again=await store.previewHumanDescriptorReview(token,base,deadline());
  expect(again.descriptorHash).toBe(review.descriptorHash);
  const accepted=await store.acceptPublishedDescriptorReview(token,{accountId:preview.accountId,publicationId:published.publicationId,operationId:randomUUID(),
    expectedPublicationHash:published.publicationHash},deadline());
  const selectors={...base,publicationId:published.publicationId,acceptanceId:accepted.acceptanceId,expectedGeneration:review.expectedGeneration,
    expectedCandidateRevision:review.expectedCandidateRevision,expectedConsentGeneration:review.expectedConsentGeneration,
    expectedDefinitionHash:review.expectedDefinitionHash,expectedAccessRevision:review.expectedAccessRevision,
    expectedPublicationHash:published.publicationHash,expectedAcceptanceHash:accepted.acceptanceHash};
  const activation=await store.previewExecutableActivation(token,{...selectors,operationId:randomUUID()},deadline());
  const staged=await store.stage(token,{...selectors,operationId:randomUUID(),expectedPolicyHash:activation.policyHash,
    activationReviewId:activation.reviewId,expectedActivationReviewHash:activation.reviewHash},deadline());
  expect(staged.outcome).toBe('staged');
  return {selectors,activation,staged};
}
async function activate(s:Awaited<ReturnType<typeof reviewAndStage>>){
  return store.apply(token,{...s.selectors,operationId:randomUUID(),expectedPolicyHash:s.activation.policyHash,activationReviewId:s.activation.reviewId,
    expectedActivationReviewHash:s.activation.reviewHash,stageOperationId:s.staged.operationId,candidateRevision:s.staged.credentialRevision!},deadline());
}
async function oneToolCall(name:string,definitionHash:string){
  await admin.query('DELETE FROM console_session_bindings WHERE session_id=$1',[sessionId]);
  await admin.query(`INSERT INTO console_session_bindings(agent,incarnation,session_id,admission_nonce,place_id,member_id,
      agent_access_revision,private_surface_revision,source_history_guard_revision,policy_revision)
    SELECT 'worker',$1,$2,$3,'fixture',$4,a.revision,2,1,2 FROM agent_access a WHERE a.agent_name='worker'
    ON CONFLICT DO NOTHING`,[incarnation,sessionId,admissionNonce,owner]);
  const binding={agent:'worker',incarnation,sessionId,memberId:owner,approverMemberId:owner,admissionNonce,policyRevision:2};
  const call={callId:randomUUID(),connectionName:name,toolName:'lookup-company',input:{query:'Example company'}};
  await store.approveExecution(binding,call,{requestId:randomUUID(),definitionHash,expiresAt:Date.now()+60_000},deadline());
  return store.dispatchApproved(binding,call,{deadlineAtMs:Date.now()+10_000});
}

/** The screen's order (components/ConnectOutsideTool.tsx): save with the placeholder, ask the server, save the chosen tools,
 *  ask the server again, record and stage, activate. */
async function wholeConnect(secret:string,stopAfter?:'first-lookup'|'staged'){
  await saveDefinition([PENDING],[PENDING]);
  const first=await lookUpTools('connector',secret);
  expect(first.document.tools.map(t=>t.name)).toEqual(['lookup-company']);
  if(stopAfter==='first-lookup')return {first};
  await saveDefinition(['lookup-company'],['lookup-company']);
  const second=await lookUpTools('connector',secret);
  const staged=await reviewAndStage('connector',second.preview);
  if(stopAfter==='staged')return {first,second,staged};
  const applied=await activate(staged);
  expect(applied.outcome).toBe('applied');
  return {first,second,staged};
}

it('connects a token tool to an agent limited to lookups, from the first save to one working tool call',async()=>{
  const {staged}=await wholeConnect('vendor-key-for-the-test');
  expect(serverCalls).toBeGreaterThan(0);
  expect((await admin.query('SELECT active_revision::text,candidate_revision FROM outside_custody_accounts WHERE connection_name=\'connector\'')).rows[0])
    .toEqual({active_revision:String(staged!.staged.credentialRevision),candidate_revision:null});
  expect(await oneToolCall('connector',hashOf(version))).toMatchObject({content:[{text:'Example company AS'}]});
},180_000);

it('connects again after the server refused the token once, and after Remove the half-set-up connection',async()=>{
  await saveDefinition([PENDING],[PENDING]);
  refuseServer=true;
  await expect(lookUpTools('connector','wrong-key')).rejects.toThrow();
  refuseServer=false;
  await removeDefinition();
  await wholeConnect('right-key');
  expect(await oneToolCall('connector',hashOf(version))).toMatchObject({content:[{text:'Example company AS'}]});
},180_000);

it('connects again after an earlier attempt stopped after the first lookup, then after one stopped after staging (Start over)',async()=>{
  await wholeConnect('first-key','first-lookup');
  await removeDefinition();
  await wholeConnect('second-key','staged');
  await removeDefinition();
  await wholeConnect('third-key');
  expect(await oneToolCall('connector',hashOf(version))).toMatchObject({content:[{text:'Example company AS'}]});
},180_000);

/** Each connect uses about nine of the keeper's 32 saved operations for a connection. Removing the declaration does not give
 *  them back; only Remove on the credential does (it retires the account and frees the name). So an agent and connection name
 *  that is connected three times without Remove still runs out on the fourth, with a refusal that names the check. */
async function useUpTheRoom(){
  for(let n=1;n<=3;n++){await wholeConnect(`key-${n}`);await removeDefinition();}
  await saveDefinition([PENDING],[PENDING]);
}
it('names the check when a connection has used up its saved attempts, and says so in plain words',async()=>{
  await useUpTheRoom();
  const error=await wholeConnect('key-4').then(()=>undefined,(e:unknown)=>e);
  expect(error).toBeInstanceOf(OutsideRefusal);
  expect((error as OutsideRefusal).code).toBe('capacity.operations');
  expect((error as OutsideRefusal).message).toBe('Outside credential change could not be confirmed');
  const plain=plainOutsideRefusal(error)!;
  expect(plain.message).toMatch(/used them all.*different connection name.*\(check: capacity\.operations\)/);
  expect(serverCalls).toBeGreaterThan(0);
},300_000);

/** What the member's Remove does for the connection called `name`: the account the console shows, at its shown generation. */
async function removeCredential(name='connector'){
  const account=(await admin.query('SELECT account_id,generation::text AS generation FROM outside_custody_accounts WHERE connection_name=$1 AND state=\'active\'',[name])).rows[0];
  expect(account).toBeTruthy();
  const operationId=randomUUID();
  await store.removeHumanCredential(token,{accountId:account.account_id,agentName:'worker',connectionName:name,
    expectedGeneration:Number(account.generation),operationId},deadline());
  return {accountId:account.account_id as string,generation:Number(account.generation),operationId};
}
const receiptCount=async(accountId:string)=>(await admin.query('SELECT count(*)::int AS n FROM outside_custody_operations WHERE account_id=$1',[accountId])).rows[0].n as number;

it('connects again after the saved attempts for the name were used up and the credential was removed',async()=>{
  await useUpTheRoom();
  await wholeConnect('key-4','first-lookup').catch(()=>undefined);
  await removeCredential();
  await wholeConnect('key-4');
  expect(await oneToolCall('connector',hashOf(version))).toMatchObject({content:[{text:'Example company AS'}]});
},300_000);

it('connect, Remove and connect the same plain name five times: fresh counters each time, receipts and approvals kept',async()=>{
  const retired:{accountId:string;receipts:number;approvals:number}[]=[];
  for(let cycle=1;cycle<=5;cycle++){
    await wholeConnect(`key-${cycle}`);
    expect(await oneToolCall('connector',hashOf(version))).toMatchObject({content:[{text:'Example company AS'}]});
    // A fresh account every time: generation one's counters, one live row under the plain name.
    const live=(await admin.query('SELECT account_id,generation::text,active_revision::text FROM outside_custody_accounts WHERE connection_name=\'connector\'')).rows;
    expect(live).toHaveLength(1);
    expect(retired.map(r=>r.accountId)).not.toContain(live[0].account_id);
    expect(await receiptCount(live[0].account_id)).toBeLessThan(16);
    expect(live[0].active_revision).toBe('3');
    const approvalsBefore=(await admin.query('SELECT count(*)::int AS n FROM outside_execution_approvals WHERE account_id=$1',[live[0].account_id])).rows[0].n;
    expect(approvalsBefore).toBe(1);
    const receiptsBefore=await receiptCount(live[0].account_id);

    const removed=await removeCredential();
    expect(removed.accountId).toBe(live[0].account_id);
    // The name is free: nothing under it, nothing held, and the member's list shows no account for it.
    expect((await admin.query('SELECT 1 FROM outside_custody_accounts WHERE connection_name=\'connector\'')).rowCount).toBe(0);
    expect(await store.heldConnections('worker')).toEqual([]);
    // The account is kept under a tombstone with its revisions erased and every receipt and approval still attached.
    const row=(await admin.query('SELECT connection_name,state,active_revision,candidate_revision FROM outside_custody_accounts WHERE account_id=$1',[removed.accountId])).rows[0];
    expect(row.connection_name).toMatch(/^retired-[0-9a-f]{12}$/);
    expect(row).toMatchObject({state:'revoked',active_revision:null,candidate_revision:null});
    expect((await admin.query('SELECT count(*)::int AS n FROM outside_custody_revisions WHERE account_id=$1',[removed.accountId])).rows[0].n).toBe(0);
    expect(await receiptCount(removed.accountId)).toBe(receiptsBefore+1);
    expect((await admin.query('SELECT count(*)::int AS n FROM outside_execution_approvals WHERE account_id=$1',[removed.accountId])).rows[0].n).toBe(approvalsBefore);
    expect((await admin.query('SELECT count(*)::int AS n FROM outside_execution_approvals a JOIN outside_custody_accounts c USING(account_id) WHERE a.connection_name=\'connector\' AND c.account_id=$1',[removed.accountId])).rows[0].n).toBe(1);
    retired.push({accountId:removed.accountId,receipts:await receiptCount(removed.accountId),approvals:approvalsBefore});
    // Earlier removals are untouched by later cycles.
    for(const r of retired){
      expect(await receiptCount(r.accountId)).toBe(r.receipts);
      expect((await admin.query('SELECT count(*)::int AS n FROM outside_execution_approvals WHERE account_id=$1',[r.accountId])).rows[0].n).toBe(r.approvals);
    }
  }
  expect((await admin.query('SELECT count(DISTINCT connection_name)::int AS n FROM outside_custody_accounts')).rows[0].n).toBe(5);
},600_000);

it('never uses a retired account: an approval made before Remove, a tombstone name, and a replayed removal all fail closed',async()=>{
  await wholeConnect('key-1');
  // An approval for one call, made but not yet used, then the credential is removed and the name connected again.
  await admin.query('DELETE FROM console_session_bindings WHERE session_id=$1',[sessionId]);
  await admin.query(`INSERT INTO console_session_bindings(agent,incarnation,session_id,admission_nonce,place_id,member_id,
      agent_access_revision,private_surface_revision,source_history_guard_revision,policy_revision)
    SELECT 'worker',$1,$2,$3,'fixture',$4,a.revision,2,1,2 FROM agent_access a WHERE a.agent_name='worker'
    ON CONFLICT DO NOTHING`,[incarnation,sessionId,admissionNonce,owner]);
  const binding={agent:'worker',incarnation,sessionId,memberId:owner,approverMemberId:owner,admissionNonce,policyRevision:2};
  const oldCall={callId:randomUUID(),connectionName:'connector',toolName:'lookup-company',input:{query:'Example company'}};
  await store.approveExecution(binding,oldCall,{requestId:randomUUID(),definitionHash:hashOf(version),expiresAt:Date.now()+60_000},deadline());
  const removed=await removeCredential();
  const tombstone=(await admin.query('SELECT connection_name FROM outside_custody_accounts WHERE account_id=$1',[removed.accountId])).rows[0].connection_name as string;

  await wholeConnect('key-2');
  const callsBefore=serverCalls;
  // The old approval points at the retired account; the live account of the same name is a different one.
  await expect(store.dispatchApproved(binding,oldCall,{deadlineAtMs:Date.now()+10_000})).rejects.toThrow();
  expect(serverCalls).toBe(callsBefore);
  // Nobody can call, approve or review a connection by a tombstone's name.
  await expect(oneToolCall(tombstone,hashOf(version))).rejects.toThrow();
  await expect(store.previewHumanDiscovery(token,{agentName:'worker',connectionName:tombstone},deadline())).rejects.toThrow();
  await expect(store.removeHumanCredential(token,{accountId:removed.accountId,agentName:'worker',connectionName:tombstone,
    expectedGeneration:removed.generation+1,operationId:randomUUID()},deadline())).rejects.toThrow();
  // The old account stays revoked, empty and un-reopenable: Remove cannot be run again on it with a new request.
  await expect(store.removeHumanCredential(token,{accountId:removed.accountId,agentName:'worker',connectionName:'connector',
    expectedGeneration:removed.generation,operationId:randomUUID()},deadline())).rejects.toThrow();
  expect((await admin.query('SELECT state,active_revision FROM outside_custody_accounts WHERE account_id=$1',[removed.accountId])).rows[0])
    .toEqual({state:'revoked',active_revision:null});
  // The same removal request sent again (a lost reply) still answers the same, and changes nothing.
  const receipts=await receiptCount(removed.accountId);
  await expect(store.removeHumanCredential(token,{accountId:removed.accountId,agentName:'worker',connectionName:'connector',
    expectedGeneration:removed.generation,operationId:removed.operationId},deadline())).resolves.toMatchObject({kind:'revoke',outcome:'revoked'});
  expect(await receiptCount(removed.accountId)).toBe(receipts);
  // The live account is the only one that works.
  expect(await oneToolCall('connector',hashOf(version))).toMatchObject({content:[{text:'Example company AS'}]});
  expect(await store.heldConnections('worker')).toEqual(['connector']);
},300_000);

it('says the route is unavailable (not "session failed") when the keeper\'s own route review refuses',async()=>{
  await saveDefinition([PENDING],[PENDING]);
  routeReview=async()=>{throw new KeeperRefusedError('Outside route is unavailable');};
  await expect(lookUpTools('connector','vendor-key-for-the-test')).rejects.toThrow('Outside route is unavailable');
},180_000);

it('names the step and the error class, never a value, when a database step under the session fails',async()=>{
  await admin.query("UPDATE member_sessions SET expires_at='infinity'");
  const error=await store.previewHumanDiscovery(token,{agentName:'worker',connectionName:'connector'},deadline()).then(()=>undefined,(e:unknown)=>e);
  expect((error as OutsideRefusal).code).toBe('session.expiry-not-finite');
  await admin.query("UPDATE member_sessions SET expires_at=clock_timestamp()+interval '1 hour'");
  const plain=plainOutsideRefusal(await store.previewHumanDiscovery('x'.repeat(43),{agentName:'worker',connectionName:'connector'},deadline()).then(()=>undefined,(e:unknown)=>e))!;
  expect(plain.message).toMatch(/\(check: session\.not-found\)/);
});
