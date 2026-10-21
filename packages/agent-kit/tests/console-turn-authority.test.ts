import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgGrantStore } from '../src/grant-store.js';
import { closePool } from '../src/db.js';
import { searchTool,readTool,listTool,backlinksTool } from '../src/note-tools.js';
import { vi } from 'vitest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindConsoleSession, bindConsoleSessionStarted, requireConsoleSessionBinding, requireConsoleTurnAuthority,
  consoleRouteAdmission, hasConsoleTurnAuthorityTag, type ConsoleAuthorityContext } from '../src/console-turn-authority.js';
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
 CREATE TABLE agent_resources(name text PRIMARY KEY,ownership_token uuid,runtime_control_token uuid,state text,pending boolean);
 INSERT INTO orgs VALUES('org','Example');
 INSERT INTO users(id,display_name,status,org_role,org_id) VALUES('Owner-ID','Owner','active','owner','org'),('other','Other','active','owner','org');
 INSERT INTO org_member_policy VALUES('Owner-ID',NULL);
 INSERT INTO agent_definitions VALUES('helper','valid','definition-one','{"grants":[]}');
 INSERT INTO agent_resources VALUES('helper','${incarnation}','${incarnation}','ready',false);`);
 for(const file of ['007_member_identity_sessions.sql','013_console_turn_authority.sql','014_agent_access_grants.sql','016_console_agent_access_capture.sql'])await db.query(readFileSync(new URL(`../../../services/box/sql/${file}`,import.meta.url),'utf8'));
 await new PgGrantStore(db).adoptAgent('Owner-ID',{agentName:'helper',expectedDefinitionHash:'definition-one'},{designatedOwnerMemberId:'Owner-ID'});
});
describe('durable console authority on disposable PostgreSQL',()=>{
 it('binds only an exact singleton and returns stable actor/speaker independently of email',async()=>{
  await bindConsoleSession(tuple,db,env);
  expect(await requireConsoleTurnAuthority(ctx(),db,env)).toEqual({origin:'human',agentId:'helper',sessionId:'wrun_test',turnId:'turn-1',actingMemberId:'Owner-ID',spokenByMemberId:'Owner-ID',placeId:`console:helper:${incarnation}:wrun_test`,audience:{placeId:`console:helper:${incarnation}:wrun_test`,revision:1,participants:[{kind:'member',memberId:'Owner-ID'}]},policyRevision:1});
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
  await db.query("INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id) VALUES('helper',$1,'historical','Owner-ID',repeat('z',43),'historical')",[incarnation]);
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
  await expect(bindConsoleSession(other,db,env)).rejects.toThrow('Conversation authority');
  await bindConsoleSession(other,db,otherEnv);await db.query('SELECT pg_sleep(0.6)');
  await expect(requireConsoleSessionBinding(other,db,otherEnv)).rejects.toThrow('Conversation authority');
 });
 it('uses one connection and serializes capture before concurrent access revocation',async()=>{
  const single=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:500});
  try{await bindConsoleSession(tuple,single,env);await requireConsoleSessionBinding(tuple,single,env);}finally{await single.end();}
  await db.query('DELETE FROM console_session_bindings');
  const client=await db.connect();await client.query('BEGIN');
  try{
   await bindConsoleSession(tuple,client,env);
   const store=new PgGrantStore(db),a=await store.agentAccess('Owner-ID','helper');
   let finished=false;const revoked=store.updateAgentAccess('Owner-ID',{agentName:'helper',expectedRevision:a!.accessRevision,grants:[]}).then(()=>{finished=true;});
   // An independent connection proves revocation is waiting on the capture transaction's org lock.
   for(let i=0;i<100;i++){
    const wait=await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM orgs%'");
    if(wait.rows.length)break;
    await new Promise(resolve=>setTimeout(resolve,10));
    if(i===99)throw new Error('Revocation did not reach lock barrier');
   }
   expect(finished).toBe(false);await client.query('COMMIT');await revoked;
   expect((await db.query('SELECT revoked_at FROM console_session_bindings')).rows[0].revoked_at).toBeInstanceOf(Date);
   await expect(requireConsoleSessionBinding(tuple,db,env)).rejects.toThrow('Conversation authority');
   await expect(bindConsoleSession(tuple,db,env)).rejects.toThrow('Conversation authority');
  }finally{await client.query('ROLLBACK');client.release();}
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
  for(const [suffix,purpose,body] of [['/wrun_test/stream','read',undefined],['/wrun_test','resolver',{inputResponses:[]}],['/wrun_test/cancel','control',{}],['/wrun_test/clear','control',{}],['/wrun_test/compact','control',{}]] as const){
   expect(await consoleRouteAdmission(request(suffix,purpose,body),db,env)).toMatchObject({lares_member_id:'Owner-ID',lares_purpose:purpose});
  }
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
