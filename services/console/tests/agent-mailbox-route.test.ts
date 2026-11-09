import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestDb, type TestDb } from '@lares/agent-box/tests/helpers/pg.js';
import { GOOGLE_PERSONAL_READ_SCOPES, googlePersonalConsentScopes } from '@lares/agent-kit/personal-consent';

const seam = vi.hoisted(() => ({ query: (..._args: unknown[]): Promise<unknown> => Promise.reject(new Error('not initialized')),
  connect: (): Promise<unknown> => Promise.reject(new Error('not initialized')), session: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'signed-cookie' }) }) }));
vi.mock('../lib/auth', () => ({ sessionMember: seam.session }));
vi.mock('../lib/accounts', () => ({ googleOrgs: () => [{ id: 'example', label: 'example' }] }));
vi.mock('../lib/db', () => ({ pool: new Proxy({}, { get: (_t, key) => key === 'query' ? (...a: unknown[]) => seam.query(...a)
  : key === 'connect' ? () => seam.connect() : undefined, has: (_t, key) => key === 'query' || key === 'connect' }) }));
import { GET, POST } from '../app/api/agent-mailbox/route';

const origin = 'https://console.example.test', url = `${origin}/api/agent-mailbox`;
const COMPOSE = [...googlePersonalConsentScopes('read+mail-draft')], READ = [...GOOGLE_PERSONAL_READ_SCOPES];
const sqlDir = fileURLToPath(new URL('../../box/sql/', import.meta.url));
const definition = { name: 'writer', model: 'example-model', role: 'chief-of-staff', grants: [{ capability: 'gmail', scope: 'write-with-confirm' }], autonomy: { gmail: 'gated' } };
const post = (body: unknown, from: string | null = origin, raw?: string) => POST(new Request(url, { method: 'POST',
  headers: { 'content-type': 'application/json', ...(from ? { origin: from } : {}) }, body: raw ?? JSON.stringify(body) }));
const pick = { operation: 'choose', name: 'writer', accountId: 'acct-a', resourceBindingId: 'res-a' };
let db: TestDb;
const stored = async () => (await db.pool.query('SELECT * FROM agent_account_bindings')).rows;

async function account(id: string, owner: string, scopes: string[], label = 'name@example.com') {
  await db.pool.query(`INSERT INTO connected_accounts (id,owner_member_id,connector_id,provider_issuer,provider_subject,provider_label,status,generation)
    VALUES ($1,$2,'google','https://accounts.google.com',$3,$4,'ok',0)`, [id, owner, `sub-${id}`, label]);
  await db.pool.query(`INSERT INTO connected_resource_bindings (id,owner_member_id,connected_account_id,resource_kind,external_id,provider_label)
    VALUES ($1,$2,$3,'mailbox',$4,$5)`, [id.replace('acct', 'res'), owner, id, `sub-${id}`, label]);
  const token = await db.pool.query(`INSERT INTO oauth_tokens (principal,provider,org_id,email_address,refresh_token_enc,scopes)
    VALUES ($1,'google','org-test',$2,'fixture-encrypted',$3) RETURNING id`, [owner, label, scopes]);
  await db.pool.query(`INSERT INTO connected_account_credentials (account_id,owner_member_id,connector_id,account_generation,oauth_token_id)
    VALUES ($1,$2,'google',0,$3)`, [id, owner, token.rows[0].id]);
}

beforeAll(async () => {
  db = await startTestDb();
  for (const name of readdirSync(sqlDir).filter(n => n.endsWith('.sql') && n !== '001_baseline.sql').sort())
    await db.pool.query(readFileSync(`${sqlDir}/${name}`, 'utf8'));
  seam.query = (...args) => db.pool.query(args[0] as string, args[1] as unknown[]);
  seam.connect = () => db.pool.connect();
}, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  vi.stubEnv('CONSOLE_OAUTH_REDIRECT', `${origin}/api/auth/callback`); vi.stubEnv('NODE_ENV', 'production');
  seam.session.mockResolvedValue({ id: 'member-a' });
  await db.pool.query('DELETE FROM connected_accounts');
  await db.pool.query('DELETE FROM oauth_tokens');
  await db.pool.query('DELETE FROM agent_definitions');
  await db.pool.query("DELETE FROM users WHERE id IN ('member-a','member-b')");
  await db.pool.query("INSERT INTO orgs (id, display_name) VALUES ('org-test','Example') ON CONFLICT DO NOTHING");
  await db.pool.query(`INSERT INTO users (id,display_name,org_id,org_role,status) VALUES ('org-owner','Owner','org-test','owner','active') ON CONFLICT DO NOTHING`);
  await db.pool.query(`INSERT INTO users (id,display_name,org_id,org_role,status) VALUES
    ('member-a','Member A','org-test','member','active'), ('member-b','Member B','org-test','member','active')`);
  await db.pool.query("INSERT INTO agent_definitions (name,definition,hash,status) VALUES ('writer',$1,'fixture','valid')", [JSON.stringify(definition)]);
  await db.pool.query("INSERT INTO agent_access (agent_name,owner_member_id,organisation_id) VALUES ('writer','member-a','org-test')");
});

