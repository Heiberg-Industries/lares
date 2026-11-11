/** The mailbox an agent's scheduled jobs work on: real Postgres, stubbed token endpoint and Gmail. */
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PgAccountStore, type TrustedAccountAdapter } from '@lares/agent-kit/account-store';
import { decryptSecret } from '@lares/agent-kit/google-auth';
import { googlePersonalConsentScopes } from '@lares/agent-kit/personal-consent';
import { PgAgentMailboxStore } from '@lares/agent-kit/agent-mailbox-store';
import { agentMailbox, resetAgentMailboxLogForTests, noteOnce } from '../lib/agent-mailbox.js';
import { __setTestGmailApiFactory, __setTestCalendarApiFactory } from '../lib/google.js';
import { makeEmailTriageTick } from '../agent/schedules/email-triage.js';
import { quietPool } from './helpers/quiet-pool.js';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, readFileSync: (path: Parameters<typeof original.readFileSync>[0], ...args: unknown[]) => {
    const fixed: Record<string, string> = { '/run/secrets/google-token-key': '1'.repeat(64),
      '/run/secrets/personal-google-acme-id': 'fixture-client', '/run/secrets/personal-google-acme-secret': 'fixture-secret' };
    if (typeof path === 'string' && Object.hasOwn(fixed, path)) return fixed[path];
    return (original.readFileSync as (...a: unknown[]) => unknown)(path, ...args);
  } };
});

const key = '1'.repeat(64), incarnation = '11111111-1111-4111-8111-111111111111';
const definition = { role: 'chief-of-staff', grants: [{ capability: 'gmail', scope: 'org' }], autonomy: {} } as never;
const COMPOSE = [...googlePersonalConsentScopes('read+mail-draft')];
const sqlDir = new URL('../../box/sql/', import.meta.url);
let container: StartedPostgreSqlContainer, pool: Pool, store: PgAccountStore, dir: string;

