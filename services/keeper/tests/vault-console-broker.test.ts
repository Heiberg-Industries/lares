import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { quiet } from '../../../packages/agent-kit/tests/helpers/quiet-pool.js';
import { PgGrantStore } from '../../../packages/agent-kit/src/grant-store.js';
import { PgVaultStore } from '../../../packages/agent-kit/src/vault-area-store.js';
import { bindConsoleSession } from '../../../packages/agent-kit/src/console-turn-authority.js';
import { definitionSchema, hashOf } from '../../../packages/agent-kit/src/definition.js';

const ids = vi.hoisted(() => ({
  organisation: 'broker-org', member: 'broker-owner', area: '11111111-1111-4111-8111-111111111111',
  sharedArea: '44444444-4444-4444-8444-444444444444',
  backing: '22222222-2222-4222-8222-222222222222', readGate: undefined as (() => Promise<void>) | undefined, reads: 0, clock: Date.now(),
  inventory: undefined as any,
}));
vi.mock('@lares/agent-box/lib/vault-storage.js', () => ({
  loadVaultStorageInventory: () => ids.inventory,
  verifyVaultStorageMetadata: async () => undefined,
}));
vi.mock('@lares/agent-kit/vault-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lares/agent-kit/vault-files')>();
  return { ...actual, GuardedVaultFiles: class {
    async list() { return { paths: ['owner.md'], files: 1 }; }
    async read() { ids.reads++; await ids.readGate?.(); return { path: 'owner.md', content: 'private note content', lines: 1, contentRevision: 'fixture', companion: null }; }
  } };
});

const incarnation = '33333333-3333-4333-8333-333333333333';
let admissionNonce = 'a'.repeat(43);
let session = 'wrun_broker_test';
const runtimeKey = 'b'.repeat(64), consoleKey = 'c'.repeat(64);
const agent = 'helper';
const defaultRoleDefinition = definitionSchema.parse({ ...JSON.parse(readFileSync(new URL('../../../packages/agent-kit/templates/chief-of-staff/agent.json', import.meta.url), 'utf8')), name: agent });
let roleDefinition = defaultRoleDefinition;
const dutiesMd = '', voiceMd = '';
let definitionHash = hashOf({ definition: roleDefinition, dutiesMd, voiceMd });
const env = { LARES_AGENT_NAME: agent, LARES_AGENT_INCARNATION: incarnation, AGENT_OWNER_USER_ID: ids.member };
let pool: Pool, container: Awaited<ReturnType<PostgreSqlContainer['start']>>, root: string, stopBroker: (() => Promise<void>) | undefined;

async function challenge(input: Record<string, unknown>): Promise<{ challenge: string; expiry: number }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(process.env.LARES_VAULT_CONSOLE_SOCKET!); let data = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ op: 'challenge', input }) + '\n'));
    socket.on('data', chunk => { data += chunk.toString(); const end = data.indexOf('\n'); if (end < 0) return;
      try { const response = JSON.parse(data.slice(0, end)); socket.destroy(); if (!response.ok) throw new Error('challenge refused'); resolve(response); }
      catch (error) { reject(error); }
    });
  });
}

async function runtime(op: string, input: unknown): Promise<any> {
  const { vaultBrokerRequest } = await import('../../../packages/agent-kit/src/vault-broker-client.js');
  return vaultBrokerRequest(op, input);
}

async function openTurn(sequence: number) {
  const rawBodyHash = createHash('sha256').update('{"message":"read"}').digest('hex');
  const input = { agent, incarnation, session, member: ids.member, admissionNonce, method: 'POST', path: `/eve/v1/session/${session}`, rawBodyHash, policyRevision: 2, definitionHash };
  const issued = await challenge(input);
  const payload = Buffer.from(JSON.stringify({ version: 1, purpose: 'human', ...input, challenge: issued.challenge, nonce: 'n'.repeat(43), expiry: issued.expiry })).toString('base64url');
  const capsule = `${payload}.${createHmac('sha256', Buffer.from(consoleKey, 'hex')).update(payload).digest('base64url')}`;
  const admitted = await runtime('request.admit', { capsule, receipt: { method: input.method, path: input.path, rawBodyHash } });
  await expect(runtime('request.admit', { capsule, receipt: { method: input.method, path: input.path, rawBodyHash } })).rejects.toThrow('Vault reader unavailable');
  const turnId = `01JAZ9K3M0EVE8QW4S7P1K2H${sequence ? '6S' : '6R'}`;
  const opened = await runtime('turn.open', { pendingReceipt: admitted.pendingReceipt, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence,
    definition: { definition: roleDefinition, dutiesMd, voiceMd, hash: definitionHash } });
  return { turnId, opened, pendingReceipt: admitted.pendingReceipt };
}

