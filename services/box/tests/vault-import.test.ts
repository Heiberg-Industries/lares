import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { quiet } from './helpers/quiet-pool.js';
import { applyVaultStorage, previewVaultStorage, VAULT_RECOVERY_SCRIPTS, VAULT_RECOVERY_UNITS, type VaultStorageFiles, type VaultStorageInventory } from '../lib/vault-storage.js';
import { parseImportMap, runVaultImport, type ImportOptions } from '../lib/vault-import.js';
import { main as importMain } from '../bin/vault-import.js';

let container: StartedPostgreSqlContainer, pool: Pool, prefix: string, scratch: string, inv: VaultStorageInventory;
const helper = resolve('ops/vault-storage.sh'), uid = process.getuid!();
const storage = (): VaultStorageFiles => ({ prefix, rootUid: uid, runtimeUid: uid });
const git = (root: string, ...args: string[]) => execFileSync('git', ['--literal-pathspecs', '-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const shell = (operation: string, plan: VaultStorageInventory) => execFileSync('bash', ['-c', '. "$1"; "$2" "$3" "$4"', '_', helper, operation, prefix, JSON.stringify(plan)], { stdio: 'pipe' });
const work = (kind: 'private' | 'shared') => join(prefix, 'srv', inv.areas.find(a => a.kind === kind)!.relativePath);
const bare = (kind: 'private' | 'shared') => join(prefix, inv.areas.find(a => a.kind === kind)!.origin);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80]);

function recovery() {
    mkdirSync(join(prefix, 'opt/lares'), { recursive: true });
    mkdirSync(join(prefix, 'etc/systemd/system'), { recursive: true });
    const files: Record<string, string> = {};
    for (const name of [...VAULT_RECOVERY_SCRIPTS, ...VAULT_RECOVERY_UNITS]) {
        const content = readFileSync(resolve('ops', name));
        writeFileSync(join(prefix, name.endsWith('.service') || name.endsWith('.timer') ? 'etc/systemd/system' : 'opt/lares', name), content);
        files[name] = sha(content);
    }
    const engineImage = 'example.invalid/keeper@sha256:' + 'a'.repeat(64);
    writeFileSync(join(prefix, 'opt/lares/vault-recovery-engine-image'), engineImage + '\n');
    writeFileSync(join(prefix, 'opt/lares/vault-recovery.json'), JSON.stringify({ version: 1, engineImage, files }));
}
/** Write a source folder; a string is text, a Buffer is bytes. */
function source(files: Record<string, string | Buffer>): string {
    const dir = join(scratch, 'my-old-notes');
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
    return dir;
}
const opts = (extra: Partial<ImportOptions> = {}): ImportOptions => ({ label: 'my-old-notes', map: {}, shared: [], private: [], skip: [], origin: 'synced', includeConversations: false, ...extra });
async function run(mode: 'preview' | 'apply', dir: string, extra: Partial<ImportOptions> = {}, confirm?: string) {
    const lines: string[] = [], code = await runVaultImport(pool, { mode, source: dir, options: opts(extra), confirm }, storage(), v => lines.push(v));
    const text = lines.join('\n');
    return { code, text, planId: /plan-id: ([0-9a-f]{64})/.exec(text)?.[1] };
}
async function importAll(dir: string, extra: Partial<ImportOptions> = {}) {
    const preview = await run('preview', dir, extra);
    expect(preview.planId, preview.text).toBeDefined();
    return run('apply', dir, extra, preview.planId);
}
const note = (title: string, extra = '') => `---\ntitle: ${title}\n${extra}---\nBody of ${title}\n`;
const inVault = (kind: 'private' | 'shared', path: string) => existsSync(join(work(kind), path));

