import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPool, closePool } from '@lares/agent-kit/db';
import { PgAccountStore, type TrustedAccountAdapter } from '@lares/agent-kit/account-store';
import { bindConsoleSession } from '@lares/agent-kit/console-turn-authority';
import { currentTaint, resetTaintForTests, turnKeyFrom } from '@lares/agent-kit/origin-taint';
import gmailAccounts from '../catalogue/gmail_accounts.js';
import gmailRead from '../catalogue/gmail_read.js';
import gmailSearch from '../catalogue/gmail_search.js';
import { __setTestGmailApiFactory } from '../lib/google.js';
import { PERSONAL_MAILBOX_REFUSED } from '../lib/personal-gmail.js';
import { quiet } from './helpers/quiet-pool.js';

const incarnation = '11111111-1111-4111-8111-111111111111';
const nonce = 'a'.repeat(43);
const auth = (member = 'member-a', purpose = 'human') => ({ authenticator: 'lares-console', attributes: {
  user_id: 'legacy-address@example.invalid', lares_member_id: member, lares_admission_nonce: nonce, lares_purpose: purpose,
} });
const ctx = (current = auth(), initial = auth()) => ({ session: { id: 'wrun_mail', turn: { id: 'turn-mail', sequence: 1 },
  auth: { current, initiator: initial } } }) as never;
