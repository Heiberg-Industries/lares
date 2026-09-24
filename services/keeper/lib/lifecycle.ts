import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { doorsOf, definitionSchema, type AgentDefinition } from '@lares/agent-kit/definition';
import { generateEgress } from './egress.js';
import { renderAgentsCompose, nextAddress, DOOR_FILES, ROLE_DOORS, type AgentContainer } from './compose-agents.js';
import type { DockerBoundary } from './docker.js';
import type { LifecycleConfig } from './lifecycle-config.js';
import { WorkflowStorage } from './workflow-storage.js';
import { KeeperRefusedError } from './actions.js';
import { verifyCurrentStateSchema, deleteAgentCurrentState } from './agent-current-state.js';
import { runtimeSecret, verifySecretRoot } from './secret-permissions.js';
import { bindingsFor, verifyBindingSources } from './runtime-bindings.js';
import { LiteLLMGatewayKeys, gatewayModels, type GatewayKeyProvisioner } from './gateway-keys.js';
import { readSetting } from './settings.js';
function atomic(path: string, body: string, mode = 0o600) { const temp = `${path}.${randomUUID()}`; const fd = openSync(temp, 'wx', mode); try {
    writeFileSync(fd, body);
    fsyncSync(fd);
}
finally {
    closeSync(fd);
} renameSync(temp, path); }
const RETIREMENT_PENDING = 'Retirement pending; retry definition.retire';
function refusePendingRetirement(row: any): void {
    if (row?.pending && row.pending_reason === RETIREMENT_PENDING)
        throw new KeeperRefusedError('Retry definition.retire to complete pending retirement');
}
function runtimeControlled(row: any): boolean { return !!row?.runtime_control_token && row.runtime_control_token === row.ownership_token; }
function fingerprint(d: AgentDefinition) { return createHash('sha256').update(JSON.stringify({ role: d.role, doors: doorsOf(d) })).digest('hex'); }
/** All callers run within the audited definition action AND namespace advisory lock.
 * Partial failures leave resources and pending state for an explicit reconcile; never auto replay. */
