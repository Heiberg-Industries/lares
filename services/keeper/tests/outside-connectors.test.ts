import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { quiet } from './helpers/quiet-pool.js';
import { resetActions, runAction } from '../lib/actions.js';
import { classifyProbe, connectorRouteHosts, registerOutsideConnectorActions, type ConnectorProbeAnswer } from '../lib/outside-connectors.js';

const repo = resolve('../..');
const OWNER = 'member-owner', ADMIN = 'member-admin';
const token = (seed: string) => seed.padEnd(43, 'x');
const sessions = { owner: token('owner'), admin: token('admin'), expired: token('expired') };
let container: StartedPostgreSqlContainer, pool: Pool;
const audit = vi.fn(async (_record: unknown) => { });
const run = (name: string, input: Record<string, unknown>) => runAction(name, input, { actor: 'owner@example.com', audit }, {}) as Promise<any>;
const asOwner = (name: string, input: Record<string, unknown> = {}) => run(name, { sessionToken: sessions.owner, ...input });
const reseals = vi.fn(async () => { });
let answer: ConnectorProbeAnswer = { status: 401, wwwAuthenticate: 'Bearer realm="x"', mcp: false };
const probe = vi.fn(async (_url: string) => answer);

const tool = (name: string, url: string, token = false) => ({ name, url, description: `The ${name} server.`, token, tools: { allow: ['lookup'], read: ['lookup'] } });
const base = JSON.parse(readFileSync(join(repo, 'packages/agent-kit/templates/creative/agent.json'), 'utf8'));
const definition = (name: string, outsideTools: unknown[], scope = 'write-with-confirm') => JSON.stringify({ ...base, name, role: 'creative', doors: [],
  grants: [{ capability: 'outside', scope }], autonomy: { outside: 'gated' }, outsideTools });

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
  for (const name of ['001_baseline.sql', '007_member_identity_sessions.sql', '039_outside_connectors.sql']) await pool.query(readFileSync(join(repo, 'services/box/sql', name), 'utf8'));
  await pool.query("INSERT INTO orgs(id,display_name) VALUES('org','Example') ON CONFLICT DO NOTHING");
  for (const [id, role] of [[OWNER, 'owner'], [ADMIN, 'owner']]) await pool.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES($1,$1,'org',$2,'active')", [id, role]);
  const add = (id: string, member: string, expires: string) => pool.query(
    'INSERT INTO member_sessions(id,member_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now() - interval \'1 day\',now() + $4::interval)',
    [id, member, createHash('sha256').update(sessions[id as keyof typeof sessions]).digest('hex'), expires]);
  await add('owner', OWNER, '1 hour'); await add('admin', ADMIN, '1 hour'); await add('expired', OWNER, '-1 second');
});
afterAll(async () => { await pool?.end(); await container?.stop(); });
beforeEach(async () => {
  await pool.query('DELETE FROM outside_connectors');
  await pool.query('DELETE FROM agent_definitions');
  audit.mockClear(); reseals.mockClear(); probe.mockClear();
  answer = { status: 401, wwwAuthenticate: 'Bearer realm="x"', mcp: false };
  resetActions();
  registerOutsideConnectorActions({ pool, designatedOwnerId: OWNER, probe, reseal: reseals });
});

const create = (extra: Record<string, unknown> = {}) => asOwner('outside.connector-create', { slug: 'registry', displayName: 'Registry', url: 'https://tools.example.org/mcp', ...extra });

it('is for the designated owner only, on every action', async () => {
  const { connector } = await create();
  for (const who of ['admin', 'expired'] as const)
    for (const [name, extra] of [['outside.connector-list', {}], ['outside.connector-create', { slug: 'other', displayName: 'Other', url: 'https://o.example.org/' }],
      ['outside.connector-rename', { id: connector.id, displayName: 'X' }], ['outside.connector-retire', { id: connector.id }], ['outside.connector-probe', { id: connector.id }]] as const)
      await expect(run(name, { sessionToken: sessions[who], ...extra })).rejects.toThrow('Only the designated owner');
  await expect(run('outside.connector-list', { sessionToken: token('unknown') })).rejects.toThrow('Only the designated owner');
  resetActions();
  registerOutsideConnectorActions({ pool, probe, reseal: reseals });
  await expect(asOwner('outside.connector-list')).rejects.toThrow('Only the designated owner');
  expect(probe).not.toHaveBeenCalled();
});

