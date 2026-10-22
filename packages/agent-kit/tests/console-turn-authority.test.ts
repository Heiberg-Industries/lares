import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgGrantStore } from '../src/grant-store.js';
import { consoleSourceTransaction } from '../src/console-source-transaction.js';
import { closePool } from '../src/db.js';
import { searchTool,readTool,listTool,backlinksTool } from '../src/note-tools.js';
import { vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { definitionModel } from '../src/definition-model.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindConsoleSession, bindConsoleSessionStarted, requireConsoleSessionBinding, requireConsoleTurnAuthority,
  consoleRouteAdmission, hasConsoleTurnAuthorityTag, CONSOLE_AUTHORITY_REVISION, authorityTransaction, type ConsoleAuthorityContext } from '../src/console-turn-authority.js';
import { observeConversation, resetConversation } from '../src/conversation-control.js';
import { verifyPrivateConsoleSession, markPrivateConsoleSurface } from '../src/private-console-surface.js';
const keeperPath=new URL('../../../services/keeper/lib/conversations.js',import.meta.url).href;
const actionPath=new URL('../../../services/keeper/lib/actions.js',import.meta.url).href;
const waitingPath=new URL('../../../services/console/lib/waiting.js',import.meta.url).href;
const {registerConversationActions}=await import(keeperPath);
const {resetActions,runAction}=await import(actionPath);
const {listWaiting}=await import(waitingPath);
import { pathToFileURL,fileURLToPath } from 'node:url';
import { quiet } from './helpers/quiet-pool.js';
const migration = readFileSync(new URL('../../../services/box/sql/013_console_turn_authority.sql',import.meta.url),'utf8');
const incarnation = '11111111-1111-4111-8111-111111111111';
const nonce = 'a'.repeat(43);
const env = {LARES_AGENT_NAME:'helper',LARES_AGENT_INCARNATION:incarnation,AGENT_OWNER_USER_ID:'Owner-ID'};
const tuple = {agent:'helper',incarnation,sessionId:'wrun_test',memberId:'Owner-ID',admissionNonce:nonce};
const auth = (purpose='human', memberId='Owner-ID', admissionNonce=nonce) => ({authenticator:'lares-console',attributes:{user_id:'owner@example.invalid',lares_member_id:memberId,lares_admission_nonce:admissionNonce,lares_purpose:purpose}});
const ctx = (purpose='human'): ConsoleAuthorityContext => ({session:{id:tuple.sessionId,turn:{id:'turn-1',sequence:0},auth:{current:auth(purpose),initiator:auth()}}});
const request = (suffix='',purpose='human',body?:unknown) => new Request(`http://runtime.invalid/eve/v1/session${suffix}`,{
  method:purpose.endsWith('read')?'GET':'POST',headers:{'x-lares-member-id':'Owner-ID','x-lares-admission':nonce,'x-lares-purpose':purpose},
  ...(body === undefined ? {} : {body:JSON.stringify(body)})});
