// The Notion sync as an optional managed service.
//
// OFF UNTIL CONFIGURED, AND THEN OFF UNTIL THE OWNER HAS SEEN WHAT IT WOULD DO. The service runs only
// when all of these hold at the same moment (see `syncInEffect`):
//   1. the owner switched it on (sync.notion.enabled),
//   2. the current sync configuration is complete (planNotionSync has no reason to refuse),
//   3. the owner accepted a preview of exactly this configuration (sync.notion.preview_ack equals the
//      configuration's hash, which also binds the installation's identity so a restored copy of the
//      setting from another server never matches), and
//   4. the shared Notion key is applied (the credential's effective revision is not null).
// Change anything that reaches the configuration and the hash changes, the acceptance no longer
// matches, and the service is stopped until a new preview is accepted.
//
// This first slice runs only the passes that need no vault: meeting attendees and people records.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { KeeperRefusedError, registerAction, type ActionContext } from './actions.js';
import { renderServicesCompose, type ManagedServiceSpec } from './compose-services.js';
import { nextAddress } from './compose-agents.js';
import type { DockerBoundary } from './docker.js';
import type { KeeperConfig } from './config.js';
import { withDefinitionNamespace } from './definition-namespace.js';
import { normaliseNotionId, readSetting, writeSetting } from './settings.js';

export const NOTION_SYNC_NAME = 'notion-sync';
export const NOTION_SYNC_SERVICE = 'lares-notion-sync';
/** The fixed, versioned Notion API date the sync engine requires (the Markdown content endpoints). */
const NOTION_VERSION = '2026-03-11';
const COMMAND = ['/app/node_modules/.bin/tsx', 'services/notion-sync/bin/notion-sync.ts'] as const;
const CONFIG_IN_CONTAINER = '/etc/lares/notion-sync.config.json';
/** The passes this slice may run. The vault passes (transcripts, notion-born, pull, apply, wiki, desk) are not here on purpose. */
export type SyncPass = 'attendees' | 'people';

// ---- what the sync is configured with -------------------------------------------------------------

export interface PreviewCounts { create: number; adoptPatch: number; skip: number; conflict: number }
export interface StoredPreview { hash: string; at: string; passes: Record<string, PreviewCounts> }
export interface NotionSyncSettings {
    enabled: boolean;
    meetings: string | null;
    people: string | null;
    ack: string | null;
    address: string | null;
    preview: StoredPreview | null;
}

export async function readNotionSyncSettings(pool: Pool): Promise<NotionSyncSettings> {
    const [enabled, meetings, people, ack, address, preview] = await Promise.all(
        ['sync.notion.enabled', 'notion.meetings_data_source', 'sync.notion.people_data_source', 'sync.notion.preview_ack', 'sync.notion.address', 'sync.notion.preview']
            .map(key => readSetting(pool, key)));
    const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    return { enabled: enabled === true, meetings: text(meetings), people: text(people), ack: text(ack), address: text(address),
        preview: preview && typeof preview === 'object' ? preview as StoredPreview : null };
}

/** What the installation provides that the sync is built from. Everything optional: a missing piece is a
 * reason the sync cannot be configured, said in plain words, never a crash. */
export interface SyncPlanInput {
    installationId?: string;
    /** The installation owner's address; the engine needs it to tell the owner from other attendees. */
    ownerEmail?: string;
    /** The meetings database an older installation file names (a console value wins over it). */
    meetingsFallback?: string;
    google?: { principal?: string; tokenKeyFile?: string; clients: Record<string, { clientIdFile: string; clientSecretFile: string }> };
    crm?: { baseUrl?: string; keyFile?: string };
}

type SyncConfigInput = Pick<KeeperConfig, 'credentials'> & { lifecycle?: {
    maintenanceAdmission?: { installationId: string };
    runtime?: { google?: SyncPlanInput['google'] };
    egress?: { endpoints?: { TWENTY_BASE_URL?: string } };
    defaultBindings?: Partial<Record<string, { environment: Record<string, string | undefined>; secrets: Record<string, string | undefined> }>>;
} };

