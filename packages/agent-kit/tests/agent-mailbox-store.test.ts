import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgAccountStore } from '../src/account-store.js';
import { AGENT_MAILBOX_REASONS, AgentMailboxRefused, PgAgentMailboxStore, agentMayUsePersonalMailbox } from '../src/agent-mailbox-store.js';
import { GOOGLE_PERSONAL_READ_SCOPES, googlePersonalConsentScopes, microsoftPersonalConsentScopes, normalizeMicrosoftPersonalScopes,
  personalConsentPower, validateGooglePersonalScopes } from '../src/personal-consent.js';

const sqlDir = fileURLToPath(new URL('../../../services/box/sql/', import.meta.url));
let container: StartedPostgreSqlContainer;
let db: Pool;
let store: PgAgentMailboxStore;
const COMPOSE = [...googlePersonalConsentScopes('read+mail-draft')];
const READ = [...GOOGLE_PERSONAL_READ_SCOPES];
const SEND = [...googlePersonalConsentScopes('read+mail-send')];
const granted = { role: 'chief-of-staff', grants: [{ capability: 'gmail', scope: 'org' }], autonomy: {} } as never;
const pick = { accountId: 'acct-a', resourceBindingId: 'res-a' };

/** One Google account with a mailbox resource and stored consent scopes, owned by `owner`. */
async function account(id: string, owner: string, scopes: string[], generation = 0) {
  await db.query(`INSERT INTO connected_accounts (id,owner_member_id,connector_id,provider_issuer,provider_subject,provider_label,status,generation)
    VALUES ($1,$2,'google','https://accounts.google.com',$3,'name@example.com','ok',$4)`, [id, owner, `sub-${id}`, generation]);
  await db.query(`INSERT INTO connected_resource_bindings (id,owner_member_id,connected_account_id,resource_kind,external_id,provider_label)
    VALUES ($1,$2,$3,'mailbox',$4,'name@example.com')`, [id.replace('acct', 'res'), owner, id, `sub-${id}`]);
  const token = await db.query(`INSERT INTO oauth_tokens (principal,provider,org_id,email_address,refresh_token_enc,scopes)
    VALUES ($1,'google','org-test','name@example.com','fixture-encrypted',$2) RETURNING id`, [owner, scopes]);
  await db.query(`INSERT INTO connected_account_credentials (account_id,owner_member_id,connector_id,account_generation,oauth_token_id)
    VALUES ($1,$2,'google',$3,$4)`, [id, owner, generation, token.rows[0].id]);
}
const stored = async () => (await db.query('SELECT * FROM agent_account_bindings')).rows;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  db.on('error', () => undefined);
  db.on('connect', client => client.on('error', () => undefined));
  for (const name of readdirSync(sqlDir).filter(n => n.endsWith('.sql')).sort())
    await db.query(readFileSync(`${sqlDir}/${name}`, 'utf8'));
  store = new PgAgentMailboxStore(db);
}, 120_000);
afterAll(async () => { await db?.end(); await container?.stop(); });
beforeEach(async () => {
  await db.query('DELETE FROM connected_accounts');
  await db.query('DELETE FROM oauth_tokens');
  await db.query('DELETE FROM agent_definitions');
  await db.query("DELETE FROM users WHERE id IN ('member-a','member-b')");
  await db.query("INSERT INTO orgs (id, display_name) VALUES ('org-test','Example') ON CONFLICT DO NOTHING");
  await db.query(`INSERT INTO users (id,display_name,org_id,org_role,status) VALUES ('org-owner','Owner','org-test','owner','active')
    ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO users (id,display_name,org_id,org_role,status) VALUES
    ('member-a','Member A','org-test','member','active'), ('member-b','Member B','org-test','member','active')`);
  await db.query("INSERT INTO agent_definitions (name,definition,hash,status) VALUES ('agent-x','{}','fixture','valid')");
  await db.query("INSERT INTO agent_access (agent_name,owner_member_id,organisation_id) VALUES ('agent-x','member-a','org-test')");
});

