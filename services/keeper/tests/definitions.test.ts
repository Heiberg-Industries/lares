import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, symlinkSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { loadDefinition } from '@lares/agent-kit/definition';
import { deployedToolsFor } from '@lares/agent-kit/persona';
import { registerDefinitionActions } from '../lib/definitions.js';
import { resetActions, runAction } from '../lib/actions.js';
const repo = resolve('../..');
const role = 'creative';
const GOOD = { ...JSON.parse(readFileSync(join(repo, 'packages/agent-kit/templates/creative/agent.json'), 'utf8')), name: 'bookkeeper', role, model: 'test-writer' };
let container: StartedPostgreSqlContainer, pool: Pool, root: string, agentsDir: string, retiredDir: string, secretsDir: string;
let backup: {
    commit: ReturnType<typeof vi.fn>;
}, compose: {
    stop: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    prepareSecretChange?:ReturnType<typeof vi.fn>;secretChanged?:ReturnType<typeof vi.fn>;
    ownedSecrets?:ReturnType<typeof vi.fn>;
};
const ctx = () => ({ actor: 'owner@example.com', audit: vi.fn(async (_record: unknown) => { }) });
const save = (name = 'bookkeeper', extra = {}) => ({ name, definition: { ...GOOD, name }, duties: 'Books.\n', voice: 'Dry.\n', ...extra });
const create = (name = 'bookkeeper', extra = {}) => runAction('definition.create', { ...save(name, extra), startingPoint: role }, ctx());
function register(ceiling = 2, storage = true) {
    resetActions();
    registerDefinitionActions({ pool, agentsDir, retiredDir, secretsDir, ceiling: async () => ceiling, compose, backup,
        roleInfo: (r) => ({ roleMd: readFileSync(join(repo, 'packages/agent-kit/templates', r, 'role.md'), 'utf8'), deployedTools: deployedToolsFor(join(repo, 'services', r)) }),
        storage: storage ? { prepareDelete: async (name) => ({ delete: async () => { await pool.query('DELETE FROM owned_memory WHERE agent=$1', [name]); } }) } : undefined,
    });
}
beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    for (const f of ['039_agent_definitions.sql', '040_keeper.sql', '041_definition_retirement.sql'])
        await pool.query(readFileSync(join(repo, 'services/box/sql', f), 'utf8'));
    await pool.query('CREATE TABLE owned_memory(agent text, value text); CREATE TABLE standing_facts(user_id text, fact text)');
});
afterAll(async () => { await pool?.end(); await container?.stop(); if (root)
    rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
    if (root)
        rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'keeper-definitions-'));
    [agentsDir, retiredDir, secretsDir] = ['agents', 'retired', 'secrets'].map(n => { const d = join(root, n); mkdirSync(d); return d; });
    await pool.query('TRUNCATE agent_definitions, agent_doors, owned_memory, standing_facts');
    backup = { commit: vi.fn(async () => { }) };
    compose = { stop: vi.fn(async () => { }), create: vi.fn(async () => { }),prepareSecretChange:vi.fn(async()=>{}),secretChanged:vi.fn(async()=>{}) };
    register();
});
it('creates, saves coherent files without changing the mounted root inode, and records hash evidence', async () => {
    await create();
    const inode = lstatSync(join(agentsDir, 'bookkeeper')).ino;
    const c = ctx();
    const result: any = await runAction('definition.save', save('bookkeeper', { duties: 'New duties' }), c);
    const loaded = await loadDefinition({ serviceDir: 'unused', env: { LARES_DEFINITION_DIR: join(agentsDir, 'bookkeeper') } });
    expect(loaded.dutiesMd).toBe('New duties');
    expect(loaded.hash).toBe(result.hash);
    expect(readFileSync(join(agentsDir, 'bookkeeper', 'voice.md'), 'utf8')).toBe('Dry.\n');
    expect(lstatSync(join(agentsDir, 'bookkeeper')).ino).toBe(inode);
    expect((await pool.query('SELECT hash,status FROM agent_definitions')).rows).toEqual([{ hash: loaded.hash, status: 'valid' }]);
    expect(c.audit.mock.calls.at(-1)?.[0]).toMatchObject({ outcome: 'ok', detail: JSON.stringify({ hash: loaded.hash }) });
    expect(backup.commit).toHaveBeenCalledTimes(2);
});
it('refuses all findings before writes, enforces matching slug, and save cannot bypass creation', async () => {
    await expect(runAction('definition.save', save(), ctx())).rejects.toThrow('create');
    await expect(create('bookkeeper', { definition: { ...GOOD, model: 'raw', doors: [{ kind: 'telegram', enabled: true }] } })).rejects.toThrow(/model-alias[\s\S]*door-secret/);
    expect(existsSync(join(agentsDir, 'bookkeeper'))).toBe(false);
    expect(backup.commit).not.toHaveBeenCalled();
    for (const name of ['../escape', 'Book Keeper', 'a/b', ''])
        await expect(create(name)).rejects.toThrow();
    await expect(create('other', { definition: GOOD })).rejects.toThrow('name');
    await expect(create('bookkeeper', { definition: { ...GOOD, duties: '../secret' } })).rejects.toThrow('duties');
    await expect(create('bookkeeper', { definition: { ...GOOD, doors: [{ kind: 'telegram', enabled: false }] } })).resolves.toBeTruthy();
});
it('serializes ceiling races across separate registration instances and refuses host overrides', async () => {
    register(1);
    const first = create('first');
    register(1);
    const second = create('second');
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(readdirSync(agentsDir).filter(n => !n.startsWith('.'))).toHaveLength(1);
    await expect(runAction('definition.create', { ...save('third'), startingPoint: role }, ctx(), { host: true })).rejects.toThrow('this box holds 1 agents; retire one or move to a larger server');
    await expect(runAction('definition.create', { ...save('third'), startingPoint: role, force: true }, ctx())).rejects.toThrow();
});
it('retirement preserves seeded owned/shared rows; deletion removes only owned memory with confirmation', async () => {
    await create();
    compose.ownedSecrets=vi.fn(()=>['bookkeeper-gateway-key']);
    writeFileSync(join(secretsDir,'bookkeeper-gateway-key'),'sk-test-agent-key-only');
    await pool.query("INSERT INTO owned_memory VALUES ('bookkeeper','mine'),('another','theirs'); INSERT INTO standing_facts VALUES ('owner','shared')");
    await runAction('definition.retire', { name: 'bookkeeper' }, ctx());
    expect(compose.stop).toHaveBeenCalledWith('bookkeeper');
    expect(existsSync(join(agentsDir, 'bookkeeper'))).toBe(false);
    expect((await pool.query('SELECT * FROM owned_memory ORDER BY agent')).rows).toEqual([{ agent: 'another', value: 'theirs' }, { agent: 'bookkeeper', value: 'mine' }]);
    const row = (await pool.query('SELECT status,retired_folder FROM agent_definitions')).rows[0];
    expect(row.status).toBe('retired');
    expect(existsSync(join(retiredDir, row.retired_folder))).toBe(true);
    await expect(runAction('definition.delete', { name: 'bookkeeper' }, ctx())).rejects.toThrow();
    register(2, false);
    await expect(runAction('definition.delete', { name: 'bookkeeper', confirm: true }, ctx())).rejects.toThrow('ownership');
    expect(existsSync(join(retiredDir, row.retired_folder))).toBe(true);
    register();
    await runAction('definition.delete', { name: 'bookkeeper', confirm: true }, ctx());
    expect((await pool.query('SELECT * FROM owned_memory')).rows).toEqual([{ agent: 'another', value: 'theirs' }]);
    expect((await pool.query('SELECT * FROM standing_facts')).rows).toEqual([{ user_id: 'owner', fact: 'shared' }]);
    expect(existsSync(join(retiredDir, row.retired_folder))).toBe(false);
    expect(existsSync(join(secretsDir,'bookkeeper-gateway-key'))).toBe(false);
    await create();
    await runAction('definition.retire', { name: 'bookkeeper' }, ctx());
    expect((await pool.query('SELECT retired_folder FROM agent_definitions')).rows[0].retired_folder).not.toBe(row.retired_folder);
});
it('creates, saves and retires locally when optional Git backup is disabled', async () => {
    backup.commit.mockResolvedValue('disabled');
    const disabled={ok:false,status:'disabled',message:'Git backup is not enabled.'};
    expect(await create()).toMatchObject({backup:disabled});
    expect(compose.create).toHaveBeenCalled();
    expect(await runAction('definition.save',save('bookkeeper',{duties:'Local edit'}),ctx())).toMatchObject({backup:disabled});
    expect(readFileSync(join(agentsDir,'bookkeeper','duties.md'),'utf8')).toBe('Local edit');
    expect(await runAction('definition.retire',{name:'bookkeeper'},ctx())).toMatchObject({status:'retired',backup:disabled});
    const row=(await pool.query('SELECT retired_folder FROM agent_definitions')).rows[0];
    expect(readFileSync(join(retiredDir,row.retired_folder,'duties.md'),'utf8')).toBe('Local edit');
});
it('keeps a successful save if backup fails, and scrubs connected secrets', async () => {
    backup.commit.mockRejectedValueOnce(new Error('remote failure'));
    expect(await create()).toMatchObject({ backup: { ok: false, status: 'failed' } });
    const c = ctx();
    await runAction('door.connect', { name: 'bookkeeper', kind: 'slack', secret: 'xoxb-test', signingSecret:'a'.repeat(32) }, c);
    const file = join(secretsDir, 'bookkeeper-slack-token');
    expect(readFileSync(file, 'utf8')).toBe('xoxb-test');
    expect(readFileSync(join(secretsDir,'bookkeeper-slack-signing-secret'),'utf8')).toBe('a'.repeat(32));
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(c.audit.mock.calls)).not.toContain('xoxb-test');
    expect((await pool.query('SELECT secret_set_at FROM agent_doors')).rows[0].secret_set_at).toBeTruthy();
});
it('refuses symlinks before publication or credential writes', async () => {
    symlinkSync(retiredDir, join(agentsDir, 'bookkeeper'));
    await expect(create()).rejects.toThrow();
    expect(readdirSync(retiredDir)).toEqual([]);
    rmSync(join(agentsDir, 'bookkeeper'), { recursive: true });
    await create();
    const target = join(root, 'untouched');
    writeFileSync(target, 'original');
    symlinkSync(target, join(secretsDir, 'bookkeeper-telegram-token'));
    await expect(runAction('door.connect', { name: 'bookkeeper', kind: 'telegram', secret: 'secret' }, ctx())).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('original');
});
it('refuses zero/unmeasured capacity and missing lifecycle provisioning before any files or backup', async () => {
    for (const ceiling of [0, NaN]) {
        register(ceiling);
        await expect(create()).rejects.toThrow();
        expect(readdirSync(agentsDir)).toEqual([]);
    }
    register();
    delete (compose as {
        create?: unknown;
    }).create;
    await expect(create()).rejects.toThrow('lifecycle provisioning');
    expect(readdirSync(agentsDir)).toEqual([]);
    expect(backup.commit).not.toHaveBeenCalled();
});
it('lists active and retired folders and reads a valid atomic hand edit through get', async () => {
    await create();
    const path = join(agentsDir, 'bookkeeper', 'voice.md');
    rmSync(path);
    writeFileSync(path, 'Atomic edit');
    expect(await runAction('definition.get', { name: 'bookkeeper' }, ctx())).toMatchObject({ voice: 'Atomic edit' });
    const listed: any = await runAction('definition.list', {}, ctx());
    expect(listed[0]).toMatchObject({ name: 'bookkeeper', status: 'valid' });
    await runAction('definition.retire', { name: 'bookkeeper' }, ctx());
    expect((await runAction('definition.list', {}, ctx()) as any[])[0].status).toBe('retired');
    await expect(create()).rejects.toThrow('already exists');
});
it('enforces capacity across two independent keeper processes sharing the database', async () => {
    register(1);
    const {execFile} = await import('node:child_process');
    const {promisify} = await import('node:util');
    const execute = promisify(execFile);
    const module = new URL('../lib/definitions.ts', import.meta.url).href;
    const actions = new URL('../lib/actions.ts', import.meta.url).href;
    const run = (name: string) => {
        const script = `import {Pool} from 'pg';import {registerDefinitionActions} from ${JSON.stringify(module)};import {runAction} from ${JSON.stringify(actions)};
          const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,application_name:'keeper-capacity-test'});
          registerDefinitionActions({pool,agentsDir:${JSON.stringify(agentsDir)},retiredDir:${JSON.stringify(retiredDir)},secretsDir:${JSON.stringify(secretsDir)},ceiling:async()=>1,
          compose:{stop:async()=>{},create:async()=>{}},backup:{commit:async()=>{}},roleInfo:()=>(${JSON.stringify({roleMd:readFileSync(join(repo,'packages/agent-kit/templates/creative/role.md'),'utf8'),deployedTools:deployedToolsFor(join(repo,'services/creative'))})})});
          try{await runAction('definition.create',${JSON.stringify({...save(name),startingPoint:role})},{actor:'test',audit:async()=>{}});console.log('created');}
          catch{console.log('refused');}finally{await pool.end();}`;
        return execute(process.execPath, ['--import','tsx','--input-type=module','-e',script], {env:{...process.env,TEST_DATABASE_URL:container.getConnectionUri()},timeout:10000});
    };
    const blocker = await pool.connect();
    await blocker.query('SELECT pg_advisory_lock(1279349317,12)');
    const children = [run('first'),run('second')];
    let waiting = 0;
    try {
        const deadline=Date.now()+5000;
        while(Date.now()<deadline){
            waiting=(await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='keeper-capacity-test' AND wait_event='advisory'")).rows[0].n;
            if(waiting===2)break;await new Promise(r=>setTimeout(r,25));
        }
    }finally{await blocker.query('SELECT pg_advisory_unlock(1279349317,12)');blocker.release();}
    const results=await Promise.all(children);
    expect(waiting).toBe(2);
    expect(results.map(r=>r.stdout.trim()).sort()).toEqual(['created','refused']);
    expect(readdirSync(agentsDir).filter(n=>!n.startsWith('.'))).toHaveLength(1);
},15000);
it('reports unconfigured capacity distinctly from zero without blocking existing saves', async () => {
 register(); await create();
 register(NaN);
 expect(await runAction('definition.capacity',{},ctx())).toEqual({ceiling:null,activeCount:1,approved:false,creationAvailable:false});
 await expect(runAction('definition.save',save(),ctx())).resolves.toBeTruthy();
 register(0);
 expect(await runAction('definition.capacity',{},ctx())).toEqual({ceiling:0,activeCount:1,approved:true,creationAvailable:false});
});
it('rejects stale reconciliation hashes before lifecycle side effects',async()=>{
 await create(); const reconcile=vi.fn(async()=>({pending:false}));Object.assign(compose,{reconcile});register();
 await expect(runAction('definition.reconcile',{name:'bookkeeper',hash:'0'.repeat(64)},ctx())).rejects.toThrow('changed');expect(reconcile).not.toHaveBeenCalled();
 const loaded=await loadDefinition({serviceDir:'unused',env:{LARES_DEFINITION_DIR:join(agentsDir,'bookkeeper')}});
 await expect(runAction('definition.reconcile',{name:'bookkeeper',hash:loaded.hash},ctx())).resolves.toEqual({pending:false});expect(reconcile).toHaveBeenCalledTimes(1);
});
it('reports post-publication door hook errors as failed partial outcomes, never effect-free refusals',async()=>{
 await create();
 const {KeeperRefusedError}=await import('../lib/actions.js');
 Object.assign(compose,{prepareSecretChange:async()=>{},secretChanged:async()=>{},status:async()=>{throw new KeeperRefusedError('runtime precondition changed');}});
 register();const c=ctx();
 await expect(runAction('door.connect',{name:'bookkeeper',kind:'slack',secret:'xoxb-saved-token',signingSecret:'a'.repeat(32)},c)).rejects.toThrow();
 expect(readFileSync(join(secretsDir,'bookkeeper-slack-token'),'utf8')).toBe('xoxb-saved-token');
 expect((await pool.query("SELECT secret_set_at FROM agent_doors WHERE agent='bookkeeper' AND kind='slack'")).rows[0].secret_set_at).toBeTruthy();
 expect(c.audit.mock.calls.at(-1)?.[0]).toMatchObject({outcome:'failed'});
});
