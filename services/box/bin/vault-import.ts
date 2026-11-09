/** `lares vault import`, inside the engine image. Run by ops/lares with a private copy of the source
 * folder and the two Vault areas mounted; not meant to be run by hand.
 *   vault-import preview|apply --source <dir> --label <name> [--prefix <root>] [--map <file>]
 *     [--shared <folder>]... [--private <folder>]... [--skip <glob>]... [--origin owner|agent|synced]
 *     [--include-conversations] [--confirm <plan-id>] */
import { fileURLToPath } from 'node:url';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { poolFromEnv } from '../lib/db.js';
import { parseImportMap, runVaultImport, VaultImportError, type ImportMap, type ImportOptions } from '../lib/vault-import.js';

export async function main(argv: readonly string[], deps: { db?: Pool; env: NodeJS.ProcessEnv; out: (v: string) => void; error: (v: string) => void; storage?: { rootUid?: number; runtimeUid?: number } }): Promise<number> {
    const mode = argv[0];
    if (mode !== 'preview' && mode !== 'apply') { deps.error('vault import: say preview or apply'); return 64; }
    let source = '', label = '', prefix = '', mapFile = '', confirm: string | undefined, origin = 'synced', includeConversations = false;
    const shared: string[] = [], priv: string[] = [], skip: string[] = [];
    const usage = (why: string) => { deps.error(`vault import: ${why}`); return 64; };
    for (let i = 1; i < argv.length; i++) {
        const flag = argv[i]!, value = argv[i + 1];
        if (flag === '--include-conversations') { includeConversations = true; continue; }
        if (value === undefined) return usage(`${flag} needs a value`);
        i++;
        if (flag === '--source') source = value;
        else if (flag === '--label') label = value;
        else if (flag === '--prefix') prefix = value;
        else if (flag === '--map') mapFile = value;
        else if (flag === '--shared') shared.push(value);
        else if (flag === '--private') priv.push(value);
        else if (flag === '--skip') skip.push(value);
        else if (flag === '--origin') origin = value;
        else if (flag === '--confirm') confirm = value;
        else return usage(`I do not know the option ${flag}`);
    }
    if (!source || !label) return usage('--source and --label are required');
    if (!['owner', 'agent', 'synced'].includes(origin)) return usage('--origin must be owner, agent or synced');
    if (mode === 'apply' && !confirm) return usage('apply needs --confirm <plan-id> from a preview');
    if (!deps.db) return usage('no database connection');
    try {
        if (!lstatSync(source).isDirectory()) throw new VaultImportError('the source is not a folder');
        let map: ImportMap = {};
        const file = mapFile || (existsSync(join(source, '.lares-import.json')) ? join(source, '.lares-import.json') : '');
        if (file) {
            if (!lstatSync(file).isFile()) throw new VaultImportError('the map must be a plain file');
            try { map = parseImportMap(JSON.parse(readFileSync(file, 'utf8'))); } catch (error) {
                throw error instanceof VaultImportError ? error : new VaultImportError('the map file is not valid JSON');
            }
        }
        const options: ImportOptions = { label, map, shared, private: priv, skip, origin: origin as ImportOptions['origin'], includeConversations };
        return await runVaultImport(deps.db, { mode, source, options, confirm }, { prefix, rootUid: deps.storage?.rootUid, runtimeUid: deps.storage?.runtimeUid ?? 10001 }, deps.out);
    } catch (error) {
        deps.error(error instanceof VaultImportError ? `vault import: ${error.message}. Nothing was changed by this step.`
            : 'vault import: refused; the Vault could not be opened or written safely. Anything already written is committed in whole chunks; run the preview again to see what is left.');
        return 78;
    }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const db = process.argv[2] === '--help' ? undefined : poolFromEnv();
    main(process.argv.slice(2), { db, env: process.env, out: v => process.stdout.write(v + '\n'), error: v => process.stderr.write(v + '\n') })
        .then(code => { process.exitCode = code; }).finally(() => db?.end());
}
