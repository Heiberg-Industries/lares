import {chmodSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {PgGrantStore} from '@lares/agent-kit/grant-store';
import {quiet} from './helpers/quiet-pool.js';
import {platformTestJournalLock,testJournalUid} from './helpers/financial-journal.js';
import {resetActions,runAction} from '../lib/actions.js';
import {auditor} from '../lib/audit.js';
import {provisionBudgetAccounts} from '../lib/budget-account-provisioning.js';
import {registerBudgetAgentStartActions,type AgentStartStatus} from '../lib/budget-agent-start.js';
import {HostFinancialJournal} from '../lib/financial-journal.js';
import {prepareFinancialCustody} from '../lib/financial-continuity.js';
import {provisionEngineDatabasePrivileges} from '../../box/lib/database-privileges.js';

const database='budget_agent_start',agent='my-agent',incarnation=randomUUID();
const owner='start-owner',person='start-person',stranger='start-stranger',org='start-org';
const passwords={application:Buffer.from('agent-start-app-role-test-password-0001'),financial:Buffer.from('agent-start-financial-role-test-password'),outsideCustody:Buffer.from('agent-start-outside-role-test-password01')};
let container:StartedPostgreSqlContainer,selected:Pool,financial:Pool,journal:HostFinancialJournal,root:string;
const pools:Pool[]=[];

function poolFor(user?:string,password?:Buffer):Pool{
  const uri=new URL(container.getConnectionUri());
  if(user){uri.username=user;uri.password=password!.toString('ascii');}
  const pool=quiet(new Pool({connectionString:uri.toString(),max:3,connectionTimeoutMillis:3000}));pools.push(pool);return pool;
}
const status=(member?:string)=>runAction('budget.agent-start-status',{agent,...(member?{member}:{})},context(),{host:true}) as Promise<AgentStartStatus>;
const context=()=>({actor:'host',audit:auditor(selected)});
const limitOf=async(id:string)=>(await selected.query('SELECT spend_cap_usd_month::text AS cap FROM org_member_policy WHERE user_id=$1',[id])).rows[0]?.cap;

beforeAll(async()=>{
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').withDatabase(database).start();
  selected=poolFor();
  const sqlDir=new URL('../../box/sql/',import.meta.url);
  for(const name of readdirSync(sqlDir).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort())
    await selected.query(readFileSync(new URL(name,sqlDir),'utf8'));
  const operator=await selected.connect();
  try{await provisionEngineDatabasePrivileges(operator,{expectedDatabase:database,passwords});}finally{operator.release();}
  // The action runs with the keeper's real financial login, so a missing grant fails here.
  financial=poolFor('lares_financial',passwords.financial);

  await selected.query("INSERT INTO orgs(id,display_name) VALUES($1,'Agent start test')",[org]);
  for(const [id,role,email] of [[owner,'owner','owner@example.test'],[person,'member','Person@example.test'],[stranger,'member','stranger@example.test']]){
    await selected.query("INSERT INTO users(id,display_name,org_id,org_role,status,primary_email) VALUES($1,$1,$2,$3,'active',$4)",[id,org,role,email]);
  }
  for(const id of [owner,person])
    await selected.query("INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES($1,'https://identity.example.invalid',$1,'tenant')",[id]);
  const definition={name:agent,role:'chief-of-staff',model:'lares-brain'},hash='a'.repeat(64);
  await selected.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES($1,$2::jsonb,$3,'valid')",[agent,JSON.stringify(definition),hash]);
  await selected.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending) VALUES($1,'172.30.0.9','wf','owned',$2,$2,'ready',false)",[agent,incarnation]);

  root=mkdtempSync(join(realpathSync(tmpdir()),'lares-agent-start-'));chmodSync(root,0o700);
  const directory=join(root,'journal'),options={ownershipUid:testJournalUid,lock:platformTestJournalLock},connection=await selected.connect();
  try{await prepareFinancialCustody(directory,connection,options);}finally{connection.release();}
  journal=HostFinancialJournal.openExisting(directory,{...options,requirePrepared:true});
  resetActions();
  registerBudgetAgentStartActions({pool:financial,designatedOwnerId:owner});
},120_000);
afterAll(async()=>{
  resetActions();journal?.close();
  await Promise.allSettled(pools.map(pool=>pool.end()));
  await container?.stop();
  if(root)rmSync(root,{recursive:true,force:true});
});

