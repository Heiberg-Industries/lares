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
/** Return the exact complete generation currently exposed through the stable aliases. */
export function currentDefinitionGeneration(dir: string): string | null {
    const current = join(dir, '.current'), s = stat(current);
    if (!s) return null;
    if (!s.isSymbolicLink()) throw new Error('definition: unsafe current pointer');
    const target = readlinkSync(current);
    validateTarget(dir, target);
    return target;
}
/** Keep one exact known-good generation while a saved candidate awaits Apply. */
export function preserveDefinitionGeneration(dir: string, target: string): void {
    validateTarget(dir, target);
    const marker = join(dir, '.apply-rollback'), existing = stat(marker);
    if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('definition: unsafe Apply rollback marker');
        const prior = readFileSync(marker, 'utf8');
        validateTarget(dir, prior);
        return;
    }
    const temp = join(dir, `.rollback-${randomUUID()}`);
    durableFile(temp, target);
    renameSync(temp, marker);
    syncDefinitionDirectory(dir);
}
/** Record only files observed after a successful runtime start as the authoritative applied set. */
export function recordAppliedDefinition(dir: string, files: DefinitionFiles): string {
    const target = generation(dir, files);
    const temp = join(dir, `.applied-${randomUUID()}`);
    durableFile(temp, target);
    renameSync(temp, join(dir, '.applied-generation'));
    syncDefinitionDirectory(dir);
    return target;
}
export function appliedDefinitionGeneration(dir: string): string | null {
    const marker = join(dir, '.applied-generation'), s = stat(marker);
    if (!s) return null;
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('definition: unsafe applied generation marker');
    const target = readFileSync(marker, 'utf8');
    validateTarget(dir, target);
    return target;
}
/** A save with no authoritative applied generation must not later be mistaken for unchanged. */
export function markUnknownApplyBaseline(dir: string): void {
    const marker = join(dir, '.apply-unknown'), s = stat(marker);
    if (s) {
        if (!s.isFile() || s.isSymbolicLink()) throw new Error('definition: unsafe unknown Apply marker');
        return;
    }
    const temp = join(dir, `.unknown-${randomUUID()}`);
    durableFile(temp, 'A saved definition has no verified prior applied generation.');
    renameSync(temp, marker);
    syncDefinitionDirectory(dir);
}
export function hasUnknownApplyBaseline(dir: string): boolean {
    const s = stat(join(dir, '.apply-unknown'));
    if (!s) return false;
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('definition: unsafe unknown Apply marker');
    return true;
}
export function clearUnknownApplyBaseline(dir: string): void {
    const marker = join(dir, '.apply-unknown'), s = stat(marker);
    if (!s) return;
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('definition: unsafe unknown Apply marker');
    unlinkSync(marker);
    syncDefinitionDirectory(dir);
}
/** Mark a newly created definition whose first native activation may be explicitly held. */
export function markFirstActivation(dir: string): void {
    const marker = join(dir, '.first-activation');
    if (stat(marker)) return;
    const temp = join(dir, `.first-${randomUUID()}`);
    durableFile(temp, 'No successful runtime start has been recorded for this new definition.');
    renameSync(temp, marker);
    syncDefinitionDirectory(dir);
}
export function hasFirstActivation(dir: string): boolean {
    const s = stat(join(dir, '.first-activation'));
    if (!s) return false;
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('definition: unsafe first activation marker');
    return true;
}
export function clearFirstActivation(dir: string): void {
    const marker = join(dir, '.first-activation'), s = stat(marker);
    if (!s) return;
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('definition: unsafe first activation marker');
    unlinkSync(marker);
    syncDefinitionDirectory(dir);
}
/** Restore the exact complete generation and clear its marker after Apply resolves. */
export function restoreDefinitionGeneration(dir: string, target: string): void {
    validateTarget(dir, target);
    aliases(dir);
    switchPointer(dir, target);
    const marker = join(dir, '.apply-rollback'), s = stat(marker);
    if (s) {
        if (!s.isFile() || s.isSymbolicLink() || readFileSync(marker, 'utf8') !== target)
            throw new Error('definition: Apply rollback marker changed');
        unlinkSync(marker);
        syncDefinitionDirectory(dir);
    }
}
export function forgetDefinitionGeneration(dir: string, target: string): void {
    const marker = join(dir, '.apply-rollback'), s = stat(marker);
    if (!s) return;
    if (!s.isFile() || s.isSymbolicLink() || readFileSync(marker, 'utf8') !== target)
        throw new Error('definition: Apply rollback marker changed');
    unlinkSync(marker);
    syncDefinitionDirectory(dir);
}
export function preservedDefinitionGeneration(dir: string): string | null {
    const marker = join(dir, '.apply-rollback'), s = stat(marker);
    if (!s) return null;
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('definition: unsafe Apply rollback marker');
    const target = readFileSync(marker, 'utf8');
    validateTarget(dir, target);
    return target;
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
