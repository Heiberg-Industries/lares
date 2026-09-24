import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { generateEgress } from '../lib/egress.js';

// Read-only production capture, 2026-09-16 17:39 Europe/Oslo. Live adds
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
const addresses = ['172.18.0.24', '172.18.0.25', '172.18.0.26'];
const names = ['saga', 'marcel', 'calliope'];
const roles = ['chief-of-staff', 'travel', 'creative'];
const agents = roles.map((role, i) => ({ name: names[i], address: addresses[i], grants: JSON.parse(readFileSync(new URL(`../../${role}/agent.json`, import.meta.url), 'utf8')).grants, doors: [{ kind: 'slack' as const, enabled: true }, { kind: 'telegram' as const, enabled: true }], infrastructureHosts: ['cloud.langfuse.com'] }));
// Retain legacy/non-agent consumers under their own SOURCE ACLs. Their historical
// broad access is preserved; it cannot be borrowed by the three current agents.
const oldHosts = [...new Set(aclValues(baseline, 'dstdomain'))].sort();
const options = {
  legacyConsumers: [10, 11, 13, 14, 23].map(n => ({ name: `legacy-${n}`, address: `172.18.0.${n}`, hosts: oldHosts })),
  internalNetworks: ['172.18.0.0/16'],
  directDestinations: ['192.0.2.10', '198.51.100.10', '37.59.57.117', '51.210.3.20', '51.210.3.23', '51.255.82.75', '149.154.160.0/20'],
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
  expect(allowed(squid, addresses[1], 'maps.googleapis.com')).toBe(true);
  expect(allowed(squid, addresses[2], 'gmail.googleapis.com')).toBe(false);
  expect(allowed(squid, addresses[0], 'api.notion.com')).toBe(true);
  expect(allowed(squid, addresses[1], 'api.notion.com')).toBe(false);
  expect(allowed(squid, addresses[2], 'api.github.com')).toBe(false);
  expect(allowed(squid, addresses[1], 'api.frankfurter.dev')).toBe(true);
  expect(allowed(squid, addresses[0], 'api.frankfurter.dev')).toBe(false);
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
  expect(result.match(sourceSet)?.[1]).toBe(nft.match(sourceSet)?.[1]);
  const destinations = (s: string) => [...s.matchAll(/ip daddr (.+) accept/g)].flatMap(m => m[1].replace(/[{}]/g, '').split(/[,\s]+/).filter(Boolean)).sort();
  expect(destinations(result)).toEqual(destinations(nft));
  for (const rule of ['ct state established,related accept', 'udp dport 53 accept', 'tcp dport 53 accept']) expect(result).toContain(rule);
  expect(result.indexOf('ip saddr')).toBeLessThan(result.indexOf('ct state'));
  expect(result.indexOf('ct state')).toBeLessThan(result.indexOf('ip daddr'));
  expect(result.indexOf('ip daddr')).toBeLessThan(result.indexOf('counter drop'));
});