let container: StartedPostgreSqlContainer, dir: string, store: PgAccountStore;
const key = '1'.repeat(64);
const scope = 'https://www.googleapis.com/auth/gmail.readonly';
const calls: unknown[] = [], credentials: string[] = [];
let providerError = false, hold: (() => Promise<void>) | undefined;
function encrypt(token: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  return Buffer.concat([iv, cipher.update(token), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
async function account(member = 'member-a', subject = 'subject-a', connectorId = 'google', scopes = [scope]) {
  const adapter: TrustedAccountAdapter = { connectorId,
    verifyAccount: async () => ({ issuer: 'https://accounts.google.com', subject, label: 'Same label' }),
    verifyResource: async (_a, kind) => ({ resourceKind: String(kind), externalId: subject, providerLabel: 'Inbox' }) };
  const trusted = store.forTrustedAdapter(adapter);
  const created = await trusted.createPersonalAccount(member, null, { persist: async (db) => {
    const { rows } = await db.query(`INSERT INTO oauth_tokens(principal,provider,org_id,email_address,scopes,refresh_token_enc)
      VALUES($1,$2,'acme',$3,$4,$5) RETURNING id`, [member, connectorId, `${subject}@example.invalid`, scopes, encrypt(`refresh-${subject}`)]);
    return rows[0].id;
  } }, ['mailbox', 'calendar']);
  const resources = await store.listResources(member, created.id, created.generation);
  return { account: created, resources, selection: { accountId: created.id, generation: created.generation,
    resourceBindingId: resources.find(r => r.resourceKind === 'mailbox')!.id } };
}
beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  vi.stubEnv('DATABASE_URL', container.getConnectionUri());
  quiet(getPool());
  const sql = new URL('../../box/sql/', import.meta.url);
  for (const name of readdirSync(sql).filter(n => n.endsWith('.sql')).sort())
    await getPool().query(readFileSync(new URL(name, sql), 'utf8'));
  store = new PgAccountStore(getPool());
  dir = mkdtempSync(join(tmpdir(), 'personal-gmail-'));
  writeFileSync(join(dir, 'key'), key); writeFileSync(join(dir, 'client'), 'fixture-client');
  writeFileSync(join(dir, 'secret'), 'fixture-client-secret');
}, 120_000);
afterAll(async () => { await closePool(); await container?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  vi.stubEnv('LARES_AGENT_NAME', 'helper'); vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
  vi.stubEnv('AGENT_OWNER_USER_ID', 'member-a'); vi.stubEnv('LARES_EMAIL_ORG', 'acme');
  vi.stubEnv('LARES_GOOGLE_CLIENT_ID_FILE', join(dir, 'client')); vi.stubEnv('LARES_GOOGLE_CLIENT_SECRET_FILE', join(dir, 'secret'));
  vi.stubEnv('TOKEN_ENC_KEY_FILE', join(dir, 'key'));
  // Tempting legacy defaults must never choose the mailbox in tagged console context.
  vi.stubEnv('GMAIL_PRIMARY_EMAIL', 'another@example.invalid'); vi.stubEnv('GOOGLE_PRINCIPAL_ID', 'member-b');
  await getPool().query('DELETE FROM console_session_bindings; DELETE FROM connected_accounts; DELETE FROM oauth_tokens; DELETE FROM agent_resources; DELETE FROM agent_definitions');
  await getPool().query(`INSERT INTO orgs(id,display_name) VALUES ('fixture-org','Fixture') ON CONFLICT DO NOTHING;
    INSERT INTO users(id,display_name,org_id,org_role,status) VALUES
    ('member-a','A','fixture-org','owner','active'),('member-b','B','fixture-org','owner','active')
    ON CONFLICT(id) DO UPDATE SET status='active',org_role='owner';`);
  await getPool().query("INSERT INTO agent_definitions(name,definition,hash) VALUES('helper','{}','fixture')");
  await getPool().query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending)
    VALUES('helper','127.0.0.2','fixture','owned',$1,$1,'ready',false)`, [incarnation]);
  await bindConsoleSession({ agent: 'helper', incarnation, sessionId: 'wrun_mail', memberId: 'member-a', admissionNonce: nonce });
  calls.length = 0; credentials.length = 0; providerError = false; hold = undefined; resetTaintForTests();
  __setTestGmailApiFactory((_cfg, token) => {
    credentials.push(token);
    return { users: { messages: {
      list: async (params: unknown) => { calls.push(params); if (providerError) throw new Error('secret-provider-refresh-details');
        await hold?.(); return { data: { messages: [{ id: 'message-a' }] } }; },
      get: async (params: unknown) => { calls.push(params); if (providerError) throw new Error('secret-provider-refresh-details');
        return { data: { id: 'message-a', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Sender <sender@example.invalid>' }],
          body: { data: Buffer.from('x'.repeat(13_000)).toString('base64url') } } } }; },
    } } } as never;
  });
});
afterEach(() => { __setTestGmailApiFactory(undefined); vi.restoreAllMocks(); });

describe('private console Gmail catalogue execution', () => {
  it('lists only current actor selections without provider identities, orgs or custody', async () => {
    const own = await account(); await account('member-b', 'subject-b');
    expect(await gmailAccounts.execute({}, ctx())).toEqual([{ accountId: own.account.id, generation: 0, label: 'Same label', status: 'ok',
      mailboxes: [{ resourceBindingId: own.selection.resourceBindingId, label: 'Inbox' }] }]);
    expect(credentials).toEqual([]); expect(calls).toEqual([]);
    expect(currentTaint(turnKeyFrom(ctx())!)).toBe('third_party');
  });
  it('searches exact associated credential through users.me, disregarding defaults and provider subject', async () => {
    const own = await account(); await account('member-b', 'subject-b');
    expect(await gmailSearch.execute({ query: 'in:inbox', selection: own.selection }, ctx())).toEqual(['message-a']);
    expect(credentials).toEqual(['refresh-subject-a']);
    expect(calls).toEqual([{ userId: 'me', q: 'in:inbox', maxResults: 25 }]);
    expect(currentTaint(turnKeyFrom(ctx())!)).toBe('third_party');
  });
  it('preserves bounded quoted mail and truthful unknown sender history without another lookup', async () => {
    const own = await account();
    const result = await gmailRead.execute({ id: 'message-a', selection: own.selection }, ctx()) as {bodyText:string;nextOffset:number;truncated:boolean};
    expect(result.bodyText).toContain("<<<SOMEONE ELSE'S WORDS"); expect(result.bodyText).toContain('I could not check');
    expect(result.nextOffset).toBe(12_000); expect(result.truncated).toBe(true);
    expect(calls).toEqual([{ userId: 'me', id: 'message-a', format: 'full' }]);
  });
  it.each(['missing', 'legacy-email', 'stale-generation', 'wrong-account', 'wrong-resource', 'calendar-resource', 'other-member'])('refuses %s before SDK construction', async kind => {
    const own = await account(), other = await account('member-b', 'subject-b');
    const selection = kind === 'missing' ? undefined : kind === 'other-member' ? other.selection : kind === 'wrong-account' ? {...own.selection, accountId: 'missing'} :
      kind === 'stale-generation' ? {...own.selection, generation: 99} : kind === 'wrong-resource' ? {...own.selection, resourceBindingId: other.selection.resourceBindingId} :
      kind === 'calendar-resource' ? {...own.selection, resourceBindingId: own.resources.find(r => r.resourceKind === 'calendar')!.id} : own.selection;
    await expect(gmailSearch.execute({ query: 'in:inbox', selection, ...(kind === 'legacy-email' ? {account: 'own@example.invalid'} : {}) }, ctx())).rejects.toThrow(PERSONAL_MAILBOX_REFUSED);
    expect(credentials).toEqual([]); expect(calls).toEqual([]); expect(currentTaint(turnKeyFrom(ctx())!)).toBeUndefined();
  });
  it.each(['revoked','needs_reconsent','error'])('refuses %s account before SDK construction', async status => {
    const own = await account(); const update = await store.beginUpdate('member-a', own.account.id, 0);
    await store.setStatus('member-a', update, status as 'revoked');
    await expect(gmailRead.execute({ id: 'm', selection: own.selection }, ctx())).rejects.toThrow(PERSONAL_MAILBOX_REFUSED);
    expect(credentials).toEqual([]);
  });
  it.each(['removed','invited'])('refuses %s member before account or provider work', async status => {
    const own = await account(); await getPool().query("UPDATE users SET status=$1 WHERE id='member-a'", [status]);
    await expect(gmailSearch.execute({ query: 'x', selection: own.selection }, ctx())).rejects.toThrow(PERSONAL_MAILBOX_REFUSED);
    await expect(gmailAccounts.execute({}, ctx())).rejects.toThrow(PERSONAL_MAILBOX_REFUSED);
    expect(credentials).toEqual([]);
  });
  it.each(['resolver','other-member','changed-runtime','retired-session','native'])('refuses %s authority', async kind => {
    const own = await account();
    if (kind === 'changed-runtime') await getPool().query("UPDATE agent_resources SET pending=true WHERE name='helper'");
    if (kind === 'retired-session') await getPool().query('UPDATE console_session_bindings SET revoked_at=now()');
    const context = kind === 'resolver' ? ctx(auth('member-a','resolver')) : kind === 'other-member' ? ctx(auth('member-b')) : kind === 'native' ? {} as never : ctx();
    await expect(gmailAccounts.execute({}, context)).rejects.toThrow(PERSONAL_MAILBOX_REFUSED);
    await expect(gmailRead.execute({ id: 'm', selection: own.selection }, context)).rejects.toThrow();
    expect(credentials).toEqual([]);
  });
  it.each(['connector','scope','custody-generation','org-client','subject'])('refuses wrong %s before SDK construction', async kind => {
    const own = await account('member-a', 'subject-a', kind === 'connector' ? 'other' : 'google', kind === 'scope' ? ['openid'] : [scope]);
    if (kind === 'custody-generation') await getPool().query('UPDATE connected_account_credentials SET account_generation=1');
    if (kind === 'org-client') vi.stubEnv('LARES_EMAIL_ORG', 'different');
    if (kind === 'subject') await getPool().query("UPDATE connected_resource_bindings SET external_id='different' WHERE resource_kind='mailbox'");
    await expect(gmailSearch.execute({ query: 'x', selection: own.selection }, ctx())).rejects.toThrow(PERSONAL_MAILBOX_REFUSED);
    expect(credentials).toEqual([]);
  });
  it('sanitizes provider and database failures, with no taint or fallback', async () => {
    const own = await account(); providerError = true;
    await expect(gmailSearch.execute({ query: 'x', selection: own.selection }, ctx())).rejects.toThrow(PERSONAL_MAILBOX_REFUSED);
    expect(currentTaint(turnKeyFrom(ctx())!)).toBeUndefined();
    credentials.length = 0; vi.spyOn(getPool(), 'query').mockRejectedValueOnce(new Error('secret-database-details') as never);
    await expect(gmailRead.execute({ id: 'm', selection: own.selection }, ctx())).rejects.toThrow(PERSONAL_MAILBOX_REFUSED);
    expect(credentials).toEqual([]);
  });
  it('rechecks authority on the same transaction with a one-connection pool', async () => {
    const own = await account();
    await closePool();
    const pool = quiet(getPool());
    pool.options.max = 1;
    pool.options.connectionTimeoutMillis = 300;
    store = new PgAccountStore(pool);
    try {
      await expect(gmailSearch.execute({ query: 'x', selection: own.selection }, ctx())).resolves.toEqual(['message-a']);
      expect(credentials).toEqual(['refresh-subject-a']);
      await pool.query('UPDATE console_session_bindings SET revoked_at=now()');
      credentials.length = 0;
      await expect(gmailSearch.execute({ query: 'x', selection: own.selection }, ctx())).rejects.toThrow(PERSONAL_MAILBOX_REFUSED);
      expect(credentials).toEqual([]);
    } finally { pool.options.max = 10; pool.options.connectionTimeoutMillis = 0; }
  });
  it('holds account/member/resource/custody locks until provider work finishes', async () => {
    const own = await account(); let entered!:()=>void, release!:()=>void;
    const ready = new Promise<void>(resolve => { entered=resolve; }); const wait = new Promise<void>(resolve => { release=resolve; });
    hold = async () => { entered(); await wait; };
    const running = gmailSearch.execute({ query: 'x', selection: own.selection }, ctx()); await ready;
    const db = await getPool().connect();
    try {
      await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='80ms'");
      await expect(db.query("UPDATE users SET status='removed' WHERE id='member-a'")).rejects.toThrow(/lock timeout/);
      await db.query('ROLLBACK');
      for (const sql of ["UPDATE connected_accounts SET generation=generation+1 WHERE owner_member_id='member-a'",
        'DELETE FROM connected_resource_bindings', 'DELETE FROM connected_account_credentials', 'DELETE FROM oauth_tokens']) {
        await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='80ms'");
        await expect(db.query(sql)).rejects.toThrow(/lock timeout/); await db.query('ROLLBACK');
      }
    } finally { db.release(); release(); }
    await expect(running).resolves.toEqual(['message-a']);
  });
});
