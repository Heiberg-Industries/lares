import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgAccountStore, AccountAccessError, type TrustedAccountAdapter } from '../../../packages/agent-kit/src/account-store.js';
import { AccountCredentialError } from '../../../packages/agent-kit/src/account-credentials.js';
import { storeToken } from '../lib/oauth-tokens.js';

const sqlDir = fileURLToPath(new URL('../sql/', import.meta.url));
const identity = { issuer: 'https://provider.example', subject: 'subject-a', label: 'Same display label' };
const key = '1'.repeat(64);
let container: StartedPostgreSqlContainer, db: Pool, store: PgAccountStore, adapter: TrustedAccountAdapter;
const trusted = () => store.forTrustedAdapter(adapter);
const writer = (principal = 'member-a', address = 'mail@example.invalid', provider = 'google', token = 'fixture-refresh') => ({
  persist: vi.fn((transaction: PoolClient) => storeToken(transaction, key, {
    principal, provider, orgId: 'fixture-org', emailAddress: address, scopes: ['fixture-scope'], refreshToken: token,
  })),
});
const ticket = (a: { id: string; generation: number }) => store.beginUpdate('member-a', a.id, a.generation);
async function connected(credential = writer()) {
  const account = await trusted().createPersonalAccount('member-a', null, credential);
  const resource = await trusted().bindResource('member-a', await ticket(account), null);
  return { account, resource, selection: { accountId: account.id, generation: account.generation, resourceBindingId: resource.id } };
}
async function credentials() { return (await db.query('SELECT * FROM connected_account_credentials ORDER BY account_id')).rows; }
async function ciphertext() { return (await db.query('SELECT id,refresh_token_enc FROM oauth_tokens ORDER BY id')).rows; }

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  db.on('error', () => undefined);
  db.on('connect', client => client.on('error', () => undefined));
  for (const name of readdirSync(sqlDir).filter(n => n.endsWith('.sql')).sort())
    await db.query(readFileSync(`${sqlDir}/${name}`, 'utf8'));
  store = new PgAccountStore(db);
}, 120_000);
afterAll(async () => { await db?.end(); await container?.stop(); });
beforeEach(async () => {
  await db.query('DELETE FROM connected_accounts');
  await db.query('DELETE FROM oauth_tokens');
  await db.query("DELETE FROM users WHERE id IN ('member-a','member-b')");
  await db.query("INSERT INTO orgs(id,display_name) VALUES ('fixture-org','Fixture') ON CONFLICT DO NOTHING");
  await db.query(`INSERT INTO users(id,display_name,org_id,status) VALUES
    ('member-a','A','fixture-org','active'),('member-b','B','fixture-org','active')`);
  adapter = { connectorId: 'google', verifyAccount: vi.fn(async () => identity),
    verifyResource: vi.fn(async () => ({ resourceKind: 'mailbox', externalId: 'own-mailbox', providerLabel: 'Inbox' })) };
});