it('stays reachable only from the host command',async()=>{
  await expect(runAction('budget.agent-start-status',{agent},{actor:'owner@example.test',audit:auditor(selected)},{host:false})).rejects.toThrow(/host command/);
  await expect(runAction('budget.apply-default-member-limit',{memberId:person,monthlyLimit:'15'},{actor:'owner@example.test',audit:auditor(selected)},{host:false})).rejects.toThrow(/host command/);
});

it('reads a not-yet-started agent and the owner by default',async()=>{
  expect(await status()).toEqual({
    agent:{status:'valid',model:'lares-brain',incarnation,state:'ready',pending:false,pendingReason:null,owned:true},
    member:{id:owner,active:true,verified:true,limit:null,canUse:false},
    installation:null,account:null,binding:null,
  });
});

it('finds a person by exact email in any case or by id, and says when nobody matches',async()=>{
  expect((await status('person@EXAMPLE.test')).member?.id).toBe(person);
  expect((await status(person)).member?.id).toBe(person);
  expect((await status('nobody@example.test')).member).toBeNull();
  expect((await status(stranger)).member).toMatchObject({verified:false,canUse:false});
});

it('reports an agent that does not exist',async()=>{
  const missing=await runAction('budget.agent-start-status',{agent:'no-such-agent'},context(),{host:true}) as AgentStartStatus;
  expect(missing.agent).toBeNull();
  expect(missing.member?.canUse).toBe(false);
});

it('applies the default limit only to a person without one',async()=>{
  await expect(runAction('budget.apply-default-member-limit',{memberId:person,monthlyLimit:'15'},context(),{host:true})).resolves.toEqual({saved:true});
  expect(await limitOf(person)).toBe('15');
  await expect(runAction('budget.apply-default-member-limit',{memberId:person,monthlyLimit:'99'},context(),{host:true})).resolves.toEqual({saved:false});
  expect(await limitOf(person)).toBe('15');
  expect((await status(person)).member?.limit).toBe('15');
});

it('refuses an amount the ledger would not store as written',async()=>{
  for(const monthlyLimit of ['0','12.50','ten'])
    await expect(runAction('budget.apply-default-member-limit',{memberId:owner,monthlyLimit},context(),{host:true}),monthlyLimit).rejects.toThrow(/invalid/);
  expect(await limitOf(owner)).toBeUndefined();
});

it('sees access, the account and the binding once they exist',async()=>{
  await new PgGrantStore(selected).adoptAgent(owner,{agentName:agent,expectedDefinitionHash:'a'.repeat(64)},{designatedOwnerMemberId:owner});
  expect((await status()).member?.canUse).toBe(true);
  expect((await status(person)).member?.canUse).toBe(false);
  await runAction('budget.apply-default-member-limit',{memberId:owner,monthlyLimit:'15'},context(),{host:true});
  await provisionBudgetAccounts(selected,journal,{installationCap:'100',memberIds:[owner]});
  const provisioned=await status();
  expect(provisioned.installation).toEqual({state:'closed'});
  expect(provisioned.account).toEqual({state:'closed'});
  expect(provisioned.binding).toBeNull();

  const accounts=(await selected.query(`SELECT id,installation_account_id FROM budget_accounts WHERE kind='member' AND live_member_id=$1`,[owner])).rows[0];
  const bindingId=randomUUID(),fingerprint='b'.repeat(64),connection=await selected.connect();
  try{
    // The binding's own writer needs a real gateway; only the read is under test here.
    await connection.query("SET session_replication_role=replica");
    await connection.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,native_team,native_user,purpose_alias,profile_hash,maximum_liability,state)
      VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,'team','user','lares-brain',$5,1,'active')`,[bindingId,accounts.installation_account_id,accounts.id,owner,'c'.repeat(64),fingerprint,agent,incarnation]);
  }finally{await connection.query("SET session_replication_role=DEFAULT");connection.release();}
  expect((await status()).binding).toEqual({id:bindingId,credentialGeneration:'0'});
  // A limit is part of the account once it exists: the default must not touch it.
  await expect(runAction('budget.apply-default-member-limit',{memberId:owner,monthlyLimit:'99'},context(),{host:true})).resolves.toEqual({saved:false});
  expect(await limitOf(owner)).toBe('15');
});
