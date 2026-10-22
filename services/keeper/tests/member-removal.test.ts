import {chmodSync,fsyncSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createConnection} from 'node:net';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {consoleSourceTransaction,noteBudgetFinancialChange,type BudgetFinancialChange,type SourceDatabase,type SourcePool} from '@lares/agent-kit/console-source-transaction';
import {quiet} from './helpers/quiet-pool.js';
import {platformTestJournalLock,testJournalUid} from './helpers/financial-journal.js';
import {FINANCIAL_ATOM_SCHEMA,HostFinancialJournal} from '../lib/financial-journal.js';
import {prepareFinancialCustody} from '../lib/financial-continuity.js';
import {registerMemberRemovalAction} from '../lib/member-removal.js';
import {resetActions,runAction,type AuditRecord} from '../lib/actions.js';
import {PgMemberStore} from '@lares/agent-kit/member-store';
import {provisionBudgetAccounts} from '../lib/budget-account-provisioning.js';
import {JournalBudgetFinancialWriter} from '../lib/budget-financial-writer.js';
import {serve} from '../lib/socket-server.js';
import {addUnboundNativeCredential,createNativeTestCustody,openNativeTestCustody} from './helpers/native-cleanup.js';
import type {BudgetNativeCustodyStore,NativeCustodyGate} from '../lib/budget-native-custody.js';

let container:StartedPostgreSqlContainer,pool:Pool,journal:HostFinancialJournal,directory:string;
let nativeCustody:BudgetNativeCustodyStore|undefined;
const roots:string[]=[];
const sessions={designated:'A'.repeat(43),secondOwner:'B'.repeat(43),expired:'C'.repeat(43),revoked:'D'.repeat(43),fresh:'F'.repeat(43),expiring:'G'.repeat(43)};
const sessionHash=(token:string)=>createHash('sha256').update(token).digest('hex');
const context=(actor='untrusted audit text')=>({actor,audit:vi.fn(async(_record:AuditRecord)=>{})});
function register(ownerId:string|undefined,poolArg:Pool=pool,native?:BudgetNativeCustodyStore){
  registerMemberRemovalAction({pool:poolArg,journal,designatedOwnerId:ownerId,nativeCustody:native});
}
async function act(token:string,targetMemberId:string,actor?:string){
  return runAction('member.remove',{sessionToken:token,targetMemberId},context(actor));
}
async function seedFinancial(changes:readonly BudgetFinancialChange[],write:(db:SourceDatabase)=>Promise<void>){
  const writer=new JournalBudgetFinancialWriter(journal);
  await writer.run('admit',boundary=>consoleSourceTransaction(pool as unknown as SourcePool,async db=>{
    await write(db);for(const change of changes)noteBudgetFinancialChange(db,change.table,change.id);
  },boundary));
}
async function socketRequest(path:string,data:unknown):Promise<any>{
  return new Promise((resolve,reject)=>{
    const client=createConnection(path);let response='';
    client.setTimeout(5000,()=>{client.destroy();reject(new Error('socket response timed out'));});
    client.on('error',reject);client.on('connect',()=>client.write(JSON.stringify(data)+'\n'));
    client.on('data',chunk=>{response+=chunk;if(response.includes('\n')){client.destroy();resolve(JSON.parse(response.split('\n')[0]));}});
  });
}

