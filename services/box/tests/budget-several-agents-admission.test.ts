// One person, several agents, one monthly limit. Every agent of a person spends from that person's one account and
// its one month window; the installation limit covers every person and every agent. The ledger needs no change for
// this: these cases pin that down.
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {captureModelInvocation,runModelInvocation} from '../../../packages/agent-kit/src/model-invocation.js';
import type {ConsoleAuthorityContext} from '../../../packages/agent-kit/src/console-turn-authority.js';
import {bindConsoleSession} from '../../../packages/agent-kit/src/console-turn-authority.js';
import {PgBudgetAdmissionStore,budgetIdentitySuppression,type BudgetGatewayObservation,type BudgetTerminalReceipt} from '../../../packages/agent-kit/src/budget-admission-store.js';
import {PgGrantStore} from '../../../packages/agent-kit/src/grant-store.js';
import {quiet} from './helpers/quiet-pool.js';

const incarnation='11111111-1111-4111-8111-111111111111',endpoint='e'.repeat(64),profile='f'.repeat(64),fingerprint='d'.repeat(64);
const pricing={version:1,capabilityHash:profile,format:'openai',limits:{inputTokens:1000,outputTokens:1000},usdPerMillionTokens:{input:'10',output:'90',cacheRead:'5',cacheWrite:'0'}};
const agents=['helper','helper-two'] as const,members=['member-a','member-b'] as const;
type Agent=typeof agents[number];type Member=typeof members[number];
let sessionGeneration=0,invocationSequence=0;
const nonce=(member:string)=>createHash('sha256').update(`${member}:${sessionGeneration}`).digest('base64url');
const env=(agent:Agent='helper')=>({LARES_AGENT_NAME:agent,LARES_AGENT_INCARNATION:incarnation,AGENT_OWNER_USER_ID:'member-a'});
const context=(member:Member='member-a',agent:Agent='helper'):ConsoleAuthorityContext=>{
  const auth={authenticator:'lares-console',attributes:{lares_member_id:member,lares_admission_nonce:nonce(member),lares_purpose:'human'}};
  return {session:{id:`session-${member}-${agent}-${sessionGeneration}`,turn:{id:'turn-1',sequence:0},auth:{current:auth,initiator:auth}}} as ConsoleAuthorityContext;
};
const h=(s:string)=>createHash('sha256').update(s).digest('hex');
const fixtureOwner=randomUUID(),sql=new URL('../sql/',import.meta.url);
let container:StartedPostgreSqlContainer,db:Pool,installation:string,accounts:Record<string,string>,bindings:Record<string,string>;
const recovery=()=>({installationAccountId:installation,epoch:'epoch-1',endpointGeneration:'0',state:'reconciled' as const});
const store=(agent:Agent,pool:Pool=db)=>new PgBudgetAdmissionStore(pool,env(agent));

async function freshConsoleSessions(){
  // A policy change correctly revokes earlier captures; later calls use freshly admitted sessions.
  sessionGeneration++;
  for(const agent of agents)for(const memberId of members)
    await bindConsoleSession({agent,incarnation,memberId,admissionNonce:nonce(memberId),sessionId:context(memberId,agent).session!.id!},db,env(agent));
}
async function cap(member:Member,amount:string){
  await db.query('UPDATE org_member_policy SET spend_cap_usd_month=$2 WHERE user_id=$1',[member,amount]);
  await freshConsoleSessions();
}
async function window(accountId:string,member:string|null){
  const id=randomUUID();
  await db.query(`INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision)
    VALUES($1,$2,$3,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 day',0,1,0)`,[id,accountId,member]);
  await db.query('UPDATE budget_accounts SET active_window_id=$2 WHERE id=$1',[accountId,id]);
}
async function prepared(member:Member,agent:Agent){
  const requestHash=h(randomUUID()),bindingId=bindings[`${member}:${agent}`]!,ctx=context(member,agent);
  const invocation=captureModelInvocation({type:'step.started',data:{turnId:'turn-1',sequence:0,stepIndex:invocationSequence++}},ctx.session as never,'standard');
  const ticket=await runModelInvocation(invocation,()=>store(agent).prepareIntent({bindingId,requestHash,profileHash:profile}));
  const observation:BudgetGatewayObservation={requestHash,profileHash:profile,endpointHash:endpoint,credentialGeneration:'0',keyFingerprint:fingerprint,agent,incarnation,purposeAlias:'standard'};
  return {ticket,observation,bindingId,agent};
}
async function admitted(member:Member,agent:Agent){
  const p=await prepared(member,agent),a=await store(agent).admit(p.ticket,p.observation,recovery());
  expect(a.state).toBe('allowed');if(a.state!=='allowed')throw new Error('Not admitted');return {...p,...a};
}
const receipt=(a:Awaited<ReturnType<typeof admitted>>,amount:string):BudgetTerminalReceipt=>({attemptId:a.attemptId,bindingId:a.bindingId,requestHash:a.observation.requestHash,
  endpointHash:endpoint,credentialGeneration:'0',profileHash:profile,receiptHash:h(`receipt-${a.attemptId}`),actualAmount:amount,kind:'terminal-usage'});
