import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CredentialActivation, type CredentialRuntime } from '../lib/credential-activation.js';
import { CredentialFiles } from '../lib/credential-files.js';
import { Credentials, registerCredentialActions } from '../lib/credentials.js';
import { credentialRecordSchema, initialCredentialRecord, inventoryGrants, type CredentialRecord } from '../lib/credential-state.js';
import type { CredentialJournal, CredentialStore } from '../lib/credential-store.js';
import { resetActions, runAction } from '../lib/actions.js';

class Store implements CredentialStore {
  record = initialCredentialRecord(); writes = 0; crashAt = 0; dead = false;
  async read() { if (this.dead) throw new Error('lost connection'); return structuredClone(this.record); }
  async locked<T>(work: (j: CredentialJournal) => Promise<T>) {
    return work({ read: () => this.read(), save: async (old, next) => {
      if (this.dead) throw new Error('lost connection');
      this.record = credentialRecordSchema.parse({ ...next, version: old.version + 1 });
      if (++this.writes === this.crashAt) { this.dead = true; throw new Error('process death after commit'); }
      return structuredClone(this.record);
    } });
  }
}
const actor = { actor: 'admin@example.invalid', audit: async () => {} };
const host = { ...actor, host: true };
const consumers = [{ name: 'example-one', category: 'owned-agent' as const, incarnation: randomUUID() }, { name: 'example-two', category: 'owned-agent' as const, incarnation: randomUUID() }];
const inventoryRevision = 'a'.repeat(64);
let dir: string, files: CredentialFiles, store: Store, credentials: Credentials, runtime: CredentialRuntime;
let running: Map<string, string | null>, events: string[], oldRevision: string;
beforeEach(() => {
  resetActions();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'credential-activation-'))); chmodSync(dir, 0o700);
  files = new CredentialFiles(dir, { uid: process.getuid!(), gid: process.getgid!() }); store = new Store();
  oldRevision = randomUUID();
  store.record = { ...initialCredentialRecord(), version: 1, phase: 'applied', activeRevision: oldRevision, consumers };
  writeFileSync(files.activePath, 'old-synthetic', { mode: 0o600 });
  running = new Map(consumers.map(c => [c.name, oldRevision])); events = [];
  runtime = {
    locked: async work => work(), snapshot: vi.fn(async () => ({ revision: inventoryRevision, consumers })),
    quiesce: vi.fn(async name => { events.push(`stop:${name}`); running.delete(name); }),
    reconcile: vi.fn(async (name, revision) => { events.push(`recreate:${name}`); expect(store.record.effectiveRevision).toBe(revision); running.set(name, revision); }),
    verify: vi.fn(async (name, _, revision) => { if (!running.has(name) || running.get(name) !== revision) throw new Error('health or revision mismatch'); }),
  };
  credentials = new Credentials({ slot: 'notion:shared', binding: 'NOTION_TOKEN_FILE', administrator: actor.actor, prepared: true, inventoryComplete: true, retainedConsumers: [] },
    store, files, async () => consumers, { ready: () => true, test: async () => ({ outcome: 'passed' }) }, new CredentialActivation(files, runtime));
  registerCredentialActions(credentials);
});
afterEach(() => { resetActions(); rmSync(dir, { recursive: true, force: true }); });
const input = () => ({ slot: 'notion:shared', expectedRevision: store.record.version, expectedActiveRevision: store.record.activeRevision, inventoryRevision, confirmRestart: true });
const stage = () => runAction('credential.test_save', { slot: 'notion:shared', expectedRevision: store.record.version, token: 'new-synthetic' }, actor);
it('publishes a fresh inode and marks applied only after every confirmed consumer agrees', async () => {
  const inode = lstatSync(files.activePath).ino;
  await stage(); expect(events).toEqual([]); const candidate = store.record.candidateRevision;
  expect(await runAction('credential.apply', input(), actor)).toMatchObject({ state: 'applied', activeRevision: candidate, candidateRevision: null, activation: [{ state: 'complete' }, { state: 'complete' }] });
  expect(files.readActive()).toBe('new-synthetic'); expect(lstatSync(files.activePath).ino).not.toBe(inode);
  expect(events.slice(0, 2)).toEqual(consumers.map(c => `stop:${c.name}`));
  expect([...running.values()]).toEqual([candidate, candidate]); expect(files.unexpectedFiles(null, null)).toBe(false);
  expect(JSON.stringify(await credentials.status(actor))).not.toContain('testedCustody');
});
it('requires exact candidate custody, active revision, confirmed inventory and administrator before effects', async () => {
  await stage(); const request = input();
  for (const change of [{ expectedActiveRevision: randomUUID() }, { inventoryRevision: 'b'.repeat(64) }, { confirmRestart: false }, { path: dir }])
    await expect(runAction('credential.apply', { ...request, ...change }, actor)).rejects.toThrow();
  await expect(runAction('credential.apply', request, { ...actor, actor: 'member@example.invalid' })).rejects.toThrow('administrator');
  writeFileSync(join(dir, `.notion-${store.record.candidateRevision}.candidate`), 'new-synthetic', { mode: 0o600 });
  await expect(runAction('credential.apply', request, actor)).rejects.toThrow('unchanged');
  expect(events).toEqual([]); expect(files.readActive()).toBe('old-synthetic');
});
it.each(['publish', 'recreate', 'health', 'audit'] as const)('restores old bytes and observes every old runtime after %s failure', async failure => {
  await stage(); let once = true;
  if (failure === 'publish') vi.spyOn(files, 'publishCandidate').mockImplementationOnce(() => { throw new Error('file failure'); });
  if (failure === 'recreate') vi.mocked(runtime.reconcile).mockImplementation(async (name, revision) => { if (revision !== oldRevision && once) { once = false; throw new Error('start failed'); } running.set(name, revision); });
  if (failure === 'health') vi.mocked(runtime.verify).mockImplementation(async (name, _, revision) => { if (revision !== oldRevision && once) { once = false; throw new Error('not healthy'); } expect(running.get(name)).toBe(revision); });
  let audits = 0;
  const ctx = failure === 'audit' ? { ...actor, audit: async () => { if (++audits === 2) throw new Error('audit failed'); } } : actor;
  await expect(runAction('credential.apply', input(), ctx)).rejects.toThrow('outcome uncertain');
  expect(files.readActive()).toBe('old-synthetic'); expect([...running.values()]).toEqual([oldRevision, oldRevision]);
  expect(store.record.phase).toBe('applied'); expect(store.record.rollback.every(p => p.state === 'complete')).toBe(true);
});
it('retains protected custody and failed progress when rollback cannot restore a runtime', async () => {
  await stage(); vi.mocked(runtime.reconcile).mockRejectedValue(new Error('runtime refused'));
  await expect(runAction('credential.apply', input(), actor)).rejects.toThrow('outcome uncertain');
  expect(await credentials.status(actor)).toMatchObject({ state: 'recovery-required', rollback: [{ state: 'failed' }, { state: 'pending' }] });
  expect(files.rollbackExists(oldRevision)).toBe(true); expect(files.readActive()).toBe('old-synthetic');
  await expect(runAction('credential.apply', input(), actor)).rejects.toThrow('recovery required');
  vi.mocked(runtime.reconcile).mockImplementation(async (name, revision) => { running.set(name, revision); });
  expect(await credentials.recover(store.record.version, host)).toMatchObject({ state: 'applied' });
});
it.each([1, 2, 3, 4, 5, 6])('explicit host recovery resolves process death at durable boundary %i without provider replay', async boundary => {
  await stage(); store.writes = 0; store.crashAt = boundary;
  await expect(runAction('credential.apply', input(), actor)).rejects.toThrow('outcome uncertain');
  store.dead = false; store.crashAt = 0;
  expect(await credentials.status(actor)).toMatchObject({ state: 'recovery-required' });
  const finishing = store.record.activationIntent?.finishing;
  expect(await credentials.recover(store.record.version, host)).toMatchObject({ state: 'applied' });
  expect(files.readActive()).toBe(finishing ? 'new-synthetic' : 'old-synthetic');
  expect(files.unexpectedFiles(null, null)).toBe(false);
});
it('a lost response after final commit is inspected as applied rather than replayed', async () => {
  await stage(); store.writes = 0; store.crashAt = 7;
  await expect(runAction('credential.apply', input(), actor)).rejects.toThrow('outcome uncertain');
  store.dead = false;
  expect(await credentials.status(actor)).toMatchObject({ state: 'applied' });
  expect(files.readActive()).toBe('new-synthetic');
  await expect(credentials.recover(store.record.version, host)).rejects.toThrow('Host inspection');
});
it('disconnect recreates all consumers without Notion before deleting values and keeps unrelated custody', async () => {
  await stage(); writeFileSync(join(dir, 'unrelated-key'), 'unrelated', { mode: 0o600 });
  const remove = vi.spyOn(files, 'removeActive');
  remove.mockImplementation(() => { expect([...running.values()]).toEqual([null, null]); rmSync(files.activePath); });
  expect(await runAction('credential.disconnect', input(), actor)).toMatchObject({ state: 'disconnected', test: null, candidateRevision: null, activeRevision: null });
  expect(files.activeExists()).toBe(false); expect(readFileSync(join(dir, 'unrelated-key'), 'utf8')).toBe('unrelated');
  expect(store.record.effectiveRevision).toBeNull();
});
it('disconnect failure restores the old effective binding and bytes', async () => {
  vi.mocked(runtime.reconcile).mockImplementation(async (name, revision) => { if (revision === null) throw new Error('failed'); running.set(name, revision); });
  await expect(runAction('credential.disconnect', input(), actor)).rejects.toThrow('outcome uncertain');
  expect(files.readActive()).toBe('old-synthetic'); expect(store.record.effectiveRevision).toBe(oldRevision);
  expect([...running.values()]).toEqual([oldRevision, oldRevision]);
});
it('refuses changed grants/inventory during recovery without claiming restored consumers', async () => {
  await stage(); store.crashAt = store.writes + 3;
  await expect(runAction('credential.apply', input(), actor)).rejects.toThrow(); store.dead = false;
  vi.mocked(runtime.snapshot).mockResolvedValue({ revision: 'b'.repeat(64), consumers });
  await expect(credentials.recover(store.record.version, host)).rejects.toThrow('outcome uncertain');
  expect(store.record.activationIntent).toBeTruthy();
});
it('rechecks complete inventory after finishing intent before recovery can delete custody', async () => {
  await stage(); store.writes = 0; store.crashAt = 6;
  await expect(runAction('credential.apply', input(), actor)).rejects.toThrow(); store.dead = false; store.crashAt = 0;
  expect(store.record.activationIntent?.finishing).toBe(true);
  vi.mocked(runtime.snapshot).mockResolvedValue({ revision: 'b'.repeat(64), consumers });
  await expect(credentials.recover(store.record.version, host)).rejects.toThrow('outcome uncertain');
  expect(files.rollbackExists(oldRevision)).toBe(true); expect(store.record.activationIntent).toBeTruthy();
});