let db:Pool,stop:()=>Promise<void>;
beforeAll(async()=>{const container=await new PostgreSqlContainer('postgres:16-alpine').start();db=quiet(new Pool({connectionString:container.getConnectionUri()}));vi.stubEnv('DATABASE_URL',container.getConnectionUri());vi.stubEnv('LARES_AGENT_NAME',env.LARES_AGENT_NAME);vi.stubEnv('LARES_AGENT_INCARNATION',incarnation);vi.stubEnv('AGENT_OWNER_USER_ID','Owner-ID');stop=async()=>{await closePool();await db.end();await container.stop();vi.unstubAllEnvs();};},120_000);
afterAll(async()=>{await stop?.();});
beforeEach(async()=>{
 await db.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');
 await db.query(`CREATE TABLE orgs(id text PRIMARY KEY,display_name text NOT NULL);
 CREATE TABLE users(id text PRIMARY KEY,display_name text NOT NULL,primary_email text,status text,org_role text,org_id text REFERENCES orgs(id),created_at timestamptz DEFAULT now());
 CREATE TABLE org_member_policy(user_id text PRIMARY KEY REFERENCES users(id),allowed_capabilities text[]);
 CREATE TABLE agent_definitions(name text PRIMARY KEY,status text,hash text,definition jsonb);
 CREATE TABLE agent_conversations(agent text,incarnation uuid,session_id text,door text,observed_at timestamptz DEFAULT now(),terminal boolean DEFAULT false,PRIMARY KEY(agent,incarnation,session_id));
 CREATE TABLE connected_accounts(id text PRIMARY KEY,owner_member_id text,generation integer,status text);
 CREATE TABLE agent_resources(name text PRIMARY KEY,ownership_token uuid,runtime_control_token uuid,state text,pending boolean);
 INSERT INTO orgs VALUES('org','Example');
 INSERT INTO users(id,display_name,status,org_role,org_id) VALUES('Owner-ID','Owner','active','owner','org'),('other','Other','active','owner','org');
 INSERT INTO org_member_policy VALUES('Owner-ID',NULL);
 INSERT INTO agent_definitions VALUES('helper','valid','definition-one','{"grants":[]}');
 INSERT INTO agent_resources VALUES('helper','${incarnation}','${incarnation}','ready',false);`);
 for(const file of ['007_member_identity_sessions.sql','009_vault_areas.sql','013_console_turn_authority.sql','014_agent_access_grants.sql','016_console_agent_access_capture.sql','017_private_console_surface_capture.sql','018_private_account_history.sql','022_console_vault_source_history.sql'])await db.query(readFileSync(new URL(`../../../services/box/sql/${file}`,import.meta.url),'utf8'));
 await new PgGrantStore(db).adoptAgent('Owner-ID',{agentName:'helper',expectedDefinitionHash:'definition-one'},{designatedOwnerMemberId:'Owner-ID'});
});
describe('durable console authority on disposable PostgreSQL',()=>{
 it('binds only an exact singleton and returns stable actor/speaker independently of email',async()=>{
  await bindConsoleSession(tuple,db,env);
  expect(await requireConsoleTurnAuthority(ctx(),db,env)).toEqual({origin:'human',agentId:'helper',sessionId:'wrun_test',turnId:'turn-1',actingMemberId:'Owner-ID',spokenByMemberId:'Owner-ID',placeId:`console:helper:${incarnation}:wrun_test`,audience:{placeId:`console:helper:${incarnation}:wrun_test`,revision:1,participants:[{kind:'member',memberId:'Owner-ID'}]},policyRevision:CONSOLE_AUTHORITY_REVISION});
  await db.query(migration);
  expect((await requireConsoleSessionBinding({agent:tuple.agent,incarnation,sessionId:tuple.sessionId,memberId:tuple.memberId},db,env)).admissionNonce).toBe(nonce);
  expect((await requireConsoleSessionBinding(tuple,db,env)).memberId).toBe('Owner-ID');
 });
 it('serializes first-turn/proxy races, allows exact idempotence, refuses changed tuples',async()=>{
  const result=await Promise.all([bindConsoleSession(tuple,db,env),bindConsoleSession(tuple,db,env)]);
  expect(result[0]).toEqual(result[1]);
  await expect(bindConsoleSession({...tuple,admissionNonce:'b'.repeat(43)},db,env)).rejects.toThrow();
  await expect(bindConsoleSession({...tuple,memberId:'other'},db,{...env,AGENT_OWNER_USER_ID:'other'})).rejects.toThrow();
  await expect(bindConsoleSession({...tuple,sessionId:'different'},db,env)).rejects.toThrow();
  expect((await db.query('SELECT count(*)::int AS n FROM console_session_bindings')).rows[0].n).toBe(1);
 });
 it('requires explicit adoption, retains historical unversioned rows and makes access captures immutable',async()=>{
  await db.query("DELETE FROM agent_access");
  await expect(bindConsoleSession(tuple,db,env)).rejects.toThrow('Conversation authority');
  await expect(consoleRouteAdmission(request('', 'human',{}),db,env)).rejects.toThrow('Conversation authority');
  await db.query('ALTER TABLE console_session_bindings DROP CONSTRAINT console_binding_access_capture');
  await db.query("INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,revoked_at) VALUES('helper',$1,'historical','Owner-ID',repeat('z',43),'historical',clock_timestamp())",[incarnation]);
  const captureMigration=readFileSync(new URL('../../../services/box/sql/016_console_agent_access_capture.sql',import.meta.url),'utf8');
  await db.query(captureMigration);await db.query(captureMigration);
  expect((await db.query("SELECT revoked_at,agent_access_revision FROM console_session_bindings WHERE session_id='historical'")).rows[0]).toEqual({revoked_at:expect.any(Date),agent_access_revision:null});
  await new PgGrantStore(db).adoptAgent('Owner-ID',{agentName:'helper',expectedDefinitionHash:'definition-one'},{designatedOwnerMemberId:'Owner-ID'});
  const captured=await bindConsoleSession(tuple,db,env);expect(captured.agentAccessRevision).toBeGreaterThan(0);
  await expect(db.query("UPDATE console_session_bindings SET agent_access_revision=agent_access_revision+1 WHERE session_id='wrun_test'")).rejects.toThrow('immutable');
 });
 it('never revives a captured binding after access removal/regrant, policy restoration, membership rejoin or definition hash restoration',async()=>{
  const mutations=[
   ["UPDATE users SET status='removed' WHERE id='Owner-ID'","UPDATE users SET status='active' WHERE id='Owner-ID'"],
   ["UPDATE org_member_policy SET allowed_capabilities=ARRAY[]::text[] WHERE user_id='Owner-ID'","UPDATE org_member_policy SET allowed_capabilities=NULL WHERE user_id='Owner-ID'"],
   ["UPDATE agent_definitions SET hash='changed'","UPDATE agent_definitions SET hash='definition-one'"],
   ["UPDATE agent_access SET revision=nextval('resource_access_revision_seq')","UPDATE agent_access SET revision=nextval('resource_access_revision_seq')"]
  ];
  for(const [change,restore] of mutations){
   await db.query('DELETE FROM console_session_bindings');const old=await bindConsoleSession(tuple,db,env);
   await db.query(change);await db.query(restore);
   await expect(requireConsoleSessionBinding(tuple,db,env)).rejects.toThrow('Conversation authority');
   await expect(bindConsoleSession(tuple,db,env)).rejects.toThrow('Conversation authority');
   expect((await bindConsoleSession({...tuple,sessionId:'fresh',admissionNonce:'f'.repeat(43)},db,env)).agentAccessRevision).toBeGreaterThan(old.agentAccessRevision);
  }
 });
 it('rechecks named use expiry on lookups while keeping member chat closed',async()=>{
  const store=new PgGrantStore(db),a=await store.agentAccess('Owner-ID','helper');
  await store.updateAgentAccess('Owner-ID',{agentName:'helper',expectedRevision:a!.accessRevision,grants:[{principal:{kind:'member',id:'other'},permission:'use',expiresAt:new Date(Date.now()+500).toISOString()}]});
  const other={...tuple,memberId:'other'},otherEnv={...env,AGENT_OWNER_USER_ID:'other'};
  await bindConsoleSession(other,db,otherEnv);await db.query('SELECT pg_sleep(0.6)');
  await expect(requireConsoleSessionBinding(other,db,otherEnv)).rejects.toThrow('Conversation authority');
 });
 it('uses one connection and serializes capture before concurrent access revocation',async()=>{
  const single=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:500});
  try{
   await bindConsoleSession(tuple,single,env);await requireConsoleSessionBinding(tuple,single,env);
   const realConnect=single.connect.bind(single);let checkedOut:any,originalQuery:any;
   single.connect=(async()=>{checkedOut=await realConnect();originalQuery=checkedOut.query;return checkedOut;}) as typeof single.connect;
   let workClient:any;
   await consoleSourceTransaction(single as never,async client=>{workClient=client;await client.query('SELECT 1');},undefined,{deadlineAtMs:Date.now()+5000});
   expect(workClient).toBe(checkedOut);expect(checkedOut.query).toBe(originalQuery);expect(single.totalCount).toBe(1);expect(single.idleCount).toBe(1);
  }finally{await single.end();}
  await db.query('DELETE FROM console_session_bindings');
  let revoked!:Promise<void>;
  await authorityTransaction(db,async client=>{
   await bindConsoleSession(tuple,client,env);
   const store=new PgGrantStore(db),a=await store.agentAccess('Owner-ID','helper');
   let finished=false;revoked=store.updateAgentAccess('Owner-ID',{agentName:'helper',expectedRevision:a!.accessRevision,grants:[]}).then(()=>{finished=true;});
   for(let i=0;i<100;i++){
    const wait=await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM orgs%'");
    if(wait.rows.length)break;
    await new Promise(resolve=>setTimeout(resolve,10));
    if(i===99)throw new Error('Revocation did not reach lock barrier');
   }
   expect(finished).toBe(false);
  });
  await revoked;
  expect((await db.query('SELECT revoked_at FROM console_session_bindings')).rows[0].revoked_at).toBeInstanceOf(Date);
  await expect(requireConsoleSessionBinding(tuple,db,env)).rejects.toThrow('Conversation authority');
  await expect(bindConsoleSession(tuple,db,env)).rejects.toThrow('Conversation authority');
 });
 it('an in-flight first capture cannot escape revocation, and a capture waiting behind revocation refuses',async()=>{
  const store=new PgGrantStore(db),a=await store.agentAccess('Owner-ID','helper');
  const named={principal:{kind:'member' as const,id:'other'},permission:'use' as const,expiresAt:null};
  const granted=await store.updateAgentAccess('Owner-ID',{agentName:'helper',expectedRevision:a!.accessRevision,grants:[named]});
  const other={...tuple,memberId:'other'},otherEnv={...env,AGENT_OWNER_USER_ID:'other'};
  let entered!:()=>void,proceed!:()=>void;
  const atInsert=new Promise<void>(resolve=>{entered=resolve;}),allowInsert=new Promise<void>(resolve=>{proceed=resolve;});
  const wrapped={query:db.query.bind(db),connect:async()=>{
   const client=await db.connect();return {release:()=>client.release(),query:async(sql:string,values?:unknown[])=>{
    if(sql.startsWith('INSERT INTO console_session_bindings')){entered();await allowInsert;}
    return client.query(sql,values);
   }};
  }};
  const capture=bindConsoleSession(other,wrapped,otherEnv);await atInsert;
  const revoke=store.updateAgentAccess('Owner-ID',{agentName:'helper',expectedRevision:granted.accessRevision,grants:[]});
  try{
   for(let i=0;i<100;i++){
    if((await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM orgs%'")).rows.length)break;
    await new Promise(resolve=>setTimeout(resolve,10));if(i===99)throw new Error('Revocation did not reach lock barrier');
   }
  }finally{proceed();}
  await capture;await revoke;
  expect((await db.query('SELECT revoked_at FROM console_session_bindings')).rows[0].revoked_at).toBeInstanceOf(Date);
  await expect(requireConsoleSessionBinding(other,db,otherEnv)).rejects.toThrow('Conversation authority');
  const current=await store.agentAccess('Owner-ID','helper');
  const again=await store.updateAgentAccess('Owner-ID',{agentName:'helper',expectedRevision:current!.accessRevision,grants:[named]});
  const client=await db.connect();await client.query('BEGIN');
  try{
   await store.updateAgentAccess('Owner-ID',{agentName:'helper',expectedRevision:again.accessRevision,grants:[]},{db:client});
   const waiting=bindConsoleSession({...other,sessionId:'waiting',admissionNonce:'w'.repeat(43)},db,otherEnv);
   const refused=expect(waiting).rejects.toThrow('Conversation authority');
   await client.query('COMMIT');await refused;
   expect((await db.query("SELECT count(*)::int AS n FROM console_session_bindings WHERE revoked_at IS NULL")).rows[0].n).toBe(0);
  }finally{await client.query('ROLLBACK');client.release();}
 });
 it('admits an explicitly granted active member with its own singleton audience and refuses ungranted members',async()=>{
  await db.query("UPDATE users SET org_role='member' WHERE id='other'");
  await expect(bindConsoleSession({...tuple,memberId:'other'},db,env)).rejects.toThrow('Conversation authority');
  const store=new PgGrantStore(db),a=await store.agentAccess('Owner-ID','helper');
  await store.updateAgentAccess('Owner-ID',{agentName:'helper',expectedRevision:a!.accessRevision,grants:[{principal:{kind:'member',id:'other'},permission:'use',expiresAt:null}]});
  await bindConsoleSession({...tuple,memberId:'other'},db,env);
  const current=auth('human','other');
  expect(await requireConsoleTurnAuthority({session:{...ctx().session,auth:{current,initiator:current}}},db,env)).toMatchObject({actingMemberId:'other',spokenByMemberId:'other',audience:{participants:[{kind:'member',memberId:'other'}]}});
  await expect(requireConsoleSessionBinding(tuple,db,env)).rejects.toThrow('Conversation authority');
 });
 it('session-start hook binds first-message creates; message-free proxy binding already exists',async()=>{
  await bindConsoleSessionStarted(ctx(),db,env);
  await bindConsoleSession(tuple,db,env);
  await expect(requireConsoleTurnAuthority(ctx(),db,env)).resolves.toMatchObject({actingMemberId:'Owner-ID'});
 });
 it('does not mint private authority for native or unknown callers or jobs',async()=>{
  await bindConsoleSessionStarted({session:{id:'native',auth:{current:{authenticator:'slack-webhook'}}}},db,env);
  expect((await db.query('SELECT * FROM console_session_bindings')).rows).toEqual([]);
  for(const current of [null,{authenticator:'app'},auth('resolver'),auth('read')]){
   await expect(requireConsoleTurnAuthority({session:{...ctx().session,auth:{current,initiator:auth()}}},db,env)).rejects.toThrow('Conversation authority');
  }
 });
 it('approval resumes never borrow the initiator as human speaker or actor',async()=>{
  await bindConsoleSession(tuple,db,env);
  for(const current of [null,auth('resolver'),auth('human','other'),auth('human','Owner-ID','b'.repeat(43))]){
   await expect(requireConsoleTurnAuthority({session:{...ctx().session,auth:{current,initiator:auth()}}},db,env)).rejects.toThrow('Conversation authority');
  }
  await expect(requireConsoleTurnAuthority({session:{...ctx().session,auth:{current:auth(),initiator:null}}},db,env)).rejects.toThrow('Conversation authority');
 });
 it.each(["UPDATE users SET status='removed' WHERE id='Owner-ID'","UPDATE users SET org_role='member' WHERE id='Owner-ID'","UPDATE agent_resources SET pending=true","UPDATE agent_resources SET ownership_token='22222222-2222-4222-8222-222222222222'","UPDATE agent_resources SET state='stopped'","UPDATE agent_definitions SET status='invalid'"])("rechecks current membership and managed runtime: %s",async(sql)=>{
  await bindConsoleSession(tuple,db,env);await db.query(sql);
  await expect(requireConsoleTurnAuthority(ctx(),db,env)).rejects.toThrow('Conversation authority');
  await expect(consoleRouteAdmission(request('/wrun_test/stream','read'),db,env)).rejects.toThrow('Conversation authority');
 });
 it('checks all session routes even when onMessage is skipped; reset retires forever',async()=>{
  await bindConsoleSession(tuple,db,env);
  for(const [suffix,purpose,body] of [['/wrun_test/stream','read',undefined],['/wrun_test/cancel','control',{}],['/wrun_test/clear','control',{}],['/wrun_test/compact','control',{}]] as const){
   expect(await consoleRouteAdmission(request(suffix,purpose,body),db,env)).toMatchObject({lares_member_id:'Owner-ID',lares_purpose:purpose});
  }
  await expect(consoleRouteAdmission(request('/wrun_test','resolver',{inputResponses:[]}),db,env)).rejects.toThrow();
  await consoleRouteAdmission(request('/wrun_test/reset','control',{}),db,env);
  await expect(requireConsoleSessionBinding(tuple,db,env)).rejects.toThrow('Conversation authority');
  await expect(bindConsoleSession(tuple,db,env)).rejects.toThrow('Conversation authority');
  await expect(db.query("UPDATE console_session_bindings SET revoked_at=NULL")).rejects.toThrow('immutable');
 });
 it('refuses untagged access to bound sessions and mixed approval plus message requests',async()=>{
  await bindConsoleSession(tuple,db,env);
  await expect(consoleRouteAdmission(new Request('http://runtime.invalid/eve/v1/session/wrun_test/stream'),db,env)).rejects.toThrow('Conversation authority');
  await expect(consoleRouteAdmission(request('/wrun_test','human',{message:'hello',inputResponses:[]}),db,env)).rejects.toThrow('Conversation authority');
  await expect(consoleRouteAdmission(request('/wrun_test','human',{inputResponses:[]}),db,env)).rejects.toThrow('Conversation authority');
 });
 it('native Waiting carries resolver metadata without binding or human authority',async()=>{
  const attrs=await consoleRouteAdmission(request('/native','legacy-resolver',{inputResponses:[]}),db,env);
  expect(attrs).toEqual({lares_resolver_member_id:'Owner-ID',lares_purpose:'legacy-resolver'});
  expect(hasConsoleTurnAuthorityTag({session:{auth:{current:{authenticator:'lares-console',attributes:attrs}}}})).toBe(false);
  expect((await db.query('SELECT * FROM console_session_bindings')).rows).toEqual([]);
  await expect(requireConsoleTurnAuthority({session:{id:'native',turn:{id:'turn',sequence:1},auth:{current:{authenticator:'lares-console',attributes:attrs},initiator:auth()}}},db,env)).rejects.toThrow('Conversation authority');
 });
 it('audience and place are immutable, missing storage refuses',async()=>{
  await bindConsoleSession(tuple,db,env);
  await expect(db.query("UPDATE console_session_bindings SET audience_revision=2")).rejects.toThrow();
  await expect(db.query("UPDATE console_session_bindings SET place_id='changed'")).rejects.toThrow('immutable');
  await expect(requireConsoleTurnAuthority(ctx(),{query:async()=>{throw new Error('storage unavailable');}},env)).rejects.toThrow('Conversation authority');
 });
});

