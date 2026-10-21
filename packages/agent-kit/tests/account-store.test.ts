import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgAccountStore, AccountAccessError, type TrustedAccountAdapter } from '../src/account-store.js';
import { connectedAccountViewSchema, resourceBindingSchema } from '../src/authority-contract.js';

const sqlDir = fileURLToPath(new URL('../../../services/box/sql/', import.meta.url));
let container: StartedPostgreSqlContainer;
let db: Pool;
let store: PgAccountStore;
const identity = { issuer: 'https://provider.example', subject: 'subject-a', tenantId: 'tenant-a', label: 'Personal account' };
const resource = { resourceKind: 'mailbox', externalId: 'mailbox-a', providerLabel: 'Inbox' };
let adapter: TrustedAccountAdapter;
const trusted = () => store.forTrustedAdapter(adapter);
const create = () => trusted().createPersonalAccount('member-a', 'provider-evidence');
const ticket = (a: { id: string; generation: number }) => store.beginUpdate('member-a', a.id, a.generation);

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
  await db.query("DELETE FROM users WHERE id IN ('member-a','member-b')");
  await db.query("INSERT INTO orgs (id, display_name) VALUES ('org-test','Example') ON CONFLICT DO NOTHING");
  await db.query(`INSERT INTO users (id,display_name,org_id,status) VALUES
    ('member-a','Member A','org-test','active'), ('member-b','Member B','org-test','active')`);
  adapter = { connectorId: 'example', verifyAccount: vi.fn(async () => identity), verifyResource: vi.fn(async () => resource) };
});

