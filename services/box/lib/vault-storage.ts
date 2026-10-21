/** Explicit managed private/shared storage provisioning. No runtime mounts, tools, taste
 * adoption, import or erasure. Root owns the immutable pending plan and final inventory;
 * initialization runs as the fixed runtime uid after complete recovery tooling is installed. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { PgVaultStore } from '@lares/agent-kit/vault-area-store';
import { currentMember } from '@lares/agent-kit/member-store';
import { GuardedVaultFiles, VAULT_AREA_MARKER, vaultAreaInitializationSchema, type VaultFilesBackings } from '@lares/agent-kit/vault-files';
import { runVaultGit } from '@lares/agent-kit/vault-git';
export const VAULT_STORAGE_INVENTORY = '/srv/lares/installation/vault-storage.json';
export const VAULT_STORAGE_PENDING = '/srv/lares/installation/vault-storage.pending.json';
export const VAULT_WORKING_ROOT = '/srv/vault';
export const VAULT_BARE_ROOT = '/var/lib/lares-vault-git';
export const VAULT_RECOVERY_SCRIPTS = ['backup.sh', 'export.sh', 'restore.sh', 'backup-verify.sh', 'restore-drill.sh', 'setup-backups.sh', 'vault-storage.sh', 'engine-run.sh', 'refresh-recovery.sh'] as const;
export const VAULT_RECOVERY_UNITS = ['lares-backup.service', 'lares-backup.timer', 'lares-backup-verify.service', 'lares-backup-verify.timer', 'lares-restore-drill.service', 'lares-restore-drill.timer'] as const;
export interface ManagedVaultArea {
    areaId: string;
    kind: 'private' | 'shared';
    owner: {
        kind: 'member' | 'organisation';
        id: string;
    };
    relativePath: string;
    origin: string;
}
export interface VaultStorageInventory {
    version: 1;
    planId: string;
    organisationId: string;
    provisionerMemberId: string;
    backing: {
        id: string;
        kind: 'git';
        root: '/srv';
    };
    areas: ManagedVaultArea[];
}
export interface VaultStorageFiles {
    prefix?: string; /** Expected origin prefix, separate from a snapshot's physical scratch location. */
    originPrefix?: string;
    rootUid?: number;
    runtimeUid?: number;
    legacyRoots?: readonly string[]; /** Test-only interruption observation, never accepted by the CLI. */
    onBoundary?: (stage: string) => void;
}
export class VaultStorageError extends Error {
    constructor(message = 'managed storage is incomplete or conflicting; review the pending plan before retrying') { super(`Vault storage refused: ${message}`); this.name = 'VaultStorageError'; }
}
const opaque = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
function object(v: unknown, keys: string[]): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== keys.sort().join())
    throw new VaultStorageError(); return v as Record<string, unknown>; }
export function parseVaultStorageInventory(value: unknown): VaultStorageInventory {
    const v = object(value, ['version', 'planId', 'organisationId', 'provisionerMemberId', 'backing', 'areas']);
    const backing = object(v.backing, ['id', 'kind', 'root']);
    if (v.version !== 1 || !opaque(v.planId) || !id(v.organisationId) || !id(v.provisionerMemberId) || !opaque(backing.id) || backing.kind !== 'git' || backing.root !== '/srv' || !Array.isArray(v.areas) || !v.areas.length)
        throw new VaultStorageError();
    const seen = new Set<string>();
    for (const item of v.areas) {
        const a = object(item, ['areaId', 'kind', 'owner', 'relativePath', 'origin']), owner = object(a.owner, ['kind', 'id']);
        if (!opaque(a.areaId) || seen.has(a.areaId) || (a.kind !== 'private' && a.kind !== 'shared') || !id(owner.id) || owner.kind !== (a.kind === 'private' ? 'member' : 'organisation') || (a.kind === 'shared' && owner.id !== v.organisationId) || a.relativePath !== `vault/${a.kind}/${a.areaId}` || a.origin !== `${VAULT_BARE_ROOT}/${a.areaId}.git`)
            throw new VaultStorageError();
        seen.add(a.areaId);
    }
    return value as VaultStorageInventory;
}
const physical = (path: string, options: VaultStorageFiles = {}) => join(options.prefix ? resolve(options.prefix) : '/', path);
const originUrl = (a: ManagedVaultArea, options: VaultStorageFiles) => physical(a.origin, { prefix: options.originPrefix ?? options.prefix });
function safeAncestors(path: string): void { let cursor = resolve(path); for (;;) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
        throw new VaultStorageError();
    const parent = dirname(cursor);
    if (parent === cursor)
        return;
    cursor = parent;
} }
function directory(path: string): void { safeAncestors(path); if (!lstatSync(path).isDirectory())
    throw new VaultStorageError(); }