it('creates a connector in setup, rebuilds the route, and refuses a taken name, a bad address and a plain-http address', async () => {
  const made = await create({ description: 'Looks up companies.' });
  expect(made).toMatchObject({ routeReady: true, connector: { slug: 'registry', displayName: 'Registry', url: 'https://tools.example.org/mcp', authKind: 'none', state: 'setup', createdBy: 'owner', toolCount: null, description: 'Looks up companies.' } });
  expect(reseals).toHaveBeenCalledTimes(1);
  await expect(create({ displayName: 'Again' })).rejects.toThrow('already exists');
  await expect(create({ slug: 'a', })).rejects.toThrow();
  await expect(create({ slug: 'two', url: 'http://registry-svc:3000/mcp' })).rejects.toThrow('needs an https address');
  await expect(create({ slug: 'three', url: 'https://user:pw@tools.example.org/' })).rejects.toThrow('cannot be used');
  await expect(create({ slug: 'four', url: 'https://10.0.0.5/mcp' })).rejects.toThrow('cannot be used');
  expect((await pool.query('SELECT count(*)::int AS n FROM outside_connectors')).rows[0].n).toBe(1);
});

it('says so when the route could not be rebuilt, and keeps the saved row', async () => {
  reseals.mockRejectedValueOnce(new Error('firewall detail that must not leak'));
  const made = await create();
  expect(made.routeReady).toBe(false);
  expect(JSON.stringify(made)).not.toContain('firewall detail');
  expect((await pool.query('SELECT count(*)::int AS n FROM outside_connectors')).rows[0].n).toBe(1);
});

it('renames the label only: the technical name, address and state do not change', async () => {
  const { connector } = await create();
  const renamed = await asOwner('outside.connector-rename', { id: connector.id, displayName: 'Company lookup' });
  expect(renamed.connector).toMatchObject({ id: connector.id, slug: 'registry', displayName: 'Company lookup', url: connector.url, state: 'setup' });
  expect(reseals).toHaveBeenCalledTimes(1);
  await expect(asOwner('outside.connector-rename', { id: connector.id, displayName: '   ' })).rejects.toThrow();
  await expect(asOwner('outside.connector-rename', { id: '00000000-0000-4000-8000-000000000000', displayName: 'X' })).rejects.toThrow('no such connector');
});

it('retires a connector, frees its name, rebuilds the route, and refuses to act on it afterwards', async () => {
  const { connector } = await create();
  const gone = await asOwner('outside.connector-retire', { id: connector.id });
  expect(gone).toMatchObject({ routeReady: true, connector: { state: 'retired' } });
  expect(reseals).toHaveBeenCalledTimes(2);
  expect((await asOwner('outside.connector-list')).connectors).toEqual([]);
  for (const [name, extra] of [['outside.connector-rename', { displayName: 'X' }], ['outside.connector-retire', {}], ['outside.connector-probe', {}]] as const)
    await expect(asOwner(name, { id: connector.id, ...extra })).rejects.toThrow('no such connector');
  const again = await create({ displayName: 'Registry again' });
  expect(again.connector.id).not.toBe(connector.id);
  expect((await pool.query("SELECT count(*)::int AS n FROM outside_connectors WHERE slug='registry'")).rows[0].n).toBe(2);
});

