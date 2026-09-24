import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
export const DEFINITION_FILES = ['agent.json', 'duties.md', 'voice.md'] as const;
export type DefinitionFiles = Record<(typeof DEFINITION_FILES)[number], string>;
function stat(path: string) { try {
    return lstatSync(path);
}
catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return undefined;
    throw e;
} }
export function plainDirectory(path: string): void {
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink())
        throw new Error('definition: directory must not be a symlink');
}
export function syncDefinitionDirectory(dir: string): void { const fd = openSync(dir, 'r'); try {
    fsyncSync(fd);
}
finally {
    closeSync(fd);
} }
function durableFile(path: string, text: string): void { const fd = openSync(path, 'wx', 0o644); try {
    writeFileSync(fd, text);
    fsyncSync(fd);
}
finally {
    closeSync(fd);
} }
function generation(dir: string, files: DefinitionFiles): string {
    const parent = join(dir, '.generations');
    if (!stat(parent))
        mkdirSync(parent, { mode: 0o755 });
    plainDirectory(parent);
    const id = randomUUID();
    const dest = join(parent, id);
    mkdirSync(dest, { mode: 0o755 });
    for (const name of DEFINITION_FILES)
        durableFile(join(dest, name), files[name]);
    syncDefinitionDirectory(dest);
    syncDefinitionDirectory(parent);
    return `.generations/${id}`;
}
function validateTarget(dir: string, target: string): void {
    if (!/^\.generations\/[0-9a-f-]{36}$/.test(target))
        throw new Error('definition: unsafe generation pointer');
    plainDirectory(join(dir, '.generations'));
    plainDirectory(join(dir, target));
    for (const name of DEFINITION_FILES) {
        const s = lstatSync(join(dir, target, name));
        if (!s.isFile() || s.isSymbolicLink())
            throw new Error('definition: unsafe generation file');
    }
}
function switchPointer(dir: string, target: string): void { const temp = join(dir, `.pointer-${randomUUID()}`); symlinkSync(target, temp); renameSync(temp, join(dir, '.current')); syncDefinitionDirectory(dir); }
function aliases(dir: string): void {
    for (const name of DEFINITION_FILES) {
        const path = join(dir, name), s = stat(path);
        if (s?.isSymbolicLink()) {
            if (readlinkSync(path) !== `.current/${name}`)
                throw new Error('definition: unsafe root alias');
            continue;
        }
        if (s && !s.isFile())
            throw new Error('definition: unsafe root file');
        const temp = join(dir, `.alias-${randomUUID()}`);
        symlinkSync(`.current/${name}`, temp);
        renameSync(temp, path);
    }
}
/** Finish only the exact complete generation named in a durable journal. Recovery is idempotent
 * after SIGKILL at any point. It does not guess from staged folders or clean old generations. */
export function recoverPublication(dir: string): void {
    plainDirectory(dir);
    const marker = join(dir, '.publishing'), s = stat(marker);
    if (!s)
        return;
    if (!s.isFile() || s.isSymbolicLink())
        throw new Error('definition: unsafe publication journal');
    const target = readFileSync(marker, 'utf8');
    validateTarget(dir, target);
    aliases(dir);
    switchPointer(dir, target);
    unlinkSync(marker);
    syncDefinitionDirectory(dir);
}
/** Stable mounted root. All new files are durable before the pointer switch. Regular root
 * files (plain folders or atomic-editor overrides) require alias conversion under a durable
 * journal. Readers fail closed during that short transition; after a crash, recovery completes
 * the journaled generation before another save. Ordinary saves need only one pointer rename.
 * Old generations are retained because an in-flight reader may still hold one. */
export async function publishDefinition(dir: string, files: DefinitionFiles, beforeSwitch?: () => void): Promise<void> {
    plainDirectory(dir);
    recoverPublication(dir);
    const current = join(dir, '.current');
    const c = stat(current);
    if (c) {
        if (!c.isSymbolicLink())
            throw new Error('definition: unsafe current pointer');
        validateTarget(dir, readlinkSync(current));
    }
    let conversion = !c;
    for (const name of DEFINITION_FILES) {
        const path = join(dir, name), s = stat(path);
        if (s?.isSymbolicLink()) {
            if (readlinkSync(path) !== `.current/${name}`)
                throw new Error('definition: unsafe root alias');
        }
        else {
            if (s && !s.isFile())
                throw new Error('definition: unsafe root file');
            conversion = true;
        }
    }
    const next = generation(dir, files);
    beforeSwitch?.();
    if (conversion) {
        const marker = join(dir, '.publishing'), journal = join(dir, `.journal-${randomUUID()}`);
        durableFile(journal, next);
        renameSync(journal, marker);
        syncDefinitionDirectory(dir);
        recoverPublication(dir);
    }
    else
        switchPointer(dir, next);
}