beforeAll(async () => { container = await new PostgreSqlContainer('postgres:16-alpine').start(); pool = quiet(new Pool({ connectionString: container.getConnectionUri() })); }, 120000);
afterAll(async () => { await pool?.end(); await container?.stop(); });
beforeEach(async () => {
    prefix = realpathSync(mkdtempSync(join(tmpdir(), 'vault-import-')));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'vault-import-src-')));
    recovery();
    await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');
    await pool.query(`CREATE TABLE orgs(id text PRIMARY KEY,display_name text NOT NULL);CREATE TABLE users(id text PRIMARY KEY,display_name text NOT NULL,primary_email text,org_id text REFERENCES orgs(id),org_role text NOT NULL DEFAULT 'member',created_at timestamptz NOT NULL DEFAULT now());CREATE TABLE org_member_policy(user_id text PRIMARY KEY REFERENCES users(id),allowed_capabilities text[]);CREATE TABLE agent_definitions(name text PRIMARY KEY,hash text NOT NULL,definition jsonb NOT NULL,status text NOT NULL DEFAULT 'valid');INSERT INTO orgs VALUES('org','Example');INSERT INTO users(id,display_name,org_id,org_role) VALUES('owner','Owner','org','owner');INSERT INTO org_member_policy VALUES('owner',NULL)`);
    for (const file of ['007_member_identity_sessions.sql', '009_vault_areas.sql', '013_console_turn_authority.sql', '014_agent_access_grants.sql', '020_vault_resource_grants.sql'])
        await pool.query(readFileSync(resolve('sql', file), 'utf8'));
    inv = await previewVaultStorage(pool, 'owner', storage());
    shell('vault_storage_prepare', inv);
    await applyVaultStorage(pool, 'owner', storage());
    shell('vault_storage_publish', inv);
}, 120000);
afterEach(() => { rmSync(prefix, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); });

describe('mapping', () => {
    it('sends notes by map file, shorthands and scope, defaults to private, and finds them afterwards', async () => {
        const dir = source({
            'Atlas/a.md': note('alpha atlas'), 'Brain/b.md': note('bravo brain'), 'Archive/old.md': note('old archive'),
            'Loose/c.md': note('charlie loose', 'scope: org\n'), 'Loose/d.md': note('delta loose'), 'Team/e.md': note('echo team'),
            'Mine/f.md': note('foxtrot mine'),
        });
        const map = parseImportMap({ default: 'private', rules: [{ match: 'Atlas/**', area: 'shared', strip: 'Atlas/' }, { match: 'Brain/**', area: 'private', strip: 'Brain/' }, { match: 'Archive/**', skip: true }] });
        const done = await importAll(dir, { map, shared: ['Team'], private: ['Mine'] });
        expect(done.code, done.text).toBe(0);
        expect(inVault('shared', 'a.md')).toBe(true);
        expect(inVault('private', 'b.md')).toBe(true);
        expect(inVault('private', 'Archive/old.md') || inVault('shared', 'Archive/old.md')).toBe(false);
        expect(inVault('shared', 'Loose/c.md')).toBe(true);
        expect(inVault('private', 'Loose/d.md')).toBe(true);
        expect(inVault('shared', 'Team/e.md')).toBe(true);
        expect(inVault('private', 'Mine/f.md')).toBe(true);
        expect(readFileSync(join(work('shared'), 'a.md'), 'utf8')).toBe('---\nlares_origin: synced\ntitle: alpha atlas\n---\nBody of alpha atlas\n');
        expect(git(work('shared'), 'status', '--porcelain')).toBe('');
        expect(git(work('shared'), 'rev-parse', 'HEAD')).toBe(git(bare('shared'), 'rev-parse', 'refs/heads/main'));
        expect(done.text).toContain('All checks passed.');
    }, 60000);

    it('reads the map from the source folder when none is named, and the bin entry point works end to end', async () => {
        const dir = source({ 'Atlas/a.md': note('alpha'), '.lares-import.json': JSON.stringify({ rules: [{ match: 'Atlas/**', area: 'shared' }] }) });
        const lines: string[] = [], errors: string[] = [];
        const deps = { db: pool, env: {}, out: (v: string) => lines.push(v), error: (v: string) => errors.push(v), storage: { rootUid: uid, runtimeUid: uid } };
        const common = ['--source', dir, '--label', 'my-old-notes', '--prefix', prefix];
        expect(await importMain(['preview', ...common], deps)).toBe(0);
        const id = /plan-id: (\w{64})/.exec(lines.join('\n'))![1]!;
        expect(await importMain(['apply', ...common, '--confirm', id], deps)).toBe(0);
        expect(inVault('shared', 'Atlas/a.md')).toBe(true);
        expect(await importMain(['apply', ...common], deps)).toBe(64);
        expect(await importMain(['preview', ...common, '--origin', 'third_party'], deps)).toBe(64);
        expect(errors.join('\n')).toContain('--origin must be');
    }, 60000);

    it('blocks a private note headed for the shared area, and applies nothing', async () => {
        const dir = source({ 'Team/x.md': note('xray', 'scope: private\n'), 'Team/y.md': note('yankee') });
        const preview = await run('preview', dir, { shared: ['Team'] });
        expect(preview.text).toContain('THIS PLAN IS BLOCKED');
        expect(preview.text).toContain('scope conflict: Team/x.md');
        expect(preview.planId).toBeUndefined();
        const apply = await run('apply', dir, { shared: ['Team'] }, 'f'.repeat(64));
        expect(apply.code).toBe(78);
        expect(inVault('shared', 'Team/y.md')).toBe(false);
        expect((await run('preview', dir, { private: ['Team'] })).planId).toBeDefined();
    });

    it('blocks names that differ only by capitals and two sources for one target', async () => {
        const dir = source({ 'A/Note.md': note('one'), 'B/note.md': note('two'), 'Atlas/same.md': note('three'), 'same.md': note('four') });
        const caps = await run('preview', dir, { map: parseImportMap({ rules: [{ match: 'A/**', area: 'private', strip: 'A/' }, { match: 'B/**', area: 'private', strip: 'B/' }] }) });
        expect(caps.text).toContain('names differ only by capitals');
        const twin = await run('preview', dir, { map: parseImportMap({ rules: [{ match: 'Atlas/**', area: 'private', strip: 'Atlas/' }] }) });
        expect(twin.text).toContain('two sources, one target');
    });

    it('rejects a damaged map file with a plain message', () => {
        expect(() => parseImportMap({ rules: [{ match: 'x' }] })).toThrow(/needs an "area" or "skip"/);
        expect(() => parseImportMap({ surprise: 1 })).toThrow(/unknown key/);
        expect(() => parseImportMap([])).toThrow(/JSON object/);
    });
});