it('probes without a login: 200 from a server that speaks MCP is no login, 401 with sign-in metadata is sign-in, any other 401 is a token', async () => {
  const { connector } = await create();
  answer = { status: 200, wwwAuthenticate: null, mcp: true };
  expect(await asOwner('outside.connector-probe', { id: connector.id })).toMatchObject({ authKind: 'none', usable: true, connector: { authKind: 'none', probedAt: expect.any(String) } });
  answer = { status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://tools.example.org/.well-known/oauth-protected-resource", scope="read"', mcp: false };
  expect(await asOwner('outside.connector-probe', { id: connector.id })).toMatchObject({ authKind: 'signin', usable: false, connector: { authKind: 'signin', state: 'setup' } });
  answer = { status: 401, wwwAuthenticate: 'Bearer realm="api"', mcp: false };
  expect(await asOwner('outside.connector-probe', { id: connector.id })).toMatchObject({ authKind: 'token', usable: true });
  answer = { status: 401, wwwAuthenticate: null, mcp: false };
  expect(await asOwner('outside.connector-probe', { id: connector.id })).toMatchObject({ authKind: 'token' });
  expect(probe).toHaveBeenCalledWith('https://tools.example.org/mcp');
  expect((await pool.query('SELECT auth_kind FROM outside_connectors')).rows).toEqual([{ auth_kind: 'token' }]);
});

it('keeps a token connector a token connector when the owner said so, whatever an unauthenticated question got back, except a sign-in page', async () => {
  const { connector } = await create();
  for (const odd of [{ status: 200, wwwAuthenticate: null, mcp: true }, { status: 404, wwwAuthenticate: null, mcp: false }, { status: 403, wwwAuthenticate: 'Bearer', mcp: false }]) {
    answer = odd;
    expect(await asOwner('outside.connector-probe', { id: connector.id, expectToken: true })).toMatchObject({ authKind: 'token', usable: true });
  }
  answer = { status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://tools.example.org/.well-known/oauth-protected-resource"', mcp: false };
  expect(await asOwner('outside.connector-probe', { id: connector.id, expectToken: true })).toMatchObject({ authKind: 'signin' });
});

it('does not guess when the server answers something else, and leaves the record as it was', async () => {
  const { connector } = await create();
  for (const odd of [{ status: 200, wwwAuthenticate: null, mcp: false }, { status: 404, wwwAuthenticate: null, mcp: false }, { status: 403, wwwAuthenticate: 'Bearer', mcp: false }, { status: 302, wwwAuthenticate: null, mcp: false }]) {
    answer = odd;
    await expect(asOwner('outside.connector-probe', { id: connector.id })).rejects.toThrow(/Check the address/);
  }
  expect((await pool.query('SELECT auth_kind,probed_at FROM outside_connectors')).rows).toEqual([{ auth_kind: 'none', probed_at: null }]);
  expect(() => classifyProbe({ status: 500, wwwAuthenticate: null, mcp: false })).toThrow('status 500');
});

it('refuses to probe when outside tools are off', async () => {
  const { connector } = await create();
  resetActions();
  registerOutsideConnectorActions({ pool, designatedOwnerId: OWNER });
  await expect(asOwner('outside.connector-probe', { id: connector.id })).rejects.toThrow('not switched on');
});

it('adopts what agents already declare, grouped by name and address, once, and touches nothing else', async () => {
  const insert = (name: string, tools: unknown[], status = 'valid', scope = 'write-with-confirm') =>
    pool.query('INSERT INTO agent_definitions(name,definition,hash,status) VALUES($1,$2,$3,$4)', [name, definition(name, tools, scope), 'h', status]);
  await insert('writer', [tool('registry', 'https://tools.example.org/mcp', true), tool('hours', 'https://hours.example.org/mcp')]);
  await insert('helper', [tool('registry', 'https://tools.example.org/mcp', false), tool('clash', 'https://one.example.org/mcp')]);
  await insert('third', [tool('clash', 'https://two.example.org/mcp')]);
  await insert('ungranted', [tool('no-effect', 'https://ungranted.example.org/mcp')], 'valid', 'none');
  await insert('old-agent', [tool('retired-tool', 'https://old.example.org/mcp')], 'retired');
  await insert('internal', [tool('svc', 'http://registry-svc:3000/mcp')]);
  const before = (await pool.query('SELECT name,definition,hash FROM agent_definitions ORDER BY name')).rows;
  const first = await asOwner('outside.connector-list');
  expect(first.connectors.map((c: any) => [c.slug, c.authKind, c.state, c.createdBy, c.url])).toEqual([
    ['hours', 'none', 'connected', 'adopted', 'https://hours.example.org/mcp'],
    ['registry', 'token', 'connected', 'adopted', 'https://tools.example.org/mcp'],
  ]);
  expect(first.adopted).toBe(2);
  expect(first.notAdopted).toEqual([{ name: 'clash', reason: 'used with more than one address' }, { name: 'svc', reason: 'not an https address' }]);
  // Adopting is not run twice, and it does not bring back something that was removed.
  expect((await asOwner('outside.connector-list')).adopted).toBe(0);
  await asOwner('outside.connector-retire', { id: first.connectors.find((c: any) => c.slug === 'hours').id });
  expect((await asOwner('outside.connector-list')).connectors.map((c: any) => c.slug)).toEqual(['registry']);
  expect((await pool.query('SELECT name,definition,hash FROM agent_definitions ORDER BY name')).rows).toEqual(before);
  expect(reseals).toHaveBeenCalledTimes(1); // only the retire; adopting adds no host, so it rebuilds nothing
});

it('adds route hosts only from saved, live directory records, and drops them on retirement', async () => {
  expect(await connectorRouteHosts(pool)).toEqual([]);
  const a = await create();
  const b = await create({ slug: 'second', url: 'https://second.example.org/mcp' });
  await create({ slug: 'internal-plain', url: 'https://third.example.org/mcp' });
  expect(await connectorRouteHosts(pool)).toEqual(['second.example.org', 'third.example.org', 'tools.example.org']);
  // A record in the connected state keeps its host; a retired one loses it.
  await pool.query("UPDATE outside_connectors SET state='connected' WHERE id=$1", [a.connector.id]);
  await asOwner('outside.connector-retire', { id: b.connector.id });
  expect(await connectorRouteHosts(pool)).toEqual(['third.example.org', 'tools.example.org']);
  await asOwner('outside.connector-retire', { id: a.connector.id });
  expect(await connectorRouteHosts(pool)).toEqual(['third.example.org']);
  // Nothing but an action changes the list: the probe records a login kind and never a host.
  answer = { status: 200, wwwAuthenticate: null, mcp: true };
  const c = (await asOwner('outside.connector-list')).connectors[0];
  await asOwner('outside.connector-probe', { id: c.id });
  expect(await connectorRouteHosts(pool)).toEqual(['third.example.org']);
});

it('never writes the session token to the audit record', async () => {
  await create();
  expect(JSON.stringify(audit.mock.calls)).not.toContain(sessions.owner);
});
