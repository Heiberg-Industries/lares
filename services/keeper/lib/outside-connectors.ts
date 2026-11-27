// The installation's directory of outside connectors (ADR-0019, directory addendum): one row per outside
// server, whichever agents use it. Rows are written only here, through keeper actions the designated owner
// presses from the console (or `host` for a stored-away sign-in-less setup later). Nothing an agent says can
// add, change or remove a row.
//
// Three things leave this file: the keeper actions, the hosts the outside route takes from the rows
// (`connectorRouteHosts`, read by lifecycle.ts), and the probe's answer classifier.
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ProxyAgent, request } from 'undici';
import { parseDefinition } from '@lares/agent-kit/definition';
import { parseBearerChallenge } from '@lares/agent-kit/mcp-oauth';
import { checkOutsideUrl, outsideHttpsHosts, outsideToolsInEffect } from '@lares/agent-kit/outside-tools';
import { KeeperRefusedError, registerAction } from './actions.js';

const SLUG = /^[a-z][a-z0-9-]{1,30}$/;
const sessionToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = z.string().uuid();

export type ConnectorAuthKind = 'none' | 'token' | 'signin';
export type ConnectorState = 'setup' | 'connected' | 'retired';

export interface ConnectorView {
  id: string;
  slug: string;
  displayName: string;
  url: string;
  authKind: ConnectorAuthKind;
  description: string;
  state: ConnectorState;
  createdBy: 'owner' | 'host' | 'adopted';
  createdAt: string;
  probedAt: string | null;
  /** Names the server listed, never descriptions or schemas (those are read where they are reviewed). */
  toolCount: number | null;
  catalogueAt: string | null;
}

/** What an unauthenticated initialize got back. Only these two facts decide the login kind. */
export interface ConnectorProbeAnswer { status: number; wwwAuthenticate: string | null; mcp: boolean }
export type ConnectorProber = (url: string) => Promise<ConnectorProbeAnswer>;

/** 200 from an MCP server means no login. 401 that points at protected-resource metadata (RFC 9728, the
 *  `resource_metadata` challenge parameter) means the server's own sign-in page. Any other 401 means a token.
 *  Anything else is not an answer this directory can use. */
export function classifyProbe(answer: ConnectorProbeAnswer): ConnectorAuthKind {
  if (answer.status === 200 && answer.mcp) return 'none';
  if (answer.status === 401) return parseBearerChallenge(answer.wwwAuthenticate)?.resourceMetadata ? 'signin' : 'token';
  throw new KeeperRefusedError(answer.status === 200
    ? 'That address answered, but not like an outside tool server. Check the address.'
    : `That server answered with status ${answer.status}, which Lares cannot use to tell how it signs in. Check the address.`);
}

/** The https hosts of directory rows that are being set up or are connected. A retired row adds none.
 *  Read by the keeper each time it builds the outside route; only a row a keeper action saved is here. */
export async function connectorRouteHosts(pool: Pick<Pool, 'query'>): Promise<string[]> {
  const { rows } = await pool.query("SELECT url FROM outside_connectors WHERE retired_at IS NULL AND state IN ('setup','connected')");
  return outsideHttpsHosts(rows.map(r => ({ url: String(r.url) })));
}

const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lares-connector-check', version: '1' } } });
const BODY_LIMIT = 64 * 1024;

/** The unauthenticated initialize. It carries no credential of any kind. A redirect is not followed (undici's
 *  request leaves it as the answer), so a server cannot send the check somewhere else. The live probe in
 *  tests/live runs this same function against a real server. */
export async function askInitialize(url: string, dispatcher: import('undici').Dispatcher, deadlineAtMs: number): Promise<ConnectorProbeAnswer> {
  const response = await request(new URL(url).href, { method: 'POST', dispatcher,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: INITIALIZE, signal: AbortSignal.timeout(Math.max(1, deadlineAtMs - Date.now())) });
  let text = '';
  for await (const chunk of response.body) {
    text += Buffer.from(chunk).toString('utf8');
    if (text.length > BODY_LIMIT) { response.body.destroy(); break; }
  }
  const header = response.headers['www-authenticate'];
  return { status: response.statusCode, wwwAuthenticate: Array.isArray(header) ? header.join(', ') : header ?? null,
    mcp: response.statusCode === 200 && /"jsonrpc"\s*:\s*"2\.0"/.test(text) };
}

