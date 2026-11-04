import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import { renderServicesCompose } from '../lib/compose-services.js';
import { generateEgress } from '../lib/egress.js';
import type { DockerBoundary } from '../lib/docker.js';
import { NotionSyncService, planNotionSync, syncInEffect, readNotionSyncSettings, type NotionSyncSettings, type SyncPlanInput } from '../lib/sync-service.js';

const MEETINGS = '11111111-1111-4111-8111-111111111111';
const PEOPLE = '22222222-2222-4222-8222-222222222222';
const IMAGE = `ghcr.io/example/sync-jobs@sha256:${'a'.repeat(64)}`;
const input = (over: Partial<SyncPlanInput> = {}): SyncPlanInput => ({
  installationId: '3b7f2b1c-0000-4000-8000-000000000001', ownerEmail: 'owner@example.com',
  google: { principal: 'owner', tokenKeyFile: '/srv/secrets/token-key', clients: { acme: { clientIdFile: '/srv/secrets/gid', clientSecretFile: '/srv/secrets/gsecret' } } },
  crm: { baseUrl: 'https://crm.example.org', keyFile: '/srv/secrets/crm-key' }, ...over,
});
const settings = (over: Partial<NotionSyncSettings> = {}): NotionSyncSettings => ({ enabled: true, meetings: MEETINGS, people: PEOPLE, ack: null, address: null, preview: null, ...over });

describe('planNotionSync', () => {
  it('runs only the passes that need no vault, and says so in the rendered config', () => {
    const plan = planNotionSync(settings(), input());
    expect(plan.passes).toEqual(['attendees', 'people']);
    expect(plan.config).toMatchObject({ passes: ['attendees', 'people'], meetingsDataSourceId: MEETINGS, people: { dataSourceId: PEOPLE } });
    for (const vaultPass of ['transcripts', 'notion-born', 'pull', 'apply', 'wiki', 'desk', 'auto-two-way'])
      expect(plan.config!.passes).not.toContain(vaultPass);
    expect(plan.config).not.toHaveProperty('vaultPath');
    expect(plan.hosts).toEqual(['api.notion.com', '.googleapis.com']);
    expect(plan.endpoints).toEqual(['https://crm.example.org']);
  });
  it('names a plain reason for everything missing and refuses to plan nothing', () => {
    expect(planNotionSync(settings({ meetings: null }), input()).problems.join(' ')).toMatch(/meetings database/);
    const none = planNotionSync(settings({ people: null }), input({ google: undefined }));
    expect(none).toMatchObject({ passes: [], hash: null, config: null });
    expect(none.problems.join(' ')).toMatch(/Google calendar/);
    expect(planNotionSync(settings(), input({ crm: {} })).passes).toEqual(['attendees']);
    expect(planNotionSync(settings(), input({ ownerEmail: undefined })).hash).toBeNull();
  });
  it('falls back to the installation file for the meetings database', () => {
    expect(planNotionSync(settings({ meetings: null }), input({ meetingsFallback: MEETINGS })).hash).not.toBeNull();
  });
  it('changes its hash with anything that reaches the configuration, and is bound to the installation', () => {
    const base = planNotionSync(settings(), input()).hash;
    expect(planNotionSync(settings(), input()).hash).toBe(base);
    expect(planNotionSync(settings({ people: null }), input()).hash).not.toBe(base);
    expect(planNotionSync(settings({ meetings: '33333333-3333-4333-8333-333333333333' }), input()).hash).not.toBe(base);
    expect(planNotionSync(settings(), input({ installationId: 'another-server' })).hash).not.toBe(base);
  });
  it('also changes its hash with the contacts address and the calendar owner, but not with key file locations', () => {
    const base = planNotionSync(settings(), input()).hash;
    expect(planNotionSync(settings(), input({ crm: { baseUrl: 'https://other.example.org', keyFile: '/srv/secrets/crm-key' } })).hash).not.toBe(base);
    expect(planNotionSync(settings(), input({ google: { ...input().google!, principal: 'someone-else' } })).hash).not.toBe(base);
    expect(planNotionSync(settings(), input({ crm: { baseUrl: 'https://crm.example.org', keyFile: '/elsewhere' } })).hash).toBe(base);
  });
  it('treats a stored empty meetings value as none, not as the installation file', () => {
    expect(planNotionSync(settings({ meetings: '' }), input({ meetingsFallback: MEETINGS })).hash).toBeNull();
    expect(planNotionSync(settings({ meetings: '' }), input({ meetingsFallback: MEETINGS })).problems.join(' ')).toMatch(/meetings database/);
  });
  it('refuses plainly, and contributes nothing, while an older hand-run sync or an agent of the same name exists', () => {
    const old = planNotionSync(settings(), input({ legacySync: true }));
    expect(old).toMatchObject({ hash: null, config: null, passes: [], hosts: [], endpoints: [] });
    expect(old.problems[0]).toMatch(/older hand-run Notion sync is still set up on this server; remove it first/);
    const agent = planNotionSync(settings(), input({ agentNamedSync: true }));
    expect(agent.hash).toBeNull();
    expect(agent.problems[0]).toMatch(/agent named notion-sync/);
  });
  it('is in effect only when switched on AND the accepted hash is the current one', () => {
    const plan = planNotionSync(settings(), input());
    expect(syncInEffect(settings(), plan)).toBe(false);
    expect(syncInEffect(settings({ ack: plan.hash }), plan)).toBe(true);
    expect(syncInEffect(settings({ ack: plan.hash, enabled: false }), plan)).toBe(false);
    expect(syncInEffect(settings({ ack: 'f'.repeat(64) }), plan)).toBe(false);
    expect(syncInEffect(settings({ ack: plan.hash }), planNotionSync(settings({ people: null }), input()))).toBe(false);
  });
});

