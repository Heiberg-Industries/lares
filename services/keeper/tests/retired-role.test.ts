import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { lifecycleSchema } from '../lib/lifecycle-config.js';
import { runtimeBindingsSchema } from '../lib/runtime-bindings.js';
import { credentialConsumers, type CredentialConsumerConfig } from '../lib/credential-consumers.js';

// The travel role left the engine. An installation that ran it keeps a keeper.json and stored
// definitions that still name it; the keeper must keep loading and keep serving the other agents.
const image = 'example/image@sha256:' + 'a'.repeat(64);
const binding = (role: string) => ({ role, environment: {}, mounts: [], secrets: {} });
const base = {
  network: 'n', subnet: '172.18.0.0/24', reservedAddresses: [], composeFile: '/srv/c.yaml', egressDir: '/srv/e',
  imageByRole: { 'chief-of-staff': image, creative: image },
  proxyContainer: 'lares-egress-proxy', squidImage: image, firewallImage: image,
  adminDb: { host: 'db', port: 5432, user: 'lares', database: 'lares_state', passwordFile: '/secret' },
  workflowTemplate: 'lares_workflow_template', workflowOwner: 'lares',
  runtime: { schedulesLive: false, databaseUrl: 'postgres://lares@db/s', workflowServer: 'postgres://lares@db/', gatewayUrl: 'https://gw.example.test', proxyUrl: 'http://proxy:8888', passwordFile: '/p', gatewayKeys: {} },
  egress: { endpoints: {}, legacyConsumers: [], internalNetworks: [], directDestinations: [], infrastructureHosts: [] },
  installationPrepared: true,
};
it('loads an older keeper.json that still names the travel role, and drops those entries with a log line', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const parsed = lifecycleSchema.parse({
      ...base,
      imageByRole: { ...base.imageByRole, travel: image },
      defaultBindings: { creative: binding('creative'), travel: binding('travel') },
      bindings: { wanderer: binding('travel'), writer: binding('creative') },
    });
    expect(parsed.imageByRole).toEqual(base.imageByRole);
    expect(Object.keys(parsed.defaultBindings ?? {})).toEqual(['creative']);
    expect(Object.keys(parsed.bindings ?? {})).toEqual(['writer']);
    expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('travel') || m.includes('wanderer')).length).toBe(3);
  } finally { warn.mockRestore(); }
});
it('still refuses an unknown role in imageByRole', () => {
  expect(() => lifecycleSchema.parse({ ...base, imageByRole: { ...base.imageByRole, other: image } })).toThrow();
});
it('drops the environment settings only the travel role read, and keeps refusing unknown ones', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const parsed = runtimeBindingsSchema.parse({ role: 'chief-of-staff', environment: { TRAVEL_PATH: '/srv/trips', TASTE_ROOT: '/srv/taste', TZ: 'UTC' }, mounts: [], secrets: {} });
    expect(parsed.environment).toEqual({ TZ: 'UTC' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TRAVEL_PATH'));
  } finally { warn.mockRestore(); }
  expect(() => runtimeBindingsSchema.parse({ role: 'chief-of-staff', environment: { NOT_A_SETTING: 'x' }, mounts: [], secrets: {} })).toThrow();
});
it('refuses a new travel binding: the role is gone', () => {
  expect(() => runtimeBindingsSchema.parse(binding('travel'))).toThrow();
});
it('lists no credential consumer for a stored travel agent and does not fail for the others', async () => {
  const incarnation = randomUUID();
  const config: CredentialConsumerConfig = { secretsDir: '/srv/lares/secrets', credentials: { slot: 'notion:shared', binding: 'NOTION_TOKEN_FILE', prepared: true, inventoryComplete: true, retainedConsumers: [] }, lifecycle: { bindings: {}, defaultBindings: {} } };
  const row = (name: string, role: string) => ({ name, definition: { role }, status: 'valid', ownership_token: incarnation, runtime_control_token: incarnation, state: 'ready', applied_definition: { role }, pending: false });
  const pool = { query: vi.fn(async () => ({ rows: [row('wanderer', 'travel'), row('writer', 'creative')] })) } as unknown as Pool;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(credentialConsumers(pool, config)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wanderer'));
  } finally { warn.mockRestore(); }
});
