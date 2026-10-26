import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { quiet } from '../../../packages/agent-kit/tests/helpers/quiet-pool.js';
import { PgGrantStore } from '../../../packages/agent-kit/src/grant-store.js';
import { PgVaultStore } from '../../../packages/agent-kit/src/vault-area-store.js';
import { bindConsoleSession } from '../../../packages/agent-kit/src/console-turn-authority.js';
import { definitionSchema, hashOf } from '../../../packages/agent-kit/src/definition.js';
import { reserveExactApproval, attachExactApproval, approveExactResponse, requireApprovedExecution } from '../../../packages/agent-kit/src/approval-execution.js';
import { payloadFingerprint } from '../../../packages/agent-kit/src/approval-ledger.js';
import { NoteNotFoundError } from '../../../packages/agent-kit/src/notes-store.js';
import { tracksApprovalAdapter } from '../../chief-of-staff/lib/tracks-approval.js';
import { setVaultTurnCapability } from '../../chief-of-staff/agent/lib/vault-turn.js';

const ids = vi.hoisted(() => ({
  organisation: 'broker-org', member: 'broker-owner', area: '11111111-1111-4111-8111-111111111111',
  sharedArea: '44444444-4444-4444-8444-444444444444',
  backing: '22222222-2222-4222-8222-222222222222', readGate: undefined as (() => Promise<void>) | undefined, reads: 0, clock: Date.now(),
  inventory: undefined as any, trackFiles: new Map<string, { content: string; contentRevision: string }>(), writes: 0, useRealFiles: false,
}));
vi.mock('@lares/agent-box/lib/vault-storage.js', () => ({
  loadVaultStorageInventory: () => ids.inventory,
  verifyVaultStorageMetadata: async () => undefined,
}));
vi.mock('@lares/agent-kit/vault-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lares/agent-kit/vault-files')>();
  return { ...actual, GuardedVaultFiles: class {
    private delegate: InstanceType<typeof actual.GuardedVaultFiles> | undefined;
    constructor(authority: ConstructorParameters<typeof actual.GuardedVaultFiles>[0], backings: ConstructorParameters<typeof actual.GuardedVaultFiles>[1]) {
      if (ids.useRealFiles) this.delegate = new actual.GuardedVaultFiles(authority, backings);
    }
    async list(...args: Parameters<InstanceType<typeof actual.GuardedVaultFiles>['list']>) { if (this.delegate) return this.delegate.list(...args); return { paths: ['owner.md', ...ids.trackFiles.keys()], files: 1 + ids.trackFiles.size }; }
    async read(_ctx: unknown, path = 'owner.md', ...rest: unknown[]) { if (this.delegate) return (this.delegate as any).read(_ctx, path, ...rest); ids.reads++; await ids.readGate?.();
      const track = ids.trackFiles.get(path); if (track) return { path, content: track.content, lines: track.content.split('\n').length, contentRevision: track.contentRevision, companion: null };
      if (path.startsWith('tracks/')) throw new NoteNotFoundError(path);
      return { path, content: 'private note content', lines: 1, contentRevision: 'fixture', companion: null };
    }
    async write(_ctx: unknown, input: { binding: { relativePath: string; expectedContentRevision: string | null }; frontmatter: Record<string, unknown>; body: string }, ...rest: unknown[]) {
      if (this.delegate) return (this.delegate as any).write(_ctx, input, ...rest);
      const prior = ids.trackFiles.get(input.binding.relativePath);
      if ((prior?.contentRevision ?? null) !== input.binding.expectedContentRevision) throw new Error('stale fixture content');
      const fields = Object.entries(input.frontmatter).map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.join(', ')}]` : value}`).join('\n');
      ids.trackFiles.set(input.binding.relativePath, { content: `---\n${fields}\n---\n${input.body}`, contentRevision: `revision-${++ids.writes}` });
    }
  } };
});