beforeAll(async()=>{
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:4,connectionTimeoutMillis:3000}));
  const sqlDir=new URL('../../box/sql/',import.meta.url);
  for(const name of readdirSync(sqlDir).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort())
    await pool.query(readFileSync(new URL(name,sqlDir),'utf8'));
  await pool.query(`INSERT INTO orgs(id,display_name) VALUES('org-main','Main'),('org-other','Other')`);
  await pool.query(`INSERT INTO users(id,display_name,org_id,org_role,status) VALUES
    ('designated-owner','Owner','org-main','owner','active'),('second-owner','Second','org-main','owner','active'),
    ('target-active','Target','org-main','member','active'),('target-socket','Socket target','org-main','member','active'),
    ('target-invited','Invited','org-main','member','invited'),
    ('target-financial','Financial target','org-main','member','active'),('target-overflow','Overflow target','org-main','member','active'),
    ('target-concurrent','Concurrent target','org-main','member','active'),('target-config','Config target','org-main','member','active'),
    ('target-config-missing','Missing config target','org-main','member','invited'),
    ('target-foreign','Foreign','org-other','member','active'),('other-owner','Other owner','org-other','owner','active')`);
  await pool.query(`INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES
    ('target-financial','https://identity.example.invalid','financial','tenant'),
    ('target-overflow','https://identity.example.invalid','overflow','tenant'),
    ('target-concurrent','https://identity.example.invalid','concurrent','tenant')`);
  await pool.query("INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES('target-financial',30),('target-overflow',30)");
  const createdAt=new Date(Date.now()-60_000).toISOString();
  await pool.query(`INSERT INTO member_sessions(id,member_id,token_hash,created_at,expires_at,revoked_at) VALUES
    ('session-designated','designated-owner',$1,$2,clock_timestamp()+interval '1 day',NULL),
    ('session-second','second-owner',$3,$2,clock_timestamp()+interval '1 day',NULL),
    ('session-expired','designated-owner',$4,$2,$2::timestamptz+interval '1 second',NULL),
    ('session-revoked','designated-owner',$5,$2,clock_timestamp()+interval '1 day',clock_timestamp()),
    ('session-target-concurrent','target-concurrent',$6,$2,clock_timestamp()+interval '1 day',NULL),
    ('session-designated-fresh','designated-owner',$7,$2,clock_timestamp()+interval '1 day',NULL),
    ('session-designated-expiring','designated-owner',$8,$2,clock_timestamp()+interval '1 day',NULL)`,
  [sessionHash(sessions.designated),createdAt,sessionHash(sessions.secondOwner),sessionHash(sessions.expired),sessionHash(sessions.revoked),sessionHash('E'.repeat(43)),sessionHash(sessions.fresh),sessionHash(sessions.expiring)]);
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-member-removal-'));chmodSync(root,0o700);roots.push(root);directory=join(root,'financial');
  const client=await pool.connect();try{await prepareFinancialCustody(directory,client,{ownershipUid:testJournalUid,lock:platformTestJournalLock});}finally{client.release();}
  journal=HostFinancialJournal.openExisting(directory,{ownershipUid:testJournalUid,lock:platformTestJournalLock,requirePrepared:true});
});
beforeEach(resetActions);
afterAll(async()=>{resetActions();try{nativeCustody?.close();}catch{}try{journal?.close();}catch{}if(pool)await pool.end();if(container)await container.stop();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it('uses the opaque session as authority and removes a member through the prepared journal with no financial accounts',async()=>{
  register('designated-owner');const audit=context();
  await expect(runAction('member.remove',{sessionToken:sessions.designated,targetMemberId:'target-active'},audit)).resolves.toEqual({removed:true});
  expect((await pool.query("SELECT status FROM users WHERE id='target-active'")).rows[0].status).toBe('removed');
  expect(JSON.stringify(audit.audit.mock.calls)).not.toContain(sessions.designated);
  expect(JSON.stringify(audit.audit.mock.calls)).toContain('<redacted>');
  const records=readFileSync(join(directory,'journal.jsonl'),'utf8');
  expect(records).not.toContain(sessions.designated);
  const frames=records.trimEnd().split('\n').map(line=>JSON.parse(line));
  const journalRecords=frames.map(frame=>frame.record);
  const observationIndex=journalRecords.map((record,index)=>record.kind==='observation'?index:-1).filter(index=>index>=0).at(-1)!;
  expect(observationIndex).toBeGreaterThanOrEqual(4);
  expect(journalRecords.slice(observationIndex-4,observationIndex+1).map(record=>record.kind))
    .toEqual(['begin','proposal','commit','control','observation']);
  const [begin,proposal,commit,control,observation]=journalRecords.slice(observationIndex-4,observationIndex+1);
  expect(begin.operation).toBe('member-remove');
  expect(proposal.operationId).toBe(begin.operationId);
  expect(commit.operationId).toBe(begin.operationId);
  expect(observation.operationId).toBe(begin.operationId);
  const checkpoint={operationId:begin.operationId,journalId:control.control.journalId,sequence:proposal.sequence,digest:frames[observationIndex-3].digest};
  expect(commit.proposalDigest).toBe(checkpoint.digest);
  expect(control.control.checkpoint).toEqual(checkpoint);
  expect(observation.observation).toMatchObject({operationId:begin.operationId,checkpoint,database:control.control.database});
  expect(frames.slice(observationIndex-4,observationIndex+1).map(frame=>frame.record.sequence))
    .toEqual(frames.slice(observationIndex-4,observationIndex+1).map((_,index)=>frames[observationIndex-4]!.record.sequence+index));
});

it('admits the verified-email socket contract and redacts the opaque cookie in keeper audit',async()=>{
  register('designated-owner');const audit=context(),socket=join(roots[0]!, 'member-remove.sock');
  const stop=await serve({socket,host:false,context:{actor:'unused',audit:audit.audit},ownership:{uid:process.getuid!(),gid:process.getgid!()}});
  try{
    const response=await socketRequest(socket,{action:'member.remove',input:{sessionToken:sessions.fresh,targetMemberId:'target-socket'},actor:'owner@example.test'});
    expect(response).toEqual({ok:true,result:{removed:true}});
    expect(JSON.stringify(audit.audit.mock.calls)).not.toContain(sessions.fresh);
    expect(JSON.stringify(audit.audit.mock.calls)).toContain('<redacted>');
    expect((await pool.query("SELECT status FROM users WHERE id='target-socket'")).rows[0].status).toBe('removed');
  }finally{await stop();}
});

it('refuses actor claims, non-designated owners, expired or revoked sessions, self removal, and foreign targets',async()=>{
  nativeCustody=createNativeTestCustody(join(roots[0]!, 'native-refusal'));
  const refusedAccount=randomUUID();await addUnboundNativeCredential(nativeCustody,refusedAccount);
  register('designated-owner',pool,nativeCustody);
  await expect(act(sessions.secondOwner,'target-invited','designated-owner')).rejects.toThrow('Member removal was refused');
  await expect(act(sessions.expired,'target-invited')).rejects.toThrow('Member removal was refused');
  await expect(act(sessions.revoked,'target-invited')).rejects.toThrow('Member removal was refused');
  await expect(act(sessions.designated,'designated-owner')).rejects.toThrow('Member removal was refused');
  await expect(act(sessions.designated,'target-foreign')).rejects.toThrow('Member removal was refused');
  await expect(runAction('member.remove',{sessionToken:sessions.designated,targetMemberId:'target-invited',actorId:'designated-owner'},context()))
    .rejects.toThrow('invalid input');
  const state=(await pool.query("SELECT id,status FROM users WHERE id IN ('target-invited','target-foreign') ORDER BY id")).rows;
  expect(state).toEqual([{id:'target-foreign',status:'active'},{id:'target-invited',status:'invited'}]);
  await nativeCustody.withGate(async gate=>expect(gate.accountOperations(refusedAccount)).toHaveLength(1));
  nativeCustody.close();nativeCustody=openNativeTestCustody(join(roots[0]!, 'native-refusal'));
  await nativeCustody.withGate(async gate=>expect(gate.inventory().operations[0]).toMatchObject({phase:'prepared',plaintext:'present'}));
});

it('reports acknowledged SQL removal when the post-COMMIT deadline expires',async()=>{
  const databaseName=`member_deadline_${randomUUID().replaceAll('-','')}`;
  await pool.query(`CREATE DATABASE ${databaseName}`);
  const deadlineUri=new URL(container.getConnectionUri());deadlineUri.pathname=`/${databaseName}`;
  const deadlinePool=quiet(new Pool({connectionString:deadlineUri.toString(),max:4,connectionTimeoutMillis:3000}));
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-member-deadline-'));chmodSync(root,0o700);
  let deadlineJournal:HostFinancialJournal|undefined,deadlineCustody:BudgetNativeCustodyStore|undefined;
  try{
    const sqlDir=new URL('../../box/sql/',import.meta.url);
    for(const name of readdirSync(sqlDir).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort())await deadlinePool.query(readFileSync(new URL(name,sqlDir),'utf8'));
    await deadlinePool.query("INSERT INTO orgs(id,display_name) VALUES('org-main','Main')");
    await deadlinePool.query(`INSERT INTO users(id,display_name,org_id,org_role,status) VALUES
      ('designated-owner','Owner','org-main','owner','active'),('target-native-deadline','Deadline target','org-main','member','active')`);
    await deadlinePool.query(`INSERT INTO member_sessions(id,member_id,token_hash,created_at,expires_at,revoked_at)
      VALUES('session-designated','designated-owner',$1,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',NULL)`,[sessionHash(sessions.designated)]);
    const directory=join(root,'financial'),client=await deadlinePool.connect();
    try{await prepareFinancialCustody(directory,client,{ownershipUid:testJournalUid,lock:platformTestJournalLock});}finally{client.release();}
    deadlineJournal=HostFinancialJournal.openExisting(directory,{ownershipUid:testJournalUid,lock:platformTestJournalLock,requirePrepared:true});
    deadlineCustody=createNativeTestCustody(join(root,'native'));await addUnboundNativeCredential(deadlineCustody,randomUUID());
    const delayedPool=new Proxy(deadlinePool,{get(target,property){
      if(property==='connect')return async()=>{
        const client=await target.connect(),query=client.query.bind(client);
        return {release:client.release.bind(client),query:async(value:any,values?:any[])=>{
          const sql=typeof value==='string'?value:value.text,result=await query(value,values);
          if(/^\s*COMMIT\b/i.test(sql))await new Promise(resolve=>setTimeout(resolve,5_050));
          return result;
        }};
      };
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }}) as unknown as Pool;
    registerMemberRemovalAction({pool:delayedPool,journal:deadlineJournal,designatedOwnerId:'designated-owner',nativeCustody:deadlineCustody});
    await expect(runAction('member.remove',{sessionToken:sessions.designated,targetMemberId:'target-native-deadline'},context()))
      .resolves.toEqual({removed:true,nativeCleanup:{status:'blocked',remaining:null}});
    expect((await deadlinePool.query("SELECT status FROM users WHERE id='target-native-deadline'")).rows[0].status).toBe('removed');
    await expect(deadlineCustody.withGate(async()=>undefined)).rejects.toThrow('Native custody unavailable');
    await expect(deadlineJournal.operation('member-remove',async()=>undefined)).rejects.toThrow('closed');
  }finally{
    resetActions();try{deadlineCustody?.close();}catch{}try{deadlineJournal?.close();}catch{}
    await deadlinePool.end();await pool.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);rmSync(root,{recursive:true,force:true});
  }
},120_000);

it('journals trigger retirement and the expanded closure while leaving admitted history and windows unchanged',async()=>{
  await provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:['target-financial']});
  const accounts=(await pool.query(`SELECT a.id,a.kind,a.policy_generation::text,a.active_window_id,a.installation_account_id
    FROM budget_accounts a WHERE a.kind='installation' OR a.live_member_id='target-financial' ORDER BY a.kind,a.id`)).rows;
  const installation=accounts.find(row=>row.kind==='installation')!,member=accounts.find(row=>row.kind==='member')!;
  const windows=(await pool.query(`SELECT id,starts_at,ends_at,opening_liability::text,opening_cap::text,policy_revision::text
    FROM budget_windows WHERE account_id=ANY($1::uuid[]) ORDER BY id`,[[installation.id,member.id]])).rows;
  const iw=windows.find(row=>row.id===installation.active_window_id)!,mw=windows.find(row=>row.id===member.active_window_id)!;
  nativeCustody=createNativeTestCustody(join(roots[0]!, 'native'));
  const unboundOperationId=await addUnboundNativeCredential(nativeCustody,member.id,installation.id);
  const bindingId=randomUUID(),incarnation=randomUUID(),preparedId=randomUUID(),historyIds={admitted:randomUUID(),unknown:randomUUID(),settled:randomUUID()};
  const endpoint='a'.repeat(64),fingerprint='b'.repeat(64),profile='c'.repeat(64);
  const attemptIds={prepared:preparedId,...historyIds};
  await seedFinancial([{table:'budget_gateway_bindings',id:bindingId},...Object.values(attemptIds).map(id=>({table:'budget_attempts' as const,id}))],async db=>{
    await db.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,
      key_fingerprint,agent,incarnation,purpose_alias,profile_hash,maximum_liability,state)
      VALUES($1,$2,$3,'target-financial',$4,0,$5,'keeper-test',$6,'member-removal',$7,5,'active')`,
    [bindingId,installation.id,member.id,endpoint,fingerprint,incarnation,profile]);
    for(const [state,id] of Object.entries(attemptIds)){
      await db.query(`INSERT INTO budget_attempts(id,ticket_hash,invocation_hash,installation_account_id,member_account_id,binding_id,live_member_id,
        installation_window_id,member_window_id,endpoint_hash,credential_generation,installation_policy_generation,member_policy_generation,
        endpoint_generation,recovery_epoch,request_hash,authority_hash,profile_hash,reserved_amount,installation_cap_snapshot,member_cap_snapshot,
        expires_at,admitted_at,state,actual_amount,settlement_hash,highest_observed_liability)
        VALUES($1,$2,$3,$4,$5,$6,'target-financial',$7,$8,$9,0,$10,$11,0,'proof-epoch',$12,$13,$14,2,100,30,
          clock_timestamp()+interval '20 seconds',CASE WHEN $15='prepared' THEN NULL ELSE clock_timestamp() END,$15,
          CASE WHEN $15='settled' THEN 2 ELSE NULL END,CASE WHEN $15='settled' THEN $16 ELSE NULL END,0)`,
      [id,createHash('sha256').update(`ticket-${state}`).digest('hex'),createHash('sha256').update(`invocation-${state}`).digest('hex'),
        installation.id,member.id,bindingId,iw.id,mw.id,endpoint,installation.policy_generation,member.policy_generation,
        createHash('sha256').update(`request-${state}`).digest('hex'),createHash('sha256').update(`authority-${state}`).digest('hex'),profile,state,
        createHash('sha256').update('settlement').digest('hex')]);
    }
  });
  const originalWindows=await pool.query('SELECT id,starts_at,ends_at,opening_liability::text,opening_cap::text,policy_revision::text FROM budget_windows ORDER BY id');
  const originalWithGate=nativeCustody.withGate,ownedWithGate=nativeCustody.withGate.bind(nativeCustody),publicationAttempts:Promise<string>[]=[];
  nativeCustody.withGate=async <T>(work:(gate:NativeCustodyGate)=>Promise<T>)=>ownedWithGate(gate=>work({...gate,recordRevocation:(operationId,receipt)=>{
      publicationAttempts.push(journal.operation('settle',async()=>undefined).then(()=> 'entered',error=>error instanceof Error?error.message:'failed'));
      return gate.recordRevocation(operationId,receipt);
    }}));
  register('designated-owner',pool,nativeCustody);
  const removal=await act(sessions.designated,'target-financial');
  nativeCustody.withGate=originalWithGate;
  expect(removal).toEqual({removed:true,nativeCleanup:{status:'pending',remaining:1}});
  await expect(Promise.all(publicationAttempts)).resolves.toEqual(['Financial journal is closed or busy']);
  await nativeCustody.withGate(async gate=>expect(gate.inventory().operations[0]).toMatchObject({operationId:unboundOperationId,phase:'revoke-pending',plaintext:'removed',nativeDeletion:'unverified'}));
  const result=(await pool.query(`SELECT kind,state,reason,policy_generation::text,active_window_id FROM budget_accounts
    WHERE id=ANY($1::uuid[]) ORDER BY kind,id`,[[installation.id,member.id]])).rows;
  expect(result.find(row=>row.kind==='member')).toEqual({kind:'member',state:'retired',reason:'member_removed',
    policy_generation:String(BigInt(member.policy_generation)+1n),active_window_id:member.active_window_id});
  expect(result.find(row=>row.kind==='installation')).toMatchObject({state:'closed',reason:'unreconciled',policy_generation:installation.policy_generation});
  expect((await pool.query('SELECT state FROM budget_gateway_bindings WHERE id=$1',[bindingId])).rows[0].state).toBe('revoked');
  const attemptStates=(await pool.query('SELECT id,state,actual_amount::text,settlement_hash FROM budget_attempts WHERE id=ANY($1::uuid[]) ORDER BY id',
    [Object.values(attemptIds)])).rows;
  expect(attemptStates.find(row=>row.id===preparedId).state).toBe('retired');
  expect(attemptStates.filter(row=>row.id!==preparedId).map(row=>[row.id,row.state,row.actual_amount,row.settlement_hash]).sort())
    .toEqual([
      [historyIds.admitted,'admitted',null,null],[historyIds.unknown,'unknown',null,null],
      [historyIds.settled,'settled','2',createHash('sha256').update('settlement').digest('hex')],
    ].sort());
  expect((await pool.query('SELECT id,starts_at,ends_at,opening_liability::text,opening_cap::text,policy_revision::text FROM budget_windows ORDER BY id')).rows)
    .toEqual(originalWindows.rows);
  const records=readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line).record);
  const proposal=records.filter(record=>record.kind==='proposal').at(-1);
  expect(proposal.atoms.filter((atom:any)=>atom.kind==='attempt').map((atom:any)=>atom.id)).toEqual([preparedId]);
  expect(proposal.atoms.some((atom:any)=>Object.values(historyIds).includes(atom.id))).toBe(false);
});

it('refuses an expanded preimage closure above 128 atoms before the status trigger runs',async()=>{
  register('designated-owner');
  await provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:['target-overflow']});
  const rows=(await pool.query(`SELECT i.id AS installation_id,m.id AS member_id FROM budget_accounts i
    JOIN budget_accounts m ON m.installation_account_id=i.id AND m.live_member_id='target-overflow' WHERE i.kind='installation'`)).rows[0];
  const bindingIds=Array.from({length:127},()=>randomUUID());
  for(const batch of [bindingIds.slice(0,64),bindingIds.slice(64)])await seedFinancial(batch.map(id=>({table:'budget_gateway_bindings',id})),async db=>{
    await db.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,
      key_fingerprint,agent,incarnation,purpose_alias,profile_hash,maximum_liability,state)
      SELECT id,$1,$2,'target-overflow',repeat('a',64),0,repeat('b',64),'keeper-test',gen_random_uuid(),
        'overflow-'||id::text,repeat('c',64),5,'active' FROM unnest($3::uuid[]) AS selected(id)`,[rows.installation_id,rows.member_id,batch]);
  });
  const beforeProposals=readFileSync(join(directory,'journal.jsonl'),'utf8').split('\n').filter(line=>line.includes('"kind":"proposal"')).length;
  await expect(act(sessions.designated,'target-overflow')).rejects.toThrow('action failed');
  expect((await pool.query("SELECT status FROM users WHERE id='target-overflow'")).rows[0].status).toBe('active');
  expect((await pool.query("SELECT count(*)::int AS n FROM budget_gateway_bindings WHERE live_member_id='target-overflow' AND state='active'")).rows[0].n).toBe(127);
  const after=readFileSync(join(directory,'journal.jsonl'),'utf8');
  expect(after.split('\n').filter(line=>line.includes('"kind":"proposal"'))).toHaveLength(beforeProposals);
  expect(after).not.toContain('"kind":"freeze"');
});