describe('which mailbox an agent works on', () => {
  it('lets the agent owner choose their own account and reports it usable', async () => {
    await account('acct-a', 'member-a', COMPOSE);
    const binding = await store.set('member-a', 'agent-x', pick, granted);
    expect(binding).toMatchObject({ agent: 'agent-x', ownerMemberId: 'member-a', accountId: 'acct-a', accountGeneration: 0 });
    expect(await store.check('agent-x', granted)).toEqual({ ok: true, binding });
    expect(await store.get('member-a', 'agent-x')).toEqual({ binding });
    expect(JSON.stringify(binding)).not.toMatch(/token|credential|secret|fixture-encrypted/i);
    const replaced = await store.set('member-a', 'agent-x', pick, granted);
    expect(replaced.revision).not.toBe(binding.revision);
    expect(await stored()).toHaveLength(1);
  });
  it('accepts broader consent that still includes drafts', async () => {
    await account('acct-a', 'member-a', [...READ, 'https://www.googleapis.com/auth/gmail.modify']);
    await expect(store.set('member-a', 'agent-x', pick, granted)).resolves.toMatchObject({ accountId: 'acct-a' });
  });
  it('refuses a member who does not own the agent', async () => {
    await account('acct-b', 'member-b', COMPOSE);
    await expect(store.set('member-b', 'agent-x', { accountId: 'acct-b', resourceBindingId: 'res-b' }, granted))
      .rejects.toMatchObject({ reason: 'not-owner' });
    await expect(store.clear('member-b', 'agent-x')).rejects.toBeInstanceOf(AgentMailboxRefused);
    await expect(store.get('member-b', 'agent-x')).rejects.toBeInstanceOf(AgentMailboxRefused);
    expect(await stored()).toEqual([]);
  });
  it("refuses another member's account, and a resource that belongs to another account", async () => {
    await account('acct-a', 'member-a', COMPOSE);
    await account('acct-b', 'member-b', COMPOSE);
    await expect(store.set('member-a', 'agent-x', { accountId: 'acct-b', resourceBindingId: 'res-b' }, granted))
      .rejects.toMatchObject({ reason: 'account-unavailable' });
    await expect(store.set('member-a', 'agent-x', { accountId: 'acct-a', resourceBindingId: 'res-b' }, granted))
      .rejects.toMatchObject({ reason: 'account-unavailable' });
    await expect(store.set('member-a', 'agent-x', { accountId: 'missing', resourceBindingId: 'res-a' }, granted))
      .rejects.toMatchObject({ reason: 'account-unavailable' });
    expect(await stored()).toEqual([]);
  });
  it('lets the database refuse a hand-written row that names another member\'s account', async () => {
    await account('acct-b', 'member-b', COMPOSE);
    await expect(db.query(`INSERT INTO agent_account_bindings (agent,purpose,owner_member_id,connected_account_id,resource_binding_id,account_generation,revision)
      VALUES ('agent-x','mailbox','member-a','acct-b','res-b',0,gen_random_uuid())`)).rejects.toThrow(/foreign key/);
    await expect(db.query(`INSERT INTO agent_account_bindings (agent,purpose,owner_member_id,connected_account_id,resource_binding_id,account_generation,revision)
      VALUES ('agent-x','calendar','member-a','acct-b','res-b',0,gen_random_uuid())`)).rejects.toThrow();
  });
  it('binds only when consent allows drafts', async () => {
    await account('acct-a', 'member-a', READ);
    await expect(store.set('member-a', 'agent-x', pick, granted)).rejects.toMatchObject({ reason: 'scopes-not-draft' });
    await db.query("UPDATE oauth_tokens SET scopes=$1", [SEND]);
    await expect(store.set('member-a', 'agent-x', pick, granted)).rejects.toMatchObject({ reason: 'scopes-not-draft' });
    expect(await stored()).toEqual([]);
    await db.query("UPDATE oauth_tokens SET scopes=$1", [COMPOSE]);
    await expect(store.set('member-a', 'agent-x', pick, granted)).resolves.toMatchObject({ accountId: 'acct-a' });
  });
  it('refuses a definition that does not grant the mailbox', async () => {
    await account('acct-a', 'member-a', COMPOSE);
    const none = { role: 'chief-of-staff', grants: [{ capability: 'gmail', scope: 'none' }], autonomy: {} } as never;
    const never = { role: 'chief-of-staff', grants: [{ capability: 'gmail', scope: 'org' }], autonomy: { gmail: 'never' } } as never;
    const other = { role: 'researcher', grants: [{ capability: 'gmail', scope: 'org' }], autonomy: {} } as never;
    for (const definition of [none, never, other, { role: 'chief-of-staff', grants: [], autonomy: {} } as never]) {
      expect(agentMayUsePersonalMailbox(definition)).toBe(false);
      await expect(store.set('member-a', 'agent-x', pick, definition)).rejects.toMatchObject({ reason: 'not-granted' });
    }
    expect(agentMayUsePersonalMailbox(granted)).toBe(true);
    await store.set('member-a', 'agent-x', pick, granted);
    expect(await store.check('agent-x', none)).toEqual({ ok: false, reason: 'not-granted' });
  });
  it('reports no choice, and lets the owner clear one', async () => {
    expect(await store.check('agent-x', granted)).toEqual({ ok: false, reason: 'none' });
    expect(await store.get('member-a', 'agent-x')).toEqual({ reason: 'none' });
    await account('acct-a', 'member-a', COMPOSE);
    await store.set('member-a', 'agent-x', pick, granted);
    await store.clear('member-a', 'agent-x');
    expect(await stored()).toEqual([]);
  });
  it('stops when the account is disconnected', async () => {
    await account('acct-a', 'member-a', COMPOSE);
    await store.set('member-a', 'agent-x', pick, granted);
    const accounts = new PgAccountStore(db);
    await accounts.setStatus('member-a', await accounts.beginUpdate('member-a', 'acct-a', 0), 'revoked');
    expect(await store.check('agent-x', granted)).toEqual({ ok: false, reason: 'account-not-ok' });
    expect(await store.get('member-a', 'agent-x')).toMatchObject({ reason: 'account-not-ok' });
  });
  it('stops when a reconnect changes the account generation, until the owner confirms again', async () => {
    await account('acct-a', 'member-a', COMPOSE);
    const first = await store.set('member-a', 'agent-x', pick, granted);
    await db.query("UPDATE connected_accounts SET generation=1 WHERE id='acct-a'");
    await db.query("UPDATE connected_account_credentials SET account_generation=1 WHERE account_id='acct-a'");
    expect(await store.check('agent-x', granted)).toEqual({ ok: false, reason: 'generation-changed' });
    const again = await store.set('member-a', 'agent-x', pick, granted);
    expect(again.accountGeneration).toBe(1);
    expect(again.revision).not.toBe(first.revision);
    expect(await store.check('agent-x', granted)).toMatchObject({ ok: true });
  });
  it('stops when the reconnected consent no longer allows drafts', async () => {
    await account('acct-a', 'member-a', COMPOSE);
    await store.set('member-a', 'agent-x', pick, granted);
    await db.query("UPDATE oauth_tokens SET scopes=$1", [READ]);
    expect(await store.check('agent-x', granted)).toEqual({ ok: false, reason: 'scopes-not-draft' });
  });
  it('stops when the member is no longer active, and loses the choice when the member is deleted', async () => {
    await account('acct-a', 'member-a', COMPOSE);
    await store.set('member-a', 'agent-x', pick, granted);
    await db.query("UPDATE users SET status='removed' WHERE id='member-a'");
    expect(await store.check('agent-x', granted)).toEqual({ ok: false, reason: 'member-inactive' });
    await expect(store.get('member-a', 'agent-x')).rejects.toThrow();
    await db.query("DELETE FROM users WHERE id='member-a'");
    expect(await stored()).toEqual([]);
    expect(await store.check('agent-x', granted)).toEqual({ ok: false, reason: 'none' });
  });
  it('stops when the agent changes owner', async () => {
    await account('acct-a', 'member-a', COMPOSE);
    await store.set('member-a', 'agent-x', pick, granted);
    await db.query('ALTER TABLE agent_access DISABLE TRIGGER agent_access_changed_guard');
    try { await db.query("UPDATE agent_access SET owner_member_id='member-b' WHERE agent_name='agent-x'"); }
    finally { await db.query('ALTER TABLE agent_access ENABLE TRIGGER agent_access_changed_guard'); }
    expect(await store.check('agent-x', granted)).toEqual({ ok: false, reason: 'owner-changed' });
    await expect(store.clear('member-a', 'agent-x')).rejects.toMatchObject({ reason: 'not-owner' });
  });
  it('drops the choice when the account, the resource or the agent is deleted', async () => {
    for (const remove of ["DELETE FROM connected_accounts WHERE id='acct-a'", "DELETE FROM connected_resource_bindings WHERE id='res-a'",
      "DELETE FROM agent_definitions WHERE name='agent-x'"]) {
      await db.query('DELETE FROM connected_accounts');
      await db.query('DELETE FROM oauth_tokens');
      await db.query("INSERT INTO agent_definitions (name,definition,hash,status) VALUES ('agent-x','{}','fixture','valid') ON CONFLICT DO NOTHING");
      await db.query("INSERT INTO agent_access (agent_name,owner_member_id,organisation_id) VALUES ('agent-x','member-a','org-test') ON CONFLICT DO NOTHING");
      await account('acct-a', 'member-a', COMPOSE);
      await store.set('member-a', 'agent-x', pick, granted);
      await db.query(remove);
      expect(await stored()).toEqual([]);
    }
  });
  it('keeps the reason list closed and stable', () => {
    expect([...AGENT_MAILBOX_REASONS]).toEqual(['none', 'member-inactive', 'account-not-ok', 'generation-changed',
      'owner-changed', 'scopes-not-draft', 'not-granted']);
  });
});