const incarnation = '33333333-3333-4333-8333-333333333333';
let admissionNonce = 'a'.repeat(43);
let session = 'wrun_broker_test';
let approvalTurnId = 'turn-track-original', approvalTurnSequence = 30;
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
    vaultFilesForTests: { root: join(root, 'vault-files'), originRoot: join(root, 'vault-origins') },
  });
}, 120_000);

afterAll(async () => {
  ids.readGate = undefined;
  await stopBroker?.(); await pool?.end(); await container?.stop(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});

beforeEach(async () => {
  ids.trackFiles.clear(); ids.writes = 0;
  admissionNonce = 'a'.repeat(43); session = 'wrun_broker_test';
  approvalTurnId = 'turn-track-original'; approvalTurnSequence = 30;
  roleDefinition = defaultRoleDefinition; definitionHash = hashOf({ definition: roleDefinition, dutiesMd, voiceMd });
  ids.readGate = undefined; ids.reads = 0; ids.clock = Date.now();
  ids.useRealFiles = false;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query(`CREATE TABLE orgs(id text PRIMARY KEY,display_name text NOT NULL);
    CREATE TABLE users(id text PRIMARY KEY,display_name text NOT NULL,primary_email text,status text,org_role text,org_id text REFERENCES orgs(id),created_at timestamptz DEFAULT now());
    CREATE TABLE org_member_policy(user_id text PRIMARY KEY REFERENCES users(id),allowed_capabilities text[]);
    CREATE TABLE agent_definitions(name text PRIMARY KEY,status text,hash text,definition jsonb);
    CREATE TABLE agent_conversations(agent text,incarnation uuid,session_id text,door text,observed_at timestamptz DEFAULT now(),terminal boolean DEFAULT false,PRIMARY KEY(agent,incarnation,session_id));
    CREATE TABLE connected_accounts(id text PRIMARY KEY,owner_member_id text,generation integer,status text);
    CREATE TABLE agent_resources(name text PRIMARY KEY,ownership_token uuid,runtime_control_token uuid,state text,pending boolean,applied_definition jsonb);
    CREATE TABLE approval_asks(request_id text PRIMARY KEY,call_id text NOT NULL,agent text NOT NULL,tool text NOT NULL,payload_hash text NOT NULL,
      asked_at timestamptz NOT NULL DEFAULT now(),answered_at timestamptz,outcome text,answered_via text,used_at timestamptz,use_count integer NOT NULL DEFAULT 0,
      CHECK ((answered_at IS NULL)=(outcome IS NULL)),CHECK (outcome IS NULL OR outcome IN ('approved','cancelled','ignored','invalid','expired','payload-changed')));
    INSERT INTO orgs VALUES('${ids.organisation}','Example');
    INSERT INTO users(id,display_name,status,org_role,org_id) VALUES('${ids.member}','Owner','active','owner','${ids.organisation}');
    INSERT INTO users(id,display_name,status,org_role,org_id) VALUES('member-backup','Backup owner','active','owner','${ids.organisation}');
    INSERT INTO org_member_policy VALUES('${ids.member}',NULL);
    INSERT INTO org_member_policy VALUES('member-backup',NULL);
    INSERT INTO agent_definitions VALUES('${agent}','valid','${definitionHash}','${JSON.stringify(roleDefinition)}'::jsonb);
    INSERT INTO agent_resources VALUES('${agent}','${incarnation}','${incarnation}','ready',false,'${JSON.stringify(roleDefinition)}'::jsonb);`);
  for (const file of ['006_approval_session.sql','007_member_identity_sessions.sql','009_vault_areas.sql','013_console_turn_authority.sql','014_agent_access_grants.sql','015_exact_approval_execution.sql','016_console_agent_access_capture.sql','017_private_console_surface_capture.sql','018_private_account_history.sql','020_vault_resource_grants.sql','022_console_vault_source_history.sql'])
    await pool.query(readFileSync(new URL(`../../../services/box/sql/${file}`, import.meta.url), 'utf8'));
  await new PgGrantStore(pool).adoptAgent(ids.member, { agentName: agent, expectedDefinitionHash: definitionHash }, { designatedOwnerMemberId: ids.member });
  await bindConsoleSession({ agent, incarnation, sessionId: session, memberId: ids.member, admissionNonce }, pool as never, env);
  const vault = new PgVaultStore(pool);
  await vault.provisionBacking(ids.member, { id: ids.backing, kind: 'git' }, { designatedOwnerMemberId: ids.member });
  await vault.provisionArea(ids.member, { id: ids.area, kind: 'private', owner: { kind: 'member', id: ids.member }, backingStoreId: ids.backing, relativePath: `vault/private/${ids.area}` }, { designatedOwnerMemberId: ids.member });
  const shared = await vault.provisionArea(ids.member, { id: ids.sharedArea, kind: 'shared', owner: { kind: 'organisation', id: ids.organisation }, backingStoreId: ids.backing, relativePath: `vault/shared/${ids.sharedArea}` }, { designatedOwnerMemberId: ids.member });
  await vault.configureAccess(ids.member, { areaId: ids.sharedArea, expectedRevision: shared.accessRevision, grants: [
    { principal: { kind: 'member', id: ids.member }, permission: 'use', expiresAt: null },
    { principal: { kind: 'member', id: ids.member }, permission: 'edit', expiresAt: null },
  ] }, { designatedOwnerMemberId: ids.member });
  ids.inventory = { version: 1, planId: randomUUID(), organisationId: ids.organisation, provisionerMemberId: ids.member,
    backing: { id: ids.backing, kind: 'git', root: '/srv' }, areas: [
      { areaId: ids.area, kind: 'private', owner: { kind: 'member', id: ids.member }, relativePath: `vault/private/${ids.area}`, origin: `/var/lib/lares-vault-git/${ids.area}.git` },
      { areaId: ids.sharedArea, kind: 'shared', owner: { kind: 'organisation', id: ids.organisation }, relativePath: `vault/shared/${ids.sharedArea}`, origin: `/var/lib/lares-vault-git/${ids.sharedArea}.git` },
    ] };
});

const memberAuth = (purpose: 'human'|'resolver') => ({ authenticator: 'lares-console', principalId: ids.member, principalType: 'user',
  attributes: { user_id: ids.member, lares_member_id: ids.member, lares_admission_nonce: admissionNonce, lares_purpose: purpose } });
const trackInput = { trackId: 'follow-up', name: 'Follow up', purpose: 'Open work', steps: ['Open', 'Done'], closingSteps: ['Done'] };
const trackAdapter = {
  toolNames: ['track_create'],
  async readTarget(_db: unknown, _input: unknown, memberId: string) {
    return { kind: 'track-create', id: 'tracks/follow-up/track.md', ownerMemberId: memberId, fingerprint: payloadFingerprint('tracks-vault-target-v1', null), approvedOrigin: 'agent' };
  },
  async readPolicyHash() { return payloadFingerprint('tracks-write-policy-v1', { definition: roleDefinition, hash: definitionHash }); },
};

it('scheduled routing can read only visible shared track files for the current owner and cannot write', async () => {
  ids.trackFiles.set('tracks/follow-up/track.md', { content: '---\ntype: track\nname: Follow up\npurpose: Open work\nsteps: ["Open", "Done"]\nclosing_steps: ["Done"]\nscope: org\n---\nUntrusted description', contentRevision: 'track-v1' });
  ids.trackFiles.set('tracks/follow-up/items/lead-one.md', { content: '---\ntype: track-item\nperson: person-1\nstep: Open\nsince: 2026-10-26\nnote: untrusted background\nsource_signal: message-1\nscope: org\n---\nUntrusted item', contentRevision: 'item-v1' });
  ids.trackFiles.set('tracks/follow-up/notes.md', { content: 'out of scope', contentRevision: 'out-of-scope-v1' });
  ids.trackFiles.set('contacts/private.md', { content: 'private', contentRevision: 'private-v1' });

  const result = await runtime('tracks.list-scheduled', { ownerMemberId: ids.member, personId: 'person-1' });
  expect(result.homes).toEqual([{ home: `vault:${ids.sharedArea}`, tracks: [{
    track: { id: 'follow-up', name: 'Follow up', purpose: 'Open work', steps: ['Open', 'Done'], closingSteps: ['Done'] },
    items: [{ id: 'lead-one', trackId: 'follow-up', who: { personId: 'person-1' }, step: 'Open', since: '2026-10-26', note: 'untrusted background', sourceSignal: 'message-1' }],
  }] }]);
  expect(ids.reads).toBe(3);
  await expect(runtime('tracks.list-scheduled', { ownerMemberId: 'someone-else' })).rejects.toThrow('Vault reader unavailable');
  await expect(runtime('tracks.write', { operation: 'track_add_item', input: { home: `vault:${ids.sharedArea}` } })).rejects.toThrow('Vault reader unavailable');
  await pool.query("UPDATE users SET status='removed' WHERE id=$1", [ids.member]);
  await expect(runtime('tracks.list-scheduled', { ownerMemberId: ids.member })).rejects.toThrow('Vault reader unavailable');
  await pool.query("UPDATE users SET status='active' WHERE id=$1", [ids.member]);
  await pool.query("UPDATE agent_resources SET ownership_token='55555555-5555-4555-8555-555555555555' WHERE name=$1", [agent]);
  await expect(runtime('tracks.list-scheduled', { ownerMemberId: ids.member })).rejects.toThrow('Vault reader unavailable');
  await pool.query('UPDATE agent_resources SET ownership_token=$2::uuid WHERE name=$1', [agent, incarnation]);
  await pool.query("UPDATE vault_areas SET revision=nextval('vault_access_revision_seq') WHERE id=$1", [ids.sharedArea]);
  await expect(runtime('tracks.list-scheduled', { ownerMemberId: ids.member })).resolves.toMatchObject({ homes: [] });
  roleDefinition = definitionSchema.parse({ ...roleDefinition, grants: roleDefinition.grants.map(grant => grant.capability === 'vault' ? { ...grant, scope: 'read', areas: ['private', 'facts'] } : grant) });
  await pool.query('UPDATE agent_resources SET applied_definition=$2::jsonb WHERE name=$1', [agent, JSON.stringify(roleDefinition)]);
  await expect(runtime('tracks.list-scheduled', { ownerMemberId: ids.member })).rejects.toThrow('Vault reader unavailable');
});

function approvalContext(purpose: 'human'|'resolver', raw: unknown = trackInput, toolName = 'track_create') {
  const current = memberAuth(purpose);
  return { callId: 'track-call-1', toolName, toolInput: raw, abortSignal: new AbortController().signal,
    approvedTools: new Set<string>(), session: { id: session, turn: { id: purpose === 'human' ? approvalTurnId : 'turn-track-resolver', sequence: purpose === 'human' ? approvalTurnSequence : approvalTurnSequence + 1 },
      auth: { current, initiator: memberAuth('human') } } } as any;
}

it('accepts one exact approved Tracks write, rejects replay, and refuses after edit grant revocation', async () => {
  const approved = await approvedTrackCreate();
  const proof = { requestId: approved.authority.requestId, callId: approved.callId, toolName: approved.toolName,
    payloadHash: approved.payloadHash, input: trackInput, target: approved.target, authority: approved.authority };
  await expect(runtime('tracks.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: proof, operation: 'track_create',
    input: { ...trackInput, name: 'Changed after approval' } })).rejects.toThrow('Vault reader unavailable');
  await expect(runtime('tracks.write', { sessionId: session, memberId: 'member-b', admissionNonce, approval: proof, operation: 'track_create', input: trackInput })).rejects.toThrow('Vault reader unavailable');
  expect((await pool.query("SELECT use_count,used_at FROM approval_asks WHERE call_id='track-call-1'")).rows[0]).toMatchObject({ use_count: 0, used_at: null });
  const result = await runtime('tracks.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: proof, operation: 'track_create', input: trackInput });
  expect(result.result).toMatchObject({ id: 'follow-up', name: 'Follow up', closingSteps: ['Done'] });
  expect(ids.trackFiles.has('tracks/follow-up/track.md')).toBe(true);
  expect((await pool.query("SELECT use_count,used_at FROM approval_asks WHERE call_id='track-call-1'")).rows[0].use_count).toBe(1);
  await expect(runtime('tracks.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: proof, operation: 'track_create', input: trackInput })).rejects.toThrow('Vault reader unavailable');
  expect(ids.writes).toBe(1);

  await pool.query('DELETE FROM approval_asks; DELETE FROM console_session_bindings');
  ids.trackFiles.clear();
  await bindConsoleSession({ agent, incarnation, sessionId: session, memberId: ids.member, admissionNonce }, pool as never, env);
  const next = await approvedTrackCreate();
  const nextProof = { requestId: next.authority.requestId, callId: next.callId, toolName: next.toolName,
    payloadHash: next.payloadHash, input: trackInput, target: next.target, authority: next.authority };
  const revision = Number((await pool.query('SELECT revision FROM vault_areas WHERE id=$1', [ids.sharedArea])).rows[0].revision);
  await new PgVaultStore(pool).configureAccess(ids.member, { areaId: ids.sharedArea, expectedRevision: revision,
    grants: [{ principal: { kind: 'member', id: ids.member }, permission: 'use', expiresAt: null }] }, { designatedOwnerMemberId: ids.member });
  await expect(runtime('tracks.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: nextProof, operation: 'track_create', input: trackInput })).rejects.toThrow('Vault reader unavailable');
  expect((await pool.query("SELECT use_count,used_at FROM approval_asks WHERE call_id='track-call-1'")).rows[0]).toMatchObject({ use_count: 0, used_at: null });
  expect(ids.writes).toBe(1);
});
async function approvedExactTrack(operation: string, input: unknown, adapter: any) {
  const human = approvalContext('human', input, operation);
  await reserveExactApproval(human, operation, { adapter, db: pool as never, env });
  await attachExactApproval({ requestId: 'track-request-1', callId: 'track-call-1', tool: operation, input }, pool as never);
  await approveExactResponse({ request: { requestId: 'track-request-1', callId: 'track-call-1', toolName: operation, toolInput: input },
    responder: memberAuth('resolver'), session: { id: session, initiator: memberAuth('human'), turn: { id: 'turn-track-resolver', sequence: 31 } } },
    { adapter, db: pool as never, env });
  return requireApprovedExecution(approvalContext('resolver', input, operation), operation, input, { adapter, db: pool as never, env });
}
async function approvedTrackCreate(adapter: any = trackAdapter) {
  return approvedExactTrack('track_create', trackInput, adapter);
}

function initializeVaultArea(path: string, origin: string, marker: Record<string, unknown>) {
  mkdirSync(dirname(path), { recursive: true }); mkdirSync(dirname(origin), { recursive: true }); mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '--bare', origin], { stdio: 'ignore' });
  execFileSync('git', ['init', path], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'config', 'user.email', 'fixture@example.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Fixture'], { stdio: 'ignore' });
  writeFileSync(join(path, '.lares-vault-area.json'), JSON.stringify(marker));
  execFileSync('git', ['-C', path, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'commit', '-m', 'initialize fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', origin], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'push', '-u', 'origin', 'HEAD'], { stdio: 'ignore' });
}

it('runs an approved create through Keeper and the real GuardedVaultFiles writer', async () => {
  const vaultRoot = join(root, 'vault-files'), originRoot = join(root, 'vault-origins');
  for (const [areaId, kind, owner, relativePath] of [
    [ids.area, 'private', { kind: 'member', id: ids.member }, `vault/private/${ids.area}`],
    [ids.sharedArea, 'shared', { kind: 'organisation', id: ids.organisation }, `vault/shared/${ids.sharedArea}`],
  ] as const) {
    const marker = { version: 1, areaId, backingStoreId: ids.backing, relativePath, kind, owner };
    initializeVaultArea(join(vaultRoot, relativePath), join(originRoot, `${areaId}.git`), marker);
  }
  ids.useRealFiles = true;
  const turn = await openTurn(approvalTurnSequence);
  approvalTurnId = turn.turnId;
  setVaultTurnCapability({ sessionId: session, turnId: turn.turnId, sequence: approvalTurnSequence, incarnation },
    { turnId: turn.turnId, sequence: approvalTurnSequence, capability: turn.opened.turnCapability, expiresAt: turn.opened.expiresAt });
  const approved = await approvedTrackCreate(trackAdapter);
  const proof = { requestId: approved.authority.requestId, callId: approved.callId, toolName: approved.toolName,
    payloadHash: approved.payloadHash, input: trackInput, target: approved.target, authority: approved.authority };
  const result = await runtime('tracks.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: proof, operation: 'track_create', input: trackInput });
  expect(result.result).toMatchObject({ id: 'follow-up', name: 'Follow up' });
  const content = readFileSync(join(vaultRoot, `vault/shared/${ids.sharedArea}/tracks/follow-up/track.md`), 'utf8');
  expect(content).toContain('lares_origin: agent');
  expect(content).toContain('steps: ["Open","Done"]');
});

it('binds neutral Vault writes to the supplied current home and exact move track', async () => {
  const trackPath = 'tracks/follow-up/track.md';
  const itemPath = 'tracks/follow-up/items/lead-one.md';
  const content = '---\ntype: track\nname: Follow up\npurpose: Open work\nsteps: ["Open", "Done"]\nclosing_steps: ["Done"]\nscope: org\n---\n';
  ids.trackFiles.set(trackPath, { content, contentRevision: 'track-v1' });
  ids.trackFiles.set(itemPath, { content: '---\ntype: track-item\nperson: person-1\nstep: Open\nsince: 2026-10-26\nnote: old\nsource_signal: old\nscope: org\n---\n', contentRevision: 'item-v1' });
  const add = { home: 'vault:another-area', trackId: 'follow-up', who: { personId: 'person-1' }, step: 'Open', note: 'new', sourceSignal: 'signal-1' };
  const addAdapter = {
    toolNames: ['track_add_item'],
    async readPolicyHash() { return trackAdapter.readPolicyHash(); },
    async readTarget(_db: unknown, _input: unknown, memberId: string) {
      return { kind: 'track', id: trackPath, ownerMemberId: memberId,
        fingerprint: payloadFingerprint('tracks-vault-target-v1', content), approvedOrigin: 'agent' };
    },
  };
  const approvedAdd = await approvedExactTrack('track_add_item', add, addAdapter);
  const addProof = { requestId: approvedAdd.authority.requestId, callId: approvedAdd.callId, toolName: approvedAdd.toolName,
    payloadHash: approvedAdd.payloadHash, input: add, target: approvedAdd.target, authority: approvedAdd.authority };
  await expect(runtime('tracks.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: addProof,
    operation: 'track_add_item', input: add })).rejects.toThrow('Vault reader unavailable');
  expect((await pool.query("SELECT used_at FROM approval_asks WHERE call_id='track-call-1'")).rows[0].used_at).toBeNull();
  expect(ids.writes).toBe(0);

  await pool.query('DELETE FROM approval_asks; DELETE FROM console_session_bindings');
  approvalTurnId = 'turn-track-original'; approvalTurnSequence = 30;
  await bindConsoleSession({ agent, incarnation, sessionId: session, memberId: ids.member, admissionNonce }, pool as never, env);
  const move = { home: `vault:${ids.sharedArea}`, trackId: 'other-track', itemId: 'lead-one', step: 'Done', note: 'moved', sourceSignal: 'signal-2' };
  const moveAdapter = {
    toolNames: ['track_move_item'],
    async readPolicyHash() { return trackAdapter.readPolicyHash(); },
    async readTarget(_db: unknown, _input: unknown, memberId: string) {
      return { kind: 'track-item', id: itemPath, ownerMemberId: memberId,
        fingerprint: payloadFingerprint('tracks-vault-target-v1', ids.trackFiles.get(itemPath)?.content ?? null), approvedOrigin: 'agent' };
    },
  };
  const approvedMove = await approvedExactTrack('track_move_item', move, moveAdapter);
  const moveProof = { requestId: approvedMove.authority.requestId, callId: approvedMove.callId, toolName: approvedMove.toolName,
    payloadHash: approvedMove.payloadHash, input: move, target: approvedMove.target, authority: approvedMove.authority };
  await expect(runtime('tracks.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: moveProof,
    operation: 'track_move_item', input: move })).rejects.toThrow('Vault reader unavailable');
  expect((await pool.query("SELECT used_at FROM approval_asks WHERE call_id='track-call-1'")).rows[0].used_at).toBeNull();
  expect(ids.writes).toBe(0);

  await pool.query('DELETE FROM approval_asks; DELETE FROM console_session_bindings');
  await bindConsoleSession({ agent, incarnation, sessionId: session, memberId: ids.member, admissionNonce }, pool as never, env);
  const exactAdd = { ...add, home: `vault:${ids.sharedArea}` };
  const exactAddAdapter = {
    toolNames: ['track_add_item'],
    async readPolicyHash() { return trackAdapter.readPolicyHash(); },
    async readTarget(_db: unknown, _input: unknown, memberId: string) {
      return { kind: 'track', id: trackPath, ownerMemberId: memberId,
        fingerprint: payloadFingerprint('tracks-vault-target-v1', content), approvedOrigin: 'agent' };
    },
  };
  const approvedExactAdd = await approvedExactTrack('track_add_item', exactAdd, exactAddAdapter);
  const exactAddProof = { requestId: approvedExactAdd.authority.requestId, callId: approvedExactAdd.callId,
    toolName: approvedExactAdd.toolName, payloadHash: approvedExactAdd.payloadHash, input: exactAdd,
    target: approvedExactAdd.target, authority: approvedExactAdd.authority };
  const exactResult = await runtime('tracks.write', { sessionId: session, memberId: ids.member, admissionNonce,
    approval: exactAddProof, operation: 'track_add_item', input: exactAdd });
  expect(exactResult.result).toMatchObject({ trackId: 'follow-up', who: { personId: 'person-1' }, step: 'Open' });
  expect((await pool.query("SELECT use_count,used_at FROM approval_asks WHERE call_id='track-call-1'")).rows[0].use_count).toBe(1);
});

it('admits a signed human receipt, opens a non-synthetic turn id, reads through the keeper, and closes once', async () => {
  const { turnId, opened, pendingReceipt } = await openTurn(0);
  await expect(runtime('turn.open', { pendingReceipt, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 0,
    definition: { definition: roleDefinition, dutiesMd, voiceMd, hash: definitionHash } })).rejects.toThrow('Vault reader unavailable');
  expect(opened.turnCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const note = await runtime('vault.read', { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 0, operation: 'read', area: 'private', path: 'owner.md' });
  expect(note.content).toBe('private note content');
  await expect(runtime('vault.read', { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce,
    turnId, sequence: 0, operation: 'list', area: 'shared', home: 'vault:wrong-area' })).rejects.toThrow('Vault reader unavailable');
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
