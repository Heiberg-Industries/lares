import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { PgGrantStore } from '../src/grant-store.js';
import { PgVaultStore } from '../src/vault-area-store.js';
import { PgMemberStore } from '../src/member-store.js';
import { quiet } from './helpers/quiet-pool.js';
const migration=(n:string)=>readFileSync(new URL(`../../../services/box/sql/${n}`,import.meta.url),'utf8');
const authority={designatedOwnerMemberId:'owner'};
const resource=(id='shared')=>({kind:'vault-area',id});
const named=(id:string,permission:'use'|'edit'='use',expiresAt:string|null=null)=>({principal:{kind:'member' as const,id},permission,expiresAt});
const organisation={principal:{kind:'organisation' as const,id:'org'},permission:'use' as const,expiresAt:null};
let db:Pool,vault:PgVaultStore,grants:PgGrantStore,stop:()=>Promise<void>;
beforeAll(async()=>{
  const container=await new PostgreSqlContainer('postgres:16-alpine').start();
  db=quiet(new Pool({connectionString:container.getConnectionUri()}));vault=new PgVaultStore(db);grants=new PgGrantStore(db);
  stop=async()=>{await db.end();await container.stop();};
},120_000);
afterAll(async()=>{await stop?.();});
beforeEach(async()=>{
  await db.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
  await db.query(`CREATE TABLE orgs(id text PRIMARY KEY,display_name text NOT NULL);
    CREATE TABLE users(id text PRIMARY KEY,display_name text NOT NULL,primary_email text,org_id text REFERENCES orgs(id),org_role text NOT NULL DEFAULT 'member',created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE org_member_policy(user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,allowed_capabilities text[]);
    CREATE TABLE agent_definitions(name text PRIMARY KEY,hash text NOT NULL,definition jsonb NOT NULL,status text NOT NULL DEFAULT 'valid');
    INSERT INTO orgs VALUES('org','Example'),('other','Other');
    INSERT INTO users(id,display_name,org_id,org_role) VALUES('owner','Owner','org','owner'),('second','Second','org','member'),('restricted','Restricted','org','restricted'),('other','Other','other','owner'),('admin','Admin','org','owner');
    INSERT INTO org_member_policy VALUES('owner',NULL);
    INSERT INTO agent_definitions(name,hash,definition) VALUES('shared','one','{"grants":[]}');`);
  // SQL009 must work before console bindings and the grant registry exist.
  for(const file of ['007_member_identity_sessions.sql','009_vault_areas.sql','013_console_turn_authority.sql','014_agent_access_grants.sql','020_vault_resource_grants.sql'])await db.query(migration(file));
  await vault.provisionBacking('owner',{id:'backing',kind:'git'},authority);
});
async function area(id='shared',kind:'private'|'shared'|'place'|'taste'='shared',owner:{kind:'member'|'organisation';id:string}={kind:'organisation',id:'org'},relativePath=id,backingStoreId='backing'){
  return vault.provisionArea('owner',{id,kind,owner,relativePath,backingStoreId},authority);
}
async function revision(areaId='shared'){return Number((await db.query('SELECT revision FROM vault_areas WHERE id=$1',[areaId])).rows[0].revision);}
async function configure(selections:Parameters<PgVaultStore['configureAccess']>[1]['grants'],areaId='shared'){
  return vault.configureAccess('owner',{areaId,expectedRevision:await revision(areaId),grants:selections},authority);
}
async function directGrant(overrides:Record<string,unknown>={}){
  const g={id:randomUUID(),resource_kind:'vault-area',resource_id:'shared',principal_member_id:'second',permission:'use',grantor_member_id:'owner',issued_access_revision:await revision(),...overrides};
  const columns=Object.keys(g);return db.query(`INSERT INTO resource_grants(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(g));
}
describe('Vault area current authority on disposable PostgreSQL',()=>{
  it('requires the designated current owner for provisioning without granting private access',async()=>{
    await expect(vault.provisionBacking('admin',{id:'denied',kind:'files'},authority)).rejects.toThrow('denied');
    await expect(vault.provisionArea('second',{id:'denied',kind:'private',owner:{kind:'member',id:'second'},backingStoreId:'backing',relativePath:'private/second'},authority)).rejects.toThrow('denied');
    const own=await area('private','private',{kind:'member',id:'second'},'private/second');
    expect(await grants.can('second',resource('private'),'use')).toBe(true);
    expect(await grants.can('second',resource('private'),'edit')).toBe(true);
    for(const actor of ['owner','admin','other'])expect(await grants.can(actor,resource('private'),'use')).toBe(false);
    expect(await grants.listVisible('owner','vault-area')).toEqual([]);
    expect(await vault.vaultAreaBinding('owner',{areaId:'private',expectedRevision:own.accessRevision,permission:'use'})).toBeUndefined();
    expect(await vault.vaultAreaBinding('second',{areaId:'private',expectedRevision:own.accessRevision,permission:'use'})).toEqual({areaId:'private',kind:'private',owner:{kind:'member',id:'second'},resource:resource('private'),backingStoreId:'backing',relativePath:'private/second',accessRevision:own.accessRevision});
    await expect(configure([named('admin')],'private')).rejects.toThrow('denied');
  });
  it('has no implicit company reads and separates named use/edit and organisation use',async()=>{
    await area();expect(await grants.can('owner',resource(),'use')).toBe(false);
    await configure([named('second'),named('restricted','edit')]);
    expect(await grants.can('second',resource(),'use')).toBe(true);expect(await grants.can('second',resource(),'edit')).toBe(false);
    expect(await grants.can('restricted',resource(),'edit')).toBe(true);expect(await grants.can('restricted',resource(),'use')).toBe(false);
    expect(await grants.can('admin',resource(),'use')).toBe(false);
    await configure([organisation]);expect(await grants.can('admin',resource(),'use')).toBe(true);expect(await grants.can('restricted',resource(),'use')).toBe(false);
    await expect(configure([{...organisation,permission:'edit'}])).rejects.toThrow('invalid');
    await expect(configure([{...organisation,principal:{kind:'place',id:'place'}}] as never)).rejects.toThrow('invalid');
    expect(await grants.can('second',resource(),'approve')).toBe(false);
    await area('place','place');expect(await grants.can('owner',resource('place'),'use')).toBe(false);
    await expect(configure([named('second')],'place')).rejects.toThrow('denied');
  });
  it('keeps can/listVisible/binding decisions aligned and list metadata redacted',async()=>{
    await area();await area('hidden');const visible=await configure([named('second','edit')]);
    const list=await grants.listVisible('second','vault-area');
    expect(list).toEqual([{resource:resource(),accessRevision:visible.accessRevision,permissions:['edit']}]);
    expect(JSON.stringify(list)).not.toMatch(/owner|backing|relative|hidden|grants/);
    for(const permission of ['use','edit'] as const){
      expect(await grants.can('second',resource(),permission)).toBe(list[0].permissions.includes(permission));
      expect(!!await vault.vaultAreaBinding('second',{areaId:'shared',expectedRevision:visible.accessRevision,permission})).toBe(list[0].permissions.includes(permission));
    }
    for(const areaId of ['shared','hidden','absent'])expect(await vault.vaultAreaBinding('other',{areaId,expectedRevision:visible.accessRevision,permission:'edit'})).toBeUndefined();
    expect(await grants.listVisible('other','vault-area')).toEqual([]);
  });
  it('refuses invalid relative paths, overlap, wrong owners/backings and a second taste home',async()=>{
    for(const path of ['','/root','a/../b','a/./b','a//b','a/','a\\b',' a','a\n'])await expect(area('invalid','shared',undefined,path)).rejects.toThrow('invalid');
    await expect(area('wrong','private',{kind:'organisation',id:'org'})).rejects.toThrow('invalid');
    await expect(area('wrong','private',{kind:'member',id:'other'})).rejects.toThrow('denied');
    await expect(area('wrong','shared',{kind:'organisation',id:'other'})).rejects.toThrow('denied');
    await vault.provisionBacking('other',{id:'other-backing',kind:'files'},{designatedOwnerMemberId:'other'});
    await expect(area('wrong','shared',undefined,'other','other-backing')).rejects.toThrow('denied');
    await area('nested','shared',undefined,'shared/notes');
    await expect(area('parent','shared',undefined,'shared')).rejects.toThrow('overlap');
    await expect(area('child','shared',undefined,'shared/notes/child')).rejects.toThrow('overlap');
    await expect(area('same','shared',undefined,'shared/notes')).rejects.toThrow('overlap');
    await area('sibling','shared',undefined,'shared/notes2');
    await area('taste','taste');await expect(area('taste-copy','taste')).rejects.toThrow('vault_one_active_taste');
    await expect(db.query("UPDATE vault_areas SET owner_member_id='owner',owner_organisation_id=NULL,revision=nextval('vault_access_revision_seq') WHERE id='nested'")).rejects.toThrow('immutable');
    await expect(db.query("UPDATE vault_backing_stores SET kind='files' WHERE id='backing'")).rejects.toThrow('immutable');
    for(const path of ['/root','a/../b','a/./b','a//b','a/','a\\b',' a'])await expect(db.query("INSERT INTO vault_areas(id,organisation_id,kind,owner_organisation_id,backing_store_id,relative_path) VALUES('invalid-direct','org','shared','org','backing',$1)",[path])).rejects.toMatchObject({code:'23514'});
  });
  it('enforces same-org grant targets and grantors even for direct writes',async()=>{
    await area();await expect(configure([named('other')])).rejects.toThrow('denied');
    await expect(configure([{...organisation,principal:{kind:'organisation',id:'other'}}])).rejects.toThrow('denied');
    await expect(directGrant({principal_member_id:'other'})).rejects.toThrow('grantee');
    await db.query("INSERT INTO users(id,display_name) VALUES('no-org','Unassigned')");
    await expect(directGrant({principal_member_id:'no-org'})).rejects.toThrow('grantee');
    await expect(directGrant({grantor_member_id:'no-org'})).rejects.toThrow('grantor');
    await expect(db.query("INSERT INTO vault_areas(id,organisation_id,kind,owner_member_id,backing_store_id,relative_path) VALUES('no-org','org','private','no-org','backing','no-org')")).rejects.toThrow('owner');
    await expect(directGrant({grantor_member_id:'other'})).rejects.toThrow('grantor');
    await expect(directGrant({grantor_member_id:'second'})).rejects.toThrow('grantor');
    await expect(directGrant({principal_member_id:null,principal_organisation_id:'other'})).rejects.toThrow('organisation');
    await expect(directGrant({issued_access_revision:1+await revision()})).rejects.toThrow('unavailable');
    await area('private','private',{kind:'member',id:'owner'});await expect(directGrant({resource_id:'private',issued_access_revision:await revision('private')})).rejects.toThrow('unavailable');
    await expect(db.query("INSERT INTO vault_areas(id,organisation_id,kind,owner_member_id,backing_store_id,relative_path) VALUES('wrong','org','private','other','backing','wrong')")).rejects.toThrow('owner');
  });
  it('preserves agent grants, isolates matching IDs and preserves cascade deletion',async()=>{
    await grants.adoptAgent('owner',{agentName:'shared',expectedDefinitionHash:'one'},authority);
    await area();await configure([named('restricted','edit')]);
    let agent=await grants.agentAccess('owner','shared');expect(agent?.grants).toEqual([]);
    await grants.updateAgentAccess('owner',{agentName:'shared',expectedRevision:agent!.accessRevision,grants:[named('second')]});
    expect(await grants.can('restricted',resource(),'edit')).toBe(true);
    expect(await grants.can('restricted',{kind:'agent',id:'shared'},'edit')).toBe(false);
    agent=await grants.agentAccess('owner','shared');expect(agent!.grants.map(g=>g.principal.id)).toEqual(['second']);
    await configure([]);expect(await grants.can('second',{kind:'agent',id:'shared'},'use')).toBe(true);
    await configure([named('restricted','edit')]);await db.query("DELETE FROM agent_definitions WHERE name='shared'");
    expect(await grants.can('restricted',resource(),'edit')).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM resource_grants WHERE resource_kind='agent'")).rows[0].n).toBe(0);
  });
  it('expires against wall clock inside an old caller-owned transaction',async()=>{
    await area();await configure([named('second','use',new Date(Date.now()+400).toISOString())]);
    const client=await db.connect();await client.query('BEGIN');
    try{
      expect(await grants.can('second',resource(),'use',{db:client})).toBe(true);
      await client.query('SELECT pg_sleep(0.5)');
      expect(await grants.can('second',resource(),'use',{db:client})).toBe(false);expect(await grants.listVisible('second','vault-area',{db:client})).toEqual([]);
    }finally{await client.query('ROLLBACK');client.release();}
    const before=await revision();await expect(configure([named('second','use',new Date(0).toISOString())])).rejects.toThrow('invalid');expect(await revision()).toBe(before);
  });
  it('retains immutable grant tombstones and never revives stale captures on regrant',async()=>{
    await area();const first=await configure([named('second')]);const removed=await configure([]);const restored=await configure([named('second')]);
    expect(restored.accessRevision).toBeGreaterThan(removed.accessRevision);
    expect(await grants.can('second',resource(),'use',{expectedRevision:first.accessRevision})).toBe(false);
    expect(await grants.can('second',resource(),'use',{expectedRevision:restored.accessRevision})).toBe(true);
    expect(await vault.vaultAreaBinding('second',{areaId:'shared',expectedRevision:first.accessRevision,permission:'use'})).toBeUndefined();
    const history=await db.query('SELECT revoked_at FROM resource_grants ORDER BY created_at');expect(history.rows).toHaveLength(2);expect(history.rows[0].revoked_at).not.toBeNull();
    await expect(db.query('UPDATE resource_grants SET revoked_at=NULL WHERE revoked_at IS NOT NULL')).rejects.toThrow('immutable');
    await expect(db.query("UPDATE resource_grants SET permission='edit' WHERE revoked_at IS NULL")).rejects.toThrow('immutable');
    await expect(vault.configureAccess('owner',{areaId:'shared',expectedRevision:first.accessRevision,grants:[]},authority)).rejects.toThrow('stale');
    const results=await Promise.allSettled([vault.configureAccess('owner',{areaId:'shared',expectedRevision:restored.accessRevision,grants:[]},authority),vault.configureAccess('owner',{areaId:'shared',expectedRevision:restored.accessRevision,grants:[named('second')]},authority)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  });
  it('invalidates on membership and preserves unrelated grants across revision changes',async()=>{
    await area();const before=await configure([named('second'),named('restricted')]);
    await new PgMemberStore(db).removeMember('owner','second');
    expect(await grants.can('second',resource(),'use')).toBe(false);expect(await grants.can('restricted',resource(),'use')).toBe(true);
    expect(await grants.can('restricted',resource(),'use',{expectedRevision:before.accessRevision})).toBe(false);
    await db.query("UPDATE users SET status='active' WHERE id='second'");expect(await grants.can('second',resource(),'use')).toBe(false);
    const current=await revision();await db.query("UPDATE users SET org_role='member' WHERE id='restricted'");
    expect(await revision()).toBeGreaterThan(current);expect(await grants.can('restricted',resource(),'use')).toBe(true);
    await configure([organisation]);await db.query("UPDATE users SET org_role='restricted' WHERE id='second'");expect(await grants.can('second',resource(),'use')).toBe(false);
    await area('private','private',{kind:'member',id:'second'});await db.query("UPDATE users SET org_id='other' WHERE id='second'");
    expect((await db.query("SELECT status FROM vault_areas WHERE id='private'")).rows[0].status).toBe('retired');
    await db.query("UPDATE users SET org_id='org' WHERE id='second'");expect(await grants.can('second',resource('private'),'use')).toBe(false);
  });
  it('invalidates a shared capture on member deletion even if the same member id is recreated',async()=>{
    await area();const before=await configure([organisation]);
    expect(await grants.can('second',resource(),'use',{expectedRevision:before.accessRevision})).toBe(true);
    const grant=(await db.query("SELECT id FROM resource_grants WHERE resource_kind='vault-area'")).rows[0].id;
    await db.query("DELETE FROM users WHERE id='second'");expect(await revision()).toBeGreaterThan(before.accessRevision);
    await db.query("INSERT INTO users(id,display_name,org_id,org_role) VALUES('second','Recreated member','org','member')");
    expect(await grants.can('second',resource(),'use')).toBe(true);
    expect(await grants.can('second',resource(),'use',{expectedRevision:before.accessRevision})).toBe(false);
    expect(await vault.vaultAreaBinding('second',{areaId:'shared',expectedRevision:before.accessRevision,permission:'use'})).toBeUndefined();
    expect((await db.query('SELECT revoked_at FROM resource_grants WHERE id=$1',[grant])).rows[0].revoked_at).toBeNull();
  });
  it('retains retired identities, prevents recreation and retires a whole backing',async()=>{
    await area();const current=await configure([named('second')]);await vault.retireArea('owner',{areaId:'shared',expectedRevision:current.accessRevision},authority);
    expect(await grants.can('second',resource(),'use')).toBe(false);await expect(area()).rejects.toThrow('stale');
    await expect(db.query("DELETE FROM vault_areas WHERE id='shared'")).rejects.toThrow('retire');
    await expect(db.query("UPDATE vault_areas SET status='active',revision=nextval('vault_access_revision_seq') WHERE id='shared'")).rejects.toThrow('immutable');
    await area('private','private',{kind:'member',id:'second'});await vault.retireBacking('owner','backing',authority);
    expect(await grants.can('second',resource('private'),'use')).toBe(false);expect(await grants.listVisible('second','vault-area')).toEqual([]);
    await expect(vault.provisionBacking('owner',{id:'backing',kind:'git'},authority)).rejects.toThrow('stale');
  });
  it('uses a single pool connection and holds authority locks through caller use',async()=>{
    await area();const current=await configure([named('second')]);
    const single=quiet(new Pool({connectionString:db.options.connectionString,max:1,connectionTimeoutMillis:300})),client=await single.connect();
    await client.query('BEGIN');
    try{
      expect(await new PgGrantStore(single).can('second',resource(),'use',{db:client})).toBe(true);
      expect(await new PgGrantStore(single).listVisible('second','vault-area',{db:client})).toHaveLength(1);
      expect(await new PgVaultStore(single).vaultAreaBinding('second',{areaId:'shared',expectedRevision:current.accessRevision,permission:'use'},{db:client})).toBeDefined();
      const writer=await db.connect();try{
        await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'");
        await expect(writer.query("UPDATE vault_areas SET revision=nextval('vault_access_revision_seq') WHERE id='shared'")).rejects.toMatchObject({code:'55P03'});
      }finally{await writer.query('ROLLBACK');writer.release();}
    }finally{await client.query('ROLLBACK');client.release();await single.end();}
  });
  it('reuses a caller transaction for provisioning, grant replacement and retirement',async()=>{
    const single=quiet(new Pool({connectionString:db.options.connectionString,max:1,connectionTimeoutMillis:300})),client=await single.connect();
    await client.query('BEGIN');
    try{
      const owned=new PgVaultStore(single),options={...authority,db:client};
      await owned.provisionBacking('owner',{id:'single',kind:'files'},options);
      const initial=await owned.provisionArea('owner',{id:'single-area',kind:'shared',owner:{kind:'organisation',id:'org'},backingStoreId:'single',relativePath:'shared'},options);
      const granted=await owned.configureAccess('owner',{areaId:'single-area',expectedRevision:initial.accessRevision,grants:[named('second')]},options);
      expect(await new PgGrantStore(single).can('second',resource('single-area'),'use',{db:client})).toBe(true);
      await owned.retireArea('owner',{areaId:'single-area',expectedRevision:granted.accessRevision},options);
      await owned.retireBacking('owner','single',options);
      expect(await new PgGrantStore(single).can('second',resource('single-area'),'use',{db:client})).toBe(false);
    }finally{await client.query('ROLLBACK');client.release();await single.end();}
    expect((await db.query("SELECT 1 FROM vault_backing_stores WHERE id='single'")).rowCount).toBe(0);
  });
  it('rechecks expected revisions after waiting for a backing lock',async()=>{
    await area();const initial=await configure([named('second')]),writer=await db.connect();await writer.query('BEGIN');
    let decision:Promise<boolean>|undefined;
    try{
      await writer.query("SELECT id FROM vault_backing_stores WHERE id='backing' FOR UPDATE");
      decision=grants.can('second',resource(),'use',{expectedRevision:initial.accessRevision});
      let waiting=false;
      for(let i=0;i<50;i++){
        const result=await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT 1 FROM vault_backing_stores%' LIMIT 1");
        if(result.rowCount){waiting=true;break;}await db.query('SELECT pg_sleep(0.01)');
      }
      expect(waiting).toBe(true);
      // Skip metadata's org lock only for this artificial lock-wait fixture; its revision
      // update normally occurs after the org mutation lock and cannot race this reader.
      await writer.query('ALTER TABLE vault_areas DISABLE TRIGGER vault_area_guard');
      await writer.query("UPDATE vault_areas SET revision=nextval('vault_access_revision_seq') WHERE id='shared'");
      await writer.query('ALTER TABLE vault_areas ENABLE TRIGGER vault_area_guard');
      await writer.query('COMMIT');expect(await decision).toBe(false);
    }finally{await writer.query('ROLLBACK');writer.release();if(decision)await decision;}
  });
  it('refuses unexpected constraint or derived-target shapes without rebuilding history',async()=>{
    await area();await configure([named('second')]);
    await db.query('ALTER TABLE resource_grants DROP CONSTRAINT resource_grants_resource_kind_check;ALTER TABLE resource_grants ADD CONSTRAINT resource_grants_resource_kind_check CHECK (true)');
    await expect(db.query(migration('020_vault_resource_grants.sql'))).rejects.toThrow('Unexpected resource kind');await db.query('ROLLBACK');
    expect(await grants.can('second',resource(),'use')).toBe(true);
    await db.query("ALTER TABLE resource_grants DROP CONSTRAINT resource_grants_resource_kind_check;ALTER TABLE resource_grants ADD CONSTRAINT resource_grants_resource_kind_check CHECK (resource_kind IN ('agent','vault-area'));ALTER TABLE resource_grants ALTER COLUMN vault_area_id DROP EXPRESSION");
    await expect(db.query(migration('020_vault_resource_grants.sql'))).rejects.toThrow('Unexpected resource target columns');await db.query('ROLLBACK');
    expect((await db.query('SELECT count(*)::int AS n FROM resource_grants')).rows[0].n).toBe(1);
  });
  it('checks expiry again after a matching grant lock waits',async()=>{
    await area();await configure([named('second','use',new Date(Date.now()+400).toISOString())]);
    const writer=await db.connect();await writer.query('BEGIN');let decision:Promise<boolean>|undefined;
    try{
      await writer.query('SELECT id FROM resource_grants FOR UPDATE');decision=grants.can('second',resource(),'use');
      let waiting=false;
      for(let i=0;i<40;i++){
        const result=await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM resource_grants%' LIMIT 1");
        if(result.rowCount){waiting=true;break;}await db.query('SELECT pg_sleep(0.01)');
      }
      expect(waiting).toBe(true);await writer.query('SELECT pg_sleep(0.5)');await writer.query('COMMIT');expect(await decision).toBe(false);
    }finally{await writer.query('ROLLBACK');writer.release();if(decision)await decision;}
  });
  it('proves generated NEW target columns are absent before update and replays SQL014/020 safely',async()=>{
    await area();await configure([named('second')]);
    await db.query(`CREATE TABLE generated_observation(value text);
      CREATE FUNCTION observe_generated_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO generated_observation VALUES(NEW.vault_area_id);RETURN NEW;END $$;
      CREATE TRIGGER observe_generated BEFORE UPDATE ON resource_grants FOR EACH ROW EXECUTE FUNCTION observe_generated_target();`);
    await db.query(migration('009_vault_areas.sql'));await db.query(migration('014_agent_access_grants.sql'));await db.query(migration('020_vault_resource_grants.sql'));
    expect(await grants.can('second',resource(),'use')).toBe(true);
    await configure([]);expect((await db.query('SELECT value FROM generated_observation')).rows).toEqual([{value:null}]);
    await configure([named('second')]);await db.query(migration('014_agent_access_grants.sql'));await configure([]);
    await expect(db.query("INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,permission,grantor_member_id,issued_access_revision) VALUES($1,'agent','missing','second','use','owner',1)",[randomUUID()])).rejects.toMatchObject({code:'23503'});
  });
});
