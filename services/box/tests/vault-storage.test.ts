import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { quiet } from './helpers/quiet-pool.js';
import { PgVaultStore } from '@lares/agent-kit/vault-area-store';
import { GuardedVaultFiles } from '@lares/agent-kit/vault-files';
import { applyVaultStorage, previewVaultStorage, verifyVaultStorage, verifyVaultStorageMetadata, VAULT_RECOVERY_SCRIPTS, VAULT_RECOVERY_UNITS, VAULT_STORAGE_PENDING, VAULT_STORAGE_INVENTORY, type VaultStorageInventory, type VaultStorageFiles } from '../lib/vault-storage.js';
let container: StartedPostgreSqlContainer, pool: Pool, stop: () => Promise<void>, prefix: string;
const helper = resolve('ops/vault-storage.sh'), uid = process.getuid!();
const options = (): VaultStorageFiles => ({ prefix, rootUid: uid, runtimeUid: uid });
const git = (root: string, ...args: string[]) => execFileSync('git', ['--literal-pathspecs', '-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const shell = (operation: string, inv: VaultStorageInventory) => execFileSync('bash', ['-c', '. "$1"; "$2" "$3" "$4"', '_', helper, operation, prefix, JSON.stringify(inv)], { stdio: 'pipe' });
function recovery() {
    mkdirSync(join(prefix, 'opt/lares'), { recursive: true });
    mkdirSync(join(prefix, 'etc/systemd/system'), { recursive: true });
    const files: Record<string, string> = {};
    for (const name of [...VAULT_RECOVERY_SCRIPTS, ...VAULT_RECOVERY_UNITS]) {
        const content = readFileSync(resolve('ops', name));
        writeFileSync(join(prefix, name.endsWith('.service') || name.endsWith('.timer') ? 'etc/systemd/system' : 'opt/lares', name), content);
        files[name] = createHash('sha256').update(content).digest('hex');
    }
    const engineImage = 'example.invalid/keeper@sha256:' + 'a'.repeat(64);
    writeFileSync(join(prefix, 'opt/lares/vault-recovery-engine-image'), engineImage + '\n');
    writeFileSync(join(prefix, 'opt/lares/vault-recovery.json'), JSON.stringify({ version: 1, engineImage, files }));
}
async function plan() { const inv = await previewVaultStorage(pool, 'owner', options()); shell('vault_storage_prepare', inv); expect(statSync(join(prefix,'srv/lares/installation')).mode & 0o777).toBe(0o750); return inv; }
async function context(a: VaultStorageInventory['areas'][number], memberId = 'owner') { const db = await pool.connect(); await db.query('BEGIN'); const revision = Number((await db.query('SELECT revision FROM vault_areas WHERE id=$1', [a.areaId])).rows[0].revision); return { db, memberId, areaId: a.areaId, expectedRevision: revision }; }
function api(inv: VaultStorageInventory) { return new GuardedVaultFiles(new PgVaultStore(), new Map([[inv.backing.id, { kind: 'git', root: join(prefix, 'srv'), areas: new Map(inv.areas.map(a => [a.areaId, { origin: join(prefix, a.origin) }])) }]])); }
beforeAll(async () => { container = await new PostgreSqlContainer('postgres:16-alpine').start(); pool = quiet(new Pool({ connectionString: container.getConnectionUri() })); stop = async () => { await pool.end(); await container.stop(); }; }, 120000);
afterAll(async () => { await stop?.(); });
beforeEach(async () => {
    prefix = realpathSync(mkdtempSync(join(tmpdir(), 'vault-provisioning-')));
    recovery();
    await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');
    await pool.query(`CREATE TABLE orgs(id text PRIMARY KEY,display_name text NOT NULL);CREATE TABLE users(id text PRIMARY KEY,display_name text NOT NULL,primary_email text,org_id text REFERENCES orgs(id),org_role text NOT NULL DEFAULT 'member',created_at timestamptz NOT NULL DEFAULT now());CREATE TABLE org_member_policy(user_id text PRIMARY KEY REFERENCES users(id),allowed_capabilities text[]);CREATE TABLE agent_definitions(name text PRIMARY KEY,hash text NOT NULL,definition jsonb NOT NULL,status text NOT NULL DEFAULT 'valid');INSERT INTO orgs VALUES('org','Example');INSERT INTO users(id,display_name,org_id,org_role) VALUES('owner','Owner','org','owner'),('second','Second','org','member');INSERT INTO org_member_policy VALUES('owner',NULL)`);
    for (const file of ['007_member_identity_sessions.sql', '009_vault_areas.sql', '013_console_turn_authority.sql', '014_agent_access_grants.sql', '020_vault_resource_grants.sql'])
        await pool.query(readFileSync(resolve('sql', file), 'utf8'));
});
afterEach(() => rmSync(prefix, { recursive: true, force: true }));
it('initializes twice without changing identity, notes, organisation settings or sharing', async () => {
    const inv = await plan();
    await applyVaultStorage(pool, 'owner', options());
    shell('vault_storage_publish', inv);
    const files = api(inv), a = inv.areas[0], ctx = await context(a);
    try {
        await files.write(ctx, { binding: { areaId: a.areaId, relativePath: 'private-canary.md', accessRevision: ctx.expectedRevision, expectedContentRevision: null, approvedOrigin: 'owner', authority: { origin: 'human', agentId: 'example-agent', turnId: 'example-turn', sessionId: 'example-session', placeId: 'example-place', audience: { placeId: 'example-place', revision: 1, participants: [{ kind: 'member', memberId: 'owner' }] }, policyRevision: 1, actingMemberId: 'owner', spokenByMemberId: 'owner' } }, frontmatter: { title: 'Private canary' }, body: '# Private canary' });
        await ctx.db.query('COMMIT');
    }
    finally {
        ctx.db.release();
    }
    const shared = inv.areas[1], store = new PgVaultStore(pool), revision = Number((await pool.query('SELECT revision FROM vault_areas WHERE id=$1', [shared.areaId])).rows[0].revision);
    await store.configureAccess('owner', { areaId: shared.areaId, expectedRevision: revision, grants: ['owner', 'second'].flatMap(id => ['use', 'edit'].map(permission => ({ principal: { kind: 'member' as const, id }, permission: permission as 'use' | 'edit', expiresAt: null }))) }, { designatedOwnerMemberId: 'owner' });
    await pool.query("UPDATE orgs SET display_name='Preserved name'");
    const grants = (await pool.query('SELECT * FROM resource_grants ORDER BY id')).rows, head = git(join(prefix, 'srv', a.relativePath), 'rev-parse', 'HEAD');
    expect(await previewVaultStorage(pool, 'owner', options())).toEqual(inv);
    expect(await applyVaultStorage(pool, 'owner', options())).toEqual(inv);
    expect((await pool.query('SELECT * FROM resource_grants ORDER BY id')).rows).toEqual(grants);
    expect((await pool.query('SELECT display_name FROM orgs')).rows[0].display_name).toBe('Preserved name');
    expect(git(join(prefix, 'srv', a.relativePath), 'rev-parse', 'HEAD')).toBe(head);
    const current = await context(a);
    try {
        expect((await files.read(current, 'private-canary.md')).content).toContain('Private canary');
        expect((await files.search(current, 'Private')).hits).toEqual(['private-canary.md']);
    }
    finally {
        await current.db.query('ROLLBACK');
        current.db.release();
    }
    const denied = await context(a, 'second');
    try {
        await expect(files.list(denied)).rejects.toThrow();
    }
    finally {
        await denied.db.query('ROLLBACK');
        denied.db.release();
    }
    expect(git(join(prefix, a.origin), 'rev-parse', 'HEAD')).toBe(head);
});
it('retains one pending identity across every persistent initialization boundary', async () => {
    const stages = ['metadata', 'receipt-working', 'receipt-bare', 'git-working', 'git-bare', 'identity', 'marker', 'commit', 'push'];
    for (const stage of stages) {
        const inv = await plan();
        let interrupted = false;
        await expect(applyVaultStorage(pool, 'owner', { ...options(), onBoundary: s => { if (!interrupted && s === stage) {
                interrupted = true;
                throw new Error('simulated interruption');
            } } })).rejects.toThrow('simulated interruption');
        expect(existsSync(join(prefix, VAULT_STORAGE_PENDING))).toBe(true);
        expect(existsSync(join(prefix, VAULT_STORAGE_INVENTORY))).toBe(false);
        expect(await previewVaultStorage(pool, 'owner', options())).toEqual(inv);
        await applyVaultStorage(pool, 'owner', options());
        shell('vault_storage_publish', inv);
        expect(await verifyVaultStorage(pool, options(), true)).toEqual(inv);
        // Each independent interruption starts from an empty disposable installation/database.
        if (stage !== stages.at(-1)) {
            await pool.query('TRUNCATE resource_grants,vault_areas,vault_backing_stores CASCADE');
            rmSync(join(prefix, 'srv'), { recursive: true });
            rmSync(join(prefix, 'var'), { recursive: true });
        }
    }
}, 90000);
it('refuses foreign paths, legacy overlap and stale recovery tooling before creating metadata', async () => {
    const inv = await plan(), root = join(prefix, 'srv', inv.areas[0].relativePath);
    writeFileSync(join(root, 'foreign.md'), 'do not adopt');
    await expect(applyVaultStorage(pool, 'owner', options())).rejects.toThrow();
    expect((await pool.query('SELECT * FROM vault_backing_stores')).rowCount).toBe(0);
    rmSync(join(root, 'foreign.md'));
    await expect(applyVaultStorage(pool, 'owner', { ...options(), legacyRoots: [join(prefix, 'srv')] })).rejects.toThrow(/overlap/);
    writeFileSync(join(prefix, 'opt/lares/backup.sh'), 'old');
    await expect(applyVaultStorage(pool, 'owner', options())).rejects.toThrow(/stale/);
    expect((await pool.query('SELECT * FROM vault_backing_stores')).rowCount).toBe(0);
});
it('refuses retired or mismatched metadata but still reconciles retained retired recovery data', async () => {
    const inv = await plan();
    await applyVaultStorage(pool, 'owner', options());
    shell('vault_storage_publish', inv);
    await pool.query("UPDATE vault_areas SET status='retired',revision=nextval('vault_access_revision_seq') WHERE id=$1", [inv.areas[0].areaId]);
    await expect(applyVaultStorage(pool, 'owner', options())).rejects.toThrow();
    await expect(verifyVaultStorage(pool, options())).resolves.toEqual(inv);
    const wrong = { ...inv, areas: inv.areas.map((a, i) => i === 0 ? { ...a, owner: { kind: 'member' as const, id: 'second' } } : a) };
    await expect(verifyVaultStorageMetadata(pool, wrong)).rejects.toThrow(/ownership/);
});
it('refuses a snapshot with retained metadata but absent inventory and a wrong configured owner', async () => {
    await expect(previewVaultStorage(pool, 'second', options())).rejects.toThrow();
    const inv = await plan();
    await applyVaultStorage(pool, 'owner', options());
    shell('vault_storage_publish', inv);
    rmSync(join(prefix, 'srv'), { recursive: true });
    rmSync(join(prefix, 'var'), { recursive: true });
    await expect(verifyVaultStorage(pool, options())).rejects.toThrow(/metadata/);
});
it('snapshots both members and bare repositories under canonical locks, then stages only verified empty target roots', async () => {
    const inv = await plan();
    await applyVaultStorage(pool, 'owner', options());
    shell('vault_storage_publish', inv);
    for (const [i, a] of inv.areas.entries())
        writeFileSync(join(prefix, 'srv', a.relativePath, 'working-only.md'), 'member canary ' + i);
    const archive = join(prefix, 'snapshot.tar');
    execFileSync('bash', ['-c', '. "$1"; vault_storage_load "$2"; vault_storage_lock; trap vault_storage_unlock EXIT; for root in "${VAULT_STORAGE_REPOSITORIES[@]}"; do test -f "$root/.git/lares-vault.lock" || exit 1; done; tar --exclude="*/.git/lares-vault.lock" -cf "$3" -C "$2" srv/vault var/lib/lares-vault-git srv/lares/installation', '_', helper, prefix, archive], { stdio: 'pipe' });
    const names = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' });
    expect(names).not.toContain('lares-vault.lock');
    const snapshot = join(prefix, 'snapshot');
    mkdirSync(snapshot);
    execFileSync('tar', ['-xf', archive, '-C', snapshot]);
    for (const [i, a] of inv.areas.entries()) {
        expect(readFileSync(join(snapshot, 'srv', a.relativePath, 'working-only.md'), 'utf8')).toBe('member canary ' + i);
        expect(git(join(snapshot, a.origin), 'fsck', '--full', '--strict')).toBe('');
        rmSync(join(prefix, 'srv', a.relativePath, 'working-only.md'));
    }
    await verifyVaultStorage(pool, options(), true);
    const staging = join(prefix, 'restore-staging');
    mkdirSync(staging);
    const result = execFileSync('bash', ['-c', '. "$1"; vault_storage_load "$2"; vault_storage_lock; vault_storage_stage_empty "$2" "$3"; vault_storage_unlock; printf interrupted', '_', helper, prefix, staging], { encoding: 'utf8' });
    expect(result).toBe('interrupted');
    expect(existsSync(join(prefix, 'srv/vault'))).toBe(false);
    expect(existsSync(join(prefix, 'var/lib/lares-vault-git'))).toBe(false);
    for (const a of inv.areas) {
        expect(existsSync(join(staging, 'target-empty-vault', a.areaId + '-working', '.lares-vault-area.json'))).toBe(true);
        expect(existsSync(join(staging, 'target-empty-vault', a.areaId + '-bare.git', 'HEAD'))).toBe(true);
        expect(existsSync(join(staging, 'target-empty-vault', a.areaId + '-working', '.git/lares-vault.lock'))).toBe(false);
    }
});
it('checks restored snapshot ownership against a real restored database before applying any target', async () => {
    const inv = await plan();
    await applyVaultStorage(pool, 'owner', options());
    shell('vault_storage_publish', inv);
    for (const [i, a] of inv.areas.entries())
        writeFileSync(join(prefix, 'srv', a.relativePath, 'retained.md'), 'retained member canary ' + i);
    const snapshot = prefix + '-snapshot';
    cpSync(prefix, snapshot, { recursive: true });
    const database = 'drill_vault_storage_snapshot';
    await pool.query('CREATE DATABASE ' + database);
    const url = new URL(container.getConnectionUri());
    url.pathname = '/' + database;
    const restored = quiet(new Pool({ connectionString: url.href }));
    try {
        const dump = execFileSync('docker', ['exec', container.getId(), 'pg_dump', '-U', container.getUsername(), '-d', container.getDatabase(), '-Fc']);
        execFileSync('docker', ['exec', '-i', container.getId(), 'pg_restore', '--exit-on-error', '--no-owner', '-U', container.getUsername(), '-d', database], { input: dump, stdio: ['pipe', 'pipe', 'pipe'] });
        expect(await verifyVaultStorage(restored, { ...options(), prefix: snapshot, originPrefix: prefix })).toEqual(inv);
        await restored.query("ALTER TABLE vault_areas DISABLE TRIGGER vault_area_guard");
        await restored.query("UPDATE vault_areas SET owner_member_id='second' WHERE id=$1", [inv.areas[0].areaId]);
        await expect(verifyVaultStorage(restored, { ...options(), prefix: snapshot, originPrefix: prefix })).rejects.toThrow(/ownership/);
        for (const [i, a] of inv.areas.entries())
            expect(readFileSync(join(snapshot, 'srv', a.relativePath, 'retained.md'), 'utf8')).toBe('retained member canary ' + i);
    }
    finally {
        await restored.end();
        await pool.query('DROP DATABASE ' + database);
        rmSync(snapshot, { recursive: true, force: true });
    }
});

it('refuses a redirected pending working repository before touching the redirected directory',async()=>{
 const inv=await plan();await expect(applyVaultStorage(pool,'owner',{...options(),onBoundary:s=>{if(s==='git-working')throw new Error('interrupted');}})).rejects.toThrow('interrupted');
 const root=join(prefix,'srv',inv.areas[0].relativePath),outside=join(prefix,'outside');mkdirSync(outside);git(root,'config','core.worktree',outside);
 await expect(previewVaultStorage(pool,'owner',options())).rejects.toThrow(/redirect/);await expect(applyVaultStorage(pool,'owner',options())).rejects.toThrow(/redirect/);expect(git(root,'config','core.worktree')).toBe(outside);expect(existsSync(join(outside,'.lares-vault-area.json'))).toBe(false);expect((await pool.query('SELECT * FROM vault_backing_stores')).rowCount).toBe(0);
});