it('refuses a proposal frame above 64 KiB through the shared exact preflight validator',async()=>{
  const repeated=Array.from({length:64},()=> 'a'.repeat(64));
  const atoms=Array.from({length:16},()=>FINANCIAL_ATOM_SCHEMA.parse({kind:'account',id:randomUUID(),installationAccountId:randomUUID(),
    accountKind:'member',state:'retired',reason:'member_removed',activeWindowId:randomUUID(),installationCap:null,policyGeneration:'1',
    selectedEndpointHash:null,endpointGeneration:'0',recoveryEpochHash:null,canonicalSuppressionHash:'b'.repeat(64),providerSuppressionHashes:repeated}));
  const before=readFileSync(join(directory,'journal.jsonl'),'utf8');
  await journal.operation('member-remove',async operationId=>{
    expect(()=>journal.validateProposal(operationId,atoms)).toThrow('Financial proposal exceeds journal record limit');
    journal.aborted(operationId,'not-started');
  });
  const after=readFileSync(join(directory,'journal.jsonl'),'utf8');
  expect(after.split('\n').filter(line=>line.includes('"kind":"proposal"'))).toHaveLength(before.split('\n').filter(line=>line.includes('"kind":"proposal"')).length);
  expect(after).not.toContain('"kind":"freeze"');
});