function interceptCommit(target: number, afterAck?: (query: (...args: any[]) => Promise<any>) => Promise<void>, loseAck = true): () => void {
  const originalConnect = pool.connect, connect = originalConnect.bind(pool); let seen = 0;
  pool.connect = (async (...args: any[]) => {
    const client = await (connect as any)(...args), queryDescriptor = Object.getOwnPropertyDescriptor(client, 'query'), releaseDescriptor = Object.getOwnPropertyDescriptor(client, 'release');
    const query = client.query.bind(client), release = client.release.bind(client);
    (client as any).query = async (...queryArgs: any[]) => {
      const command = typeof queryArgs[0] === 'string' ? queryArgs[0] : queryArgs[0]?.text;
      if (/^\s*COMMIT\b/i.test(command ?? '') && ++seen === target) {
        const result = await query(...queryArgs);
        await afterAck?.(query);
        if (loseAck) throw new Error('simulated lost COMMIT acknowledgement');
        return result;
      }
      return query(...queryArgs);
    };
    (client as any).release = (error?: boolean) => {
      if (queryDescriptor) Object.defineProperty(client, 'query', queryDescriptor); else delete (client as any).query;
      if (releaseDescriptor) Object.defineProperty(client, 'release', releaseDescriptor); else delete (client as any).release;
      return release(error);
    };
    return client;
  }) as typeof pool.connect;
  return () => { pool.connect = originalConnect; };
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'keeper-vault-broker-')));
  const secrets = join(root, 'secrets');
  await mkdir(secrets);
  await writeFile(join(secrets, 'console-vault-signing-key'), consoleKey);
  await writeFile(join(secrets, `${agent}-runtime-control`), runtimeKey);
  process.env.LARES_RUNTIME_CONTROL_SECRET_FILE = join(root, 'runtime-control');
  await writeFile(process.env.LARES_RUNTIME_CONTROL_SECRET_FILE, runtimeKey);
  process.env.LARES_AGENT_NAME = agent; process.env.LARES_AGENT_INCARNATION = incarnation;
  process.env.LARES_VAULT_RUNTIME_SOCKET = join(root, 'runtime.sock');
  process.env.LARES_VAULT_CONSOLE_SOCKET = join(root, 'console.sock');
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
  vi.stubEnv('DATABASE_URL', container.getConnectionUri());
  vi.stubEnv('LARES_AGENT_NAME', agent); vi.stubEnv('LARES_AGENT_INCARNATION', incarnation); vi.stubEnv('AGENT_OWNER_USER_ID', ids.member);
  const { serveConsoleVaultBroker } = await import('../lib/vault-console-broker.js');
  stopBroker = await serveConsoleVaultBroker(pool as never, join(secrets, 'console-vault-signing-key'), secrets, process.env.LARES_VAULT_RUNTIME_SOCKET, {
    consoleSocket: process.env.LARES_VAULT_CONSOLE_SOCKET,
    rootUid: process.getuid?.() ?? 0, socketUid: process.getuid?.() ?? 0, socketGid: process.getgid?.() ?? 0, turnClockForTests: () => ids.clock,
  });
}, 120_000);