/** The same question, sent from the keeper through the outside route's proxy, only while the route lease holds. */
export async function routeProbe(url: string, proxyUrl: string, deadlineAtMs: number, assertCurrent: () => Promise<unknown>): Promise<ConnectorProbeAnswer> {
  const target = new URL(url);
  const proxy = new ProxyAgent({ uri: proxyUrl, proxyTunnel: true, connections: 1, allowH2: false,
    headersTimeout: Math.max(1, deadlineAtMs - Date.now()), bodyTimeout: Math.max(1, deadlineAtMs - Date.now()),
    requestTls: { servername: target.hostname, rejectUnauthorized: true, allowH2: false } });
  try {
    await assertCurrent();
    return await askInitialize(url, proxy, deadlineAtMs);
  } catch (error) {
    if (error instanceof KeeperRefusedError) throw error;
    throw new KeeperRefusedError('Lares could not reach that server through its outside route. Check the address, then try again.');
  } finally {
    await proxy.close().catch(() => undefined);
  }
}

interface Row {
  id: string; slug: string; display_name: string; url: string; auth_kind: ConnectorAuthKind; description: string;
  catalogue: { tools?: unknown[] } | null; catalogue_at: Date | null; state: ConnectorState;
  created_by: 'owner' | 'host' | 'adopted'; created_at: Date; probed_at: Date | null;
}
const COLUMNS = 'id,slug,display_name,url,auth_kind,description,catalogue,catalogue_at,state,created_by,created_at,probed_at';
const view = (r: Row): ConnectorView => ({ id: r.id, slug: r.slug, displayName: r.display_name, url: r.url, authKind: r.auth_kind,
  description: r.description, state: r.state, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(),
  probedAt: r.probed_at ? new Date(r.probed_at).toISOString() : null,
  toolCount: r.catalogue && Array.isArray(r.catalogue.tools) ? r.catalogue.tools.length : null,
  catalogueAt: r.catalogue_at ? new Date(r.catalogue_at).toISOString() : null });

const displayNameOf = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1).replaceAll('-', ' ');

/** The one https-only address rule: the same check the definition check applies, then https. */
function requireConnectorUrl(value: string): string {
  const check = checkOutsideUrl(value);
  if (!check.ok) throw new KeeperRefusedError(`That address cannot be used: ${check.reason}.`);
  if (check.scheme !== 'https') throw new KeeperRefusedError('A connector in the directory needs an https address.');
  return new URL(value).href;
}

export interface ConnectorOptions {
  pool: Pool;
  designatedOwnerId?: string;
  /** Sends the unauthenticated initialize. Absent when outside custody (and so the route) is off. */
  probe?: ConnectorProber;
  /** Rebuilds and acknowledges the outside route after the directory changed the host list. */
  reseal?: () => Promise<void>;
}

