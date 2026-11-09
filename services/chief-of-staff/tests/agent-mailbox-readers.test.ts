/** The mailbox an agent's scheduled jobs work on: real Postgres, stubbed token endpoint and Gmail. */
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PgAccountStore, type TrustedAccountAdapter } from '@lares/agent-kit/account-store';
import { googlePersonalConsentScopes } from '@lares/agent-kit/personal-consent';
import { PgAgentMailboxStore } from '@lares/agent-kit/agent-mailbox-store';
import { resetAgentMailboxLogForTests } from '../lib/agent-mailbox.js';
import { driveApisFor } from '../lib/google-drive.js';
import { __setTestGmailApiFactory, __setTestCalendarApiFactory, __setChosenMailboxDepsForTests, googleClients, listEnrolledMailboxes } from '../lib/google.js';
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
let gmailCalls: string[] = [], driveCalls = 0;
const logs: string[] = [];
const log = (line: string) => { logs.push(line); };
const fakeFetch = vi.fn<typeof fetch>(async input => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname.endsWith('/tokeninfo')) return Response.json(tokenInfo);
  if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/drive/')) { driveCalls++; return Response.json({ name: 'Plan', mimeType: 'application/vnd.google-apps.document' }); }
  if (url.hostname === 'oauth2.googleapis.com') {
    tokenCalls++;
    return Response.json({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, ...(rotateTo ? { refresh_token: rotateTo } : {}) });
  }
  throw new Error(`Unexpected URL ${url}`);
});

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
  resetAgentMailboxLogForTests(); __setChosenMailboxDepsForTests({ pool, fetch: fakeFetch, definition: async () => definition, log }); logs.length = 0; tokenCalls = 0; driveCalls = 0; rotateTo = undefined; gmailCalls = []; fakeFetch.mockClear();
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


// The Google readers go through the chosen mailbox, and only it.
describe('default readers on the chosen mailbox', () => {
  it('lists the chosen mailbox and hands out its clients, with one refresh for many calls', async () => {
    await choose();
    await expect(listEnrolledMailboxes()).resolves.toEqual(['own@example.invalid']);
    const gmail = await googleClients().gmail();
    await expect(gmail.search('in:inbox', 5)).resolves.toEqual(['m1']);
    await googleClients().gmail('own@example.invalid');
    await googleClients().calendar();
    await googleClients().calendar('own@example.invalid');
    await listEnrolledMailboxes();
    expect(tokenCalls).toBe(1);
  });

  it('refuses any other account', async () => {
    await choose();
    await expect(googleClients().gmail('other@example.invalid')).rejects.toThrow(/works on own@example.invalid only/);
    await expect(googleClients().calendar('other@example.invalid')).rejects.toThrow(/only/);
  });

  it('refuses to send or write, in plain words, and never reaches the provider', async () => {
    await choose();
    const gmail = await googleClients().gmail();
    await expect(gmail.send({ ...draftInput })).rejects.toThrow('This agent writes drafts only; send it from Gmail');
    const calendar = await googleClients().calendar();
    await expect(calendar.insertEvent({ summary: 's', start: 'a', end: 'b' })).rejects.toThrow(/calendar only/);
    expect(gmailCalls.filter(c => c === 'send' || c.startsWith('events.'))).toEqual([]);
  });

  it('a stale choice gives no mailboxes and refuses, never another account', async () => {
    const a = await choose();
    await store.setStatus('member-a', await store.beginUpdate('member-a', a.id, 0), 'revoked');
    await expect(listEnrolledMailboxes()).resolves.toEqual([]);
    await expect(googleClients().gmail()).rejects.toThrow(/no longer holds/);
    await expect(googleClients().calendar()).rejects.toThrow(/no longer holds/);
  });

  it('refuses mid-window once the choice stops holding, and drafts are refused too', async () => {
    const a = await choose();
    const gmail = await googleClients().gmail();
    await store.setStatus('member-a', await store.beginUpdate('member-a', a.id, 0), 'revoked');
    await expect(listEnrolledMailboxes()).resolves.toEqual([]);
    await expect(googleClients().gmail()).rejects.toThrow(/no longer holds/);
    await expect(gmail.draft(draftInput)).rejects.toThrow(/no longer holds/);
  });

  it('with nothing chosen, refuses plainly and lists nothing, whatever the environment says', async () => {
    vi.stubEnv('GOOGLE_PRINCIPAL_ID', 'member-a'); vi.stubEnv('GMAIL_PRIMARY_EMAIL', 'own@example.invalid');
    await expect(listEnrolledMailboxes()).resolves.toEqual([]);
    await expect(googleClients().gmail()).rejects.toThrow('No mailbox chosen for this agent; choose one on its Access tab');
    await expect(googleClients().calendar()).rejects.toThrow('No mailbox chosen for this agent; choose one on its Access tab');
    expect(tokenCalls).toBe(0);
  });

  it('outside a managed agent there is no mailbox either', async () => {
    await choose();
    vi.stubEnv('LARES_AGENT_NAME', ''); vi.stubEnv('LARES_AGENT_INCARNATION', '');
    await expect(listEnrolledMailboxes()).resolves.toEqual([]);
    await expect(googleClients().gmail()).rejects.toThrow('No mailbox chosen for this agent');
    expect(tokenCalls).toBe(0);
  });
});

// Drive: the same chosen mailbox, the same single refresh, read only.
describe('Drive on the chosen mailbox', () => {
  const OLD_CONSENT = COMPOSE.filter(s => !s.endsWith('drive.readonly'));
  it("gives the chosen mailbox's Drive, and many reads with mail calls in one window cost one refresh", async () => {
    await choose();
    await googleClients().gmail();
    const [one] = await driveApisFor();
    expect(one!.account).toBe('own@example.invalid');
    await one!.api.files.get({ fileId: 'f1' });
    await (await driveApisFor())[0]!.api.files.get({ fileId: 'f1' });
    await googleClients().calendar();
    expect(driveCalls).toBe(2);
    expect(tokenCalls).toBe(1);
  });
  it('says plainly when nothing is chosen', async () => {
    await expect(driveApisFor()).rejects.toThrow('Google Drive is not connected for this agent; choose a mailbox on its Access tab');
    expect(tokenCalls).toBe(0);
  });
  it('says plainly to reconnect when the account has no Drive permission', async () => {
    tokenInfo = { ...tokenInfo, scope: OLD_CONSENT.join(' ') };
    await choose(OLD_CONSENT);
    await expect(driveApisFor()).rejects.toThrow('To read Google Docs, reconnect Google on Your accounts');
    await expect(googleClients().gmail()).resolves.toBeDefined(); // mail and drafts keep working
  });
  it('refuses a stale choice, never another account, and a recheck failure mid-window', async () => {
    const a = await choose();
    const [{ api }] = await driveApisFor() as [{ api: Awaited<ReturnType<typeof driveApisFor>>[0]['api'] }];
    await store.setStatus('member-a', await store.beginUpdate('member-a', a.id, 0), 'revoked');
    await expect(driveApisFor()).rejects.toThrow(/no longer holds/);
    await expect(api.files.get({ fileId: 'f1' })).rejects.toThrow(/no longer holds/);
    expect(driveCalls).toBe(0);
  });
});
