import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { assertEmptyVaultStorage, parseVaultStorageInventory, requireVaultRecoveryTooling, verifyVaultStorageFiles, VAULT_RECOVERY_SCRIPTS, VAULT_RECOVERY_UNITS, VAULT_STORAGE_INVENTORY, type VaultStorageInventory } from '../lib/vault-storage.js';
let prefix: string, inventory: VaultStorageInventory;
const git = (path: string, ...args: string[]) => execFileSync('git', ['--literal-pathspecs', '-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
beforeEach(() => {
    prefix = realpathSync(mkdtempSync(join(tmpdir(), 'vault-storage-files-')));
    const backingId = randomUUID(), privateId = randomUUID(), sharedId = randomUUID();
    inventory = { version: 1, planId: randomUUID(), organisationId: 'org.example.invalid', provisionerMemberId: 'owner', backing: { id: backingId, kind: 'git', root: '/srv' }, areas: [
            { areaId: privateId, kind: 'private', owner: { kind: 'member', id: 'owner' }, relativePath: 'vault/private/' + privateId, origin: '/var/lib/lares-vault-git/' + privateId + '.git' },
            { areaId: sharedId, kind: 'shared', owner: { kind: 'organisation', id: 'org.example.invalid' }, relativePath: 'vault/shared/' + sharedId, origin: '/var/lib/lares-vault-git/' + sharedId + '.git' }
        ] };
});
afterEach(() => rmSync(prefix, { recursive: true, force: true }));
function files(logicalOrigins = false) {
    mkdirSync(join(prefix, 'srv/lares/installation'), { recursive: true });
    writeFileSync(join(prefix, VAULT_STORAGE_INVENTORY), JSON.stringify(inventory));
    for (const a of inventory.areas) {
        const root = join(prefix, 'srv', a.relativePath), bare = join(prefix, a.origin);
        mkdirSync(root, { recursive: true });
        execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
        execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
        git(root, 'config', '--local', 'user.name', 'Lares Vault');
        git(root, 'config', '--local', 'user.email', 'vault@localhost');
        git(root, 'remote', 'add', 'origin', bare);
        const receipt = JSON.stringify({ version: 1, planId: inventory.planId, areaId: a.areaId });
        writeFileSync(join(root, '.git/lares-provisioning.json'), receipt);
        writeFileSync(join(bare, 'lares-provisioning.json'), receipt);
        writeFileSync(join(root, '.lares-vault-area.json'), JSON.stringify({ version: 1, areaId: a.areaId, backingStoreId: inventory.backing.id, relativePath: a.relativePath, kind: a.kind, owner: a.owner }));
        git(root, 'add', '--', '.lares-vault-area.json');
        git(root, 'commit', '-qm', 'Initialize managed Vault area');
        git(root, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
        if (logicalOrigins)
            git(root, 'remote', 'set-url', 'origin', a.origin);
    }
}
it('accepts only the portable fixed-layout inventory and never accepts caller paths', () => {
    expect(parseVaultStorageInventory(inventory)).toBe(inventory);
    for (const patch of [{ version: 2 }, { backing: { ...inventory.backing, root: '/tmp' } }, { areas: [{ ...inventory.areas[0], origin: '/srv/other.git' }] }, { areas: [inventory.areas[0], inventory.areas[0]] }, { unknown: true }])
        expect(() => parseVaultStorageInventory({ ...inventory, ...patch })).toThrow();
});
it('verifies retained files and both repositories with separate physical and logical paths', () => {
    files(true);
    const first = inventory.areas[0], root = join(prefix, 'srv', first.relativePath);
    writeFileSync(join(root, 'untracked.md'), 'working-only private canary');
    const scratch = prefix + '-snapshot';
    cpSync(prefix, scratch, { recursive: true });
    try {
        expect(() => verifyVaultStorageFiles(inventory, { prefix: scratch, originPrefix: '' })).not.toThrow();
        expect(git(join(scratch, 'srv', first.relativePath), 'config', 'remote.origin.url')).toBe(first.origin);
        expect(readFileSync(join(scratch, 'srv', first.relativePath, 'untracked.md'), 'utf8')).toBe('working-only private canary');
    }
    finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
it('requires complete installed recovery tooling and the matching digest-pinned verifier', () => {
    mkdirSync(join(prefix, 'opt/lares'), { recursive: true });
    mkdirSync(join(prefix, 'etc/systemd/system'), { recursive: true });
    const files: Record<string, string> = {};
    for (const name of [...VAULT_RECOVERY_SCRIPTS, ...VAULT_RECOVERY_UNITS]) {
        const dir = name.endsWith('.service') || name.endsWith('.timer') ? 'etc/systemd/system' : 'opt/lares';
        const content = readFileSync(resolve('ops', name));
        writeFileSync(join(prefix, dir, name), content);
        files[name] = createHash('sha256').update(content).digest('hex');
    }
    const engineImage = 'example.invalid/keeper@sha256:' + 'a'.repeat(64);
    writeFileSync(join(prefix, 'opt/lares/vault-recovery-engine-image'), engineImage + '\n');
    writeFileSync(join(prefix, 'opt/lares/vault-recovery.json'), JSON.stringify({ version: 1, engineImage, files }));
    expect(() => requireVaultRecoveryTooling({ prefix, rootUid: process.getuid!() })).not.toThrow();
    writeFileSync(join(prefix, 'opt/lares/backup.sh'), 'old script');
    expect(() => requireVaultRecoveryTooling({ prefix, rootUid: process.getuid!() })).toThrow();
});
it('accepts only exact untouched marker initialization for restore preparation', () => {
    files();
    expect(() => assertEmptyVaultStorage(inventory, { prefix })).not.toThrow();
    const root = join(prefix, 'srv', inventory.areas[0].relativePath);
    writeFileSync(join(root, 'untracked.md'), 'do not erase');
    expect(() => assertEmptyVaultStorage(inventory, { prefix })).toThrow(/untouched empty/);
});
it('refuses extra refs, marker mismatch, missing store, and unknown paths', () => {
    files();
    const a = inventory.areas[0], root = join(prefix, 'srv', a.relativePath);
    git(root, 'tag', 'retained');
    expect(() => assertEmptyVaultStorage(inventory, { prefix })).toThrow();
    git(root, 'tag', '-d', 'retained');
    const marker = join(root, '.lares-vault-area.json'), old = readFileSync(marker);
    writeFileSync(marker, JSON.stringify({ version: 1, areaId: randomUUID() }));
    expect(() => verifyVaultStorageFiles(inventory, { prefix })).toThrow();
    writeFileSync(marker, old);
    mkdirSync(join(prefix, 'srv/vault/private/unknown'));
    expect(() => verifyVaultStorageFiles(inventory, { prefix })).toThrow();
    rmSync(join(prefix, 'srv/vault/private/unknown'), { recursive: true });
    rmSync(join(prefix, a.origin), { recursive: true });
    expect(() => verifyVaultStorageFiles(inventory, { prefix })).toThrow();
});
it('preserves a durable local commit awaiting push and refuses diverged bare history', () => {
    files();
    const a = inventory.areas[0], root = join(prefix, 'srv', a.relativePath), bare = join(prefix, a.origin), peer = join(prefix, 'peer');
    execFileSync('git', ['clone', '--quiet', bare, peer]);
    git(peer, 'config', 'user.name', 'Lares Vault');
    git(peer, 'config', 'user.email', 'vault@localhost');
    writeFileSync(join(root, 'local.md'), 'durable local canary');
    git(root, 'add', '--', 'local.md');
    git(root, 'commit', '-qm', 'Retained local commit');
    expect(() => verifyVaultStorageFiles(inventory, { prefix })).not.toThrow();
    expect(() => assertEmptyVaultStorage(inventory, { prefix })).toThrow();
    writeFileSync(join(peer, 'other.md'), 'independent peer history');
    git(peer, 'add', '--', 'other.md');
    git(peer, 'commit', '-qm', 'Diverged history');
    git(peer, 'push', '-q', 'origin', 'HEAD');
    expect(() => verifyVaultStorageFiles(inventory, { prefix })).toThrow(/diverge/);
    expect(readFileSync(join(root, 'local.md'), 'utf8')).toBe('durable local canary');
});

it('keeps new parent directories traversable by the runtime group under a restrictive install umask',()=>{
 execFileSync('bash',['-c','umask 077; . "$1"; vault_storage_prepare "$2" "$3"','_',resolve('ops/vault-storage.sh'),prefix,JSON.stringify(inventory)],{stdio:'pipe'});
 expect(statSync(join(prefix,'srv/lares/installation')).mode&0o777).toBe(0o750);
 expect(statSync(join(prefix,'srv/vault/private')).mode&0o777).toBe(0o750);
 expect(statSync(join(prefix,'srv',inventory.areas[0].relativePath)).mode&0o777).toBe(0o700);
});
it('releases only the canonical locks this snapshot owns',()=>{
 files();const first=join(prefix,'srv',inventory.areas[0].relativePath,'.git/lares-vault.lock');
 execFileSync('bash',['-c','. "$1"; vault_storage_load "$2"; vault_storage_lock; printf foreign > "$3"; vault_storage_unlock','_',resolve('ops/vault-storage.sh'),prefix,first],{stdio:'pipe'});
 expect(readFileSync(first,'utf8')).toBe('foreign');
 expect(()=>readFileSync(join(prefix,'srv',inventory.areas[1].relativePath,'.git/lares-vault.lock'))).toThrow();
});
