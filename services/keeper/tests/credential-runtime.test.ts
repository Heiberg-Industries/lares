import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hashOf, parseDefinition } from '@lares/agent-kit/definition';
import type { Pool } from 'pg';
import type { KeeperConfig } from '../lib/config.js';
import type { DockerBoundary } from '../lib/docker.js';
import type { AgentLifecycle } from '../lib/lifecycle.js';
import { OwnedCredentialRuntime } from '../lib/credential-runtime.js';
import { initialCredentialRecord } from '../lib/credential-state.js';

let root: string, row: any, runtime: any, config: KeeperConfig, docker: DockerBoundary, boundary: OwnedCredentialRuntime;
const revision = randomUUID(), incarnation = randomUUID(), image = 'example/runtime@sha256:' + 'a'.repeat(64);
const preflight = vi.fn(async () => {}), reconcile = vi.fn(async () => {}), unlock = vi.fn(async () => {});
const record = () => ({ ...initialCredentialRecord(), activeRevision: revision, phase: 'applied' as const });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'credential-runtime-')));
  const agentsDir = join(root, 'agents'), dir = join(agentsDir, 'example'); mkdirSync(dir, { recursive: true });
  const definition = parseDefinition({ ...JSON.parse(readFileSync(new URL('../../../packages/agent-kit/templates/creative/agent.json', import.meta.url), 'utf8')), name: 'example', role: 'creative', doors: [], grants: [], autonomy: {} });
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(definition)); writeFileSync(join(dir, 'duties.md'), ''); writeFileSync(join(dir, 'voice.md'), '');
  row = { name: 'example', definition, applied_definition: definition, duties: '', voice: '', hash: hashOf({ definition, dutiesMd: '', voiceMd: '' }), status: 'valid',
    ownership_token: incarnation, runtime_control_token: incarnation, address: '172.30.0.10', workflow_database: 'test', state: 'ready', pending: false };
  config = { agentsDir, secretsDir: join(root, 'secrets'), credentials: { administrator: 'admin@example.invalid', slot: 'notion:shared', binding: 'NOTION_TOKEN_FILE', prepared: true, inventoryComplete: true, retainedConsumers: [] },
    lifecycle: { imageByRole: { creative: image }, defaultBindings: { creative: { role: 'creative', secrets: { NOTION_TOKEN_FILE: join(root, 'secrets/notion-token') }, environment: {}, mounts: [] } } } } as unknown as KeeperConfig;
  runtime = { id: 'a'.repeat(64), running: true, incarnation, notionRevision: revision, image, mounts: [{ source: join(root, 'secrets/notion-token'), destination: '/run/secrets/notion-token' }], addresses: ['172.30.0.10'] };
  docker = { inspect: vi.fn(async () => runtime), healthy: vi.fn(async () => true), credentialMounts: vi.fn(async () => [{ name: 'example', incarnation, owned: true }]), stop: vi.fn(async () => { runtime.running = false; }) } as unknown as DockerBoundary;
  const pool = { query: async (sql: string) => ({ rows: sql.includes('agent_door_connections') ? [] : [row] }), connect: async () => ({ query: async (sql: string) => { if (sql.includes('unlock')) await unlock(); return { rows: [{ acquired: true }] }; }, release: vi.fn() }) } as unknown as Pool;
  boundary = new OwnedCredentialRuntime(pool, config, { credentialPreflight: preflight, reconcileCredential: reconcile } as unknown as AgentLifecycle, docker);
  preflight.mockClear(); reconcile.mockClear(); unlock.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('derives stable confirmation from real definitions/bindings/ownership and actual mounts', async () => {
  const before = await boundary.snapshot(record()); expect(before.consumers).toEqual([{ name: 'example', category: 'owned-agent', incarnation }]);
  expect(before.revision).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(before)).not.toContain(root);
  runtime.id = 'b'.repeat(64); expect((await boundary.snapshot(record())).revision).toBe(before.revision);
  config.lifecycle!.runtime = { schedulesLive: false } as never;
  expect((await boundary.snapshot(record())).revision).not.toBe(before.revision);
});
it.each(['incarnation', 'image', 'address', 'mount', 'revision', 'health', 'unknown-mount', 'grant', 'pending'] as const)('refuses %s before any runtime/file effect', async change => {
  if (change === 'incarnation') runtime.incarnation = randomUUID();
  if (change === 'image') runtime.image = 'other';
  if (change === 'address') runtime.addresses = [];
  if (change === 'mount') runtime.mounts[0].source = '/external';
  if (change === 'revision') runtime.notionRevision = randomUUID();
  if (change === 'health') vi.mocked(docker.healthy!).mockResolvedValue(false);
  if (change === 'unknown-mount') vi.mocked(docker.credentialMounts!).mockResolvedValue([{ name: 'unmanaged', incarnation: null, owned: false }]);
  if (change === 'grant') writeFileSync(join(config.agentsDir, 'example', 'duties.md'), 'changed grant instructions');
  if (change === 'pending') row.pending = true;
  await expect(boundary.snapshot(record())).rejects.toThrow(); expect(docker.stop).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
});
it('quiesces only proven incarnation and verifies the stopped state', async () => {
  vi.mocked(docker.stop).mockImplementation(async () => { runtime.running = false; runtime.addresses = []; });
  await expect(boundary.quiesce('example', randomUUID())).rejects.toThrow(); expect(docker.stop).not.toHaveBeenCalled();
  await boundary.quiesce('example', incarnation); expect(runtime.running).toBe(false);
});
it('refuses an unknown grant even when file, saved and applied hashes agree', async () => {
  row.definition = { ...row.definition, grants: [{ capability: 'retired-capability', scope: 'read' }] };
  row.applied_definition = row.definition;
  row.hash = hashOf({ definition: row.definition, dutiesMd: '', voiceMd: '' });
  writeFileSync(join(config.agentsDir, 'example', 'agent.json'), JSON.stringify(row.definition));
  await expect(boundary.snapshot(record())).rejects.toThrow();
  expect(docker.stop).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
});
it('releases the existing namespace lock even after a failure', async () => {
  await expect(boundary.locked(async () => { throw new Error('local failure'); })).rejects.toThrow('local failure'); expect(unlock).toHaveBeenCalledOnce();
});