describe('personal consent powers', () => {
  const compose = 'https://www.googleapis.com/auth/gmail.compose';
  const gmailSend = 'https://www.googleapis.com/auth/gmail.send';
  const drive = 'https://www.googleapis.com/auth/drive.readonly';
  it('gives each Google power exactly its own scopes', () => {
    expect(googlePersonalConsentScopes('read')).toEqual(READ);
    expect(googlePersonalConsentScopes('read+mail-send')).toEqual([...READ, gmailSend]);
    expect(googlePersonalConsentScopes('read+mail-draft')).toEqual([...READ, compose, drive]);
    expect(googlePersonalConsentScopes('read+mail-draft')).not.toContain(gmailSend);
    expect(googlePersonalConsentScopes('read')).not.toContain(drive);
    expect(() => personalConsentPower('read+mail-everything')).toThrow();
  });
  it('validates each Google power against what the account really holds', () => {
    expect(() => validateGooglePersonalScopes(READ, 'read')).not.toThrow();
    expect(() => validateGooglePersonalScopes(COMPOSE, 'read+mail-draft')).not.toThrow();
    expect(() => validateGooglePersonalScopes([...READ, 'https://www.googleapis.com/auth/gmail.modify'], 'read+mail-draft')).not.toThrow();
    // An account consented before Drive joined "read + drafts" has no Drive scope and still validates.
    expect(() => validateGooglePersonalScopes([...READ, compose], 'read+mail-draft')).not.toThrow();
    expect(() => validateGooglePersonalScopes(READ, 'read+mail-draft')).toThrow(/incomplete/);
    expect(() => validateGooglePersonalScopes(SEND, 'read+mail-draft')).toThrow(/incomplete/);
    expect(() => validateGooglePersonalScopes(SEND, 'read+mail-send')).not.toThrow();
    expect(() => validateGooglePersonalScopes(READ, 'read+mail-send')).toThrow(/incomplete/);
  });
  it('has no draft power for Microsoft accounts', () => {
    expect(() => microsoftPersonalConsentScopes('read+mail-draft')).toThrow(/no draft/);
    expect(() => normalizeMicrosoftPersonalScopes(['User.Read', 'Mail.Read', 'Calendars.Read'], 'read+mail-draft')).toThrow(/no draft/);
    expect(microsoftPersonalConsentScopes('read+mail-send')).toContain('Mail.Send');
    expect(microsoftPersonalConsentScopes('read')).not.toContain('Mail.Send');
  });
});
