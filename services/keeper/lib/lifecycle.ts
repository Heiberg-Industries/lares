import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { doorsOf, definitionSchema, type AgentDefinition } from '@lares/agent-kit/definition';
import { outsideHttpsHosts, outsideSecretName, outsideToolsInEffect } from '@lares/agent-kit/outside-tools';
import { CAPABILITY_DOCS } from '@lares/agent-kit/persona';
import { generateEgress } from './egress.js';
import { renderAgentsCompose, nextAddress, DOOR_FILES, ROLE_DOORS, type AgentContainer } from './compose-agents.js';
import { AgentNotHealthyError, NoOwnedContainerError, type DockerBoundary } from './docker.js';
import type { LifecycleConfig } from './lifecycle-config.js';
import { WorkflowStorage } from './workflow-storage.js';
import { KeeperRefusedError } from './actions.js';
import { verifyCurrentStateSchema, deleteAgentCurrentState } from './agent-current-state.js';
import { runtimeSecret, verifySecretRoot } from './secret-permissions.js';
import { personalReadSecretFiles, personalMicrosoftEnabled, verifyPersonalReadSecretSources } from './personal-microsoft.js';
import { personalGoogleConfig, personalGoogleEnabled } from './personal-google.js';
import { bindingsFor, verifyBindingSources, INTEGRATION_SECRET_FILES, isRetiredRole } from './runtime-bindings.js';
import { LiteLLMGatewayKeys, gatewayModels, type GatewayKeyProvisioner } from './gateway-keys.js';
import { readSetting } from './settings.js';
import { effectiveGrantedAgents, type CredentialRecord } from './credential-state.js';
function atomic(path: string, body: string, mode = 0o600) { const temp = `${path}.${randomUUID()}`; const fd = openSync(temp, 'wx', mode); try {
    writeFileSync(fd, body);
    fsyncSync(fd);
}
finally {
    closeSync(fd);
} renameSync(temp, path); }
const RETIREMENT_PENDING = 'Retirement pending; retry definition.retire';
/** In the egress folder: the stage whose nft file is the firewall last installed. Written only after nft applied it. */
const INSTALLED_STAGE = 'installed-stage';
function refusePendingRetirement(row: any): void {
    if (row?.pending && row.pending_reason === RETIREMENT_PENDING)
        throw new KeeperRefusedError('Retry definition.retire to complete pending retirement');
}
function runtimeControlled(row: any): boolean { return !!row?.runtime_control_token && row.runtime_control_token === row.ownership_token; }
/** Names of this definition's outside tools that need a token file. Only entries that take effect. */
function outsideTokensOf(d: AgentDefinition): { outsideTokens?: string[] } {
    const names = outsideToolsInEffect(d).filter(t => t.token).map(t => t.name);
    return names.length ? { outsideTokens: names } : {};
}
const outsideTokenFiles = (secretsDir: string, name: string, tokens?: readonly string[]) => (tokens ?? []).map(t => join(secretsDir, outsideSecretName(name, t)));
function fingerprint(d: AgentDefinition) { return createHash('sha256').update(JSON.stringify({ role: d.role, doors: doorsOf(d), personalGoogle: personalGoogleEnabled(d), personalMicrosoft: personalMicrosoftEnabled(d), ...outsideTokensOf(d) })).digest('hex'); }
/** All callers run within the audited definition action AND namespace advisory lock.
 * Partial failures leave resources and pending state for an explicit reconcile; never auto replay. */
