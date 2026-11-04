import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { quiet } from './helpers/quiet-pool.js';
import { afterAll, beforeAll, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { deployedToolsFor } from '@lares/agent-kit/persona';
import { registerDefinitionActions } from '../lib/definitions.js';
import { resetActions, runAction } from '../lib/actions.js';

// `definition.import` is the host command that brings an existing agent folder onto this
// installation. It must be the console's create, not a second copy of it.
type AnyMock = Mock<(...args: any[]) => any>;
const repo = resolve('../..');
const role = 'creative';
const GOOD = { ...JSON.parse(readFileSync(join(repo, 'packages/agent-kit/templates/creative/agent.json'), 'utf8')), name: 'bookkeeper', role, model: 'test-writer' };
let container: StartedPostgreSqlContainer, pool: Pool, root: string, agentsDir: string, retiredDir: string, secretsDir: string;
let backup: { commit: AnyMock }, compose: { stop: AnyMock; create: AnyMock };
const ctx = () => ({ actor: 'owner@example.com', audit: vi.fn(async (_record: unknown) => { }) });
const save = (name = 'bookkeeper', extra = {}) => ({ name, definition: { ...GOOD, name }, duties: 'Books.\n', voice: 'Dry.\n', ...extra });
const create = (name = 'bookkeeper', extra = {}) => runAction('definition.create', { ...save(name, extra), startingPoint: role }, ctx());
const hostImport = (name = 'bookkeeper', extra = {}) => runAction('definition.import', save(name, extra), ctx(), { host: true });
function register(ceiling = 2) {
    resetActions();
    registerDefinitionActions({ pool, agentsDir, retiredDir, secretsDir, ceiling: async () => ceiling, memory: () => 0, compose, backup,
        roleInfo: (r) => ({ roleMd: readFileSync(join(repo, 'packages/agent-kit/templates', r, 'role.md'), 'utf8'), deployedTools: deployedToolsFor(join(repo, 'services', r)) }),
    });
}
const filesOf = (name = 'bookkeeper') => ['agent.json', 'duties.md', 'voice.md'].map(n => [n, readFileSync(join(agentsDir, name, n), 'utf8')]);
const rowOf = async (name = 'bookkeeper') => (await pool.query('SELECT definition,hash,status FROM agent_definitions WHERE name=$1', [name])).rows[0];
function nothingWritten(name = 'bookkeeper') {
    expect(existsSync(join(agentsDir, name))).toBe(false);
    expect(readdirSync(agentsDir)).toEqual([]);
    expect(compose.create).not.toHaveBeenCalled();
}
beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
    await pool.query(readFileSync(join(repo, 'services/box/sql', '001_baseline.sql'), 'utf8'));
    for (const migration of ['007_member_identity_sessions.sql', '013_console_turn_authority.sql', '014_agent_access_grants.sql'])
        await pool.query(readFileSync(join(repo, 'services/box/sql', migration), 'utf8'));
});
afterAll(async () => { await pool?.end(); await container?.stop(); if (root)
    rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
    if (root)
        rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'keeper-import-'));
    [agentsDir, retiredDir, secretsDir] = ['agents', 'retired', 'secrets'].map(n => { const d = join(root, n); mkdirSync(d); return d; });
    await pool.query('DELETE FROM agent_access; DELETE FROM member_sessions; DELETE FROM agent_definitions; TRUNCATE agent_resources, agent_avatars, agent_doors');
    backup = { commit: vi.fn(async () => { }) };
    compose = { stop: vi.fn(async () => { }), create: vi.fn(async () => { }) };
    register();
});

it('creates the agent exactly as a console create would: same files, same row, same hash, same provisioning', async () => {
    const viaImport: any = await hostImport();
    const importedFiles = filesOf(), importedRow = await rowOf(), importCalls = compose.create.mock.calls.slice();
    rmSync(join(agentsDir, 'bookkeeper'), { recursive: true });
    await pool.query("DELETE FROM agent_doors WHERE agent='bookkeeper'; DELETE FROM agent_definitions WHERE name='bookkeeper'");
    compose.create.mockClear();
    const viaConsole: any = await create();
    expect(viaConsole.hash).toBe(viaImport.hash);
    expect(filesOf()).toEqual(importedFiles);
    expect(await rowOf()).toEqual(importedRow);
    expect(importedRow.status).toBe('valid');
    expect(compose.create.mock.calls).toEqual(importCalls);
    expect(importCalls).toHaveLength(1);
    expect(backup.commit).toHaveBeenCalledTimes(2);
});
it('is reachable only from the host command', async () => {
    await expect(runAction('definition.import', save(), ctx())).rejects.toThrow('reachable only from the host command');
    nothingWritten();
});
it('refuses a skill that would widen what the agent may do', async () => {
    const definition = { ...GOOD, skills: [{ name: 'signals', requires: [{ capability: 'signals', scope: 'read' }] }] };
    await expect(hostImport('bookkeeper', { definition })).rejects.toThrow(/skills-within-grants/);
    nothingWritten();
});
it('refuses a name that is already taken and leaves the first agent as it was', async () => {
    await hostImport();
    const before = filesOf();
    compose.create.mockClear();
    await expect(hostImport('bookkeeper', { duties: 'Other.\n' })).rejects.toThrow('name already exists');
    expect(filesOf()).toEqual(before);
    expect(compose.create).not.toHaveBeenCalled();
});
it('refuses past the agent limit with the existing sentence', async () => {
    register(1);
    await hostImport('first');
    compose.create.mockClear();
    await expect(hostImport('second')).rejects.toThrow("this box's agent limit is 1; the installation owner can raise it in Settings → Agents after reviewing the RAM estimate, or retire an agent");
    expect(existsSync(join(agentsDir, 'second'))).toBe(false);
    expect(compose.create).not.toHaveBeenCalled();
});
it('refuses an unknown role, and names a retired role plainly', async () => {
    await expect(hostImport('bookkeeper', { definition: { ...GOOD, role: 'assistant' } })).rejects.toThrow('role must be chief-of-staff or creative');
    await expect(hostImport('bookkeeper', { definition: { ...GOOD, role: 'travel' } })).rejects.toThrow('"travel" is a role this version of Lares no longer runs');
    nothingWritten();
});
it('refuses a malformed agent.json, a missing duties or voice, and a name that does not match', async () => {
    for (const definition of [null, 'text', [], {}, { ...GOOD, grants: 'all' }, { ...GOOD, surprise: true }])
        await expect(hostImport('bookkeeper', { definition })).rejects.toThrow();
    await expect(runAction('definition.import', { name: 'bookkeeper', definition: GOOD, voice: 'Dry.\n' }, ctx(), { host: true })).rejects.toThrow('invalid input');
    await expect(runAction('definition.import', { name: 'bookkeeper', definition: GOOD, duties: 'Books.\n' }, ctx(), { host: true })).rejects.toThrow('invalid input');
    await expect(hostImport('other', { definition: GOOD })).rejects.toThrow('name');
    nothingWritten();
});
it('reads no door token from the folder: a door that needs one is refused until its token is in the secrets folder', async () => {
    const definition = { ...GOOD, doors: [{ kind: 'telegram', enabled: true }] };
    await expect(hostImport('bookkeeper', { definition })).rejects.toThrow(/door-secret/);
    nothingWritten();
    writeFileSync(join(secretsDir, 'bookkeeper-telegram-token'), '1:token', { mode: 0o600 });
    writeFileSync(join(secretsDir, 'bookkeeper-telegram-webhook-secret'), 'hook', { mode: 0o600 });
    await expect(hostImport('bookkeeper', { definition })).resolves.toBeTruthy();
});
