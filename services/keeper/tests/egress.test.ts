import { expect, it } from 'vitest';
import { generateEgress, type EgressAgent } from '../lib/egress.js';
const agent: EgressAgent = { name: 'alpha', address: '172.18.0.40', grants: [] };
it('seals bare agents and grants/revokes vendor and enabled door access by source', () => {
  const bare = generateEgress([agent]);
  expect(bare.perAgent.alpha).toEqual([]);
  expect(bare.squid).not.toContain('http_access allow');
  expect(bare.nft).toContain('172.18.0.40');
  expect(bare.nft).toContain('counter drop');
  const result = generateEgress([{ ...agent, grants: [{ capability: 'notion', scope: 'read' }], doors: [{ kind: 'slack', enabled: true }, { kind: 'telegram', enabled: false }] }]);
  expect(result.perAgent.alpha).toEqual(['.slack-files.com', '.slack.com', 'api.notion.com']);
  expect(result.squid).toContain('acl src_alpha src 172.18.0.40');
  expect(result.squid).toContain('http_access allow CONNECT src_alpha dst_alpha SSL_ports');
  expect(generateEgress([{ ...agent, grants: [{ capability: 'notion', scope: 'none' }] }]).perAgent.alpha).toEqual([]);
});
it('resolves only granted configured endpoints and explicit infrastructure', () => {
  const options = { endpoints: { READABILITY_URL: 'https://reader.example.org/extract', ORAKEL_URL: 'https://registry.example.org' } };
  expect(generateEgress([agent], options).perAgent.alpha).toEqual([]);
  expect(generateEgress([{ ...agent, grants: [{ capability: 'read_url', scope: 'read' }], infrastructureHosts: ['gateway.example.org'] }], options).perAgent.alpha).toEqual(['gateway.example.org', 'reader.example.org']);
});
it('rejects config injection, duplicate sources, malformed addresses, hosts and scopes', () => {
  for (const name of ['x\nhttp_access allow all', '__proto__', 'x y']) expect(() => generateEgress([{ ...agent, name }])).toThrow();
  for (const address of ['0.0.0.0/0', '999.1.1.1', '172.18.0.40\naccept']) expect(() => generateEgress([{ ...agent, address }])).toThrow();
  for (const host of ['.com', '*.example.org', 'https://x.org', 'x.org:443', 'x.org\nallow all']) expect(() => generateEgress([{ ...agent, infrastructureHosts: [host] }])).toThrow();
  expect(() => generateEgress([agent, { ...agent, name: 'beta' }])).toThrow();
  expect(() => generateEgress([{ ...agent, grants: [{ capability: 'notion', scope: 'invalid' }] }])).toThrow();
  expect(() => generateEgress([agent], { legacyConsumers: [{ name: 'old', address: agent.address, hosts: ['api.github.com'] }] })).toThrow();
  expect(() => generateEgress([agent], { directDestinations: ['0.0.0.0/0'] })).toThrow();
  for (const capability of ['missing', 'constructor', '__proto__']) expect(() => generateEgress([{ ...agent, grants: [{ capability, scope: 'read' }] }])).toThrow();
  for (const url of ['http://reader.example.org', 'https://reader.example.org:8443', 'https://user:secret@reader.example.org', 'https://reader.example.org\nallow']) {
    expect(() => generateEgress([{ ...agent, grants: [{ capability: 'read_url', scope: 'read' }] }], { endpoints: { READABILITY_URL: url } })).toThrow();
  }
});
it('is deterministic and keeps retained consumers source-scoped', () => {
  const options = { legacyConsumers: [{ name: 'sync', address: '172.18.0.11', hosts: ['api.github.com', 'api.notion.com'] }], internalNetworks: ['172.18.0.0/16'], directDestinations: ['192.0.2.8'] };
  const result = generateEgress([agent], options);
  expect(result.squid).toContain('http_access allow CONNECT src_sync dst_sync SSL_ports');
  expect(result.squid).not.toContain('http_access allow CONNECT dst_sync');
  expect(result.nft).toContain('ip saddr != { 172.18.0.11, 172.18.0.40 } accept');
  expect(result.nft).toContain('ip daddr 192.0.2.8 accept');
  expect(result.nft).not.toContain('flush');
  expect(result.nft.split('\n').slice(1, 4)).toEqual(['add table inet saga_egress', 'delete table inet saga_egress', 'table inet saga_egress {']);
  expect(result.nft.match(/delete table/g)).toHaveLength(1);
  expect(result).toEqual(generateEgress([agent], options));
});

it('canonicalizes overlapping domains inside each Squid ACL without losing metadata', () => {
  const result = generateEgress([{ ...agent, grants: [{ capability: 'gmail', scope: 'read' }, { capability: 'places', scope: 'read' }] }]);
  expect(result.perAgent.alpha).toContain('.googleapis.com');
  expect(result.perAgent.alpha).toContain('places.googleapis.com');
  const domains = result.squid.split('\n').find(line => line.startsWith('acl dst_alpha '))!.split(' ').slice(3);
  expect(domains).toContain('.googleapis.com');
  expect(domains).not.toContain('places.googleapis.com');
  expect(domains).not.toContain('maps.googleapis.com');
  expect(domains).toContain('api.entur.io');
});