export function registerOutsideConnectorActions(o: ConnectorOptions): void {
  const { pool } = o;

  type Admitted = { id: string; status: string; org_role: string; with_owner: boolean } | undefined;
  /** The person behind a session that is live right now. Any failure reads as nobody. */
  async function sessionPerson(token: string): Promise<Admitted> {
    try {
      // with_owner: this person belongs to the designated owner's organisation. An admin of any other one is nobody here.
      return (await pool.query(`SELECT u.id,u.status,u.org_role,
          COALESCE(u.org_id IS NOT NULL AND u.org_id=(SELECT o.org_id FROM users o WHERE o.id=$2),false) AS with_owner
        FROM member_sessions s JOIN users u ON u.id=s.member_id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`, [sha256(token), o.designatedOwnerId ?? ''])).rows[0];
    } catch { return undefined; }
  }
  const isDesignatedOwner = (row: Admitted) =>
    !!o.designatedOwnerId && !!row && row.id === o.designatedOwnerId && row.status === 'active' && row.org_role === 'owner';
  /** Only the installation's designated owner, signed in now, active and an owner of the organisation.
   * Removing a connector stays here: it takes the connection away from every agent that uses it. */
  async function requireOwner(token: string): Promise<void> {
    if (!isDesignatedOwner(await sessionPerson(token))) throw new KeeperRefusedError('Only the designated owner can change the outside connector directory.');
  }
  /** The designated owner, or a person the owner made an admin, signed in now and active. For reading
   * the directory, adding a connector, renaming one and checking one: the same set the console gives
   * an admin. Without a configured owner there is no installation to be an admin of, so that refuses too. */
  async function requireOwnerOrAdmin(token: string): Promise<void> {
    const row = await sessionPerson(token);
    if (isDesignatedOwner(row)) return;
    if (!o.designatedOwnerId || !row || row.status !== 'active' || row.org_role !== 'admin' || row.with_owner !== true)
      throw new KeeperRefusedError('Only the designated owner or an admin can use the outside connector directory.');
  }

  async function inTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { db.release(); }
  }

  /** The hosts changed: rebuild the route. The row is already saved, so a failure here is reported, not undone. */
  async function resealRoute(): Promise<boolean> {
    if (!o.reseal) return true;
    try { await o.reseal(); return true; } catch { return false; }
  }

  async function load(db: Pick<Pool, 'query'>, id: string, lock = false): Promise<Row> {
    const row = (await db.query<Row>(`SELECT ${COLUMNS} FROM outside_connectors WHERE id=$1 AND retired_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!row) throw new KeeperRefusedError('There is no such connector (it may have been removed).');
    return row;
  }

  /** Groups the connections agents already declare, by name and address, into directory rows. Adopted rows
   *  are connected, never probed, and carry no credential. A name used with two different addresses, a name
   *  the directory cannot hold, and an address not https stay where they are and are reported. No agent
   *  definition and no custody record is touched. Safe to run again: a group already in the directory (or
   *  once removed from it) is not made twice. Only connections that take effect in a saved definition are
   *  grouped (the same rule the route uses), so adopting never adds a host the route did not already have. */
  async function adopt(db: PoolClient): Promise<{ adopted: number; skipped: { name: string; reason: string }[] }> {
    const definitions = (await db.query("SELECT name,definition FROM agent_definitions WHERE status<>'retired' ORDER BY name")).rows;
    const groups = new Map<string, { slug: string; url: string; token: boolean; description: string }[]>();
    for (const r of definitions) {
      let declared;
      try { declared = outsideToolsInEffect(parseDefinition(r.definition)); } catch { continue; }
      for (const t of declared) {
        const list = groups.get(t.name) ?? [];
        let href: string;
        try { href = new URL(t.url).href; } catch { href = t.url; }
        const same = list.find(g => g.url === href);
        if (same) same.token = same.token || t.token;
        else list.push({ slug: t.name, url: href, token: t.token, description: t.description });
        groups.set(t.name, list);
      }
    }
    const known = (await db.query("SELECT slug,url FROM outside_connectors")).rows as { slug: string; url: string }[];
    const skipped: { name: string; reason: string }[] = [];
    let adopted = 0;
    for (const [name, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      if (list.length > 1) { skipped.push({ name, reason: 'used with more than one address' }); continue; }
      const g = list[0]!;
      if (!SLUG.test(g.slug)) { skipped.push({ name, reason: 'the name is too long for the directory' }); continue; }
      const check = checkOutsideUrl(g.url);
      if (!check.ok || check.scheme !== 'https') { skipped.push({ name, reason: 'not an https address' }); continue; }
      if (known.some(k => k.slug === g.slug)) continue;
      await db.query(`INSERT INTO outside_connectors(slug,display_name,url,auth_kind,description,state,created_by)
        VALUES($1,$2,$3,$4,$5,'connected','adopted') ON CONFLICT (slug) WHERE retired_at IS NULL DO NOTHING`,
        [g.slug, displayNameOf(g.slug), g.url, g.token ? 'token' : 'none', g.description.slice(0, 500)]);
      adopted++;
    }
    return { adopted, skipped };
  }

  registerAction({
    name: 'outside.connector-list', input: z.strictObject({ sessionToken }), secretFields: ['sessionToken'],
    run: async ({ sessionToken: token }) => {
      await requireOwnerOrAdmin(token);
      // Existing per-agent connections join the directory the first time anyone looks. Nothing is migrated.
      const result = await inTransaction(async db => {
        const adoption = await adopt(db);
        const rows = (await db.query<Row>(`SELECT ${COLUMNS} FROM outside_connectors WHERE retired_at IS NULL ORDER BY lower(display_name),slug`)).rows;
        return { connectors: rows.map(view), adopted: adoption.adopted, notAdopted: adoption.skipped };
      });
      return result;
    },
    successDetail: r => `connector directory read (${r.connectors.length} connectors, ${r.adopted} adopted)`,
  });

  registerAction({
    name: 'outside.connector-create',
    input: z.strictObject({ sessionToken, slug: z.string().regex(SLUG), displayName: z.string().trim().min(1).max(80),
      url: z.string().min(1).max(2048), description: z.string().trim().max(500).default('') }),
    secretFields: ['sessionToken'],
    run: async ({ sessionToken: token, slug, displayName, url, description }) => {
      await requireOwnerOrAdmin(token);
      const href = requireConnectorUrl(url);
      let row: Row;
      try {
        row = (await pool.query<Row>(`INSERT INTO outside_connectors(slug,display_name,url,auth_kind,description,state,created_by)
          VALUES($1,$2,$3,'none',$4,'setup','owner') RETURNING ${COLUMNS}`, [slug, displayName, href, description])).rows[0]!;
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new KeeperRefusedError('A connector with that name already exists. Choose another name, or remove the old one first.');
        throw new KeeperRefusedError('The connector could not be saved. Nothing was changed.');
      }
      // The route takes the address now, so the sign-in check can reach a server no agent uses yet.
      return { connector: view(row), routeReady: await resealRoute() };
    },
    successDetail: r => `connector ${r.connector.slug} created (route ${r.routeReady ? 'ready' : 'not ready'})`,
  });

  registerAction({
    name: 'outside.connector-rename', input: z.strictObject({ sessionToken, id: uuid, displayName: z.string().trim().min(1).max(80) }),
    secretFields: ['sessionToken'],
    run: async ({ sessionToken: token, id, displayName }) => {
      await requireOwnerOrAdmin(token);
      // The label only. The technical name, and so every agent's declaration and held credential, stays as it is.
      const row = (await pool.query<Row>(`UPDATE outside_connectors SET display_name=$2 WHERE id=$1 AND retired_at IS NULL RETURNING ${COLUMNS}`, [id, displayName])).rows[0];
      if (!row) throw new KeeperRefusedError('There is no such connector (it may have been removed).');
      return { connector: view(row) };
    },
    successDetail: r => `connector ${r.connector.slug} renamed`,
  });

  registerAction({
    name: 'outside.connector-retire', input: z.strictObject({ sessionToken, id: uuid }), secretFields: ['sessionToken'],
    run: async ({ sessionToken: token, id }) => {
      await requireOwner(token);
      const row = await inTransaction(async db => {
        await load(db, id, true);
        return (await db.query<Row>(`UPDATE outside_connectors SET state='retired',retired_at=clock_timestamp() WHERE id=$1 RETURNING ${COLUMNS}`, [id])).rows[0]!;
      });
      // The directory host leaves the route. A host an agent's saved definition still names stays until that goes.
      return { connector: view(row), routeReady: await resealRoute() };
    },
    successDetail: r => `connector ${r.connector.slug} retired (route ${r.routeReady ? 'ready' : 'not ready'})`,
  });

  registerAction({
    name: 'outside.connector-probe', input: z.strictObject({ sessionToken, id: uuid, expectToken: z.boolean().default(false) }), secretFields: ['sessionToken'],
    run: async ({ sessionToken: token, id, expectToken }) => {
      await requireOwnerOrAdmin(token);
      if (!o.probe) throw new KeeperRefusedError('Outside tools are not switched on for this installation.');
      const row = await load(pool, id);
      const answer = await o.probe(row.url);
      // The owner said it takes a token: that stands, whatever an unauthenticated question got back. Many servers offer a sign-in
      // page and also accept a token (an API key sent as a bearer), so a sign-in page in the answer does not overrule the owner.
      let kind: ConnectorAuthKind;
      try { kind = classifyProbe(answer); } catch (error) { if (!expectToken) throw error; kind = 'token'; }
      if (expectToken) kind = 'token';
      // A token connector stays one when a later check sees a sign-in page: the owner chose Token for a server that offers both,
      // and a check must not undo that and stop every agent that uses it. A check can still see a server that needs no login.
      // The save itself decides, on the row as it is NOW, not as it was read before the question went out: two checks can run at
      // the same moment, and the slower one must not write its sign-in answer over the Token the other just recorded.
      const saved = (await pool.query<Row>(`UPDATE outside_connectors SET auth_kind=CASE WHEN auth_kind='token' AND $2='signin' THEN auth_kind ELSE $2 END,
        probed_at=clock_timestamp() WHERE id=$1 AND retired_at IS NULL RETURNING ${COLUMNS}`, [id, kind])).rows[0];
      if (!saved) throw new KeeperRefusedError('There is no such connector (it may have been removed).');
      // Recorded, never acted on: a sign-in server is saved as one and stays unusable until sign-in is built.
      return { connector: view(saved), authKind: saved.auth_kind, usable: saved.auth_kind !== 'signin' };
    },
    successDetail: r => `connector ${r.connector.slug} checked: ${r.authKind}`,
  });

}
