import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { doorsOf, definitionSchema, hashOf, readDefinitionFiles, type AgentDefinition, type DefinitionFileContents } from '@lares/agent-kit/definition';
import { outsideHttpsHosts, outsideToolsInEffect } from '@lares/agent-kit/outside-tools';
import { CAPABILITY_DOCS } from '@lares/agent-kit/persona';
import { generateEgress } from './egress.js';
import { renderAgentsCompose, nextAddress, DOOR_FILES, ROLE_DOORS, type AgentContainer } from './compose-agents.js';
import { AgentNotHealthyError, NoOwnedContainerError, type DockerBoundary } from './docker.js';
import type { LifecycleConfig } from './lifecycle-config.js';
import type { KeeperConfig } from './config.js';
import { WorkflowStorage } from './workflow-storage.js';
import type { WorkflowDatabaseConnections, WorkflowPrivilegeContract } from './workflow-storage.js';
import { keeperPool } from './config.js';
import { KeeperRefusedError } from './actions.js';
import { verifyCurrentStateSchema, deleteAgentCurrentState } from './agent-current-state.js';
import { runtimeSecret, verifySecretRoot } from './secret-permissions.js';
import { personalReadSecretFiles, personalMicrosoftEnabled, verifyPersonalReadSecretSources } from './personal-microsoft.js';
import { personalGoogleConfig, personalGoogleEnabled } from './personal-google.js';
import { bindingsFor, verifyBindingSources, INTEGRATION_SECRET_FILES, isRetiredRole } from './runtime-bindings.js';
import { LiteLLMGatewayKeys, gatewayModels, type GatewayKeyProvisioner } from './gateway-keys.js';
import { readSetting } from './settings.js';
import { effectiveGrantedAgents, type CredentialRecord } from './credential-state.js';
import { requireDefinitionNamespace, withDefinitionNamespace } from './definition-namespace.js';
import { clearFirstActivation, clearUnknownApplyBaseline, recordAppliedDefinition } from './definition-files.js';
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
const OUTSIDE_ROUTE_ATTEMPT = 'discovery-route-attempt';
export type OutsideRouteReview = { readonly policyHash: string; readonly sourceAddress: string; readonly proxyUrl: string };
export type OutsideRouteLease = { assertCurrent(): Promise<OutsideRouteReview> };
export type NativeRuntimeIdentity = { agent: string; incarnation: string; definitionHash: string; purposeAlias: string };
export type NativeRuntimeState = { state: 'active' } | { state: 'held'; reason: 'Native budget activation required' };
export type NativeRuntimeAuthority = { current(identity: NativeRuntimeIdentity): Promise<NativeRuntimeState> };
const NATIVE_HELD = 'Native budget activation required' as const;
function refusePendingRetirement(row: any): void {
    if (row?.pending && row.pending_reason === RETIREMENT_PENDING)
        throw new KeeperRefusedError('Retry definition.retire to complete pending retirement');
}
function runtimeControlled(row: any): boolean { return !!row?.runtime_control_token && row.runtime_control_token === row.ownership_token; }
function fingerprint(d: AgentDefinition) { return createHash('sha256').update(JSON.stringify({ role: d.role, doors: doorsOf(d), personalGoogle: personalGoogleEnabled(d), personalMicrosoft: personalMicrosoftEnabled(d) })).digest('hex'); }
/** All callers run within the audited definition action AND namespace advisory lock.
 * Partial failures leave resources and pending state for an explicit reconcile; never auto replay. */
