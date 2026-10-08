import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { credentialConsumers, type CredentialConsumerConfig } from '../lib/credential-consumers.js';
const incarnation = randomUUID();
const config = (): CredentialConsumerConfig => ({ secretsDir: '/srv/lares/secrets', credentials: {
  slot: 'notion:shared', binding: 'NOTION_TOKEN_FILE', prepared: true, inventoryComplete: true, retainedConsumers: [],
}, lifecycle: {
  bindings: {}, defaultBindings: { creative: { role: 'creative', environment: {}, mounts: [], secrets: { NOTION_TOKEN_FILE: '/srv/lares/secrets/notion-token' } } },
} });
const owned = { name: 'example', definition: { role: 'creative' }, status: 'valid', ownership_token: incarnation, runtime_control_token: incarnation, state: 'ready', applied_definition: {role:'creative'}, pending:false };
const pool = (rows: unknown[]) => ({ query: vi.fn(async () => ({ rows })) } as unknown as Pool);
it('enumerates actual consumers and root-retained consumers separately from declarations', async () => {
  const c = config();
  expect(await credentialConsumers(pool([]), c)).toEqual([]);
  expect(await credentialConsumers(pool([owned]), c)).toEqual([{ name: 'example', category: 'owned-agent', incarnation }]);
  c.credentials!.retainedConsumers = [{ name: 'sync', category: 'unmanaged-service' }];
  expect(await credentialConsumers(pool([owned]), c)).toHaveLength(2);
});
it('refuses incomplete or unreadable inventory instead of assuming no consumers', async () => {
  const c = config(); c.credentials!.inventoryComplete = false;
  await expect(credentialConsumers(pool([]), c)).rejects.toThrow();
  c.credentials!.inventoryComplete = true;
  await expect(credentialConsumers({query: async () => {throw new Error('unavailable');}} as never, c)).rejects.toThrow();
  await expect(credentialConsumers(pool([{...owned, definition: null}]), c)).rejects.toThrow();
});
it('reports uncontrolled, unready and external bound consumers with fixed categories', async () => {
  for (const overrides of [{runtime_control_token: null}, {state: 'provisioning'}, {status: 'retired'}])
    expect(await credentialConsumers(pool([{...owned, ...overrides}]), config())).toMatchObject([{category: 'runtime-not-ready'}]);
  const c = config(); c.lifecycle!.bindings = { example: { ...c.lifecycle!.defaultBindings!.creative!, secrets: { NOTION_TOKEN_FILE: '/etc/lares/secrets/notion-token' } } };
  const result = await credentialConsumers(pool([owned]), c);
  expect(result.every(r => r.category === 'external-binding')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('/etc/');
});
it('includes unregistered named token bindings; skips only retired resource plus definition pairs', async () => {
  const c = config(); c.lifecycle!.bindings = { missing: c.lifecycle!.defaultBindings!.creative! };
  expect(await credentialConsumers(pool([]), c)).toMatchObject([{name: 'missing', category: 'runtime-not-ready'}]);
  expect(await credentialConsumers(pool([{...owned, state: 'retired', status: 'retired'}]), config())).toEqual([]);
});

it('retains applied Notion consumers when an unreconciled saved role has no token binding', async () => {
  const desired = {...owned, definition:{role:'travel'}, pending:true};
  expect(await credentialConsumers(pool([desired]), config())).toMatchObject([{name:'example', category:'runtime-not-ready'}]);
  expect(await credentialConsumers(pool([{...owned, applied_definition:null}]), config())).toMatchObject([{category:'runtime-not-ready'}]);
  expect(await credentialConsumers(pool([{...desired, applied_definition:null}]), config())).toMatchObject([{name:'example',category:'runtime-not-ready'}]);
});
it('finds alternate broad mounts and retained Notion egress consumers without trusting empty declarations', async () => {
  const c=config();
  c.lifecycle!.defaultBindings!.creative!.mounts=[{source:'/srv/lares/secrets',target:'/data',readOnly:true}];
  c.lifecycle!.egress={legacyConsumers:[{name:'sync',address:'172.30.0.40',hosts:['api.notion.com']}]};
  expect(await credentialConsumers(pool([owned]),c)).toMatchObject([{name:'alternate-mount',category:'external-binding'},{name:'example',category:'owned-agent'},{name:'sync',category:'unmanaged-service'}]);
});