afterAll(async () => {
  ids.readGate = undefined;
  await stopBroker?.(); await pool?.end(); await container?.stop(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});

beforeEach(async () => {
  admissionNonce = 'a'.repeat(43); session = 'wrun_broker_test';
  roleDefinition = defaultRoleDefinition; definitionHash = hashOf({ definition: roleDefinition, dutiesMd, voiceMd });
  ids.readGate = undefined; ids.reads = 0; ids.clock = Date.now();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query(`CREATE TABLE orgs(id text PRIMARY KEY,display_name text NOT NULL);
    CREATE TABLE users(id text PRIMARY KEY,display_name text NOT NULL,primary_email text,status text,org_role text,org_id text REFERENCES orgs(id),created_at timestamptz DEFAULT now());
    CREATE TABLE org_member_policy(user_id text PRIMARY KEY REFERENCES users(id),allowed_capabilities text[]);
    CREATE TABLE agent_definitions(name text PRIMARY KEY,status text,hash text,definition jsonb);
    CREATE TABLE agent_conversations(agent text,incarnation uuid,session_id text,door text,observed_at timestamptz DEFAULT now(),terminal boolean DEFAULT false,PRIMARY KEY(agent,incarnation,session_id));
    CREATE TABLE connected_accounts(id text PRIMARY KEY,owner_member_id text,generation integer,status text);
    CREATE TABLE agent_resources(name text PRIMARY KEY,ownership_token uuid,runtime_control_token uuid,state text,pending boolean);
    INSERT INTO orgs VALUES('${ids.organisation}','Example');
    INSERT INTO users(id,display_name,status,org_role,org_id) VALUES('${ids.member}','Owner','active','owner','${ids.organisation}');
    INSERT INTO org_member_policy VALUES('${ids.member}',NULL);
    INSERT INTO agent_definitions VALUES('${agent}','valid','${definitionHash}','${JSON.stringify(roleDefinition)}'::jsonb);
    INSERT INTO agent_resources VALUES('${agent}','${incarnation}','${incarnation}','ready',false);`);
  for (const file of ['007_member_identity_sessions.sql','009_vault_areas.sql','013_console_turn_authority.sql','014_agent_access_grants.sql','016_console_agent_access_capture.sql','017_private_console_surface_capture.sql','018_private_account_history.sql','020_vault_resource_grants.sql','022_console_vault_source_history.sql'])
    await pool.query(readFileSync(new URL(`../../../services/box/sql/${file}`, import.meta.url), 'utf8'));
  await new PgGrantStore(pool).adoptAgent(ids.member, { agentName: agent, expectedDefinitionHash: definitionHash }, { designatedOwnerMemberId: ids.member });
  await bindConsoleSession({ agent, incarnation, sessionId: session, memberId: ids.member, admissionNonce }, pool as never, env);
  const vault = new PgVaultStore(pool);
  await vault.provisionBacking(ids.member, { id: ids.backing, kind: 'git' }, { designatedOwnerMemberId: ids.member });
  await vault.provisionArea(ids.member, { id: ids.area, kind: 'private', owner: { kind: 'member', id: ids.member }, backingStoreId: ids.backing, relativePath: `vault/private/${ids.area}` }, { designatedOwnerMemberId: ids.member });
  const shared = await vault.provisionArea(ids.member, { id: ids.sharedArea, kind: 'shared', owner: { kind: 'organisation', id: ids.organisation }, backingStoreId: ids.backing, relativePath: `vault/shared/${ids.sharedArea}` }, { designatedOwnerMemberId: ids.member });
  await vault.configureAccess(ids.member, { areaId: ids.sharedArea, expectedRevision: shared.accessRevision, grants: [{ principal: { kind: 'member', id: ids.member }, permission: 'use', expiresAt: null }] }, { designatedOwnerMemberId: ids.member });
  ids.inventory = { version: 1, planId: randomUUID(), organisationId: ids.organisation, provisionerMemberId: ids.member,
    backing: { id: ids.backing, kind: 'git', root: '/srv' }, areas: [
      { areaId: ids.area, kind: 'private', owner: { kind: 'member', id: ids.member }, relativePath: `vault/private/${ids.area}`, origin: `/var/lib/lares-vault-git/${ids.area}.git` },
      { areaId: ids.sharedArea, kind: 'shared', owner: { kind: 'organisation', id: ids.organisation }, relativePath: `vault/shared/${ids.sharedArea}`, origin: `/var/lib/lares-vault-git/${ids.sharedArea}.git` },
    ] };
});

it('admits a signed human receipt, opens a non-synthetic turn id, reads through the keeper, and closes once', async () => {
  const { turnId, opened, pendingReceipt } = await openTurn(0);
  await expect(runtime('turn.open', { pendingReceipt, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 0,
    definition: { definition: roleDefinition, dutiesMd, voiceMd, hash: definitionHash } })).rejects.toThrow('Vault reader unavailable');
  expect(opened.turnCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const note = await runtime('vault.read', { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 0, operation: 'read', area: 'private', path: 'owner.md' });
  expect(note.content).toBe('private note content');
  await runtime('turn.close', { turnCapability: opened.turnCapability, turnId, sequence: 0 });
  await expect(runtime('vault.read', { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 0, operation: 'read', area: 'private', path: 'owner.md' })).rejects.toThrow('Vault reader unavailable');
});

it('captures and reads only the area kinds granted by the exact loaded definition', async () => {
  roleDefinition = definitionSchema.parse({ ...roleDefinition, grants: roleDefinition.grants.map(grant => grant.capability === 'vault' ? { ...grant, areas: ['private'] } : grant) });
  definitionHash = hashOf({ definition: roleDefinition, dutiesMd, voiceMd });
  await pool.query('UPDATE agent_definitions SET hash=$1,definition=$2::jsonb WHERE name=$3', [definitionHash, JSON.stringify(roleDefinition), agent]);
  session = 'wrun_private_only'; admissionNonce = 'd'.repeat(43);
  await bindConsoleSession({ agent, incarnation, sessionId: session, memberId: ids.member, admissionNonce }, pool as never, env);

  const { turnId, opened } = await openTurn(20);
  const captures = await pool.query('SELECT area_id FROM console_vault_source_captures WHERE session_id=$1 ORDER BY area_id', [session]);
  expect(captures.rows.map(row => row.area_id)).toEqual([ids.area]);
  const privateRead = await runtime('vault.read', { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 20, operation: 'read', area: 'private', path: 'owner.md' });
  expect(privateRead.content).toBe('private note content');
  await expect(runtime('vault.read', { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 20, operation: 'read', area: 'shared', path: 'owner.md' })).rejects.toThrow('Vault reader unavailable');
  expect(ids.reads).toBe(1);
});

it('withholds buffered content if turn.close races a file read', async () => {
  const { turnId, opened } = await openTurn(1);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  ids.readGate = async () => { entered(); await gate; };
  const read = runtime('vault.read', { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 1, operation: 'read', area: 'private', path: 'owner.md' });
  await started; await runtime('turn.close', { turnCapability: opened.turnCapability, turnId, sequence: 1 }); release();
  await expect(read).rejects.toThrow('Vault reader unavailable');
});

it.each([{ commit: 2, expectedReads: 0 }, { commit: 3, expectedReads: 1 }])('withholds all bytes when real keeper capture/read COMMIT acknowledgment $commit is lost', async ({ commit, expectedReads }) => {
  const { turnId, opened } = await openTurn(commit);
  const restore = interceptCommit(commit);
  try {
    await expect(runtime('vault.read', { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: commit, operation: 'read', area: 'private', path: 'owner.md' })).rejects.toThrow('Vault reader unavailable');
  } finally { restore(); }
  expect(ids.reads).toBe(expectedReads);
});

it('rechecks the turn capability before the read COMMIT when it expires during file access', async () => {
  const { turnId, opened } = await openTurn(4);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  ids.readGate = async () => { entered(); await gate; };
  const read = runtime('vault.read', { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 4, operation: 'read', area: 'private', path: 'owner.md' });
  await started; ids.clock += 5 * 60_000 + 1; release();
  await expect(read).rejects.toThrow('Vault reader unavailable');
});

it('keeps the acknowledged transaction outcome but withholds bytes when the turn expires after COMMIT acknowledgment', async () => {
  const { turnId, opened } = await openTurn(5);
  const restore = interceptCommit(3, async () => { ids.clock += 5 * 60_000 + 1; }, false);
  try {
    await expect(runtime('vault.read', { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 5, operation: 'read', area: 'private', path: 'owner.md' })).rejects.toThrow('Vault reader unavailable');
  } finally { restore(); }
  expect(ids.reads).toBe(1);
});

it.each([
  { name: 'current member policy', sql: "UPDATE org_member_policy SET allowed_capabilities=ARRAY[]::text[] WHERE user_id=$1", values: [ids.member] },
  { name: 'loaded definition', sql: "UPDATE agent_definitions SET hash=$1 WHERE name=$2", values: ['f'.repeat(64), agent] },
  { name: 'retained Vault source', sql: "UPDATE vault_areas SET status='retired',revision=nextval('vault_access_revision_seq') WHERE id=$1", values: [ids.area] },
])('withholds bytes if $name changes after source capture and before the fresh read transaction', async ({ sql, values }) => {
  const { turnId, opened } = await openTurn(6);
  const restore = interceptCommit(2, async query => { await query({ text: sql, values }); }, false);
  try {
    await expect(runtime('vault.read', { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 6, operation: 'read', area: 'private', path: 'owner.md' })).rejects.toThrow('Vault reader unavailable');
  } finally { restore(); }
  expect(ids.reads).toBe(0);
});
