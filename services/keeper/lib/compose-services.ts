// The keeper's compose file for managed services that are not agents (today: the Notion sync).
// Same house rules as compose-agents.ts: only digests, no builds, no mutable tags, no host paths the
// keeper did not choose, a non-root read-only container with every capability dropped, and a fixed
// address on the fleet network so the egress proxy can scope what it may reach by source.
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { stringify } from 'yaml';
import { pinnedImage } from './compose-agents.js';

export interface ManagedServiceSpec {
    /** The compose service name, `lares-<name>`. */
    service: string;
    image: string;
    command: readonly string[];
    address: string;
    environment: Readonly<Record<string, string>>;
    /** Host secret file -> file name under /run/secrets inside the container. */
    secrets: readonly { file: string; target: string }[];
    /** Read-only single-file bind mounts. */
    files: readonly { source: string; target: string }[];
    labels: Readonly<Record<string, string>>;
}

const absolute = (path: string): string => {
    if (!isAbsolute(path) || /[\n\r\0]/.test(path)) throw new Error('Absolute path required');
    return path;
};

export function renderServicesCompose(services: readonly ManagedServiceSpec[], network: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network)) throw new Error('Invalid network');
    const out: Record<string, unknown> = {}, secrets: Record<string, unknown> = {};
    const addresses = new Set<string>();
    for (const s of services) {
        if (!/^lares-[a-z][a-z0-9-]{1,30}$/.test(s.service) || out[s.service]) throw new Error('Invalid or duplicate service');
        if (isIP(s.address) !== 4 || addresses.has(s.address)) throw new Error('Duplicate service or invalid address');
        addresses.add(s.address);
        const mounts: { source: string; target: string }[] = [];
        const seen = new Set<string>();
        for (const secret of s.secrets) {
            if (!/^[a-z][a-z0-9-]{0,62}$/.test(secret.target) || seen.has(secret.target)) throw new Error('Invalid or conflicting service secret');
            seen.add(secret.target);
            const key = `${s.service}-${secret.target}`;
            secrets[key] = { file: absolute(secret.file) };
            mounts.push({ source: key, target: secret.target });
        }
        out[s.service] = {
            image: pinnedImage(s.image), command: [...s.command], labels: { ...s.labels },
            read_only: true, user: '10001:10001', restart: 'unless-stopped', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
            environment: { ...s.environment },
            volumes: s.files.map(f => ({ type: 'bind', source: absolute(f.source), target: absolute(f.target), read_only: true, bind: { create_host_path: false } })),
            tmpfs: ['/tmp:uid=10001,gid=10001,mode=1770'],
            secrets: mounts,
            networks: { [network]: { ipv4_address: s.address } },
        };
    }
    return stringify({ services: out, secrets, networks: { [network]: { external: true } } });
}