function regular(path: string, uid?: number): void { safeAncestors(path); const st = lstatSync(path); if (!st.isFile() || st.nlink !== 1 || (uid !== undefined && st.uid !== uid))
    throw new VaultStorageError(); }
function readJson(path: string, uid?: number): unknown { regular(path, uid); try {
    return JSON.parse(readFileSync(path, 'utf8'));
}
catch {
    throw new VaultStorageError();
} }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function marker(inv: VaultStorageInventory, a: ManagedVaultArea) { return vaultAreaInitializationSchema.parse({ version: 1, areaId: a.areaId, backingStoreId: inv.backing.id, relativePath: a.relativePath, kind: a.kind, owner: a.owner }); }
const work = (a: ManagedVaultArea, options: VaultStorageFiles) => physical('/srv/' + a.relativePath, options);
function receipt(inv: VaultStorageInventory, a: ManagedVaultArea) { return { version: 1, planId: inv.planId, areaId: a.areaId }; }
const receiptName = 'lares-provisioning.json';
function git(root: string, args: string[]): string { return runVaultGit(root, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args]).trim(); }
/** A portable inventory's logical paths are never rewritten to inspect a scratch snapshot. */
export function loadVaultStorageInventory(options: VaultStorageFiles = {}, pending = false): VaultStorageInventory {
    return parseVaultStorageInventory(readJson(physical(pending ? VAULT_STORAGE_PENDING : VAULT_STORAGE_INVENTORY, options), options.rootUid ?? 0));
}
export function requireVaultRecoveryTooling(options: VaultStorageFiles = {}): void {
    const manifest = object(readJson(physical('/opt/lares/vault-recovery.json', options), options.rootUid ?? 0), ['version', 'engineImage', 'files']);
    const enginePath = physical('/opt/lares/vault-recovery-engine-image', options);
    regular(enginePath, options.rootUid ?? 0);
    if (typeof manifest.engineImage !== 'string' || !/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(manifest.engineImage) || readFileSync(enginePath, 'utf8').trim() !== manifest.engineImage)
        throw new VaultStorageError();
    if (manifest.version !== 1)
        throw new VaultStorageError('complete installed recovery tooling is required before initialization');
    const names = [...VAULT_RECOVERY_SCRIPTS, ...VAULT_RECOVERY_UNITS], files = object(manifest.files, [...names]);
    for (const name of names) {
        const path = physical((name.endsWith('.service') || name.endsWith('.timer') ? '/etc/systemd/system/' : '/opt/lares/') + name, options);
        regular(path, options.rootUid ?? 0);
        if (createHash('sha256').update(readFileSync(path)).digest('hex') !== files[name])
            throw new VaultStorageError('installed recovery tooling is stale or incomplete');
    }
}
function allowedRoots(inv: VaultStorageInventory, options: VaultStorageFiles, partial = false): void {
    for (const root of [VAULT_WORKING_ROOT, VAULT_BARE_ROOT]) {
        const path = physical(root, options);
        safeAncestors(path);
        if (existsSync(path))
            directory(path);
        else if (!partial)
            throw new VaultStorageError();
    }
    const kinds = ['private', 'shared'] as const, expected = new Set(inv.areas.map(a => a.areaId + '.git'));
    const bare = physical(VAULT_BARE_ROOT, options);
    if (existsSync(bare) && readdirSync(bare).some(n => !expected.has(n)))
        throw new VaultStorageError('unclassified repository under the managed bare root');
    const root = physical(VAULT_WORKING_ROOT, options);
    if (existsSync(root) && readdirSync(root).some(n => !kinds.includes(n as typeof kinds[number])))
        throw new VaultStorageError();
    for (const kind of kinds) {
        const path = physical(VAULT_WORKING_ROOT + '/' + kind, options), ids = new Set(inv.areas.filter(a => a.kind === kind).map(a => a.areaId));
        if (!existsSync(path)) {
            if (!partial)
                throw new VaultStorageError();
            continue;
        }
        directory(path);
        if (readdirSync(path).some(n => !ids.has(n)))
            throw new VaultStorageError('unclassified content under the managed working root');
    }
}
function noRedirects(root: string): void {
    directory(root);
    for (const name of readdirSync(root)) {
        const path = join(root, name), st = lstatSync(path);
        if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
            throw new VaultStorageError();
        if (st.isDirectory())
            noRedirects(path);
    }
}
function repoFiles(inv: VaultStorageInventory, a: ManagedVaultArea, options: VaultStorageFiles): void {
    const root = work(a, options), bare = physical(a.origin, options);
    noRedirects(root);
    noRedirects(bare);
    directory(join(root, '.git'));
    regular(join(root, VAULT_AREA_MARKER));
    if (options.runtimeUid !== undefined && [root, bare].some(path => lstatSync(path).uid !== options.runtimeUid))
        throw new VaultStorageError('prepared repository owner differs');
    if (!same(vaultAreaInitializationSchema.parse(readJson(join(root, VAULT_AREA_MARKER))), marker(inv, a)))
        throw new VaultStorageError();
    if (git(root, ['rev-parse', '--show-toplevel']) !== realpathSync(root) || git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== realpathSync(join(root, '.git')) || git(bare, ['rev-parse', '--is-bare-repository']) !== 'true' || git(bare, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== realpathSync(bare))
        throw new VaultStorageError();
    for (const repo of [join(root, '.git'), bare])
        if (existsSync(join(repo, 'objects/info/alternates')))
            throw new VaultStorageError();
    for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']])
        if (git(root, args) !== originUrl(a, options))
            throw new VaultStorageError('repository origin differs from its inventory');
    if (git(root, ['config', '--local', 'user.name']) !== 'Lares Vault' || git(root, ['config', '--local', 'user.email']) !== 'vault@localhost')
        throw new VaultStorageError('repository local identity differs');
    git(root, ['fsck', '--full', '--strict']);
    git(bare, ['fsck', '--full', '--strict']);
    for (const repo of [root, bare]) {
        let committed: unknown;
        try {
            committed = JSON.parse(git(repo, ['show', 'HEAD:' + VAULT_AREA_MARKER]));
        }
        catch {
            throw new VaultStorageError();
        }
        if (!same(vaultAreaInitializationSchema.parse(committed), marker(inv, a)))
            throw new VaultStorageError('committed initialization identity differs');
    }
    const head = git(root, ['rev-parse', 'HEAD']), remote = git(bare, ['rev-parse', 'HEAD']);
    try {
        git(root, ['merge-base', '--is-ancestor', remote, head]);
    }
    catch {
        throw new VaultStorageError('working and local bare histories diverge');
    }
    for (const repo of [join(root, '.git'), bare])
        if (!same(readJson(join(repo, receiptName)), receipt(inv, a)))
            throw new VaultStorageError();
}
export function verifyVaultStorageFiles(inv: VaultStorageInventory, options: VaultStorageFiles = {}): void { parseVaultStorageInventory(inv); allowedRoots(inv, options); for (const a of inv.areas)
    repoFiles(inv, a, options); }
/** Recovery reconciles retained identities, including retired/unauthorized areas. Current
 * grants never decide whether retained data belongs in a backup. */
export async function verifyVaultStorageMetadata(db: Pick<PoolClient, 'query'>, inv: VaultStorageInventory, active = false): Promise<void> {
    const backing = (await db.query('SELECT id,organisation_id,kind,status FROM vault_backing_stores WHERE id=$1', [inv.backing.id])).rows[0];
    if (!backing || backing.organisation_id !== inv.organisationId || backing.kind !== 'git' || (active && backing.status !== 'active'))
        throw new VaultStorageError();
    const rows = (await db.query('SELECT * FROM vault_areas WHERE backing_store_id=$1 ORDER BY id', [inv.backing.id])).rows;
    if (rows.length !== inv.areas.length)
        throw new VaultStorageError('database and storage inventory contain different areas');
    for (const a of inv.areas) {
        const row = rows.find(r => r.id === a.areaId);
        if (!row || row.organisation_id !== inv.organisationId || row.kind !== a.kind || row.relative_path !== a.relativePath || row.backing_store_id !== inv.backing.id || row.owner_member_id !== (a.owner.kind === 'member' ? a.owner.id : null) || row.owner_organisation_id !== (a.owner.kind === 'organisation' ? a.owner.id : null) || (active && row.status !== 'active'))
            throw new VaultStorageError('database ownership and stored markers disagree');
    }
}
export function assertEmptyVaultStorage(inv: VaultStorageInventory, options: VaultStorageFiles = {}): void {
    verifyVaultStorageFiles(inv, options);
    for (const a of inv.areas) {
        const root = work(a, options), bare = physical(a.origin, options);
        if (readdirSync(root).sort().join() !== ['.git', VAULT_AREA_MARKER].sort().join() || git(root, ['status', '--porcelain', '--untracked-files=all']) || git(root, ['rev-list', '--count', '--all']) !== '1' || git(root, ['ls-tree', '-r', '--name-only', 'HEAD']) !== VAULT_AREA_MARKER)
            throw new VaultStorageError('restore preparation requires untouched empty managed stores; export existing notes first');
        for (const repo of [root, bare]) {
            const refs = git(repo, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean);
            if (refs.sort().join() !== (repo === root ? ['refs/heads/main', 'refs/remotes/origin/main'] : ['refs/heads/main']).sort().join() || git(repo, ['fsck', '--full', '--no-reflogs', '--unreachable']) !== '')
                throw new VaultStorageError('restore preparation found extra repository references');
        }
    }
}
async function transaction<T>(pool: Pick<Pool, 'connect'>, fn: (db: PoolClient) => Promise<T>): Promise<T> { const db = await pool.connect(); try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('lares-vault-storage'))");
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
}
catch (e) {
    try {
        await db.query('ROLLBACK');
    }
    catch { }
    throw e;
}
finally {
    db.release();
} }
async function provisioner(db: PoolClient, memberId: string) { const before = await currentMember(db, memberId); if (!before)
    throw new VaultStorageError('the configured owner is not a current organisation owner'); await db.query('SELECT id FROM orgs WHERE id=$1 FOR UPDATE', [before.organisationId]); const member = await currentMember(db, memberId, { lock: 'share' }); if (!member || member.role !== 'owner' || member.organisationId !== before.organisationId)
    throw new VaultStorageError(); return member; }