it('rolls back when the opaque session expires during proposal fsync and remains usable after a known abort',async()=>{
  const expiry=(await pool.query(`UPDATE member_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1
    RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at`,[sessionHash(sessions.designated)])).rows[0].expires_at;
  const expiryMs=Date.parse(expiry);let syncCount=0,proposalFsyncReached=false;
  journal.close();journal=HostFinancialJournal.openExisting(directory,{ownershipUid:testJournalUid,lock:platformTestJournalLock,requirePrepared:true,
    sync:fd=>{fsyncSync(fd);if(++syncCount===3){proposalFsyncReached=true;const wait=new Int32Array(new SharedArrayBuffer(4));while(Date.now()<expiryMs+40)Atomics.wait(wait,0,0,Math.min(100,expiryMs+40-Date.now()));}}});
  register('designated-owner');
  await expect(act(sessions.designated,'target-invited')).rejects.toThrow('Member removal was refused');
  expect(proposalFsyncReached).toBe(true);
  expect((await pool.query("SELECT status FROM users WHERE id='target-invited'")).rows[0].status).toBe('invited');
  const aborted=readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line).record).at(-1);
  expect(aborted).toMatchObject({kind:'abort',reason:'rollback-acknowledged'});
  expect(readFileSync(join(directory,'journal.jsonl'),'utf8')).not.toContain('"kind":"freeze"');
  await expect(act(sessions.fresh,'target-invited')).resolves.toEqual({removed:true});
});

