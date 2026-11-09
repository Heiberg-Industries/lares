import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { quiet } from './helpers/quiet-pool.js';
import { resetActions, runAction } from '../lib/actions.js';
import { ProviderKeyFiles, registerProviderKeyActions } from '../lib/provider-keys.js';

const repo = resolve('../..');
const owner = { uid: process.getuid!(), gid: process.getgid!() };
const KEY = 'sk-example-agent-provider-key-0123456789';
let container: StartedPostgreSqlContainer, pool: Pool, root: string, files: ProviderKeyFiles;
const audit = vi.fn(async (_record: unknown) => { });
const ctx = () => ({ actor: 'host', audit });
const host = { host: true };
const run = (name: string, input: unknown) => runAction(name, input, ctx(), host) as Promise<any>;
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const listed = () => readdirSync(files.directory).sort();

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
  for (const name of ['001_baseline.sql', '035_agent_provider_keys.sql']) await pool.query(readFileSync(join(repo, 'services/box/sql', name), 'utf8'));
});
afterAll(async () => { await pool?.end(); await container?.stop(); if (root) rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), 'keeper-provider-keys-'));
  await pool.query('DELETE FROM agent_definitions');
  await pool.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES('writer','{}','h','valid'),('old-agent','{}','h','retired')");
  files = new ProviderKeyFiles(root, owner, 150);
  audit.mockClear();
  resetActions();
  registerProviderKeyActions({ pool, files });
  await wait(100); // the start-up sweep makes the directory
});

it('stores the key as a root-only file named by its revision, and nothing secret in the database', async () => {
  const result = await run('provider-key.set', { name: 'writer', key: KEY });
  expect(result).toMatchObject({ name: 'writer', replaced: false, revision: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(listed()).toEqual([result.revision]);
  const directory = lstatSync(files.directory), file = lstatSync(join(files.directory, result.revision));
  expect(directory.mode & 0o777).toBe(0o700);
  expect(file.mode & 0o777).toBe(0o400);
  expect(file.nlink).toBe(1);
  expect(readFileSync(join(files.directory, result.revision), 'utf8')).toBe(KEY + '\n');
  const row = (await pool.query('SELECT * FROM agent_provider_keys')).rows[0];
  expect(row).toMatchObject({ agent: 'writer', revision: result.revision, state: 'active', set_by: 'host', tested_at: null, test_outcome: null });
  expect(JSON.stringify(row)).not.toContain(KEY);
  // Neither the audit trail nor the answer carries the key; the audit names the agent and the revision only.
  expect(JSON.stringify(audit.mock.calls)).not.toContain(KEY);
  expect(JSON.stringify(result)).not.toContain(KEY);
  expect(JSON.stringify(audit.mock.calls)).toContain(result.revision);
  expect(JSON.stringify(audit.mock.calls)).toContain('<redacted>');
});

it('is reachable only from the host command', async () => {
  await expect(runAction('provider-key.set', { name: 'writer', key: KEY }, ctx())).rejects.toThrow('reachable only from the host command');
  await expect(runAction('provider-key.remove', { name: 'writer' }, ctx())).rejects.toThrow('reachable only from the host command');
  expect((await pool.query('SELECT 1 FROM agent_provider_keys')).rowCount).toBe(0);
  expect(listed()).toEqual([]);
});

it.each([
  ['empty', ''], ['a space', 'sk-example key'], ['a newline', 'sk-example\nkey'], ['a tab', 'sk-example\tkey'], ['an escape', 'sk-\u001bexample'], ['a non-ASCII letter', 'sk-example-\u00e6'], ['a non-breaking space', 'sk-example\u00a0key'],
  ['too long', 'k'.repeat(4097)],
])('refuses a key with %s, and writes nothing', async (_label, key) => {
  await expect(run('provider-key.set', { name: 'writer', key })).rejects.toThrow('invalid input');
  expect(listed()).toEqual([]);
  expect((await pool.query('SELECT 1 FROM agent_provider_keys')).rowCount).toBe(0);
  expect(JSON.stringify(audit.mock.calls)).not.toContain('sk-example');
});

it('accepts the longest allowed key', async () => {
  const result = await run('provider-key.set', { name: 'writer', key: 'k'.repeat(4096) });
  expect(readFileSync(join(files.directory, result.revision), 'utf8')).toBe('k'.repeat(4096) + '\n');
});

it('refuses an unknown or retired agent, and an unsafe key directory', async () => {
  await expect(run('provider-key.set', { name: 'nobody', key: KEY })).rejects.toThrow('no such agent');
  await expect(run('provider-key.set', { name: 'old-agent', key: KEY })).rejects.toThrow('no such agent');
  chmodSync(files.directory, 0o755);
  await expect(run('provider-key.set', { name: 'writer', key: KEY })).rejects.toThrow();
  expect((await pool.query('SELECT 1 FROM agent_provider_keys')).rowCount).toBe(0);
  expect(listed()).toEqual([]);
  rmSync(files.directory, { recursive: true });
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, files.directory);
  await expect(run('provider-key.set', { name: 'writer', key: KEY })).rejects.toThrow();
  expect(readdirSync(elsewhere)).toEqual([]);
});

it('rotates by setting again: the new key is active at once, the old file goes after the grace period', async () => {
  const first = await run('provider-key.set', { name: 'writer', key: KEY });
  const second = await run('provider-key.set', { name: 'writer', key: KEY + '-next' });
  expect(second).toMatchObject({ replaced: true });
  expect(second.revision).not.toBe(first.revision);
  expect((await pool.query('SELECT revision FROM agent_provider_keys')).rows).toEqual([{ revision: second.revision }]);
  // A call admitted just before the switch can still read the old file.
  expect(listed()).toEqual([first.revision, second.revision].sort());
  await wait(400);
  expect(listed()).toEqual([second.revision]);
  expect(readFileSync(join(files.directory, second.revision), 'utf8')).toBe(KEY + '-next\n');
});

it('removes the row now and the file after the grace period; removing nothing is not an error', async () => {
  const set = await run('provider-key.set', { name: 'writer', key: KEY });
  expect(await run('provider-key.remove', { name: 'writer' })).toMatchObject({ removed: true, revision: set.revision });
  expect((await pool.query('SELECT 1 FROM agent_provider_keys')).rowCount).toBe(0);
  expect(listed()).toEqual([set.revision]);
  await wait(400);
  expect(listed()).toEqual([]);
  expect(await run('provider-key.remove', { name: 'writer' })).toMatchObject({ removed: false, revision: null });
  expect(JSON.stringify(audit.mock.calls)).not.toContain(KEY);
});

it('leaves no file behind when the database refuses the new key', async () => {
  const failing = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...args: any[]) => Promise<any>;
      const release = client.release.bind(client);
      (client as any).query = (text: unknown, ...rest: unknown[]) => typeof text === 'string' && text.includes('INSERT INTO agent_provider_keys') ? Promise.reject(new Error('refused')) : query(text, ...rest);
      (client as any).release = (error?: boolean | Error) => { (client as any).query = query; release(error); };
      return client;
    },
  } as unknown as Pool;
  resetActions();
  registerProviderKeyActions({ pool: failing, files });
  await expect(run('provider-key.set', { name: 'writer', key: KEY })).rejects.toThrow('Nothing was changed');
  expect(listed()).toEqual([]);
  expect((await pool.query('SELECT 1 FROM agent_provider_keys')).rowCount).toBe(0);
});