describe('re-running', () => {
    it('writes nothing the second time, leaves an edited note alone, and does not bring back a deleted one', async () => {
        const dir = source({ 'one.md': note('first note'), 'two.md': note('second note'), 'three.md': note('third note') });
        const first = await importAll(dir);
        expect(first.text).toContain('3 written');
        const second = await run('preview', dir);
        expect(second.text).toContain('0 to add, 3 already in the Vault');
        const head = git(work('private'), 'rev-parse', 'HEAD');
        expect((await run('apply', dir, {}, second.planId)).text).toContain('0 written');
        expect(git(work('private'), 'rev-parse', 'HEAD')).toBe(head);

        writeFileSync(join(work('private'), 'one.md'), 'owner rewrote this\n');
        git(work('private'), 'commit', '-qam', 'owner edit');
        git(work('private'), 'rm', '-q', 'two.md');
        git(work('private'), 'commit', '-qm', 'owner delete');
        git(work('private'), 'push', '-q', 'origin', 'HEAD');
        writeFileSync(join(dir, 'three.md'), note('third note', 'tags: changed\n'));
        const third = await run('preview', dir);
        expect(third.text).toContain('1 where the source is newer');
        expect(third.text).toContain('1 conflicts');
        expect(third.text).toContain('1 you deleted');
        expect(third.text).toContain('0 to add');
        expect(third.text).toContain('conflict: private/one.md (edited since it was imported)');
        const applied = await run('apply', dir, {}, third.planId);
        expect(applied.code).toBe(0);
        expect(readFileSync(join(work('private'), 'one.md'), 'utf8')).toBe('owner rewrote this\n');
        expect(inVault('private', 'two.md')).toBe(false);
        expect(readFileSync(join(work('private'), 'three.md'), 'utf8')).not.toContain('changed');
    }, 90000);

    it('treats a different note already at the path as a conflict and an identical note elsewhere as a probable duplicate', async () => {
        writeFileSync(join(work('private'), 'taken.md'), 'someone else\n');
        git(work('private'), 'add', 'taken.md');
        git(work('private'), 'commit', '-qm', 'seed');
        const dir = source({ 'taken.md': note('mine'), 'copy.md': 'duplicate text\n' });
        writeFileSync(join(work('private'), 'elsewhere.md'), 'duplicate text\n');
        git(work('private'), 'add', 'elsewhere.md');
        git(work('private'), 'commit', '-qm', 'seed2');
        const preview = await run('preview', dir);
        expect(preview.text).toContain('1 conflicts');
        expect(preview.text).toContain('1 probable duplicates');
        expect(preview.text).toContain('0 to add');
    });

    it('refuses an apply when the source changed after the preview', async () => {
        const dir = source({ 'one.md': note('first note') });
        const preview = await run('preview', dir);
        writeFileSync(join(dir, 'two.md'), note('sneaky'));
        const apply = await run('apply', dir, {}, preview.planId);
        expect(apply.code).toBe(78);
        expect(apply.text).toContain('The plan changed');
        expect(inVault('private', 'one.md')).toBe(false);
    });
});