const spent=async(member:Member='member-a')=>(await store('helper').readStatus(context(member))).liability;
const installationSpent=async()=>(await store('helper').readStatus(context(),'installation')).liability;

beforeAll(async()=>{
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  db=quiet(new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1000}));
  for(const file of readdirSync(sql).filter(f=>f.endsWith('.sql')).sort())await db.query(readFileSync(new URL(file,sql),'utf8'));
  await db.query('CREATE TABLE budget_test_owner(marker text NOT NULL)');
  await db.query('INSERT INTO budget_test_owner VALUES($1)',[fixtureOwner]);
},120_000);
afterAll(async()=>{await db?.end();await container?.stop();});
beforeEach(async()=>{
  sessionGeneration++;
  // Destructive cleanup is confined to this owned, disposable container.
  expect((await db.query('SELECT marker,current_database() AS database FROM budget_test_owner')).rows).toEqual([{marker:fixtureOwner,database:'test'}]);
  await db.query('TRUNCATE users,orgs,agent_definitions,agent_resources,budget_financial_checkpoints RESTART IDENTITY CASCADE');
  await db.query(`INSERT INTO orgs(id,display_name) VALUES('org','Example');
    INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-a','A','org','owner','active'),('member-b','B','org','member','active');
    INSERT INTO org_member_policy(user_id,allowed_capabilities,spend_cap_usd_month) VALUES('member-a',NULL,1),('member-b',NULL,1);`);
  const grants=new PgGrantStore(db);
  for(const agent of agents){
    await db.query("INSERT INTO agent_definitions(name,definition,hash) VALUES($1,'{\"grants\":[]}','fixture')",[agent]);
    await db.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending) VALUES($1,$3,$1,'owned',$2,$2,'ready',false)",[agent,incarnation,agent==='helper'?'127.0.0.2':'127.0.0.3']);
    const adopted=await grants.adoptAgent('member-a',{agentName:agent,expectedDefinitionHash:'fixture'},{designatedOwnerMemberId:'member-a'});
    await grants.updateAgentAccess('member-a',{agentName:agent,expectedRevision:adopted.accessRevision,grants:[{principal:{kind:'organisation',id:'org'},permission:'use',expiresAt:null}]});
  }
  await freshConsoleSessions();
  installation=randomUUID();accounts={};bindings={};
  await db.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,installation_cap,selected_endpoint,recovery_epoch) VALUES($1,'installation','installation',$1,1,$2,'epoch-1')",[installation,endpoint]);
  await window(installation,null);
  await db.query("UPDATE budget_accounts SET state='open',reason='approved' WHERE id=$1",[installation]);
  for(const member of members){
    const id=randomUUID(),suppression=budgetIdentitySuppression(Buffer.alloc(32,1),{canonicalMemberId:member,providers:[{issuer:'https://issuer.invalid',subject:member,tenantId:'tenant'}]});accounts[member]=id;
    await db.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,live_member_id,organisation_id,canonical_suppression_hash,provider_suppression_hashes) VALUES($1,'installation','member',$2,$3,'org',$4,$5)",[id,installation,member,suppression.canonicalSuppressionHash,suppression.providerSuppressionHashes]);
    await window(id,member);await db.query("UPDATE budget_accounts SET state='open',reason='approved' WHERE id=$1",[id]);
    // One account per person, one main key per agent on it: the shape a person with several agents has.
    for(const agent of agents){
      const bindingId=randomUUID();bindings[`${member}:${agent}`]=bindingId;
      await db.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,purpose_alias,profile_hash,maximum_liability,pricing_profile,state)
        VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,'standard',$9,0.1,$10::jsonb,'active')`,[bindingId,installation,id,member,endpoint,fingerprint,agent,incarnation,profile,JSON.stringify(pricing)]);
    }
  }
});

it('adds up calls from both of a person\'s agents in that person\'s one month window',async()=>{
  const calls=[await admitted('member-a','helper'),await admitted('member-a','helper-two'),await admitted('member-a','helper'),await admitted('member-a','helper-two')];
  expect(await spent()).toBe('0.4');
  const windows=(await db.query('SELECT DISTINCT member_account_id,member_window_id FROM budget_attempts WHERE id=ANY($1::uuid[])',[calls.map(call=>call.attemptId)])).rows;
  expect(windows).toEqual([{member_account_id:accounts['member-a'],member_window_id:(await db.query('SELECT active_window_id FROM budget_accounts WHERE id=$1',[accounts['member-a']])).rows[0].active_window_id}]);
  // Settled calls count their real cost, whichever agent made them.
  expect(await store('helper').settle(receipt(calls[0]!,'0.03'))).toBe('settled');
  expect(await store('helper-two').settle(receipt(calls[1]!,'0.02'))).toBe('settled');
  expect(await spent()).toBe('0.25');
  expect(await spent('member-b')).toBe('0');
});

it('allows exactly one of two calls made at the same moment by two agents when together they would pass the person\'s limit',async()=>{
  await cap('member-a','0.15');
  for(let round=0;round<3;round++){
    const calls=await Promise.all([prepared('member-a','helper'),prepared('member-a','helper-two')]);
    const concurrent=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));
    try{
      const results=await Promise.all(calls.map(call=>store(call.agent,concurrent).admit(call.ticket,call.observation,recovery())));
      expect(results.filter(result=>result.state==='allowed')).toHaveLength(round===0?1:0);
      expect(results.filter(result=>result.state==='denied')).toHaveLength(round===0?1:2);
    }finally{await concurrent.end();}
    expect(await spent()).toBe('0.1');
  }
  // The limit is the person's, not the agent's: the other person is untouched.
  await admitted('member-b','helper');await admitted('member-b','helper-two');
  expect(await spent('member-b')).toBe('0.2');
});

it('keeps a call left unfinished on one agent holding its reservation against the person\'s other agents',async()=>{
  await cap('member-a','0.15');
  const unfinished=await admitted('member-a','helper');
  await store('helper').markUnknown(unfinished.attemptId);
  expect(await spent()).toBe('0.1');
  const other=await prepared('member-a','helper-two');
  const refused=await store('helper-two').admit(other.ticket,other.observation,recovery());
  expect(refused).toMatchObject({state:'denied',limit:{scope:'member',cap:'0.15'}});
  // Once its real cost is known the reservation is released, and the other agent can spend.
  expect(await store('helper').settle(receipt(unfinished,'0.01'))).toBe('settled');
  expect(await spent()).toBe('0.01');
  await admitted('member-a','helper-two');
  expect(await spent()).toBe('0.11');
});

it('checks the installation limit across every person and every agent',async()=>{
  await db.query('UPDATE budget_accounts SET installation_cap=0.3 WHERE id=$1',[installation]);
  await freshConsoleSessions();
  await admitted('member-a','helper');await admitted('member-a','helper-two');await admitted('member-b','helper');
  expect(await installationSpent()).toBe('0.3');
  const last=await prepared('member-b','helper-two');
  expect(await store('helper-two').admit(last.ticket,last.observation,recovery())).toMatchObject({state:'denied',limit:{scope:'installation'}});
  expect([await spent('member-a'),await spent('member-b'),await installationSpent()]).toEqual(['0.2','0.1','0.3']);
});
