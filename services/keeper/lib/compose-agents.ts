// Keeper-owned compose only. No overlay services, builds, orphan removal or mutable tags.
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { stringify } from 'yaml';
import { gatewayModels } from './gateway-keys.js';
import { DOOR_SECRET_FILES } from '@lares/agent-kit/platform-secrets';
import { outsideSecretName, outsideSecretTarget } from '@lares/agent-kit/outside-tools';
import { bindingsFor, INTEGRATION_SECRET_FILES, type RuntimeBindings } from './runtime-bindings.js';
export const DIGEST = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
export function agentName(name: string): string { if (!/^[a-z][a-z0-9-]{1,30}$/.test(name))
    throw new Error('Invalid agent name'); return name; }
export function pinnedImage(image: string): string { if (!DIGEST.test(image))
    throw new Error('Image must have a full SHA256 digest'); return image; }
export const ROLE_DOORS:Record<string,readonly string[]>={creative:['slack'],'chief-of-staff':['slack','telegram','email']};
export const DOOR_FILES = DOOR_SECRET_FILES;
export interface AgentContainer {
    name: string;
    role: string;
    address: string;
    incarnation?: string;
    notionRevision?: string | null;
    bindings?: RuntimeBindings;
    email?: {principal:string;org:string;mailbox:string;revision:string;owner:string;tokenKeyFile:string;clientIdFile:string;clientSecretFile:string};
    claims?: {kind:'slack'|'telegram';principal:string;revision:string;owner:string}[];
    /** The one member who may approve in the console: the owner of the earliest claim. Computed once, never by overwriting. */
    consoleOwner?: string;
    doors: readonly {
        kind: string;
        enabled: boolean;
    }[];
    /** Names of the outside tools that need a token (definition `outsideTools[].token`). */
    outsideTokens?: readonly string[];
    /** Installation-supplied, password-free URLs. Workflow MUST be per-agent. */
    runtime: {
        databaseUrl: string;
        workflowUrl: string;
        gatewayUrl: string;
        proxyUrl: string;
        schedulesLive?: boolean;
        gatewayKeyFile: string;
        passwordFile: string;
        endpoints?: Record<string, string>;
    };
}
export interface ComposeOptions {
    network: string;
    imageByRole: Record<string, string>;
    agentsDir: string;
    secretsDir: string;
    /** The installation's gateway model-name prefix (setting models.alias_prefix). Every agent
     * derives its purpose names from it as LARES_MODEL_PREFIX. */
    modelPrefix: string;
    /** The installation owner's console address (keeper.json `credentials.administrator`). The
     * console approver of an agent that has no door or email claim. A claim always wins. */
    consoleAdministrator?: string;
}
function absolute(path: string): string { if (!isAbsolute(path) || /[\n\r\0]/.test(path))
    throw new Error('Absolute path required'); return path; }