function encrypt(token: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  return Buffer.concat([iv, cipher.update(token), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
/** A connected Google account (mailbox + calendar) for member-a, then the agent's mailbox choice. */
async function connect(scopes: string[] = COMPOSE) {
  const adapter: TrustedAccountAdapter = { connectorId: 'google',
    verifyAccount: async () => ({ issuer: 'https://accounts.google.com', subject: 'subject-a', label: 'Own' }),
    verifyResource: async (_a, kind) => ({ resourceKind: String(kind), externalId: 'subject-a', providerLabel: 'Inbox' }) };
  const created = await store.forTrustedAdapter(adapter).createPersonalAccount('member-a', null, { persist: async db => {
    const { rows } = await db.query(`INSERT INTO oauth_tokens(principal,provider,org_id,email_address,scopes,refresh_token_enc)
      VALUES('member-a','google','acme','own@example.invalid',$1,$2) RETURNING id`, [scopes, encrypt('old-refresh')]);
    return rows[0].id;
  } }, ['mailbox', 'calendar']);
  const resources = await store.listResources('member-a', created.id, created.generation);
  return { id: created.id, mailbox: resources.find(r => r.resourceKind === 'mailbox')!.id };
}
async function choose(scopes?: string[]) {
  const a = await connect(scopes);
  if (scopes) await pool.query('UPDATE oauth_tokens SET scopes=$1', [COMPOSE]); // choose needs drafts; the test then narrows
  await new PgAgentMailboxStore(pool).set('member-a', 'agent-x', { accountId: a.id, resourceBindingId: a.mailbox }, definition);
  if (scopes) await pool.query('UPDATE oauth_tokens SET scopes=$1', [scopes]);
  return a;
}

// What the stubbed provider says.
let tokenCalls = 0, tokenInfo: { sub: string; aud: string; expires_in: number; scope: string }, rotateTo: string | undefined;
let gmailCalls: string[] = [];
const logs: string[] = [];
const log = (line: string) => { logs.push(line); };
const fakeFetch = vi.fn<typeof fetch>(async input => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname.endsWith('/tokeninfo')) return Response.json(tokenInfo);
  if (url.hostname === 'oauth2.googleapis.com') {
    tokenCalls++;
    return Response.json({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, ...(rotateTo ? { refresh_token: rotateTo } : {}) });
  }
  throw new Error(`Unexpected URL ${url}`);
});
const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';
const OLD_CONSENT = COMPOSE.filter(s => s !== DRIVE);
const open = (extra = {}) => agentMailbox('email-triage', { pool, fetch: fakeFetch, definition: async () => definition, log, ...extra });

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = quietPool(container.getConnectionUri());
  for (const name of readdirSync(sqlDir).filter(n => n.endsWith('.sql')).sort()) await pool.query(readFileSync(new URL(name, sqlDir), 'utf8'));
  store = new PgAccountStore(pool);
  dir = mkdtempSync(join(tmpdir(), 'agent-mailbox-'));
}, 120_000);
afterAll(async () => { await pool?.end(); await container?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  vi.stubEnv('LARES_AGENT_NAME', 'agent-x'); vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
  vi.stubEnv('TOKEN_ENC_KEY_FILE', '/run/secrets/google-token-key');
  vi.stubEnv('LARES_PERSONAL_GOOGLE_CLIENTS', JSON.stringify({ acme: { clientIdFile: '/run/secrets/personal-google-acme-id',
    clientSecretFile: '/run/secrets/personal-google-acme-secret' } }));
  resetAgentMailboxLogForTests(); logs.length = 0; tokenCalls = 0; rotateTo = undefined; gmailCalls = []; fakeFetch.mockClear();
  tokenInfo = { sub: 'subject-a', aud: 'fixture-client', expires_in: 3600, scope: COMPOSE.join(' ') };
  await pool.query('DELETE FROM connected_accounts; DELETE FROM oauth_tokens; DELETE FROM agent_resources; DELETE FROM agent_definitions');
  await pool.query(`INSERT INTO orgs(id,display_name) VALUES ('fixture-org','Fixture') ON CONFLICT DO NOTHING;
    INSERT INTO users(id,display_name,org_id,org_role,status) VALUES ('member-a','A','fixture-org','owner','active'),('member-b','B','fixture-org','owner','active')
    ON CONFLICT(id) DO UPDATE SET status='active',org_role='owner'`);
  await pool.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES('agent-x','{}','fixture','valid')");
  await pool.query("INSERT INTO agent_access(agent_name,owner_member_id,organisation_id) VALUES('agent-x','member-a','fixture-org')");
  await pool.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending)
    VALUES('agent-x','127.0.0.2','fixture','owned',$1,$1,'ready',false)`, [incarnation]);
  const call = (name: string) => async (params: unknown) => { gmailCalls.push(name); void params; return { data: {} }; };
  __setTestGmailApiFactory(() => ({ users: {
    getProfile: async () => ({ data: { emailAddress: 'own@example.invalid' } }),
    messages: { list: async () => { gmailCalls.push('list'); return { data: { messages: [{ id: 'm1', threadId: 't1' }] } }; },
      get: call('get'), send: call('send') },
    drafts: { create: async () => { gmailCalls.push('drafts.create'); return { data: { id: 'd1', message: { id: 'dm1', threadId: 't1' } } }; },
      update: async () => { gmailCalls.push('drafts.update'); return { data: { id: 'd1', message: { id: 'dm1', threadId: 't1' } } }; },
      get: call('drafts.get') },
    threads: { get: call('threads.get') },
  } }) as never);
  __setTestCalendarApiFactory(() => ({ events: { list: async () => ({ data: { items: [] } }), insert: call('events.insert'), patch: call('events.patch'), delete: call('events.delete') },
    freebusy: { query: async () => ({ data: { calendars: { primary: { busy: [] } } } }) } }) as never);
});
afterEach(() => { __setTestGmailApiFactory(undefined); __setTestCalendarApiFactory(undefined); vi.unstubAllEnvs(); });

const draftInput = { from: 'own@example.invalid', to: ['x@example.com'], subject: 's', bodyText: 'b' };

describe('agentMailbox', () => {
  it('opens the chosen mailbox with one refresh and returns working clients', async () => {
    await choose();
    const am = await open();
    if (!am.ok) throw new Error(am.reason);
    expect(am).toMatchObject({ mailbox: 'own@example.invalid', ownerMemberId: 'member-a' });
    expect(tokenCalls).toBe(1);
    await expect(am.gmail.search('in:inbox', 5)).resolves.toEqual(['m1']);
    await expect(am.gmail.draft(draftInput)).resolves.toMatchObject({ gmailDraftId: 'd1' });
    await expect(am.calendar.freeBusy({ timeMin: 'a', timeMax: 'b' })).resolves.toEqual([]);
    expect(logs).toEqual([]);
  });

  it('never holds the custody lock while the job runs', async () => {
    const a = await choose();
    const am = await open();
    if (!am.ok) throw new Error(am.reason);
    // The setup transaction has ended: a second transaction locks the account row at once (NOWAIT would
    // fail if the first still held it), and the job's clients keep working while that lock is held.
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT id FROM connected_accounts WHERE id=$1 FOR UPDATE NOWAIT', [a.id]);
      await other.query('SELECT 1 FROM connected_account_credentials WHERE account_id=$1 FOR UPDATE NOWAIT', [a.id]);
      await expect(am.gmail.search('in:inbox', 5)).resolves.toEqual(['m1']);
      await other.query('ROLLBACK');
    } finally { other.release(); }
    const holding = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE state='idle in transaction'");
    expect(holding.rows[0].n).toBe(0);
  });

  it('refuses every mail send path and never reaches the provider', async () => {
    await choose();
    const am = await open();
    if (!am.ok) throw new Error(am.reason);
    await expect(am.gmail.send({ ...draftInput })).rejects.toThrow(/drafts only/);
    expect(gmailCalls.filter(c => c === 'send')).toEqual([]);
    // The send method on the message layer is refused too, whatever builds on it.
    expect(Object.keys(am.gmail)).toEqual(expect.arrayContaining(['draft', 'updateDraftRaw', 'send']));
  });

  it('rechecks before every draft and update, and refuses once the choice no longer holds', async () => {
    const a = await choose();
    const am = await open();
    if (!am.ok) throw new Error(am.reason);
    await expect(am.recheck()).resolves.toBe(true);
    await expect(am.gmail.updateDraftRaw('d1', 'raw')).resolves.toEqual({ gmailDraftId: 'd1' });
    // Disconnect.
    await store.setStatus('member-a', await store.beginUpdate('member-a', a.id, 0), 'revoked');
    gmailCalls.length = 0;
    await expect(am.recheck()).resolves.toBe(false);
    await expect(am.gmail.draft(draftInput)).rejects.toThrow(/no longer holds/);
    await expect(am.gmail.updateDraftRaw('d1', 'raw')).rejects.toThrow(/no longer holds/);
    expect(gmailCalls).toEqual([]);
  });

  it('refuses after the account is reconnected (new generation)', async () => {
    const a = await choose();
    const am = await open();
    if (!am.ok) throw new Error(am.reason);
    await pool.query('UPDATE connected_accounts SET generation=generation+1 WHERE id=$1', [a.id]);
    await pool.query('UPDATE connected_account_credentials SET account_generation=account_generation+1 WHERE account_id=$1', [a.id]);
    await expect(am.recheck()).resolves.toBe(false);
    await expect(am.gmail.draft(draftInput)).rejects.toThrow(/no longer holds/);
    expect(await open()).toEqual({ ok: false, reason: 'generation-changed' });
  });

  it('refuses after the agent changes owner, and when the same choice is replaced', async () => {
    await choose();
    const am = await open();
    if (!am.ok) throw new Error(am.reason);
    await pool.query('ALTER TABLE agent_access DISABLE TRIGGER agent_access_changed_guard');
    await pool.query("UPDATE agent_access SET owner_member_id='member-b'");
    await pool.query('ALTER TABLE agent_access ENABLE TRIGGER agent_access_changed_guard');
    await expect(am.recheck()).resolves.toBe(false);
    expect(await open()).toEqual({ ok: false, reason: 'owner-changed' });
  });

  it('refuses when the choice is replaced by another revision of the same account', async () => {
    const a = await choose();
    const am = await open();
    if (!am.ok) throw new Error(am.reason);
    await new PgAgentMailboxStore(pool).set('member-a', 'agent-x', { accountId: a.id, resourceBindingId: a.mailbox }, definition);
    await expect(am.recheck()).resolves.toBe(false);
  });

  it('saves a rotated refresh token, encrypted, when Google issues one', async () => {
    await choose();
    rotateTo = 'rotated-refresh';
    const am = await open();
    expect(am.ok).toBe(true);
    const { rows } = await pool.query('SELECT refresh_token_enc FROM oauth_tokens');
    expect(decryptSecret(rows[0].refresh_token_enc, key)).toBe('rotated-refresh');
  });

  it('leaves the stored refresh token alone when none is issued', async () => {
    await choose();
    await open();
    const { rows } = await pool.query('SELECT refresh_token_enc FROM oauth_tokens');
    expect(decryptSecret(rows[0].refresh_token_enc, key)).toBe('old-refresh');
  });

  it.each([
    ['subject', { sub: 'someone-else' }],
    ['audience', { aud: 'another-client' }],
    ['expiry', { expires_in: -10 }],
    ['scopes', { scope: COMPOSE.slice(0, -1).join(' ') }],
  ])('refuses a token whose %s does not match, before any Gmail call or rotation', async (_name, change) => {
    await choose();
    rotateTo = 'rotated-refresh';
    tokenInfo = { ...tokenInfo, ...change };
    expect(await open()).toEqual({ ok: false, reason: 'unavailable' });
    expect(gmailCalls).toEqual([]);
    const { rows } = await pool.query('SELECT refresh_token_enc FROM oauth_tokens');
    expect(decryptSecret(rows[0].refresh_token_enc, key)).toBe('old-refresh');
  });

  it('refuses a mailbox whose address differs from the connected account', async () => {
    await choose();
    __setTestGmailApiFactory(() => ({ users: { getProfile: async () => ({ data: { emailAddress: 'someone@example.invalid' } }) } }) as never);
    expect(await open()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('logs which kind of failure stopped it, never the detail, and still answers unavailable', async () => {
    await choose();
    const refused = (async () => Response.json({ error: 'invalid_grant',
      error_description: 'Token for own@example.invalid has been expired or revoked.' }, { status: 400 })) as typeof fetch;
    expect(await open({ fetch: refused })).toEqual({ ok: false, reason: 'unavailable' });
    expect(logs).toEqual([
      'email-triage: agent mailbox could not be opened: category=provider class=GaxiosError status=400 code=invalid_grant',
      'email-triage: agent mailbox unavailable (unavailable): Google did not accept the connection just now',
    ]);
    expect(gmailCalls).toEqual([]);
  });

  it('refuses a read-only account without any provider call', async () => {
    await choose(COMPOSE.filter(s => !s.endsWith('gmail.compose')));
    expect(await open()).toEqual({ ok: false, reason: 'scopes-not-draft' });
    expect(tokenCalls).toBe(0);
  });

  describe('calendar events', () => {
    const NO_EVENTS = COMPOSE.filter(sc => !sc.endsWith('calendar.events'));
    it('are written through the one refresh when the token carries calendar.events', async () => {
      await choose();
      const am = await open();
      if (!am.ok) throw new Error('expected a mailbox');
      await am.calendar.insertEvent({ summary: 's', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' });
      await am.calendar.updateEvent({ eventId: 'e', summary: 't' });
      await am.calendar.deleteEvent({ eventId: 'e' });
      expect(gmailCalls.filter(c => c.startsWith('events.'))).toEqual(['events.insert', 'events.patch', 'events.delete']);
      expect(tokenCalls).toBe(1);
    });
    it('also work with the broader calendar scope', async () => {
      const broad = [...NO_EVENTS, 'https://www.googleapis.com/auth/calendar'];
      tokenInfo = { ...tokenInfo, scope: broad.join(' ') };
      await choose(broad);
      const am = await open();
      if (!am.ok) throw new Error('expected a mailbox');
      await am.calendar.deleteEvent({ eventId: 'e' });
      expect(gmailCalls).toContain('events.delete');
    });
    it('refuse in plain words without the scope, while the mailbox still opens and reads', async () => {
      tokenInfo = { ...tokenInfo, scope: NO_EVENTS.join(' ') };
      await choose(NO_EVENTS);
      const am = await open();
      if (!am.ok) throw new Error('expected a mailbox');
      await expect(am.calendar.insertEvent({ summary: 's', start: 'a', end: 'b' })).rejects.toThrow('To add calendar events, reconnect Google on Your accounts');
      await expect(am.calendar.freeBusy({ timeMin: 'a', timeMax: 'b' })).resolves.toEqual([]);
      expect(gmailCalls.filter(c => c.startsWith('events.'))).toEqual([]);
    });
    it('refuse once the choice no longer holds, before reaching Google', async () => {
      const a = await choose();
      const am = await open();
      if (!am.ok) throw new Error('expected a mailbox');
      await store.setStatus('member-a', await store.beginUpdate('member-a', a.id, 0), 'revoked');
      await expect(am.calendar.updateEvent({ eventId: 'e' })).rejects.toThrow(/no longer holds; the event was not changed/);
      expect(gmailCalls).toEqual([]);
    });
  });

  describe('Drive, read only', () => {
    const driveCalls: string[] = [];
    const driveFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/drive/')) {
        driveCalls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        return Response.json({ id: 'f1', name: 'Plan', mimeType: 'application/vnd.google-apps.document' });
      }
      return fakeFetch(input, init);
    });
    beforeEach(() => { driveCalls.length = 0; });

    it('is present with the Drive scope, reads through the one refresh, and offers nothing that writes', async () => {
      await choose();
      const am = await open({ fetch: driveFetch });
      if (!am.ok) throw new Error('expected a mailbox');
      expect(am.drive).not.toBeNull();
      expect(Object.keys(am.drive!)).toEqual(['files']);
      expect(Object.keys(am.drive!.files).sort()).toEqual(['export', 'get']);
      await am.drive!.files.get({ fileId: 'f1', fields: 'name' });
      await am.drive!.files.get({ fileId: 'f1', fields: 'name' });
      expect(driveCalls).toEqual(['GET /drive/v3/files/f1', 'GET /drive/v3/files/f1']);
      expect(tokenCalls).toBe(1);
    });

    it('is null for an account consented before Drive was added, which still opens for mail and drafts', async () => {
      tokenInfo = { ...tokenInfo, scope: OLD_CONSENT.join(' ') };
      await choose(OLD_CONSENT);
      const am = await open({ fetch: driveFetch });
      expect(am.ok && am.drive).toBeNull();
      expect(am.ok).toBe(true);
    });

    it('refuses a Drive read once the choice stops holding', async () => {
      const a = await choose();
      const am = await open({ fetch: driveFetch });
      if (!am.ok) throw new Error('expected a mailbox');
      await store.setStatus('member-a', await store.beginUpdate('member-a', a.id, 0), 'revoked');
      await expect(am.drive!.files.get({ fileId: 'f1' })).rejects.toThrow(/no longer holds; the file was not read/);
      expect(driveCalls).toEqual([]);
    });
  });

  it('says nothing is chosen once, and again only when the reason changes', async () => {
    expect(await open()).toEqual({ ok: false, reason: 'none' });
    expect(await open()).toEqual({ ok: false, reason: 'none' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/email-triage: agent mailbox unavailable \(none\)/);
    expect(tokenCalls).toBe(0);
    const a = await connect();
    await new PgAgentMailboxStore(pool).set('member-a', 'agent-x', { accountId: a.id, resourceBindingId: a.mailbox }, definition);
    await open();
    await pool.query('UPDATE connected_accounts SET status=\'revoked\'');
    await open(); await open();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatch(/account-not-ok/);
    expect(logs.join('\n')).not.toMatch(/\n\s+at /);
  });

  it('refuses outside a managed agent, and when the agent is not ready', async () => {
    await choose();
    vi.stubEnv('LARES_AGENT_NAME', ''); vi.stubEnv('LARES_AGENT_INCARNATION', '');
    expect(await open()).toEqual({ ok: false, reason: 'not-managed' });
    vi.stubEnv('LARES_AGENT_NAME', 'agent-x'); vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    await pool.query('UPDATE agent_resources SET pending=true');
    expect(await open()).toEqual({ ok: false, reason: 'agent-not-ready' });
    await pool.query("UPDATE agent_resources SET pending=false; UPDATE agent_definitions SET status='invalid'");
    expect(await open({ log })).toEqual({ ok: false, reason: 'agent-not-ready' });
  });

  it('keeps a one-off notice quiet after the first time', () => {
    const say = vi.fn();
    noteOnce('k', 'same', say); noteOnce('k', 'same', say);
    expect(say).toHaveBeenCalledTimes(1);
  });
});

describe('triage tick on the chosen mailbox', () => {
  const claimed = { claimed: true as const, attempt: 1, isFinalAttempt: false };
  function deps(am: Extract<Awaited<ReturnType<typeof open>>, { ok: true }>, outcomes: string[], extra = {}) {
    return { mailboxes: async () => [am.mailbox], searchCandidates: async (m: string) => { void m; return am.gmail.search('in:inbox', 5); },
      readMessage: async () => ({ id: 'm1', threadId: 't1' }) as never, readThread: async () => [],
      claim: async () => claimed,
      triage: async () => { await am.gmail.draft(draftInput); return { outcome: 'drafted' as const, from: 'a', subject: 's', account: am.mailbox }; },
      recordOutcome: async (_m: string, _id: string, outcome: string) => { outcomes.push(outcome); },
      notify: async () => undefined, reportDropped: async () => undefined, prune: async () => undefined, ...extra };
  }
  it('runs on the chosen mailbox and writes the draft', async () => {
    await choose();
    const am = await open();
    if (!am.ok) throw new Error(am.reason);
    const outcomes: string[] = [];
    expect(await makeEmailTriageTick(deps(am, outcomes) as never).tick()).toBe(true);
    expect(outcomes).toEqual(['drafted']);
    expect(gmailCalls).toContain('drafts.create');
  });
  it('writes no draft and records no outcome once the choice stops holding mid-tick', async () => {
    const a = await choose();
    const am = await open();
    if (!am.ok) throw new Error(am.reason);
    await store.setStatus('member-a', await store.beginUpdate('member-a', a.id, 0), 'revoked');
    const outcomes: string[] = [];
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await makeEmailTriageTick(deps(am, outcomes) as never).tick();
    quiet.mockRestore();
    expect(outcomes).toEqual([]);
    expect(gmailCalls).not.toContain('drafts.create');
  });
});
