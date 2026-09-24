// Pure generation: no host writes, reloads or ruleset flushing. Task 14 owns the
// audited lifecycle integration; the installation supplies its retained services
// and existing internal/direct exceptions. Squid tightens current agents by source;
// nft deliberately retains the existing global direct-destination exception shape.
//
// The hosts this file allows ultimately trace back to `integrations/<id>/integration.json`
// (loaded via `@lares/agent-kit/integration-manifest`), which is checked against
// `CAPABILITY_DOCS`'s `hosts` below rather than read here — there is exactly one allow-list
// path, and `tests/egress-from-manifest.test.ts` pins that the two never disagree.
import { isIP } from 'node:net';
import { CAPABILITY_DOCS, docFor, hostsFor } from '@lares/agent-kit/persona';
import { SCOPES } from '@lares/agent-kit/manifest';

export interface EgressAgent {
  name: string;
  address: string;
  grants: readonly { capability: string; scope: string }[];
  doors?: readonly { kind: 'slack' | 'telegram'; enabled: boolean }[];
  /** Explicit runtime dependencies: e.g. gateway and telemetry, not capabilities. */
  infrastructureHosts?: readonly string[];
}
export interface EgressOptions {
  /** Missing endpoint means the integration is not connected. Only granted
   * capabilities consume these values; READABILITY_URL is the worker, not the URL read. */
  endpoints?: Partial<Record<'READABILITY_URL' | 'ORAKEL_URL' | 'TWENTY_BASE_URL', string>>;
  /** Non-agent consumers retained in BOTH the seal and source-scoped proxy ACLs.
   * Enumerate all retained sources at migration; never add a subnet fallback. */
  legacyConsumers?: readonly { name: string; address: string; hosts: readonly string[] }[];
  internalNetworks?: readonly string[];
  directDestinations?: readonly string[];
}
const DOOR_HOSTS = { slack: ['.slack.com', '.slack-files.com'], telegram: ['api.telegram.org'] } as const;
const EXISTING_SUFFIXES = new Set(['.googleapis.com', '.slack.com', '.slack-files.com']);
const sorted = (values: readonly string[]) => [...new Set(values)].sort();

function host(value: string): string {
  const domain = value.startsWith('.') ? value.slice(1) : value;
  if ((value.startsWith('.') && !EXISTING_SUFFIXES.has(value)) || domain.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain) || isIP(domain)) {
    throw new Error(`Invalid egress host: ${value}`);
  }
  return value;
}
function address(value: string): string {
  if (isIP(value) !== 4) throw new Error(`Invalid egress IPv4 address: ${value}`);
  return value;
}
function destination(value: string): string {
  const parts = value.split('/');
  address(parts[0]);
  if (parts.length > 2 || (parts.length === 2 && (!/^[1-9][0-9]?$/.test(parts[1]) || Number(parts[1]) > 32))) {
    throw new Error(`Invalid egress IPv4 network: ${value}`);
  }
  return value;
}
function endpointHost(value: string): string {
  if (/[\s\\]/.test(value)) throw new Error('Invalid egress endpoint');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new Error('Egress proxy endpoints require HTTPS port 443 without credentials or fragment');
  }
  return host(url.hostname);
}

export function generateEgress(agents: readonly EgressAgent[], options: EgressOptions = {}): {
  squid: string; nft: string; perAgent: Record<string, string[]>;
} {
  const names = new Set<string>();
  const addresses = new Set<string>();
  const consumers: { name: string; address: string; hosts: string[] }[] = [];
  const perAgent: Record<string, string[]> = {};
  const add = (name: string, ip: string, hosts: readonly string[]) => {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name) || names.has(name)) throw new Error(`Invalid or duplicate egress name: ${name}`);
    address(ip);
    if (addresses.has(ip)) throw new Error(`Duplicate egress source: ${ip}`);
    names.add(name); addresses.add(ip);
    const values = sorted(hosts.map(host));
    consumers.push({ name, address: ip, hosts: values });
    return values;
  };
  for (const agent of [...agents].sort((a, b) => a.name.localeCompare(b.name))) {
    const hosts: string[] = [...(agent.infrastructureHosts ?? [])];
    const grants = new Set<string>();
    for (const grant of agent.grants) {
      if (!Object.hasOwn(CAPABILITY_DOCS, grant.capability)) throw new Error(`Unknown egress capability: ${grant.capability}`);
      const doc = docFor(grant.capability);
      if (!SCOPES.some(scope => scope === grant.scope) || grants.has(grant.capability)) throw new Error(`Invalid or duplicate egress grant: ${grant.capability}`);
      grants.add(grant.capability);
      if (grant.scope === 'none') continue;
      hosts.push(...hostsFor(grant.capability));
      const endpoint = doc.endpoint ? options.endpoints?.[doc.endpoint] : undefined;
      if (endpoint !== undefined) hosts.push(endpointHost(endpoint));
    }
    for (const door of agent.doors ?? []) {
      if (!Object.hasOwn(DOOR_HOSTS, door.kind) || typeof door.enabled !== 'boolean') throw new Error('Invalid egress door');
      if (door.enabled) hosts.push(...DOOR_HOSTS[door.kind]);
    }
    perAgent[agent.name] = add(agent.name, agent.address, hosts);
  }
  for (const consumer of options.legacyConsumers ?? []) add(consumer.name, consumer.address, consumer.hosts);
  const squid = ['# Generated by keeper; do not edit.', 'acl SSL_ports port 443', 'acl CONNECT method CONNECT'];
  for (const consumer of consumers.sort((a, b) => a.name.localeCompare(b.name))) {
    // Squid's domain tree rejects/warns on overlapping entries in ONE ACL. Keep
    // the metadata union in perAgent but emit only the covering suffix where present.
    const domains = consumer.hosts.filter(h => !consumer.hosts.some(suffix =>
      suffix !== h && suffix.startsWith('.') && (h === suffix.slice(1) || h.endsWith(suffix))));
    squid.push(`acl src_${consumer.name} src ${consumer.address}`);
    if (consumer.hosts.length) {
      squid.push(`acl dst_${consumer.name} dstdomain ${domains.join(' ')}`,
        `http_access allow CONNECT src_${consumer.name} dst_${consumer.name} SSL_ports`);
    }
  }
  squid.push('http_access deny all', 'http_port 8888', 'cache deny all');
  const exceptions = sorted([...(options.internalNetworks ?? []), ...(options.directDestinations ?? [])].map(destination));
  const nft = ['# Generated by keeper; apply the whole file atomically with nft -f.',
    'add table inet saga_egress', 'delete table inet saga_egress',
    'table inet saga_egress {', '  chain forward {', '    type filter hook forward priority -10; policy accept;'];
  if (addresses.size) {
    nft.push(`    ip saddr != { ${sorted([...addresses]).join(', ')} } accept`,
      '    ct state established,related accept', ...exceptions.map(ip => `    ip daddr ${ip} accept`),
      '    udp dport 53 accept', '    tcp dport 53 accept', '    counter drop');
  }
  nft.push('  }', '}');
  return { squid: squid.join('\n') + '\n', nft: nft.join('\n') + '\n', perAgent };
}