describe('personal connected accounts', () => {
  it('creates secret-free typed views and verified resource bindings for the owner only', async () => {
    const a = await create();
    const b = await trusted().bindResource('member-a', await ticket(a), 'resource-evidence');
    expect(connectedAccountViewSchema.parse(a)).toEqual(a);
    expect(resourceBindingSchema.parse(b)).toEqual(b);
    expect(a.owner).toEqual({ kind: 'member', id: 'member-a' });
    expect(a.automationMode).toBe('draft-and-ask');
    expect(await store.list('member-b')).toEqual([]);
    await expect(store.read('member-b', a.id)).rejects.toThrow(AccountAccessError);
    await expect(store.beginUpdate('member-b', a.id, a.generation)).rejects.toThrow(AccountAccessError);
    await expect(store.listResources('member-b', a.id, a.generation)).rejects.toThrow(AccountAccessError);
    const expected = await ticket(a);
    await expect(trusted().renew('member-b', expected, null)).rejects.toThrow(AccountAccessError);
    await expect(store.setStatus('member-b', expected, 'revoked')).rejects.toThrow(AccountAccessError);
    expect(JSON.stringify({ a, b })).not.toMatch(/token|credential|custody|secret|lifecycleRevision/i);
    expect(adapter.verifyAccount).toHaveBeenCalledTimes(1);
  });
  it('does not accept model-shaped identities or resources through a trusted verifier', async () => {
    adapter.verifyAccount = vi.fn(async () => { throw new Error('Unverified evidence'); });
    await expect(trusted().createPersonalAccount('member-a', identity)).rejects.toThrow('Unverified');
    expect(await store.list('member-a')).toEqual([]);
  });
  it('refuses extra credential fields returned by an adapter rather than persisting them', async () => {
    adapter.verifyAccount = vi.fn(async () => ({ ...identity, accessToken: 'fixture-secret' }));
    await expect(create()).rejects.toThrow();
    expect(await store.list('member-a')).toEqual([]);
  });
  it('preserves exact opaque resource identifiers, including meaningful whitespace', async () => {
    const a = await create();
    adapter.verifyResource = vi.fn(async () => ({ ...resource, externalId: ' opaque ' }));
    const spaced = await trusted().bindResource('member-a', await ticket(a), null);
    adapter.verifyResource = vi.fn(async () => ({ ...resource, externalId: 'opaque' }));
    const plain = await trusted().bindResource('member-a', await ticket(a), null);
    expect(spaced.externalId).toBe(' opaque ');
    expect(plain.externalId).toBe('opaque');
    expect(spaced.id).not.toBe(plain.id);
    expect((await store.listResources('member-a', a.id, a.generation)).map(b => b.externalId).sort())
      .toEqual([' opaque ', 'opaque']);
  });
  it('advances authority on explicit healthy reconnect while preserving account and resource IDs', async () => {
    const a = await create();
    const b = await trusted().bindResource('member-a', await ticket(a), null);
    adapter.verifyAccount = vi.fn(async () => ({ ...identity, label: 'Renamed display label' }));
    const renewed = await trusted().renew('member-a', await ticket(a), null);
    expect(renewed.id).toBe(a.id);
    expect(renewed.generation).toBe(a.generation+1);
    expect(await store.listResources('member-a', a.id, renewed.generation)).toEqual([b]);
    expect((await trusted().bindResource('member-a', await ticket(renewed), null)).id).toBe(b.id);
  });
  it.each(['subject', 'issuer', 'tenantId'] as const)('refuses silent identity changes through %s', async key => {
    const a = await create();
    adapter.verifyAccount = vi.fn(async () => ({ ...identity, [key]: 'different' }));
    await expect(trusted().renew('member-a', await ticket(a), null)).rejects.toThrow(AccountAccessError);
    expect((await store.read('member-a', a.id)).providerAccount).toEqual(identity);
  });
  it('requires reviewed replacement and never retargets an old resource binding', async () => {
    const a = await create();
    const b = await trusted().bindResource('member-a', await ticket(a), null);
    const old = await ticket(a);
    adapter.verifyAccount = vi.fn(async () => ({ ...identity, subject: 'subject-b' }));
    expect(() => trusted().replace('member-a', old, null, { reviewedReplacement: false } as never)).toThrow();
    const replaced = await trusted().replace('member-a', old, null, { reviewedReplacement: true });
    expect(replaced.id).not.toBe(a.id);
    expect(await store.listResources('member-a', replaced.id, replaced.generation)).toEqual([]);
    const previous = await store.read('member-a', a.id);
    expect(previous.status).toBe('revoked');
    expect(previous.generation).toBe(a.generation + 1);
    expect(previous.providerAccount).toEqual(identity);
    expect((await db.query('SELECT id FROM connected_resource_bindings WHERE connected_account_id=$1', [a.id])).rows).toEqual([{ id: b.id }]);
    await expect(store.listResources('member-a', a.id, a.generation)).rejects.toThrow(AccountAccessError);
    const next = await trusted().bindResource('member-a', await ticket(replaced), null);
    expect(next.id).not.toBe(b.id);
    await expect(trusted().renew('member-a', old, null)).rejects.toThrow(AccountAccessError);
  });
  it.each(['needs_reconsent', 'revoked', 'error'] as const)('%s invalidates old authority; reconnect preserves bindings', async status => {
    const a = await create();
    const b = await trusted().bindResource('member-a', await ticket(a), null);
    const old = await ticket(a);
    const stopped = await store.setStatus('member-a', old, status);
    expect(stopped.generation).toBe(a.generation + 1);
    await expect(store.listResources('member-a', a.id, stopped.generation)).rejects.toThrow(AccountAccessError);
    await expect(trusted().renew('member-a', old, null)).rejects.toThrow(AccountAccessError);
    const resumed = await trusted().renew('member-a', await ticket(stopped), null);
    expect(resumed.status).toBe('ok');
    expect(resumed.generation).toBe(stopped.generation + 1);
    expect(await store.listResources('member-a', resumed.id, resumed.generation)).toEqual([b]);
  });
  it('allows only one concurrent renewal and rejects a stale failure after a successful refresh', async () => {
    const a = await create();
    const old = await ticket(a);
    const outcomes = await Promise.allSettled([
      trusted().renew('member-a', old, null), trusted().renew('member-a', old, null),
    ]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    await expect(store.setStatus('member-a', old, 'error')).rejects.toThrow(AccountAccessError);
    expect((await store.read('member-a', a.id)).generation).toBe(a.generation+1);
  });
  it('snapshots status-change account and revision before waiting for a database connection', async () => {
    const a = await create();
    const original = await ticket(a);
    adapter.verifyAccount = vi.fn(async () => ({ ...identity, subject: 'other-account' }));
    const b = await create();
    const stopped = await store.setStatus('member-a', await ticket(b), 'revoked');
    const restored = await trusted().renew('member-a', await ticket(stopped), null);
    const other = await ticket(restored);
    const waitingPool = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
    const occupied = await waitingPool.connect();
    const waitingStore = new PgAccountStore(waitingPool);
    const pending = waitingStore.setStatus('member-a', original, 'revoked');
    Object.assign(original, other);
    occupied.release();
    try {
      const result = await pending;
      expect(result.id).toBe(a.id);
      expect(result.status).toBe('revoked');
      expect(await store.read('member-a', b.id)).toEqual(restored);
    } finally { await waitingPool.end(); }
  });
  it('cannot refresh a stale status-change revision by mutating its ticket during a database wait', async () => {
    const a = await create();
    const stale = await ticket(a);
    const renewed = await trusted().renew('member-a', stale, null);
    const fresh = await ticket(renewed);
    const waitingPool = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
    const occupied = await waitingPool.connect();
    const waitingStore = new PgAccountStore(waitingPool);
    const pending = waitingStore.setStatus('member-a', stale, 'revoked');
    Object.assign(stale, fresh);
    occupied.release();
    try {
      await expect(pending).rejects.toThrow(AccountAccessError);
      expect((await store.read('member-a', a.id)).status).toBe('ok');
    } finally { await waitingPool.end(); }
  });
  it('serializes competing reviewed replacements and keeps the losing transition out', async () => {
    const a = await create();
    const old = await ticket(a);
    adapter.verifyAccount = vi.fn(async () => ({ ...identity, subject: 'replacement' }));
    const outcomes = await Promise.allSettled([
      trusted().replace('member-a', old, null, { reviewedReplacement: true }),
      trusted().replace('member-a', old, null, { reviewedReplacement: true }),
    ]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(await store.list('member-a')).toHaveLength(2);
    expect((await store.read('member-a', a.id)).status).toBe('revoked');
  });
  it('never adopts legacy encrypted OAuth rows by matching display labels', async () => {
    await db.query(`INSERT INTO oauth_tokens (principal,provider,org_id,email_address,refresh_token_enc)
      VALUES ('member-a','example','org-test','matching@example.invalid','fixture-encrypted')`);
    try {
      await db.query(readFileSync(`${sqlDir}/008_connected_accounts.sql`, 'utf8'));
      expect(await store.list('member-a')).toEqual([]);
      expect((await db.query("SELECT refresh_token_enc FROM oauth_tokens WHERE principal='member-a'")).rows)
        .toEqual([{ refresh_token_enc: 'fixture-encrypted' }]);
    } finally { await db.query("DELETE FROM oauth_tokens WHERE principal='member-a'"); }
  });
  it('rejects provider results completed after revocation or replacement', async () => {
    const a = await create();
    const old = await ticket(a);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    adapter.verifyAccount = vi.fn(async () => { entered(); await blocked; return identity; });
    const pending = trusted().renew('member-a', old, null);
    await started;
    await store.setStatus('member-a', old, 'revoked');
    release();
    await expect(pending).rejects.toThrow(AccountAccessError);
    expect((await store.read('member-a', a.id)).status).toBe('revoked');
  });
  it('rejects stale resource discovery after reviewed replacement and snapshots caller tickets', async () => {
    const a = await create();
    const old = await ticket(a);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    adapter.verifyResource = vi.fn(async () => { entered(); await blocked; return resource; });
    const pending = trusted().bindResource('member-a', old, null);
    await started;
    adapter.verifyAccount = vi.fn(async () => ({ ...identity, subject: 'replacement' }));
    const replacement = await trusted().replace('member-a', old, null, { reviewedReplacement: true });
    // An asynchronous caller must not redirect old provider evidence to its new account.
    Object.assign(old, await ticket(replacement));
    release();
    await expect(pending).rejects.toThrow(AccountAccessError);
    expect(await store.listResources('member-a', replacement.id, replacement.generation)).toEqual([]);
  });
  it('rolls back a replacement collision without revoking the old account', async () => {
    const a = await create();
    adapter.verifyAccount = vi.fn(async () => ({ ...identity, subject: 'already-connected' }));
    await create();
    await expect(trusted().replace('member-a', await ticket(a), null, { reviewedReplacement: true })).rejects.toThrow();
    expect(await store.read('member-a', a.id)).toEqual(a);
  });
  it.each(['invited', 'removed'] as const)('refuses %s members before calling a verifier', async status => {
    await db.query('UPDATE users SET status=$1 WHERE id=$2', [status, 'member-a']);
    await expect(create()).rejects.toThrow(AccountAccessError);
    expect(adapter.verifyAccount).not.toHaveBeenCalled();
  });
  it('rechecks active membership after asynchronous verification and denies removed members', async () => {
    const a = await create();
    adapter.verifyAccount = vi.fn(async () => {
      await db.query("UPDATE users SET status='removed' WHERE id='member-a'");
      return identity;
    });
    await expect(trusted().renew('member-a', await ticket(a), null)).rejects.toThrow(AccountAccessError);
    await expect(store.list('member-a')).rejects.toThrow(AccountAccessError);
    await expect(store.read('member-a', a.id)).rejects.toThrow(AccountAccessError);
    await expect(create()).rejects.toThrow(AccountAccessError);
  });
  it('refuses a member moved to another organisation while waiting for the original organisation lock',async()=>{
    await db.query("INSERT INTO orgs(id,display_name) VALUES('moved-org','Other') ON CONFLICT DO NOTHING");
    const locked=await db.connect();const waitingPool=new Pool({connectionString:container.getConnectionUri(),application_name:'account-org-lock-proof',max:1});
    let pending:Promise<unknown>|undefined;
    try{
      await locked.query('BEGIN');await locked.query("SELECT id FROM orgs WHERE id='org-test' FOR UPDATE");
      pending=new PgAccountStore(waitingPool).list('member-a');
      const outcome=pending.then(()=>({ok:true,error:undefined as unknown}),error=>({ok:false,error}));
      let blocked=false;
      for(let n=0;n<100;n++){
        blocked=(await db.query("SELECT 1 FROM pg_stat_activity WHERE application_name='account-org-lock-proof' AND wait_event_type='Lock'")).rows.length>0;
        if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      await locked.query("UPDATE users SET org_id='moved-org' WHERE id='member-a'");
      await locked.query('COMMIT');
      const result=await outcome;expect(result.ok).toBe(false);expect(result.error).toBeInstanceOf(AccountAccessError);
    }finally{await locked.query('ROLLBACK');locked.release();await pending?.catch(()=>undefined);await waitingPool.end();}
  },10_000);
  it('refuses company creation and cross-member binding references at the database boundary', async () => {
    await expect(store.createCompanyAccount()).rejects.toThrow('account-manager');
    const a = await create();
    await expect(db.query(`INSERT INTO connected_resource_bindings
      (id, owner_member_id,connected_account_id,resource_kind,external_id,provider_label)
      VALUES ('bad','member-b',$1,'mailbox','external','Inbox')`, [a.id])).rejects.toThrow();
  });
  it('reapplies SQL008 without changing existing account and resource IDs', async () => {
    const a = await create();
    const b = await trusted().bindResource('member-a', await ticket(a), null);
    await db.query(readFileSync(`${sqlDir}/008_connected_accounts.sql`, 'utf8'));
    expect(await store.read('member-a', a.id)).toEqual(a);
    expect(await store.listResources('member-a', a.id, a.generation)).toEqual([b]);
  });
});
