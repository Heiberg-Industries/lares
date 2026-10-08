import { randomUUID } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Credentials, registerCredentialActions } from '../lib/credentials.js';
import { CredentialFiles } from '../lib/credential-files.js';
import { CREDENTIAL_SLOT, credentialRecordSchema, credentialStatusSchema, initialCredentialRecord, type CredentialRecord, type CredentialConfig } from '../lib/credential-state.js';
import type { CredentialJournal, CredentialStore } from '../lib/credential-store.js';
import { resetActions, runAction, type AuditRecord } from '../lib/actions.js';
import type { NotionCredentialTester } from '../lib/notion-credential.js';

class MemoryStore implements CredentialStore {
  record = initialCredentialRecord();
  writes = 0;
  failAt = 0;
  busy = false;
  read = async () => structuredClone(this.record);
  async locked<T>(work: (j: CredentialJournal) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('operation in progress');
    this.busy = true;
    try { return await work({ read: this.read, save: async (old, next) => {
      this.writes++;
      if (this.writes === this.failAt) throw new Error('database error synthetic-secret');
      if (old.version !== this.record.version) throw new Error('stale');
      this.record = credentialRecordSchema.parse({ ...next, version: old.version + 1 });
      return structuredClone(this.record);
    } }); } finally { this.busy = false; }
  }
}
const admin = { actor: 'owner@example.invalid', audit: async (_: AuditRecord) => {} };
const host = { ...admin, actor: 'host', host: true };
const config: CredentialConfig = { administrator: admin.actor, slot: CREDENTIAL_SLOT, binding: 'NOTION_TOKEN_FILE', prepared: true, inventoryComplete: true, retainedConsumers: [] };
const secret = 'synthetic-secret-only';
let dir: string, files: CredentialFiles, store: MemoryStore, service: Credentials;
const inventory = vi.fn(async () => []);
const tester: NotionCredentialTester = { ready: vi.fn(() => true), test: vi.fn<NotionCredentialTester['test']>() };
function build(conf: CredentialConfig | undefined = config) { return new Credentials(conf, store, files, inventory, tester); }
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'credential-test-')));
  chmodSync(dir, 0o700);
  files = new CredentialFiles(dir, { uid: process.getuid!(), gid: process.getgid!() });
  store = new MemoryStore();
  inventory.mockReset(); inventory.mockResolvedValue([]);
  vi.mocked(tester.ready).mockReset().mockReturnValue(true);
  vi.mocked(tester.test).mockReset().mockResolvedValue({ outcome: 'passed', identity: { kind: 'internal-bot', botId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
  service = build(); resetActions(); registerCredentialActions(service);
});

const testInput = (revision: number) => ({ slot: CREDENTIAL_SLOT, expectedRevision: revision });
function active() {
  store.record = { ...initialCredentialRecord(), version: 1, phase: 'applied', activeRevision: randomUUID() };
  writeFileSync(files.activePath, secret, { mode: 0o600 });
}
it('test/save keeps the exact tested protected candidate pending without changing active bytes or consumers', async () => {
  active(); const before = store.record.activeRevision;
  const audit: AuditRecord[] = [];
  const result = await runAction('credential.test_save', { ...testInput(1), token: 'replacement-without-prefix' }, { ...admin, audit: async r => { audit.push(r); } });
  expect(result).toMatchObject({ state: 'pending-apply', revision: 4, activeRevision: before,
    test: { outcome: 'passed', identity: { kind: 'internal-bot' } }, activation: [], rollback: [] });
  expect(store.record.test?.revision).toBe(store.record.candidateRevision);
  expect(files.readCandidate(store.record.candidateRevision!)).toBe('replacement-without-prefix');
  expect(readFileSync(files.activePath, 'utf8')).toBe(secret);
  expect(tester.test).toHaveBeenCalledTimes(1);
  expect(tester.test).toHaveBeenCalledWith(expect.objectContaining({ kind: 'api_key', integration: 'notion', secretFile: expect.stringMatching(/\.candidate$/) }), expect.any(Function));
  expect(audit.map(r => r.outcome)).toEqual(['pending', 'ok']);
  expect(JSON.stringify(audit)).not.toContain('replacement-without-prefix');
  expect(JSON.stringify(result)).not.toContain(dir);
  expect(audit[1].detail).toContain(store.record.candidateRevision!);
  const calls = vi.mocked(tester.test).mock.calls.length;
  await service.status(admin); await service.status(admin);
  expect(tester.test).toHaveBeenCalledTimes(calls);
});
it.each(['refused', 'rate-limited', 'unavailable', 'unexpected'] as const)('failed candidate %s leaves active key untouched and cannot become pending apply', async outcome => {
  active(); vi.mocked(tester.test).mockResolvedValue({ outcome });
  const result = await runAction('credential.test_save', { ...testInput(1), token: 'new-value' }, admin);
  expect(result).toMatchObject({ state: 'test-failed', test: { outcome } });
  expect(store.record.test?.revision).toBe(store.record.candidateRevision);
  expect(store.record.test?.identity).toBeUndefined();
  expect(readFileSync(files.activePath, 'utf8')).toBe(secret);
});
it('test/save rejects non-admin, malformed/stale inputs, missing proxy and unsupported inventory before staging or requests', async () => {
  active();
  const input = { ...testInput(1), token: 'new-value' };
  await expect(runAction('credential.test_save', input, { ...admin, actor: 'member@example.invalid' })).rejects.toThrow('administrator required');
  for (const value of ['', 'a b', 'a'.repeat(8193), 'é'.repeat(5000), 'line\nsecret'])
    await expect(runAction('credential.test_save', { ...input, token: value }, admin)).rejects.toThrow('invalid input');
  await expect(runAction('credential.test_save', { ...input, path: files.activePath }, admin)).rejects.toThrow('invalid input');
  await expect(runAction('credential.test_save', { ...input, expectedRevision: 0 }, admin)).rejects.toThrow('revision changed');
  vi.mocked(tester.ready).mockReturnValue(false);
  await expect(runAction('credential.test_save', input, admin)).rejects.toThrow('egress proxy');
  vi.mocked(tester.ready).mockReturnValue(true);
  inventory.mockResolvedValue([{ name: 'retained-sync', category: 'unmanaged-service', incarnation: null }] as never);
  await expect(runAction('credential.test_save', input, admin)).rejects.toThrow('unsupported credential consumers');
  expect(tester.test).not.toHaveBeenCalled(); expect(store.writes).toBe(0);
  expect(readdirSync(dir)).toEqual(['notion-token']);
});
it('initial audit failure prevents all work; final audit failure keeps untested recoverable intent', async () => {
  active(); const input = { ...testInput(1), token: 'new-value' };
  await expect(runAction('credential.test_save', input, { ...admin, audit: async () => { throw new Error(secret); } })).rejects.toThrow('action not run');
  expect(tester.test).not.toHaveBeenCalled(); expect(store.writes).toBe(0);
  let audits = 0;
  await expect(runAction('credential.test_save', input, { ...admin, audit: async () => { if (++audits === 2) throw new Error(secret); } })).rejects.toThrow('outcome uncertain');
  expect(await service.status(admin)).toMatchObject({ state: 'recovery-required', phase: 'testing', test: null });
  expect(readFileSync(files.activePath, 'utf8')).toBe(secret);
  await expect(runAction('credential.test_pending', testInput(store.record.version), admin)).rejects.toThrow('recovery required');
  expect(await service.recover(store.record.version, host)).toMatchObject({ state: 'applied', test: null, candidateRevision: null });
  expect(tester.test).toHaveBeenCalledTimes(1);
});
it.each([1, 2, 3])('journal failure at test/save write %s leaves no reusable test and preserves old bytes', async failAt => {
  active(); store.failAt = failAt;
  await expect(runAction('credential.test_save', { ...testInput(1), token: 'new-value' }, admin)).rejects.toThrow('outcome uncertain');
  expect(store.record.test).toBeNull(); expect(store.record.phase).not.toBe('pending-apply');
  expect(readFileSync(files.activePath, 'utf8')).toBe(secret);
  expect(tester.test).toHaveBeenCalledTimes(failAt === 3 ? 1 : 0);
});
it('retesting clears evidence durably before a request, holds the slot lock and invalidates stale/discarded revisions', async () => {
  await runAction('credential.test_save', { ...testInput(0), token: secret }, admin);
  const old = structuredClone(store.record);
  let finish!: (result: { outcome: 'unavailable' }) => void;
  vi.mocked(tester.test).mockImplementation(async (_credential, read) => {
    expect(read()).toBe(secret);
    expect(store.record).toMatchObject({ phase: 'testing', test: null });
    return new Promise(resolve => { finish = resolve; });
  });
  const retest = runAction('credential.test_pending', testInput(old.version), admin);
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(await service.status(admin)).toMatchObject({ state: 'recovery-required', test: null });
  await expect(runAction('credential.discard', testInput(old.version), admin)).rejects.toThrow();
  finish({ outcome: 'unavailable' });
  expect(await retest).toMatchObject({ state: 'test-failed', test: { outcome: 'unavailable' } });
  await expect(runAction('credential.test_pending', testInput(old.version), admin)).rejects.toThrow('revision changed');
  await service.discard(store.record.version, admin);
  await expect(runAction('credential.test_pending', testInput(store.record.version), admin)).rejects.toThrow('No pending');
});
it('current-key tests keep activation facts independent from provider results and bind evidence to active revision', async () => {
  await expect(runAction('credential.test_current', testInput(0), admin)).rejects.toThrow('active key');
  active();
  expect(await runAction('credential.test_current', testInput(1), admin)).toMatchObject({ state: 'applied', candidateRevision: null, test: { revision: store.record.activeRevision, outcome: 'passed' } });
  vi.mocked(tester.test).mockResolvedValue({ outcome: 'refused' });
  expect(await runAction('credential.test_current', testInput(store.record.version), admin)).toMatchObject({ state: 'applied', test: { outcome: 'refused' } });
  expect(readFileSync(files.activePath, 'utf8')).toBe(secret);
  await service.stage('replacement', store.record.version, admin);
  await expect(runAction('credential.test_current', testInput(store.record.version), admin)).rejects.toThrow('discard the pending change');
});
it('failed audit while testing current clears old evidence and host cleanup neither deletes active nor retries provider', async () => {
  active(); await runAction('credential.test_current', testInput(1), admin);
  let audits = 0;
  await expect(runAction('credential.test_current', testInput(store.record.version), { ...admin, audit: async () => { if (++audits === 2) throw new Error(secret); } })).rejects.toThrow('outcome uncertain');
  expect(await service.status(admin)).toMatchObject({ state: 'recovery-required', test: null });
  expect(await service.recover(store.record.version, host)).toMatchObject({ state: 'applied', candidateRevision: null, test: null });
  expect(readFileSync(files.activePath, 'utf8')).toBe(secret); expect(tester.test).toHaveBeenCalledTimes(2);
});
it.each(['file', 'inventory'] as const)('%s changes during test leave recovery required instead of testing different custody', async change => {
  active();
  vi.mocked(tester.test).mockImplementation(async () => {
    if (change === 'file') writeFileSync(join(dir, `.notion-${store.record.candidateRevision}.candidate`), 'changed-by-host', { mode: 0o600 });
    else inventory.mockResolvedValue([{ name: 'new-consumer', category: 'owned-agent', incarnation: randomUUID() }] as never);
    return { outcome: 'passed', identity: { kind: 'internal-bot', botId: randomUUID() } };
  });
  await expect(runAction('credential.test_save', { ...testInput(1), token: 'new-value' }, admin)).rejects.toThrow('outcome uncertain');
  expect(await service.status(admin)).toMatchObject({ state: 'recovery-required', test: null });
  expect(readFileSync(files.activePath, 'utf8')).toBe(secret);
});
afterEach(() => { resetActions(); rmSync(dir, { recursive: true, force: true }); });

it('status is a strict secret-free DTO without writes or provider activity', async () => {
  expect(await service.status(admin)).toMatchObject({ state: 'not-configured', revision: 0 });
  expect(store.writes).toBe(0);
  const candidate = await service.stage(secret, 0, admin);
  expect(candidate.state).toBe('pending-test');
  expect(await service.status(admin)).toEqual(candidate);
  expect(JSON.stringify(candidate)).not.toContain(secret);
  expect(JSON.stringify(candidate)).not.toContain(dir);
  expect(credentialStatusSchema.safeParse({ ...candidate, suffix: secret }).success).toBe(false);
  expect(credentialRecordSchema.safeParse({ ...store.record, secret }).success).toBe(false);
});
it('keeper refuses non-admin reads and writes before reading custody', async () => {
  const spy = vi.spyOn(store, 'read');
  for (const actor of ['member@example.invalid', 'host']) {
    await expect(service.status({ ...admin, actor })).rejects.toThrow('administrator required');
    await expect(service.discard(0, { ...admin, actor })).rejects.toThrow('administrator required');
    await expect(service.stage(secret, 0, { ...admin, actor })).rejects.toThrow('administrator required');
  }
  expect(spy).not.toHaveBeenCalled(); expect(store.writes).toBe(0);
});
it('missing admin fails closed, while trusted host receives fixed preparation guidance', async () => {
  service = new Credentials(undefined, store, files, inventory);
  await expect(service.status(admin)).rejects.toThrow('Configure one credential administrator');
  expect(await service.status(host)).toMatchObject({ state: 'host-administration-required', guidance: 'configure-administrator' });
});
it('runAction derives host authority from transport, never an injected context or actor', async () => {
  await expect(runAction('credential.status', { slot: CREDENTIAL_SLOT }, { ...host, actor: 'host' })).rejects.toThrow('administrator required');
  expect(await runAction('credential.status', { slot: CREDENTIAL_SLOT }, { ...admin, actor: 'host' }, { host: true })).toMatchObject({ state: 'not-configured' });
  await expect(runAction('credential.recover', { slot: CREDENTIAL_SLOT, expectedRevision: 0 }, admin)).rejects.toThrow('host command');
});
it('strict action input refuses arbitrary slots, paths, URLs, secrets and inventories', async () => {
  for (const input of [{slot: 'gateway:master'}, {slot: CREDENTIAL_SLOT, path: dir}, {slot: CREDENTIAL_SLOT, token: secret}, {slot: CREDENTIAL_SLOT, consumers: []}, {slot: CREDENTIAL_SLOT, url: 'https://example.invalid'}])
    await expect(runAction('credential.status', input, admin)).rejects.toThrow('invalid input');
  expect(store.writes).toBe(0);
});
it('unprepared and unwritable roots refuse before creating a candidate', async () => {
  service = build({ ...config, prepared: false });
  expect(await service.status(admin)).toMatchObject({ guidance: 'prepare-managed-slot' });
  await expect(service.stage(secret, 0, admin)).rejects.toThrow('Prepare the managed Notion slot');
  service = build(); chmodSync(dir, 0o500);
  expect(await service.status(admin)).toMatchObject({ guidance: 'prepare-writable-storage' });
  await expect(service.stage(secret, 0, admin)).rejects.toThrow('writable keeper-only');
  expect(store.writes).toBe(0);
});
it('does not adopt an external existing active key even when root declares prepared', async () => {
  writeFileSync(files.activePath, secret, { mode: 0o600 });
  expect(await service.status(admin)).toMatchObject({ guidance: 'prepare-managed-slot', activeRevision: null });
  await expect(service.stage('replacement', 0, admin)).rejects.toThrow('not adopted');
  expect(readFileSync(files.activePath, 'utf8')).toBe(secret);
});
it('reports unreadable DB/inventory as unavailable instead of empty', async () => {
  vi.spyOn(store, 'read').mockRejectedValue(new Error(secret));
  const status = await service.status(admin);
  expect(status).toMatchObject({ state: 'unavailable', revision: null });
  expect(JSON.stringify(status)).not.toContain(secret);
  vi.restoreAllMocks();
  inventory.mockRejectedValue(new Error(secret));
  expect(await service.status(admin)).toMatchObject({ state: 'unavailable' });
  await expect(service.stage(secret, 0, admin)).rejects.toThrow('status unavailable');
  expect(store.writes).toBe(0);
});
it('unsupported and incomplete consumer inventory blocks stage before journal/file work', async () => {
  inventory.mockResolvedValue([{ name: 'retained-sync', category: 'unmanaged-service', incarnation: null }] as never);
  expect(await service.status(admin)).toMatchObject({ guidance: 'review-consumers', consumers: [{ name: 'retained-sync' }] });
  await expect(service.stage(secret, 0, admin)).rejects.toThrow('unsupported credential consumers');
  inventory.mockResolvedValue([]); service = build({ ...config, inventoryComplete: false });
  await expect(service.stage(secret, 0, admin)).rejects.toThrow('unsupported credential consumers');
  expect(store.writes).toBe(0); expect(readdirSync(dir)).toEqual([]);
});
it('rejects stale revisions, concurrent writes and a second pending candidate', async () => {
  const both = await Promise.allSettled([service.stage(secret, 0, admin), service.stage('other', 0, admin)]);
  expect(both.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(readdirSync(dir)).toHaveLength(1);
  await expect(service.discard(0, admin)).rejects.toThrow('revision changed');
  await expect(service.stage('other', 2, admin)).rejects.toThrow('existing credential change');
});
it('rejects invalid token inputs without assuming a vendor prefix', async () => {
  for (const value of ['', 'a b', 'line\nsecret', 'a'.repeat(8193), 'é'.repeat(5000)])
    await expect(service.stage(value, 0, admin)).rejects.toThrow('Invalid credential input');
  expect(store.writes).toBe(0);
  expect(await service.stage('opaque_valid_token', 0, admin)).toMatchObject({ state: 'pending-test' });
});
it('DB intent failure leaves no candidate and preserves old active bytes', async () => {
  const activeRevision = randomUUID();
  store.record = { ...store.record, version: 1, activeRevision, phase: 'applied' };
  writeFileSync(files.activePath, secret, { mode: 0o600 }); store.failAt = 1;
  await expect(service.stage('replacement', 1, admin)).rejects.toThrow('outcome uncertain');
  expect(readdirSync(dir)).toEqual(['notion-token']);
  expect(readFileSync(files.activePath, 'utf8')).toBe(secret);
});
it('journal retains intent if file staging fails; explicit host recovery resolves it', async () => {
  const stage = vi.spyOn(files, 'stage').mockImplementation(() => { throw new Error(secret); });
  await expect(service.stage(secret, 0, admin)).rejects.toThrow('outcome uncertain');
  expect(store.record.phase).toBe('staging');
  expect(await service.status(admin)).toMatchObject({ state: 'recovery-required' });
  await expect(service.stage(secret, 1, admin)).rejects.toThrow('recovery required');
  stage.mockRestore();
  expect(await service.recover(1, host)).toMatchObject({ state: 'not-configured', candidateRevision: null });
});
it('crash after candidate rename leaves recoverable staging intent, never a tested key', async () => {
  store.failAt = 2;
  await expect(service.stage(secret, 0, admin)).rejects.toThrow('outcome uncertain');
  expect(store.record.phase).toBe('staging');
  expect(files.readCandidate(store.record.candidateRevision!)).toBe(secret);
  expect(await service.status(admin)).toMatchObject({ state: 'recovery-required', test: null });
  expect(await service.recover(1, host)).toMatchObject({ state: 'not-configured' });
  expect(readdirSync(dir)).toEqual([]);
});
it('discard journals intent before deletion; final DB failure is recovery required', async () => {
  await service.stage(secret, 0, admin); store.failAt = 4;
  await expect(service.discard(2, admin)).rejects.toThrow('outcome uncertain');
  expect(store.record.phase).toBe('discarding'); expect(readdirSync(dir)).toEqual([]);
  expect(await service.status(admin)).toMatchObject({ state: 'recovery-required' });
  expect(await service.recover(3, host)).toMatchObject({ state: 'not-configured' });
});
it('failed discard never changes active key, including file and initial journal failure', async () => {
  store.record = { ...store.record, version: 1, activeRevision: randomUUID(), phase: 'applied' };
  writeFileSync(files.activePath, secret, { mode: 0o600 });
  await service.stage('replacement', 1, admin);
  store.failAt = 3;
  await expect(service.discard(3, admin)).rejects.toThrow('outcome uncertain');
  expect(files.readCandidate(store.record.candidateRevision!)).toBe('replacement');
  store.failAt = 0;
  vi.spyOn(files, 'removeCandidate').mockImplementation(() => { throw new Error(secret); });
  await expect(service.discard(3, admin)).rejects.toThrow('outcome uncertain');
  expect(await service.status(admin)).toMatchObject({ state: 'recovery-required' });
  expect(readFileSync(files.activePath, 'utf8')).toBe(secret);
});
it('successful discard removes only candidate; active survives and unsupported consumers do not prevent safe cleanup', async () => {
  store.record = { ...store.record, version: 1, activeRevision: randomUUID(), phase: 'applied' };
  writeFileSync(files.activePath, secret, { mode: 0o600 });
  await service.stage('replacement', 1, admin);
  inventory.mockResolvedValue([{ name: 'retained-sync', category: 'unmanaged-service', incarnation: null }] as never);
  expect(await service.discard(3, admin)).toMatchObject({ state: 'applied', candidateRevision: null });
  expect(readdirSync(dir)).toEqual(['notion-token']); expect(readFileSync(files.activePath, 'utf8')).toBe(secret);
});
it('pre-side-effect audit failure leaves a candidate intact; final audit failure retains inspectable outcome', async () => {
  await service.stage(secret, 0, admin);
  await expect(runAction('credential.discard', { slot: CREDENTIAL_SLOT, expectedRevision: 2 }, { ...admin, audit: async () => { throw new Error(secret); } })).rejects.toThrow('action not run');
  expect(files.readCandidate(store.record.candidateRevision!)).toBe(secret);
  let calls = 0;
  await expect(runAction('credential.discard', { slot: CREDENTIAL_SLOT, expectedRevision: 2 }, { ...admin, audit: async () => { if (++calls === 2) throw new Error(secret); } })).rejects.toThrow('outcome uncertain');
  expect(await service.status(admin)).toMatchObject({ state: 'not-configured', revision: 4 });
  expect(readdirSync(dir)).toEqual([]);
});
it('all socket errors/audit records are fixed and contain no raw custody failure', async () => {
  await service.stage(secret, 0, admin);
  vi.spyOn(files, 'removeCandidate').mockImplementation(() => { throw new Error(`${dir} ${secret}`); });
  const audit: AuditRecord[] = [];
  await expect(runAction('credential.discard', { slot: CREDENTIAL_SLOT, expectedRevision: 2 }, { ...admin, audit: async r => { audit.push(r); } })).rejects.toThrow('outcome uncertain');
  expect(audit.map(r => r.outcome)).toEqual(['pending', 'failed']);
  expect(JSON.stringify(audit)).not.toContain(secret); expect(JSON.stringify(audit)).not.toContain(dir);
});
it('bounded custody rejects orphan files and unknown activation recovery instead of replaying', async () => {
  writeFileSync(join(dir, `.notion-${randomUUID()}.candidate`), secret, { mode: 0o600 });
  expect(await service.status(admin)).toMatchObject({ state: 'recovery-required' });
  await expect(service.stage(secret, 0, admin)).rejects.toThrow('recovery required');
  await expect(service.recover(0, host)).rejects.toThrow('Host inspection required');
  rmSync(join(dir, readdirSync(dir)[0]));
  const candidateRevision = randomUUID();
  store.record = { ...store.record, version: 1, phase: 'applying', candidateRevision, operation:{id:randomUUID(),kind:'apply'}, test:{revision:candidateRevision,outcome:'passed',at:new Date().toISOString()} };
  expect(await service.status(admin)).toMatchObject({ state: 'recovery-required' });
  await expect(service.recover(1, host)).rejects.toThrow('activation recovery');
});
it('partial crash files are retained until explicit host cleanup and cleanup can crash twice', async () => {
  vi.spyOn(files, 'stage').mockImplementation(revision => { writeFileSync(join(dir, `.notion-${revision}.candidate.partial`), '', { mode: 0o600 }); throw new Error('crash'); });
  await expect(service.stage(secret, 0, admin)).rejects.toThrow('outcome uncertain');
  store.failAt = 2;
  await expect(service.recover(1, host)).rejects.toThrow('outcome uncertain');
  expect(readdirSync(dir)).toEqual([]); expect(store.record.phase).toBe('staging');
  expect(await service.recover(1, host)).toMatchObject({ state: 'not-configured' });
});
it('file boundary rejects symlinks, hardlinks, directory traversal and insecure permissions', () => {
  const target = join(dir, 'outside'); writeFileSync(target, secret, { mode: 0o600 });
  symlinkSync(target, files.activePath); expect(() => files.activeExists()).toThrow(); rmSync(files.activePath);
  linkSync(target, files.activePath); expect(() => files.activeExists()).toThrow(); rmSync(files.activePath);
  const revision = randomUUID(); files.stage(revision, secret);
  const candidate = join(dir, `.notion-${revision}.candidate`);
  chmodSync(candidate, 0o644); expect(() => files.readCandidate(revision)).toThrow();
  expect(() => files.stage('../escape', secret)).toThrow();
  expect(() => files.stage(revision, secret)).toThrow();
  const linkedRoot = join(dir, 'link'); mkdirSync(join(dir, 'real'), { mode: 0o700 }); symlinkSync(join(dir, 'real'), linkedRoot);
  expect(() => new CredentialFiles(linkedRoot, { uid: process.getuid!(), gid: process.getgid!() }).verifyRoot()).toThrow();
});
it('rollback custody is exclusive and root-only without changing active bytes', () => {
  writeFileSync(files.activePath, secret, { mode: 0o600 });
  const revision = randomUUID(); files.preserveActive(revision);
  expect(readFileSync(join(dir, `.notion-${revision}.rollback`), 'utf8')).toBe(secret);
  expect(() => files.preserveActive(revision)).toThrow();
  expect(() => files.preserveActive(randomUUID())).toThrow('retention limit'); expect(readFileSync(files.activePath, 'utf8')).toBe(secret);
});
it('pending apply requires successful evidence for the exact candidate', () => {
  const candidateRevision = randomUUID();
  const r: CredentialRecord = { ...initialCredentialRecord(), candidateRevision, phase: 'pending-apply', operation:{id:randomUUID(),kind:'test'} };
  expect(credentialRecordSchema.safeParse(r).success).toBe(false);
  r.test = { revision: randomUUID(), outcome: 'passed', at: new Date().toISOString() };
  expect(credentialRecordSchema.safeParse(r).success).toBe(false);
  r.test.revision = candidateRevision;
  expect(credentialRecordSchema.safeParse(r).success).toBe(true);
});

it('rejects contradictory journal phases instead of claiming configuration or activation', async () => {
  const revision=randomUUID();
  for(const r of [
    {...initialCredentialRecord(),activeRevision:revision},
    {...initialCredentialRecord(),candidateRevision:revision},
    {...initialCredentialRecord(),phase:'staging',candidateRevision:revision,operation:{id:randomUUID(),kind:'apply'}},
    {...initialCredentialRecord(),phase:'pending-test',candidateRevision:revision,operation:{id:randomUUID(),kind:'stage'},test:{revision:randomUUID(),outcome:'passed',at:new Date().toISOString()}},
  ]) expect(credentialRecordSchema.safeParse(r).success).toBe(false);
  store.record={...initialCredentialRecord(),activeRevision:revision};
  expect(await service.status(admin)).toMatchObject({state:'unavailable',revision:null});
});
it('rejects insecure mutable ancestors and candidates with hardlinks or symlink leaves', () => {
  const parent=join(dir,'mutable'); const root=join(parent,'custody');
  mkdirSync(parent,{mode:0o777});chmodSync(parent,0o777);mkdirSync(root,{mode:0o700});
  expect(()=>new CredentialFiles(root,{uid:process.getuid!(),gid:process.getgid!()}).verifyRoot()).toThrow();
  const revision=randomUUID(),path=join(dir,`.notion-${revision}.candidate`),target=join(dir,'target');
  writeFileSync(target,secret,{mode:0o600});symlinkSync(target,path);
  expect(()=>files.readCandidate(revision)).toThrow();expect(()=>files.removeCandidate(revision)).toThrow();rmSync(path);
  linkSync(target,path);expect(()=>files.readCandidate(revision)).toThrow();expect(()=>files.removeCandidate(revision)).toThrow();
});

it('never retains two pending candidates and exposes fixed test states tied to the current candidate', async () => {
  const status=await service.stage(secret,0,admin);
  expect(()=>files.stage(randomUUID(),'other')).toThrow('retention limit');
  store.record={...store.record,phase:'test-failed',operation:{id:randomUUID(),kind:'test'},test:{revision:status.candidateRevision!,outcome:'unavailable',at:new Date().toISOString()}};
  expect(await service.status(admin)).toMatchObject({state:'test-failed',test:{outcome:'unavailable'}});
  store.record={...store.record,phase:'pending-apply',test:{...store.record.test!,outcome:'passed'}};
  expect(await service.status(admin)).toMatchObject({state:'pending-apply'});
  expect(readFileSync(join(dir,readdirSync(dir)[0]),'utf8')).toBe(secret);
});