describe('special folders and files', () => {
    it('keeps _meta/dream, skips conversations, taste and other _meta, keeps _inbox private, and brings conversations on request', async () => {
        const files = {
            '_meta/dream/2026-01-02.md': 'dream log\n', '_meta/dream/notes.md': 'not a dream day\n', '_meta/conversations/c1.md': 'chat log\n', '_meta/other.md': 'other\n',
            'taste/voice.md': 'taste\n', '_inbox/clip.md': note('clip'), 'Team/t.md': note('team note'),
        };
        const dir = source(files);
        const preview = await run('preview', dir, { shared: ['Team', '_inbox'] });
        expect(preview.text).toContain('1 taste files');
        expect(preview.text).toContain('2 other _meta files');
        expect(preview.text).toContain('1 conversation logs');
        const done = await importAll(dir, { shared: ['Team', '_inbox'] });
        expect(done.code, done.text).toBe(0);
        expect(inVault('private', '_meta/dream/2026-01-02.md')).toBe(true);
        expect(inVault('private', '_meta/dream/notes.md')).toBe(false);
        expect(inVault('private', '_meta/conversations/c1.md')).toBe(false);
        expect(inVault('private', 'taste/voice.md') || inVault('shared', 'taste/voice.md')).toBe(false);
        expect(inVault('private', '_inbox/clip.md')).toBe(true);
        expect(inVault('shared', '_inbox/clip.md')).toBe(false);
        expect(inVault('shared', 'Team/t.md')).toBe(true);
        const more = await importAll(dir, { shared: ['Team', '_inbox'], includeConversations: true });
        expect(more.code, more.text).toBe(0);
        expect(inVault('private', '_meta/conversations/c1.md')).toBe(true);
    }, 90000);

    it('copies referenced attachments byte for byte, leaves unreferenced ones, and counts everything left behind', async () => {
        const outside = join(scratch, 'outside.md');
        writeFileSync(outside, 'x');
        const dir = source({
            'Doc/a.md': note('with picture') + '![[pic.png]] and ![scan](files/scan.pdf) and [site](https://example.com/x.png)\n',
            'Doc/pic.png': PNG, 'Doc/files/scan.pdf': Buffer.from('%PDF-1.4\n\xff\xfe\n', 'latin1'), 'Doc/unused.png': PNG,
            '.obsidian/app.json': '{}', '.trash/gone.md': 'gone', 'Doc/.hidden.md': 'hidden',
            'Doc/hard.md': 'hardlink target\n',
        });
        symlinkSync(outside, join(dir, 'Doc/link.md'));
        linkSync(join(dir, 'Doc/hard.md'), join(dir, 'Doc/hard-twin.md'));
        mkdirSync(join(dir, 'Sub/repo'), { recursive: true });
        execFileSync('git', ['init', '-q', join(dir, 'Sub/repo')]);
        writeFileSync(join(dir, 'Sub/repo/inner.md'), 'inner\n');
        const preview = await run('preview', dir);
        expect(preview.text).toMatch(/3 hidden files and folders/);
        expect(preview.text).toContain('1 links');
        expect(preview.text).toContain('2 hard-linked files');
        expect(preview.text).toContain('1 folders that are their own repository');
        expect(preview.text).toContain('1 attachments no imported note refers to');
        const done = await importAll(dir);
        expect(done.code, done.text).toBe(0);
        expect(readFileSync(join(work('private'), 'Doc/pic.png')).equals(PNG)).toBe(true);
        expect(readFileSync(join(work('private'), 'Doc/files/scan.pdf')).equals(Buffer.from('%PDF-1.4\n\xff\xfe\n', 'latin1'))).toBe(true);
        expect(inVault('private', 'Doc/unused.png')).toBe(false);
        expect(inVault('private', '.obsidian/app.json')).toBe(false);
        expect(inVault('private', 'Doc/link.md')).toBe(false);
        expect(git(work('private'), 'ls-files', '--', 'Doc/pic.png')).toBe('Doc/pic.png');
    }, 60000);

    it('counts the stamps it narrowed only among notes it wrote', async () => {
        const dir = source({ 'a.md': '---\nlares_origin: owner\n---\nowned\n', 'b.md': '---\nlares_origin: third_party\n---\nforeign\n' });
        const preview = await run('preview', dir);
        expect(preview.text).toContain('1 carry a wider stamp');
        const done = await importAll(dir);
        expect(done.text).toContain('1 stamps narrowed');
        expect(readFileSync(join(work('private'), 'b.md'), 'utf8')).toContain('lares_origin: third_party');
        const again = await run('apply', dir, {}, (await run('preview', dir)).planId);
        expect(again.text).toContain('0 stamps narrowed');
    }, 60000);
});