export class AgentLifecycle {
    readonly storage: WorkflowStorage;
    private credentialState?: () => Promise<CredentialRecord>;
    private get nativeGuarded(): boolean { return this.paths.mode === 'rendered' || this.nativeAuthority !== undefined; }
    setCredentialState(read: () => Promise<CredentialRecord>): void { this.credentialState = read; }
    private async notionRevision(): Promise<string | null | undefined> {
        const credential = await this.credentialState?.();
        return credential ? credential.effectiveRevision === undefined ? credential.activeRevision : credential.effectiveRevision : undefined;
    }
    /** Agents the owner switched on to receive the managed key (effective view, as notionRevision). */
    private async notionGranted(): Promise<ReadonlySet<string>> {
        return effectiveGrantedAgents(await this.credentialState?.());
    }
    private async definitionFiles(name: string): Promise<DefinitionFileContents | null> {
        const dir = join(this.paths.agentsDir, name);
        try { lstatSync(dir); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        return readDefinitionFiles(dir);
    }
    private async recordSuccessfulDefinitionStart(name: string, before: DefinitionFileContents | null,
        result: { running?: boolean; healthy?: boolean | null }): Promise<void> {
        if (!before || result.running !== true || result.healthy !== true) return;
        const after = await this.definitionFiles(name);
        if (!after || !isDeepStrictEqual(before, after))
            throw new KeeperRefusedError('Definition files changed while the runtime was starting; applied generation is unknown');
        recordAppliedDefinition(join(this.paths.agentsDir, name), before);
        clearFirstActivation(join(this.paths.agentsDir, name));
        clearUnknownApplyBaseline(join(this.paths.agentsDir, name));
    }
    /** True when installation configuration alone gives this agent the key (a revoke must not unmount it). */
    installationBindsNotion(name: string): boolean {
        const b = this.config.bindings?.[name] ?? this.config.defaultBindings?.['chief-of-staff'];
        return !!b?.secrets.NOTION_TOKEN_FILE;
    }
    constructor(private pool: Pool, admin: Pool, private config: LifecycleConfig, private paths: {
        mode: 'overlay' | 'rendered';
        agentsDir: string;
        secretsDir: string;
        vaultRuntimeDir?: string;
        modelPurposeRuntimeDir?: string;
        outsideCustody?: KeeperConfig['outsideCustody'];
        credentials?: { administrator?: string };
    }, private docker: DockerBoundary, private provisionSecret = runtimeSecret, private verifySecrets = verifySecretRoot,
    private gatewayKeyProvisioner: GatewayKeyProvisioner = new LiteLLMGatewayKeys(),
    workflowConnections?: WorkflowDatabaseConnections,
    workflowPrivileges?: WorkflowPrivilegeContract,
    private nativeAuthority?: NativeRuntimeAuthority) {
        const runtimeUrl = new URL(config.runtime.workflowServer);
        const connections: WorkflowDatabaseConnections = workflowConnections ?? {
            provisioner: database => keeperPool({ ...config.adminDb, database }),
            runtime: database => keeperPool({ host: runtimeUrl.hostname, port: Number(runtimeUrl.port || 5432), database, user: 'lares_workflow', passwordFile: config.runtime.workflowPasswordFile }),
        };
        this.storage = new WorkflowStorage(pool, admin, config.workflowTemplate, config.workflowOwner, connections, workflowPrivileges);
    }
    private gatewayKeyFile(name: string): string {
        const exact = this.config.runtime.gatewayKeys[name];
        if (exact) return exact;
        if (this.config.runtime.gatewayMasterKeyFile) return join(this.paths.secretsDir, `${name}-gateway-key`);
        throw new KeeperRefusedError('Installation must supply or manage this agent gateway key');
    }
    private async currentNative(name: string): Promise<NativeRuntimeState> {
        if (!this.nativeGuarded) return { state: 'active' };
        if (!this.nativeAuthority) return { state: 'held', reason: NATIVE_HELD };
        try {
            const result = await this.pool.query(`SELECT d.definition,d.duties,d.voice,d.hash,d.status,
                    r.ownership_token,r.runtime_control_token,r.state,r.pending,r.applied_definition
                FROM agent_definitions d LEFT JOIN agent_resources r ON r.name=d.name WHERE d.name=$1`, [name]);
            const row = result.rows[0];
            if (!row || !row.definition || typeof row.duties !== 'string' || typeof row.voice !== 'string' ||
                row.status !== 'valid' || typeof row.ownership_token !== 'string' ||
                row.runtime_control_token !== row.ownership_token || row.state !== 'ready' || row.pending !== false ||
                !row.applied_definition || JSON.stringify(row.applied_definition) !== JSON.stringify(row.definition))
                return { state: 'held', reason: NATIVE_HELD };
            const definition = definitionSchema.parse(row.definition);
            const definitionHash = hashOf({ definition, dutiesMd: row.duties, voiceMd: row.voice });
            if (row.hash !== definitionHash || definition.role !== 'chief-of-staff' || typeof definition.model !== 'string')
                return { state: 'held', reason: NATIVE_HELD };
            const identity: NativeRuntimeIdentity = {
                agent: name,
                incarnation: row.ownership_token,
                definitionHash,
                purposeAlias: definition.model,
            };
            const current = await this.nativeAuthority.current(identity);
            return current?.state === 'active' ? { state: 'active' } : { state: 'held', reason: NATIVE_HELD };
        } catch {
            return { state: 'held', reason: NATIVE_HELD };
        }
    }
    private async refuseUnsupportedNativeInventory(): Promise<void> {
        if (!this.nativeGuarded) return;
        const rows = await this.pool.query(`SELECT d.name,d.status,d.definition,r.state,r.applied_definition,
                r.ownership_token,r.runtime_control_token
            FROM agent_definitions d LEFT JOIN agent_resources r ON r.name=d.name
            WHERE d.status<>'retired' OR r.name IS NOT NULL`);
        for (const row of rows.rows) {
            const current = definitionSchema.safeParse(row.definition);
            const applied = row.applied_definition == null ? undefined : definitionSchema.safeParse(row.applied_definition);
            if (isRetiredRole(current.success ? current.data.role : undefined) ||
                isRetiredRole(applied?.success ? applied.data.role : undefined)) continue;
            if (row.state === 'deleting') {
                if (row.status !== 'retired')
                    throw new KeeperRefusedError('Rendered native lifecycle cannot publish while an existing runtime needs a separate migration');
                continue;
            }
            // publishCompose renders retained retired rows too. It only adds rows with
            // runtime-control ownership to the Compose file, but that final render would
            // still reject a retained Creative container after definition publication.
            if (row.state === 'retired' && !runtimeControlled(row)) continue;
            if (row.state == null) {
                if (row.status !== 'retired')
                    throw new KeeperRefusedError('Rendered native lifecycle cannot publish while an existing runtime needs a separate migration');
                continue;
            }
            if (!current.success || current.data.role !== 'chief-of-staff' ||
                applied && (!applied.success || applied.data.role !== 'chief-of-staff'))
                throw new KeeperRefusedError('Rendered native lifecycle cannot publish while an existing runtime needs a separate migration');
        }
    }
    private async startWithCurrentAuthority(name: string, address: string, credential = false) {
        if (this.nativeGuarded) {
            const before = await this.currentNative(name);
            if (before.state !== 'active') {
                if (credential) throw new KeeperRefusedError(NATIVE_HELD);
                return { pending: false, reason: NATIVE_HELD, running: false, healthy: null } as const;
            }
        }
        let startError: unknown;
        let unhealthy = false;
        try {
            if (credential) await this.docker.start(name, address, true);
            else await this.docker.start(name, address, false, 15);
        }
        catch (error) {
            startError = error;
            unhealthy = error instanceof AgentNotHealthyError;
            if (!this.nativeGuarded) {
                if (credential || !unhealthy) throw error;
            }
        }
        if (this.nativeGuarded) {
            const after = await this.currentNative(name);
            if (after.state !== 'active') {
                try { await this.docker.stop(name); }
                catch (error) { throw new Error('Native runtime authority changed during start and the owned runtime could not be stopped', { cause: error }); }
                if (credential) throw new KeeperRefusedError(NATIVE_HELD);
                return { pending: false, reason: NATIVE_HELD, running: false, healthy: null } as const;
            }
        }
        if (startError !== undefined) {
            if (credential || !unhealthy) throw startError;
        }
        return { pending: false, reason: null, running: true, healthy: unhealthy ? false : true } as const;
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
        if (this.nativeGuarded) return;
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
        if (this.nativeGuarded) return [];
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
        const role = d.role!;
        if (this.nativeGuarded && role !== 'chief-of-staff')
            throw new KeeperRefusedError('Native budget activation is supported only for the chief of staff runtime');
        const gatewayKeyFile = this.nativeGuarded ? undefined : this.gatewayKeyFile(row.name);
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
        return { name: row.name, incarnation: row.ownership_token, role, notionRevision: managedRevision, bindings: bindingsFor(role, binding), address: String(row.address).split('/')[0], doors: doorsOf(d), ...(personalGoogle ? { personalGoogle } : {}), ...(personalMicrosoft ? { personalMicrosoft } : {}), runtime: { databaseUrl: r.databaseUrl, workflowUrl: url.toString(), gatewayUrl: r.gatewayUrl, proxyUrl: r.proxyUrl, schedulesLive: r.schedulesLive, ...(gatewayKeyFile ? { gatewayKeyFile } : {}), passwordFile: r.passwordFile, workflowPasswordFile: r.workflowPasswordFile, endpoints: c.egress.endpoints } };
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
        await withDefinitionNamespace(this.pool, async () => {
            const c = this.config;
            const stage = randomUUID();
            this.outsideRouteReady = undefined;
            const selected = this.outsideConsumer();
            if (selected && e.squid.split('http_access deny all').length !== 2)
                throw new KeeperRefusedError('Outside route policy is unavailable');
            const squid = selected ? e.squid.replace('http_access deny all', `reply_header_add X-Lares-Route-Stage ${stage} all\nhttp_access deny all`) : e.squid;
            if (selected) atomic(join(c.egressDir, OUTSIDE_ROUTE_ATTEMPT), `${stage}\n`, 0o644);
            writeFileSync(join(c.egressDir, `${stage}.squid`), squid, { flag: 'wx', mode: 0o644 });
            writeFileSync(join(c.egressDir, `${stage}.nft`), e.nft, { flag: 'wx', mode: 0o644 });
            await this.docker.validateSquid(stage);
            await this.docker.firewall(stage, true);
            // Firewall transaction first. No start occurs until native validation, seal and proxy reload succeed.
            await this.docker.firewall(stage, false);
            atomic(join(c.egressDir, INSTALLED_STAGE), `${stage}\n`, 0o644);
            atomic(join(c.egressDir, 'squid.conf'), squid, 0o644);
            await this.docker.reloadSquid();
            if (selected) {
                const deadlineAtMs = Date.now() + 1000;
                if (!this.docker.acknowledgeOutsideStage) throw new KeeperRefusedError('Outside route acknowledgement is unavailable');
                await this.docker.acknowledgeOutsideStage(stage, selected.address, c.runtime.proxyUrl, deadlineAtMs);
                this.outsideRouteReady = { epoch: this.outsideControllerEpoch, stage, sourceAddress: selected.address,
                    squidHash: createHash('sha256').update(squid).digest('hex'), nftHash: createHash('sha256').update(e.nft).digest('hex'),
                    basePolicyHash: this.outsideBasePolicyHash(e, selected) };
            }
        });
    }
    private readonly outsideControllerEpoch = randomUUID();
    private outsideRouteReady?: { epoch: string; stage: string; sourceAddress: string; squidHash: string; nftHash: string; basePolicyHash: string };
    private readonly outsideRouteLeases = new WeakMap<object, { active: boolean; destination: string; policyHash: string; sourceAddress: string; proxyUrl: string; epoch: string; stage: string; deadlineAtMs: number; namespaceClient: ReturnType<typeof requireDefinitionNamespace> }>();
    private outsideConsumer(): { name: string; address: string; hosts: readonly string[] } | undefined {
        const selected = this.paths.outsideCustody;
        if (!selected) return undefined;
        const matches = this.config.egress.legacyConsumers.filter(consumer => consumer.name === selected.routeConsumerName);
        if (matches.length !== 1 || isIP(matches[0]!.address) !== 4)
            throw new KeeperRefusedError('Outside route source is unavailable');
        return matches[0];
    }
    private outsideBasePolicyHash(e: ReturnType<typeof generateEgress>, consumer: { name: string; address: string; hosts: readonly string[] }): string {
        return createHash('sha256').update(JSON.stringify(['lares-outside-route-v1', consumer.name, consumer.address,
            [...new Set(consumer.hosts)].sort(), this.config.runtime.proxyUrl, e.squid, e.nft])).digest('hex');
    }
    private destinationPolicy(destination: string, basePolicyHash: string): { policyHash: string; host: string } {
        let url: URL;
        try { url = new URL(destination); } catch { throw new KeeperRefusedError('Outside destination is unavailable'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash ||
            url.hostname.endsWith('.invalid')) throw new KeeperRefusedError('Outside destination is unavailable');
        const consumer = this.outsideConsumer();
        if (!consumer || !consumer.hosts.some(host => host === url.hostname || host.startsWith('.') && url.hostname.endsWith(host)))
            throw new KeeperRefusedError('Outside destination is unavailable');
        return { policyHash: createHash('sha256').update(JSON.stringify(['lares-outside-destination-v1', basePolicyHash, url.href])).digest('hex'), host: url.hostname };
    }
    private async assertCurrentOutsideRoute(destination: string, expectedPolicyHash: string, deadlineAtMs: number): Promise<OutsideRouteReview> {
        const namespaceClient = requireDefinitionNamespace();
        if (deadlineAtMs <= Date.now()) throw new KeeperRefusedError('Outside route is unavailable');
        const selected = this.outsideConsumer(), ready = this.outsideRouteReady;
        if (!selected || !ready || ready.epoch !== this.outsideControllerEpoch || ready.sourceAddress !== selected.address)
            throw new KeeperRefusedError('Outside route is unavailable');
        const derived = this.destinationPolicy(destination, ready.basePolicyHash);
        if (derived.policyHash !== expectedPolicyHash) throw new KeeperRefusedError('Outside route changed; review the destination again');
        const read = (file: string) => readFileSync(join(this.config.egressDir, file), 'utf8');
        let stage: string;
        try {
            stage = read(OUTSIDE_ROUTE_ATTEMPT).trim();
            if (stage !== ready.stage || read(INSTALLED_STAGE).trim() !== ready.stage ||
                createHash('sha256').update(read(`${ready.stage}.squid`)).digest('hex') !== ready.squidHash ||
                createHash('sha256').update(read(`${ready.stage}.nft`)).digest('hex') !== ready.nftHash ||
                createHash('sha256').update(read('squid.conf')).digest('hex') !== ready.squidHash)
                throw new Error('stale');
        } catch { this.outsideRouteReady = undefined; throw new KeeperRefusedError('Outside route is unavailable'); }
        if (!this.docker.acknowledgeOutsideStage) throw new KeeperRefusedError('Outside route is unavailable');
        const proxyUrl = this.config.runtime.proxyUrl;
        await this.docker.acknowledgeOutsideStage(ready.stage, selected.address, proxyUrl, deadlineAtMs);
        if (requireDefinitionNamespace() !== namespaceClient || deadlineAtMs <= Date.now() ||
            this.outsideControllerEpoch !== ready.epoch || this.outsideRouteReady !== ready ||
            this.outsideConsumer()?.address !== selected.address || this.config.runtime.proxyUrl !== proxyUrl)
            throw new KeeperRefusedError('Outside route is unavailable');
        return { policyHash: derived.policyHash, sourceAddress: selected.address, proxyUrl: this.config.runtime.proxyUrl };
    }
    /** Review is usable only while this process holds the shared definition namespace and
     * the exact currently acknowledged route remains selected by root configuration. */
    async reviewOutsideRoute(destination: string, deadlineAtMs: number): Promise<OutsideRouteReview> {
        return withDefinitionNamespace(this.pool, async () => {
            const ready = this.outsideRouteReady;
            if (!ready) throw new KeeperRefusedError('Outside route is unavailable');
            const hash = this.destinationPolicy(destination, ready.basePolicyHash).policyHash;
            return this.assertCurrentOutsideRoute(destination, hash, deadlineAtMs);
        }, { deadlineAtMs });
    }
    /** The callback is the trusted discovery implementation; its lease check is callable only
     * while the namespace gate remains held and must run immediately before transport. */
    async withAppliedOutsideRoute<T>(destination: string, expectedPolicyHash: string, deadlineAtMs: number,
        work: (lease: OutsideRouteLease) => Promise<T>): Promise<T> {
        return withDefinitionNamespace(this.pool, async () => {
            const namespaceClient = requireDefinitionNamespace();
            const ready = this.outsideRouteReady;
            if (!ready) throw new KeeperRefusedError('Outside route is unavailable');
            const derived = this.destinationPolicy(destination, ready.basePolicyHash);
            if (derived.policyHash !== expectedPolicyHash) throw new KeeperRefusedError('Outside route changed; review the destination again');
            const state = { active: true, destination, policyHash: expectedPolicyHash, sourceAddress: ready.sourceAddress,
                proxyUrl: this.config.runtime.proxyUrl, epoch: ready.epoch, stage: ready.stage, deadlineAtMs, namespaceClient };
            let lease!: OutsideRouteLease;
            lease = Object.freeze({ assertCurrent: async () => {
                const current = this.outsideRouteLeases.get(lease as object);
                if (!current?.active || current !== state || Date.now() >= current.deadlineAtMs ||
                    current.epoch !== this.outsideControllerEpoch || requireDefinitionNamespace() !== current.namespaceClient)
                    throw new KeeperRefusedError('Outside route lease is unavailable');
                const reviewed = await this.assertCurrentOutsideRoute(current.destination, current.policyHash, current.deadlineAtMs);
                if (this.outsideRouteLeases.get(lease as object) !== current || !current.active || Date.now() >= current.deadlineAtMs ||
                    requireDefinitionNamespace() !== current.namespaceClient || current.epoch !== this.outsideControllerEpoch ||
                    reviewed.sourceAddress !== current.sourceAddress || reviewed.proxyUrl !== current.proxyUrl ||
                    this.outsideRouteReady?.stage !== current.stage || this.outsideRouteReady?.epoch !== current.epoch)
                    throw new KeeperRefusedError('Outside route lease is unavailable');
                return reviewed;
            } });
            this.outsideRouteLeases.set(lease as object, state);
            try {
                await lease.assertCurrent();
                const result = await work(lease);
                await lease.assertCurrent();
                return result;
            } finally {
                state.active = false;
                this.outsideRouteLeases.delete(lease as object);
            }
        }, { deadlineAtMs });
    }
    private resealing: Promise<void> = Promise.resolve();
    /** Startup: a reboot empties the kernel's nft tables, so re-apply the last firewall this keeper
     * installed, unchanged. Not a fresh render: that reads the database, and a definition gone invalid
     * would block it. The proxy needs nothing; it reads squid.conf from disk when it starts. One
     * attempt; never throws. On failure it logs one line and the next agent change seals afresh. */
    resealAtStart(): Promise<void> {
        this.outsideRouteReady = undefined;
        this.resealing = withDefinitionNamespace(this.pool, async () => {
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
        });
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
        atomic(this.config.composeFile, renderAgentsCompose(agents, { network: this.config.network, imageByRole: this.config.imageByRole, agentsDir: this.paths.agentsDir, secretsDir: this.paths.secretsDir, maintenanceAdmission: this.config.maintenanceAdmission, vaultRuntimeDir: this.paths.vaultRuntimeDir, modelPurposeRuntimeDir: this.paths.modelPurposeRuntimeDir, modelPrefix, consoleAdministrator: this.paths.credentials?.administrator }));
        await this.docker.config();
    }
    async prepare(name: string, d: AgentDefinition, create: boolean) {
        // Preflight BEFORE definition writes. New database/address provision is later, after audited publication.
        if (this.nativeGuarded) {
            if (d.role !== 'chief-of-staff') throw new KeeperRefusedError('Native budget activation is supported only for the chief of staff runtime');
            if (!this.paths.modelPurposeRuntimeDir) throw new KeeperRefusedError('Managed model-purpose transport is not configured');
            if (typeof d.model !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(d.model)) throw new KeeperRefusedError('Managed model-purpose alias is required');
            await this.refuseUnsupportedNativeInventory();
        } else this.gatewayKeyFile(name);
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
        if (this.nativeGuarded && (d.role !== 'chief-of-staff' || !this.paths.modelPurposeRuntimeDir || typeof d.model !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(d.model)))
            throw new KeeperRefusedError(d.role !== 'chief-of-staff'
                ? 'Native budget activation is supported only for the chief of staff runtime'
                : 'Managed model-purpose transport is not configured');
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
        if (!this.nativeGuarded) await this.ensureGatewayKey(name);
        // Before any stop: a list that cannot be built changes no rule, so the agent keeps running its applied definition.
        const plan = await this.plan({ name, definition: d }).catch(async error => {
            if (!(error instanceof KeeperRefusedError)) await this.pool.query('UPDATE agent_resources SET pending=true,pending_reason=$2,updated_at=now() WHERE name=$1', [name, 'Egress list could not be built; nothing was changed']);
            throw error;
        });
        const nativeState = this.nativeGuarded ? await this.currentNative(name) : { state: 'active' as const };
        if (this.nativeGuarded && nativeState.state !== 'active') await this.docker.stop(name);
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
        return { pending, reason: nativeState.state === 'held' ? nativeState.reason : reason };
    }
    async reconcile(name: string, d: AgentDefinition) {
        let row = await this.storage.row(name);
        if (!runtimeControlled(row) || !['ready','provisioning'].includes(row.state) || (row.state === 'provisioning' && row.ownership !== 'owned'))
            throw new KeeperRefusedError('Active runtime control required for reconciliation');
        refusePendingRetirement(row);
        if (!this.nativeGuarded) await this.ensureGatewayKey(name);
        if (row.state === 'provisioning')
            row = await this.storage.provision(name, String(row.address).split('/')[0]);
        if (row.state !== 'ready')
            throw new KeeperRefusedError('Only active resources can reconcile');
        await this.modelPrefix(); // Refuse before anything is marked, published or stopped.
        const plan = await this.plan({ name, definition: d }); // Before pending, publish and stop: an unbuildable list must not take the agent down.
        const definitionFiles = await this.definitionFiles(name);
        await this.pool.query("UPDATE agent_resources SET pending=true,pending_reason='Runtime reconciliation in progress',updated_at=now() WHERE name=$1", [name]);
        const a = await this.connections(this.container(row, d, await this.notionRevision(), await this.notionGranted()),true);
        verifyBindingSources(a.bindings);
        verifyPersonalReadSecretSources(a);
        this.verifySecrets(this.paths.secretsDir);
        const controlSecret = join(this.paths.secretsDir, `${name}-runtime-control`);
        try { const fd = openSync(controlSecret, 'wx', 0o600); try { writeFileSync(fd, randomBytes(32).toString('hex')); fsyncSync(fd); } finally { closeSync(fd); } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        this.provisionSecret(controlSecret);
        for (const path of [...(a.runtime.gatewayKeyFile ? [a.runtime.gatewayKeyFile] : []), a.runtime.passwordFile, a.runtime.workflowPasswordFile, ...Object.values(a.bindings?.secrets ?? {}), ...personalReadSecretFiles(a), ...a.doors.filter(d => d.enabled).flatMap(d => Object.values(DOOR_FILES[d.kind as keyof typeof DOOR_FILES] ?? {}).map(s => join(this.paths.secretsDir, `${name}-${s}`)))])
            this.provisionSecret(path);
        await this.publishCompose({ name, definition: d });
        await this.docker.stop(name); // Explicit action announces restart; no invented drain guarantee.
        await this.apply(plan);
        // Applied is recorded once stop and the egress seal both succeeded and before start: the container that starts is exactly this setup.
        await this.pool.query(`UPDATE agent_door_connections SET applied_revision=revision,applied_connection=jsonb_build_object('kind',kind,'principal',principal,'revision',revision,'owner_email',owner_email,'org',org,'mailbox',mailbox) WHERE agent=$1 AND incarnation=$2::uuid AND principal IS NOT NULL`,[name,row.ownership_token]);
        await this.pool.query('UPDATE agent_resources SET applied_definition=$2::jsonb,pending=false,pending_reason=NULL,updated_at=now() WHERE name=$1', [name, JSON.stringify(d)]);
        // A held native runtime remains fully staged and ready for the explicit provision/activate/reconcile flow.
        const result = await this.startWithCurrentAuthority(name, a.address);
        await this.recordSuccessfulDefinitionStart(name, definitionFiles, result);
        return result;
    }
    /** No provisioning, provider access, claim application or definition writes. Uses the
     * existing compose, seals and private health route for one already-owned ready runtime. */
    async credentialPreflight(names: string[]): Promise<void> {
        await this.plan();
        this.verifySecrets(this.paths.secretsDir);
        for (const name of names) {
            if (this.nativeGuarded && (await this.currentNative(name)).state !== 'active') throw new KeeperRefusedError(NATIVE_HELD);
            const row = await this.storage.row(name);
            if (!runtimeControlled(row) || row.state !== 'ready' || row.pending || !row.applied_definition)
                throw new KeeperRefusedError('Ready applied runtime required');
            this.refuseUnknownGrants(name, row.applied_definition);
            const a = await this.connections(this.container(row, row.applied_definition, null, await this.notionGranted()), false);
            verifyBindingSources(a.bindings);
            for (const path of [...(a.runtime.gatewayKeyFile ? [a.runtime.gatewayKeyFile] : []), a.runtime.passwordFile, a.runtime.workflowPasswordFile, join(this.paths.secretsDir, `${name}-runtime-control`),
                ...Object.values(a.bindings?.secrets ?? {}), ...personalReadSecretFiles(a),
                ...a.doors.filter(d => d.enabled).flatMap(d => Object.values(DOOR_FILES[d.kind as keyof typeof DOOR_FILES] ?? {}).map(s => join(this.paths.secretsDir, `${name}-${s}`)))]) {
                const st = lstatSync(path);
                if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !st.size) throw new KeeperRefusedError('Existing runtime secrets unavailable');
            }
        }
    }
    async reconcileCredential(name: string, revision: string | null): Promise<void> {
        if (this.nativeGuarded && (await this.currentNative(name)).state !== 'active') throw new KeeperRefusedError(NATIVE_HELD);
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
        const definitionFiles = await this.definitionFiles(name);
        if (revision || grantOp && record.activeRevision) this.provisionSecret(join(this.paths.secretsDir, 'notion-token'));
        await this.publishCompose();
        await this.docker.stop(name);
        await this.apply(plan);
        const result = await this.startWithCurrentAuthority(name, String(row.address).split('/')[0], true);
        await this.recordSuccessfulDefinitionStart(name, definitionFiles, result);
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
    async status(name: string) {
        const row = await this.storage.row(name);
        if (!row) return { pending: true, reason: 'Ownership migration required' };
        if (this.nativeGuarded && (await this.currentNative(name)).state !== 'active') return { pending: row.pending, reason: NATIVE_HELD };
        return { pending: row.pending, reason: row.pending_reason };
    }
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
