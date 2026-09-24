import { randomUUID, randomBytes } from 'node:crypto';
import { lstatSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, openSync, writeFileSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { definitionSchema, parseDefinition, hashOf, loadDefinition, readDefinitionFiles, doorsOf, type AgentDefinition } from '@lares/agent-kit/definition';
import { validateDefinition, doorSecretName } from '@lares/agent-kit/definition-validate';
import { rememberValid } from '@lares/agent-kit/definition-cache';
import { KeeperRefusedError, registerAction, type ActionContext } from './actions.js';
import { DOOR_FILES } from './compose-agents.js';
import { publishDefinition, plainDirectory, syncDefinitionDirectory } from './definition-files.js';
import type { Backup } from './git-backup.js';
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
let namespaceTail: Promise<unknown> = Promise.resolve();
const ROLES = ['chief-of-staff', 'travel', 'creative'] as const;
export type DefinitionRole = typeof ROLES[number];
export interface DefinitionCompose {
    stop(name: string): Promise<void>;
    retired?(name:string):Promise<void>;
    prepare?(name:string, definition:AgentDefinition, create:boolean):Promise<void>;
    saved?(name:string, definition:AgentDefinition):Promise<{pending:boolean;reason:string|null}>;
    reconcile?(name:string, definition:AgentDefinition):Promise<unknown>;
    status?(name:string):Promise<unknown>;
    prepareSecretChange?(name:string):Promise<void>;
    secretChanged?(name:string):Promise<void>;
    deleted?(name:string):Promise<void>;
    /** Names below secretsDir that this lifecycle created and may remove with the agent. */
    ownedSecrets?(name:string):string[];
    /** Task14 owns provisioning, compose generation and start. Absent = refuse create BEFORE writes. */
    create?(name: string, definition: AgentDefinition): Promise<unknown>;
}
export interface DefinitionStorage {
    /** Must prove ownership of ALL resources before returning. Shared stores must refuse unless
     * every owned row can be identified. Never drop shared owner/workflow schemas. Returned delete
     * must be idempotent, as a crash can leave an audit pending after partial resource deletion. */
    prepareDelete(name: string, actor: string): Promise<{
        delete(): Promise<void>;
    }>;
}
export interface DefinitionOptions {
    pool: Pool;
    agentsDir: string;
    retiredDir: string;
    secretsDir: string;
    ceiling(): Promise<number>;
    compose: DefinitionCompose;
    storage?: DefinitionStorage;
    backup: Backup;
    roleInfo(role: DefinitionRole): {
        roleMd: string;
        deployedTools: string[];
    };
}
function refused(message: string): never { throw new KeeperRefusedError(message); }
function nameOf(name: string): string { if (!NAME_RE.test(name))
    refused('name must be a lowercase slug of 2–31 characters'); return name; }
function hasPath(path: string): boolean { try {
    lstatSync(path);
    return true;
}
catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return false;
    throw e;
} }
export function registerDefinitionActions(o: DefinitionOptions): void {
    const connection = new AsyncLocalStorage<PoolClient>();
    const db = () => connection.getStore() ?? o.pool;
    const nameInput = z.strictObject({ name: z.string() });
    const writeInput = z.strictObject({ name: z.string(), definition: z.unknown(), duties: z.string(), voice: z.string() });
    const active = (name: string) => join(o.agentsDir, nameOf(name));
    const roots = () => { for (const d of [o.agentsDir, o.retiredDir, o.secretsDir])
        plainDirectory(d); };
    // Cross-process lock, released by PostgreSQL on process death. Fixed installation-wide key
    // makes the capacity check and every namespace change one serialized operation.
    async function locked<T>(fn: () => Promise<T>): Promise<T> {
        // Queue BEFORE borrowing a connection: otherwise waiting advisory locks can exhaust the
        // pool and deadlock the active action's setting/backup callbacks.
        const next = namespaceTail.then(async () => {
            const client = await o.pool.connect();
            try {
                await client.query('SELECT pg_advisory_lock(1279349317,12)');
                roots();
                return await connection.run(client, fn);
            }
            finally {
                try {
                    await client.query('SELECT pg_advisory_unlock(1279349317,12)');
                }
                finally {
                    client.release();
                }
            }
        });
        namespaceTail = next.catch(() => { });
        return next;
    }
    async function registry(name: string) { return (await db().query('SELECT status,retired_folder FROM agent_definitions WHERE name=$1', [name])).rows[0]; }
    async function folder(name: string): Promise<string> {
        const path = active(name);
        if (hasPath(path)) {
            plainDirectory(path);
            return path;
        }
        const row = await registry(name);
        if (row?.status !== 'retired' || typeof row.retired_folder !== 'string' || !new RegExp(`^${name}-[0-9T-]+-[0-9a-f-]{36}$`).test(row.retired_folder))
            refused('definition folder is missing or its archive cannot be safely identified');
        const pathRetired = join(o.retiredDir, row.retired_folder);
        plainDirectory(pathRetired);
        return pathRetired;
    }
    async function backup(name: string, ctx: ActionContext, message: string) {
        try {
            const outcome = await o.backup.commit(name, ctx.actor, message);
            if (outcome === 'disabled')
                return { ok: false, status: 'disabled' as const, message: 'Git backup is not enabled.' };
            return { ok: true, status: 'saved' as const };
        }
        catch {
            return { ok: false, status: 'failed' as const, message: 'Definition retained on disk; git backup failed. Check backup configuration and retry backup.' };
        }
    }
    function validate(input: z.infer<typeof writeInput>): AgentDefinition {
        nameOf(input.name);
        const parsed = definitionSchema.safeParse(input.definition);
        if (!parsed.success) {
            const findings = parsed.error.issues.map(i => ({ check: 'schema', message: `invalid field ${i.path.filter(p => typeof p === 'string' && /^[a-zA-Z_]+$/.test(p)).join('.') || 'definition'}` }));
            throw new KeeperRefusedError(findings.map(f => f.message).join('; '), findings);
        }
        const d = parseDefinition(parsed.data);
        if (d.name !== input.name)
            refused('action name and definition name must match');
        if (d.duties !== 'duties.md')
            refused('duties must be duties.md inside the definition folder');
        if (!ROLES.includes(d.role as DefinitionRole))
            refused('role must be chief-of-staff, travel or creative');
        const info = o.roleInfo(d.role as DefinitionRole);
        if (!d.doors && d.channels.some(kind => !["slack", "telegram", "email"].includes(kind))) refused("unsupported legacy door kind");
        const findings = validateDefinition({ definition: { ...d, doors: d.doors ?? d.channels.map(kind => ({ kind: kind as "slack" | "telegram" | "email", enabled: true, settings: {} })) }, ...info, secretExists: (name) => {
                // Never expose filesystem exceptions as trusted validation messages.
                try {
                    const s = lstatSync(join(o.secretsDir, name));
                    return s.isFile() && !s.isSymbolicLink() && s.size > 0;
                }
                catch {
                    return false;
                }
            } });
        if (findings.length)
            throw new KeeperRefusedError(findings.map(f => `[${f.check}] ${f.message}`).join('\n'), findings);
        return d;
    }
    async function save(input: z.infer<typeof writeInput>, ctx: ActionContext, create: boolean) {
        const d = validate(input), path = active(input.name), previous = await registry(input.name);
        if (create) {
            if (!o.compose.create)
                refused('agent creation is unavailable until lifecycle provisioning is configured');
            if (hasPath(path) || previous)
                refused('name already exists; delete its retired definition before reusing it');
            const ceiling = await o.ceiling();
            if (!Number.isInteger(ceiling) || ceiling < 0)
                refused('agent capacity has not been measured and configured');
            const count = readdirSync(o.agentsDir, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())).length;
            if (count >= ceiling)
                refused(`this box holds ${ceiling} agents; retire one or move to a larger server`);
        }
        else {
            if (!hasPath(path) || previous?.status === 'retired')
                refused('definition.save edits an active agent; use definition.create for a new agent');
            plainDirectory(path);
        }
        await o.compose.prepare?.(input.name,d,create);
        const files = { 'agent.json': JSON.stringify(d, null, 2) + '\n', 'duties.md': input.duties, 'voice.md': input.voice };
        if (create) {
            // Stage creation outside the counted namespace and publish a complete root in one rename.
            // Interrupted stages are inert; a subsequent create may use the unoccupied name.
            const stage = join(o.agentsDir, `.create-${randomUUID()}`);
            mkdirSync(stage, { mode: 0o755 });
            await publishDefinition(stage, files);
            renameSync(stage, path);
            syncDefinitionDirectory(o.agentsDir);
        }
        else
            await publishDefinition(path, files);
        const loaded = { definition: d, dutiesMd: input.duties, voiceMd: input.voice, source: 'definition' as const, dir: path, hash: hashOf({ definition: d, dutiesMd: input.duties, voiceMd: input.voice }) };
        await rememberValid(db() as Pool, loaded);
        await db().query('UPDATE agent_definitions SET retired_folder=NULL WHERE name=$1', [input.name]);
        for (const door of doorsOf(d))
            await db().query(`INSERT INTO agent_doors(agent,kind,enabled,settings) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(agent,kind) DO UPDATE SET enabled=EXCLUDED.enabled,settings=EXCLUDED.settings,updated_at=now()`, [input.name, door.kind, door.enabled, JSON.stringify(d.doors?.find(x => x.kind === door.kind)?.settings ?? {})]);
        await db().query('UPDATE agent_doors SET enabled=false,updated_at=now() WHERE agent=$1 AND NOT(kind=ANY($2::text[]))', [input.name, doorsOf(d).map(x => x.kind)]);
        const backedUp = await backup(input.name, ctx, 'Saved definition');
        let runtime:unknown;
        try {
            if (create) await o.compose.create!(input.name, d);
            runtime = create ? await o.compose.status?.(input.name) : await o.compose.saved?.(input.name,d);
        } catch {
            // Disk/cache/backup publication already happened. Never describe a lifecycle precondition
            // discovered here as an effect-free refusal or silently replay the operation.
            throw new Error('Definition published; runtime reconciliation failed. Inspect pending resources.');
        }
        return { name: input.name, hash: loaded.hash, backup: backedUp, runtime };
    }
    const successDetail = (result: {
        hash: string;
    }) => JSON.stringify({ hash: result.hash });
    registerAction({ name: 'definition.save', input: writeInput, successDetail, run: (input, ctx) => locked(() => save(input, ctx, false)) });
    registerAction({ name: 'definition.create', input: writeInput.extend({ startingPoint: z.enum(ROLES) }), successDetail, run: (input, ctx) => locked(() => {
            if ((input.definition as {
                role?: unknown;
            } | null)?.role !== input.startingPoint)
                refused('starting point and definition role must match');
            return save(input, ctx, true);
        }) });
    registerAction({name:'definition.capacity',input:z.strictObject({}),run:async()=>{
        const value=await o.ceiling();
        const ceiling=Number.isInteger(value)&&value>=0?value:null;
        const activeCount=readdirSync(o.agentsDir,{withFileTypes:true}).filter(e=>!e.name.startsWith('.')&&(e.isDirectory()||e.isSymbolicLink())).length;
        return {ceiling,activeCount,approved:ceiling!==null,creationAvailable:ceiling!==null&&activeCount<ceiling};
    }});
    registerAction({ name: 'definition.get', input: nameInput, run: async ({ name }) => {
            roots();
            const files = await readDefinitionFiles(await folder(name));
            return { name, runtime:await o.compose.status?.(name), definition: files['agent.json'], duties: files['duties.md'], voice: files['voice.md'] };
        } });
    registerAction({ name: 'definition.list', input: z.strictObject({}), run: async () => {
            roots();
            const rows = (await db().query('SELECT name,status,hash,definition,retired_folder FROM agent_definitions')).rows;
            const names = new Set([...readdirSync(o.agentsDir).filter(n => NAME_RE.test(n)), ...rows.filter(r => r.status === 'retired').map(r => r.name)]);
            return Promise.all([...names].sort().map(async (name) => {
                const row = rows.find(r => r.name === name);
                try {
                    const loaded = await loadDefinition({ serviceDir: 'unused', env: { LARES_DEFINITION_DIR: await folder(name) } });
                    return { name, runtime:await o.compose.status?.(name), display: loaded.definition.display ?? name, description: loaded.definition.description ?? '', doors: doorsOf(loaded.definition), status: row?.status ?? 'unvalidated', hash: loaded.hash };
                }
                catch {
                    return { name, display: row?.definition?.display ?? name, description: row?.definition?.description ?? '', doors: [], status: 'invalid', hash: row?.hash ?? null };
                }
            }));
        } });
    registerAction({ name:'definition.reconcile', input:nameInput.extend({hash:z.string().regex(/^[a-f0-9]{64}$/)}), run:({name,hash})=>locked(async()=>{
        if(!o.compose.reconcile) refused('Runtime reconciliation is not configured');
        const loaded=await loadDefinition({serviceDir:'unused',env:{LARES_DEFINITION_DIR:active(name)}});
        if(loaded.hash!==hash) refused('Definition changed; refresh before applying connection changes');
        const row=await db().query("SELECT hash,status FROM agent_definitions WHERE name=$1",[name]);
        if(row.rows[0]?.hash!==hash||row.rows[0]?.status!=='valid') refused('Save a valid definition before reconciliation');
        validate({name,definition:loaded.definition,duties:loaded.dutiesMd,voice:loaded.voiceMd});
        return o.compose.reconcile!(name,loaded.definition);
    }) });
    registerAction({ name: 'definition.retire', input: nameInput, run: ({ name }, ctx) => locked(async () => {
            const path = active(name);
            plainDirectory(path);
            // Refuse before stopping if the current definition has never been recorded.
            if (!await registry(name))
                refused('save this definition before retiring it');
            const archive = `${name}-${new Date().toISOString().replace(/[:.Z]/g, '')}-${randomUUID()}`;
            await o.compose.stop(name);
            // Persist archive identity BEFORE rename. A failed rename is explicitly uncertain, and the
            // row identifies exactly where an operator must inspect; no timestamp guessing on deletion.
            await db().query("UPDATE agent_definitions SET status='retired',retired_folder=$2,checked_at=now() WHERE name=$1", [name, archive]);
            renameSync(path, join(o.retiredDir, archive));
            syncDefinitionDirectory(o.agentsDir);
            syncDefinitionDirectory(o.retiredDir);
            await o.compose.retired?.(name);
            return { name, status: 'retired', archive, backup: await backup(name, ctx, 'Retired definition') };
        }) });
    registerAction({ name: 'definition.delete', input: nameInput.extend({ confirm: z.literal(true) }), run: ({ name }, ctx) => locked(async () => {
            nameOf(name);
            const row = await registry(name);
            if (row?.status !== 'retired' || hasPath(active(name)))
                refused('retire the agent before deleting it');
            // A deletion interrupted after removing its archive may resume only against the exact
            // persisted archive identity; never guess another folder or require resurrecting data.
            if(typeof row.retired_folder!=='string'||!new RegExp(`^${name}-[0-9T-]+-[0-9a-f-]{36}$`).test(row.retired_folder)) refused('Archive identity is missing');
            const path=join(o.retiredDir,row.retired_folder);
            if(hasPath(path)) plainDirectory(path);
            if (!o.storage)
                refused('deletion is unavailable: agent storage ownership has not been configured');
            // Removed only after storage ownership proof and successful owned deletion.
            // Reconcile preserves this file within one incarnation; slug reuse must not.
            const secrets = [...new Set([`${name}-runtime-control`,...(o.compose.ownedSecrets?.(name)??[]),...['slack','telegram','email'].map(kind=>doorSecretName(name,kind)),...Object.values(DOOR_FILES).flatMap(files=>Object.values(files).map(s=>`${name}-${s}`))])].map(file=>join(o.secretsDir,file));
            for (const path of secrets)
                if (hasPath(path)) {
                    const st = lstatSync(path);
                    if (!st.isFile() && !st.isSymbolicLink())
                        refused('owned secret path is not a file');
                }
            const plan = await o.storage.prepareDelete(name,ctx.actor);
            await plan.delete();
            rmSync(path, { recursive: true, force:true });
            syncDefinitionDirectory(o.retiredDir);
            for (const secret of secrets)
                if (hasPath(secret))
                    unlinkSync(secret);
            syncDefinitionDirectory(o.secretsDir);
            await db().query('DELETE FROM agent_doors WHERE agent=$1', [name]);
            await db().query("DELETE FROM agent_definitions WHERE name=$1 AND status='retired'", [name]);
            await o.compose.deleted?.(name);
            // Backup history is deliberately retained; deletion never calls git rm.
            return { name, deleted: true };
        }) });
    registerAction({ name: 'door.connect', input: z.discriminatedUnion('kind', [
        z.strictObject({name:z.string().regex(NAME_RE),kind:z.literal('slack'),secret:z.string().regex(/^xoxb-[A-Za-z0-9-]+$/),signingSecret:z.string().regex(/^[a-f0-9]{32}$/)}),
        z.strictObject({name:z.string().regex(NAME_RE),kind:z.literal('telegram'),secret:z.string().regex(/^\d+:[A-Za-z0-9_-]+$/)}),
    ]), secretFields:['secret','signingSecret'], run:input=>locked(async()=>{
        const {name,kind,secret}=input;
        plainDirectory(active(name));
        const loaded=await loadDefinition({serviceDir:'unused',env:{LARES_DEFINITION_DIR:active(name)}});
        const supported:Record<string,string[]>={creative:['slack'],travel:['telegram'],'chief-of-staff':['slack','telegram','email']};
        if(!supported[loaded.definition.role??'']?.includes(kind))refused('This starting point does not support that door');
        if(!o.compose.prepareSecretChange||!o.compose.secretChanged)refused('Configure resource lifecycle before connecting doors');
        await o.compose.prepareSecretChange(name);
        const files:Record<string,string>={[`${name}-${kind}-token`]:secret};
        if(input.kind==='slack') files[`${name}-slack-signing-secret`]=input.signingSecret;
        else files[`${name}-telegram-webhook-secret`]=randomBytes(32).toString('hex');
        // Preflight EVERY destination before publishing either part of the pair.
        for(const file of Object.keys(files))if(hasPath(join(o.secretsDir,file))){
            const st=lstatSync(join(o.secretsDir,file));
            if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)refused('Secret path is not a regular single-link file');
        }
        let published=false;
        try {
            // Pending state precedes any credential replacement. Explicit reconciliation applies
            // root:10001 0440 and mounts the new inodes; old runtime is never called Connected.
            await o.compose.secretChanged?.(name);
            for(const [file,value] of Object.entries(files)){
                const temp=join(o.secretsDir,`.secret-${randomUUID()}`),fd=openSync(temp,'wx',0o600);
                try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}
                renameSync(temp,join(o.secretsDir,file));published=true;
            }
            syncDefinitionDirectory(o.secretsDir);
            await db().query(`INSERT INTO agent_doors(agent,kind,secret_set_at) VALUES($1,$2,now()) ON CONFLICT(agent,kind) DO UPDATE SET secret_set_at=now(),updated_at=now()`,[name,kind]);
            return {name,kind,connected:false,runtime:await o.compose.status?.(name)??{pending:true,reason:'Apply connection changes (restarts agent)'}};
        } catch {
            throw new Error(published?'Credentials may be partially published; inspect pending state before retrying.':'Connection state update failed; inspect current state before retrying.');
        }
    }) });
}