it('all four real Vault readers require current authority before touching the store',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'console-vault-'));
 vi.stubEnv('VAULT_PATH',directory);
 writeFileSync(join(directory,'own.md'),'---\nscope: private\nowner: Owner-ID\n---\n# Own\nUnique own note.\n');
 writeFileSync(join(directory,'other.md'),'---\nscope: private\nowner: other\n---\n# Other\nSecret other note.\n');
 const areas=()=>['private'] as const;
 const reads=(callCtx:ConsoleAuthorityContext)=>[
  ()=>readTool({areas}).execute!({area:'private',path:'own.md'},callCtx as never),
  ()=>searchTool({areas}).execute!({area:'private',q:'Unique'},callCtx as never),
  ()=>listTool({areas}).execute!({area:'private'},callCtx as never),
  ()=>backlinksTool({areas}).execute!({area:'private',path:'own.md'},callCtx as never),
 ];
 try{
  await bindConsoleSession(tuple,db,env);
  for(const read of reads(ctx())) await expect(read()).resolves.toBeDefined();
  for(const read of reads(ctx('resolver'))) await expect(read()).rejects.toThrow('Conversation authority');
  await expect(readTool({areas}).execute!({area:'private',path:'other.md'},ctx() as never)).rejects.toThrow();
  await db.query("UPDATE users SET status='removed' WHERE id='Owner-ID'");
  // The Vault is now unavailable: any actual file/list read would throw a filesystem error.
  rmSync(directory,{recursive:true,force:true});
  for(const read of reads(ctx())) await expect(read()).rejects.toThrow('Conversation authority');
 }finally{rmSync(directory,{recursive:true,force:true});}
});

