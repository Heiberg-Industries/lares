import { execFile } from "node:child_process";
import { createConnection, type Socket } from 'node:net';
import { promisify } from "node:util";
import { isIP } from "node:net";
import type { KeeperConfig } from "./config.js";
const execute = promisify(execFile);
/** Internal helper, never itself registered as a keeper action. */
export async function dockerCompose(config: KeeperConfig, args: readonly string[]): Promise<string> {
    try {
        const { stdout } = await execute("docker", ["compose", "--project-name", config.project, "--project-directory", config.dir, ...config.files.flatMap(file => ["-f", file]), ...args], { cwd: config.dir, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
        return stdout;
    }
    catch {
        throw new Error("keeper: docker compose failed");
    }
}
import { agentName, pinnedImage } from './compose-agents.js';
/** Fixed operations only. This boundary is injectable for ordering tests, never an action input. */
export interface DockerBoundary {
    inventory(network: string): Promise<string[]>;
    config(): Promise<void>;
    /** Start one owned runtime and return only after its private Eve health route is ready. */
    start(name: string, address: string, forceRecreate?: boolean, probes?: number): Promise<void>;
    inspect?(name: string): Promise<{ id: string; running: boolean; incarnation: string | null; notionRevision: string | null; image: string; mounts: { source: string; destination: string }[]; addresses: string[] }>;
    credentialMounts?(activePath: string): Promise<{ name: string | null; incarnation: string | null; owned: boolean }[]>;
    healthy?(address: string): Promise<boolean>;
    stop(name: string): Promise<void>;
    remove(name: string): Promise<void>;
    validateSquid(stage: string): Promise<void>;
    reloadSquid(): Promise<void>;
    acknowledgeOutsideStage?(stage: string, sourceAddress: string, proxyUrl: string, deadlineAtMs: number): Promise<void>;
    firewall(stage: string, check: boolean): Promise<void>;
}
export interface OwnedDockerConfig {
    project: string;
    dir: string;
    composeFile: string;
    proxyContainer: string;
    squidImage: string;
    firewallImage: string;
    egressDir: string;
}
/** The started container never answered its health address in the fixed window. Its own
 *  log has the reason; the keeper cannot see inside it. */
export class AgentNotHealthyError extends Error {
    constructor() { super('keeper: agent did not become healthy; reconciliation required'); }
}
/** No container exists for this agent (for example after the stack was taken down). Distinct from a Docker failure. */
export class NoOwnedContainerError extends Error {
    constructor() { super('Owned runtime inventory unavailable'); }
}
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const ROUTE_STAGE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type OutsideRouteAcknowledgementFailure = 'invalid-input'|'deadline-before-connect'|'connection-error'|
    'dns-failure'|'connection-refused'|'local-source-unavailable'|'network-unreachable'|'connection-reset'|'socket-timeout'|
    'source-mismatch'|'response-too-large'|'deadline-no-response'|'response-not-ended'|'incomplete-headers'|
    'status-not-403'|'stage-absent'|'stage-multiple'|'stage-mismatch'|'malformed-headers'|'allow-marker'|'response-invalid';
/** The message remains safe for existing callers; only trusted fixture code reads the fixed reason. */
export class OutsideRouteAcknowledgementError extends Error {
    readonly reason!: OutsideRouteAcknowledgementFailure;
    constructor(reason: OutsideRouteAcknowledgementFailure) {
        super('keeper: outside route acknowledgement unavailable');
        Object.defineProperty(this, 'reason', { value: reason, enumerable: false });
    }
}
/** Keep the production predicate byte-for-byte aligned in behavior with the pinned-Squid raw
 * response fixture: only SP/HTAB are optional whitespace, folded/control-bearing headers fail. */
export function outsideRouteStageAcknowledged(data: Buffer, expectedStage: string): boolean {
    if (!ROUTE_STAGE.test(expectedStage)) return false;
    const headerEnd = data.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) return false;
    const headerLines = data.subarray(0, headerEnd).toString('latin1').split('\r\n');
    const statusMatch = (headerLines[0] ?? '').match(/^HTTP\/\d+\.\d+ ([0-9]{3})(?:[ \t]|$)/);
    const values: string[] = [];
    let malformed = false;
    const trimOws = (value: string) => value.replace(/^[ \t]+|[ \t]+$/g, '');
    const control = /[\x00-\x08\x0a-\x1f\x7f]/;
    for (const line of headerLines.slice(1)) {
        if (control.test(line)) malformed = true;
        if (/^[ \t]/.test(line)) { malformed = true; continue; }
        const colon = line.indexOf(':');
        if (colon < 0) {
            if (/^x-lares-route-stage(?:[: \t]|$)/i.test(trimOws(line))) malformed = true;
            continue;
        }
        const rawName = line.slice(0, colon), name = trimOws(rawName);
        if (/^x-lares-route-stage$/i.test(name)) {
            if (rawName !== name) malformed = true;
            const value = line.slice(colon + 1);
            if (control.test(value)) malformed = true;
            values.push(trimOws(value));
        } else if (/^x-lares-route-stage(?:[ \t]|$)/i.test(name)) malformed = true;
    }
    return statusMatch?.[1] === '403' && !data.includes(Buffer.from('CI_PROXY_DESTINATION_OK')) && !malformed &&
        values.length === 1 && values[0] === expectedStage;
}
/** Diagnostic classification only; the strict success predicate above remains authoritative. */
function outsideRouteAcknowledgementFailure(data: Buffer, expectedStage: string): OutsideRouteAcknowledgementFailure {
    const headerEnd = data.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) return 'incomplete-headers';
    if (data.includes(Buffer.from('CI_PROXY_DESTINATION_OK'))) return 'allow-marker';
    const lines = data.subarray(0, headerEnd).toString('latin1').split('\r\n');
    const status = (lines[0] ?? '').match(/^HTTP\/\d+\.\d+ ([0-9]{3})(?:[ \t]|$)/)?.[1];
    if (!status) return 'malformed-headers';
    if (status !== '403') return 'status-not-403';
    const trimOws = (value: string) => value.replace(/^[ \t]+|[ \t]+$/g, '');
    const control = /[\x00-\x08\x0a-\x1f\x7f]/;
    const values: string[] = [];
    for (const line of lines.slice(1)) {
        if (control.test(line) || /^[ \t]/.test(line)) return 'malformed-headers';
        const colon = line.indexOf(':');
        if (colon < 0) {
            if (/^x-lares-route-stage(?:[: \t]|$)/i.test(trimOws(line))) return 'malformed-headers';
            continue;
        }
        const rawName = line.slice(0, colon), name = trimOws(rawName);
        if (/^x-lares-route-stage$/i.test(name)) {
            const value = line.slice(colon + 1);
            if (rawName !== name || control.test(value)) return 'malformed-headers';
            values.push(trimOws(value));
        } else if (/^x-lares-route-stage(?:[ \t]|$)/i.test(name)) return 'malformed-headers';
    }
    if (values.length === 0) return 'stage-absent';
    if (values.length > 1) return 'stage-multiple';
    if (values[0] !== expectedStage) return 'stage-mismatch';
    return 'response-invalid';
}
function outsideRouteSocketFailure(code: unknown): OutsideRouteAcknowledgementFailure {
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns-failure';
    if (code === 'ECONNREFUSED') return 'connection-refused';
    if (code === 'EADDRNOTAVAIL' || code === 'EACCES') return 'local-source-unavailable';
    if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'network-unreachable';
    if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection-reset';
    if (code === 'ETIMEDOUT') return 'socket-timeout';
    return 'connection-error';
}
/** A bounded, deliberately denied CONNECT proves the configured proxy has loaded one stage.
 * The TCP socket is pinned to the root-selected local source before it can send a request. */