it('sweeps files no row names once they are older than the grace period, and keeps the live one', async () => {
  const live = await run('provider-key.set', { name: 'writer', key: KEY });
  const stray = '55555555-5555-4555-8555-555555555555', fresh = '66666666-6666-4666-8666-666666666666';
  for (const name of [stray, fresh, `.candidate-${stray}`]) writeFileSync(join(files.directory, name), 'x', { mode: 0o400 });
  const old = new Date(Date.now() - 60_000);
  for (const name of [stray, live.revision, `.candidate-${stray}`]) utimesSync(join(files.directory, name), old, old);
  files.sweep(new Set([live.revision]));
  expect(listed()).toEqual([live.revision, fresh].sort());
});

// ---- From the console: the designated owner only, through the signed-in session ----
const OWNER = 'member-owner', ADMIN = 'member-admin', PLAIN = 'member-plain';
const token = (seed: string) => seed.padEnd(43, 'x');
const sessions = { owner: token('owner'), admin: token('admin'), plain: token('plain'), removed: token('removed'), expired: token('expired'), revoked: token('revoked') };
const consoleRun = (name: string, input: Record<string, unknown>) => runAction(name, input, { actor: 'owner@example.com', audit }, {}) as Promise<any>;
async function consoleSetup() {
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'");
  await pool.query('CREATE TABLE IF NOT EXISTS member_sessions (id text PRIMARY KEY, member_id text NOT NULL, token_hash text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz)');
  await pool.query('DELETE FROM member_sessions');
  await pool.query('DELETE FROM users');
  await pool.query("INSERT INTO orgs(id,display_name) VALUES('org','Example') ON CONFLICT DO NOTHING");
  for (const [id, role, status] of [[OWNER, 'owner', 'active'], [ADMIN, 'owner', 'active'], [PLAIN, 'member', 'active'], ['member-removed', 'owner', 'removed']])
    await pool.query('INSERT INTO users(id,display_name,org_id,org_role,status) VALUES($1,$1,$2,$3,$4)', [id, 'org', role, status]);
  const add = (name: keyof typeof sessions, member: string, expires = '1 hour', revoked = false) => pool.query(
    `INSERT INTO member_sessions(id,member_id,token_hash,expires_at,revoked_at) VALUES($1,$2,$3,now() + $4::interval,${revoked ? 'now()' : 'NULL'})`,
    [name, member, createHash('sha256').update(sessions[name]).digest('hex'), expires]);
  await add('owner', OWNER); await add('admin', ADMIN); await add('plain', PLAIN); await add('removed', 'member-removed');
  await add('expired', OWNER, '-1 second'); await add('revoked', OWNER, '1 hour', true);
  resetActions();
  registerProviderKeyActions({ pool, files, designatedOwnerId: OWNER });
}