export function syncPlanInput(config: SyncConfigInput): SyncPlanInput {
    const l = config.lifecycle, chief = l?.defaultBindings?.['chief-of-staff'];
    return {
        installationId: l?.maintenanceAdmission?.installationId, ownerEmail: config.credentials?.administrator,
        meetingsFallback: chief?.environment.NOTION_MEETINGS_DATA_SOURCE_ID,
        google: l?.runtime?.google,
        crm: { baseUrl: l?.egress?.endpoints?.TWENTY_BASE_URL, keyFile: chief?.secrets.TWENTY_KEY_FILE },
    };
}

export interface NotionSyncPlan {
    passes: SyncPass[];
    /** Plain-language reasons the sync cannot run as configured. Empty when `hash` is set. */
    problems: string[];
    /** The rendered notion-sync.config.json content, or null when nothing can run. */
    config: Record<string, unknown> | null;
    hash: string | null;
    /** Hosts the service may reach, and the endpoint URLs whose hosts are added to them. */
    hosts: string[];
    endpoints: string[];
    orgs: string[];
}

const canonical = (v: unknown): string => JSON.stringify((function sort(x: unknown): unknown {
    return Array.isArray(x) ? x.map(sort) : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort((x as Record<string, unknown>)[k])])) : x;
})(v));

export function planNotionSync(s: NotionSyncSettings, input: SyncPlanInput): NotionSyncPlan {
    const meetings = s.meetings ?? input.meetingsFallback ?? null;
    const problems: string[] = [];
    const passes: SyncPass[] = [];
    const orgs = Object.keys(input.google?.clients ?? {}).filter(org => /^[a-z0-9]{1,32}$/.test(org)).sort();
    if (!meetings) problems.push('Choose the Notion meetings database first (under Notion, above).');
    if (!input.ownerEmail) problems.push("The installation does not record the owner's address, which the sync needs.");
    else if (meetings) {
        if (input.google?.principal && input.google.tokenKeyFile && orgs.length > 0) passes.push('attendees');
        else problems.push('Meeting attendees need a connected Google calendar, which this installation does not have.');
    }
    if (s.people) {
        if (meetings && input.ownerEmail && input.crm?.baseUrl && input.crm.keyFile) passes.push('people');
        else if (meetings) problems.push('People records need the contacts connection (CRM), which this installation does not have.');
    }
    if (passes.length === 0) {
        if (problems.length === 0) problems.push('There is nothing to sync yet.');
        return { passes, problems, config: null, hash: null, hosts: [], endpoints: [], orgs };
    }
    const config: Record<string, unknown> = {
        notionVersion: NOTION_VERSION, meetingsDataSourceId: meetings, selfEmail: input.ownerEmail, passes,
        ...(passes.includes('people') ? { people: { dataSourceId: s.people } } : {}),
    };
    const hash = createHash('sha256').update(canonical({ config, installation: input.installationId ?? '', orgs: passes.includes('attendees') ? orgs : [] })).digest('hex');
    return { passes, problems, config, hash, orgs,
        hosts: ['api.notion.com', ...(passes.includes('attendees') ? ['.googleapis.com'] : [])],
        endpoints: passes.includes('people') && input.crm?.baseUrl ? [input.crm.baseUrl] : [] };
}

/** The one gate: switched on, complete, and the owner accepted exactly this configuration. */
export function syncInEffect(s: NotionSyncSettings, plan: NotionSyncPlan): boolean {
    return s.enabled && plan.hash !== null && s.ack === plan.hash;
}

/** True when the credential inventory has to list the service as a consumer of the shared key. */
export async function notionSyncRequested(pool: Pool, config: SyncConfigInput): Promise<boolean> {
    const settings = await readNotionSyncSettings(pool);
    return syncInEffect(settings, planNotionSync(settings, syncPlanInput(config)));
}

// ---- running it ---------------------------------------------------------------------------------