// ---- owner switch: grant / revoke of the managed key for one purpose ----
const grantInput = (over: object = {}) => ({ ...input(), agent: 'example-one', purpose: 'clipping', ...over });
const granted = [{ agent: 'example-one', purposes: ['clipping' as const] }];
/** Fake that models the mount: the effective grants decide what example-one holds. */
function modelMounts(installation = false) {
  const bound = (name: string, revision: string | null) => revision;
  runtime.installationBound = () => installation;
  vi.mocked(runtime.reconcile).mockImplementation(async (name, revision) => { events.push(`recreate:${name}`); running.set(name, bound(name, revision)); });
}
it('grant restarts only the named agent, journals first, audits before finishing, and persists the grant', async () => {
  modelMounts(); running.set('example-one', null);
  const seen: string[] = [];
  const ctx = { ...actor, audit: async () => { seen.push(`${store.record.phase}:${store.record.activationIntent?.finishing}:${JSON.stringify(store.record.grants ?? [])}:${JSON.stringify(store.record.effectiveGrants)}`); } };
  const before = store.record.activeRevision;
  expect(await runAction('credential.grant', grantInput(), ctx)).toMatchObject({ state: 'applied', activeRevision: before, grants: granted });
  expect(events).toEqual(['stop:example-one', 'recreate:example-one']);
  expect(running.get('example-one')).toBe(before); expect(running.get('example-two')).toBe(before);
  // Second audit call is the finalize one: grants still the old ones, new ones only effective.
  expect(seen[1]).toBe(`applying:false:[]:${JSON.stringify(granted)}`);
  expect(store.record).toMatchObject({ grants: granted, phase: 'applied', activationIntent: null, rollbackRevision: null });
  expect(store.record.effectiveGrants).toBeUndefined();
  expect(files.readActive()).toBe('old-synthetic'); expect(files.unexpectedFiles(null, null)).toBe(false);
  expect((await credentials.status(actor)).grants).toEqual(granted);
});
it('revoke unmounts the agent and clears the grant', async () => {
  modelMounts(); store.record = { ...store.record, grants: granted };
  expect(await runAction('credential.revoke', grantInput(), actor)).toMatchObject({ state: 'applied', grants: [] });
  expect(running.get('example-one')).toBeNull(); expect(running.get('example-two')).toBe(oldRevision);
  expect(events).toEqual(['stop:example-one', 'recreate:example-one']); expect(store.record.grants).toEqual([]);
});
it('revoke keeps the mount of an agent the installation binds itself', async () => {
  modelMounts(true); store.record = { ...store.record, grants: granted };
  await runAction('credential.revoke', grantInput(), actor);
  expect(running.get('example-one')).toBe(oldRevision); expect(store.record.grants).toEqual([]);
});
it('refuses grant and revoke before any effect when preconditions fail', async () => {
  modelMounts();
  await expect(runAction('credential.revoke', grantInput(), actor)).rejects.toThrow('does not have');
  await expect(runAction('credential.grant', grantInput({ inventoryRevision: 'b'.repeat(64) }), actor)).rejects.toThrow('consumers changed');
  await expect(runAction('credential.grant', grantInput({ purpose: 'email' }), actor)).rejects.toThrow();
  await expect(runAction('credential.grant', grantInput(), { ...actor, actor: 'member@example.invalid' })).rejects.toThrow('administrator');
  await expect(runAction('credential.grant', grantInput({ confirmRestart: false }), actor)).rejects.toThrow();
  // An agent the inventory does not list as a ready chief of staff.
  await expect(runAction('credential.grant', grantInput({ agent: 'someone-else' }), actor)).rejects.toThrow('chief-of-staff');
  store.record = { ...store.record, grants: granted };
  await expect(runAction('credential.grant', grantInput(), actor)).rejects.toThrow('already');
  expect(events).toEqual([]); expect(store.record.grants).toEqual(granted);
  // No applied key: a staged replacement blocks it, and so does no key at all.
  store.record = { ...store.record, grants: undefined };
  await stage();
  await expect(runAction('credential.grant', grantInput(), actor)).rejects.toThrow('Apply a tested key');
  expect(events).toEqual([]);
});
it('a failure mid-reconcile rolls back, leaving no grant and the previous mount', async () => {
  modelMounts(); running.set('example-one', null); let once = true;
  vi.mocked(runtime.reconcile).mockImplementation(async (name, revision) => { if (revision && once) { once = false; throw new Error('start failed'); } running.set(name, revision); });
  await expect(runAction('credential.grant', grantInput(), actor)).rejects.toThrow('outcome uncertain');
  expect(store.record.grants ?? []).toEqual([]); expect(store.record.phase).toBe('applied'); expect(store.record.activationIntent).toBeNull();
  expect(running.get('example-one')).toBeNull(); expect(running.get('example-two')).toBe(oldRevision);
  expect(files.readActive()).toBe('old-synthetic'); expect(files.unexpectedFiles(null, null)).toBe(false);
});
it('a failed revoke restores the grant and the mount', async () => {
  modelMounts(); store.record = { ...store.record, grants: granted }; let once = true;
  vi.mocked(runtime.reconcile).mockImplementation(async (name, revision) => { if (revision === null && once) { once = false; throw new Error('start failed'); } running.set(name, revision); });
  await expect(runAction('credential.revoke', grantInput(), actor)).rejects.toThrow('outcome uncertain');
  expect(store.record.grants).toEqual(granted); expect(running.get('example-one')).toBe(oldRevision); expect(store.record.phase).toBe('applied');
});
it.each([1, 2, 3, 4, 5])('host recovery resolves a crash at grant journal boundary %i', async boundary => {
  modelMounts(); running.set('example-one', null); store.writes = 0; store.crashAt = boundary;
  await expect(runAction('credential.grant', grantInput(), actor)).rejects.toThrow('outcome uncertain');
  store.dead = false; store.crashAt = 0;
  const finishing = store.record.activationIntent?.finishing;
  expect(await credentials.recover(store.record.version, host)).toMatchObject({ state: 'applied' });
  expect(store.record.grants ?? []).toEqual(finishing ? granted : []);
  expect(running.get('example-one')).toBe(finishing ? oldRevision : null);
  expect(store.record.effectiveGrants).toBeUndefined(); expect(files.readActive()).toBe('old-synthetic'); expect(files.unexpectedFiles(null, null)).toBe(false);
});
it.each([1, 2, 3, 4, 5])('host recovery resolves a crash at revoke journal boundary %i', async boundary => {
  modelMounts(); store.record = { ...store.record, grants: granted }; store.writes = 0; store.crashAt = boundary;
  await expect(runAction('credential.revoke', grantInput(), actor)).rejects.toThrow('outcome uncertain');
  store.dead = false; store.crashAt = 0;
  const finishing = store.record.activationIntent?.finishing;
  expect(await credentials.recover(store.record.version, host)).toMatchObject({ state: 'applied' });
  expect(store.record.grants).toEqual(finishing ? [] : granted);
  expect(running.get('example-one')).toBe(finishing ? null : oldRevision);
});
it('a record written before grants existed still parses and reports no grants', async () => {
  const old: any = structuredClone(store.record); delete old.grants; delete old.effectiveGrants;
  expect(credentialRecordSchema.parse(old).grants).toBeUndefined();
  expect((await credentials.status(actor)).grants).toEqual([]);
});
it('rejects grant intents that contradict custody', () => {
  const base = { ...store.record, phase: 'applying', rollbackRevision: oldRevision, operation: { id: randomUUID(), kind: 'grant' },
    activationIntent: { previousRevision: oldRevision, targetRevision: oldRevision, inventoryRevision, prepared: true, finishing: false,
      grantChange: { agent: 'example-one', purpose: 'clipping', to: true }, grantsBefore: [], grantsAfter: granted } };
  expect(credentialRecordSchema.safeParse(base).success).toBe(true);
  expect(credentialRecordSchema.safeParse({ ...base, effectiveGrants: [{ agent: 'example-two', purposes: ['clipping'] }] }).success).toBe(false);
  expect(credentialRecordSchema.safeParse({ ...base, activationIntent: { ...base.activationIntent, targetRevision: randomUUID() } }).success).toBe(false);
  expect(credentialRecordSchema.safeParse({ ...base, operation: { id: randomUUID(), kind: 'revoke' } }).success).toBe(false);
});
it('a lost response after the final grant commit is inspected as applied with the grant', async () => {
  modelMounts(); running.set('example-one', null); store.writes = 0; store.crashAt = 6;
  await expect(runAction('credential.grant', grantInput(), actor)).rejects.toThrow('outcome uncertain');
  store.dead = false;
  expect(await credentials.status(actor)).toMatchObject({ state: 'applied', grants: granted });
});

