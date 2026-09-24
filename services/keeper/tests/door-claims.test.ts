import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
import {registerDoorActions} from '../lib/doors.js';
import {runAction,resetActions} from '../lib/actions.js';
import {consumeClaim,assertDoorAuthority,assertManagedRuntimeCurrent} from '@lares/agent-kit/door-authority';
let container:StartedPostgreSqlContainer,pool:Pool;
const inc='11111111-1111-4111-8111-111111111111';
const env={LARES_AGENT_NAME:'writer',LARES_AGENT_INCARNATION:inc};
const ctx={actor:'owner@example.com',audit:vi.fn()};
const issue=()=>runAction('door.claim_issue',{name:'writer',kind:'slack'},ctx) as Promise<{code:string;instruction:string}>;
beforeAll(async()=>{
 container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=new Pool({connectionString:container.getConnectionUri()});
 // A stopped container ends every session with FATAL 57P01; a connection the pool already let go of
 // has no listener left and the run fails although every test passed (seen on CI, 2026-09-19).
 pool.on('error',()=>undefined);pool.on('connect',(c)=>c.on('error',()=>undefined));
 for(const f of ['039_agent_definitions.sql','042_agent_resources.sql','044_agent_door_connections.sql','045_agent_runtime_control.sql'])await pool.query(readFileSync(resolve('../box/sql',f),'utf8'));
});
afterAll(async()=>{await pool?.end();await container?.stop();});
beforeEach(async()=>{
 await pool.query('TRUNCATE agent_definitions,agent_resources,agent_doors,agent_door_connections,agent_door_claim_audit');
 const d={name:'writer',role:'creative',doors:[{kind:'slack',enabled:true}]};
 await pool.query("INSERT INTO agent_definitions(name,hash,definition,status)VALUES('writer','hash',$1,'valid')",[JSON.stringify(d)]);
 await pool.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,applied_definition,pending)VALUES('writer','172.29.0.10','writer','owned',$1,$1,'ready',$2,false)",[inc,JSON.stringify(d)]);
 await pool.query("INSERT INTO agent_doors(agent,kind,enabled)VALUES('writer','slack',true)");
 resetActions();registerDoorActions({pool,secretsDir:'/unused'});vi.clearAllMocks();
});
it('hashes codes, permits verified bootstrap, consumes exactly once, and needs explicit apply',async()=>{
 const {code}=await issue();expect(code).toMatch(/^[A-Z0-9]{24}$/);
 const before=(await pool.query('SELECT * FROM agent_door_connections')).rows[0];
 expect(before.code_hash).not.toContain(code);expect(JSON.stringify(ctx.audit.mock.calls)).not.toContain(code);
 await assertDoorAuthority('slack',true,pool,env);
 await expect(assertDoorAuthority('slack',false,pool,env)).rejects.toThrow();
 expect(await consumeClaim('slack',`/claim ${code}`,'U_OWNER',true,pool,env)).toBe(true);
 expect(await consumeClaim('slack',`/claim ${code}`,'U_OTHER',true,pool,env)).toBe(true);
 const c=(await pool.query('SELECT * FROM agent_door_connections')).rows[0];
 expect(c.principal).toBe('U_OWNER');expect(c.code_hash).toBeNull();
 expect((await pool.query('SELECT principal FROM agent_door_claim_audit')).rows).toEqual([{principal:'U_OWNER'}]);
 expect((await pool.query('SELECT pending FROM agent_resources')).rows[0].pending).toBe(true);
 await expect(assertDoorAuthority('slack',true,pool,env)).rejects.toThrow();
 await expect(issue()).rejects.toThrow(/already claimed/);
 await pool.query('UPDATE agent_door_connections SET applied_revision=revision');await pool.query('UPDATE agent_resources SET pending=false');
 const applied={...env,LARES_SLACK_PRINCIPAL:'U_OWNER',LARES_SLACK_CLAIM_REVISION:c.revision};
 await assertDoorAuthority('slack',false,pool,applied);
 await assertManagedRuntimeCurrent(pool,applied);
 await pool.query('UPDATE agent_resources SET pending=true');await expect(assertManagedRuntimeCurrent(pool,applied)).rejects.toThrow();await pool.query('UPDATE agent_resources SET pending=false');
 await expect(assertDoorAuthority('slack',false,pool,{...applied,LARES_SLACK_PRINCIPAL:'U_LEGACY'})).rejects.toThrow();
 await pool.query('UPDATE agent_doors SET enabled=false');await expect(assertDoorAuthority('slack',true,pool,applied)).rejects.toThrow();
});
it('refuses expired, wrong, non-private and old incarnation claims without leaking control text',async()=>{
 const {code}=await issue();
 await consumeClaim('slack',`/claim ${code}`,'U_OTHER',false,pool,env);
 await consumeClaim('slack','/claim INVALID','U_OTHER',true,pool,env);
 await pool.query("UPDATE agent_door_connections SET expires_at=now()-interval '1 second'");
 await consumeClaim('slack',`/claim ${code}`,'U_OTHER',true,pool,env);
 expect((await pool.query('SELECT principal FROM agent_door_connections')).rows[0].principal).toBeNull();
 await pool.query("UPDATE agent_resources SET runtime_control_token=NULL,ownership_token='22222222-2222-4222-8222-222222222222'");
 await consumeClaim('slack',`/claim ${code}`,'U_OTHER',true,pool,env);
 expect((await pool.query('SELECT principal FROM agent_door_connections')).rows[0].principal).toBeNull();
 await expect(assertDoorAuthority('slack',true,pool,env)).rejects.toThrow();
});
it('bounds attempts and serializes simultaneous consumers',async()=>{
 const {code}=await issue();await Promise.all(Array.from({length:20},()=>consumeClaim('slack','/claim WRONG','U_OTHER',true,pool,env)));
 await consumeClaim('slack',`/claim ${code}`,'U_OWNER',true,pool,env);
 let c=(await pool.query('SELECT * FROM agent_door_connections')).rows[0];expect(c.attempts).toBe(10);expect(c.principal).toBeNull();
 const next=await issue();await Promise.all(['U_ONE','U_TWO'].map(id=>consumeClaim('slack',`/claim ${next.code}`,id,true,pool,env)));
 c=(await pool.query('SELECT * FROM agent_door_connections')).rows[0];expect(['U_ONE','U_TWO']).toContain(c.principal);expect(c.attempts).toBe(1);
});
it('refuses authority on DB failure',async()=>{await expect(assertDoorAuthority('slack',true,{query:async()=>{throw new Error('unavailable');}},env)).rejects.toThrow('unavailable');});