export interface ManagedEgress { name: string; address: string; hosts: string[]; endpoints: string[] }
export interface ManagedServices {
    egress(): Promise<ManagedEgress[]>;
    /** Addresses a stopped service still owns, so a new agent never takes one. */
    reservedAddresses(): Promise<string[]>;
}

export interface NotionSyncView {
    canChange: boolean;
    enabled: boolean;
    meetingsDataSource: string | null;
    peopleDataSource: string | null;
    passes: SyncPass[];
    problems: string[];
    keyApplied: boolean;
    /** Identifies the configuration as it is now; accepting a preview names it, so a stale click is refused. */
    hash: string | null;
    /** The stored preview, and whether it was made for the configuration as it is now. */
    preview: { at: string; passes: Record<string, PreviewCounts>; current: boolean } | null;
    accepted: boolean;
    running: 'running' | 'stopped' | 'not-created';
    lastRun: string | null;
    phase: 'off' | 'needs-setup' | 'needs-key' | 'needs-preview' | 'ready-to-accept' | 'on';
}

const previewOutput = z.object({ version: z.literal(1), passes: z.record(z.string(), z.object({
    create: z.number().int().nonnegative(), adoptPatch: z.number().int().nonnegative(), skip: z.number().int().nonnegative(), conflict: z.number().int().nonnegative() }).strict()) }).strict();