export class AgentLifecycle {
    readonly storage: WorkflowStorage;
    constructor(private pool: Pool, admin: Pool, private config: LifecycleConfig, private paths: {
        agentsDir: string;
        secretsDir: string;
    }, private docker: DockerBoundary, private provisionSecret = runtimeSecret, private verifySecrets = verifySecretRoot,
    private gatewayKeyProvisioner: GatewayKeyProvisioner = new LiteLLMGatewayKeys()) {
        this.storage = new WorkflowStorage(pool, admin, config.workflowTemplate, config.workflowOwner);
    }
    private gatewayKeyFile(name: string): string {
        const exact = this.config.runtime.gatewayKeys[name];
        if (exact) return exact;
        if (this.config.runtime.gatewayMasterKeyFile) return join(this.paths.secretsDir, `${name}-gateway-key`);
        throw new KeeperRefusedError('Installation must supply or manage this agent gateway key');
    }
    private async ensureGatewayKey(name: string): Promise<void> {
        if (this.config.runtime.gatewayKeys[name]) return;
        const masterKeyFile = this.config.runtime.gatewayMasterKeyFile;
        if (!masterKeyFile) throw new KeeperRefusedError('Installation must supply or manage this agent gateway key');
        const setting = await readSetting(this.pool, 'models.alias_prefix');
        if (typeof setting !== 'string') throw new Error('keeper: models.alias_prefix is missing or invalid');
        const aliasPrefix = setting;
        // Validate here before touching either secret. The provisioner repeats the validation so
        // its direct callers cannot bypass it.
        gatewayModels(aliasPrefix);
        this.verifySecrets(this.paths.secretsDir);
        this.provisionSecret(masterKeyFile);
        await this.gatewayKeyProvisioner.ensure({
            gatewayUrl: this.config.runtime.gatewayUrl,
            masterKeyFile,
            secretFile: this.gatewayKeyFile(name),
            name,
            aliasPrefix,
        });
    }
    private async removeGatewayKey(name: string): Promise<void> {
        if (this.config.runtime.gatewayKeys[name]) return;
        const masterKeyFile = this.config.runtime.gatewayMasterKeyFile;
        if (!masterKeyFile) return;
        await this.gatewayKeyProvisioner.remove({
            gatewayUrl: this.config.runtime.gatewayUrl,
            masterKeyFile,
            secretFile: this.gatewayKeyFile(name),
            name,
        });
    }
    ownedSecrets(name: string): string[] {
        return !this.config.runtime.gatewayKeys[name] && this.config.runtime.gatewayMasterKeyFile
            ? [`${name}-gateway-key`]
            : [];
    }
    private async definitions(): Promise<Map<string, AgentDefinition>> {
        return new Map((await this.pool.query("SELECT name,definition FROM agent_definitions ")).rows.map(r => [r.name, r.definition]));
    }
    private async rows() { return (await this.pool.query("SELECT * FROM agent_resources WHERE state<>'deleting' ORDER BY name")).rows; }
    private container(row: any, d: AgentDefinition): AgentContainer {
        const c = this.config, r = c.runtime;
        const url = new URL(r.workflowServer);
        url.pathname = `/${row.workflow_database}`;
        const gatewayKeyFile = this.gatewayKeyFile(row.name);
        const role = d.role!;
        const roleDefault = role === 'chief-of-staff' || role === 'travel' || role === 'creative'
            ? c.defaultBindings?.[role]
            : undefined;
        const binding = c.bindings?.[row.name] ?? roleDefault;
        return { name: row.name, incarnation: row.ownership_token, role, bindings: bindingsFor(role, binding), address: String(row.address).split('/')[0], doors: doorsOf(d), runtime: { databaseUrl: r.databaseUrl, workflowUrl: url.toString(), gatewayUrl: r.gatewayUrl, proxyUrl: r.proxyUrl, schedulesLive: r.schedulesLive, gatewayKeyFile, passwordFile: r.passwordFile, endpoints: c.egress.endpoints } };
    }
    private async render(override?: {
        name: string;
        definition: AgentDefinition;
    }, omit?: string, includeRetired = false, runtimeOnly = false) {
        const defs = await this.definitions();
        if (override)
            defs.set(override.name, override.definition);
        const agents: AgentContainer[] = [];
        const rows = await this.rows();
        const active = (await this.pool.query("SELECT name FROM agent_definitions WHERE status<>'retired'")).rows;
        if (active.some(r => r.name !== omit && !rows.some(owned => owned.name === r.name)))
            throw new Error('Register every active agent before replacing the egress seal');
        for (const row of rows) {
            const d = defs.get(row.name);
            // The firewall accepts sources outside the generated inventory. Missing or corrupt
            // definitions therefore MUST block replacement, never silently drop a live source.
            if (row.state !== 'retired') {
                const parsed = definitionSchema.safeParse(d);
                if (!parsed.success || parsed.data.name !== row.name ||
                    !['chief-of-staff', 'travel', 'creative'].includes(parsed.data.role ?? ''))
                    throw new Error('Active resource has no usable matching definition; preserve the installed seal');
            }
            if (row.name === omit || (!includeRetired && row.state === 'retired'))
                continue;
            if (d && (!runtimeOnly || runtimeControlled(row)))
                agents.push(this.container(row, d));
        }
        return { defs, agents };
    }
    private async seal(override?: {
        name: string;
        definition: AgentDefinition;
    }, omit?: string) {
        const { agents, defs } = await this.render(override, omit), c = this.config;
        const e = generateEgress(agents.map(a => ({ name: a.name, address: a.address, grants: defs.get(a.name)!.grants, doors: a.doors.filter(d => d.kind === 'slack' || d.kind === 'telegram') as {
                kind: 'slack' | 'telegram';
                enabled: boolean;
            }[], infrastructureHosts: c.egress.infrastructureHosts })), c.egress);
        const stage = randomUUID();
        writeFileSync(join(c.egressDir, `${stage}.squid`), e.squid, { flag: 'wx', mode: 0o644 });
        writeFileSync(join(c.egressDir, `${stage}.nft`), e.nft, { flag: 'wx', mode: 0o644 });
        await this.docker.validateSquid(stage);
        await this.docker.firewall(stage, true);
        // Firewall transaction first. No start occurs until native validation, seal and proxy reload succeed.
        await this.docker.firewall(stage, false);
        atomic(join(c.egressDir, 'squid.conf'), e.squid, 0o644);
        await this.docker.reloadSquid();
    }
    private async connections(a: AgentContainer, apply: boolean): Promise<AgentContainer> {
        const result=await this.pool.query(`SELECT kind,principal,revision,owner_email,org,mailbox,applied_connection FROM agent_door_connections
          WHERE agent=$1 AND incarnation=$2::uuid AND principal IS NOT NULL
          `,[a.name,a.incarnation]);
        const rows=result.rows.map(c=>apply?c:c.applied_connection).filter(Boolean);
        a.claims=rows.filter(c=>c.kind!=='email'&&a.doors.some(d=>d.kind===c.kind&&d.enabled)).map(c=>({kind:c.kind,principal:c.principal,revision:c.revision,owner:c.owner_email}));
        if(a.doors.some(d=>d.kind==='email'&&d.enabled)) {
            const e=rows.find(c=>c.kind==='email'),config=this.config.runtime.google,client=config?.clients[e?.org];
            if(!e||!config||!client||e.principal!==config.principal)throw new KeeperRefusedError('Configure and select a Google mailbox before enabling email');
            const token=await this.pool.query("SELECT 1 FROM oauth_tokens WHERE principal=$1 AND provider='google' AND org_id=$2 AND email_address=$3",[e.principal,e.org,e.mailbox]);
            if(!token.rows.length)throw new KeeperRefusedError('Selected Google mailbox is no longer connected');
            a.email={principal:e.principal,org:e.org,mailbox:e.mailbox,revision:e.revision,owner:e.owner_email,tokenKeyFile:config.tokenKeyFile,...client};
        }
        return a;
    }
    private async publishCompose(override?: {
        name: string;
        definition: AgentDefinition;
    }, omit?: string) {
        const { agents } = await this.render(override, omit, true, true);
        // Keep applied door/role mounts for other pending agents: save must never restart them implicitly.
        const rows = await this.rows();
        for (let i = 0; i < agents.length; i++) {
            const row = rows.find(r => r.name === agents[i].name);
            if (row.applied_definition && agents[i].name !== override?.name)
                agents[i] = this.container(row, row.applied_definition);
        }
        for (let i=0;i<agents.length;i++) agents[i]=await this.connections(agents[i],agents[i].name===override?.name);
        atomic(this.config.composeFile, renderAgentsCompose(agents, { network: this.config.network, imageByRole: this.config.imageByRole, ...this.paths }));
        await this.docker.config();
    }
    async prepare(name: string, d: AgentDefinition, create: boolean) {
        // Preflight BEFORE definition writes. New database/address provision is later, after audited publication.
        this.gatewayKeyFile(name);
        for (const door of doorsOf(d))
            if (door.enabled) {
                if(!ROLE_DOORS[d.role??'']?.includes(door.kind))throw new KeeperRefusedError('This role does not support that door');
                if (door.kind === 'email') { if(d.role!=='chief-of-staff') throw new KeeperRefusedError('This role has no email adapter'); continue; }
                if (!(door.kind in DOOR_FILES))
                    throw new KeeperRefusedError('This door has no runnable adapter contract');
                for (const suffix of Object.values(DOOR_FILES[door.kind as keyof typeof DOOR_FILES])) {
                    let valid = false;
                    try {
                        const st = lstatSync(join(this.paths.secretsDir, `${name}-${suffix}`));
                        valid = st.isFile() && !st.isSymbolicLink() && st.size > 0;
                    }
                    catch { }
                    if (!valid)
                        throw new KeeperRefusedError('Enabled door requires its token and signing or webhook secret');
                }
            }
        const row = await this.storage.row(name);
        refusePendingRetirement(row);
        if (!create && !runtimeControlled(row))
            throw new KeeperRefusedError('Migrate existing resource ownership before saving');
        if (create && row)
            throw new KeeperRefusedError('Prior resources require reconciliation before name reuse');
        const candidate=this.container(row ?? { name, address: '192.0.2.2', workflow_database: 'lares_preflight' }, d);
        verifyBindingSources(candidate.bindings);
        if(doorsOf(d).some(x=>x.kind==='email'&&x.enabled))await this.connections(candidate,true);
    }
    async create(name: string, d: AgentDefinition) {
        const c = this.config, rows = await this.rows();
        const taken = [...await this.docker.inventory(c.network), ...c.reservedAddresses, ...c.egress.legacyConsumers.map(x => x.address), ...rows.map(r => String(r.address).split('/')[0])];
        await this.storage.provision(name, nextAddress(taken, c.subnet));
        return this.reconcile(name, d);
    }
    async saved(name: string, d: AgentDefinition) {
        const row = await this.storage.row(name);
        if (!runtimeControlled(row))
            throw new KeeperRefusedError('Migrate this existing agent runtime control before saving');
        refusePendingRetirement(row);
        await this.ensureGatewayKey(name);
        const pending = row.pending || !row.applied_definition || fingerprint(row.applied_definition) !== fingerprint(d) || row.state === 'provisioning';
        await this.pool.query('UPDATE agent_resources SET pending=$2,pending_reason=$3,updated_at=now() WHERE name=$1', [name, true, 'Egress reconciliation in progress']);
        try {
            await this.seal({ name, definition: d });
        }
        catch (error) {
            await this.docker.stop(name);
            throw error;
        }
        const reason = pending ? 'Apply connection changes (restarts agent)' : null;
        await this.pool.query('UPDATE agent_resources SET pending=$2,pending_reason=$3,updated_at=now() WHERE name=$1', [name, pending, reason]);
        return { pending, reason };
    }
    async reconcile(name: string, d: AgentDefinition) {
        let row = await this.storage.row(name);
        if (!runtimeControlled(row) || !['ready','provisioning'].includes(row.state) || (row.state === 'provisioning' && row.ownership !== 'owned'))
            throw new KeeperRefusedError('Active runtime control required for reconciliation');
        refusePendingRetirement(row);
        await this.ensureGatewayKey(name);
        if (row.state === 'provisioning')
            row = await this.storage.provision(name, String(row.address).split('/')[0]);
        if (row.state !== 'ready')
            throw new KeeperRefusedError('Only active resources can reconcile');
        await this.pool.query("UPDATE agent_resources SET pending=true,pending_reason='Runtime reconciliation in progress',updated_at=now() WHERE name=$1", [name]);
        const a = await this.connections(this.container(row, d),true);
        verifyBindingSources(a.bindings);
        this.verifySecrets(this.paths.secretsDir);
        const controlSecret = join(this.paths.secretsDir, `${name}-runtime-control`);
        try { const fd = openSync(controlSecret, 'wx', 0o600); try { writeFileSync(fd, randomBytes(32).toString('hex')); fsyncSync(fd); } finally { closeSync(fd); } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        this.provisionSecret(controlSecret);
        for (const path of [a.runtime.gatewayKeyFile, a.runtime.passwordFile, ...Object.values(a.bindings?.secrets ?? {}), ...(a.email?[a.email.tokenKeyFile,a.email.clientIdFile,a.email.clientSecretFile]:[]), ...a.doors.filter(d => d.enabled).flatMap(d => Object.values(DOOR_FILES[d.kind as keyof typeof DOOR_FILES] ?? {}).map(s => join(this.paths.secretsDir, `${name}-${s}`)))])
            this.provisionSecret(path);
        await this.publishCompose({ name, definition: d });
        await this.docker.stop(name); // Explicit action announces restart; no invented drain guarantee.
        await this.seal({ name, definition: d });
        await this.docker.start(name, a.address);
        await this.pool.query(`UPDATE agent_door_connections SET applied_revision=revision,applied_connection=jsonb_build_object('kind',kind,'principal',principal,'revision',revision,'owner_email',owner_email,'org',org,'mailbox',mailbox) WHERE agent=$1 AND incarnation=$2::uuid AND principal IS NOT NULL`,[name,row.ownership_token]);
        await this.pool.query('UPDATE agent_resources SET applied_definition=$2::jsonb,pending=false,pending_reason=NULL,updated_at=now() WHERE name=$1', [name, JSON.stringify(d)]);
        return { pending: false, reason: null };
    }
    async stop(name: string) {
        const row = await this.storage.row(name);
        if (!runtimeControlled(row) || !['ready', 'retired'].includes(row.state))
            throw new KeeperRefusedError('Only ready or interrupted retired resources can retire');
        // Persist intent before stopping. Until seal succeeds this remains a ready, sealed
        // source in other agents' renders. Only retrying retirement may complete this intent.
        await this.pool.query('UPDATE agent_resources SET pending=true,pending_reason=$2,updated_at=now() WHERE name=$1', [name, RETIREMENT_PENDING]);
        await this.docker.stop(name);
        await this.seal(undefined, name);
        await this.pool.query("UPDATE agent_resources SET state='retired',updated_at=now() WHERE name=$1", [name]);
        // Keep pending through the definition archive step; stop alone is not full retirement.
        // Retain the service in compose for explicit later removal; no unrelated service reconcile.
    }
    async retired(name: string) {
        await this.pool.query("UPDATE agent_resources SET pending=false,pending_reason=NULL,updated_at=now() WHERE name=$1 AND state='retired' AND pending_reason=$2", [name, RETIREMENT_PENDING]);
    }
    async prepareDelete(name: string, actor = 'keeper') {
        const plan = await this.storage.prepareDelete(name); // Prove ownership BEFORE removing container or touching files.
        await verifyCurrentStateSchema(this.pool);
        return { delete: async () => { await this.docker.remove(name); await this.removeGatewayKey(name); await plan.delete(); await deleteAgentCurrentState(this.pool,name,actor); await this.publishCompose(undefined, name); } };
    }
    async prepareSecretChange(name: string) {
        const row = await this.storage.row(name);
        if (!runtimeControlled(row) || row.state!=='ready')
            throw new KeeperRefusedError('Ready runtime control required for door setup');
        refusePendingRetirement(row);
    }
    async secretChanged(name: string) {
        await this.prepareSecretChange(name);
        await this.pool.query("UPDATE agent_resources SET pending=true,pending_reason='Apply connection changes (restarts agent)',updated_at=now() WHERE name=$1", [name]);
    }
    async deleted(name: string) { await this.pool.query("DELETE FROM agent_resources WHERE name=$1 AND state='deleting'", [name]); }
    async status(name: string) { const row = await this.storage.row(name); return row ? { pending: row.pending, reason: row.pending_reason } : { pending: true, reason: 'Ownership migration required' }; }
}