it('retires every pre-surface conversation and refuses old-binary active captures; reapply preserves new bindings',async()=>{
 const surfaceMigration=readFileSync(new URL('../../../services/box/sql/017_private_console_surface_capture.sql',import.meta.url),'utf8');
 await db.query('ALTER TABLE console_session_bindings DROP CONSTRAINT console_binding_private_surface_capture');
 const access=await new PgGrantStore(db).agentAccess('Owner-ID','helper');
 await db.query("INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision,policy_revision) VALUES('helper',$1,'wrun_old','Owner-ID',repeat('z',43),'old',$2,2)",[incarnation,access!.accessRevision]);
 await db.query(surfaceMigration);await db.query(surfaceMigration);await db.query(readFileSync(new URL('../../../services/box/sql/018_private_account_history.sql',import.meta.url),'utf8'));
 expect((await db.query("SELECT revoked_at,private_surface_revision FROM console_session_bindings WHERE session_id='wrun_old'")).rows[0]).toEqual({revoked_at:expect.any(Date),private_surface_revision:0});
 const old={session:{id:'wrun_old',auth:{current:auth('human','Owner-ID','z'.repeat(43)),initiator:auth('human','Owner-ID','z'.repeat(43))}}};
 await expect(verifyPrivateConsoleSession(old)).rejects.toThrow('Conversation authority');
 // A new neutral prompt cannot bless a retired history, even if local readiness was retained.
 const dist=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/context/container.js',import.meta.url))).href;
 const {ContextContainer,contextStorage}=await import(dist);
 await contextStorage.run(new ContextContainer(),async()=>{markPrivateConsoleSurface();await expect(verifyPrivateConsoleSession(old)).rejects.toThrow('Conversation authority');});
 await expect(db.query("INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision) VALUES('helper',$1,'wrun_old_binary','Owner-ID',repeat('x',43),'old-binary',$2)",[incarnation,access!.accessRevision])).rejects.toThrow('console_binding_private_surface_capture');
 await bindConsoleSession(tuple,db,env);await db.query(surfaceMigration);
 await expect(requireConsoleSessionBinding(tuple,db,env)).resolves.toMatchObject({sessionId:tuple.sessionId});
 await expect(db.query("UPDATE console_session_bindings SET private_surface_revision=0 WHERE session_id=$1",[tuple.sessionId])).rejects.toThrow('immutable');
});
it('old projected private rows stay invisible to keeper list/reset, runtime reset and Waiting, while native rows still work',async()=>{
 await bindConsoleSession(tuple,db,env);
 await db.query("INSERT INTO agent_conversations(agent,incarnation,session_id,door) VALUES('helper',$1,'wrun_test','http'),('helper',$1,'wrun_native','telegram')",[incarnation]);
 resetActions();const keeperReset=vi.fn(async()=>({status:'reset'}));registerConversationActions(db,keeperReset);
 const actionContext={actor:'owner@example.invalid',audit:vi.fn(async()=>{})};
 const listed=await runAction('conversation.list',{name:'helper'},actionContext) as any[];
 expect(listed.map(r=>r.sessionId)).toEqual(['wrun_native']);
 await expect(runAction('conversation.reset',{name:'helper',incarnation,sessionId:'wrun_test',confirm:true},actionContext)).rejects.toThrow('Conversation');expect(keeperReset).not.toHaveBeenCalled();
 const attach=vi.fn(()=>({reset:vi.fn(async()=>({status:'reset'}))}));
 await expect(resetConversation({sessionId:'wrun_test',incarnation,confirm:true},attach,db,env)).rejects.toThrow('owned');expect(attach).not.toHaveBeenCalled();
 const calls:string[]=[];
 await listWaiting('owner@example.invalid',{
  query:async(sql:string,values:unknown[])=>{
   if(sql.includes('agent_door_connections'))return{rows:[{name:'helper',address:'172.29.0.10',state:'ready',status:'valid',runtime_control_token:incarnation,incarnation,doors:[{kind:'telegram',enabled:true}],claim:{kind:'telegram',owner_email:'owner@example.invalid'}}]};
   if(sql.includes('notion_sync_proposals')||sql.includes('atlas_proposals'))return{rows:[]};
   return db.query(sql,values);
  },
  signedInMember:async()=>({id:'Owner-ID',organisationId:'org',role:'owner',status:'active',automationMode:'draft-and-ask'}),
  routePassword:()=> 'synthetic',fetch:async(input:string|URL|Request)=>{calls.push(String(input));return new Response('');},now:()=>new Date(),sleep:async()=>{},
 } as never);
 expect(calls).toHaveLength(1);expect(calls[0]).toContain('wrun_native');expect(calls[0]).not.toContain('wrun_test');
 await resetConversation({sessionId:'wrun_native',incarnation,confirm:true},attach,db,env);expect(attach).toHaveBeenCalledOnce();
});