it('rolls back when the session expires during final continuity and does not freeze a known abort',async()=>{
  const expiry=(await pool.query(`UPDATE member_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1
    RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at`,[sessionHash(sessions.expiring)])).rows[0].expires_at;
  const expiryMs=Date.parse(expiry);let finalContinuityReached=false,observations=0;
  const delayedPool=new Proxy(pool,{get(target,property){
    if(property==='connect')return async()=>{
      const client=await target.connect(),query=client.query.bind(client);
      return {release:client.release.bind(client),query:async(value:any,values?:any[])=>{
        const sql=typeof value==='string'?value:value.text;
        if(sql.includes('pg_control_system')&&++observations===2){finalContinuityReached=true;await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiryMs-Date.now()+40)));}
        return query(value,values);
      }};
    };
    const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }}) as unknown as Pool;
  register('designated-owner',delayedPool);
  await expect(act(sessions.expiring,'target-config')).rejects.toThrow('Member removal was refused');
  expect(finalContinuityReached).toBe(true);
  expect((await pool.query("SELECT status FROM users WHERE id='target-config'")).rows[0].status).toBe('active');
  expect(readFileSync(join(directory,'journal.jsonl'),'utf8')).not.toContain('"kind":"freeze"');
  const abort=readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line).record).at(-1);
  expect(abort).toMatchObject({kind:'abort',reason:'rollback-acknowledged'});
  await expect(act(sessions.fresh,'target-config')).resolves.toEqual({removed:true});
});