// ---- preview of a grant, and a deleted agent's stale grant ----
const previewInput = (over: object = {}) => ({ slot: 'notion:shared', agent: 'example-one', purpose: 'clipping', ...over });
const afterGrant = 'c'.repeat(64);
it('preview returns the post-grant inventory revision, writes nothing, and a grant confirming it succeeds', async () => {
  modelMounts(); running.set('example-one', null);
  vi.mocked(runtime.snapshot).mockImplementation(async r => ({ revision: inventoryGrants(r).length ? afterGrant : inventoryRevision, consumers }));
  const version = store.record.version, writes = store.writes;
  const preview = await runAction('credential.preview_grant', previewInput(), actor);
  expect(preview).toEqual({ agent: 'example-one', purpose: 'clipping', inventoryRevision: afterGrant, consumers });
  expect(store.record.version).toBe(version); expect(store.writes).toBe(writes); expect(events).toEqual([]);
  await expect(runAction('credential.grant', grantInput(), actor)).rejects.toThrow('consumers changed');
  expect(await runAction('credential.grant', grantInput({ inventoryRevision: (preview as { inventoryRevision: string }).inventoryRevision }), actor)).toMatchObject({ state: 'applied', grants: granted });
});
it('preview refuses without an applied key, when already granted, for a non-chief agent, and for non-administrators', async () => {
  modelMounts();
  await expect(runAction('credential.preview_grant', previewInput({ agent: 'someone-else' }), actor)).rejects.toThrow('chief-of-staff');
  await expect(runAction('credential.preview_grant', previewInput(), { ...actor, actor: 'member@example.invalid' })).rejects.toThrow('administrator');
  await expect(runAction('credential.preview_grant', previewInput({ purpose: 'email' }), actor)).rejects.toThrow();
  store.record = { ...store.record, grants: granted };
  await expect(runAction('credential.preview_grant', previewInput(), actor)).rejects.toThrow('already');
  store.record = { ...store.record, grants: undefined };
  await stage();
  await expect(runAction('credential.preview_grant', previewInput(), actor)).rejects.toThrow('Apply a tested key');
  expect(events).toEqual([]);
});
function withDeleted(gone: string[]) {
  resetActions();
  credentials = new Credentials({ slot: 'notion:shared', binding: 'NOTION_TOKEN_FILE', administrator: actor.actor, prepared: true, inventoryComplete: true, retainedConsumers: [] },
    store, files, async () => consumers, { ready: () => true, test: async () => ({ outcome: 'passed' }) }, new CredentialActivation(files, runtime),
    async names => new Set(names.filter(n => gone.includes(n))));
  registerCredentialActions(credentials);
}
const staleGrant = [{ agent: 'deleted-one', purposes: ['clipping' as const] }];
it('a grant for a deleted agent is marked stale, does not block anything, and is revoked without any runtime call', async () => {
  withDeleted(['deleted-one']); store.record = { ...store.record, grants: [...granted, ...staleGrant] };
  const status = await credentials.status(actor);
  expect(status).toMatchObject({ state: 'applied', guidance: null });
  expect(status.grants).toContainEqual({ agent: 'deleted-one', purposes: ['clipping'], stale: true });
  expect(status.grants!.find(g => g.agent === 'example-one')).not.toHaveProperty('stale');
  // Apply is not blocked by it.
  await stage();
  expect(await runAction('credential.apply', input(), actor)).toMatchObject({ state: 'applied' });
  // Revoke is journal-only.
  vi.mocked(runtime.quiesce).mockClear(); vi.mocked(runtime.reconcile).mockClear(); vi.mocked(runtime.verify).mockClear();
  const audits: unknown[] = [];
  const result = await runAction('credential.revoke', grantInput({ agent: 'deleted-one' }), { ...actor, audit: async (...a: unknown[]) => { audits.push(a); } });
  expect(result).toMatchObject({ state: 'applied', grants: granted });
  expect(runtime.quiesce).not.toHaveBeenCalled(); expect(runtime.reconcile).not.toHaveBeenCalled(); expect(runtime.verify).not.toHaveBeenCalled();
  expect(events.filter(e => e.startsWith('recreate'))).toHaveLength(2); // only the earlier apply
  expect(store.record).toMatchObject({ grants: granted, phase: 'applied', activationIntent: null });
  expect(audits.length).toBeGreaterThan(0);
});
it('a deleted agent does not block Disconnect, and revoke of a stale grant still checks revisions', async () => {
  withDeleted(['deleted-one']); store.record = { ...store.record, grants: staleGrant };
  await expect(runAction('credential.revoke', grantInput({ agent: 'deleted-one', inventoryRevision: 'b'.repeat(64) }), actor)).rejects.toThrow('consumers changed');
  await expect(runAction('credential.revoke', grantInput({ agent: 'deleted-one', expectedActiveRevision: randomUUID() }), actor)).rejects.toThrow('revision changed');
  expect(store.record.grants).toEqual(staleGrant);
  expect(await runAction('credential.disconnect', input(), actor)).toMatchObject({ state: 'disconnected' });
});
