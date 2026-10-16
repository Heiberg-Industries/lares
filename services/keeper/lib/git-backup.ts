/** Backup, never authoring. An independent checkout of the owner's configured remote updates
 * only definitions/<agent> and adds commits; never force-pushes or rewrites remote history.
 * duties.md is owner-written operational text, the same exposure class as voice.md.
 * No installation remote is hardcoded here. An unset remote disables this optional backup;
 * a configured but rejected remote is reported AFTER retaining the local save. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readDefinitionFiles } from '@lares/agent-kit/definition';
export interface Backup {
    /** undefined means pushed successfully; disabled means no remote was configured. */
    commit(agent: string, actor: string, message: string): Promise<void | 'disabled'>;
}
const exec = promisify(execFile);
export class GitBackup implements Backup {
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private readonly options: {
        checkout: string;
        remote: () => Promise<string>;
        source: (agent: string) => Promise<string>;
    }) { }
    commit(agent: string, actor: string, message: string): Promise<void | 'disabled'> { const run = this.tail.then(() => this.save(agent, actor, message)); this.tail = run.catch(() => { }); return run; }
    private async save(agent: string, actor: string, message: string): Promise<void | 'disabled'> {
        if (!/^[a-z][a-z0-9-]{1,30}$/.test(agent))
            throw new Error('backup: invalid name');
        const remote = (await this.options.remote()).trim();
        if (!remote) return 'disabled';
        if (remote.startsWith('-') || remote.includes('\0'))
            throw new Error('backup: remote unavailable');
        const dir = resolve(this.options.checkout);
        const git = async (...args: string[]) => (await exec('git', ['-C', dir, ...args], { maxBuffer: 1024 * 1024, timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
        try {
            const st = await lstat(dir);
            if (!st.isDirectory() || st.isSymbolicLink())
                throw new Error('backup: unsafe checkout');
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
            await mkdir(dirname(dir), { recursive: true });
            await exec('git', ['clone', '--', remote, dir], { timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        }
        if (await git('remote', 'get-url', 'origin') !== remote)
            throw new Error('backup: configured remote changed; use a new checkout');
        if (await git('status', '--porcelain'))
            throw new Error('backup: checkout has uncommitted changes');
        await git('fetch', 'origin');
        // A rejected push retains the local commit. Rebase only our unpushed commits atop the
        // new remote tip, then ordinary push; remote history is never rewritten.
        const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
        // Replaying an unpushed commit creates a new committer record even though its author
        // remains the original owner. A clean keeper image has no global Git identity.
        await git('-c', 'user.name=Lares keeper', '-c', 'user.email=keeper@localhost', 'rebase', upstream);
        for (const part of [join(dir, 'definitions'), join(dir, 'definitions', agent)]) {
            try {
                const st = await lstat(part);
                if (!st.isDirectory() || st.isSymbolicLink())
                    throw new Error('backup: unsafe definitions directory');
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw e;
                await mkdir(part);
            }
        }
        const sourcePath = await this.options.source(agent);
        if ((await realpath(sourcePath)).startsWith(dir + '/'))
            throw new Error('backup: source must be independent');
        const source = await readDefinitionFiles(sourcePath);
        for (const file of ['agent.json', 'duties.md', 'voice.md'] as const) {
            const path = join(dir, 'definitions', agent, file);
            try {
                const st = await lstat(path);
                if (!st.isFile() || st.isSymbolicLink())
                    throw new Error('backup: unsafe target');
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw e;
            }
            await writeFile(path, source[file]);
        }
        await git('add', '--', `definitions/${agent}`);
        // Even an unchanged owner save gets its own auditable backup commit.
        await git('-c', `user.name=${actor}`, '-c', 'user.email=keeper@localhost', 'commit', '--allow-empty', '-m', `${message}: ${agent}`, '--', `definitions/${agent}`);
        await git('push', 'origin', 'HEAD');
    }
}