it('lets the agent owner choose their own account and returns the working view', async () => {
  await account('acct-a', 'member-a', COMPOSE, 'one@example.com');
  const response = await post(pick); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  const json = await response.json();
  expect(json.view).toMatchObject({ state: 'working', title: 'Mailbox', sentence: 'Sorts new mail and writes reply drafts in Gmail, and can read your Drive files. It never sends.',
    chosen: { accountId: 'acct-a', address: 'one@example.com' } });
  expect(json.view.options).toEqual([{ accountId: 'acct-a', resourceBindingId: 'res-a', address: 'one@example.com', canDraft: true }]);
  expect(JSON.stringify(json)).not.toContain('fixture-encrypted');
  expect(await stored()).toHaveLength(1);
});
it('refuses a member who does not own the agent, and changes nothing', async () => {
  await account('acct-b', 'member-b', COMPOSE);
  seam.session.mockResolvedValue({ id: 'member-b' });
  const response = await post({ ...pick, accountId: 'acct-b', resourceBindingId: 'res-b' });
  expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ ok: false, code: 'not-owner', message: 'Only this agent’s owner can choose its mailbox.' });
  expect((await post({ operation: 'clear', name: 'writer' })).status).toBe(403);
  const view = (await (await GET(new Request(`${url}?name=writer`))).json()).view;
  expect(view).toMatchObject({ state: 'not-yours', options: [] });
  expect(await stored()).toEqual([]);
});
it("refuses another member's account", async () => {
  await account('acct-b', 'member-b', COMPOSE);
  const response = await post({ ...pick, accountId: 'acct-b', resourceBindingId: 'res-b' });
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'account-unavailable' });
  expect(await stored()).toEqual([]);
});
it('refuses an account whose consent only reads, with a plain sentence', async () => {
  await account('acct-a', 'member-a', READ);
  const response = await post(pick); expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ ok: false, code: 'scopes-not-draft',
    message: 'That account can be read, but this agent may not write drafts in it. Reconnect it with “read + drafts”, which also lets the agent read your Drive files.' });
  expect(await stored()).toEqual([]);
});
it('refuses when the definition has no Gmail permission', async () => {
  await account('acct-a', 'member-a', COMPOSE);
  await db.pool.query("UPDATE agent_definitions SET definition=$1", [JSON.stringify({ ...definition, grants: [], autonomy: {} })]);
  expect(await (await post(pick)).json()).toMatchObject({ code: 'not-granted' });
  expect((await (await GET(new Request(`${url}?name=writer`))).json()).view).toMatchObject({ state: 'no-gmail-permission' });
});
it('after a reconnect pauses the mailbox until the owner confirms, then works again with the new generation', async () => {
  await account('acct-a', 'member-a', COMPOSE, 'one@example.com');
  await post(pick);
  await db.pool.query("UPDATE connected_accounts SET generation=1 WHERE id='acct-a'");
  await db.pool.query("UPDATE connected_account_credentials SET account_generation=1 WHERE account_id='acct-a'");
  const paused = (await (await GET(new Request(`${url}?name=writer`))).json()).view;
  expect(paused).toMatchObject({ state: 'paused', title: 'Mailbox paused', confirm: true,
    sentence: 'You reconnected one@example.com. Confirm that this agent may keep working on it.' });
  const confirmed = await post({ operation: 'confirm', name: 'writer' });
  expect((await confirmed.json()).view).toMatchObject({ state: 'working' });
  expect((await stored())[0].account_generation).toBe(1);
});
it('confirm with nothing chosen is refused', async () => {
  const response = await post({ operation: 'confirm', name: 'writer' });
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'account-unavailable' });
});
it('a disconnected account pauses the mailbox and offers a reconnect', async () => {
  await account('acct-a', 'member-a', COMPOSE, 'one@example.com');
  await post(pick);
  await db.pool.query("UPDATE connected_accounts SET status='revoked', generation=generation+1 WHERE id='acct-a'");
  const view = (await (await GET(new Request(`${url}?name=writer`))).json()).view;
  expect(view).toMatchObject({ state: 'paused', reconnect: { accountId: 'acct-a', generation: 1 }, options: [] });
  expect(view.sentence).toContain('one@example.com was disconnected');
});
it('clear removes the choice', async () => {
  await account('acct-a', 'member-a', COMPOSE);
  await post(pick);
  const response = await post({ operation: 'clear', name: 'writer' });
  expect((await response.json()).view).toMatchObject({ state: 'choose' });
  expect(await stored()).toEqual([]);
});
it('lists no account state when there is no Google account', async () => {
  expect((await (await GET(new Request(`${url}?name=writer`))).json()).view).toMatchObject({ state: 'no-account' });
});
it('needs a session, the exact origin, a small JSON body and no extra fields', async () => {
  await account('acct-a', 'member-a', COMPOSE);
  seam.session.mockResolvedValueOnce(null);
  expect((await post(pick)).status).toBe(401);
  for (const from of [null, 'https://other.example.test', `${origin}:444`]) expect((await post(pick, from)).status).toBe(403);
  expect((await post(null, origin, JSON.stringify({ ...pick, accountId: 'a'.repeat(20_000) }))).status).toBe(400);
  for (const change of [{ extra: 1 }, { name: 'Bad Name' }, { operation: 'apply' }, { accountId: '' }]) expect((await post({ ...pick, ...change })).status).toBe(400);
  expect((await POST(new Request(`${url}?x=1`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(pick) }))).status).toBe(400);
  expect(await stored()).toEqual([]);
});
