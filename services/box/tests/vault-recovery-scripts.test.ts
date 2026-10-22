import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { VaultStorageInventory } from '../lib/vault-storage.js';
let root: string, bin: string, env: NodeJS.ProcessEnv, inv: VaultStorageInventory;
const git = (path: string, ...args: string[]) => execFileSync('git', ['--literal-pathspecs', '-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
function stub(name: string, body: string) { writeFileSync(join(bin, name), '#!/usr/bin/env bash\nset -e\n' + body + '\n', { mode: 0o755 }); }
beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-recovery-scripts-')));
    bin = join(root, 'bin');
    mkdirSync(bin);
    for (const dir of ['ops', 'etc/lares/secrets', 'etc/lares/operator', 'srv/lares/agents', 'srv/lares/retired', 'srv/lares/installation', 'srv/taste', 'opt/lares', 'var/backups', 'export', 'tmp'])
        mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'etc/lares/operator/database-password'), 'fixture-only-operator-password\n', { mode: 0o600 });
    writeFileSync(join(root, 'srv/taste/taste.md'), 'unchanged taste canary');
    writeFileSync(join(root, 'opt/lares/compose.yaml'), 'services: {}\n');
    const ids = [randomUUID(), randomUUID()];
    inv = { version: 1, planId: randomUUID(), organisationId: 'example.invalid', provisionerMemberId: 'owner', backing: { id: randomUUID(), kind: 'git', root: '/srv' }, areas: ids.map((areaId, i) => ({ areaId, kind: i ? 'shared' : 'private', owner: { kind: i ? 'organisation' : 'member', id: i ? 'example.invalid' : 'owner' }, relativePath: 'vault/' + (i ? 'shared' : 'private') + '/' + areaId, origin: '/var/lib/lares-vault-git/' + areaId + '.git' })) };
    writeFileSync(join(root, 'srv/lares/installation/vault-storage.json'), JSON.stringify(inv));
    for (const [i, a] of inv.areas.entries()) {
        const work = join(root, 'srv', a.relativePath), bare = join(root, a.origin);
        mkdirSync(work, { recursive: true });
        execFileSync('git', ['init', '--quiet', '--initial-branch=main', work]);
        execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
        git(work, 'config', 'user.name', 'Lares Vault');
        git(work, 'config', 'user.email', 'vault@localhost');
        git(work, 'remote', 'add', 'origin', bare);
        const marker = { version: 1, areaId: a.areaId, backingStoreId: inv.backing.id, relativePath: a.relativePath, kind: a.kind, owner: a.owner }, receipt = { version: 1, planId: inv.planId, areaId: a.areaId };
        writeFileSync(join(work, '.lares-vault-area.json'), JSON.stringify(marker));
        writeFileSync(join(work, '.git/lares-provisioning.json'), JSON.stringify(receipt));
        writeFileSync(join(bare, 'lares-provisioning.json'), JSON.stringify(receipt));
        git(work, 'add', '--', '.lares-vault-area.json');
        git(work, 'commit', '-qm', 'Initialize managed Vault area');
        git(work, 'push', '-q', 'origin', 'HEAD');
        git(work, 'remote', 'set-url', 'origin', a.origin);
        writeFileSync(join(work, 'working-only.md'), 'member ' + i + ' working-only canary');
    }
    const image = 'example.invalid/keeper@sha256:' + 'a'.repeat(64);
    writeFileSync(join(root, 'opt/lares/vault-recovery-engine-image'), image);
    const verify = join(root, 'verify.mts');
    writeFileSync(verify, `import {loadVaultStorageInventory,verifyVaultStorageFiles} from ${JSON.stringify(new URL('../lib/vault-storage.ts', import.meta.url).href)};const options={prefix:process.argv[2],rootUid:process.getuid(),originPrefix:''};verifyVaultStorageFiles(loadVaultStorageInventory(options),options);`);
    stub('docker', `printf '%s\\n' "$*" >> "$DOCKER_CALLS"\ncase "$*" in *bin/vault-storage.ts*) exec "$VERIFY_RUNNER" "$VERIFY_SCRIPT" "$LARES_PREFIX";; *"config --format json"*) printf '{"services":{"db":{"image":"postgres:16-alpine"}}}\\n'; exit 0;; esac\ncase "$*" in *pg_isready*) exit 0;; *pg_dumpall*) echo '-- fixture roles';; *pg_dump*) python3 -c 'print("x"*2048)';; *psql*) printf 'lares_state\\npostgres\\n';; esac`);
    stub('stat', `python3 -c 'import os,sys;a=sys.argv[1:];print("0:600" if len(a)>2 and a[-2]=="%u:%a" and a[-1].endswith("/etc/lares/operator/database-password") else os.stat(a[-1]).st_size)' "$@"`);
    stub('restic', `python3 - <<'PYCAPTURE'\nimport os,tarfile\nr=os.environ['LARES_PREFIX']\nwith tarfile.open(r+'/backup-capture.tar','w') as t:\n for p in ['srv/vault','var/lib/lares-vault-git','srv/lares/installation','srv/taste']:\n  t.add(r+'/'+p,arcname=p,filter=lambda info:None if info.name.endswith('/.git/lares-vault.lock') else info)\nPYCAPTURE`);
    const key = join(root, 'identity');
    execFileSync('age-keygen', ['-o', key], { stdio: 'pipe' });
    const recipient = execFileSync('age-keygen', ['-y', key], { encoding: 'utf8' }).trim();
    const config = join(root, 'backup.env');
    writeFileSync(config, `LARES_CURRENT_LAYOUT=1\nRESTIC_REPOSITORY=fixture\nRESTIC_PASSWORD_FILE=/dev/null\nAGE_SECRETS_RECIPIENT=${recipient}\n`);
    env = { ...process.env, LARES_PREFIX: root, LARES_ENGINE_IMAGE: image, AGENT_BOX_BACKUP_ENV: config, AGENT_BOX_EXPORT_ENV: config, DOCKER_CALLS: join(root, 'docker-calls.log'), PATH: bin + ':' + process.env.PATH, VERIFY_RUNNER: resolve('node_modules/.bin/tsx'), VERIFY_SCRIPT: verify, EXPORT_VAULT_PATHS: '', EXPORT_DATA_PATHS: join(root, 'srv/taste'), EXPORT_DIR: join(root, 'export'), EXPORT_WORKDIR_ROOT: join(root, 'tmp'), EXPORT_COMPOSE_FILE: join(root, 'opt/lares/compose.yaml') };
    writeFileSync(env.DOCKER_CALLS!, '');
    for (const name of ['vault-storage.sh', 'engine-run.sh'])
        cpSync(resolve('ops', name), join(root, 'ops', name));
    let backup = readFileSync(resolve('ops/backup.sh'), 'utf8');
    for (const path of ['/etc/', '/opt/', '/srv/', '/var/backups/'])
        backup = backup.replaceAll(path, root + path);
    backup = backup.replace('tar -C / -cf -', `tar -C '${root}' -cf -`);
    writeFileSync(join(root, 'ops/backup.sh'), backup);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function verifyArchive(archive: string) { const folder = join(root, 'unpack-' + randomUUID()); mkdirSync(folder); execFileSync('tar', ['-xf', archive, '-C', folder]); for (const [i, a] of inv.areas.entries()) {
    expect(readFileSync(join(folder, 'srv', a.relativePath, 'working-only.md'), 'utf8')).toBe('member ' + i + ' working-only canary');
    expect(existsSync(join(folder, a.origin, 'HEAD'))).toBe(true);
    expect(existsSync(join(folder, 'srv', a.relativePath, '.git/lares-vault.lock'))).toBe(false);
} expect(readFileSync(join(folder, 'srv/taste/taste.md'), 'utf8')).toContain('taste'); }
it('backs up both full working trees, local bare repositories and inventory while preserving taste', () => { execFileSync('bash', [join(root, 'ops/backup.sh')], { env, stdio: 'pipe' }); verifyArchive(join(root, 'backup-capture.tar')); for (const a of inv.areas)
    expect(existsSync(join(root, 'srv', a.relativePath, '.git/lares-vault.lock'))).toBe(false); });
