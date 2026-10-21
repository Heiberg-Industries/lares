import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {readFileSync,readdirSync,mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {rememberValid} from '../../../packages/agent-kit/src/definition-cache.js';
import {PgGrantStore} from '../../../packages/agent-kit/src/grant-store.js';
import {PgVaultStore} from '../../../packages/agent-kit/src/vault-area-store.js';
import {bindConsoleSession,captureConsoleVaultSources,requireConsoleSessionBinding,authorityTransaction} from '../../../packages/agent-kit/src/console-turn-authority.js';
import {gateConsoleOrganisation,SourceAuthorityUnavailable} from '../../../packages/agent-kit/src/console-source-transaction.js';
import {hashOf,parseDefinition,type LoadedDefinition} from '../../../packages/agent-kit/src/definition.js';
import {PgAccountStore} from '../../../packages/agent-kit/src/account-store.js';
import {erasePerson} from '../lib/erase-person.js';
import {runErase,renderRunEraseReport} from '../lib/run-erase.js';
import {scopeOf} from '../lib/member-scope.js';
import {quiet} from './helpers/quiet-pool.js';
let container:StartedPostgreSqlContainer,pool:Pool,sequence=0;
const incarnation='11111111-1111-4111-8111-111111111111',sql=new URL('../sql/',import.meta.url);
const migration=()=>readFileSync(new URL('022_console_vault_source_history.sql',sql),'utf8');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function blocked(pid:number):Promise<void>{
 const until=Date.now()+3000;
 while(Date.now()<until){
  const row=(await pool.query("SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];
  if(row?.wait_event_type==='Lock'&&row.blockers.length)return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw new Error('Expected owned PostgreSQL client to block on the protected runtime transaction');
}

beforeAll(async()=>{
 container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:6}));
 for(const f of readdirSync(sql).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort())await pool.query(readFileSync(new URL(f,sql),'utf8'));
 await pool.query('CREATE TABLE dream_observations(id bigserial PRIMARY KEY,owner text);CREATE TABLE dream_preferences(id bigserial PRIMARY KEY,owner text);CREATE TABLE source_test_business(marker text PRIMARY KEY)');
},120_000);
afterAll(async()=>{await pool?.end();await container?.stop();});
async function fixture(expiryMs?:number,agentExpiryMs?:number){
 const n=++sequence,org=`source-org-${n}`,owner=`source-owner-${n}`,member=`source-reader-${n}`,agent=`helper-${n}`,area=`source-area-${n}`,backing=`source-backing-${n}`;
 const definition=parseDefinition({name:agent,model:'fixture-brain',persona:'voice.md',role:'chief-of-staff',channels:[],grants:[{capability:'vault',scope:'read',areas:['shared']}],autonomy:{vault:'gated'},skills:[]});
 const loaded:LoadedDefinition={definition,dutiesMd:'',voiceMd:'',source:'service',dir:'<fixture>',hash:''};loaded.hash=hashOf(loaded);
 await pool.query('INSERT INTO orgs(id,display_name) VALUES($1,$1)',[org]);
 await pool.query("INSERT INTO users(id,display_name,org_id,org_role) VALUES($1,$1,$3,'owner'),($2,$2,$3,'member')",[owner,member,org]);
 await pool.query('INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES($1,NULL),($2,NULL)',[owner,member]);
 await pool.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES($1,$2,$3,'valid')",[agent,definition,loaded.hash]);
 await pool.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending,applied_definition) VALUES($1,$4,$1,'owned',$2,$2,'ready',false,$3)",[agent,incarnation,definition,`172.30.0.${n}`]);
 const grants=new PgGrantStore(pool),access=await grants.adoptAgent(owner,{agentName:agent,expectedDefinitionHash:loaded.hash},{designatedOwnerMemberId:owner});
 const agentExpiry=agentExpiryMs===undefined?null:(await pool.query("SELECT (clock_timestamp()+($1::int*interval '1 millisecond'))::text AS deadline",[agentExpiryMs])).rows[0].deadline;
 await grants.updateAgentAccess(owner,{agentName:agent,expectedRevision:access.accessRevision,grants:[{principal:{kind:'member',id:member},permission:'use',expiresAt:agentExpiry===null?null:new Date(agentExpiry).toISOString()}]});
 const vault=new PgVaultStore(pool),authority={designatedOwnerMemberId:owner};
 await vault.provisionBacking(owner,{id:backing,kind:'git'},authority);
 const a=await vault.provisionArea(owner,{id:area,kind:'shared',owner:{kind:'organisation',id:org},backingStoreId:backing,relativePath:'shared'},authority);
 const expiry=expiryMs===undefined?null:(await pool.query("SELECT (clock_timestamp()+($1::int*interval '1 millisecond'))::text AS deadline",[expiryMs])).rows[0].deadline;
 const configured=await vault.configureAccess(owner,{areaId:area,expectedRevision:a.accessRevision,grants:[{principal:{kind:'member',id:member},permission:'use',expiresAt:expiry===null?null:new Date(expiry).toISOString()}]},authority);
 const binding={agent,incarnation,sessionId:`source-session-${n}`,memberId:member,admissionNonce:randomUUID().replaceAll('-','')+'a'.repeat(11)};
 const env={LARES_AGENT_NAME:agent,LARES_AGENT_INCARNATION:incarnation};
 await bindConsoleSession(binding,pool,env);
 const capture=(db:Parameters<typeof captureConsoleVaultSources>[2]=pool,areas=[area])=>captureConsoleVaultSources(binding,{sessionDefinition:loaded,areaIds:areas},db,env);
 const guard=(db:Parameters<typeof requireConsoleSessionBinding>[1]=pool)=>requireConsoleSessionBinding(binding,db,env);
 const revoked=async()=>(await pool.query('SELECT revoked_at FROM console_session_bindings WHERE agent=$1 AND session_id=$2',[agent,binding.sessionId])).rows[0].revoked_at;
 return {org,owner,member,agent,area,backing,loaded,binding,env,vault,authority,configured,expiry,agentExpiry,capture,guard,revoked};
}
describe('retained private conversation Vault sources',()=>{
 it('captures exact immutable evidence, never refreshes deadlines, and reapplies safely',async()=>{
  const f=await fixture(60_000);await f.capture();const before=(await pool.query('SELECT * FROM console_vault_source_captures WHERE agent=$1',[f.agent])).rows;
  await f.capture();await pool.query(migration());expect((await pool.query('SELECT * FROM console_vault_source_captures WHERE agent=$1',[f.agent])).rows).toEqual(before);
  expect(before[0]).toMatchObject({member_id:f.member,area_id:f.area,session_definition_hash:f.loaded.hash,permission:'use',admission_nonce:f.binding.admissionNonce});
  for(const change of ["UPDATE console_vault_source_captures SET original_valid_until=NULL WHERE agent=$1","DELETE FROM console_vault_source_captures WHERE agent=$1"])
   await expect(pool.query(change,[f.agent])).rejects.toThrow('Conversation source history is immutable');
  await expect(pool.query('DELETE FROM console_session_bindings WHERE agent=$1',[f.agent])).rejects.toThrow();
  await expect(pool.query('DELETE FROM users WHERE id=$1',[f.member])).rejects.toThrow();
 });
 it('rejects mismatched tuple, old-runtime capture marker and widened session definition',async()=>{
  const f=await fixture();await expect(captureConsoleVaultSources({...f.binding,admissionNonce:'z'.repeat(43)},{sessionDefinition:f.loaded,areaIds:[f.area]},pool,f.env)).rejects.toThrow();
  const widened=structuredClone(f.loaded);widened.definition.grants[0]!.areas=['shared','private'];
  await expect(captureConsoleVaultSources(f.binding,{sessionDefinition:widened,areaIds:[f.area]},pool,f.env)).rejects.toThrow();
  await pool.query(`INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision,private_surface_revision,policy_revision)
    SELECT agent,incarnation,'old-runtime',member_id,repeat('b',43),'old-runtime',agent_access_revision,private_surface_revision,2 FROM console_session_bindings WHERE agent=$1`,[f.agent]);
  await expect(pool.query(`INSERT INTO console_vault_source_captures(agent,incarnation,session_id,member_id,admission_nonce,area_id,access_revision,session_definition_hash)
    VALUES($1,$2,'old-runtime',$3,repeat('b',43),$4,$5,$6)`,[f.agent,incarnation,f.member,f.area,f.configured.accessRevision,f.loaded.hash])).rejects.toThrow('Conversation source guard is unavailable');
 });
 it('closes legacy creation and resume without relabelling or reviving historical bindings',async()=>{
  const f=await fixture();await f.capture();
  expect((await pool.query(`SELECT 1 FROM console_session_bindings WHERE agent=$1 AND policy_revision=1 AND revoked_at IS NULL`,[f.agent])).rows).toEqual([]);
  await expect(pool.query(`INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision,private_surface_revision)
    SELECT agent,incarnation,'legacy-active',member_id,repeat('l',43),'legacy-place',agent_access_revision,private_surface_revision FROM console_session_bindings WHERE agent=$1`,[f.agent])).rejects.toThrow('console_binding_source_policy_version');
  await pool.query(`INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision,private_surface_revision,revoked_at)
    SELECT agent,incarnation,'legacy-retired',member_id,repeat('l',43),'legacy-place',agent_access_revision,private_surface_revision,clock_timestamp() FROM console_session_bindings WHERE agent=$1`,[f.agent]);
  await pool.query(migration());
  expect((await pool.query("SELECT policy_revision,revoked_at FROM console_session_bindings WHERE agent=$1 AND session_id='legacy-retired'",[f.agent])).rows[0]).toEqual({policy_revision:1,revoked_at:expect.any(Date)});
  await expect(pool.query("UPDATE console_session_bindings SET policy_revision=2,revoked_at=NULL WHERE agent=$1 AND session_id='legacy-retired'",[f.agent])).rejects.toThrow('immutable');
  await f.guard();
 });
 it('intersects trusted session area grants with current member authority and refuses cross-organisation sources',async()=>{
  const f=await fixture(),other=await fixture();
  const privateArea=await f.vault.provisionArea(f.owner,{id:f.area+'-private',kind:'private',owner:{kind:'member',id:f.member},backingStoreId:f.backing,relativePath:'private'},f.authority);
  await expect(f.capture(pool,[privateArea.areaId])).rejects.toThrow();await expect(f.capture(pool,[other.area])).rejects.toThrow();
  expect((await pool.query('SELECT * FROM console_vault_source_captures WHERE agent=$1',[f.agent])).rows).toEqual([]);expect(await f.revoked()).toBeNull();
 });
 it('refuses newly requested captures after a prior binding lock without retiring valid history',async()=>{
  const f=await fixture();await f.capture();
  const area=await f.vault.provisionArea(f.owner,{id:f.area+'-later',kind:'shared',owner:{kind:'organisation',id:f.org},backingStoreId:f.backing,relativePath:'later'},f.authority);
  await f.vault.configureAccess(f.owner,{areaId:area.areaId,expectedRevision:area.accessRevision,grants:[{principal:{kind:'member',id:f.member},permission:'use',expiresAt:null}]},f.authority);
  await authorityTransaction(pool,async db=>{await f.guard(db);await f.capture(db);await expect(f.capture(db,[area.areaId])).rejects.toThrow();});
  expect((await pool.query('SELECT area_id FROM console_vault_source_captures WHERE agent=$1',[f.agent])).rows).toEqual([{area_id:f.area}]);expect(await f.revoked()).toBeNull();
 });
 it('checks every retained source when no new source is requested and never revives after regrant',async()=>{
  const f=await fixture();await f.capture();
  const next=await f.vault.configureAccess(f.owner,{areaId:f.area,expectedRevision:f.configured.accessRevision,grants:[]},f.authority);
  await f.vault.configureAccess(f.owner,{areaId:f.area,expectedRevision:next.accessRevision,grants:[{principal:{kind:'member',id:f.member},permission:'use',expiresAt:null}]},f.authority);
  await expect(f.guard()).rejects.toThrow();expect(await f.revoked()).not.toBeNull();await expect(f.capture()).rejects.toThrow();
 });
 it('rolls all business writes back and durably retires history even if refusal is swallowed',async()=>{
  const f=await fixture();await f.capture();
  const sibling={...f.binding,sessionId:f.binding.sessionId+'-other',admissionNonce:'k'.repeat(43)};await bindConsoleSession(sibling,pool,f.env);
  await f.vault.retireBacking(f.owner,f.backing,f.authority);
  await expect(authorityTransaction(pool,async db=>{
   await db.query('INSERT INTO source_test_business VALUES($1)',[f.agent]);
   try{await f.guard(db);}catch{}
   await db.query('INSERT INTO source_test_business VALUES($1)',[f.agent+'-after']);return 'must not escape';
  })).rejects.toThrow();
  expect((await pool.query('SELECT * FROM source_test_business WHERE marker=ANY($1)',[[f.agent,f.agent+'-after']])).rows).toEqual([]);expect(await f.revoked()).not.toBeNull();
  expect((await pool.query('SELECT revoked_at FROM console_session_bindings WHERE agent=$1 AND session_id=$2',[f.agent,sibling.sessionId])).rows[0].revoked_at).toBeNull();
 });
 it('cannot hide invalid retained history behind new-source, definition or ordering errors',async()=>{
  for(const variant of ['missing','definition','order'] as const){
   const f=await fixture();await f.capture();
   if(variant!=='order')await f.vault.retireBacking(f.owner,f.backing,f.authority);
   const loaded=structuredClone(f.loaded);if(variant==='definition')loaded.voiceMd='Unmatched definition';
   await expect(authorityTransaction(pool,async db=>{
    if(variant==='order'){
     await f.guard(db);
     await db.query("UPDATE vault_areas SET status='retired',revision=nextval('vault_access_revision_seq') WHERE id=$1",[f.area]);
    }
    await db.query('INSERT INTO source_test_business VALUES($1)',[f.agent]);
    try{await captureConsoleVaultSources(f.binding,{sessionDefinition:loaded,areaIds:['a-missing-source']},db,f.env);}catch{}
    return 'must not escape';
   })).rejects.toThrow();
   expect(await f.revoked()).not.toBeNull();expect((await pool.query('SELECT * FROM source_test_business WHERE marker=$1',[f.agent])).rows).toEqual([]);
  }
 });
 it('refuses PostgreSQL ROLLBACK responses to COMMIT after a swallowed SQL error',async()=>{
  const f=await fixture();
  await expect(authorityTransaction(pool,async db=>{
   await f.capture(db);
   try{await db.query('SELECT * FROM missing_source_test_relation');}catch{}
   return 'uncommitted source result';
  })).rejects.toBeInstanceOf(SourceAuthorityUnavailable);
  expect((await pool.query('SELECT * FROM console_vault_source_captures WHERE agent=$1',[f.agent])).rows).toEqual([]);expect(await f.revoked()).toBeNull();
 });
 it('ordinary exceptions roll back without retiring the binding',async()=>{
  const f=await fixture();await f.capture();
  await expect(authorityTransaction(pool,async db=>{await f.guard(db);await db.query('INSERT INTO source_test_business VALUES($1)',[f.agent]);throw new Error('ordinary failure');})).rejects.toThrow('ordinary failure');
  expect(await f.revoked()).toBeNull();expect((await pool.query('SELECT * FROM source_test_business WHERE marker=$1',[f.agent])).rows).toEqual([]);
 });
 it('unknown retirement acknowledgement returns unavailable and exposes no callback value',async()=>{
  const f=await fixture();await f.capture();await f.vault.retireBacking(f.owner,f.backing,f.authority);
  let destroyed=false;
  const uncertain={query:pool.query.bind(pool),connect:async()=>{const db=await pool.connect();return {release:(broken?:boolean)=>{destroyed=!!broken;db.release(broken);},query:async(sql:string,values?:unknown[])=>{const result=await db.query(sql,values);if(sql==='COMMIT')throw new Error('lost acknowledgement');return result;}};}};
  await expect(authorityTransaction(uncertain,async db=>{try{await f.guard(db);}catch{}return 'secret';})).rejects.toBeInstanceOf(SourceAuthorityUnavailable);expect(destroyed).toBe(true);expect(await f.revoked()).not.toBeNull();
 });
 it('refuses unregistered query-only clients and a second organisation gate',async()=>{
  const f=await fixture(),other=await fixture(),db=await pool.connect();
  try{await db.query('BEGIN');await expect(f.guard(db)).rejects.toThrow();await db.query('ROLLBACK');}finally{db.release();}
  await expect(authorityTransaction(pool,async db=>{await gateConsoleOrganisation(db,f.member);await gateConsoleOrganisation(db,other.member);})).rejects.toThrow();
 });
 it('original source expiry retires a capture after a later protected lock wait',async()=>{
  const f=await fixture(650);await f.capture();
  await expect(authorityTransaction(pool,async db=>{await f.guard(db);await db.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)",[f.expiry]);return 'secret';})).rejects.toThrow();expect(await f.revoked()).not.toBeNull();
 });
 it('rechecks agent and original source deadlines after a real runtime-row wait before callback work',async()=>{
  for(const {state,kind} of [{state:'none',kind:'agent'},{state:'retained',kind:'agent'},{state:'pending',kind:'agent'},{state:'retained',kind:'source'},{state:'pending',kind:'source'}]){
   const f=await fixture(kind==='source'?900:undefined,kind==='agent'?900:undefined);if(state==='retained')await f.capture();
   const locker=await pool.connect(),atRuntime=deferred();let pid=0;
   const observed={query:pool.query.bind(pool),connect:async()=>{const db=await pool.connect();pid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return {release:(broken?:boolean)=>db.release(broken),query:(sql:string,values?:unknown[])=>{if(sql.includes('FROM agent_resources r'))atRuntime.resolve();return db.query(sql,values);}};}} as unknown as Pool;
   await locker.query('BEGIN');await locker.query('SELECT name FROM agent_resources WHERE name=$1 FOR UPDATE',[f.agent]);
   let callbackReached=false;
   const guarded=authorityTransaction(observed,async db=>{if(state==='pending')await f.capture(db);else await f.guard(db);callbackReached=true;}).then(()=>{throw new Error('Expired authority escaped');},()=>undefined);
   try{await atRuntime.promise;await blocked(pid);await locker.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)",[kind==='agent'?f.agentExpiry:f.expiry]);await locker.query('COMMIT');await guarded;}
   finally{await locker.query('ROLLBACK');locker.release();await guarded;}
   expect(callbackReached).toBe(false);if(state!=='none')expect(await f.revoked()).not.toBeNull();else expect(await f.revoked()).toBeNull();
   if(state==='pending')expect((await pool.query('SELECT * FROM console_vault_source_captures WHERE agent=$1',[f.agent])).rows).toEqual([]);
  }
 },15_000);
 it('keeps the original agent-use deadline through later callback waits when source history exists',async()=>{
  const f=await fixture(undefined,650);await f.capture();
  await expect(authorityTransaction(pool,async db=>{await f.guard(db);await db.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)",[f.agentExpiry]);return 'secret';})).rejects.toThrow();
  expect(await f.revoked()).not.toBeNull();
 });
 it('uses one pooled client for account callbacks, including swallowed invalidation',async()=>{
  const f=await fixture();await f.capture();const single=quiet(new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:500}));
  try{
   await authorityTransaction(single,async db=>{await f.guard(db);});
   const accounts=new PgAccountStore(single);await expect(accounts.list(f.member)).resolves.toEqual([]);
   await f.vault.retireBacking(f.owner,f.backing,f.authority);
   const selected={accountId:'unused',generation:0,resourceBindingId:'unused'};
   // The account owner registry is exercised before a protected callback takes its source guard.
   const adapter=accounts.forTrustedAdapter({connectorId:'example',verifyAccount:async()=>({issuer:'https://example.test',subject:'reader',label:'Reader'}),verifyResource:async()=>({resourceKind:'mailbox',externalId:'reader',providerLabel:'Mailbox'})});
   const account=await adapter.createPersonalAccount(f.member,{}, {persist:async(db,owner)=>{const token=randomUUID();await db.query('INSERT INTO oauth_tokens(id,principal,provider,org_id,email_address,refresh_token_enc) VALUES($1,$2,$3,$4,$5,$6)',[token,owner.ownerMemberId,owner.connectorId,f.org,'reader@example.invalid','opaque']);return token;}},[{}]);
   const resource=(await accounts.listResources(f.member,account.id,account.generation))[0]!;
   await expect(accounts.withPersonalResourceCredential(f.member,{...selected,accountId:account.id,resourceBindingId:resource.id},'mailbox',async(_s,_c,db)=>{try{await f.guard(db);}catch{}return 'secret';})).rejects.toThrow();
  }finally{await single.end();}
 });
 it('serializes opposite-area runtime requests and coordinates sharing, member and definition writes',async()=>{
  for(const mutation of ['vault','sharing','member','definition','definition-cache'] as const){
   const f=await fixture();await f.capture();const entered=deferred(),release=deferred();
   const held=authorityTransaction(pool,async db=>{await f.guard(db);entered.resolve();await release.promise;});await entered.promise;
   const management=quiet(new Pool({connectionString:container.getConnectionUri(),max:1}));
   const pid=(await management.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const next=structuredClone(f.loaded);next.voiceMd='Updated fixture voice';next.hash=hashOf(next);
   const revision=(await pool.query('SELECT revision FROM agent_access WHERE agent_name=$1',[f.agent])).rows[0].revision*1;
   const changed=mutation==='vault'?new PgVaultStore(management).retireBacking(f.owner,f.backing,f.authority):mutation==='sharing'?new PgGrantStore(management).updateAgentAccess(f.owner,{agentName:f.agent,expectedRevision:revision,grants:[]}):mutation==='member'?management.query("BEGIN; SELECT id FROM orgs WHERE id='"+f.org+"' FOR UPDATE; UPDATE users SET status='removed' WHERE id='"+f.member+"'; COMMIT"):mutation==='definition-cache'?rememberValid(management,next):management.query("UPDATE agent_definitions SET status='invalid' WHERE name=$1",[f.agent]);
   try{await blocked(pid);}finally{release.resolve();}
   try{await Promise.all([held,changed]);await expect(f.guard()).rejects.toThrow();}finally{await management.end();}
  }
  const f=await fixture(),second=await f.vault.provisionArea(f.owner,{id:f.area+'-two',kind:'shared',owner:{kind:'organisation',id:f.org},backingStoreId:f.backing,relativePath:'other'},f.authority);
  await f.vault.configureAccess(f.owner,{areaId:second.areaId,expectedRevision:second.accessRevision,grants:[{principal:{kind:'member',id:f.member},permission:'use',expiresAt:null}]},f.authority);
  const entered=deferred(),release=deferred(),first=authorityTransaction(pool,async db=>{await f.capture(db,[f.area,second.areaId]);entered.resolve();await release.promise;});await entered.promise;
  const opposite=quiet(new Pool({connectionString:container.getConnectionUri(),max:1})),pid=(await opposite.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const secondCapture=f.capture(opposite,[second.areaId,f.area]);
  try{await blocked(pid);}finally{release.resolve();}
  try{await Promise.all([first,secondCapture]);}finally{await opposite.end();}
  expect((await pool.query('SELECT count(*)::int n FROM console_vault_source_captures WHERE agent=$1',[f.agent])).rows[0].n).toBe(2);
 });
 it('holds the erasure barrier across preflight and the file pass on a one-client pool',async()=>{
  const f=await fixture(),single=quiet(new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:500}));
  const root=mkdtempSync(join(tmpdir(),'source-erasure-')),preflight=deferred(),release=deferred(),captureAtBarrier=deferred();let paused=false,capturePid=0;
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'note.md'),`---\nowner: ${f.member}\n---\nPrivate fixture\n`);git('add','note.md');git('commit','-m','fixture');
  const observed={query:single.query.bind(single),connect:async()=>{const db=await single.connect();return {release:()=>db.release(),query:async(sql:string,values?:unknown[])=>{
   const result=await db.query(sql,values);
   if(sql.includes('SELECT count(*)::int AS n FROM console_vault_source_captures')&&!paused){paused=true;preflight.resolve();await release.promise;}
   return result;
  }};}} as unknown as Pool;
  const captureObserved={query:pool.query.bind(pool),connect:async()=>{const db=await pool.connect();capturePid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return {release:()=>db.release(),query:(sql:string,values?:unknown[])=>{
   if(sql==='SELECT id FROM orgs WHERE id=$1 FOR SHARE')captureAtBarrier.resolve();return db.query(sql,values);
  }};}} as unknown as Pool;
  let erased:ReturnType<typeof runErase>|undefined,captured:Promise<unknown>|undefined;
  try{
   erased=runErase({db:observed,person:f.member,vaults:[root],apply:true});await preflight.promise;
   captured=f.capture(captureObserved).then(()=>{throw new Error('Capture escaped the erasure barrier');},()=>undefined);
   await captureAtBarrier.promise;await blocked(capturePid);expect(existsSync(join(root,'note.md'))).toBe(true);
   release.resolve();const result=await erased;await captured;
   expect(result.dbReport.refusals).toEqual([]);expect(existsSync(join(root,'note.md'))).toBe(false);
   expect((await pool.query('SELECT * FROM console_vault_source_captures WHERE agent=$1',[f.agent])).rows).toEqual([]);
  }finally{release.resolve();await erased;await captured;await single.end();rmSync(root,{recursive:true,force:true});}
 });
 it('reports already removed files when the later database sweep rolls back',async()=>{
  const f=await fixture(),root=mkdtempSync(join(tmpdir(),'source-erasure-failure-'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'note.md'),`---\nowner: ${f.member}\n---\nPrivate fixture\n`);git('add','note.md');git('commit','-m','fixture');
  await pool.query(`CREATE OR REPLACE FUNCTION source_test_erase_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id=TG_ARGV[0] THEN RAISE EXCEPTION 'Fixture sweep refusal'; END IF; RETURN OLD; END $$;
   CREATE TRIGGER source_test_erase_guard BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION source_test_erase_refusal('${f.member}');`);
  try{
   const result=await runErase({db:pool,person:f.member,vaults:[root],apply:true}),report=renderRunEraseReport(result);
   expect(result.dbReport.refusals.join(' ')).toContain('Fixture sweep refusal');expect(result.dbReport.deleted).toEqual([]);
   expect(existsSync(join(root,'note.md'))).toBe(false);expect((await pool.query('SELECT 1 FROM users WHERE id=$1',[f.member])).rows).toHaveLength(1);
   expect(report).toContain('note.md');expect(report).toContain('were not rolled back');expect(report).not.toContain('Nothing was erased');expect(report).not.toContain('before anything was changed');
  }finally{await pool.query('DROP TRIGGER IF EXISTS source_test_erase_guard ON users');rmSync(root,{recursive:true,force:true});}
 });
 it('does not report a confirmed erasure when the final commit acknowledgement is lost',async()=>{
  const f=await fixture();
  const uncertain={query:pool.query.bind(pool),connect:async()=>{const db=await pool.connect();return {release:(broken?:boolean)=>db.release(broken),query:async(sql:string,values?:unknown[])=>{const result=await db.query(sql,values);if(sql==='COMMIT')throw new Error('lost acknowledgement');return result;}};}} as unknown as Pool;
  await expect(runErase({db:uncertain,person:f.member,vaults:[],apply:true})).rejects.toThrow('Files already removed may remain removed');
  expect((await pool.query('SELECT 1 FROM users WHERE id=$1',[f.member])).rows).toEqual([]);
 });
 it('registers source history for member inventory and refuses reader erasure before any sweep',async()=>{
  const f=await fixture();await f.capture();expect(scopeOf('console_vault_source_captures')).toMatchObject({scope:'member',column:'member_id'});
  await pool.query('UPDATE console_session_bindings SET revoked_at=clock_timestamp() WHERE agent=$1',[f.agent]);
  for(const dryRun of [true,false]){const report=await erasePerson(pool,{person:f.member,dryRun});expect(report.refusals.join(' ')).toContain('retained conversation source dependencies');expect(report.deleted).toEqual([]);}
  expect((await pool.query('SELECT 1 FROM users WHERE id=$1',[f.member])).rows).toHaveLength(1);
 });
});