it('requires configured designated ownership and a prepared journal before opening the budget transaction',async()=>{
  register(undefined);const audit=context();
  await expect(runAction('member.remove',{sessionToken:sessions.designated,targetMemberId:'target-config-missing'},audit)).rejects.toThrow('Member removal was refused');
  expect(audit.audit).toHaveBeenCalled();
  expect((await pool.query("SELECT status FROM users WHERE id='target-config-missing'")).rows[0].status).toBe('invited');
});

it('serializes session issuance with removal so any issued session is unusable afterward',async()=>{
  register('designated-owner');
  const store=new PgMemberStore(pool);
  const proof={identity:{issuer:'https://identity.example.invalid',subject:'concurrent',tenantId:'tenant'},verifiedAt:new Date()};
  const [removal,session]=await Promise.allSettled([
    act(sessions.fresh,'target-concurrent'),
    store.createSession(proof,new Date(Date.now()+60_000)),
  ]);
  expect(removal.status).toBe('fulfilled');
  if(session.status==='fulfilled')expect(await store.sessionMember(session.value.token)).toBeUndefined();
  else expect(session.reason).toMatchObject({code:'denied'});
  expect(await store.currentMember('target-concurrent')).toBeUndefined();
});

it('freezes native custody when SQL committed but the journal control fsync is unknown',async()=>{
  nativeCustody=createNativeTestCustody(join(roots[0]!, 'native-uncertain'));
  await addUnboundNativeCredential(nativeCustody,randomUUID());
  await pool.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('target-native-uncertain','Uncertain target','org-main','member','active')");
  const priorControl=readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line).record)
    .filter(record=>record.kind==='control').at(-1)?.control.checkpoint?.operationId;
  journal.close();
  journal=HostFinancialJournal.openExisting(directory,{ownershipUid:testJournalUid,lock:platformTestJournalLock,requirePrepared:true,
    sync:fd=>{
      fsyncSync(fd);
      const last=readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').at(-1);
      if(!last)return;
      const record=JSON.parse(last).record;
      if(record.kind==='control'&&record.control.checkpoint?.operationId&&record.control.checkpoint.operationId!==priorControl)
        throw new Error('synthetic terminal control fsync failure');
    }});
  register('designated-owner',pool,nativeCustody);
  const actionResult=await act(sessions.fresh,'target-native-uncertain').catch(error=>error);
  expect((await pool.query("SELECT status FROM users WHERE id='target-native-uncertain'")).rows[0].status).toBe('removed');
  expect(actionResult).toEqual({removed:true,nativeCleanup:{status:'blocked',remaining:null}});
  await expect(nativeCustody.withGate(async()=>undefined)).rejects.toThrow('Native custody unavailable');
  nativeCustody.close();
  expect(()=>openNativeTestCustody(join(roots[0]!, 'native-uncertain'))).toThrow('reconciliation');
});
