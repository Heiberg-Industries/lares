import {chmodSync,fsyncSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool,type PoolClient} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {quiet} from './helpers/quiet-pool.js';
import {HostFinancialJournal} from '../lib/financial-journal.js';
import {prepareFinancialCustody} from '../lib/financial-continuity.js';
import {JournalBudgetFinancialWriter} from '../lib/budget-financial-writer.js';
import {budgetAccountProvisionPlanSchema,provisionBudgetAccounts} from '../lib/budget-account-provisioning.js';
import {platformTestJournalLock,testJournalUid} from './helpers/financial-journal.js';
import {consoleSourceTransaction,noteBudgetFinancialChange} from '@lares/agent-kit/console-source-transaction';

let container:StartedPostgreSqlContainer;
let pool:Pool,admin:Pool;
const pools:Pool[]=[],journals:HostFinancialJournal[]=[],roots:string[]=[];
const uid=testJournalUid;
const lock=platformTestJournalLock;
let syncCount=0,failSyncAt=0;
const sync=(fd:number)=>{fsyncSync(fd);syncCount++;if(failSyncAt===syncCount){failSyncAt=0;throw new Error('synthetic journal fsync failure');}};
const id=()=>randomUUID();
const journalOptions={ownershipUid:uid,lock,sync};
const plan={installationCap:'100',memberIds:['budget-member-a','budget-member-b']};
const journalRecords=(directory:string)=>readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line).record);
const poolCustody=new WeakMap<Pool,{journal:HostFinancialJournal;directory:string}>();
const dbTime=(date:Date)=>date.toISOString().replace('.000Z','.000000Z');
const nextMonth=(date:Date)=>new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1));
async function boundedClose(action:()=>Promise<unknown>,label:string,ms=5000):Promise<void>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([action(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} cleanup timed out`)),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}

function dbPool(database:string,max=1):Pool{
  const uri=new URL(container.getConnectionUri());uri.pathname='/'+database;
  const selected=quiet(new Pool({connectionString:uri.toString(),max,connectionTimeoutMillis:3000}));pools.push(selected);return selected;
}
async function custody(selected:Pool):Promise<{journal:HostFinancialJournal;directory:string}>{
  const existing=poolCustody.get(selected);if(existing)return existing;
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-budget-provision-'));chmodSync(root,0o700);roots.push(root);
  const directory=join(root,'journal'),connection=await selected.connect();
  try{await prepareFinancialCustody(directory,connection,journalOptions);}finally{connection.release();}
  const journal=HostFinancialJournal.openExisting(directory,{...journalOptions,requirePrepared:true});journals.push(journal);
  const value={journal,directory};poolCustody.set(selected,value);return value;
}
async function seed(selected:Pool,suffix=''){
  const org=`budget-org${suffix}`,owner=`budget-owner${suffix}`,a=`budget-member-a${suffix}`,b=`budget-member-b${suffix}`;
  await selected.query('INSERT INTO orgs(id,display_name) VALUES($1,$2)',[org,'Budget test']);
  await selected.query(`INSERT INTO users(id,display_name,org_id,org_role,status) VALUES
    ($1,'Owner',$2,'owner','active'),($3,'Member A',$2,'member','active'),($4,'Member B',$2,'member','active')`,[owner,org,a,b]);
  await selected.query(`INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES
    ($1,'https://identity.example.invalid',$2,'tenant'),($3,'https://identity.example.invalid',$4,'tenant')`,[a,`subject-a${suffix}`,b,`subject-b${suffix}`]);
  await selected.query('INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES($1,25),($2,40)',[a,b]);
  return {org,owner,a,b};
}
async function migrate(selected:Pool):Promise<void>{
  const sqlDir=new URL('../../box/sql/',import.meta.url);
  for(const name of readdirSync(sqlDir).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort())
    await selected.query(readFileSync(new URL(name,sqlDir),'utf8'));
}
async function paused():Promise<{reached:Promise<void>;resume:()=>void;readMonth:()=>Promise<{startsAt:string;endsAt:string}>}>{
  let signal!:()=>void,release!:()=>void;
  const reached=new Promise<void>(resolve=>{signal=resolve;});
  const wait=new Promise<void>(resolve=>{release=resolve;});
  return {reached,resume:release,readMonth:async()=>{signal();await wait;return {startsAt:'2026-10-01T00:00:00.000000Z',endsAt:'2026-11-01T00:00:00.000000Z'};}};
}
async function waitForLocks(selected:Pool,pids:number[]):Promise<void>{
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){
    const rows=(await selected.query(`SELECT pid FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'`,[pids])).rows;
    if(rows.length===pids.length)return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('Concurrent writer did not wait for source locks');
}

beforeAll(async()=>{
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool=dbPool(container.getDatabase(),1);admin=dbPool('postgres',4);
  await migrate(pool);const migrationPool=pool;await pool.end();pools.splice(pools.indexOf(migrationPool),1);
  const base=container.getDatabase();
  for(const database of ['budget_proposal_failure','budget_control_failure','budget_commit_unknown','budget_identity','budget_concurrent'])
    await admin.query(`CREATE DATABASE ${database} TEMPLATE ${base}`);
  await admin.query(`CREATE DATABASE budget_proposal_size_failure TEMPLATE ${base}`);
  pool=dbPool(base,1);
});
afterAll(async()=>{
  for(const journal of journals.splice(0)){try{journal.close();}catch{}}
  for(const selected of pools.splice(0))await boundedClose(()=>selected.end(),'PostgreSQL pool');
  if(container)await boundedClose(()=>container.stop(),'Test PostgreSQL container',10_000);
  for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
});

it('validates plans and provisions only closed accounts with locked live identity and cap evidence',async()=>{
  const users=await seed(pool),{journal,directory}=await custody(pool);
  expect(budgetAccountProvisionPlanSchema.safeParse({installationCap:'0',memberIds:[users.a]}).success).toBe(false);
  expect(budgetAccountProvisionPlanSchema.safeParse({installationCap:'01',memberIds:[users.a]}).success).toBe(false);
  expect(budgetAccountProvisionPlanSchema.safeParse({installationCap:'10',memberIds:[users.a,users.a]}).success).toBe(false);

  await pool.query(`INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('budget-missing-cap','No cap',$1,'member','active'),('budget-zero-cap','Zero cap',$1,'member','active'),('budget-too-many-providers','Many providers',$1,'member','active')`,[users.org]);
  await pool.query(`INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES
    ('budget-missing-cap','https://identity.example.invalid','missing-cap','tenant'),
    ('budget-zero-cap','https://identity.example.invalid','zero-cap','tenant'),
    ('budget-too-many-providers','https://identity.example.invalid','too-many-0','tenant')`);
  await pool.query("INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES('budget-zero-cap',0),('budget-too-many-providers',10)");
  await pool.query(`INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id)
    SELECT 'budget-too-many-providers','https://identity.example.invalid','too-many-'||provider::text,'tenant' FROM generate_series(1,64) provider`);

  await expect(provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:[users.a,'budget-missing-cap']})).rejects.toThrow();
  await expect(provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:['budget-zero-cap']})).rejects.toThrow();
  await expect(provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:['budget-too-many-providers']})).rejects.toThrow();
  await expect(pool.query('SELECT id FROM budget_accounts')).resolves.toMatchObject({rows:[]});

  const created=await provisionBudgetAccounts(pool,journal,plan);
  expect(created).toEqual({state:'closed',reason:'unreconciled',members:2,accountsCreated:3,windowsCreated:3});
  const accounts=(await pool.query(`SELECT kind,live_member_id,organisation_id,state,reason,policy_generation,active_window_id,installation_cap,selected_endpoint,recovery_epoch
    FROM budget_accounts ORDER BY kind,id`)).rows;
  expect(accounts).toHaveLength(3);
  expect(accounts.every(row=>row.state==='closed'&&row.reason==='unreconciled'&&row.selected_endpoint===null&&row.recovery_epoch===null&&row.policy_generation==='1'&&row.active_window_id)).toBe(true);
  const windows=(await pool.query('SELECT opening_liability::text,opening_cap::text,policy_revision::text,starts_at,ends_at FROM budget_windows ORDER BY account_id')).rows;
  expect(windows).toHaveLength(3);
  expect(windows.every(row=>row.opening_liability==='0'&&row.policy_revision==='1'&&row.starts_at.getUTCDate()===1&&row.starts_at.getUTCHours()===0&&row.starts_at.getUTCMinutes()===0&&row.starts_at.getUTCSeconds()===0&&row.ends_at.getTime()===nextMonth(row.starts_at).getTime())).toBe(true);
  expect(windows.map(row=>row.opening_cap).sort()).toEqual(['100','25','40']);

  const exact=await provisionBudgetAccounts(pool,journal,plan);
  expect(exact.accountsCreated).toBe(0);expect(exact.windowsCreated).toBe(0);
  const changed=await provisionBudgetAccounts(pool,journal,{...plan,installationCap:'120'});
  expect(changed.accountsCreated).toBe(0);expect(changed.windowsCreated).toBe(0);
  const afterChange=(await pool.query(`SELECT installation_cap::text,policy_generation::text FROM budget_accounts WHERE kind='installation'`)).rows[0];
  expect(afterChange).toEqual({installation_cap:'120',policy_generation:'2'});
  expect((await pool.query('SELECT count(*)::int AS n, max(opening_cap)::text AS cap FROM budget_windows')).rows[0]).toEqual({n:3,cap:'100'});
  await new JournalBudgetFinancialWriter(journal).run('provision',boundary=>consoleSourceTransaction(pool,async db=>{
    const affected=(await db.query('SELECT id FROM budget_accounts WHERE live_member_id=$1 ORDER BY id FOR UPDATE',[users.a])).rows;
    await db.query('UPDATE org_member_policy SET spend_cap_usd_month=30 WHERE user_id=$1',[users.a]);
    for(const account of affected)noteBudgetFinancialChange(db,'budget_accounts',account.id);
  },boundary));
  const memberPolicyChange=await provisionBudgetAccounts(pool,journal,{...plan,installationCap:'120'});
  expect(memberPolicyChange.windowsCreated).toBe(0);
  expect((await pool.query('SELECT count(*)::int AS n FROM budget_windows')).rows[0].n).toBe(3);

  // Preserve a prior unresolved liability and its original windows. Account setup must
  // not migrate that exposure into the new window or settle it as a late receipt.
  const financial=(await pool.query(`SELECT i.id AS installation_id,i.active_window_id AS installation_window,m.id AS member_id,m.live_member_id,
      m.active_window_id AS member_window,i.policy_generation AS installation_generation,m.policy_generation AS member_generation,i.endpoint_generation
    FROM budget_accounts i JOIN budget_accounts m ON m.installation_account_id=i.id AND m.live_member_id=$1 WHERE i.kind='installation'`,[users.a])).rows[0];
  const bindingId=id(),attemptId=id(),ticket=createHash('sha256').update(randomUUID()).digest('hex');
  const opaqueHash='a'.repeat(64);
  await new JournalBudgetFinancialWriter(journal).run('unknown',boundary=>consoleSourceTransaction(pool,async db=>{
    await db.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,profile_hash,maximum_liability,state)
      VALUES($1,$2,$3,$4,$5,0,$6,5,'revoked')`,[bindingId,financial.installation_id,financial.member_id,financial.live_member_id,opaqueHash,opaqueHash]);
    noteBudgetFinancialChange(db,'budget_gateway_bindings',bindingId);
    await db.query(`INSERT INTO budget_attempts(id,invocation_hash,ticket_hash,installation_account_id,member_account_id,binding_id,live_member_id,installation_window_id,member_window_id,
      endpoint_hash,credential_generation,installation_policy_generation,member_policy_generation,endpoint_generation,recovery_epoch,request_hash,authority_hash,profile_hash,
      reserved_amount,installation_cap_snapshot,member_cap_snapshot,expires_at,admitted_at,state,highest_observed_liability)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,'unresolved-proof',$14,$15,$16,5,120,30,clock_timestamp()+interval '20 seconds',clock_timestamp(),'unknown',5)`
    ,[attemptId,opaqueHash,ticket,financial.installation_id,financial.member_id,bindingId,financial.live_member_id,financial.installation_window,financial.member_window,
      opaqueHash,financial.installation_generation,financial.member_generation,financial.endpoint_generation,opaqueHash,opaqueHash,opaqueHash]);
    noteBudgetFinancialChange(db,'budget_attempts',attemptId);
  },boundary));
  const originalAttempt=(await pool.query('SELECT state,highest_observed_liability::text,actual_amount,settlement_hash,installation_window_id,member_window_id FROM budget_attempts WHERE id=$1',[attemptId])).rows[0];

  const rolloverStarts=windows[0].ends_at,rolloverEnds=nextMonth(rolloverStarts);
  const rollover=await provisionBudgetAccounts(pool,journal,{...plan,installationCap:'120'},async()=>({startsAt:dbTime(rolloverStarts),endsAt:dbTime(rolloverEnds)}));
  expect(rollover.accountsCreated).toBe(0);expect(rollover.windowsCreated).toBe(3);
  expect((await pool.query('SELECT count(*)::int AS n FROM budget_windows')).rows[0].n).toBe(6);
  const current=(await pool.query(`SELECT a.policy_generation::text,w.policy_revision::text,w.opening_liability::text
    FROM budget_accounts a JOIN budget_windows w ON w.id=a.active_window_id ORDER BY a.kind,a.id`)).rows;
  expect(current).toHaveLength(3);expect(current.every(row=>row.policy_generation===row.policy_revision&&row.opening_liability==='0')).toBe(true);
  expect((await pool.query('SELECT state,highest_observed_liability::text,actual_amount,settlement_hash,installation_window_id,member_window_id FROM budget_attempts WHERE id=$1',[attemptId])).rows[0]).toEqual(originalAttempt);
  const atoms=journalRecords(directory).filter(record=>record.kind==='proposal').flatMap(record=>record.atoms);
  expect(atoms.filter(atom=>atom.kind==='account').every(atom=>typeof atom.policyGeneration==='string')).toBe(true);
  const encoded=JSON.stringify(journalRecords(directory));
  for(const privateValue of [users.a,users.b,'subject-a','subject-b','https://identity.example.invalid'])expect(encoded).not.toContain(privateValue);
});

it('refuses changed identity sets, organisation drift, cross-organisation plans and provider tombstone collisions',async()=>{
  const selected=dbPool('budget_identity'),users=await seed(selected,'-identity'),{journal}=await custody(selected);
  await selected.query("INSERT INTO orgs(id,display_name) VALUES('budget-other-org','Other'); INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('budget-other-owner','Other owner','budget-other-org','owner','active')");
  await selected.query("INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES('budget-other-owner','https://identity.example.invalid','other-owner','tenant')");
  await selected.query("INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES('budget-other-owner',50)");
  await expect(provisionBudgetAccounts(selected,journal,{installationCap:'100',memberIds:[users.a,'budget-other-owner']})).rejects.toThrow();
  await provisionBudgetAccounts(selected,journal,{installationCap:'100',memberIds:[users.a]});
  await selected.query("UPDATE member_provider_identities SET subject='changed-subject' WHERE member_id=$1",[users.a]);
  await expect(provisionBudgetAccounts(selected,journal,{installationCap:'100',memberIds:[users.a]})).rejects.toThrow();
  await selected.query("UPDATE member_provider_identities SET subject='subject-a-identity' WHERE member_id=$1",[users.a]);
  await selected.query("UPDATE users SET org_id='budget-other-org' WHERE id=$1",[users.a]);
  await expect(provisionBudgetAccounts(selected,journal,{installationCap:'100',memberIds:[users.a]})).rejects.toThrow();
  await selected.query('UPDATE users SET org_id=$2 WHERE id=$1',[users.a,users.org]);

  await selected.query(`INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('budget-tombstone-member','Tombstone',$1,'member','active')`,[users.org]);
  await selected.query("INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES('budget-tombstone-member','https://identity.example.invalid','rejoined-provider','tenant')");
  await selected.query("INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES('budget-tombstone-member',12)");
  const digests=journal.suppression({canonicalMemberId:'budget-tombstone-member',providers:[{issuer:'https://identity.example.invalid',subject:'rejoined-provider',tenantId:'tenant'}]});
  const installation=(await selected.query("SELECT id,installation_id FROM budget_accounts WHERE kind='installation'")).rows[0];
  const tombstoneAccountId=id();
  await new JournalBudgetFinancialWriter(journal).run('member-remove',boundary=>consoleSourceTransaction(selected,async db=>{
    await db.query(`INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,live_member_id,organisation_id,canonical_suppression_hash,provider_suppression_hashes)
      VALUES($1,$2,'member',$3,'budget-tombstone-member',$4,$5,$6)`,[tombstoneAccountId,installation.installation_id,installation.id,users.org,digests.canonicalSuppressionHash,digests.providerSuppressionHashes]);
    await db.query("DELETE FROM users WHERE id='budget-tombstone-member'");
    noteBudgetFinancialChange(db,'budget_accounts',tombstoneAccountId);
  },boundary));
  expect((await selected.query('SELECT live_member_id,canonical_suppression_hash,provider_suppression_hashes FROM budget_accounts WHERE id=$1',[tombstoneAccountId])).rows[0]).toEqual({
    live_member_id:null,canonical_suppression_hash:digests.canonicalSuppressionHash,provider_suppression_hashes:digests.providerSuppressionHashes,
  });
  await selected.query(`INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('budget-rejoined-member','Rejoined',$1,'member','active')`,[users.org]);
  await selected.query("INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES('budget-rejoined-member','https://identity.example.invalid','rejoined-provider','tenant')");
  await selected.query("INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES('budget-rejoined-member',12)");
  await expect(provisionBudgetAccounts(selected,journal,{installationCap:'100',memberIds:['budget-rejoined-member']}))
    .rejects.toThrow('Budget account provisioning refused; financial recovery may be required');
  await expect(provisionBudgetAccounts(selected,journal,{installationCap:'100',memberIds:[users.a]}))
    .resolves.toMatchObject({state:'closed',members:1,accountsCreated:0,windowsCreated:0});
});

it('serializes concurrent policy and member changes behind the selected-user recheck',async()=>{
  const selected=dbPool('budget_concurrent'),users=await seed(selected,'-concurrent'),{journal}=await custody(selected),other=dbPool('budget_concurrent',3);
  const hold=await paused();
  let operation:ReturnType<typeof provisionBudgetAccounts>|undefined;
  let policyUpdate:Promise<unknown>|undefined,memberUpdate:Promise<unknown>|undefined;
  let policy:PoolClient|undefined,member:PoolClient|undefined;
  let policyTransaction=false,memberTransaction=false;
  try{
    operation=provisionBudgetAccounts(selected,journal,{installationCap:'100',memberIds:[users.a,users.b]},hold.readMonth);
    await hold.reached;
    policy=await other.connect();member=await other.connect();
    const policyPid=(await policy.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const memberPid=(await member.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await policy.query('BEGIN');policyTransaction=true;
    await member.query('BEGIN');memberTransaction=true;
    policyUpdate=policy.query('UPDATE org_member_policy SET spend_cap_usd_month=55 WHERE user_id=$1',[users.a]);
    memberUpdate=member.query("UPDATE users SET status='removed' WHERE id=$1",[users.b]);
    await waitForLocks(other,[policyPid,memberPid]);
    hold.resume();
    await expect(operation).resolves.toMatchObject({state:'closed',members:2});
    // Keep the released source writers uncommitted until the provisioning observer has
    // published its own post-COMMIT projection. Then serialize their trigger-written account
    // changes: member retirement takes the shared installation lock before its member account.
    await policyUpdate;
    await policy.query('COMMIT');policyTransaction=false;
    await memberUpdate;
    await member.query('COMMIT');memberTransaction=false;
    expect((await selected.query('SELECT spend_cap_usd_month::text AS cap FROM org_member_policy WHERE user_id=$1',[users.a])).rows[0].cap).toBe('55');
    expect((await selected.query("SELECT state,reason FROM budget_accounts WHERE live_member_id=$1",[users.b])).rows[0]).toEqual({state:'retired',reason:'member_removed'});
  }finally{
    hold.resume();
    if(operation)await boundedClose(()=>Promise.allSettled([operation!]),'Provisioning observer',4000);
    if(policy){
      const rollback=policyTransaction?policy.query('ROLLBACK').then(()=>{policyTransaction=false;}):undefined;
      const pending=[policyUpdate,rollback].filter((value):value is Promise<unknown>=>Boolean(value));
      if(pending.length)await boundedClose(()=>Promise.allSettled(pending),'Policy source writer',4000);
      policy.release();
    }
    if(member){
      const pending=[memberUpdate].filter((value):value is Promise<unknown>=>Boolean(value));
      if(pending.length)await boundedClose(()=>Promise.allSettled(pending),'Member source writer',4000);
      if(memberTransaction)await boundedClose(()=>member!.query('ROLLBACK'),'Member source rollback',4000);
      member.release();
    }
  }
},12_000);

it('does not expose success after proposal fsync failure, control fsync failure, or unknown COMMIT',async()=>{
  const cases=[
    {database:'budget_proposal_failure',fail:'proposal'},
    {database:'budget_control_failure',fail:'control'},
    {database:'budget_commit_unknown',fail:'commit'},
    {database:'budget_proposal_size_failure',fail:'proposal-size'},
  ] as const;
  for(const scenario of cases){
    const selected=dbPool(scenario.database,1);
    let memberIds:string[];
    if(scenario.fail==='proposal-size'){
      await selected.query("INSERT INTO orgs(id,display_name) VALUES('budget-size-org','Large projection')");
      await selected.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('budget-size-owner','Owner','budget-size-org','owner','active')");
      memberIds=Array.from({length:16},(_,index)=>`budget-size-member-${index}`);
      await selected.query('INSERT INTO users(id,display_name,org_id,org_role,status) SELECT member_id,member_id,\'budget-size-org\',\'member\',\'active\' FROM unnest($1::text[]) AS u(member_id)',[memberIds]);
      await selected.query('INSERT INTO org_member_policy(user_id,spend_cap_usd_month) SELECT member_id,25 FROM unnest($1::text[]) AS u(member_id)',[memberIds]);
      await selected.query(`INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id)
        SELECT member_id,'https://identity.example.invalid',member_id||'-'||provider::text,'tenant'
        FROM unnest($1::text[]) AS u(member_id) CROSS JOIN generate_series(0,63) provider`,[memberIds]);
    }else memberIds=[(await seed(selected,`-${scenario.fail}`)).a];
    const {journal,directory}=await custody(selected);
    if(scenario.fail==='proposal')failSyncAt=syncCount+2;
    if(scenario.fail==='control')failSyncAt=syncCount+4;
    const source=scenario.fail==='commit'?{
      query:selected.query.bind(selected),
      connect:async()=>{
        const client=await selected.connect();
        return {query:async(sql:string,values?:unknown[])=>{
          const value=await client.query(sql,values);
          return sql==='COMMIT'?{...value,command:'UNKNOWN'}:value;
        },release:(error?:boolean)=>client.release(error)};
      },
    }:selected;
    await expect(provisionBudgetAccounts(source as never,journal,{installationCap:'100',memberIds})).rejects.toThrow();
    if(scenario.fail==='proposal-size'){
      expect(journalRecords(directory).some(record=>record.kind==='abort')).toBe(true);
    }else{
      await expect(provisionBudgetAccounts(selected,journal,{installationCap:'100',memberIds})).rejects.toThrow();
    }
    if(scenario.fail==='proposal'||scenario.fail==='proposal-size'){
      expect((await selected.query('SELECT count(*)::int AS n FROM budget_accounts')).rows[0].n).toBe(0);
      expect((await selected.query('SELECT count(*)::int AS n FROM budget_windows')).rows[0].n).toBe(0);
      expect((await selected.query('SELECT count(*)::int AS n FROM budget_financial_checkpoints')).rows[0].n).toBe(0);
    }else expect((await selected.query('SELECT count(*)::int AS n FROM budget_accounts')).rows[0].n).toBe(2);
  }
});
