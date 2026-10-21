import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { poolFromEnv } from '../lib/db.js';
import { applyVaultStorage, loadVaultStorageInventory, previewVaultStorage, verifyVaultStorage, verifyVaultStorageFiles, verifyVaultStorageMetadata, VAULT_STORAGE_INVENTORY, type VaultStorageFiles } from '../lib/vault-storage.js';
export async function main(argv: readonly string[], deps: {
    db?: Pool;
    env: NodeJS.ProcessEnv;
    out: (v: string) => void;
    error: (v: string) => void;
}): Promise<number> {
    let command = argv[0], prefix = '', owner = deps.env.LARES_OWNER_ID ?? '';
    if (command === '--help') {
        deps.out('vault-storage preview|apply|verify-plan|verify|verify-empty|verify-files|verify-snapshot [--prefix <physical-root>] [--owner <current-owner-id>]. No runtime tools or mounts are enabled.');
        return 0;
    }
    const allowed = ['preview', 'apply', 'verify-plan', 'verify', 'verify-empty', 'verify-files', 'verify-snapshot'];
    if (!allowed.includes(command)) {
        deps.error('vault storage: unknown operation');
        return 78;
    }
    try {
        for (let i = 1; i < argv.length; i += 2) {
            if (argv[i] === '--prefix' && argv[i + 1] !== undefined)
                prefix = argv[i + 1];
            else if (argv[i] === '--owner' && argv[i + 1])
                owner = argv[i + 1];
            else
                throw new Error();
        }
        const options: VaultStorageFiles = { prefix, runtimeUid: 10001 };
        if (deps.env.LARES_VAULT_LEGACY_ROOTS) {
            const roots: unknown = JSON.parse(deps.env.LARES_VAULT_LEGACY_ROOTS);
            if (!Array.isArray(roots) || !roots.every(v => typeof v === 'string'))
                throw new Error();
            options.legacyRoots = roots;
        }
        if (command === 'verify-files' || command === 'verify-snapshot')
            options.originPrefix = '';
        let inventory;
        if (command === 'verify-files') {
            inventory = loadVaultStorageInventory(options);
            verifyVaultStorageFiles(inventory, options);
        }
        else {
            if (!deps.db)
                throw new Error();
            if (command === 'preview')
                inventory = await previewVaultStorage(deps.db, owner, options);
            else if (command === 'apply')
                inventory = await applyVaultStorage(deps.db, owner, options);
            else if (command === 'verify-plan') {
                inventory = loadVaultStorageInventory(options, !existsSync(join(prefix, VAULT_STORAGE_INVENTORY)));
                verifyVaultStorageFiles(inventory, options);
                const db = await deps.db.connect();
                try {
                    await verifyVaultStorageMetadata(db, inventory);
                }
                finally {
                    db.release();
                }
            }
            else
                inventory = await verifyVaultStorage(deps.db, options, command === 'verify-empty');
        }
        deps.out(JSON.stringify(inventory ?? { absent: true }));
        return 0;
    }
    catch {
        deps.error('vault storage: refused; the pending plan, current database and complete local repositories must agree. No runtime was enabled.');
        return 78;
    }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2), db = args[0] === 'verify-files' || args[0] === '--help' ? undefined : poolFromEnv();
    main(args, { db, env: process.env, out: v => process.stdout.write(v + '\n'), error: v => process.stderr.write(v + '\n') }).then(code => { process.exitCode = code; }).finally(() => db?.end());
}
