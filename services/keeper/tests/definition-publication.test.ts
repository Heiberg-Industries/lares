import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, unlinkSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadDefinition } from '@lares/agent-kit/definition';
import { publishDefinition, recoverPublication } from '../lib/definition-files.js';
const roots: string[] = [];
const files = (n: number) => ({ 'agent.json': JSON.stringify({ name: 'sample', model: 'test-brain', persona: 'agent/persona.md', description: String(n) }), 'duties.md': String(n), 'voice.md': String(n) });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'definition-publication-')); roots.push(root); const dir = join(root, 'sample'); mkdirSync(dir); return dir; }
afterEach(() => { for (const d of roots.splice(0))
    rmSync(d, { recursive: true, force: true }); });
const load = (dir: string) => loadDefinition({ serviceDir: 'unused', env: { LARES_DEFINITION_DIR: dir } });
it('migrates a plain folder and publishes into the same inode; root files remain editable', async () => {
    const dir = fixture();
    for (const [f, s] of Object.entries(files(0)))
        writeFileSync(join(dir, f), s);
    const inode = lstatSync(dir).ino;
    await publishDefinition(dir, files(1));
    expect(lstatSync(dir).ino).toBe(inode);
    writeFileSync(join(dir, 'voice.md'), 'hand edit');
    expect((await load(dir)).voiceMd).toBe('hand edit');
    await publishDefinition(dir, files(2));
    expect((await load(dir)).voiceMd).toBe('2');
    expect(lstatSync(dir).ino).toBe(inode);
});
it('readers pin a whole generation while repeated publications happen', async () => {
    const dir = fixture();
    await publishDefinition(dir, files(0));
    const reads = Array.from({ length: 80 }, async () => { for (let i = 0; i < 8; i++) {
        const d = await load(dir);
        expect(d.dutiesMd).toBe(d.definition.description);
        expect(d.voiceMd).toBe(d.definition.description);
    } });
    for (let n = 1; n <= 12; n++) {
        await publishDefinition(dir, files(n));
        await new Promise(r => setImmediate(r));
    }
    await Promise.all(reads);
});
it('interrupted staging leaves old generation readable; restart can publish again', async () => {
    const dir = fixture();
    await publishDefinition(dir, files(1));
    await expect(publishDefinition(dir, files(2), () => { throw new Error('simulated crash before pointer switch'); })).rejects.toThrow('simulated crash');
    expect((await load(dir)).dutiesMd).toBe('1');
    await publishDefinition(dir, files(3));
    expect((await load(dir)).dutiesMd).toBe('3');
});
it('rejects traversal, external pointers and symlinked generation files', async () => {
    const dir = fixture();
    await publishDefinition(dir, files(1));
    const pointer = readlinkSync(join(dir, '.current'));
    unlinkSync(join(dir, '.current'));
    symlinkSync('../outside', join(dir, '.current'));
    await expect(load(dir)).rejects.toThrow();
    unlinkSync(join(dir, '.current'));
    symlinkSync(pointer, join(dir, '.current'));
    rmSync(join(dir, pointer, 'voice.md'));
    symlinkSync('/etc/passwd', join(dir, pointer, 'voice.md'));
    await expect(load(dir)).rejects.toThrow();
});
it('rejects duties traversal in old plain folders and external root aliases in managed folders', async () => {
    const dir = fixture();
    for (const [f, s] of Object.entries(files(0)))
        writeFileSync(join(dir, f), s);
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ ...JSON.parse(files(0)['agent.json']), duties: '../../outside' }));
    await expect(load(dir)).rejects.toThrow('duties');
    writeFileSync(join(dir, 'agent.json'), files(0)['agent.json']);
    await publishDefinition(dir, files(1));
    unlinkSync(join(dir, 'voice.md'));
    symlinkSync('/etc/passwd', join(dir, 'voice.md'));
    await expect(load(dir)).rejects.toThrow('root alias');
});
it('reads atomic-editor root replacements and allows the next keeper save', async () => {
    const dir = fixture();
    await publishDefinition(dir, files(1));
    unlinkSync(join(dir, 'voice.md'));
    writeFileSync(join(dir, 'voice.md'), 'changed');
    expect((await load(dir)).voiceMd).toBe('changed');
    await publishDefinition(dir, files(2));
    expect((await load(dir)).voiceMd).toBe('2');
});
it('survives an actual writer SIGKILL after staging and recovers on the next save', async () => {
    const dir = fixture();
    await publishDefinition(dir, files(1));
    const source = new URL('../lib/definition-files.ts', import.meta.url).href;
    const script = `import {publishDefinition,recoverPublication} from ${JSON.stringify(source)}; await publishDefinition(${JSON.stringify(dir)},${JSON.stringify(files(2))},()=>process.kill(process.pid,'SIGKILL'));`;
    let signal;
    try {
        execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: 'pipe' });
    }
    catch (error) {
        signal = (error as {
            signal: string;
        }).signal;
    }
    expect(signal).toBe('SIGKILL');
    expect((await load(dir)).voiceMd).toBe('1');
    await publishDefinition(dir, files(3));
    expect((await load(dir)).voiceMd).toBe('3');
});
it('recovers a crash during plain-folder alias conversion without changing the mounted inode', async () => {
    const dir = fixture();
    await publishDefinition(dir, files(1));
    const inode = lstatSync(dir).ino;
    unlinkSync(join(dir, 'duties.md'));
    writeFileSync(join(dir, 'duties.md'), '1');
    expect((await load(dir)).dutiesMd).toBe('1');
    await publishDefinition(dir, files(2));
    expect(lstatSync(dir).ino).toBe(inode);
    expect((await load(dir)).dutiesMd).toBe('2');
});
it('recovers a durable conversion journal without exposing partly reattached overrides', async () => {
    const dir = fixture();
    await publishDefinition(dir, files(1));
    const old = readlinkSync(join(dir, '.current'));
    await publishDefinition(dir, files(2));
    const next = readlinkSync(join(dir, '.current'));
    unlinkSync(join(dir, '.current'));
    symlinkSync(old, join(dir, '.current'));
    unlinkSync(join(dir, 'voice.md'));
    writeFileSync(join(dir, 'voice.md'), 'manual prior voice');
    writeFileSync(join(dir, '.publishing'), next);
    await expect(load(dir)).rejects.toThrow('publication interrupted');
    recoverPublication(dir);
    const loaded = await load(dir);
    expect(loaded.voiceMd).toBe('2');
    expect(loaded.dutiesMd).toBe('2');
});