export class AgentLifecycle {
    readonly storage: WorkflowStorage;
    private credentialState?: () => Promise<CredentialRecord>;
    setCredentialState(read: () => Promise<CredentialRecord>): void { this.credentialState = read; }
    private async notionRevision(): Promise<string | null | undefined> {
        const credential = await this.credentialState?.();
        return credential ? credential.effectiveRevision === undefined ? credential.activeRevision : credential.effectiveRevision : undefined;
    }
    /** Agents the owner switched on to receive the managed key (effective view, as notionRevision). */
    private async notionGranted(): Promise<ReadonlySet<string>> {
        return effectiveGrantedAgents(await this.credentialState?.());
    }
    /** True when installation configuration alone gives this agent the key (a revoke must not unmount it). */
    installationBindsNotion(name: string): boolean {
        const b = this.config.bindings?.[name] ?? this.config.defaultBindings?.['chief-of-staff'];
        return !!b?.secrets.NOTION_TOKEN_FILE;
    }
    constructor(private pool: Pool, admin: Pool, private config: LifecycleConfig, private paths: {
        agentsDir: string;
        secretsDir: string;
        vaultRuntimeDir?: string;
        credentials?: { administrator?: string };
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
    private container(row: any, d: AgentDefinition, notionRevision?: string | null, granted: ReadonlySet<string> = new Set()): AgentContainer {
        const c = this.config, r = c.runtime;
        const url = new URL(r.workflowServer);
        url.pathname = `/${row.workflow_database}`;
        const gatewayKeyFile = this.gatewayKeyFile(row.name);
        const role = d.role!;
        const roleDefault = role === 'chief-of-staff' || role === 'creative'
            ? c.defaultBindings?.[role]
            : undefined;
        let binding = c.bindings?.[row.name] ?? roleDefault;
        // The owner's switch adds the managed key to the agent's own binding. Installation config wins:
        // a configured key is never replaced or removed here, and a missing base binding is never invented.
        if (granted.has(row.name) && role === 'chief-of-staff' && !binding?.secrets.NOTION_TOKEN_FILE) {
            if (!binding)
                throw new KeeperRefusedError('A granted agent needs an installation runtime binding');
            if (notionRevision)
                binding = { ...binding, secrets: { ...binding.secrets, NOTION_TOKEN_FILE: join(this.paths.secretsDir, INTEGRATION_SECRET_FILES.NOTION_TOKEN_FILE) } };
        }
        const personalGoogle = personalGoogleEnabled(d) ? personalGoogleConfig(r.google) : undefined;
        const personalMicrosoft = personalMicrosoftEnabled(d) ? r.microsoft : undefined;
        const managedRevision = binding?.secrets.NOTION_TOKEN_FILE ? notionRevision : undefined;
        if (binding?.secrets.NOTION_TOKEN_FILE && notionRevision === null) {
            const { NOTION_TOKEN_FILE: _, ...secrets } = binding.secrets;
            binding = { ...binding, secrets };
        }
        return { name: row.name, incarnation: row.ownership_token, role, notionRevision: managedRevision, bindings: bindingsFor(role, binding), address: String(row.address).split('/')[0], doors: doorsOf(d), ...(personalGoogle ? { personalGoogle } : {}), ...(personalMicrosoft ? { personalMicrosoft } : {}), ...outsideTokensOf(d), runtime: { databaseUrl: r.databaseUrl, workflowUrl: url.toString(), gatewayUrl: r.gatewayUrl, proxyUrl: r.proxyUrl, schedulesLive: r.schedulesLive, gatewayKeyFile, passwordFile: r.passwordFile, endpoints: c.egress.endpoints } };
    }
    private async render(override?: {
        name: string;
        definition: AgentDefinition;
    }, omit?: string, includeRetired = false, runtimeOnly = false) {
        const defs = await this.definitions();
        if (override)
            defs.set(override.name, override.definition);
        const agents: AgentContainer[] = [];
        const notionRevision = await this.notionRevision();
        const granted = await this.notionGranted();
        const rows = await this.rows();
        const active = (await this.pool.query("SELECT name FROM agent_definitions WHERE status<>'retired'")).rows;
        if (active.some(r => r.name !== omit && !rows.some(owned => owned.name === r.name)))
            throw new Error('Register every active agent before replacing the egress seal');
        for (const row of rows) {
            const d = defs.get(row.name);
            if (isRetiredRole(d?.role) || isRetiredRole(row.applied_definition?.role)) {
                console.warn(`keeper: skipping agent ${row.name}: its role is no longer part of the engine; it is not managed here (list its address under egress.legacyConsumers if it keeps running elsewhere)`);
                continue;
            }
            // The firewall accepts sources outside the generated inventory. Missing or corrupt
            // definitions therefore MUST block replacement, never silently drop a live source.
            if (row.state !== 'retired') {
                const parsed = definitionSchema.safeParse(d);
                if (!parsed.success || parsed.data.name !== row.name ||
                    !['chief-of-staff', 'creative'].includes(parsed.data.role ?? ''))
                    throw new Error('Active resource has no usable matching definition; preserve the installed seal');
            }
            if (row.name === omit || (!includeRetired && row.state === 'retired'))
                continue;
            if (d && (!runtimeOnly || runtimeControlled(row)))
                agents.push(this.container(row, d, notionRevision, granted));
        }
        return { defs, agents };
    }
    /** The agent being saved may not grant a retired capability: refuse by name, before anything is stored. */
    private refuseUnknownGrants(name: string, d: AgentDefinition) {
        const old = d.grants.find(g => !Object.hasOwn(CAPABILITY_DOCS, g.capability));
        if (old)
            throw new KeeperRefusedError(`Agent ${name} grants ${old.capability}, which this version no longer has; remove or replace it before saving`);
    }
    /** Side-effect-free: builds the whole allow-list or throws, BEFORE anything is stored, marked or stopped.
     * Other agents' retired grants give them no hosts (logged); the saved agent's own grants stay strict. */
    private async plan(override?: {
        name: string;
        definition: AgentDefinition;
    }, omit?: string) {
        if (override)
            this.refuseUnknownGrants(override.name, override.definition);
        const { agents, defs } = await this.render(override, omit), c = this.config;
        const e = generateEgress(agents.map(a => ({ name: a.name, address: a.address, grants: defs.get(a.name)!.grants, doors: a.doors.filter(d => d.kind === 'slack' || d.kind === 'telegram') as {
                kind: 'slack' | 'telegram';
                enabled: boolean;
            }[], infrastructureHosts: c.egress.infrastructureHosts, outsideHosts: outsideHttpsHosts(outsideToolsInEffect(defs.get(a.name)!)) })),
            { ...c.egress, tolerateUnknownGrantsFor: new Set(agents.map(a => a.name).filter(n => n !== override?.name)) });
        for (const s of e.skipped)
            console.warn(`keeper: agent ${s.agent} still grants ${s.capability}; it opens no network hosts until the agent is saved in the new style`);
        return e;
    }
    private async seal(override?: {
        name: string;
        definition: AgentDefinition;
    }, omit?: string) {
        await this.apply(await this.plan(override, omit));
    }
    private async apply(e: ReturnType<typeof generateEgress>) {
        await this.resealing; // Never interleave with the startup re-apply: it must not overwrite a newer seal.
        const c = this.config;
        const stage = randomUUID();
        writeFileSync(join(c.egressDir, `${stage}.squid`), e.squid, { flag: 'wx', mode: 0o644 });
        writeFileSync(join(c.egressDir, `${stage}.nft`), e.nft, { flag: 'wx', mode: 0o644 });
        await this.docker.validateSquid(stage);
        await this.docker.firewall(stage, true);
        // Firewall transaction first. No start occurs until native validation, seal and proxy reload succeed.
        await this.docker.firewall(stage, false);
        atomic(join(c.egressDir, INSTALLED_STAGE), `${stage}\n`, 0o644);
        atomic(join(c.egressDir, 'squid.conf'), e.squid, 0o644);
        await this.docker.reloadSquid();
    }
    private resealing: Promise<void> = Promise.resolve();
    /** Startup: a reboot empties the kernel's nft tables, so re-apply the last firewall this keeper
     * installed, unchanged. Not a fresh render: that reads the database, and a definition gone invalid
     * would block it. The proxy needs nothing; it reads squid.conf from disk when it starts. One
     * attempt; never throws. On failure it logs one line and the next agent change seals afresh. */
    resealAtStart(): Promise<void> {
        this.resealing = (async () => {
            const dir = this.config.egressDir;
            const read = (file: string, missing: string) => {
                try { return readFileSync(join(dir, file), 'utf8'); }
                catch (error) { throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? missing : `${file} is unreadable`); }
            };
            let stage: string;
            try {
                stage = read(INSTALLED_STAGE, 'no firewall is on record yet').trim();
                if (!/^[a-f0-9-]{36}$/.test(stage)) throw new Error(`${INSTALLED_STAGE} does not name a stage`);
                const nft = read(`${stage}.nft`, `the recorded ${stage}.nft is missing`);
                // An installed table without a drop rule seals no source: never re-apply an empty seal.
                if (!nft.includes('table inet lares_egress {') || !/^\s*counter drop$/m.test(nft)) throw new Error('the recorded firewall seals no agent');
            }
            catch (error) {
                console.error(`keeper: nothing to re-apply for the outbound firewall at startup (${(error as Error).message}); nothing was changed, the next agent change installs it`);
                return;
            }
            try {
                await this.docker.firewall(stage, true);
                await this.docker.firewall(stage, false);
                console.log('keeper: re-applied the installed outbound firewall at startup');
            }
            catch (error) {
                console.error(`keeper: could not re-apply the outbound firewall at startup (${(error as Error).message}); agents run without it until the next agent change`);
            }
        })();
        return this.resealing;
    }
    private async connections(a: AgentContainer, apply: boolean): Promise<AgentContainer> {
        const result=await this.pool.query(`SELECT kind,principal,revision,owner_email,org,mailbox,applied_connection FROM agent_door_connections
          WHERE agent=$1 AND incarnation=$2::uuid AND principal IS NOT NULL
          ORDER BY claimed_at NULLS LAST,kind`,[a.name,a.incarnation]);
        const rows=result.rows.map(c=>apply?c:c.applied_connection).filter(Boolean);
        a.claims=rows.filter(c=>c.kind!=='email'&&a.doors.some(d=>d.kind===c.kind&&d.enabled)).map(c=>({kind:c.kind,principal:c.principal,revision:c.revision,owner:c.owner_email}));
        if(a.doors.some(d=>d.kind==='email'&&d.enabled)) {
            const e=rows.find(c=>c.kind==='email'),config=this.config.runtime.google,client=config?.clients[e?.org];
            if(!e||!config||!client||e.principal!==config.principal)throw new KeeperRefusedError('Configure and select a Google mailbox before enabling email');
            const token=await this.pool.query("SELECT 1 FROM oauth_tokens t WHERE principal=$1 AND provider='google' AND org_id=$2 AND email_address=$3 AND NOT EXISTS(SELECT 1 FROM connected_account_credentials c WHERE c.oauth_token_id=t.id)",[e.principal,e.org,e.mailbox]);
            if(!token.rows.length)throw new KeeperRefusedError('Selected Google mailbox is no longer connected');
            a.email={principal:e.principal,org:e.org,mailbox:e.mailbox,revision:e.revision,owner:e.owner_email,tokenKeyFile:config.tokenKeyFile,...client};
        }
        verifyPersonalReadSecretSources(a);
        // One approver per agent: the owner of the earliest claim among the connections in use.
        // The rows are already in claim order, so this is the same answer whatever order they arrive in.
        const used=rows.filter(c=>c.kind==='email'?!!a.email:a.claims!.some(x=>x.kind===c.kind));
        a.consoleOwner=used[0]?.owner_email;
        return a;
    }
    /** The prefix every agent derives its purpose model names from (LARES_MODEL_PREFIX). No fallback name. */
    private async modelPrefix(): Promise<string> {
        const setting = await readSetting(this.pool, 'models.alias_prefix');
        try {
            if (typeof setting !== 'string') throw new Error('missing');
            gatewayModels(setting);
            return setting;
        }
        catch { throw new KeeperRefusedError('Set models.alias_prefix (the gateway\'s model-name prefix) before starting agents'); }
    }
    private async publishCompose(override?: {
        name: string;
        definition: AgentDefinition;
    }, omit?: string) {
        const modelPrefix = await this.modelPrefix();
        const { agents } = await this.render(override, omit, true, true);
        // Keep applied door/role mounts for other pending agents: save must never restart them implicitly.
        const rows = await this.rows();
        const granted = await this.notionGranted();
        for (let i = 0; i < agents.length; i++) {
            const row = rows.find(r => r.name === agents[i].name);
            if (row.applied_definition && agents[i].name !== override?.name)
                agents[i] = this.container(row, row.applied_definition, agents[i]!.notionRevision, granted);
        }
        for (let i=0;i<agents.length;i++) agents[i]=await this.connections(agents[i],agents[i].name===override?.name);
        atomic(this.config.composeFile, renderAgentsCompose(agents, { network: this.config.network, imageByRole: this.config.imageByRole, agentsDir: this.paths.agentsDir, secretsDir: this.paths.secretsDir, vaultRuntimeDir: this.paths.vaultRuntimeDir, modelPrefix, consoleAdministrator: this.paths.credentials?.administrator }));
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
                        throw new KeeperRefusedError(door.kind === 'slack'
                            ? 'Slack needs a bot token and a signing secret before it can be turned on. Save the credentials first.'
                            : 'Telegram needs a bot token before it can be turned on. Save the credentials first.');
                }
            }
        const row = await this.storage.row(name);
        refusePendingRetirement(row);
        if (!create && !runtimeControlled(row))
            throw new KeeperRefusedError('Migrate existing resource ownership before saving');
        if (create && row)
            throw new KeeperRefusedError('Prior resources require reconciliation before name reuse');
        const candidate=this.container(row ?? { name, address: '192.0.2.2', workflow_database: 'lares_preflight' }, d, await this.notionRevision(), await this.notionGranted());
        verifyBindingSources(candidate.bindings);
        if(doorsOf(d).some(x=>x.kind==='email'&&x.enabled))await this.connections(candidate,true);
        verifyPersonalReadSecretSources(candidate);
        // Build the allow-list now so a refusal happens before the definition is stored. A new agent has no resource row yet.
        if (create) this.refuseUnknownGrants(name, d); else await this.plan({ name, definition: d });
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
        // Before any stop: a list that cannot be built changes no rule, so the agent keeps running its applied definition.
        const plan = await this.plan({ name, definition: d }).catch(async error => {
            if (!(error instanceof KeeperRefusedError)) await this.pool.query('UPDATE agent_resources SET pending=true,pending_reason=$2,updated_at=now() WHERE name=$1', [name, 'Egress list could not be built; nothing was changed']);
            throw error;
        });
        const pending = row.pending || !row.applied_definition || fingerprint(row.applied_definition) !== fingerprint(d) || row.state === 'provisioning';
        await this.pool.query('UPDATE agent_resources SET pending=$2,pending_reason=$3,updated_at=now() WHERE name=$1', [name, true, 'Egress reconciliation in progress']);
        try {
            await this.apply(plan);
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
        await this.modelPrefix(); // Refuse before anything is marked, published or stopped.
        const plan = await this.plan({ name, definition: d }); // Before pending, publish and stop: an unbuildable list must not take the agent down.
        await this.pool.query("UPDATE agent_resources SET pending=true,pending_reason='Runtime reconciliation in progress',updated_at=now() WHERE name=$1", [name]);
        const a = await this.connections(this.container(row, d, await this.notionRevision(), await this.notionGranted()),true);
        verifyBindingSources(a.bindings);
        verifyPersonalReadSecretSources(a);
        this.verifySecrets(this.paths.secretsDir);
        const controlSecret = join(this.paths.secretsDir, `${name}-runtime-control`);
        try { const fd = openSync(controlSecret, 'wx', 0o600); try { writeFileSync(fd, randomBytes(32).toString('hex')); fsyncSync(fd); } finally { closeSync(fd); } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        this.provisionSecret(controlSecret);
        for (const path of [a.runtime.gatewayKeyFile, a.runtime.passwordFile, ...Object.values(a.bindings?.secrets ?? {}), ...personalReadSecretFiles(a), ...a.doors.filter(d => d.enabled).flatMap(d => Object.values(DOOR_FILES[d.kind as keyof typeof DOOR_FILES] ?? {}).map(s => join(this.paths.secretsDir, `${name}-${s}`))), ...outsideTokenFiles(this.paths.secretsDir, name, a.outsideTokens)])
            this.provisionSecret(path);
        await this.publishCompose({ name, definition: d });
        await this.docker.stop(name); // Explicit action announces restart; no invented drain guarantee.
        await this.apply(plan);
        // Applied is recorded once stop and the egress seal both succeeded and before start: the container that starts is exactly this setup.
        await this.pool.query(`UPDATE agent_door_connections SET applied_revision=revision,applied_connection=jsonb_build_object('kind',kind,'principal',principal,'revision',revision,'owner_email',owner_email,'org',org,'mailbox',mailbox) WHERE agent=$1 AND incarnation=$2::uuid AND principal IS NOT NULL`,[name,row.ownership_token]);
        await this.pool.query('UPDATE agent_resources SET applied_definition=$2::jsonb,pending=false,pending_reason=NULL,updated_at=now() WHERE name=$1', [name, JSON.stringify(d)]);
        try { await this.docker.start(name, a.address, false, 15); }
        catch (error) {
            // A slow first start is not a failed apply: the console reads live status and shows "not answering yet".
            if (error instanceof AgentNotHealthyError) return { pending: false, reason: null, running: true, healthy: false };
            throw error;
        }
        return { pending: false, reason: null, running: true, healthy: true };
    }
    /** No provisioning, provider access, claim application or definition writes. Uses the
     * existing compose, seals and private health route for one already-owned ready runtime. */
    async credentialPreflight(names: string[]): Promise<void> {
        await this.plan();
        this.verifySecrets(this.paths.secretsDir);
        for (const name of names) {
            const row = await this.storage.row(name);
            if (!runtimeControlled(row) || row.state !== 'ready' || row.pending || !row.applied_definition)
                throw new KeeperRefusedError('Ready applied runtime required');
            this.refuseUnknownGrants(name, row.applied_definition);
            const a = await this.connections(this.container(row, row.applied_definition, null, await this.notionGranted()), false);
            verifyBindingSources(a.bindings);
            for (const path of [a.runtime.gatewayKeyFile, a.runtime.passwordFile, join(this.paths.secretsDir, `${name}-runtime-control`),
                ...Object.values(a.bindings?.secrets ?? {}), ...personalReadSecretFiles(a),
                ...a.doors.filter(d => d.enabled).flatMap(d => Object.values(DOOR_FILES[d.kind as keyof typeof DOOR_FILES] ?? {}).map(s => join(this.paths.secretsDir, `${name}-${s}`))), ...outsideTokenFiles(this.paths.secretsDir, name, a.outsideTokens)]) {
                const st = lstatSync(path);
                if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !st.size) throw new KeeperRefusedError('Existing runtime secrets unavailable');
            }
        }
    }
    async reconcileCredential(name: string, revision: string | null): Promise<void> {
        const record = await this.credentialState?.();
        const grantOp = !!record?.activationIntent?.grantChange;
        // A grant change keeps the active key and moves only who is bound; the per-agent revision is
        // decided by container() from the effective grants the activation journaled.
        if (!record?.activationIntent || (grantOp ? record.effectiveGrants === undefined : record.effectiveRevision !== revision))
            throw new KeeperRefusedError('Credential activation intent required');
        const row = await this.storage.row(name);
        if (!runtimeControlled(row) || row.state !== 'ready' || row.pending || !row.applied_definition)
            throw new KeeperRefusedError('Ready applied runtime required');
        const plan = await this.plan();
        if (revision || grantOp && record.activeRevision) this.provisionSecret(join(this.paths.secretsDir, 'notion-token'));
        await this.publishCompose();
        await this.docker.stop(name);
        await this.apply(plan);
        await this.docker.start(name, String(row.address).split('/')[0], true);
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
    /** status plus what the container is doing now. Never throws because of Docker: unknown is null. */
    async liveStatus(name: string) {
        const base = await this.status(name);
        const row = await this.storage.row(name);
        let running: boolean | null = null, healthy: boolean | null = null;
        if (row && this.docker.inspect) {
            try {
                running = (await this.docker.inspect(name)).running;
                if (running && this.docker.healthy) healthy = await this.docker.healthy(String(row.address).split('/')[0]!);
            }
            catch (error) {
                // Only an absent container means stopped; a Docker failure or an ambiguous inventory is unknown.
                healthy = null;
                if (running === null && error instanceof NoOwnedContainerError) running = false;
            }
        }
        return { ...base, running, healthy };
    }
}
