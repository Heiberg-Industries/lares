import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { PgGrantStore } from '../src/grant-store.js';
import { PgMemberStore } from '../src/member-store.js';
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
    await new PgMemberStore(db).removeMember('owner','second');
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
