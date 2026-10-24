import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { generateEgress } from '../lib/egress.js';
import { firewallProjection } from './outside-discovery-image.probe.mjs';

// A baseline proxy configuration in the shape of a long-running installation's. It adds
// .slack-files.com over the repo version. Comments must not become destinations.
const baseline = readFileSync(new URL('./fixtures/egress-live-squid.conf', import.meta.url), 'utf8');
const nft = readFileSync(new URL('./fixtures/egress-live-nft.txt', import.meta.url), 'utf8');
function aclValues(conf: string, kind: string): string[] {
  return conf.split('\n').flatMap(line => {
    const tokens = line.split('#')[0].trim().split(/\s+/);
    return tokens[0] === 'acl' && tokens[2] === kind ? tokens.slice(3) : [];
  });
}
// Evaluate the generated subset of Squid ACL syntax, including ordered allow/deny,
// source conjunction and true hostname boundaries (not a two-label approximation).
function allowed(conf: string, address: string, host: string, port = 443, method = 'CONNECT'): boolean {
  const acls = new Map<string, { kind: string; values: string[] }>();
  for (const line of conf.split('\n')) {
    const t = line.split('#')[0].trim().split(/\s+/);
    if (t[0] === 'acl') acls.set(t[1], { kind: t[2], values: t.slice(3) });
    if (t[0] !== 'http_access') continue;
    const matches = t.slice(2).every(name => {
      if (name === 'all') return true;
      const acl = acls.get(name)!;
      if (acl.kind === 'src') return acl.values.includes(address);
      if (acl.kind === 'port') return acl.values.includes(String(port));
      if (acl.kind === 'method') return acl.values.includes(method);
      return acl.values.some(h => h.startsWith('.') ? host === h.slice(1) || host.endsWith(h) : host === h);
    });
    if (matches) return t[1] === 'allow';
  }
  return false;
}
const addresses = ['172.18.0.24', '172.18.0.26'];
const names = ['chief', 'writer'];
const roles = ['chief-of-staff', 'creative'];
const agents = roles.map((role, i) => ({ name: names[i], address: addresses[i], grants: JSON.parse(readFileSync(new URL(`../../${role}/agent.json`, import.meta.url), 'utf8')).grants, doors: [{ kind: 'slack' as const, enabled: true }, { kind: 'telegram' as const, enabled: true }], infrastructureHosts: ['cloud.langfuse.com'] }));
// Retain legacy/non-agent consumers under their own SOURCE ACLs. Their historical
// broad access is preserved; it cannot be borrowed by the two current agents.
const oldHosts = [...new Set(aclValues(baseline, 'dstdomain'))].sort();
const options = {
  // 25 is a former agent: it now runs outside the keeper and is listed as a legacy consumer.
  legacyConsumers: [10, 11, 13, 14, 23, 25].map(n => ({ name: `legacy-${n}`, address: `172.18.0.${n}`, hosts: oldHosts })),
  internalNetworks: ['172.18.0.0/16'],
  directDestinations: ['192.0.2.10', '198.51.100.10', '203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.13', '149.154.160.0/20'],
};
it('reproduces live proxy destination breadth while retaining legacy source attribution', () => {
  const result = generateEgress(agents, options);
  expect([...new Set(aclValues(result.squid, 'dstdomain'))].filter(h => !oldHosts.includes(h))).toEqual([]);
  for (const consumer of options.legacyConsumers) for (const h of oldHosts) expect(allowed(result.squid, consumer.address, h.replace(/^\./, 'api.'))).toBe(true);
  expect(allowed(result.squid, '172.18.0.11', 'api.github.com')).toBe(true);
  expect(allowed(result.squid, '172.18.0.11', 'api.notion.com')).toBe(true);
});
it('intentionally tightens each current agent, with no fallback to legacy destinations', () => {
  const { squid } = generateEgress(agents, options);
  expect(allowed(squid, addresses[0], 'gmail.googleapis.com')).toBe(true);
  expect(allowed(squid, addresses[1], 'gmail.googleapis.com')).toBe(false);
  expect(allowed(squid, addresses[0], 'api.notion.com')).toBe(true);
  expect(allowed(squid, addresses[1], 'api.notion.com')).toBe(false);
  expect(allowed(squid, addresses[1], 'api.github.com')).toBe(false);
  expect(allowed(squid, addresses[0], 'api.service-a.example')).toBe(false);
  // A former agent keeps its source, as a legacy consumer, not as a managed agent.
  expect(allowed(squid, '172.18.0.25', 'api.notion.com')).toBe(true);
  for (const address of addresses) {
    expect(allowed(squid, address, 'files.slack-files.com')).toBe(true);
    expect(allowed(squid, address, 'a.b.slack.com')).toBe(true);
    expect(allowed(squid, address, 'slack.com.evil.org')).toBe(false);
    expect(allowed(squid, address, 'evilslack.com')).toBe(false);
    expect(allowed(squid, address, 'api.slack.com', 80)).toBe(false);
    expect(allowed(squid, address, 'api.slack.com', 443, 'GET')).toBe(false);
  }
  expect(allowed(squid, '172.18.0.99', 'api.slack.com')).toBe(false);
});
it('keeps every live sealed source, internal/direct exception and firewall ordering', () => {
  const result = generateEgress(agents, options).nft;
  const sourceSet = /ip saddr != \{ ([^}]+) \} accept/;
  const table = (text: string, family: 'inet' | 'bridge') => {
    const start = text.indexOf(`table ${family} lares_egress {`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n  }', start);
    return text.slice(start, end + 4);
  };
  const inet = table(result, 'inet'), bridge = table(result, 'bridge');
  expect(inet.match(sourceSet)?.[1]).toBe(nft.match(sourceSet)?.[1]);
  expect(bridge.match(/ip saddr != \{ ([^}]+) \} accept/)?.[1]).toBe(inet.match(sourceSet)?.[1]);
  expect(bridge).toContain('ether type != ip accept');
  const destinations = (s: string) => [...s.matchAll(/ip daddr (.+) accept/g)].flatMap(m => m[1].replace(/[{}]/g, '').split(/[,\s]+/).filter(Boolean)).sort();
  expect(destinations(inet)).toEqual(destinations(nft));
  expect(destinations(bridge)).toEqual(destinations(inet));
  for (const policy of [inet, bridge]) {
    for (const rule of ['ct state established,related accept', 'udp dport 53 accept', 'tcp dport 53 accept']) expect(policy).toContain(rule);
    expect(policy.indexOf('ip saddr')).toBeLessThan(policy.indexOf('ct state'));
    expect(policy.indexOf('ct state')).toBeLessThan(policy.indexOf('ip daddr'));
    expect(policy.indexOf('ip daddr')).toBeLessThan(policy.indexOf('counter drop'));
  }
});