it('adds managed stores to an export even with custom data paths, including working-only content', () => {
    execFileSync('bash', [resolve('ops/export.sh')], { env, stdio: 'pipe' });
    const vaultCalls = readFileSync(env.DOCKER_CALLS!, 'utf8').split('\n').filter(line => line.includes('bin/vault-storage.ts'));
    expect(vaultCalls.some(line => line.includes(`-v ${join(root, 'etc/lares/secrets/database-password')}:${join(root, 'etc/lares/secrets/database-password')}:ro`) && line.includes('-e PGUSER=lares_app'))).toBe(true);
    expect(vaultCalls.every(line => !line.includes(`${join(root, 'etc/lares/secrets')}:${join(root, 'etc/lares/secrets')}:ro`))).toBe(true);
    const out = join(root, 'export', readdirSync(join(root, 'export'))[0]), folder = join(root, 'export-contents');
    mkdirSync(folder);
    execFileSync('tar', ['-xf', out, '-C', folder]);
    const restore = join(root, 'export-restored');
    mkdirSync(restore);
    for (const file of readdirSync(folder).filter(n => n.endsWith('.tar')))
        execFileSync('tar', ['-xf', join(folder, file), '-C', restore]);
    for (const [i, a] of inv.areas.entries()) {
        expect(readFileSync(join(restore, 'vault', a.kind, a.areaId, 'working-only.md'), 'utf8')).toBe('member ' + i + ' working-only canary');
        expect(existsSync(join(restore, 'lares-vault-git', a.areaId + '.git', 'HEAD'))).toBe(true);
        expect(existsSync(join(restore, 'vault', a.kind, a.areaId, '.git/lares-vault.lock'))).toBe(false);
    }
    expect(existsSync(join(restore, 'installation/vault-storage.json'))).toBe(true);
    expect(readFileSync(join(restore, 'taste/taste.md'), 'utf8')).toContain('taste');
});
it('refuses backup and export when any managed root is missing before producing an archive', () => {
    rmSync(join(root, inv.areas[0].origin), { recursive: true });
    for (const script of [join(root, 'ops/backup.sh'), resolve('ops/export.sh')]) {
        const r = spawnSync('bash', [script], { env, encoding: 'utf8' });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('incomplete or conflicting managed storage');
    }
    expect(existsSync(join(root, 'backup-capture.tar'))).toBe(false);
    expect(readdirSync(join(root, 'export'))).toEqual([]);
});