it('a real revoked binding stops a cached model before either fake provider execution mode',async()=>{
 await bindConsoleSession(tuple,db,env);
 const dist=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/context/container.js',import.meta.url))).href;
 const {ContextContainer,contextStorage}=await import(dist);
 await contextStorage.run(new ContextContainer(),async()=>{
  markPrivateConsoleSurface();const call=vi.fn(async()=>{throw new Error('PROVIDER REACHED');});
  const resolver=definitionModel({resolveAlias:async()=> 'synthetic-model',provider:()=>new MockLanguageModelV3({doGenerate:call,doStream:call})});
  const event=(stepIndex:number)=>({type:'step.started',data:{turnId:'revoked-model-turn',sequence:0,stepIndex}});
  const selections=[await resolver.events['step.started']!(event(0),ctx() as never),await resolver.events['step.started']!(event(1),ctx() as never)];
  await db.query('UPDATE console_session_bindings SET revoked_at=clock_timestamp() WHERE session_id=$1',[tuple.sessionId]);
  await expect(resolver.events['step.started']!(event(2),ctx() as never)).rejects.toThrow('Conversation authority');
  for(const [index,method] of (['doGenerate','doStream'] as const).entries()){
   await expect(selections[index].model[method]({prompt:[]})).rejects.toThrow('Conversation authority');
   await expect(selections[index].model[method]({prompt:[]})).rejects.toThrow('fresh trusted model invocation');
  }
  expect(call).not.toHaveBeenCalled();
 });
});