it('adopted legacy runtime uses shared authority and relay, revocation and wrong incarnation fail closed',async()=>{
 const {forwardDoor}=await import('../../console/lib/door-forwarder.js');
 const relay=()=>forwardDoor(new Request('http://console/api/doors/writer/slack/events',{method:'POST',body:'{}'}),'writer','slack',{
  query:(sql,values)=>pool.query(sql,values),fetch:vi.fn(async()=>new Response('accepted')) as typeof fetch});
 await pool.query("UPDATE agent_resources SET ownership='legacy',runtime_control_token=NULL");
 await expect(issue()).rejects.toThrow();await expect(assertManagedRuntimeCurrent(pool,env)).rejects.toThrow();expect((await relay()).status).toBe(404);
 await pool.query('UPDATE agent_resources SET runtime_control_token=ownership_token,pending=true');
 await expect(assertManagedRuntimeCurrent(pool,env)).rejects.toThrow();expect((await relay()).status).toBe(404);
 await pool.query('UPDATE agent_resources SET pending=false');
 await assertDoorAuthority('slack',true,pool,env);expect((await relay()).status).toBe(200);
 await expect(assertManagedRuntimeCurrent(pool,{...env,LARES_AGENT_INCARNATION:'22222222-2222-4222-8222-222222222222'})).rejects.toThrow();
 const {code}=await issue();await consumeClaim('slack',`/claim ${code}`,'U_OWNER',true,pool,env);
 const connection=(await pool.query('SELECT * FROM agent_door_connections')).rows[0];expect(connection.principal).toBe('U_OWNER');
 await pool.query('UPDATE agent_door_connections SET applied_revision=revision');await pool.query('UPDATE agent_resources SET pending=false');
 await assertManagedRuntimeCurrent(pool,{...env,LARES_SLACK_PRINCIPAL:'U_OWNER',LARES_SLACK_CLAIM_REVISION:connection.revision});
 await pool.query('UPDATE agent_resources SET runtime_control_token=NULL,pending=false');
 await expect(assertDoorAuthority('slack',true,pool,env)).rejects.toThrow();await expect(assertManagedRuntimeCurrent(pool,env)).rejects.toThrow();expect((await relay()).status).toBe(404);
});

it.each(['claim','/claim'])('accepts %s as private control input with one-use authority',async(command)=>{
 const {code,instruction}=await issue();expect(instruction).toContain(`Send claim ${code} as an ordinary message`);
 expect(await consumeClaim('slack',`  ${command} ${code}  `,'U_OTHER',false,pool,env)).toBe(true);
 expect((await pool.query('SELECT attempts FROM agent_door_connections')).rows[0].attempts).toBe(0);
 expect(await consumeClaim('slack',`${command} INVALID`,'U_OWNER',true,pool,env)).toBe(true);
 expect(await consumeClaim('slack',`  ${command} ${code}  `,'U_OWNER',true,pool,env)).toBe(true);
 const c=(await pool.query('SELECT * FROM agent_door_connections')).rows[0];
 expect(c.principal).toBe('U_OWNER');expect(c.attempts).toBe(2);expect(c.code_hash).toBeNull();
 await expect(assertDoorAuthority('slack',true,pool,env)).rejects.toThrow();
});
it('keeps claim-looking control text out of model history without intercepting unrelated words',async()=>{
 const {code}=await issue();
 for(const text of ['claim WRONG','  /claim WRONG','CLAIM '+code,'claim'])expect(await consumeClaim('slack',text,'U_OWNER',true,pool,env)).toBe(true);
 expect((await pool.query('SELECT principal FROM agent_door_connections')).rows[0].principal).toBeNull();
 for(const text of ['claims report','reclaim this','Please claim this task'])expect(await consumeClaim('slack',text,'U_OWNER',true,pool,env)).toBe(false);
});