describe('refusals', () => {
    it('refuses while the storage setup is unfinished or the Vault is missing', async () => {
        const dir = source({ 'a.md': note('a') });
        writeFileSync(join(prefix, 'srv/lares/installation/vault-storage.pending.json'), '{}');
        const pending = await importMain(['preview', '--source', dir, '--label', 'x', '--prefix', prefix], { db: pool, env: {}, out: () => undefined, error: () => undefined, storage: { rootUid: uid, runtimeUid: uid } });
        expect(pending).toBe(78);
        rmSync(join(prefix, 'srv/lares/installation/vault-storage.pending.json'));
        rmSync(join(prefix, 'srv/lares/installation/vault-storage.json'));
        const errors: string[] = [];
        const missing = await importMain(['preview', '--source', dir, '--label', 'x', '--prefix', prefix], { db: pool, env: {}, out: () => undefined, error: v => errors.push(v), storage: { rootUid: uid, runtimeUid: uid } });
        expect(missing).toBe(78);
        expect(errors.join('')).toContain('no Vault yet');
    });
});

describe('a big import', () => {
    it('brings in 2000 notes in whole chunks and still lists and searches them', async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 2000; i++) files[`Bulk/${String(i % 20).padStart(2, '0')}/n${i}.md`] = note(`bulknote${i}`);
        const dir = source(files);
        const started = Date.now();
        const done = await importAll(dir);
        const seconds = (Date.now() - started) / 1000;
        console.log(`2000-note import (scan, plan, apply, health check): ${seconds.toFixed(1)} s`);
        expect(done.code, done.text).toBe(0);
        expect(done.text).toContain('2000 written in 4 commits');
        expect(done.text).toContain('listed 2000 of 2000');
        expect(Number(git(work('private'), 'rev-list', '--count', 'HEAD'))).toBe(1 + 4);
        expect(sha(readFileSync(join(work('private'), 'Bulk/07/n1007.md')))).toBeTruthy();
    }, 600000);
});