describe('explicit account credential custody', () => {
  it('resolves secret-free resources and reads only the exact associated canonical token inside use', async () => {
    const { account, resource, selection } = await connected();
    const resolved = await store.resolvePersonalResource('member-a', selection, 'mailbox');
    expect(resolved).toEqual({ account, resource });
    expect(JSON.stringify(resolved)).not.toMatch(/oauth|token|credential|custody|secret/i);
    const work = vi.fn(async (selected, credential) => {
      expect(selected).toEqual(resolved);
      expect(credential).toEqual({ refreshTokenEnc: (await ciphertext())[0].refresh_token_enc,
        scopes: ['fixture-scope'], orgId: 'fixture-org', emailAddress: 'mail@example.invalid' });
      expect(credential.refreshTokenEnc).not.toContain('fixture-refresh');
      return { ok: true };
    });
    expect(await store.withPersonalResourceCredential('member-a', selection, 'mailbox', work)).toEqual({ ok: true });
    expect(work).toHaveBeenCalledTimes(1);
  });
  it.each(['member-b', 'missing-member'])('refuses %s before any credential use', async member => {
    const { selection } = await connected();
    const work = vi.fn();
    await expect(store.withPersonalResourceCredential(member, selection, 'mailbox', work)).rejects.toThrow(AccountAccessError);
    expect(work).not.toHaveBeenCalled();
  });
  it('requires current generation and exact resource ID, kind and account', async () => {
    const { selection } = await connected();
    for (const [ref, kind] of [[{ ...selection, generation: 1 }, 'mailbox'],
      [{ ...selection, resourceBindingId: 'missing' }, 'mailbox'],
      [{ ...selection, accountId: 'missing' }, 'mailbox'], [selection, 'calendar']] as const) {
      const work = vi.fn();
      await expect(store.withPersonalResourceCredential('member-a', ref, kind, work)).rejects.toThrow(AccountAccessError);
      expect(work).not.toHaveBeenCalled();
    }
  });
  it.each(['invited', 'removed'])('refuses a now %s member and never runs credential work', async status => {
    const { selection } = await connected();
    await db.query("UPDATE users SET status=$1 WHERE id='member-a'", [status]);
    const work = vi.fn();
    await expect(store.withPersonalResourceCredential('member-a', selection, 'mailbox', work)).rejects.toThrow(AccountAccessError);
    expect(work).not.toHaveBeenCalled();
  });
  it('refuses noncanonical aliases even when both rows appear to name the same person', async () => {
    await db.query("INSERT INTO user_aliases(system,alias,user_id) VALUES ('legacy','legacy-a','member-a')");
    const credential = writer('legacy-a');
    await expect(trusted().createPersonalAccount('member-a', null, credential)).rejects.toThrow(AccountCredentialError);
    expect(await store.list('member-a')).toEqual([]);
    expect(await ciphertext()).toEqual([]);
  });
  it.each([['member-b','google'], ['member-a','other-provider']])('rolls back %s/%s custody association', async (principal, provider) => {
    await expect(trusted().createPersonalAccount('member-a', null, writer(principal, undefined, provider))).rejects.toThrow(AccountCredentialError);
    expect(await store.list('member-a')).toEqual([]);
    expect(await credentials()).toEqual([]);
    expect(await ciphertext()).toEqual([]);
  });
  it('database foreign keys independently reject cross-member custody and account references', async () => {
    const { account } = await connected();
    const other = await writer('member-b').persist(db as unknown as PoolClient);
    await expect(db.query('UPDATE connected_account_credentials SET oauth_token_id=$1 WHERE account_id=$2', [other, account.id])).rejects.toMatchObject({ code: '23503' });
    await expect(db.query("UPDATE connected_account_credentials SET owner_member_id='member-b' WHERE account_id=$1", [account.id])).rejects.toMatchObject({ code: '23503' });
  });
  it('rolls back same-email upserts for another subject, preserving old encrypted credentials', async () => {
    const { account } = await connected();
    const before = await ciphertext(), association = await credentials();
    adapter.verifyAccount = vi.fn(async () => ({ ...identity, subject: 'subject-b' }));
    await expect(trusted().createPersonalAccount('member-a', null, writer('member-a', undefined, undefined, 'replacement-secret'))).rejects.toThrow(AccountCredentialError);
    expect(await ciphertext()).toEqual(before);
    expect(await credentials()).toEqual(association);
    expect(await store.list('member-a')).toEqual([account]);
  });
  it('rejects a replacement collision atomically, then preserves old identity and association with a fresh row', async () => {
    const { account, resource, selection } = await connected();
    const before = await ciphertext(), association = await credentials();
    adapter.verifyAccount = vi.fn(async () => ({ ...identity, subject: 'replacement' }));
    await expect(trusted().replace('member-a', await ticket(account), null, { reviewedReplacement: true }, writer())).rejects.toThrow(AccountCredentialError);
    expect(await store.read('member-a', account.id)).toEqual(account);
    expect(await ciphertext()).toEqual(before);
    expect(await credentials()).toEqual(association);
    const replacement = await trusted().replace('member-a', await ticket(account), null,
      { reviewedReplacement: true }, writer('member-a', 'new@example.invalid'));
    expect(replacement.id).not.toBe(account.id);
    expect((await credentials()).find(c => c.account_id === account.id)).toEqual(association[0]);
    expect((await ciphertext()).find(c => c.id === before[0].id)).toEqual(before[0]);
    expect((await store.read('member-a', account.id)).providerAccount).toEqual(identity);
    expect((await db.query('SELECT id FROM connected_resource_bindings WHERE connected_account_id=$1',[account.id])).rows).toEqual([{ id: resource.id }]);
    await expect(store.withPersonalResourceCredential('member-a', selection, 'mailbox', vi.fn())).rejects.toThrow(AccountAccessError);
  });
  it('rejects stale updates before token writing and preserves generation on routine rotation', async () => {
    const { account, selection } = await connected();
    const old = await ticket(account);
    const rotated = await trusted().renew('member-a', old, null, writer('member-a', undefined, undefined, 'rotated'));
    expect(rotated.generation).toBe(account.generation);
    const stale = writer();
    await expect(trusted().renew('member-a', old, null, stale)).rejects.toThrow(AccountAccessError);
    expect(stale.persist).not.toHaveBeenCalled();
    await expect(store.withPersonalResourceCredential('member-a', selection, 'mailbox', async () => true)).resolves.toBe(true);
  });
  it.each(['revoked', 'needs_reconsent', 'error'] as const)('%s stops credentials until explicit verified reconnect', async status => {
    const { account, selection } = await connected();
    const before = await credentials();
    const stopped = await store.setStatus('member-a', await ticket(account), status);
    await expect(store.withPersonalResourceCredential('member-a', { ...selection, generation: stopped.generation }, 'mailbox', vi.fn())).rejects.toThrow(AccountAccessError);
    const metadata = await trusted().renew('member-a', await ticket(stopped), null);
    await expect(store.withPersonalResourceCredential('member-a', { ...selection, generation: metadata.generation }, 'mailbox', vi.fn())).rejects.toThrow(AccountCredentialError);
    expect(await credentials()).toEqual(before);
    const reconnected = await trusted().renew('member-a', await ticket(metadata), null, writer());
    await expect(store.withPersonalResourceCredential('member-a', { ...selection, generation: reconnected.generation }, 'mailbox', async () => true)).resolves.toBe(true);
    await expect(store.withPersonalResourceCredential('member-a', selection, 'mailbox', vi.fn())).rejects.toThrow(AccountAccessError);
  });
  it('does not adopt legacy matching labels on migration reapply or resource lookup', async () => {
    const legacy = await writer().persist(db as unknown as PoolClient);
    const account = await trusted().createPersonalAccount('member-a', null);
    const resource = await trusted().bindResource('member-a', await ticket(account), null);
    const before = await ciphertext();
    for (let n=0;n<2;n++) await db.query(readFileSync(`${sqlDir}/012_connected_account_credentials.sql`, 'utf8'));
    expect(await credentials()).toEqual([]);
    expect(await ciphertext()).toEqual(before);
    await expect(store.withPersonalResourceCredential('member-a', { accountId: account.id, generation: account.generation,
      resourceBindingId: resource.id }, 'mailbox', vi.fn())).rejects.toThrow(AccountCredentialError);
    expect((await ciphertext())[0].id).toBe(legacy);
  });
  it('reapplies SQL012 without data loss and removes association when custody is explicitly deleted', async () => {
    const { selection } = await connected();
    const before = await ciphertext(), association = await credentials();
    await db.query(readFileSync(`${sqlDir}/012_connected_account_credentials.sql`, 'utf8'));
    expect(await credentials()).toEqual(association);
    expect(await ciphertext()).toEqual(before);
    await db.query('DELETE FROM oauth_tokens');
    expect(await credentials()).toEqual([]);
    const work = vi.fn();
    await expect(store.withPersonalResourceCredential('member-a', selection, 'mailbox', work)).rejects.toThrow(AccountCredentialError);
    expect(work).not.toHaveBeenCalled();
  });
  it('rechecks membership after verification, rolling back before token write', async () => {
    const { account } = await connected();
    const pending = await ticket(account), credential = writer();
    adapter.verifyAccount = vi.fn(async () => { await db.query("UPDATE users SET status='removed' WHERE id='member-a'"); return identity; });
    await expect(trusted().renew('member-a', pending, null, credential)).rejects.toThrow(AccountAccessError);
    expect(credential.persist).not.toHaveBeenCalled();
  });
});
