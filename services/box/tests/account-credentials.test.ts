import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgAccountStore, AccountAccessError, type TrustedAccountAdapter } from '../../../packages/agent-kit/src/account-store.js';
import { AccountCredentialError } from '../../../packages/agent-kit/src/account-credentials.js';
import { storeToken, deleteToken, writeVerifiedAccountToken, LegacyCredentialQuarantinedError, getDecryptedRefreshToken, listDecryptedRefreshTokens } from '../lib/oauth-tokens.js';
import { PgMemberStore, currentSession } from '../../../packages/agent-kit/src/member-store.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';

const sqlDir = fileURLToPath(new URL('../sql/', import.meta.url));
const identity = { issuer: 'https://provider.example', subject: 'subject-a', label: 'Same display label' };
const key = '1'.repeat(64);
let container: StartedPostgreSqlContainer, db: Pool, store: PgAccountStore, adapter: TrustedAccountAdapter;
const trusted = () => store.forTrustedAdapter(adapter);
const writer = (principal = 'member-a', address = 'mail@example.invalid', provider = 'google', token = 'fixture-refresh') => ({
  persist: vi.fn(async (transaction: PoolClient) => {
    const result = await transaction.query(`INSERT INTO oauth_tokens(principal,provider,org_id,email_address,scopes,refresh_token_enc)
      VALUES($1,$2,'fixture-org',$3,ARRAY['fixture-scope'],$4) ON CONFLICT(principal,provider,email_address)
      DO UPDATE SET refresh_token_enc=EXCLUDED.refresh_token_enc RETURNING id`,[principal,provider,address,encryptSecret(token,key)]);
    return result.rows[0].id;
  }),
});
const verifiedWriter = (address='mail@example.invalid', token='fixture-refresh') => ({
  persist: vi.fn((transaction: PoolClient, context: Parameters<typeof writeVerifiedAccountToken>[1]) => {
    expect(Object.isFrozen(context)).toBe(true);
    return writeVerifiedAccountToken(transaction,context,key,{orgId:'fixture-org',emailAddress:address,scopes:['fixture-scope'],refreshToken:token});
  }),
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
  it('rejects stale updates and advances generation on explicit verified healthy reconnect', async () => {
    const { account, selection } = await connected();
    const old = await ticket(account);
    const rotated = await trusted().renew('member-a', old, null, writer('member-a', undefined, undefined, 'rotated'));
    expect(rotated.generation).toBe(account.generation+1);
    const stale = writer();
    await expect(trusted().renew('member-a', old, null, stale)).rejects.toThrow(AccountAccessError);
    expect(stale.persist).not.toHaveBeenCalled();
    await expect(store.withPersonalResourceCredential('member-a', {...selection,generation:rotated.generation}, 'mailbox', async () => true)).resolves.toBe(true);
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

describe('verified writer and permanent legacy quarantine', () => {
  it.each(['ok','revoked','needs_reconsent','error'] as const)('quarantines associated custody in %s state without older-token fallback', async status => {
    await storeToken(db,key,{principal:'member-a',provider:'google',orgId:'fixture-org',emailAddress:'older@example.invalid',scopes:[],refreshToken:'older'});
    const account = await trusted().createPersonalAccount('member-a',null,verifiedWriter());
    if(status!=='ok') await store.setStatus('member-a',await ticket(account),status);
    const before=await ciphertext();
    await expect(getDecryptedRefreshToken(db,key,'member-a','google')).rejects.toThrow(LegacyCredentialQuarantinedError);
    await expect(listDecryptedRefreshTokens(db,key,'member-a','google')).rejects.toThrow(LegacyCredentialQuarantinedError);
    await expect(storeToken(db,key,{principal:'member-a',provider:'google',orgId:'fixture-org',emailAddress:'mail@example.invalid',scopes:[],refreshToken:'legacy-overwrite'})).rejects.toThrow(LegacyCredentialQuarantinedError);
    await expect(deleteToken(db,'member-a','google','mail@example.invalid')).rejects.toThrow(LegacyCredentialQuarantinedError);
    expect(await ciphertext()).toEqual(before);
  });
  it('preserves exact associated token ID on same-subject provider email rename and rolls back collisions', async () => {
    const account=await trusted().createPersonalAccount('member-a',null,verifiedWriter());
    const before=await credentials();
    adapter.verifyAccount=vi.fn(async()=>({...identity,label:'renamed@example.invalid'}));
    const renewed=await trusted().renew('member-a',await ticket(account),null,verifiedWriter('renamed@example.invalid','renamed-refresh'));
    const current=before.map(row=>({...row,account_generation:renewed.generation}));
    expect(await credentials()).toEqual(current);
    const stored=(await db.query('SELECT * FROM oauth_tokens')).rows[0];
    expect(stored.id).toBe(before[0].oauth_token_id); expect(stored.email_address).toBe('renamed@example.invalid');
    expect(decryptSecret(stored.refresh_token_enc,key)).toBe('renamed-refresh');
    await storeToken(db,key,{principal:'member-a',provider:'google',orgId:'fixture-org',emailAddress:'collision@example.invalid',scopes:[],refreshToken:'legacy'});
    const snapshot=await ciphertext(), view=await store.read('member-a',account.id);
    await expect(trusted().renew('member-a',await ticket(view),null,verifiedWriter('collision@example.invalid'))).rejects.toMatchObject({code:'23505'});
    expect(await ciphertext()).toEqual(snapshot); expect(await store.read('member-a',account.id)).toEqual(view); expect(await credentials()).toEqual(current);
  });
  it('commits verified resources and custody together, refusing an unverified old primary resource atomically', async () => {
    adapter.verifyResource=vi.fn(async(_account,evidence)=>({resourceKind:String(evidence),externalId:`own-${evidence}`,providerLabel:'Own resource'}));
    const account=await trusted().createPersonalAccount('member-a',null,verifiedWriter(),['mailbox','calendar']);
    const resources=await store.listResources('member-a',account.id,account.generation), before=await ciphertext(), association=await credentials();
    expect(resources.map(resource=>resource.resourceKind).sort()).toEqual(['calendar','mailbox']);
    adapter.verifyResource=vi.fn(async(_account,evidence)=>({resourceKind:String(evidence),externalId:evidence==='calendar'?'different-calendar':`own-${evidence}`,providerLabel:'Own resource'}));
    await expect(trusted().renew('member-a',await ticket(account),null,verifiedWriter(undefined,'not-committed'),['mailbox','calendar'])).rejects.toThrow(AccountAccessError);
    expect(await store.read('member-a',account.id)).toEqual(account); expect(await ciphertext()).toEqual(before); expect(await credentials()).toEqual(association);
    expect(await store.listResources('member-a',account.id,account.generation)).toEqual(resources);
  });
  it.each(['overwrite','delete'] as const)('legacy %s waits behind association creation then refuses from a fresh check', async operation => {
    await storeToken(db,key,{principal:'member-a',provider:'google',orgId:'fixture-org',emailAddress:'mail@example.invalid',scopes:[],refreshToken:'legacy'});
    let release!:()=>void, entered!:()=>void;
    const blocked=new Promise<void>(resolve=>{release=resolve;}), started=new Promise<void>(resolve=>{entered=resolve;});
    const actual=verifiedWriter();
    const creation=trusted().createPersonalAccount('member-a',null,{persist:async(transaction,context)=>{
      const id=await actual.persist(transaction,context); entered(); await blocked; return id;
    }});
    await started;
    const pending=operation==='overwrite'
      ? storeToken(db,key,{principal:'member-a',provider:'google',orgId:'fixture-org',emailAddress:'mail@example.invalid',scopes:[],refreshToken:'overwrite'})
      : deleteToken(db,'member-a','google','mail@example.invalid');
    // Observe an actual PostgreSQL lock wait, not elapsed sleep as race evidence.
    let waiting=false;
    for(let attempt=0;attempt<100&&!waiting;attempt++){
      const result=await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'");
      waiting=result.rows.length>0;
      if(!waiting) await new Promise(resolve=>setTimeout(resolve,5));
    }
    const refused=expect(pending).rejects.toThrow(LegacyCredentialQuarantinedError);
    release(); await creation; await refused; expect(waiting).toBe(true);
    expect((await credentials())).toHaveLength(1); expect((await ciphertext())).toHaveLength(1);
  });
  it('rejects a now-stale lifecycle before invoking the verified token writer', async () => {
    const account=await trusted().createPersonalAccount('member-a',null,verifiedWriter());
    const stale=await ticket(account); await store.setStatus('member-a',stale,'revoked'); const writer=verifiedWriter();
    await expect(trusted().renew('member-a',stale,null,writer)).rejects.toThrow(AccountAccessError); expect(writer.persist).not.toHaveBeenCalled();
  });
  it.each(['new', 'reconnect'] as const)('rolls back %s account, token and resource writes when the session ends during provider work', async intent => {
    const members = new PgMemberStore(db);
    const proof = { identity: { issuer: 'https://identity.example.invalid', subject: 'member-a' }, verifiedAt: new Date() };
    await members.linkIdentity('member-a', 'member-a', proof);
    for (const endSession of ['revoke', 'expire'] as const) {
      const session = await members.createSession(proof, new Date(Date.now() + 60_000));
      const account = intent === 'reconnect' ? await trusted().createPersonalAccount('member-a', null, verifiedWriter(), ['mailbox']) : undefined;
      const update = account && await ticket(account);
      const snapshot = async () => ({
        accounts: (await db.query('SELECT * FROM connected_accounts ORDER BY id')).rows,
        tokens: (await db.query('SELECT * FROM oauth_tokens ORDER BY id')).rows,
        credentials: await credentials(),
        resources: (await db.query('SELECT * FROM connected_resource_bindings ORDER BY id')).rows,
      });
      const before = await snapshot();
      adapter.verifyAccount = vi.fn(async () => {
        if (endSession === 'revoke') await members.revokeSession(session.token);
        else await db.query("UPDATE member_sessions SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1", [session.sessionId]);
        return identity;
      });
      const actual = verifiedWriter(undefined, 'must-not-be-saved');
      const credential = { persist: async (transaction: PoolClient, context: Parameters<typeof writeVerifiedAccountToken>[1]) => {
        if (!await currentSession(transaction, session.token, 'member-a', { lock: 'share' })) throw new AccountAccessError();
        return actual.persist(transaction, context);
      } };
      await expect(update
        ? trusted().renew('member-a', update, null, credential, ['mailbox'])
        : trusted().createPersonalAccount('member-a', null, credential, ['mailbox'])).rejects.toThrow(AccountAccessError);
      expect(actual.persist).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
      // Reset the verifier for the next setup, retaining the same provider identity.
      adapter.verifyAccount = vi.fn(async () => identity);
      if (account) await db.query('DELETE FROM connected_accounts WHERE id=$1', [account.id]);
      await db.query('DELETE FROM oauth_tokens');
    }
  });
  it('holds the exact session until the account transaction commits, then permits logout', async () => {
    const members = new PgMemberStore(db);
    const proof = { identity: { issuer: 'https://identity.example.invalid', subject: 'member-a' }, verifiedAt: new Date() };
    await members.linkIdentity('member-a', 'member-a', proof);
    const session = await members.createSession(proof, new Date(Date.now() + 60_000));
    expect(await currentSession(db, session.token, 'member-b')).toBeUndefined();
    expect(await currentSession(db, session.token + 'x', 'member-a')).toBeUndefined();
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const actual = verifiedWriter();
    const creation = trusted().createPersonalAccount('member-a', null, { persist: async (transaction, context) => {
      expect(await currentSession(transaction, session.token, 'member-a', { lock: 'share' })).toMatchObject({ id: 'member-a' });
      const id = await actual.persist(transaction, context); entered(); await blocked; return id;
    } }, ['mailbox']);
    await started;
    const logout = members.revokeSession(session.token);
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const result = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'UPDATE member_sessions%'");
        waiting = result.rows.length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
      }
    } finally { release(); }
    const account = await creation; await logout;
    expect(waiting).toBe(true); expect(await members.sessionMember(session.token)).toBeUndefined();
    expect(await store.read('member-a', account.id)).toEqual(account);
    expect(await credentials()).toHaveLength(1); expect(await ciphertext()).toHaveLength(1);
    expect(await store.listResources('member-a', account.id, account.generation)).toHaveLength(1);
  });

});