it('matches normalized live nft text against the actual generated two-family policy', () => {
  const generated = generateEgress([
    { name: 'alpha', address: '10.0.0.2', grants: [] },
    { name: 'beta', address: '10.0.0.3', grants: [] },
  ], { directDestinations: ['192.0.2.20/32'] }).nft;
  let live = generated.replace('priority -10;', 'priority filter - 10;')
    .replace('ip saddr != { 10.0.0.2, 10.0.0.3 }', 'ip saddr != { 10.0.0.3, 10.0.0.2 }')
    .replaceAll('ct state established,related accept', 'ct state related,established accept')
    .replaceAll('ip daddr 192.0.2.20/32 accept', 'ip daddr 192.0.2.20 accept')
    .replaceAll('counter drop', 'counter packets 4 bytes 256 drop');
  expect(firewallProjection(generated, live, 'inet')).toBeDefined();
  expect(firewallProjection(generated, live, 'bridge')).toBeDefined();
  live = live.replaceAll('ct state related,established accept',
    'ct state related,established accept\n    ip daddr 203.0.113.9 accept');
  expect(firewallProjection(generated, live, 'inet')).toBeUndefined();
  expect(firewallProjection(generated, live, 'bridge')).toBeUndefined();
});

it('keeps the Python image validator in parity with the TypeScript validator', () => {
  const generated = generateEgress([
    { name: 'alpha', address: '10.0.0.2', grants: [] },
    { name: 'beta', address: '10.0.0.3', grants: [] },
  ], { directDestinations: ['192.0.2.20/32'] }).nft;
  const live = generated.replace('priority -10;', 'priority filter - 10;')
    .replace('ip saddr != { 10.0.0.2, 10.0.0.3 }', 'ip saddr != { 10.0.0.3, 10.0.0.2 }')
    .replaceAll('ct state established,related accept', 'ct state related,established accept')
    .replaceAll('ip daddr 192.0.2.20/32 accept', 'ip daddr 192.0.2.20 accept')
    .replaceAll('counter drop', 'counter packets 4 bytes 256 drop');
  const cases = [
    { generated, live },
    { generated, live: live.replace('priority filter - 10;', 'priority 0;') },
    { generated, live: live.replaceAll('10.0.0.3, 10.0.0.2', '10.0.0.3, 10.0.0.99') },
    { generated, live: live.replaceAll('ct state related,established accept',
      'ct state related,established accept\n    ip daddr 203.0.113.9 accept') },
  ];
  const script = fileURLToPath(new URL('./outside-discovery-image.probe.py', import.meta.url));
  const response = JSON.parse(execFileSync('python3', [script, '--projection-check'], {
    input: JSON.stringify({ cases }), encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024,
  })) as { results: Record<'inet' | 'bridge', { hash: string; packets: number } | null>[] };
  expect(response.results).toHaveLength(cases.length);
  for (const [index, testCase] of cases.entries()) {
    for (const family of ['inet', 'bridge'] as const) {
      const typescript = firewallProjection(testCase.generated, testCase.live, family);
      const python = response.results[index]?.[family];
      if (typescript === undefined) expect(python).toBeNull();
      else expect(python).toEqual({ hash: typescript.hash, packets: Number(typescript.packets) });
    }
  }
});