it('upgrades pre-account-invalidation history once and preserves protocol 2 on ordered reapply',async()=>{
 const access=await new PgGrantStore(db).agentAccess('Owner-ID','helper');
 await bindConsoleSession(tuple,db,env);
 await db.query('ALTER TABLE console_session_bindings DROP CONSTRAINT console_binding_private_surface_capture');
 await db.query("INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision,private_surface_revision,policy_revision) VALUES('helper',$1,'old_one','Owner-ID',repeat('q',43),'old-one',$2,1,2)",[incarnation,access!.accessRevision]);
 const seventeen=readFileSync(new URL('../../../services/box/sql/017_private_console_surface_capture.sql',import.meta.url),'utf8');
 const eighteen=readFileSync(new URL('../../../services/box/sql/018_private_account_history.sql',import.meta.url),'utf8');
 await db.query(eighteen);await db.query(seventeen);await db.query(eighteen);
 expect((await db.query("SELECT revoked_at FROM console_session_bindings WHERE session_id='old_one'")).rows[0].revoked_at).toBeInstanceOf(Date);
 await expect(requireConsoleSessionBinding(tuple,db,env)).resolves.toMatchObject({sessionId:tuple.sessionId});
 await expect(db.query("INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision,private_surface_revision) VALUES('helper',$1,'old_binary','Owner-ID',repeat('j',43),'old-binary',$2,1)",[incarnation,access!.accessRevision])).rejects.toThrow('console_binding_private_surface_capture');
 await db.query("INSERT INTO connected_accounts(id,owner_member_id,generation,status) VALUES('account','Owner-ID',0,'ok')");
 await expect(requireConsoleSessionBinding(tuple,db,env)).resolves.toBeDefined();
 await db.query("UPDATE connected_accounts SET generation=1 WHERE id='account'");
 await expect(requireConsoleSessionBinding(tuple,db,env)).rejects.toThrow('Conversation authority');
 await db.query("UPDATE connected_accounts SET generation=2,status='ok' WHERE id='account'");
 await expect(bindConsoleSession(tuple,db,env)).rejects.toThrow('Conversation authority');
});