function requireDisjointLegacyRoots(options: VaultStorageFiles): void {
    const managed = [physical(VAULT_WORKING_ROOT, options), physical(VAULT_BARE_ROOT, options)];
    for (const path of options.legacyRoots ?? []) {
        if (!path.startsWith('/') || resolve(path) !== path)
            throw new VaultStorageError();
        safeAncestors(path);
        const actual = existsSync(path) ? realpathSync(path) : path;
        if (managed.some(root => actual === root || actual.startsWith(root + '/') || root.startsWith(actual.endsWith('/') ? actual : actual + '/')))
            throw new VaultStorageError('legacy runtime mounts overlap guarded storage; no store was initialized');
    }
}
function preflightArea(inv: VaultStorageInventory, a: ManagedVaultArea, options: VaultStorageFiles, ready: boolean): void {
    for (const [path, isBare] of [[work(a, options), false], [physical(a.origin, options), true]] as const) {
        safeAncestors(path);
        if (!existsSync(path)) {
            if (ready)
                throw new VaultStorageError();
            continue;
        }
        directory(path);
        const entries = readdirSync(path);
        if (!entries.length) {
            if (ready)
                throw new VaultStorageError();
            continue;
        }
        const gitDir = isBare ? path : join(path, '.git');
        directory(gitDir);
        const receiptFile = join(gitDir, receiptName);
        if (!existsSync(receiptFile)) {
            if (!isBare && entries.length === 1 && entries[0] === '.git' && readdirSync(gitDir).length === 0 && !ready)
                continue;
            throw new VaultStorageError('foreign nonempty storage cannot be adopted');
        }
        if (!same(readJson(receiptFile), receipt(inv, a)))
            throw new VaultStorageError('pending plan identity differs from existing artifacts');
        noRedirects(path);
        if (existsSync(join(gitDir, 'objects/info/alternates')))
            throw new VaultStorageError();
        if (!isBare && existsSync(join(path, VAULT_AREA_MARKER)) && !same(vaultAreaInitializationSchema.parse(readJson(join(path, VAULT_AREA_MARKER))), marker(inv, a)))
            throw new VaultStorageError();
        if (!ready) {
            const allowed = new Set(['HEAD', 'config', 'description', 'hooks', 'info', 'objects', 'refs', 'packed-refs', receiptName, 'COMMIT_EDITMSG', 'index', 'logs', 'branches']);
            if (readdirSync(gitDir).some(n => !allowed.has(n)))
                throw new VaultStorageError();
            const hooks = join(gitDir, 'hooks');
            if (existsSync(hooks) && readdirSync(hooks).some(n => !n.endsWith('.sample')))
                throw new VaultStorageError();
            if (!isBare && entries.some(n => n !== '.git' && n !== VAULT_AREA_MARKER))
                throw new VaultStorageError();
            if (existsSync(join(gitDir, 'config'))) {
                if (!isBare) {
                    for (const [key, wanted] of [['remote.origin.url', originUrl(a, options)], ['remote.origin.pushurl', originUrl(a, options)], ['user.name', 'Lares Vault'], ['user.email', 'vault@localhost']]) {
                        let value = '';
                        try {
                            value = git(path, ['config', '--local', '--get-all', key]);
                        }
                        catch { }
                        if (value && value !== wanted)
                            throw new VaultStorageError('pending repository configuration conflicts');
                    }
                }
                if (git(path, ['config', '--local', '--get', 'core.bare']) !== (isBare ? 'true' : 'false'))
                    throw new VaultStorageError();
            }
            if (existsSync(join(gitDir, 'HEAD'))) {
                if (git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== realpathSync(gitDir) || (!isBare && git(path, ['rev-parse', '--show-toplevel']) !== realpathSync(path)))
                    throw new VaultStorageError('pending repository redirects outside its planned root');
                if (git(isBare ? path : work(a, options), ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean).some(n => n !== 'refs/heads/main' && (isBare || n !== 'refs/remotes/origin/main')))
                    throw new VaultStorageError();
                if (git(path, ['fsck', '--full', '--no-reflogs', '--unreachable']))
                    throw new VaultStorageError();
                const count = git(path, ['rev-list', '--count', '--all']);
                if (count !== '1' && count !== '0')
                    throw new VaultStorageError();
                if (count === '1' && git(path, ['ls-tree', '-r', '--name-only', 'HEAD']) !== VAULT_AREA_MARKER)
                    throw new VaultStorageError();
                if (!isBare && git(path, ['diff', '--name-only', '--cached']).split('\n').filter(Boolean).some(n => n !== VAULT_AREA_MARKER))
                    throw new VaultStorageError();
            }
        }
    }
}
export async function previewVaultStorage(pool: Pick<Pool, 'connect'>, memberId: string, options: VaultStorageFiles = {}): Promise<VaultStorageInventory> {
    requireDisjointLegacyRoots(options);
    return transaction(pool, async (db) => {
        const member = await provisioner(db, memberId);
        const ready = existsSync(physical(VAULT_STORAGE_INVENTORY, options)), pending = existsSync(physical(VAULT_STORAGE_PENDING, options));
        if (ready && pending && !same(loadVaultStorageInventory(options), loadVaultStorageInventory(options, true)))
            throw new VaultStorageError();
        let inv: VaultStorageInventory;
        if (ready || pending)
            inv = loadVaultStorageInventory(options, !ready);
        else {
            if ((await db.query('SELECT 1 FROM vault_backing_stores LIMIT 1')).rowCount || existsSync(physical(VAULT_WORKING_ROOT, options)) || existsSync(physical(VAULT_BARE_ROOT, options)))
                throw new VaultStorageError('existing storage requires explicit reconciliation; no adoption was performed');
            const areas = ([['private', { kind: 'member', id: member.id }], ['shared', { kind: 'organisation', id: member.organisationId }]] as const).map(([kind, owner]) => { const areaId = randomUUID(); return { areaId, kind, owner, relativePath: `vault/${kind}/${areaId}`, origin: `${VAULT_BARE_ROOT}/${areaId}.git` }; });
            inv = { version: 1, planId: randomUUID(), organisationId: member.organisationId, provisionerMemberId: member.id, backing: { id: randomUUID(), kind: 'git', root: '/srv' }, areas };
        }
        if (inv.organisationId !== member.organisationId || inv.provisionerMemberId !== member.id)
            throw new VaultStorageError('pending or completed ownership differs from this installer');
        allowedRoots(inv, options, true);
        for (const a of inv.areas)
            preflightArea(inv, a, options, ready);
        if (ready) {
            verifyVaultStorageFiles(inv, options);
            await verifyVaultStorageMetadata(db, inv, true);
        }
        return inv;
    });
}
function initializeArea(inv: VaultStorageInventory, a: ManagedVaultArea, options: VaultStorageFiles): void {
    const root = work(a, options), bare = physical(a.origin, options);
    for (const path of [root, bare]) {
        directory(path);
        if (lstatSync(path).uid !== (options.runtimeUid ?? 10001))
            throw new VaultStorageError('prepared directory owner differs');
    }
    for (const path of [join(root, '.git'), bare]) {
        if (!existsSync(path))
            mkdirSync(path, { mode: 0o700 });
        const file = join(path, receiptName);
        if (!existsSync(file))
            writeFileSync(file, JSON.stringify(receipt(inv, a)) + '\n', { flag: 'wx', mode: 0o600 });
        options.onBoundary?.(path === bare ? 'receipt-bare' : 'receipt-working');
    }
    git(root, ['init', '--quiet', '--initial-branch=main']);
    options.onBoundary?.('git-working');
    git(bare, ['init', '--quiet', '--bare', '--initial-branch=main']);
    options.onBoundary?.('git-bare');
    git(root, ['config', '--local', 'user.name', 'Lares Vault']);
    git(root, ['config', '--local', 'user.email', 'vault@localhost']);
    let configured: string;
    try {
        configured = git(root, ['config', '--local', '--get', 'remote.origin.url']);
    }
    catch {
        configured = '';
    }
    options.onBoundary?.('identity');
    if (configured && configured !== originUrl(a, options))
        throw new VaultStorageError('conflicting local origin');
    if (!configured)
        git(root, ['remote', 'add', 'origin', originUrl(a, options)]);
    const file = join(root, VAULT_AREA_MARKER);
    if (!existsSync(file))
        writeFileSync(file, JSON.stringify(marker(inv, a)) + '\n', { flag: 'wx', mode: 0o600 });
    else if (!same(vaultAreaInitializationSchema.parse(readJson(file)), marker(inv, a)))
        throw new VaultStorageError();
    let hasHead = false;
    try {
        git(root, ['rev-parse', '--verify', 'HEAD']);
        hasHead = true;
    }
    catch { }
    options.onBoundary?.('marker');
    if (!hasHead) {
        git(root, ['add', '--', VAULT_AREA_MARKER]);
        git(root, ['commit', '--quiet', '-m', 'Initialize managed Vault area', '--', VAULT_AREA_MARKER]);
    }
    options.onBoundary?.('commit');
    if (git(root, ['status', '--porcelain', '--untracked-files=all']))
        throw new VaultStorageError('partial initialization contains unexpected files');
    git(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
    options.onBoundary?.('push');
}
export async function applyVaultStorage(pool: Pick<Pool, 'connect'>, memberId: string, options: VaultStorageFiles = {}): Promise<VaultStorageInventory> {
    requireVaultRecoveryTooling(options);
    requireDisjointLegacyRoots(options);
    return transaction(pool, async (db) => {
        const member = await provisioner(db, memberId), ready = existsSync(physical(VAULT_STORAGE_INVENTORY, options)), inv = loadVaultStorageInventory(options, !ready);
        if (inv.provisionerMemberId !== member.id || inv.organisationId !== member.organisationId)
            throw new VaultStorageError();
        allowedRoots(inv, options, true);
        for (const a of inv.areas)
            preflightArea(inv, a, options, ready);
        const store = new PgVaultStore(), authority = { designatedOwnerMemberId: member.id, db };
        const backing = (await db.query('SELECT * FROM vault_backing_stores WHERE id=$1', [inv.backing.id])).rows[0];
        if (backing) {
            if (backing.status !== 'active' || backing.kind !== 'git' || backing.organisation_id !== inv.organisationId)
                throw new VaultStorageError();
        }
        else
            await store.provisionBacking(member.id, { id: inv.backing.id, kind: 'git' }, authority);
        for (const a of inv.areas) {
            const existing = (await db.query('SELECT * FROM vault_areas WHERE id=$1', [a.areaId])).rows[0];
            if (!existing) {
                const created = await store.provisionArea(member.id, { id: a.areaId, kind: a.kind, owner: a.owner, backingStoreId: inv.backing.id, relativePath: a.relativePath }, authority);
                if (a.kind === 'shared')
                    await store.configureAccess(member.id, { areaId: a.areaId, expectedRevision: created.accessRevision, grants: ['use', 'edit'].map(permission => ({ principal: { kind: 'member' as const, id: member.id }, permission: permission as 'use' | 'edit', expiresAt: null })) }, authority);
            }
        }
        await verifyVaultStorageMetadata(db, inv, true);
        options.onBoundary?.('metadata');
        if (!ready)
            for (const a of inv.areas)
                initializeArea(inv, a, options);
        verifyVaultStorageFiles(inv, options);
        if (!ready)
            assertEmptyVaultStorage(inv, options);
        const backings: VaultFilesBackings = new Map([[inv.backing.id, { kind: 'git', root: physical('/srv', options), areas: new Map(inv.areas.map(a => [a.areaId, { origin: physical(a.origin, options) }])) }]]), files = new GuardedVaultFiles(store, backings);
        for (const a of inv.areas) {
            const row = (await db.query('SELECT revision FROM vault_areas WHERE id=$1', [a.areaId])).rows[0];
            const ctx = { memberId: member.id, areaId: a.areaId, expectedRevision: Number(row.revision), db };
            await files.list(ctx);
            await files.search(ctx, 'initialization-verification');
        }
        return inv;
    });
}
export async function verifyVaultStorage(pool: Pick<Pool, 'connect'>, options: VaultStorageFiles = {}, empty = false): Promise<VaultStorageInventory | undefined> {
    if (!existsSync(physical(VAULT_STORAGE_INVENTORY, options))) {
        if ([VAULT_WORKING_ROOT, VAULT_BARE_ROOT, VAULT_STORAGE_PENDING].some(p => existsSync(physical(p, options))))
            throw new VaultStorageError();
        return transaction(pool, async (db) => {
            const tables = (await db.query("SELECT to_regclass('vault_areas') AS areas,to_regclass('vault_backing_stores') AS backings")).rows[0];
            for (const [name, present] of [['vault_areas', tables.areas], ['vault_backing_stores', tables.backings]] as const)
                if (present && (await db.query('SELECT 1 FROM ' + name + ' LIMIT 1')).rowCount)
                    throw new VaultStorageError('retained Vault metadata has no storage inventory');
            return undefined;
        });
    }
    const inv = loadVaultStorageInventory(options);
    if (empty)
        assertEmptyVaultStorage(inv, options);
    else
        verifyVaultStorageFiles(inv, options);
    return transaction(pool, async (db) => { await verifyVaultStorageMetadata(db, inv); return inv; });
}