describe('services compose', () => {
  const spec = { service: 'lares-notion-sync', image: IMAGE, command: ['tsx', 'x.ts'], address: '172.30.0.9', environment: { A: 'b' },
    secrets: [{ file: '/srv/secrets/notion-token', target: 'notion-token' }], files: [{ source: '/srv/c.json', target: '/etc/lares/c.json' }], labels: { l: 'v' } };
  it('renders a pinned, hardened, address-fixed container', () => {
    const doc = parse(renderServicesCompose([spec], 'lares-fleet'));
    const s = doc.services['lares-notion-sync'];
    expect(s).toMatchObject({ image: IMAGE, read_only: true, user: '10001:10001', cap_drop: ['ALL'], networks: { 'lares-fleet': { ipv4_address: '172.30.0.9' } } });
    expect(s.volumes[0]).toMatchObject({ source: '/srv/c.json', read_only: true });
    expect(doc.secrets['lares-notion-sync-notion-token']).toEqual({ file: '/srv/secrets/notion-token' });
  });
  it('refuses a mutable tag, a bad address and a duplicate', () => {
    expect(() => renderServicesCompose([{ ...spec, image: 'ghcr.io/example/sync-jobs:latest' }], 'n')).toThrow();
    expect(() => renderServicesCompose([{ ...spec, address: 'nope' }], 'n')).toThrow();
    expect(() => renderServicesCompose([spec, spec], 'n')).toThrow();
  });
});

describe('egress as a managed service', () => {
  it('scopes the sync to its own source address and its own hosts, not as a hand-written legacy entry', () => {
    const e = generateEgress([], { managedServices: [{ name: 'notion-sync', address: '172.30.0.9', hosts: ['api.notion.com', '.googleapis.com'], endpoints: ['https://crm.example.org'] }] });
    expect(e.perAgent).toEqual({});
    expect(e.squid).toContain('acl src_notion-sync src 172.30.0.9');
    expect(e.squid).toMatch(/dstdomain .*api\.notion\.com/);
    expect(e.squid).toContain('crm.example.org');
    expect(e.nft).toContain('172.30.0.9');
  });
  it('refuses a source address an agent already holds', () => {
    expect(() => generateEgress([{ name: 'alpha', address: '172.30.0.9', grants: [] }], { managedServices: [{ name: 'notion-sync', address: '172.30.0.9', hosts: [] }] })).toThrow();
  });
});

// ---- the running service, against an in-memory settings table and a recording Docker ------------
function fakePool() {
  const rows = new Map<string, unknown>();
  const agentNamed = new Set<string>();
  const pool = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/FROM settings WHERE key/.test(sql)) return { rows: rows.has(String(params[0])) ? [{ value: rows.get(String(params[0])) }] : [] };
    if (/INSERT INTO settings/.test(sql)) { rows.set(String(params[0]), JSON.parse(String(params[1]))); return { rows: [] }; }
    if (/FROM agent_definitions/.test(sql)) return { rows: agentNamed.has(String(params[0])) ? [{ one: 1 }] : [] };
    if (/notion_sync_run/.test(sql)) return { rows: [{ last_run_at: new Date('2026-01-02T03:04:05Z') }] };
    throw new Error(`unexpected query ${sql}`);
  }) } as unknown as Pool;
  return { pool, rows, agentNamed };
}