it('lets only the designated owner read, set or remove a key from the console, including refusing another administrator', async () => {
  await consoleSetup();
  for (const who of ['admin', 'plain', 'removed', 'expired', 'revoked'] as const) {
    for (const [action, extra] of [['provider-key.status', {}], ['provider-key.save', { key: KEY }], ['provider-key.remove-own', {}]] as const)
      await expect(consoleRun(action, { sessionToken: sessions[who], name: 'writer', ...extra })).rejects.toThrow('Only the designated owner');
  }
  await expect(consoleRun('provider-key.save', { sessionToken: token('unknown'), name: 'writer', key: KEY })).rejects.toThrow('Only the designated owner');
  expect((await pool.query('SELECT 1 FROM agent_provider_keys')).rowCount).toBe(0);
  expect(listed()).toEqual([]);
  // Without a configured owner nothing is allowed.
  resetActions();
  registerProviderKeyActions({ pool, files });
  await expect(consoleRun('provider-key.save', { sessionToken: sessions.owner, name: 'writer', key: KEY })).rejects.toThrow('Only the designated owner');
});

it('saves, shows and removes the key for the designated owner, sharing the host behaviour', async () => {
  await consoleSetup();
  expect(await consoleRun('provider-key.status', { sessionToken: sessions.owner, name: 'writer' })).toEqual({ name: 'writer', own: false });
  const first = await consoleRun('provider-key.save', { sessionToken: sessions.owner, name: 'writer', key: KEY });
  expect(first).toMatchObject({ name: 'writer', replaced: false, revision: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(lstatSync(join(files.directory, first.revision)).mode & 0o777).toBe(0o400);
  expect(readFileSync(join(files.directory, first.revision), 'utf8')).toBe(KEY + '\n');
  expect((await pool.query('SELECT * FROM agent_provider_keys')).rows[0]).toMatchObject({ agent: 'writer', revision: first.revision, state: 'active', set_by: 'owner', tested_at: null, test_outcome: null });
  expect(await consoleRun('provider-key.status', { sessionToken: sessions.owner, name: 'writer' })).toMatchObject({ name: 'writer', own: true, setBy: 'owner', setAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
  // A host set after the console set replaces it the same way, and the console sees it.
  expect((await run('provider-key.set', { name: 'writer', key: KEY + '-host' })).replaced).toBe(true);
  expect(await consoleRun('provider-key.status', { sessionToken: sessions.owner, name: 'writer' })).toMatchObject({ own: true, setBy: 'host' });
  // Rotation from the console removes the previous file after the grace period.
  const second = await consoleRun('provider-key.save', { sessionToken: sessions.owner, name: 'writer', key: KEY + '-next' });
  expect(second.replaced).toBe(true);
  await wait(400);
  expect(listed()).toEqual([second.revision]);
  expect(await consoleRun('provider-key.remove-own', { sessionToken: sessions.owner, name: 'writer' })).toMatchObject({ removed: true, revision: second.revision });
  expect((await pool.query('SELECT 1 FROM agent_provider_keys')).rowCount).toBe(0);
  await wait(400);
  expect(listed()).toEqual([]);
  await expect(consoleRun('provider-key.save', { sessionToken: sessions.owner, name: 'old-agent', key: KEY })).rejects.toThrow('no such agent');
});

it('never puts the key or the session token in an audit record, a result or an error', async () => {
  await consoleSetup();
  const results = [
    await consoleRun('provider-key.save', { sessionToken: sessions.owner, name: 'writer', key: KEY }),
    await consoleRun('provider-key.status', { sessionToken: sessions.owner, name: 'writer' }),
    await consoleRun('provider-key.remove-own', { sessionToken: sessions.owner, name: 'writer' }),
  ];
  const errors: string[] = [];
  for (const input of [{ sessionToken: sessions.admin, name: 'writer', key: KEY }, { sessionToken: sessions.owner, name: 'writer', key: KEY + ' bad' }])
    errors.push(String(await consoleRun('provider-key.save', input).catch(error => error.message)));
  const seen = JSON.stringify([audit.mock.calls, results, errors]);
  for (const secret of [KEY, sessions.owner, sessions.admin]) expect(seen).not.toContain(secret);
  expect(seen).toContain('<redacted>');
});