export async function acknowledgeOutsideSquidStage(stage: string, sourceAddress: string, proxyUrl: string,
  deadlineAtMs: number, connect = createConnection): Promise<void> {
    if (!ROUTE_STAGE.test(stage) || isIP(sourceAddress) !== 4 || !Number.isFinite(deadlineAtMs))
        throw new OutsideRouteAcknowledgementError('invalid-input');
    if (deadlineAtMs <= Date.now()) throw new OutsideRouteAcknowledgementError('deadline-before-connect');
    let proxy: URL;
    try { proxy = new URL(proxyUrl); }
    catch { throw new OutsideRouteAcknowledgementError('invalid-input'); }
    if (proxy.protocol !== 'http:' || proxy.hostname !== 'lares-egress-proxy' || proxy.port !== '8888' || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash)
        throw new OutsideRouteAcknowledgementError('invalid-input');
    const host = `lares-route-${stage}.invalid`;
    const request = `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Connection: close\r\n\r\n`;
    for (let attempt = 0; attempt < 5; attempt++) {
        if (Date.now() >= deadlineAtMs) throw new OutsideRouteAcknowledgementError('deadline-before-connect');
        if (attempt > 0) {
            const remaining = deadlineAtMs - Date.now();
            if (remaining < 50) throw new OutsideRouteAcknowledgementError('deadline-before-connect');
            await wait(50);
            if (Date.now() >= deadlineAtMs) throw new OutsideRouteAcknowledgementError('deadline-before-connect');
        }
        let socket: Socket;
        try { socket = connect({ host: proxy.hostname, port: Number(proxy.port), localAddress: sourceAddress, family: 4 }); }
        catch { throw new OutsideRouteAcknowledgementError('connection-error'); }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const outcome = await new Promise<{ error?: OutsideRouteAcknowledgementError; retryableRefusal: boolean }>(resolve => {
                let buffer = Buffer.alloc(0), settled = false;
                let connected = false, requestWriteStarted = false, refusalAwaitingClose = false, closed = false;
                const finish = (error?: OutsideRouteAcknowledgementError, retryableRefusal = false) => {
                    if (settled) return;
                    if (!error && Date.now() >= deadlineAtMs)
                        error = new OutsideRouteAcknowledgementError(buffer.length === 0 ? 'deadline-no-response' : 'response-not-ended');
                    settled = true;
                    resolve({ error, retryableRefusal });
                };
                timeout = setTimeout(() => {
                    const reason: OutsideRouteAcknowledgementFailure = !connected ? 'deadline-before-connect' :
                        buffer.length === 0 ? 'deadline-no-response' : 'response-not-ended';
                    socket.destroy(); finish(new OutsideRouteAcknowledgementError(reason));
                }, Math.max(1, deadlineAtMs - Date.now()));
                socket.once('error', (error: NodeJS.ErrnoException) => {
                    if (settled) return;
                    if (Date.now() >= deadlineAtMs) {
                        finish(new OutsideRouteAcknowledgementError(!connected ? 'deadline-before-connect' :
                            buffer.length === 0 ? 'deadline-no-response' : 'response-not-ended'));
                        return;
                    }
                    const retryable = error.code === 'ECONNREFUSED' && !connected && !requestWriteStarted && buffer.length === 0;
                    if (!retryable) {
                        finish(new OutsideRouteAcknowledgementError(outsideRouteSocketFailure(error.code)));
                        return;
                    }
                    refusalAwaitingClose = true;
                    socket.destroy();
                    if (closed) finish(new OutsideRouteAcknowledgementError('connection-refused'), true);
                });
                socket.once('close', () => {
                    closed = true;
                    if (refusalAwaitingClose) finish(new OutsideRouteAcknowledgementError('connection-refused'), true);
                });
                socket.once('connect', () => {
                    if (settled) return;
                    if (refusalAwaitingClose) {
                        refusalAwaitingClose = false;
                        socket.destroy(); finish(new OutsideRouteAcknowledgementError('connection-error')); return;
                    }
                    if (Date.now() >= deadlineAtMs) {
                        socket.destroy(); finish(new OutsideRouteAcknowledgementError('deadline-before-connect')); return;
                    }
                    connected = true;
                    if (socket.localAddress !== sourceAddress) {
                        socket.destroy(); finish(new OutsideRouteAcknowledgementError('source-mismatch')); return;
                    }
                    requestWriteStarted = true;
                    try { socket.write(request); }
                    catch { socket.destroy(); finish(new OutsideRouteAcknowledgementError('connection-error')); }
                });
                socket.on('data', (chunk: Buffer) => {
                    if (settled) return;
                    if (Date.now() >= deadlineAtMs) {
                        socket.destroy(); finish(new OutsideRouteAcknowledgementError(buffer.length === 0 ? 'deadline-no-response' : 'response-not-ended')); return;
                    }
                    buffer = Buffer.concat([buffer, chunk]);
                    if (buffer.length > 8192) { finish(new OutsideRouteAcknowledgementError('response-too-large')); return; }
                    if (buffer.indexOf('\r\n\r\n') < 0) return;
                });
                socket.once('end', () => {
                    if (settled) return;
                    if (Date.now() >= deadlineAtMs) {
                        finish(new OutsideRouteAcknowledgementError(buffer.length === 0 ? 'deadline-no-response' : 'response-not-ended')); return;
                    }
                    finish(outsideRouteStageAcknowledged(buffer, stage) ? undefined :
                        new OutsideRouteAcknowledgementError(outsideRouteAcknowledgementFailure(buffer, stage)));
                });
            });
            if (!outcome.error) {
                if (Date.now() >= deadlineAtMs)
                    throw new OutsideRouteAcknowledgementError('response-not-ended');
                return;
            }
            if (!outcome.retryableRefusal || attempt === 4) throw outcome.error;
        } finally {
            if (timeout) clearTimeout(timeout);
            if (!socket.destroyed) socket.destroy();
        }
    }
}
function privateIpv4(address: string): boolean {
    if (isIP(address) !== 4) return false;
    const octets = address.split('.').map(Number);
    return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
}
export function ownedDocker(c: OwnedDockerConfig, request: typeof fetch = globalThis.fetch, pause = wait): DockerBoundary {
    pinnedImage(c.squidImage);
    pinnedImage(c.firewallImage);
    if (!/^lares-[a-z0-9_-]+$/.test(c.proxyContainer))
        throw new Error('Owned proxy required');
    const run = async (args: string[]) => { try {
        return (await execute('docker', args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout;
    }
    catch {
        throw new Error('keeper: fixed Docker operation failed; reconciliation required');
    } };
    const compose = (args: string[]) => run(['compose', '--project-name', c.project, '--project-directory', c.dir, '-f', c.composeFile, ...args]);
    const stageFile = (stage: string) => { if (!/^[a-f0-9-]{36}$/.test(stage))
        throw new Error('Invalid stage'); return stage; };
    return {
        inventory: async (network) => { const entries = JSON.parse(await run(['network', 'inspect', network])); if (entries.length !== 1)
            throw new Error('Network unavailable'); return Object.values(entries[0].Containers ?? {}).map((v: any) => String(v.IPv4Address).split('/')[0]).concat((entries[0].IPAM?.Config ?? []).map((v: any) => v.Gateway).filter(Boolean)); },
        config: async () => { await compose(['config', '--quiet']); },
        credentialMounts: async activePath => {
            const ids = (await run(['ps', '--all', '--quiet'])).trim().split(/\s+/).filter(Boolean);
            if (ids.length > 2000 || ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('Credential mount inventory unavailable');
            const result: { name: string | null; incarnation: string | null; owned: boolean }[] = [];
            for (const id of ids) {
                const [mounts, labels] = (await run(['inspect', '--format', '{{json .Mounts}}|{{json .Config.Labels}}', id])).trim().split('|').map(v => JSON.parse(v));
                if (!Array.isArray(mounts)) throw new Error('Credential mount inventory unavailable');
                if (mounts.some((m: any) => m.Type === 'bind' && (m.Source === activePath || activePath.startsWith(String(m.Source).replace(/\/$/, '') + '/'))))
                    result.push({ name: typeof labels?.['com.docker.compose.service'] === 'string' ? labels['com.docker.compose.service'].replace(/^lares-/, '') : null,
                        incarnation: labels?.['lares.incarnation'] ?? null, owned: labels?.['com.docker.compose.project'] === c.project && /^lares-[a-z][a-z0-9-]{1,30}$/.test(labels?.['com.docker.compose.service'] ?? '') });
            }
            return result;
        },
        healthy: async address => {
            if (!privateIpv4(address)) return false;
            try {
                const response = await request(`http://${address}:3000/eve/v1/health`, { method: 'GET', signal: AbortSignal.timeout(1000), redirect: 'error' });
                return response.ok && (await response.json() as { ok?: unknown })?.ok === true;
            } catch { return false; }
        },
        inspect: async name => {
            const service = `lares-${agentName(name)}`;
            const ids = (await run(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${c.project}`, '--filter', `label=com.docker.compose.service=${service}`])).trim().split(/\s+/).filter(Boolean);
            if (ids.length === 0) throw new NoOwnedContainerError();
            if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0]!)) throw new Error('Owned runtime inventory unavailable');
            // Select only ownership/mount facts. Never return environment or container logs.
            const format = '{{json .Id}}|{{json .State.Running}}|{{json .Config.Labels}}|{{json .Config.Image}}|{{json .Mounts}}|{{json .NetworkSettings.Networks}}';
            const parts = (await run(['inspect', '--format', format, ids[0]!])).trim().split('|').map(v => JSON.parse(v));
            const [id, running, labels, image, mounts, networks] = parts;
            if (labels?.['com.docker.compose.project'] !== c.project || labels?.['com.docker.compose.service'] !== service) throw new Error('Owned runtime required');
            return { id, running: running === true, incarnation: labels['lares.incarnation'] ?? null, notionRevision: labels['lares.notion-revision'] ?? null,
                image, mounts: mounts.map((m: any) => ({ source: m.Source, destination: m.Destination })), addresses: Object.values(networks).map((n: any) => n.IPAddress) };
        },
        start: async (name, address, forceRecreate = false, probes = 30) => {
            if (!privateIpv4(address)) throw new Error('keeper: agent health address was refused');
            await compose(['up', '-d', '--no-deps', ...(forceRecreate ? ['--force-recreate'] : []), `lares-${agentName(name)}`]);
            // Default at most about one minute: 30 one-second probes with one-second gaps. A caller
            // that treats a slow start as normal (reconcile) passes fewer so a Console call stays short.
            for (let attempt = 0; attempt < probes; attempt++) {
                try {
                    const response = await request(`http://${address}:3000/eve/v1/health`, {
                        method: 'GET', signal: AbortSignal.timeout(1000), redirect: 'error',
                    });
                    const body = response.ok ? await response.json() as {ok?:unknown} : null;
                    if (body?.ok === true) return;
                }
                catch { /* The container may still be starting; retry within the fixed window. */ }
                if (attempt < probes - 1) await pause(1000);
            }
            throw new AgentNotHealthyError();
        },
        stop: async (name) => { await compose(['stop', `lares-${agentName(name)}`]); },
        remove: async (name) => {
            const ids = (await run(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${c.project}`, '--filter', `label=com.docker.compose.service=lares-${agentName(name)}`])).trim().split(/\s+/).filter(Boolean);
            if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id)))
                throw new Error('Invalid owned container inventory');
            if (ids.length)
                await run(['rm', '--force', ...ids]);
        },
        validateSquid: async (stage) => { await run(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges:true', '--mount', `type=bind,src=${c.egressDir},dst=/config,readonly`, '--entrypoint', 'squid', c.squidImage, '-k', 'parse', '-f', `/config/${stageFile(stage)}.squid`]); },
        reloadSquid: async () => { await run(['exec', c.proxyContainer, 'squid', '-k', 'reconfigure', '-f', '/config/squid.conf']); },
        acknowledgeOutsideStage: async (stage, sourceAddress, proxyUrl, deadlineAtMs) => {
            await acknowledgeOutsideSquidStage(stage, sourceAddress, proxyUrl, deadlineAtMs);
        },
        // Host network is essential: an ordinary keeper network namespace does not own Docker's forward chain.
        firewall: async (stage, check) => { await run(['run', '--rm', '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--security-opt', 'no-new-privileges:true', '--mount', `type=bind,src=${c.egressDir},dst=/config,readonly`, '--entrypoint', 'nft', c.firewallImage, ...(check ? ['--check'] : []), '-f', `/config/${stageFile(stage)}.nft`]); },
    };
}