describe('NotionSyncService', () => {
  let dir: string, calls: string[], revision: string | null, previewOutput: string, runningImage: string, removed: boolean, onRun: () => void;
  let state: ReturnType<typeof fakePool>;
  const docker = (): DockerBoundary => ({
    serviceUp: async (_f, s) => { calls.push(`up:${s}`); }, serviceRemove: async s => { calls.push(`remove:${s}`); },
    serviceInspect: async () => (!removed && calls.includes('up:lares-notion-sync') && !calls.at(-1)?.startsWith('remove') ? { running: true, image: runningImage, notionRevision: revision, mounts: [{ source: '/srv/lares/secrets/notion-token', destination: '/run/secrets/notion-token' }] } : null),
    serviceRunOnce: async (_f, _s, command) => { calls.push(`once:${command.at(-1)}`); onRun(); return `some log line\n${previewOutput}\n`; },
  } satisfies Pick<DockerBoundary, 'serviceUp' | 'serviceRemove' | 'serviceInspect' | 'serviceRunOnce'> as unknown as DockerBoundary);
  const make = (variant?: 'legacy') => new NotionSyncService({
    pool: state.pool, docker: docker(), credentialRevision: async () => revision, reseal: async () => { calls.push('reseal'); }, takenAddresses: async () => ['172.30.0.1', '172.30.0.2'],
    config: { secretsDir: '/srv/lares/secrets', credentials: { administrator: 'owner@example.com' } as never, lifecycle: {
      network: 'lares-fleet', subnet: '172.30.0.0/24', composeFile: join(dir, 'compose.lares-agents.yaml'), services: { composeFile: join(dir, 'compose.lares-services.yaml'), notionSyncImage: IMAGE },
      maintenanceAdmission: { hostDirectory: '/x', installationId: 'inst-1', epoch: 1 },
      runtime: { databaseUrl: 'postgres://lares_app@db:5432/lares_state', passwordFile: '/srv/secrets/db', proxyUrl: 'http://lares-egress-proxy:8888',
        google: { principal: 'owner', tokenKeyFile: '/srv/secrets/token-key', clients: { acme: { clientIdFile: '/srv/secrets/gid', clientSecretFile: '/srv/secrets/gsecret' } } } },
      egress: { endpoints: { TWENTY_BASE_URL: 'https://crm.example.org' }, legacyConsumers: variant === 'legacy' ? [{ name: 'notion-sync', address: '172.30.0.7', hosts: ['api.notion.com'] }] : [], internalNetworks: [], directDestinations: [], infrastructureHosts: [] },
      defaultBindings: { 'chief-of-staff': { role: 'chief-of-staff', environment: {}, mounts: [], secrets: { TWENTY_KEY_FILE: '/srv/secrets/crm-key' } } },
    } as never },
  });
  const set = (key: string, value: unknown) => state.rows.set(key, value);
  const currentHash = async () => planNotionSync(await readNotionSyncSettings(state.pool), { installationId: 'inst-1', ownerEmail: 'owner@example.com',
    google: { principal: 'owner', tokenKeyFile: '/srv/secrets/token-key', clients: { acme: { clientIdFile: '/srv/secrets/gid', clientSecretFile: '/srv/secrets/gsecret' } } },
    crm: { baseUrl: 'https://crm.example.org', keyFile: '/srv/secrets/crm-key' } }).hash!;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-'));
    calls = []; runningImage = IMAGE; removed = false; onRun = () => {}; revision = '99999999-9999-4999-8999-999999999999'; state = fakePool();
    previewOutput = JSON.stringify({ version: 1, passes: { attendees: { create: 0, adoptPatch: 2, skip: 5, conflict: 0 }, people: { create: 1, adoptPatch: 0, skip: 3, conflict: 0 } } });
    set('notion.meetings_data_source', MEETINGS); set('sync.notion.people_data_source', PEOPLE);
  });

  it('starts nothing while it is switched off, and takes no firewall rule', async () => {
    expect(await make().apply('owner', { start: true })).toBe('off');
    expect(calls).toEqual(['remove:lares-notion-sync']);
    expect(await make().egress()).toEqual([]);
  });
  it('starts nothing when switched on but no preview was accepted', async () => {
    set('sync.notion.enabled', true);
    expect(await make().apply('owner', { start: true })).toBe('off');
    expect(calls).not.toContain('up:lares-notion-sync');
    expect(existsSync(join(dir, 'compose.lares-services.yaml'))).toBe(false);
  });
  it('starts nothing when the accepted preview belongs to an older configuration', async () => {
    set('sync.notion.enabled', true); set('sync.notion.preview_ack', 'e'.repeat(64));
    expect(await make().apply('owner', { start: true })).toBe('off');
    expect(calls).not.toContain('up:lares-notion-sync');
  });
  it('starts nothing without an applied Notion key', async () => {
    set('sync.notion.enabled', true); set('sync.notion.preview_ack', await currentHash()); revision = null;
    expect(await make().apply('owner', { start: true })).toBe('off');
    expect(calls).not.toContain('up:lares-notion-sync');
  });
  it('previews, then starts only after the owner accepts exactly that preview', async () => {
    const service = make();
    set('sync.notion.enabled', true);
    await expect(service.accept('owner', await currentHash())).rejects.toThrow(/out of date/);
    await service.preview('owner');
    expect(calls).toEqual(['reseal', 'once:--preview']);
    expect(state.rows.get('sync.notion.preview')).toMatchObject({ hash: await currentHash(), passes: { attendees: { adoptPatch: 2 }, people: { create: 1 } } });
    expect((await service.view(true)).phase).toBe('ready-to-accept');
    await expect(service.accept('owner', 'd'.repeat(64))).rejects.toThrow(/out of date/);
    expect(calls).not.toContain('up:lares-notion-sync');
    await service.accept('owner', await currentHash());
    expect(calls).toEqual(expect.arrayContaining(['reseal', 'up:lares-notion-sync']));
    expect(calls.indexOf('reseal', 1)).toBeLessThan(calls.indexOf('up:lares-notion-sync'));
    expect((await service.view(true)).phase).toBe('on');
    const compose = parse(readFileSync(join(dir, 'compose.lares-services.yaml'), 'utf8'));
    expect(compose.services['lares-notion-sync'].image).toBe(IMAGE);
    expect(compose.services['lares-notion-sync'].labels['lares.notion-revision']).toBe(revision);
    expect(JSON.parse(readFileSync(join(dir, 'notion-sync.config.json'), 'utf8')).passes).toEqual(['attendees', 'people']);
    expect(await service.egress()).toMatchObject([{ name: 'notion-sync', hosts: ['api.notion.com', '.googleapis.com'] }]);
  });
  it('stops the service as soon as the configuration changes, because the acceptance no longer matches', async () => {
    const service = make();
    set('sync.notion.enabled', true);
    await service.preview('owner'); await service.accept('owner', await currentHash());
    calls.length = 0;
    set('sync.notion.people_data_source', '');
    expect(await service.apply('owner', { start: true })).toBe('off');
    expect(calls).toEqual(['remove:lares-notion-sync', 'reseal']);
    expect((await service.view(true)).phase).toBe('needs-preview');
    // Changing it back must not bring the old acceptance to life: it was forgotten.
    expect(state.rows.get('sync.notion.preview_ack')).toBe('');
    set('sync.notion.people_data_source', PEOPLE);
    calls.length = 0;
    expect(await service.apply('owner', { start: true })).toBe('off');
    expect(calls).not.toContain('up:lares-notion-sync');
  });
  it('refuses a new preview while the service is running with the current settings', async () => {
    const service = make();
    set('sync.notion.enabled', true);
    await service.preview('owner'); await service.accept('owner', await currentHash());
    await expect(service.preview('owner')).rejects.toThrow(/Switch it off/);
  });
  it('a keeper that has just started only ever stops the service, never starts it', async () => {
    set('sync.notion.enabled', true); set('sync.notion.preview_ack', await currentHash());
    expect(await make().apply('keeper', { start: false })).toBe('running');
    expect(calls).toEqual([]);
    set('sync.notion.enabled', false);
    expect(await make().apply('keeper', { start: false })).toBe('off');
    expect(calls).toEqual(['remove:lares-notion-sync']);
  });
  it('refuses a preview that does not cover every part, or is not the engine\'s output', async () => {
    set('sync.notion.enabled', true);
    previewOutput = JSON.stringify({ version: 1, passes: { attendees: { create: 0, adoptPatch: 0, skip: 0, conflict: 0 } } });
    await expect(make().preview('owner')).rejects.toThrow(/every part/);
    previewOutput = 'not json';
    await expect(make().preview('owner')).rejects.toThrow(/did not finish/);
    expect(state.rows.has('sync.notion.preview')).toBe(false);
  });
  it('allocates one address, keeps it, and verifies the real container against the key revision', async () => {
    const service = make();
    set('sync.notion.enabled', true);
    await service.preview('owner');
    expect(state.rows.get('sync.notion.address')).toBe('172.30.0.3');
    expect(await service.reservedAddresses()).toEqual(['172.30.0.3']);
    await service.accept('owner', await currentHash());
    await service.verify(revision);
    await expect(service.verify('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/key binding changed/);
    await service.quiesce();
    await expect(service.verify(null)).resolves.toBeUndefined();
  });
  it('refuses the sync, takes no firewall rule and plans no egress when an older hand-run sync is configured', async () => {
    const service = make('legacy');
    set('sync.notion.enabled', true);
    expect(await service.egress()).toEqual([]);
    await expect(service.preview('owner')).rejects.toThrow(/older hand-run Notion sync/);
    expect((await service.view(true)).phase).toBe('needs-setup');
  });
  it('reads a stored empty meetings value as none for the sync, not as the installation file\'s value', async () => {
    set('notion.meetings_data_source', '');
    const read = await readNotionSyncSettings(state.pool);
    expect(planNotionSync({ ...read, enabled: true }, input({ meetingsFallback: MEETINGS })).hash).toBeNull();
    state.rows.delete('notion.meetings_data_source');
    expect(planNotionSync({ ...(await readNotionSyncSettings(state.pool)), enabled: true }, input({ meetingsFallback: MEETINGS })).hash).not.toBeNull();
  });
  it('refuses the sync while an agent named like the service exists', async () => {
    set('sync.notion.enabled', true);
    state.agentNamed.add('notion-sync');
    await expect(make().preview('owner')).rejects.toThrow(/agent named notion-sync/);
    expect(await make().egress()).toEqual([]);
  });
  it('forgets a stale acceptance on the stop-only path too, so going back to the old settings needs a new preview', async () => {
    const service = make();
    set('sync.notion.enabled', true);
    await service.preview('owner'); await service.accept('owner', await currentHash());
    set('sync.notion.people_data_source', '');
    expect(await make().apply('keeper', { start: false })).toBe('off');
    expect(state.rows.get('sync.notion.preview_ack')).toBe('');
    set('sync.notion.people_data_source', PEOPLE);
    calls.length = 0;
    expect(await make().apply('keeper', { start: true })).toBe('off');
    expect(calls).not.toContain('up:lares-notion-sync');
  });
  it('moves a running, accepted sync to a new image at keeper startup, and starts nothing that is not there', async () => {
    const service = make();
    set('sync.notion.enabled', true);
    await service.preview('owner'); await service.accept('owner', await currentHash());
    const since = () => calls.slice(calls.lastIndexOf('up:lares-notion-sync') + 1);
    expect(await make().apply('keeper', { start: false })).toBe('running');
    expect(since()).toEqual([]);
    const ups = () => calls.filter(c => c === 'up:lares-notion-sync').length;
    const before = ups();
    runningImage = `ghcr.io/example/sync-jobs@sha256:${'b'.repeat(64)}`;
    expect(await make().apply('keeper', { start: false })).toBe('running');
    expect(ups()).toBe(before + 1);
    expect(parse(readFileSync(join(dir, 'compose.lares-services.yaml'), 'utf8')).services['lares-notion-sync'].image).toBe(IMAGE);
    // Never created (or removed): startup does not create it.
    removed = true;
    expect(await make().apply('keeper', { start: false })).toBe('running');
    expect(ups()).toBe(before + 1);
  });
  it('runs the slow preview outside the lock, and stores nothing when the settings changed meanwhile', async () => {
    const service = make();
    set('sync.notion.enabled', true);
    let held = false, heldDuringRun: boolean | null = null, changeDuringRun = false;
    const guard = async <T>(work: () => Promise<T>): Promise<T> => { held = true; try { return await work(); } finally { held = false; } };
    onRun = () => { heldDuringRun = held; if (changeDuringRun) set('sync.notion.people_data_source', ''); };
    await service.preview('owner', guard);
    expect(heldDuringRun).toBe(false);
    expect(state.rows.has('sync.notion.preview')).toBe(true);
    state.rows.delete('sync.notion.preview');
    changeDuringRun = true;
    await expect(service.preview('owner', guard)).rejects.toThrow(/changed while the preview ran/);
    expect(state.rows.has('sync.notion.preview')).toBe(false);
  });
});
