import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { PgGrantStore } from '../src/grant-store.js';
import { quiet } from './helpers/quiet-pool.js';
const migration=(n:string)=>readFileSync(new URL(`../../../services/box/sql/${n}`,import.meta.url),'utf8');
let db:Pool,store:PgGrantStore,stop:()=>Promise<void>;
const agent={kind:'agent',id:'assistant'};
const named=(id:string,permission:'use'|'edit'='use',expiresAt:string|null=null)=>({principal:{kind:'member' as const,id},permission,expiresAt});
const organisation={principal:{kind:'organisation' as const,id:'org'},permission:'use' as const,expiresAt:null};
beforeAll(async()=>{const container=await new PostgreSqlContainer('postgres:16-alpine').start();db=quiet(new Pool({connectionString:container.getConnectionUri()}));store=new PgGrantStore(db);stop=async()=>{await db.end();await container.stop();};},120_000);
afterAll(async()=>{await stop?.();});
beforeEach(async()=>{
  await db.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
  await db.query(`CREATE TABLE orgs(id text PRIMARY KEY,display_name text NOT NULL);
    CREATE TABLE users(id text PRIMARY KEY,display_name text NOT NULL,primary_email text,org_id text REFERENCES orgs(id),org_role text NOT NULL DEFAULT 'member',created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE org_member_policy(user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,allowed_capabilities text[]);
    CREATE TABLE agent_definitions(name text PRIMARY KEY,hash text NOT NULL,definition jsonb NOT NULL,status text NOT NULL DEFAULT 'valid');
    INSERT INTO orgs VALUES('org','Example'),('other','Other');
    INSERT INTO users(id,display_name,org_id,org_role) VALUES('owner','Owner','org','owner'),('second','Second','org','member'),('restricted','Restricted','org','restricted'),('other','Other','other','owner'),('admin','Admin','org','owner');
    INSERT INTO org_member_policy VALUES('owner',NULL),('other',NULL);
    INSERT INTO agent_definitions(name,hash,definition) VALUES('assistant','version-one','{"grants":[{"capability":"echo","scope":"read"}]}'),('hidden','hidden-version','{"grants":[]}');`);
  await db.query(migration('007_member_identity_sessions.sql'));
  await db.query(migration('013_console_turn_authority.sql'));
  await db.query(migration('014_agent_access_grants.sql'));
});
async function adopt(){return store.adoptAgent('owner',{agentName:agent.id,expectedDefinitionHash:'version-one'},{designatedOwnerMemberId:'owner'});}
async function set(grants:Parameters<PgGrantStore['updateAgentAccess']>[1]['grants']){const current=await store.agentAccess('owner',agent.id);return store.updateAgentAccess('owner',{agentName:agent.id,expectedRevision:current!.accessRevision,grants});}
async function bind(){await db.query("INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id) VALUES('assistant','11111111-1111-4111-8111-111111111111','session','owner',repeat('a',43),'place')");}
const outsideDefinitionHash='a'.repeat(64);
function outsideDefinition(overrides:Record<string,unknown>={}){return {
  name:agent.id,model:'lares-brain',grants:[{capability:'outside',scope:'read'}],
  outsideTools:[{name:'mail',url:'https://api.example.com/mcp',description:'Mail tools',token:true,tools:{allow:['search','send'],read:['search','send']},trusted:false},
    {name:'calendar',url:'https://calendar.example.com/mcp',description:'Calendar tools',token:true,tools:{allow:['events'],read:['events']},trusted:true}],
  ...overrides,
};}
async function adoptOutside(){
  await db.query('UPDATE agent_definitions SET hash=$1,definition=$2::jsonb,status=\'valid\' WHERE name=$3',[outsideDefinitionHash,JSON.stringify(outsideDefinition()),agent.id]);
  return store.adoptAgent('owner',{agentName:agent.id,expectedDefinitionHash:outsideDefinitionHash},{designatedOwnerMemberId:'owner'});
}
async function captureOutside(memberId:string,connectionName='mail',expected?:{definitionHash:string;accessRevision:number}){
  const client=await db.connect();await client.query('BEGIN');
  try{return await store.captureOutsideUse(memberId,agent.id,{db:client,connectionName,...(expected===undefined?{}:{expected})});}
  finally{await client.query('ROLLBACK');client.release();}
}
async function beginTaggedCapture(memberId:string,expected:{definitionHash:string;accessRevision:number}){
  const client=await db.connect();
  try{
    await client.query('BEGIN');await client.query("SET LOCAL application_name='outside_capture_lock_test'");
    const result=store.captureOutsideUse(memberId,agent.id,{db:client,connectionName:'mail',expected});
    return {client,result};
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});client.release();throw error;
  }
}
async function waitForCaptureLock(queryText:string){
  for(let attempt=0;attempt<500;attempt++){
    const result=await db.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='outside_capture_lock_test' AND wait_event_type='Lock' AND query LIKE $1) AS waiting`,[`%${queryText}%`]);
    if(result.rows[0]?.waiting)return true;
    await db.query('SELECT pg_sleep(0.01)');
  }
  return false;
}
describe('agent grants on disposable PostgreSQL',()=>{
  it('requires explicit designated-owner self adoption, current definition and owner policy',async()=>{
    expect(await store.can('owner',agent,'use')).toBe(false);
    await expect(store.adoptAgent('admin',{agentName:agent.id,expectedDefinitionHash:'version-one'},{designatedOwnerMemberId:'owner'})).rejects.toThrow('denied');
    await expect(store.adoptAgent('owner',{agentName:agent.id,expectedDefinitionHash:'old'},{designatedOwnerMemberId:'owner'})).rejects.toThrow('stale');
    await db.query("DELETE FROM org_member_policy WHERE user_id='owner'");await expect(adopt()).rejects.toThrow('denied');
    await db.query("INSERT INTO org_member_policy VALUES('owner',ARRAY[]::text[])");await expect(adopt()).rejects.toThrow('denied');
    await db.query("UPDATE agent_definitions SET definition='{"+'"grants":[{"capability":"echo","scope":"none"}]'+"}' WHERE name='assistant'");
    const adopted=await adopt();expect(adopted.ownerMemberId).toBe('owner');expect(await store.can('owner',agent,'edit')).toBe(true);
    await expect(adopt()).rejects.toThrow('stale');
  });
  it('separates use/edit, honours named restricted members, and never grants another administrator inherent access',async()=>{
    await adopt();await set([named('second'),named('restricted','edit')]);
    expect(await store.can('second',agent,'use')).toBe(true);expect(await store.can('second',agent,'edit')).toBe(false);
    expect(await store.can('restricted',agent,'use')).toBe(false);expect(await store.can('restricted',agent,'edit')).toBe(true);
    expect(await store.can('admin',agent,'use')).toBe(false);expect(await store.can('other',agent,'use')).toBe(false);
    await expect(set([named('other')])).rejects.toThrow('denied');
    await expect(store.updateAgentAccess('restricted',{agentName:agent.id,expectedRevision:(await store.agentAccess('owner',agent.id))!.accessRevision,grants:[]})).rejects.toThrow('denied');
  });
  it('allows organisation use excluding restricted, with no caller capability-policy prerequisite',async()=>{
    await adopt();await set([organisation]);expect(await store.can('second',agent,'use')).toBe(true);expect(await store.can('restricted',agent,'use')).toBe(false);
    await db.query("INSERT INTO org_member_policy VALUES('second',ARRAY[]::text[])");
    expect(await store.can('second',agent,'use')).toBe(true);expect(await store.can('second',agent,'edit')).toBe(false);
    await expect(set([{...organisation,permission:'edit'}])).rejects.toThrow('invalid');
    await expect(set([{...organisation,principal:{kind:'place',id:'org'}}] as never)).rejects.toThrow('invalid');
    expect(await store.can('second',{kind:'account',id:agent.id},'use')).toBe(false);
    expect(await store.listVisible('second','account')).toEqual([]);
  });
  it('shares can/listVisible decisions and returns only redacted authorised metadata',async()=>{
    await adopt();await set([named('second','edit')]);
    const list=await store.listVisible('second','agent');expect(list).toEqual([{resource:agent,accessRevision:expect.any(Number),permissions:['edit']}]);
    expect(JSON.stringify(list)).not.toMatch(/owner|hidden|definition|hash|grants|credential/);
    for(const permission of ['use','edit'])expect(await store.can('second',agent,permission)).toBe(list[0].permissions.includes(permission as 'edit'));
    expect(await store.agentAccess('second',agent.id)).toBeUndefined();expect(await store.listVisible('other','agent')).toEqual([]);
  });
  it('expires grants and rejects expired mutation input atomically',async()=>{
    await adopt();await set([named('second','use',new Date(Date.now()+250).toISOString())]);expect(await store.can('second',agent,'use')).toBe(true);
    await db.query('SELECT pg_sleep(0.3)');expect(await store.can('second',agent,'use')).toBe(false);expect(await store.listVisible('second','agent')).toEqual([]);
    const before=(await store.agentAccess('owner',agent.id))!.accessRevision;
    await expect(set([named('second','use',new Date(0).toISOString())])).rejects.toThrow('invalid');
    expect((await store.agentAccess('owner',agent.id))!.accessRevision).toBe(before);
  });
  it('uses monotonic revisions, retires bindings, and never revives revoked captures after regrant',async()=>{
    await adopt();await bind();const granted=await set([named('second')]);
    expect((await db.query('SELECT revoked_at FROM console_session_bindings')).rows[0].revoked_at).toBeInstanceOf(Date);
    const revoked=await set([]);expect(revoked.accessRevision).toBeGreaterThan(granted.accessRevision);expect(await store.can('second',agent,'use')).toBe(false);
    const regrant=await set([named('second')]);expect(regrant.accessRevision).toBeGreaterThan(revoked.accessRevision);
    expect(await store.can('second',agent,'use',{expectedRevision:granted.accessRevision})).toBe(false);expect(await store.can('second',agent,'use',{expectedRevision:regrant.accessRevision})).toBe(true);
    const history=await db.query('SELECT revoked_at FROM resource_grants');expect(history.rows).toHaveLength(2);expect(history.rows[0].revoked_at).not.toBeNull();
    await expect(db.query('UPDATE resource_grants SET revoked_at=NULL WHERE revoked_at IS NOT NULL')).rejects.toThrow('immutable');
    await expect(store.updateAgentAccess('owner',{agentName:agent.id,expectedRevision:granted.accessRevision,grants:[]})).rejects.toThrow('stale');
    const same={agentName:agent.id,expectedRevision:regrant.accessRevision};
    const results=await Promise.allSettled([store.updateAgentAccess('owner',{...same,grants:[named('second')]}),store.updateAgentAccess('owner',{...same,grants:[]})]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  });
  it('tombstones a removed members direct grants without clearing other sharing; membership changes invalidate captures',async()=>{
    await adopt();const initial=await set([named('second'),named('restricted')]);await bind();
    await db.query("UPDATE users SET status='removed' WHERE id='second'");
    expect(await store.can('second',agent,'use')).toBe(false);expect(await store.can('restricted',agent,'use')).toBe(true);
    expect(await store.can('restricted',agent,'use',{expectedRevision:initial.accessRevision})).toBe(false);
    await db.query("UPDATE users SET status='active' WHERE id='second'");expect(await store.can('second',agent,'use')).toBe(false);
    expect((await db.query('SELECT revoked_at FROM console_session_bindings')).rows[0].revoked_at).not.toBeNull();
    await set([organisation]);await db.query("UPDATE users SET org_role='restricted' WHERE id='second'");expect(await store.can('second',agent,'use')).toBe(false);
    expect(await store.can('admin',agent,'use')).toBe(true);
  });
  it('checks only owner capability ceiling and keeps grant configuration while invalidating captures',async()=>{
    await adopt();const initial=await set([named('second')]);await bind();
    await db.query("UPDATE org_member_policy SET allowed_capabilities=ARRAY[]::text[] WHERE user_id='owner'");
    expect(await store.can('owner',agent,'use')).toBe(false);expect(await store.can('second',agent,'use')).toBe(false);
    await db.query("UPDATE org_member_policy SET allowed_capabilities=NULL WHERE user_id='owner'");
    expect(await store.can('second',agent,'use')).toBe(true);expect(await store.can('second',agent,'use',{expectedRevision:initial.accessRevision})).toBe(false);
    expect((await db.query('SELECT revoked_at FROM resource_grants')).rows[0].revoked_at).toBeNull();
  });
  it('reuses a callers one-connection transaction and directly locks the current owner policy',async()=>{
    await adopt();await set([named('second')]);
    const single=quiet(new Pool({connectionString:(db.options as {connectionString:string}).connectionString,max:1,connectionTimeoutMillis:500}));
    const client=await single.connect();await client.query('BEGIN');
    try{
      expect(await new PgGrantStore(single).can('second',agent,'use',{db:client})).toBe(true);
      expect(await new PgGrantStore(single).listVisible('second','agent',{db:client})).toHaveLength(1);
      const other=await db.connect();try{await other.query('BEGIN');await other.query("SET LOCAL lock_timeout='100ms'");await expect(other.query("UPDATE org_member_policy SET allowed_capabilities=ARRAY[]::text[] WHERE user_id='owner'")).rejects.toMatchObject({code:'55P03'});await other.query('ROLLBACK');}finally{other.release();}
    }finally{await client.query('ROLLBACK');client.release();await single.end();}
  });
  it('definition change-away/restore invalidates captures but identical refreshes preserve them',async()=>{
    await adopt();const initial=await set([named('second')]);await bind();
    await db.query("UPDATE agent_definitions SET hash=hash,status=status WHERE name='assistant'");
    expect(await store.can('second',agent,'use',{expectedRevision:initial.accessRevision})).toBe(true);
    await db.query("UPDATE agent_definitions SET hash='version-two' WHERE name='assistant'");
    await db.query("UPDATE agent_definitions SET hash='version-one' WHERE name='assistant'");
    expect(await store.can('second',agent,'use')).toBe(true);
    expect(await store.can('second',agent,'use',{expectedRevision:initial.accessRevision})).toBe(false);
    expect((await db.query('SELECT revoked_at FROM console_session_bindings')).rows[0].revoked_at).not.toBeNull();
  });
  it('rechecks an actual console session after locking and rolls back failed changes',async()=>{
    await expect(store.adoptAgent('owner',{agentName:agent.id,expectedDefinitionHash:'version-one'},{designatedOwnerMemberId:'owner',sessionToken:'invalid'})).rejects.toThrow('denied');
    expect(await store.agentAccess('owner',agent.id)).toBeUndefined();
    await adopt();const initial=await set([named('second')]);
    await expect(store.updateAgentAccess('owner',{agentName:agent.id,expectedRevision:initial.accessRevision,grants:[]},{sessionToken:'invalid'})).rejects.toThrow('denied');
    expect(await store.can('second',agent,'use',{expectedRevision:initial.accessRevision})).toBe(true);
  });
  it('captures one saved bearer connection with current owner or exact member grant proof',async()=>{
    await adoptOutside();
    const owner=await captureOutside('owner','mail');
    expect(owner).toMatchObject({version:1,actor:{memberId:'owner',organisationId:'org',role:'owner'},
      agent:{name:'assistant',ownerMemberId:'owner',definitionHash:outsideDefinitionHash},
      ownerPolicy:{kind:'unrestricted'},outside:{scope:'read',autonomy:'gated',connection:{name:'mail',url:'https://api.example.com/mcp',auth:'bearer',allow:['search','send'],read:['search','send'],trusted:false}},
      grant:{kind:'owner',validUntil:null}});
    expect(JSON.stringify(owner)).not.toContain('calendar.example.com');
    expect(await captureOutside('admin','mail')).toBeUndefined();
    await set([named('second'),named('restricted'),organisation]);
    const expected={definitionHash:outsideDefinitionHash,accessRevision:(await store.agentAccess('owner',agent.id))!.accessRevision};
    const second=await captureOutside('second','mail',expected);
    expect(second?.grant).toMatchObject({kind:'grant',principal:{kind:'member',id:'second'},permission:'use'});
    expect(second?.grant.kind==='grant'&&second.grant.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await captureOutside('second','calendar',expected)).toMatchObject({outside:{connection:{name:'calendar',url:'https://calendar.example.com/mcp'}}});
    expect(await captureOutside('restricted')).toMatchObject({actor:{role:'restricted'},grant:{kind:'grant',principal:{kind:'member',id:'restricted'}}});
    expect(await captureOutside('admin')).toMatchObject({grant:{kind:'grant',principal:{kind:'organisation',id:'org'}}});
    await set([named('second'),organisation]);
    expect(await captureOutside('restricted')).toBeUndefined();
    expect(await captureOutside('other','mail')).toBeUndefined();
  });
  it('uses deterministic member grant proof, checks the complete expected revision pair and rejects invalid declarations',async()=>{
    await adoptOutside();await set([named('second'),organisation]);
    await db.query("UPDATE org_member_policy SET allowed_capabilities=ARRAY['outside'] WHERE user_id='owner'");
    expect(await captureOutside('owner')).toMatchObject({ownerPolicy:{kind:'ceiling',requiredCapabilities:['outside']}});
    await db.query("UPDATE org_member_policy SET allowed_capabilities=ARRAY[]::text[] WHERE user_id='owner'");
    expect(await captureOutside('second')).toBeUndefined();
    await db.query("UPDATE org_member_policy SET allowed_capabilities=NULL WHERE user_id='owner'");
    const current=(await store.agentAccess('owner',agent.id))!;
    const captured=await captureOutside('second','mail',{definitionHash:outsideDefinitionHash,accessRevision:current.accessRevision});
    expect(captured?.grant).toMatchObject({kind:'grant',principal:{kind:'member',id:'second'}});
    expect(await captureOutside('second','mail',{definitionHash:'b'.repeat(64),accessRevision:current.accessRevision})).toBeUndefined();
    expect(await captureOutside('second','mail',{definitionHash:outsideDefinitionHash,accessRevision:current.accessRevision+1})).toBeUndefined();
    await expect(store.captureOutsideUse('second',agent.id,{db:db as never,connectionName:'mail',expected:{definitionHash:'A'.repeat(64),accessRevision:current.accessRevision}})).rejects.toMatchObject({code:'invalid'});
    await expect(store.captureOutsideUse('second',agent.id,{db:db as never,connectionName:'mail',expected:{definitionHash:outsideDefinitionHash} as never})).rejects.toMatchObject({code:'invalid'});
    expect(await captureOutside('second','missing')).toBeUndefined();
    const malformed=[
      outsideDefinition({outsideTools:[{name:'mail',url:'http://127.0.0.1',description:'bad',token:true,tools:{allow:['search'],read:['search']}}]}),
      outsideDefinition({outsideTools:[{name:'mail',url:'https://api.example.com/mcp',description:'mail',token:false,tools:{allow:['search'],read:['search']}}]}),
      outsideDefinition({autonomy:{outside:'never'}}),
      outsideDefinition({outsideTools:[{name:'mail',url:'https://api.example.com/mcp',description:'mail',token:true,tools:{allow:['search'],read:['other']}}]}),
      outsideDefinition({grants:[]}),
      outsideDefinition({grants:[{capability:'outside',scope:'none'}]}),
      outsideDefinition({grants:[{capability:'outside',scope:'none'},{capability:'outside',scope:'read'}]}),
      outsideDefinition({grants:[{capability:'outside',scope:'read'},{capability:'outside',scope:'none'}]}),
      outsideDefinition({grants:[{capability:'outside',scope:'write'}]}),
      outsideDefinition({outsideTools:[{name:'mail',url:'https://api.example.com/mcp',description:'mail',token:true,tools:{allow:['search','send'],read:['search']}}]}),
      outsideDefinition({unexpected:true}),
    ];
    for(const definition of malformed){
      await db.query('UPDATE agent_definitions SET definition=$1::jsonb WHERE name=$2',[JSON.stringify(definition),agent.id]);
      expect(await captureOutside('second','mail')).toBeUndefined();
    }
    await db.query('UPDATE agent_definitions SET definition=$1::jsonb WHERE name=$2',[JSON.stringify(outsideDefinition({grants:[{capability:'outside',scope:'write-with-confirm'}],outsideTools:[{name:'mail',url:'https://api.example.com/mcp',description:'mail',token:true,tools:{allow:['search','send'],read:['search']}}]})),agent.id]);
    expect(await captureOutside('owner')).toMatchObject({outside:{scope:'write-with-confirm'}});
  });
  it('keeps ordinary capture APIs on their existing result shape when member and organisation grants coexist',async()=>{
    await adoptOutside();await set([named('second','use','2099-01-01T00:00:00.123Z'),{...organisation,expiresAt:'2099-01-02T00:00:00.456Z'}]);
    const ordinary=await store.captureUseWithExpiry('second',agent.id);
    expect(ordinary).toMatchObject({accessRevision:expect.any(Number),validUntil:expect.any(String)});
    expect(Object.keys(ordinary!).sort()).toEqual(['accessRevision','validUntil']);
    const outside=await captureOutside('second');
    expect(outside?.grant).toMatchObject({kind:'grant',principal:{kind:'member',id:'second'},validUntil:'2099-01-01T00:00:00.123000Z'});
  });
  it('returns exact member grant IDs and six-digit SQL expiry, then chooses stable IDs within a grant class',async()=>{
    await adoptOutside();await set([named('second','use','2099-06-01T00:00:00.123456Z'),named('restricted','use','2099-06-02T00:00:00.654321Z')]);
    const expected={definitionHash:outsideDefinitionHash,accessRevision:(await store.agentAccess('owner',agent.id))!.accessRevision};
    const rows=await db.query<{id:string;principal_member_id:string;valid_until:string}>(`SELECT id::text,principal_member_id,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_until
      FROM resource_grants WHERE resource_id=$1 AND revoked_at IS NULL AND principal_member_id IS NOT NULL ORDER BY principal_member_id`,[agent.id]);
    const second=await captureOutside('second','mail',expected),restricted=await captureOutside('restricted','mail',expected);
    const secondRow=rows.rows.find(row=>row.principal_member_id==='second')!,restrictedRow=rows.rows.find(row=>row.principal_member_id==='restricted')!;
    expect(second?.grant).toEqual({kind:'grant',id:secondRow.id,principal:{kind:'member',id:'second'},permission:'use',validUntil:'2099-06-01T00:00:00.123456Z'});
    expect(restricted?.grant).toEqual({kind:'grant',id:restrictedRow.id,principal:{kind:'member',id:'restricted'},permission:'use',validUntil:'2099-06-02T00:00:00.654321Z'});
    await set([organisation]);
    const current=(await store.agentAccess('owner',agent.id))!.accessRevision;
    const lower='00000000-0000-4000-8000-000000000001',higher='00000000-0000-4000-8000-000000000002';
    for(const id of [higher,lower])await db.query(`INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,principal_organisation_id,permission,grantor_member_id,issued_access_revision)
      VALUES($1,'agent',$2,'second',NULL,'use','owner',$3)`,[id,agent.id,current]);
    const tied=await captureOutside('second','mail',{definitionHash:outsideDefinitionHash,accessRevision:current});
    expect(tied?.grant).toEqual({kind:'grant',id:lower,principal:{kind:'member',id:'second'},permission:'use',validUntil:null});
  });
  it('distinguishes an actual null expiry from infinity and does not fall back from a selected nonfinite grant',async()=>{
    await adoptOutside();await set([named('second')]);
    expect(await captureOutside('second')).toMatchObject({grant:{kind:'grant',principal:{kind:'member',id:'second'},validUntil:null}});
    await set([organisation]);
    const revision=(await store.agentAccess('owner',agent.id))!.accessRevision;
    await db.query(`INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,principal_organisation_id,permission,grantor_member_id,issued_access_revision,expires_at)
      VALUES('00000000-0000-4000-8000-000000000003','agent',$1,'second',NULL,'use','owner',$2,'infinity')`,[agent.id,revision]);
    expect(await captureOutside('second')).toBeUndefined();
  });
  it('refuses a selected grant that expires during an observed lock wait without using a live organisation grant',async()=>{
    await adoptOutside();
    const expiresAt=new Date(Date.now()+5000).toISOString();
    await set([named('second','use',expiresAt),organisation]);
    const expected={definitionHash:outsideDefinitionHash,accessRevision:(await store.agentAccess('owner',agent.id))!.accessRevision};
    const selected=(await db.query<{id:string}>("SELECT id::text FROM resource_grants WHERE resource_id=$1 AND principal_member_id='second' AND revoked_at IS NULL ORDER BY id LIMIT 1",[agent.id])).rows[0]!;
    const writer=await db.connect();let capture:{client:PoolClient;result:Promise<import('../src/grant-store.js').OutsideUseCapture|undefined>}|undefined;
    try{
      await writer.query('BEGIN');await writer.query('SELECT id FROM resource_grants WHERE id=$1 FOR UPDATE',[selected.id]);
      capture=await beginTaggedCapture('second',expected);
      const observed=await waitForCaptureLock('SELECT id,principal_member_id,principal_organisation_id,permission');
      let expired=false;
      for(let attempt=0;attempt<800;attempt++){
        const clock=await db.query<{expired:boolean}>('SELECT $1::timestamptz<=clock_timestamp() AS expired',[expiresAt]);
        if(clock.rows[0]?.expired){expired=true;break;}
        await db.query('SELECT pg_sleep(0.01)');
      }
      await writer.query('COMMIT');
      const result=await capture.result;
      expect(observed).toBe(true);
      expect(expired).toBe(true);
      expect(result).toBeUndefined();
    }finally{
      await writer.query('ROLLBACK').catch(()=>{});writer.release();
      if(capture){await capture.result.catch(()=>undefined);await capture.client.query('ROLLBACK').catch(()=>{});capture.client.release();}
    }
  },20_000);
  it('uses only the caller connection for outside capture',async()=>{
    await adoptOutside();await set([named('second')]);
    const single=quiet(new Pool({connectionString:(db.options as {connectionString:string}).connectionString,max:1,connectionTimeoutMillis:500}));
    const client=await single.connect();await client.query('BEGIN');
    try{
      const before=(await client.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const captured=await new PgGrantStore(single).captureOutsideUse('second',agent.id,{db:client,connectionName:'mail'});
      const after=(await client.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      expect(captured?.grant.kind).toBe('grant');expect(after).toBe(before);
    }finally{await client.query('ROLLBACK');client.release();await single.end();}
  });
  it('observes outside capture lock waits and refuses snapshots changed by the writer',async()=>{
    await adoptOutside();await set([named('second')]);
    const expected=async()=>{const row=(await store.agentAccess('owner',agent.id))!;return {definitionHash:row.definitionHash,accessRevision:row.accessRevision};};
    const resolveWait=async(expectedPair:{definitionHash:string;accessRevision:number},writerSql:string,params:unknown[],fragment:string,expectedResult:unknown)=>{
      const writer=await db.connect();let pending:Awaited<ReturnType<typeof beginTaggedCapture>>|undefined;
      try{
        await writer.query('BEGIN');await writer.query(writerSql,params);
        pending=await beginTaggedCapture('second',expectedPair);
        const observed=await waitForCaptureLock(fragment);
        await writer.query('COMMIT');
        const result=await pending.result;
        expect(observed).toBe(true);
        expect(result).toEqual(expectedResult);
      }finally{
        await writer.query('ROLLBACK').catch(()=>{});writer.release();
        if(pending){await pending.result.catch(()=>undefined);await pending.client.query('ROLLBACK').catch(()=>{});pending.client.release();}
      }
    };

    const policyExpected=await expected();
    await resolveWait(policyExpected,"UPDATE org_member_policy SET allowed_capabilities=NULL WHERE user_id='owner'",[],
      'SELECT allowed_capabilities FROM org_member_policy',undefined);

    const definitionExpected=await expected();
    await resolveWait(definitionExpected,"UPDATE agent_definitions SET hash=$1 WHERE name=$2",['b'.repeat(64),agent.id],
      'SELECT hash,definition,status FROM agent_definitions',undefined);
    await db.query('UPDATE agent_definitions SET hash=$1 WHERE name=$2',[outsideDefinitionHash,agent.id]);

    const accessExpected=await expected();
    await resolveWait(accessExpected,"UPDATE agent_access SET revision=nextval('resource_access_revision_seq') WHERE agent_name=$1",[agent.id],
      'SELECT 1 FROM agent_access WHERE agent_name=$1 AND revision=$2',undefined);

    await set([named('second')]);
    const grant=(await db.query<{id:string}>("SELECT id::text FROM resource_grants WHERE resource_id=$1 AND principal_member_id='second' AND revoked_at IS NULL ORDER BY id LIMIT 1",[agent.id])).rows[0]!;
    const expectedBeforeGrantWait=await expected();
    await resolveWait(expectedBeforeGrantWait,'SELECT id FROM resource_grants WHERE id=$1 FOR UPDATE',[grant.id],
      'SELECT id,principal_member_id,principal_organisation_id,permission',
      expect.objectContaining({grant:expect.objectContaining({kind:'grant',id:grant.id,principal:{kind:'member',id:'second'}})}));
  },20_000);
  it('does not revive a captured revision after metadata deletion and explicit readoption',async()=>{
    const initial=await adopt();await db.query("DELETE FROM agent_access WHERE agent_name='assistant'");
    const adopted=await adopt();expect(adopted.accessRevision).toBeGreaterThan(initial.accessRevision);
    expect(await store.can('owner',agent,'use',{expectedRevision:initial.accessRevision})).toBe(false);
  });
  it('refuses an old capture when a policy write commits while authority waits for its row lock',async()=>{
    await adopt();const initial=await set([named('second')]);const writer=await db.connect();await writer.query('BEGIN');
    try{
      await writer.query("UPDATE org_member_policy SET allowed_capabilities=NULL WHERE user_id='owner'");
      const decision=store.can('second',agent,'use',{expectedRevision:initial.accessRevision});
      let waiting=false;
      for(let i=0;i<50;i++){
        const result=await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT allowed_capabilities%' LIMIT 1");
        if(result.rowCount){waiting=true;break;}await db.query('SELECT pg_sleep(0.01)');
      }
      expect(waiting).toBe(true);await writer.query('COMMIT');expect(await decision).toBe(false);
      expect(await store.can('second',agent,'use')).toBe(true);
    }finally{await writer.query('ROLLBACK');writer.release();}
  });
  it('preserves adoption and grant history on migration reapply',async()=>{
    const initial=await adopt();await set([named('second')]);await db.query(migration('014_agent_access_grants.sql'));
    expect(await store.can('second',agent,'use')).toBe(true);expect((await store.agentAccess('owner',agent.id))!.accessRevision).toBeGreaterThan(initial.accessRevision);
  });
});