function atomicFile(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}`;
    writeFileSync(temp, body, { mode: 0o644, flag: 'wx' });
    renameSync(temp, path);
}

export interface NotionSyncServiceOptions {
    pool: Pool;
    config: SyncConfigInput & Pick<KeeperConfig, 'secretsDir'> & { lifecycle?: NonNullable<KeeperConfig['lifecycle']> };
    docker: DockerBoundary;
    /** The shared Notion key's EFFECTIVE revision (during an activation, the one being moved to). */
    credentialRevision: () => Promise<string | null | undefined>;
    /** Re-installs the firewall and proxy rules from the current inventory, which includes this service. */
    reseal: () => Promise<void>;
    /** Every address already taken on the fleet network. */
    takenAddresses: () => Promise<string[]>;
    now?: () => Date;
}

export class NotionSyncService implements ManagedServices {
    constructor(private o: NotionSyncServiceOptions) {}
    private get lifecycle() { return this.o.config.lifecycle; }
    private get servicesFile(): string | undefined { return this.lifecycle?.services?.composeFile; }
    private async current() {
        const settings = await readNotionSyncSettings(this.o.pool);
        const plan = planNotionSync(settings, syncPlanInput(this.o.config));
        return { settings, plan, inEffect: syncInEffect(settings, plan) };
    }
    async egress(): Promise<ManagedEgress[]> {
        const { settings, plan } = await this.current();
        // The service's own source address is allowed while it is switched on with a complete configuration,
        // so the one-shot preview can reach what it reads. Nothing is allowed for a service that is off.
        return settings.enabled && plan.hash !== null && settings.address
            ? [{ name: NOTION_SYNC_NAME, address: settings.address, hosts: plan.hosts, endpoints: plan.endpoints }] : [];
    }
    async reservedAddresses(): Promise<string[]> {
        const { address } = await readNotionSyncSettings(this.o.pool);
        return address ? [address] : [];
    }
    private async ensureAddress(actor: string): Promise<string> {
        const stored = (await readNotionSyncSettings(this.o.pool)).address;
        if (stored) return stored;
        const subnet = this.lifecycle?.subnet;
        if (!subnet) throw new KeeperRefusedError('The Notion sync is not available on this installation.');
        const address = nextAddress(await this.o.takenAddresses(), subnet);
        await writeSetting(this.o.pool, 'sync.notion.address', address, actor);
        return address;
    }
    private spec(plan: NotionSyncPlan, address: string, revision: string | null): { spec: ManagedServiceSpec; configFile: string } {
        const l = this.lifecycle, file = this.servicesFile;
        if (!l || !file || !l.services) throw new KeeperRefusedError('The Notion sync is not available on this installation.');
        const configFile = join(dirname(file), 'notion-sync.config.json');
        const db = new URL(l.runtime.databaseUrl);
        const environment: Record<string, string> = {
            NOTION_SYNC_LIVE: '1', NOTION_SYNC_CONFIG: CONFIG_IN_CONTAINER, DATABASE_PASSWORD_FILE: '/run/secrets/database-password',
            PGHOST: db.hostname, PGPORT: db.port || '5432', PGDATABASE: db.pathname.slice(1), PGUSER: decodeURIComponent(db.username),
            NOTION_TOKEN_FILE: '/run/secrets/notion-token',
            HTTPS_PROXY: l.runtime.proxyUrl, HTTP_PROXY: l.runtime.proxyUrl, EGRESS_PROXY_URL: l.runtime.proxyUrl, NODE_USE_ENV_PROXY: '1', NO_PROXY: db.hostname,
        };
        const secrets: { file: string; target: string }[] = [
            { file: l.runtime.passwordFile, target: 'database-password' },
            { file: join(this.o.config.secretsDir, 'notion-token'), target: 'notion-token' },
        ];
        const google = l.runtime.google, chief = l.defaultBindings?.['chief-of-staff'];
        if (plan.passes.includes('attendees') && google?.principal && google.tokenKeyFile) {
            environment.NOTION_SYNC_PRINCIPAL = google.principal;
            environment.TOKEN_ENC_KEY_FILE = '/run/secrets/token-enc-key';
            secrets.push({ file: google.tokenKeyFile, target: 'token-enc-key' });
            for (const org of plan.orgs) {
                const client = google.clients[org]!, upper = org.toUpperCase();
                environment[`GOOGLE_CLIENT_ID_${upper}_FILE`] = `/run/secrets/google-client-id-${org}`;
                environment[`GOOGLE_CLIENT_SECRET_${upper}_FILE`] = `/run/secrets/google-client-secret-${org}`;
                secrets.push({ file: client.clientIdFile, target: `google-client-id-${org}` }, { file: client.clientSecretFile, target: `google-client-secret-${org}` });
            }
        }
        if (plan.passes.includes('people') && l.egress.endpoints.TWENTY_BASE_URL && chief?.secrets.TWENTY_KEY_FILE) {
            environment.TWENTY_BASE_URL = l.egress.endpoints.TWENTY_BASE_URL;
            environment.TWENTY_KEY_FILE = '/run/secrets/twenty-key';
            secrets.push({ file: chief.secrets.TWENTY_KEY_FILE, target: 'twenty-key' });
        }
        return { configFile, spec: { service: NOTION_SYNC_SERVICE, image: l.services.notionSyncImage, command: COMMAND, address, environment, secrets,
            files: [{ source: configFile, target: CONFIG_IN_CONTAINER }],
            labels: { 'lares.notion-revision': revision ?? 'disconnected', 'lares.config-hash': plan.hash ?? '' } } };
    }
    private writeFiles(plan: NotionSyncPlan, address: string, revision: string | null): void {
        const { spec, configFile } = this.spec(plan, address, revision);
        atomicFile(configFile, `${JSON.stringify(plan.config, null, 2)}\n`);
        atomicFile(this.servicesFile!, renderServicesCompose([spec], this.lifecycle!.network));
    }
    private async stopService(): Promise<void> {
        await this.o.docker.serviceRemove?.(NOTION_SYNC_SERVICE);
    }
    /** Brings the service in line with the gate. `start: false` (the keeper's own startup) only ever STOPS: a
     * keeper that has just come up, perhaps after a restore, never starts the sync by itself. */
    async apply(actor: string, opts: { start: boolean }): Promise<'running' | 'off'> {
        {
            if (!this.o.docker.serviceUp || !this.servicesFile) return 'off';
            const { settings, plan, inEffect } = await this.current();
            const revision = await this.o.credentialRevision();
            const want = inEffect && typeof revision === 'string';
            if (!want) {
                const touched = settings.enabled || settings.address !== null;
                await this.stopService();
                if (touched && opts.start) await this.o.reseal();
                return 'off';
            }
            if (!opts.start) return 'running';
            const address = await this.ensureAddress(actor);
            this.writeFiles(plan, address, revision);
            await this.o.reseal();
            await this.o.docker.serviceUp(this.servicesFile, NOTION_SYNC_SERVICE);
            return 'running';
        }
    }
    /** Credential activation: stop before the key file moves. */
    async quiesce(): Promise<void> { await this.stopService(); }
    /** Credential activation: start again against the key revision the activation moved to (or leave it off). */
    async reconcile(actor: string): Promise<void> { await this.apply(actor, { start: true }); }
    /** Fails unless the real container matches the gate and the key revision the activation intends. */
    async verify(revision: string | null): Promise<void> {
        const found = await this.o.docker.serviceInspect?.(NOTION_SYNC_SERVICE);
        const { inEffect } = await this.current();
        if (revision === null || !inEffect) {
            if (found?.running) throw new KeeperRefusedError('The Notion sync is still running without the key');
            return;
        }
        const mount = found?.mounts.filter(m => m.destination === '/run/secrets/notion-token') ?? [];
        if (!found?.running || found.notionRevision !== revision || mount.length !== 1 || mount[0]!.source !== join(this.o.config.secretsDir, 'notion-token'))
            throw new KeeperRefusedError('Actual Notion sync key binding changed');
    }

    // ---- the preview ---------------------------------------------------------------------------
    async preview(actor: string): Promise<void> {
        {
            const { settings, plan } = await this.current();
            const revision = await this.o.credentialRevision();
            if (!settings.enabled) throw new KeeperRefusedError('Switch the Notion sync on before running a preview.');
            if (!plan.hash) throw new KeeperRefusedError(plan.problems[0] ?? 'The sync is not fully set up yet.');
            if (typeof revision !== 'string') throw new KeeperRefusedError('Connect the Notion key first: a preview reads Notion.');
            if (!this.o.docker.serviceRunOnce || !this.servicesFile) throw new KeeperRefusedError('The Notion sync is not available on this installation.');
            const address = await this.ensureAddress(actor);
            this.writeFiles(plan, address, revision);
            await this.o.reseal();
            // A preview makes no write anywhere; the engine runs every pass with its dry-run switch on.
            const out = (await this.o.docker.serviceRunOnce(this.servicesFile, NOTION_SYNC_SERVICE, [...COMMAND, '--preview'])).trim().split('\n').filter(Boolean).pop();
            let parsed: z.infer<typeof previewOutput>;
            try { parsed = previewOutput.parse(JSON.parse(out ?? '')); }
            catch { throw new KeeperRefusedError('The preview did not finish. Check the Notion key and the connections, then try again.'); }
            if (canonical(Object.keys(parsed.passes).sort()) !== canonical([...plan.passes].sort()))
                throw new KeeperRefusedError('The preview did not cover every part of the sync. Try again.');
            await writeSetting(this.o.pool, 'sync.notion.preview', { hash: plan.hash, at: (this.o.now?.() ?? new Date()).toISOString(), passes: parsed.passes }, actor);
        }
    }

    /** The owner accepts the stored preview of exactly this configuration, and the service starts. */
    async accept(actor: string, hash: string): Promise<void> {
        {
            const { settings, plan } = await this.current();
            if (!settings.enabled || !plan.hash || settings.preview?.hash !== plan.hash || hash !== plan.hash)
                throw new KeeperRefusedError('The preview is out of date. Run the preview again, then accept it.');
            await writeSetting(this.o.pool, 'sync.notion.preview_ack', plan.hash, actor);
            await this.apply(actor, { start: true });
        }
    }

    // ---- what the console shows ---------------------------------------------------------------------
    async view(canChange: boolean): Promise<NotionSyncView> {
        const { settings, plan, inEffect } = await this.current();
        const revision = await this.o.credentialRevision();
        const found = await this.o.docker.serviceInspect?.(NOTION_SYNC_SERVICE).catch(() => null);
        let lastRun: string | null = null;
        try { lastRun = (await this.o.pool.query('SELECT last_run_at FROM notion_sync_run WHERE id = TRUE')).rows[0]?.last_run_at?.toISOString?.() ?? null; }
        catch { lastRun = null; }
        const previewCurrent = !!settings.preview && settings.preview.hash === plan.hash;
        const keyApplied = typeof revision === 'string';
        const phase: NotionSyncView['phase'] = !settings.enabled ? 'off' : !plan.hash ? 'needs-setup' : !keyApplied ? 'needs-key'
            : inEffect ? 'on' : previewCurrent ? 'ready-to-accept' : 'needs-preview';
        return { canChange, enabled: settings.enabled, meetingsDataSource: settings.meetings ?? null, peopleDataSource: settings.people,
            passes: plan.passes, problems: plan.problems, keyApplied, hash: plan.hash,
            preview: settings.preview ? { at: settings.preview.at, passes: settings.preview.passes, current: previewCurrent } : null,
            accepted: inEffect, running: !found ? 'not-created' : found.running ? 'running' : 'stopped', lastRun, phase };
    }
}

// ---- actions ------------------------------------------------------------------------------------------

export interface SyncActionOptions {
    pool: Pool;
    service: NotionSyncService;
    /** The installation owner's console address; only that actor (or the host command) may change the sync. */
    administrator?: string;
    namespaceGuard?: () => Promise<void>;
}

export function registerSyncActions(o: SyncActionOptions): void {
    const mayChange = (ctx: ActionContext) => ctx.host === true || (o.administrator !== undefined && ctx.actor === o.administrator);
    const owner = (ctx: ActionContext) => { if (!mayChange(ctx)) throw new KeeperRefusedError("Only the installation's owner can change the Notion sync."); };
    const guarded = <T>(work: () => Promise<T>): Promise<T> => withDefinitionNamespace(o.pool, async () => { await o.namespaceGuard?.(); return work(); });
    registerAction({ name: 'sync.notion_get', input: z.strictObject({}), run: async (_input, ctx) => o.service.view(mayChange(ctx)) });
    registerAction({ name: 'sync.notion_set', input: z.strictObject({ enabled: z.boolean(), peopleDataSource: z.string().max(200) }),
        successDetail: (r: NotionSyncView) => JSON.stringify({ notionSync: r.enabled ? 'on' : 'off', phase: r.phase }),
        run: ({ enabled, peopleDataSource }, ctx) => guarded(async () => {
            owner(ctx);
            const trimmed = peopleDataSource.trim();
            const people = trimmed === '' ? '' : normaliseNotionId(trimmed);
            if (people === null) throw new KeeperRefusedError('That is not a Notion data source id. It is 32 letters and digits, with or without dashes.');
            await writeSetting(o.pool, 'sync.notion.people_data_source', people, ctx.actor);
            await writeSetting(o.pool, 'sync.notion.enabled', enabled, ctx.actor);
            // Turning it off forgets the acceptance: coming back on needs a fresh preview.
            if (!enabled) await writeSetting(o.pool, 'sync.notion.preview_ack', '', ctx.actor);
            await o.service.apply(ctx.actor, { start: true });
            return o.service.view(true);
        }) });
    registerAction({ name: 'sync.notion_preview', input: z.strictObject({}),
        successDetail: () => JSON.stringify({ notionSyncPreview: 'stored' }),
        run: (_input, ctx) => guarded(async () => { owner(ctx); await o.service.preview(ctx.actor); return o.service.view(true); }) });
    registerAction({ name: 'sync.notion_accept', input: z.strictObject({ hash: z.string().regex(/^[a-f0-9]{64}$/) }),
        successDetail: () => JSON.stringify({ notionSyncAccepted: true }),
        run: ({ hash }, ctx) => guarded(async () => {
            owner(ctx);
            await o.service.accept(ctx.actor, hash);
            return o.service.view(true);
        }) });
}