export function renderAgentsCompose(agents: readonly AgentContainer[], opts: ComposeOptions): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(opts.network))
        throw new Error('Invalid network');
    absolute(opts.agentsDir);
    absolute(opts.secretsDir);
    if (typeof opts.modelPrefix !== 'string') throw new Error('keeper: models.alias_prefix is missing or invalid');
    gatewayModels(opts.modelPrefix);
    const services: Record<string, unknown> = {}, secrets: Record<string, unknown> = {}, volumes: Record<string, unknown> = {};
    const addresses = new Set<string>();
    for (const a of agents) {
        agentName(a.name);
        if (services[`lares-${a.name}`] || isIP(a.address) !== 4 || addresses.has(a.address))
            throw new Error('Duplicate agent or invalid address');
        addresses.add(a.address);
        const r = a.runtime;
        const bindings = bindingsFor(a.role, a.bindings);
        for (const value of [r.databaseUrl, r.workflowUrl]) {
            const u = new URL(value);
            if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.password || !u.pathname.slice(1))
                throw new Error('Explicit password-free database URL required');
        }
        if (!/^https?:$/.test(new URL(r.gatewayUrl).protocol) || !/^http:$/.test(new URL(r.proxyUrl).protocol))
            throw new Error('Invalid gateway/proxy URL');
        const environment: Record<string, string> = { LARES_DEFINITION_DIR: '/definition', LARES_AGENT_NAME: a.name, DATABASE_URL: r.databaseUrl, WORKFLOW_POSTGRES_URL: r.workflowUrl, GATEWAY_URL: r.gatewayUrl, LARES_MODEL_PREFIX: opts.modelPrefix, GATEWAY_KEY_FILE: '/run/secrets/gateway-key', DATABASE_PASSWORD_FILE: '/run/secrets/database-password', HTTPS_PROXY: r.proxyUrl, HTTP_PROXY: r.proxyUrl, SLACK_PROXY_URL: r.proxyUrl, TELEGRAM_PROXY_URL: r.proxyUrl, EGRESS_PROXY_URL: r.proxyUrl, EVE_SCHEDULES_LIVE: r.schedulesLive === true ? '1' : '0' };
        Object.assign(environment, bindings?.environment);
        if (bindings?.secrets.LANGFUSE_KEY_FILE) environment.LANGFUSE_PROXY_URL = r.proxyUrl;
        for (const [key, value] of Object.entries(r.endpoints ?? {})) {
            if (!['READABILITY_URL', 'TWENTY_BASE_URL'].includes(key))
                throw new Error('Unsupported endpoint');
            environment[key] = value;
        }
        if (a.incarnation) {
            if (!/^[a-f0-9-]{36}$/.test(a.incarnation)) throw new Error('Invalid runtime incarnation');
            environment.LARES_AGENT_INCARNATION = a.incarnation;
            environment.LARES_RUNTIME_CONTROL_SECRET_FILE = '/run/secrets/runtime-control';
        }
        for (const claim of a.claims ?? []) {
            if (!['slack','telegram'].includes(claim.kind) || !/^[a-f0-9-]{36}$/.test(claim.revision) || !claim.principal || claim.principal.length > 128)
                throw new Error('Invalid claimed door identity');
            environment[`LARES_${claim.kind.toUpperCase()}_PRINCIPAL`] = claim.principal;
            environment[`LARES_${claim.kind.toUpperCase()}_CLAIM_REVISION`] = claim.revision;
            // Existing schedules still read these explicit fields; managed principal helpers
            // use the dedicated LARES fields, never an old installation fallback.
            if (claim.kind === 'slack') environment.SLACK_ALLOWED_USER_IDS = claim.principal;
            else environment.TELEGRAM_PRINCIPAL_ID = claim.principal;
            environment.AGENT_OWNER_USER_ID = claim.owner;
        }
        // W8B-s5: the owner ADDRESS (agent_door_connections.owner_email) is who may answer an
        // approval in web chat. It is one value for the agent (the earliest claim's owner, chosen
        // by the keeper), so the order of the claims here cannot change it. No claim, no console
        // approver: the administrator fallback below.
        if (a.consoleOwner) environment.LARES_CONSOLE_PRINCIPAL = a.consoleOwner;
        // A fresh install has no claim yet, so web chat would admit nobody. Fall back to the owner's
        // own console address. A door claim (above) or the email owner (below) takes precedence.
        if (a.incarnation && opts.consoleAdministrator && !environment.LARES_CONSOLE_PRINCIPAL)
            environment.LARES_CONSOLE_PRINCIPAL = opts.consoleAdministrator;
        const mounts: {
            source: string;
            target: string;
        }[] = [];
        const secret = (key: string, file: string, target: string) => { secrets[key] = { file: absolute(file) }; mounts.push({ source: key, target }); };
        for (const [key,file] of Object.entries(bindings?.secrets ?? {})) {
            const target = INTEGRATION_SECRET_FILES[key as keyof typeof INTEGRATION_SECRET_FILES];
            secret(`${a.name}-integration-${target}`, file!, target);
            environment[key] = `/run/secrets/${target}`;
        }
        if (a.incarnation) secret(`${a.name}-runtime-control`, `${opts.secretsDir}/${a.name}-runtime-control`, 'runtime-control');
        if (a.email) {
            const e=a.email;
            environment.GOOGLE_PRINCIPAL_ID=e.principal;
            environment.LARES_EMAIL_PRINCIPAL=e.principal;
            environment.LARES_EMAIL_ORG=e.org;
            environment.LARES_EMAIL_MAILBOX=e.mailbox;
            environment.LARES_EMAIL_CLAIM_REVISION=e.revision;
            environment.GMAIL_PRIMARY_EMAIL=e.mailbox;
            environment.CALENDAR_PRIMARY_EMAIL=e.mailbox;
            environment.AGENT_OWNER_USER_ID=e.owner;
            for (const [key,file,target] of [['TOKEN_ENC_KEY_FILE',e.tokenKeyFile,'google-token-key'],['LARES_GOOGLE_CLIENT_ID_FILE',e.clientIdFile,'google-client-id'],['LARES_GOOGLE_CLIENT_SECRET_FILE',e.clientSecretFile,'google-client-secret']]) {
                secret(`${a.name}-${target}`,file,target);environment[key]=`/run/secrets/${target}`;
            }
        }
        secret(`${a.name}-gateway-key`, r.gatewayKeyFile, 'gateway-key');
        if (bindings?.ownerId) {
            environment.AGENT_OWNER_USER_ID = bindings.ownerId;
            // The Slack sign-in is stored under the owner's register id (migration 085). An explicit
            // binding wins. It is derived only when this chief of staff actually has Slack (an enabled
            // Slack door or a Slack claim): an unenrolled sign-in is loud in the brief by design, so a
            // chief without Slack must carry no principal and the brief leaves Slack out quietly.
            const hasSlack = a.doors.some(d => d.kind === 'slack' && d.enabled) || (a.claims ?? []).some(c => c.kind === 'slack');
            if (a.role === 'chief-of-staff' && hasSlack && !bindings.environment.SLACK_TOKEN_PRINCIPAL_ID)
                environment.SLACK_TOKEN_PRINCIPAL_ID = bindings.ownerId;
        }
        secret(`${a.name}-database-password`, r.passwordFile, 'database-password');
        for (const door of a.doors)
            if (door.enabled) {
                if (!ROLE_DOORS[a.role]?.includes(door.kind)) throw new Error('Role does not support this door');
                if (door.kind === 'email') { if (!a.email) throw new Error('Email connection must be selected and configured'); continue; }
                if (!(door.kind in DOOR_FILES))
                    throw new Error('Unsupported runnable door');
                for (const [variable, suffix] of Object.entries(DOOR_FILES[door.kind as keyof typeof DOOR_FILES])) {
                    const key = `${a.name}-${suffix}`;
                    secret(key, `${opts.secretsDir}/${key}`, key);
                    environment[variable] = `/run/secrets/${key}`;
                }
            }
        // Outside tools: one token file per entry that asks for one, placed on the
        // server by the owner. The target is derived from the entry's name, never from a fixed list.
        for (const tool of a.outsideTokens ?? []) {
            if (!/^[a-z][a-z0-9-]{0,40}$/.test(tool)) throw new Error('Invalid outside tool name');
            const key = outsideSecretName(a.name, tool);
            secret(key, `${opts.secretsDir}/${key}`, outsideSecretTarget(tool));
        }
        const dataMounts: unknown[] = [`${opts.agentsDir}/${a.name}:/definition:ro`];
        for (const m of bindings?.mounts ?? []) dataMounts.push({type:'bind',source:m.source,target:m.target,read_only:m.readOnly,bind:{create_host_path:false}});
        if (bindings?.workflowVolume) {
            const key = `${a.name}-workflow-files`;
            volumes[key] = {external:true,name:bindings.workflowVolume};
            dataMounts.push({type:'volume',source:key,target:`/app/services/${a.role}/.eve/.workflow-data`,volume:{nocopy:true}});
        }
        // Eve loads authored modules lazily into package-local caches, including the kit
        // extension's real pnpm target. A writable .eve alone does not cover those writes.
        // Keep shipped .eve metadata visible and make only sandbox scratch writable.
        const tmpfs = ['/tmp:uid=10001,gid=10001,mode=1770',
            `/app/services/${a.role}/.eve/sandbox-cache:uid=10001,gid=10001,mode=0700,size=256m`,
            `/app/services/${a.role}/node_modules/.cache:uid=10001,gid=10001,mode=0700,size=384m`,
            '/app/packages/agent-kit/node_modules/.cache:uid=10001,gid=10001,mode=0700,size=64m',
            ...(bindings?.legacySandboxRoots ?? []).map(path => `${path}:uid=10001,gid=10001,mode=0700,size=256m`)];
        services[`lares-${a.name}`] = { image: pinnedImage(opts.imageByRole[a.role]), ...(a.incarnation ? { labels: { 'lares.incarnation': a.incarnation, ...(a.notionRevision !== undefined ? { 'lares.notion-revision': a.notionRevision ?? 'disconnected' } : {}) } } : {}), read_only: true, user: '10001:10001', restart: 'unless-stopped', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], environment, volumes: dataMounts, tmpfs, secrets: mounts, networks: { [opts.network]: { ipv4_address: a.address } } };
    }
    return stringify({ services, secrets, ...(Object.keys(volumes).length ? {volumes} : {}), networks: { [opts.network]: { external: true } } });
}
const ipNumber = (ip: string) => { if (isIP(ip) !== 4)
    throw new Error('Invalid IPv4'); return ip.split('.').reduce((n, p) => n * 256 + Number(p), 0); };
const ipString = (n: number) => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
/** Caller supplies Docker's entire network inventory PLUS configured reserved addresses.
 * Skip network/gateway and broadcast, scanning after highest taken address first. */
export function nextAddress(taken: readonly string[], subnet: string): string {
    const [base, prefix, ...rest] = subnet.split('/');
    const bits = Number(prefix);
    if (rest.length || !/^\d+$/.test(prefix ?? '') || bits < 8 || bits > 30)
        throw new Error('Unsupported IPv4 subnet');
    const size = 2 ** (32 - bits), start = ipNumber(base);
    if (start % size)
        throw new Error('Subnet must be canonical');
    const used = new Set(taken.map(ipNumber));
    const local = [...used].filter(n => n > start && n < start + size - 1);
    const begin = Math.max(start + 2, ...local.map(n => n + 1));
    for (const [from, to] of [[begin, start + size - 1], [start + 2, Math.min(begin, start + size - 1)]])
        for (let n = from; n < to; n++)
            if (!used.has(n))
                return ipString(n);
    throw new Error('No free address');
}
