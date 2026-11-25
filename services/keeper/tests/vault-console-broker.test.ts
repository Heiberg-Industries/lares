import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { quiet } from '../../../packages/agent-kit/tests/helpers/quiet-pool.js';
import { PgGrantStore } from '../../../packages/agent-kit/src/grant-store.js';
import { PgVaultStore } from '../../../packages/agent-kit/src/vault-area-store.js';
import { bindConsoleSession } from '../../../packages/agent-kit/src/console-turn-authority.js';
import { definitionSchema, hashOf } from '../../../packages/agent-kit/src/definition.js';
import { reserveExactApproval, attachExactApproval, approveExactResponse, requireApprovedExecution } from '../../../packages/agent-kit/src/approval-execution.js';
import { recordOutsideExecutionApproval, consumeOutsideExecutionApproval, outsidePayloadHash } from '../../../packages/agent-kit/src/outside-execution-receipts.js';
import { payloadFingerprint } from '../../../packages/agent-kit/src/approval-ledger.js';
import { NoteNotFoundError } from '../../../packages/agent-kit/src/notes-store.js';
import { ENGINE_DATABASE_ROLES, ENGINE_TABLE_PRIVILEGES } from '../../box/lib/database-privileges.js';
import { requestOutsideApproval,respondOutsideApproval,runOutsideTool } from '../../chief-of-staff/lib/outside-tools.js';
import { makeApprovalRecord } from '../../../packages/agent-kit/src/approval-record-hook.js';
import { eveSession } from '../../../packages/agent-kit/tests/helpers/eve-session.js';
import { tracksApprovalAdapter } from '../../chief-of-staff/lib/tracks-approval.js';
import { vaultNoteApprovalAdapter } from '../../chief-of-staff/lib/vault-note-write.js';
import { DOORS, claimEnvNames } from '../../../packages/agent-kit/src/door-kinds.js';
import { approveDoorExactResponse, attachDoorExactApproval, requireDoorApprovedExecution, reserveDoorExactApproval, type DoorExactDeps } from '../../../packages/agent-kit/src/door-exact-approval.js';
import { vaultNoteTargetFingerprint } from '../../../packages/agent-kit/src/vault-note-write.js';
import { setVaultTurnCapability } from '../../chief-of-staff/agent/lib/vault-turn.js';

const ids = vi.hoisted(() => ({
  organisation: 'broker-org', member: 'broker-owner', area: '11111111-1111-4111-8111-111111111111',
  sharedArea: '44444444-4444-4444-8444-444444444444',
  backing: '22222222-2222-4222-8222-222222222222', readGate: undefined as (() => Promise<void>) | undefined, reads: 0, clock: Date.now(),
  inventory: undefined as any, trackFiles: new Map<string, { content: string; contentRevision: string }>(), writes: 0, lastBinding: undefined as any, useRealFiles: false, outsideDispatch: vi.fn(), outsideTools: vi.fn(), outsideApprove:vi.fn(),
}));
// This file calls the outside-tool approval policy directly, outside any eve session. In the agent eve
// runs it inside the session, where Lares's per-session marks (which turn applied an answer to a card,
// services/chief-of-staff/lib/approval-card-turns.ts) are readable; outside one, reading them throws and
// the rule that refuses a new outward action in the reply to an answered request fails closed. So, as in
// the agent's own tests, those `lares.` states are held in memory here (empty: no answer was applied).
// Keeper has no `eve` dependency of its own, so the module is named by the file the agent's code loads
// for `eve/context` (the package's `./context` export); a bare `eve/context` here would mock nothing.
const eveState = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../chief-of-staff/node_modules/eve/dist/src/public/context/index.js', async (original) => {
  const real = await original<Record<string, unknown>>();
  return { ...real, defineState: (key: string, initial: () => unknown) => !key.startsWith('lares.')
    ? (real.defineState as (k: string, i: () => unknown) => unknown)(key, initial)
    : { get: () => (eveState.has(key) ? eveState.get(key) : initial()),
        update: (fn: (v: unknown) => unknown) => { eveState.set(key, fn(eveState.has(key) ? eveState.get(key) : initial())); } } };
});
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
      if (/^(tracks|_meta|_inbox|reads|inspiration|writing-seeds|articles)\/|\/transcripts\//.test(path)) throw new NoteNotFoundError(path);
      return { path, content: 'private note content', lines: 1, contentRevision: 'fixture', companion: null };
    }
    async listPage(ctx: unknown, request: any, reader: any) {
      if (this.delegate) return (this.delegate as any).listPage(ctx, request, reader);
      const { notePage, visibleTo } = await import('../../../packages/agent-kit/src/notes-store.js');
      const inFolder = notePage(['owner.md', ...ids.trackFiles.keys()], { folder: request.folder, limit: Number.MAX_SAFE_INTEGER }).paths;
      return notePage(inFolder.filter(path => visibleTo(ids.trackFiles.get(path)?.content ?? 'private note content', reader)), { cursor: request.cursor, limit: request.limit });
    }
    async search(ctx: unknown, query: string, reader: unknown) { if (this.delegate) return (this.delegate as any).search(ctx, query, reader); return { hits: [], files: 0 }; }
    async listUnder(ctx: unknown, dir: string) { if (this.delegate) return (this.delegate as any).listUnder(ctx, dir); const prefix = dir.replace(/\/+$/, '') + '/'; const paths = [...ids.trackFiles.keys()].filter(p => p.startsWith(prefix)); return { paths, files: paths.length }; }
    async remove(ctx: unknown, input: { binding: { relativePath: string } }, ...rest: unknown[]) { if (this.delegate) return (this.delegate as any).remove(ctx, input, ...rest); ids.lastBinding = input.binding; ids.trackFiles.delete(input.binding.relativePath); return { commit: 'removed' }; }
    async move(ctx: unknown, input: { binding: { relativePath: string }; destination: string }, ...rest: unknown[]) {
      if (this.delegate) return (this.delegate as any).move(ctx, input, ...rest);
      const from = ids.trackFiles.get(input.binding.relativePath); if (!from) throw new NoteNotFoundError(input.binding.relativePath);
      ids.lastBinding = input.binding; ids.trackFiles.delete(input.binding.relativePath);
      ids.trackFiles.set(input.destination, { content: from.content, contentRevision: String(++ids.writes).padStart(64, '0') });
      return { commit: `moved-${ids.writes}` };
    }
    async writeVerbatim(_ctx: unknown, input: { binding: { relativePath: string; expectedContentRevision: string | null }; content: string }, ...rest: unknown[]) {
      if (this.delegate) return (this.delegate as any).writeVerbatim(_ctx, input, ...rest);
      const prior = ids.trackFiles.get(input.binding.relativePath);
      if ((prior?.contentRevision ?? null) !== input.binding.expectedContentRevision) throw new Error('stale fixture content');
      ids.lastBinding = input.binding;
      ids.trackFiles.set(input.binding.relativePath, { content: input.content, contentRevision: String(++ids.writes).padStart(64, '0') });
      return { commit: `verbatim-${ids.writes}` };
    }
    async write(_ctx: unknown, input: { binding: { relativePath: string; expectedContentRevision: string | null }; frontmatter: Record<string, unknown>; body: string }, ...rest: unknown[]) {
      if (this.delegate) return (this.delegate as any).write(_ctx, input, ...rest);
      const prior = ids.trackFiles.get(input.binding.relativePath);
      if ((prior?.contentRevision ?? null) !== input.binding.expectedContentRevision) throw new Error('stale fixture content');
      ids.lastBinding = input.binding;
      const fields = Object.entries(input.frontmatter).map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.join(', ')}]` : value}`).join('\n');
      ids.trackFiles.set(input.binding.relativePath, { content: `---\n${fields}\n---\n${input.body}`, contentRevision: String(++ids.writes).padStart(64, '0') });
      return { commit: `commit-${ids.writes}` };
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

async function startBroker(database:Pool=pool){
  const secrets=join(root,'secrets');
  const { serveConsoleVaultBroker } = await import('../lib/vault-console-broker.js');
  return serveConsoleVaultBroker(database as never, join(root, 'secrets', 'console-vault-signing-key'), secrets, process.env.LARES_VAULT_RUNTIME_SOCKET!, {
    designatedOwnerId: ids.member, consoleSocket: process.env.LARES_VAULT_CONSOLE_SOCKET,
    rootUid: process.getuid?.() ?? 0, socketUid: process.getuid?.() ?? 0, socketGid: process.getgid?.() ?? 0, turnClockForTests: () => ids.clock,
    outsideCustody:{approveExecution:(...args)=>ids.outsideApprove(...args),acceptedRuntimeTools:(...args)=>ids.outsideTools(...args),dispatchApproved:(...args)=>ids.outsideDispatch(...args)},
    vaultFilesForTests: { root: join(root, 'vault-files'), originRoot: join(root, 'vault-origins') },
  });
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
  stopBroker = await startBroker();
}, 120_000);

afterAll(async () => {
  ids.readGate = undefined;
  await stopBroker?.(); await pool?.end(); await container?.stop(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});

beforeEach(async () => {
  ids.trackFiles.clear(); ids.writes = 0; ids.outsideDispatch.mockReset();ids.outsideTools.mockReset();ids.outsideApprove.mockReset();
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
    CREATE TABLE outside_tool_pins(agent text NOT NULL,tool text NOT NULL,config_hash text NOT NULL,pin_hash text NOT NULL,pin_tools jsonb,seen_hash text,seen_tools jsonb,seen_at timestamptz,pinned_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(agent,tool));
    CREATE TABLE repairs(kind text NOT NULL,ref text NOT NULL,severity text NOT NULL,what text NOT NULL,how_to_fix text,breaks_in text,opened_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,PRIMARY KEY(kind,ref));
    CREATE TABLE keeper_audit(id bigserial PRIMARY KEY,operation_id uuid,action text NOT NULL,actor text NOT NULL,input jsonb NOT NULL DEFAULT '{}'::jsonb,outcome text NOT NULL,detail text,at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);
    CREATE TABLE ratchet(agent text,capability text,action text,level text,updated_by text NOT NULL DEFAULT 'fixture',updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE ratchet_audit(id bigserial PRIMARY KEY,agent text NOT NULL,capability text NOT NULL,action text NOT NULL,
      old_level text,new_level text,changed_by text NOT NULL,at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE outside_execution_approvals(call_id text PRIMARY KEY,request_id text,session_id text,member_id text,approver_member_id text,
      agent text,incarnation uuid,definition_hash bytea,connection_name text,account_id uuid,credential_revision bigint,
      tool_name text,payload_hash bytea,expires_at timestamptz,consumed_at timestamptz);
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
  // Use the production audit trigger, so policy restoration tests exercise durable revision history.
  const baseline=readFileSync(new URL('../../../services/box/sql/001_baseline.sql',import.meta.url),'utf8');
  const auditFunction=baseline.match(/CREATE FUNCTION ratchet_audit_fn\(\) RETURNS trigger[\s\S]*?\$\$;/)?.[0];
  if(!auditFunction)throw new Error('Production ratchet audit trigger is unavailable');
  await pool.query(auditFunction);
  await pool.query('CREATE TRIGGER ratchet_audit_trg AFTER INSERT OR DELETE OR UPDATE ON ratchet FOR EACH ROW EXECUTE FUNCTION ratchet_audit_fn()');
  for (const file of ['006_approval_session.sql','007_member_identity_sessions.sql','009_vault_areas.sql','013_console_turn_authority.sql','014_agent_access_grants.sql','015_exact_approval_execution.sql','016_console_agent_access_capture.sql','017_private_console_surface_capture.sql','018_private_account_history.sql','020_vault_resource_grants.sql','022_console_vault_source_history.sql','038_approval_card_record.sql'])
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
  attributes: { user_id: ids.member, lares_member_id: ids.member, lares_admission_nonce: admissionNonce, lares_purpose: purpose,
    ...(purpose === 'resolver' ? { lares_resume_request_id: 'track-request-1', lares_resume_option: 'approve' } : {}) } });
const answeredAuth = (requestId: string) => { const auth = memberAuth('resolver'); return { ...auth, attributes: { ...auth.attributes, lares_resume_request_id: requestId } }; };
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

// eve 1.0: an approved call runs as the person who ASKED (`session.auth.current` stays the human requester);
// the person who answered is only `approval.responder`, present on the resumed ('resolver') call.
function approvalContext(purpose: 'human'|'resolver', raw: unknown = trackInput, toolName = 'track_create') {
  const current = memberAuth('human');
  return { callId: 'track-call-1', toolName, toolInput: raw, abortSignal: new AbortController().signal,
    ...(purpose === 'resolver' ? { approval: { responder: memberAuth('resolver') } } : {}), session: { id: session, turn: { id: purpose === 'human' ? approvalTurnId : 'turn-track-resolver', sequence: purpose === 'human' ? approvalTurnSequence : approvalTurnSequence + 1 },
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
  await approveExactResponse({ request: { interactionId: 'track-request-1', callId: 'track-call-1', toolName: operation, toolInput: input },
    response: { decision: 'approve', principal: answeredAuth('track-request-1') }, session: { id: session, initiator: memberAuth('human'), turn: { id: 'turn-track-resolver', sequence: 31 } } },
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

async function realAreasAndTurn() {
  const vaultRoot = join(root, 'vault-files'), originRoot = join(root, 'vault-origins');
  await rm(vaultRoot, { recursive: true, force: true }); await rm(originRoot, { recursive: true, force: true });
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
  return { notePath: join(vaultRoot, `vault/private/${ids.area}/_inbox/oslo.md`), privateOrigin: join(originRoot, `${ids.area}.git`), turn };
}
const noteInput = { area: 'private', title: 'Oslo', body: 'Trip to Oslo Wednesday' };
const noteProof = (approved: any, input: unknown = noteInput) => ({ requestId: approved.authority.requestId, callId: approved.callId, toolName: approved.toolName,
  payloadHash: approved.payloadHash, input, target: approved.target, authority: approved.authority });
const noteUses = async () => (await pool.query("SELECT use_count FROM approval_asks WHERE call_id='track-call-1'")).rows[0].use_count;

it('writes one approved private note through Keeper and the real writer, once', async () => {
  const { notePath, privateOrigin } = await realAreasAndTurn();
  const approved = await approvedExactTrack('agent-kit__vault_write', noteInput, vaultNoteApprovalAdapter);
  expect(approved.target).toMatchObject({ kind: 'vault-note', id: '_inbox/oslo.md', ownerMemberId: ids.member });
  const proof = noteProof(approved);
  await expect(runtime('vault.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: proof,
    input: { ...noteInput, body: 'Changed after approval' } })).rejects.toThrow('Vault reader unavailable');
  await expect(runtime('vault.write', { sessionId: session, memberId: 'member-b', admissionNonce, approval: proof, input: noteInput })).rejects.toThrow('Vault reader unavailable');
  expect(await noteUses()).toBe(0);
  const result = await runtime('vault.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: proof, input: noteInput });
  expect(result.path).toBe('_inbox/oslo.md');
  const content = readFileSync(notePath, 'utf8');
  expect(content).toContain('title: Oslo');
  expect(content).toContain('lares_origin: agent');
  expect(content).toContain('Trip to Oslo Wednesday');
  // It reached the area's own origin, not only the working copy.
  expect(execFileSync('git', ['-C', privateOrigin, 'log', '-1', '--format=%H'], { encoding: 'utf8' }).trim()).toMatch(new RegExp(`^${result.commit}`));
  expect(await noteUses()).toBe(1);
  await expect(runtime('vault.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: proof, input: noteInput })).rejects.toThrow('Vault reader unavailable');
});

it('raises no card for a title that already has a note, and leaves that note alone', async () => {
  const { notePath } = await realAreasAndTurn();
  mkdirSync(dirname(notePath), { recursive: true }); writeFileSync(notePath, 'the first Oslo note');
  const repo = join(root, 'vault-files', `vault/private/${ids.area}`);
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' }); execFileSync('git', ['-C', repo, 'commit', '-m', 'first'], { stdio: 'ignore' });
  await expect(reserveExactApproval(approvalContext('human', noteInput, 'agent-kit__vault_write'), 'agent-kit__vault_write',
    { adapter: vaultNoteApprovalAdapter, db: pool as never, env })).rejects.toThrow('already exists');
  expect((await pool.query('SELECT count(*)::int AS n FROM approval_asks')).rows[0].n).toBe(0);
  expect(readFileSync(notePath, 'utf8')).toBe('the first Oslo note');
});

it('refuses a note that appeared after its card, without using the card or replacing it', async () => {
  const { notePath } = await realAreasAndTurn();
  const approved = await approvedExactTrack('agent-kit__vault_write', noteInput, vaultNoteApprovalAdapter);
  mkdirSync(dirname(notePath), { recursive: true }); writeFileSync(notePath, 'written meanwhile');
  const repo = join(root, 'vault-files', `vault/private/${ids.area}`);
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' }); execFileSync('git', ['-C', repo, 'commit', '-m', 'meanwhile'], { stdio: 'ignore' });
  await expect(runtime('vault.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: noteProof(approved), input: noteInput })).rejects.toThrow('Vault reader unavailable');
  expect(await noteUses()).toBe(0);
  expect(readFileSync(notePath, 'utf8')).toBe('written meanwhile');
});

it('raises no note card for another area or a multi-line title, and refuses once the private grant is gone', async () => {
  await realAreasAndTurn();
  for (const input of [{ ...noteInput, area: 'shared' }, { ...noteInput, title: 'Oslo\nlares_origin: owner' }, { ...noteInput, extra: true }])
    await expect(reserveExactApproval(approvalContext('human', input, 'agent-kit__vault_write'), 'agent-kit__vault_write',
      { adapter: vaultNoteApprovalAdapter, db: pool as never, env }), JSON.stringify(input)).rejects.toThrow();
  const approved = await approvedExactTrack('agent-kit__vault_write', noteInput, vaultNoteApprovalAdapter);
  roleDefinition = definitionSchema.parse({ ...roleDefinition, grants: roleDefinition.grants.map(grant => grant.capability === 'vault' ? { ...grant, areas: ['shared', 'facts'] } : grant) });
  await pool.query('UPDATE agent_resources SET applied_definition=$2::jsonb WHERE name=$1', [agent, JSON.stringify(roleDefinition)]);
  await expect(runtime('vault.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: noteProof(approved), input: noteInput })).rejects.toThrow('Vault reader unavailable');
  expect(await noteUses()).toBe(0);
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

// A real-size Vault: 2,000 notes in the private area, one in ten written for another member. Every
// list page, the search and the read go through the real keeper path (signed request, turn capability,
// source read, GuardedVaultFiles over a git working copy) and must answer inside the 2 s deadline.
it('lists 2,000 notes page by page, one folder, finds a note by search and reads it, each inside the deadline (measured)', async () => {
  const { turn } = await realAreasAndTurn();
  const privateRoot = join(root, 'vault-files', `vault/private/${ids.area}`), sharedRoot = join(root, 'vault-files', `vault/shared/${ids.sharedArea}`);
  const folders = ['projects', 'people', 'daily/2026', 'reading'], visible = new Set<string>(), hidden = new Set<string>();
  const filler = 'Notes from a working week: what was decided, who said what, and the next step. '.repeat(20);
  for (let i = 0; i < 2000; i++) {
    const folder = folders[i % folders.length]!, path = `${folder}/note-${String(i).padStart(4, '0')}.md`, other = i % 10 === 7;
    const head = other ? '---\nscope: private\nowner: member-backup\n---\n' : '';
    const word = i === 1234 || i === 1237 ? 'zanzibarquokka ' : '';
    mkdirSync(join(privateRoot, folder), { recursive: true });
    writeFileSync(join(privateRoot, path), `${head}# Note ${i}\n\n${word}${filler}\n`);
    (other ? hidden : visible).add(path);
  }
  mkdirSync(join(privateRoot, '_meta/conversations'), { recursive: true });
  writeFileSync(join(privateRoot, '_meta/conversations/log.md'), 'a conversation log, never listed');
  mkdirSync(join(sharedRoot, 'ventures'), { recursive: true });
  writeFileSync(join(sharedRoot, 'ventures/harbor.md'), '# Harbor\n\nThe harbor venture, positioning and buyers.\n');
  for (const repo of [privateRoot, sharedRoot]) {
    execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' }); execFileSync('git', ['-C', repo, 'commit', '-m', 'notes'], { stdio: 'ignore' });
  }
  const call = (input: Record<string, unknown>) => runtime('vault.read', { turnCapability: turn.opened.turnCapability, sessionId: session, memberId: ids.member,
    admissionNonce, turnId: turn.turnId, sequence: approvalTurnSequence, ...input });
  const timed = async (input: Record<string, unknown>) => { const started = performance.now(); const result = await call(input); return { result, ms: performance.now() - started }; };

  // The cursor counts only notes the reader may see: 1,800 visible notes are exactly 9 full pages, every
  // page but none of them short, and the cursors are 200, 400, ... 1600 whatever is hidden between them.
  const listed: string[] = [], pageMs: number[] = [], cursors: number[] = [];
  let cursor: number | undefined, pages = 0;
  do {
    const { result, ms } = await timed({ operation: 'list', area: 'private', ...(cursor !== undefined ? { cursor } : {}) });
    pageMs.push(ms); listed.push(...result.notes); cursor = result.nextCursor; pages++;
    if (cursor !== undefined) cursors.push(cursor);
    expect(result.notes.length).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024);
  } while (cursor !== undefined && pages < 50);
  expect(pages).toBe(9);
  expect(cursors).toEqual([200, 400, 600, 800, 1000, 1200, 1400, 1600]);
  expect(listed.length).toBe(visible.size);
  expect(new Set(listed).size).toBe(listed.length);
  expect([...listed].sort()).toEqual([...visible].sort());
  expect(listed.filter(path => hidden.has(path) || path.startsWith('_meta/'))).toEqual([]);

  const people: string[] = [], folderMs: number[] = [];
  cursor = undefined;
  do {
    const { result, ms } = await timed({ operation: 'list', area: 'private', folder: 'people', ...(cursor !== undefined ? { cursor } : {}) });
    folderMs.push(ms); people.push(...result.notes); cursor = result.nextCursor;
  } while (cursor !== undefined && folderMs.length < 10);
  // 500 people notes, 100 of them hidden: 400 visible, so 2 full pages.
  expect(folderMs.length).toBe(2);
  expect(people).toHaveLength(400);
  expect(people).toEqual([...visible].filter(path => path.startsWith('people/')).sort());
  expect((await call({ operation: 'list', area: 'private', folder: '_meta' })).notes).toEqual([]);

  const { result: found, ms: searchMs } = await timed({ operation: 'search', area: 'private', q: 'zanzibarquokka' });
  // note-1237 holds the word too, but it is another member's note: never returned.
  expect(found.hits).toEqual(['daily/2026/note-1234.md']);
  // The number of notes searched counts only the 1,800 the reader may see.
  expect(found.files).toBe(1800);
  const { result: broad, ms: broadMs } = await timed({ operation: 'search', area: 'private', q: 'working week' });
  expect(broad.hits.length).toBe(50); expect(broad.more).toBe(true);
  expect(broad.hits.filter((path: string) => hidden.has(path))).toEqual([]);
  const { result: read, ms: readMs } = await timed({ operation: 'read', area: 'private', path: found.hits[0] });
  expect(read.content).toContain('zanzibarquokka');
  expect((await call({ operation: 'search', area: 'shared', q: 'harbor buyers' })).hits).toEqual(['ventures/harbor.md']);

  console.log(`2,000-note private area through keeper: list pages ${pageMs.map(ms => ms.toFixed(0)).join(', ')} ms; ` +
    `folder pages ${folderMs.map(ms => ms.toFixed(0)).join(', ')} ms; search one note ${searchMs.toFixed(0)} ms; broad search ${broadMs.toFixed(0)} ms; read ${readMs.toFixed(0)} ms (client deadline 2000 ms, keeper 1700 ms)`);
  for (const ms of [...pageMs, ...folderMs, searchMs, broadMs, readMs]) expect(ms).toBeLessThan(2000);
}, 120_000);

// A list page reads each note by the path the walk just returned, without a second path check, so the walk's
// own refusals must still hold for the listed folder: a symlink, a hard link or a nested repository in it
// refuses the whole page, and none of their text comes back.
it('refuses a list whose folder holds a symlinked note, a hard-linked note or a nested repository, and returns none of their text', async () => {
  const { turn } = await realAreasAndTurn();
  const privateRoot = join(root, 'vault-files', `vault/private/${ids.area}`), outside = join(root, 'outside-secret.md');
  writeFileSync(outside, 'OUTSIDE_SECRET');
  mkdirSync(join(privateRoot, 'people'), { recursive: true });
  writeFileSync(join(privateRoot, 'people/vera.md'), '# Vera\n');
  execFileSync('git', ['-C', privateRoot, 'add', '.'], { stdio: 'ignore' }); execFileSync('git', ['-C', privateRoot, 'commit', '-m', 'vera'], { stdio: 'ignore' });
  const list = () => runtime('vault.read', { turnCapability: turn.opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce,
    turnId: turn.turnId, sequence: approvalTurnSequence, operation: 'list', area: 'private', folder: 'people' });
  expect(await list()).toEqual({ ok: true, notes: ['people/vera.md'] });
  const cases: Array<[string, () => void, () => void]> = [
    ['symlinked note', () => symlinkSync(outside, join(privateRoot, 'people/link.md')), () => rmSync(join(privateRoot, 'people/link.md'))],
    ['hard-linked note', () => linkSync(outside, join(privateRoot, 'people/hard.md')), () => rmSync(join(privateRoot, 'people/hard.md'))],
    ['nested repository', () => { const inner = join(privateRoot, 'people/inner'); mkdirSync(inner); execFileSync('git', ['init', inner], { stdio: 'ignore' });
      writeFileSync(join(inner, 'other.md'), 'OUTSIDE_SECRET'); }, () => rmSync(join(privateRoot, 'people/inner'), { recursive: true, force: true })],
  ];
  for (const [name, make, undo] of cases) {
    make();
    let answer: unknown;
    try { answer = await list(); } catch (error) { answer = (error as Error).message; }
    expect(String(answer), name).toMatch(/^Vault reader unavailable/);
    expect(JSON.stringify(answer), name).not.toContain('OUTSIDE_SECRET');
    undo();
    expect(await list(), `${name} removed`).toEqual({ ok: true, notes: ['people/vera.md'] });
  }
});

it('refuses a list cursor or folder that is not a page position or a folder, and a search without words', async () => {
  const { turnId, opened } = await openTurn(0);
  const base = { turnCapability: opened.turnCapability, sessionId: session, memberId: ids.member, admissionNonce, turnId, sequence: 0, area: 'private' };
  for (const input of [{ operation: 'list', cursor: -1 }, { operation: 'list', cursor: 'owner.md' }, { operation: 'list', folder: 7 }, { operation: 'list', folder: 'x'.repeat(513) },
    { operation: 'read', path: 'owner.md', cursor: 0 }, { operation: 'search' }, { operation: 'search', q: '' }, { operation: 'search', q: 'x'.repeat(1001) }, { operation: 'list', q: 'x' }])
    await expect(runtime('vault.read', { ...base, ...input }), JSON.stringify(input)).rejects.toThrow('Vault reader unavailable (the keeper refused: read)');
  expect(await runtime('vault.read', { ...base, operation: 'list' })).toEqual({ ok: true, notes: ['owner.md'] });
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

it('reads accepted metadata through the signed broker only for the current private session',async()=>{
 ids.outsideTools.mockResolvedValue([{name:'lookup',inputSchema:{type:'object'}}]);
 const input={sessionId:session,memberId:ids.member,admissionNonce,connectionName:'registry'};
 expect(await runtime('outside.tools',input)).toMatchObject({tools:[{name:'lookup'}]});
 expect(ids.outsideTools).toHaveBeenCalledWith({agent,incarnation,sessionId:session,memberId:ids.member,approverMemberId:ids.member,
  admissionNonce,policyRevision:2},definitionHash,'registry',expect.objectContaining({deadlineAtMs:expect.any(Number)}));
 ids.outsideTools.mockClear();
 for(const changed of [{memberId:'another-member'},{sessionId:'another-session'},{admissionNonce:'f'.repeat(43)}])
  await expect(runtime('outside.tools',{...input,...changed})).rejects.toThrow();
 expect(ids.outsideTools).not.toHaveBeenCalled();
});

it('executes through the real application-role pool while that role cannot read custody receipts',async()=>{
 const role=ENGINE_DATABASE_ROLES.application,password=randomUUID();
 await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
 await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
 const tables=await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
 const ordinary=new Set<string>(ENGINE_TABLE_PRIVILEGES.ordinary);
 for(const {tablename} of tables.rows)if(ordinary.has(tablename))
  await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.${tablename} TO ${role}`);
 const url=new URL(container.getConnectionUri());url.username=role;url.password=password;
 const application=quiet(new Pool({connectionString:url.href,max:2}));
 const custodyRole=ENGINE_DATABASE_ROLES.outsideCustody;
 await pool.query(`CREATE ROLE ${custodyRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
 await pool.query(`GRANT USAGE ON SCHEMA public TO ${custodyRole}`);
 await pool.query(`GRANT SELECT,INSERT ON outside_execution_approvals TO ${custodyRole}`);
 await pool.query(`GRANT UPDATE(consumed_at) ON outside_execution_approvals TO ${custodyRole}`);
 const custodyUrl=new URL(container.getConnectionUri());custodyUrl.username=custodyRole;custodyUrl.password=password;
 const custody=quiet(new Pool({connectionString:custodyUrl.href,max:2}));
 try{
  expect((await application.query('SELECT current_user AS role')).rows[0].role).toBe(role);
  expect((await application.query("SELECT has_table_privilege(current_user,'public.outside_execution_approvals','SELECT') AS allowed")).rows[0].allowed).toBe(false);
  await expect(application.query('SELECT call_id FROM outside_execution_approvals')).rejects.toMatchObject({code:'42501'});
  await stopBroker?.();stopBroker=undefined;stopBroker=await startBroker(application);
  const exact=await exactOutsideFixture({receipts:custody});
  expect(await exact.tool.execute(exact.input,exact.resumed)).toEqual({content:[{type:'text',text:'Fixture result'}]});
  expect(ids.outsideApprove).toHaveBeenCalledOnce();expect(ids.outsideDispatch).toHaveBeenCalledOnce();
  await expect(exact.tool.execute(exact.input,exact.resumed)).rejects.toThrow();
  await expect(custody.query('SELECT * FROM approval_asks')).rejects.toMatchObject({code:'42501'});
  expect((await application.query("SELECT has_table_privilege(current_user,'public.outside_execution_approvals','SELECT') AS allowed")).rows[0].allowed).toBe(false);
 }finally{
  await stopBroker?.();stopBroker=undefined;await application.end();await custody.end();stopBroker=await startBroker();
 }
});

/** Real exact asks and durable tool phases; only the custody/provider boundary is substituted. */
async function exactOutsideFixture(options:{answer?:boolean;receipts?:Pool}={}){
 const receipts=options.receipts??pool;
 roleDefinition=definitionSchema.parse({...defaultRoleDefinition,
  grants:[...defaultRoleDefinition.grants,{capability:'outside',scope:'read'}],autonomy:{...defaultRoleDefinition.autonomy,outside:'gated'},
  outsideTools:[{name:'registry',url:'https://tools.example.org/mcp',description:'Lookup',token:true,tools:{allow:['lookup'],read:['lookup']}}]});
 definitionHash=hashOf({definition:roleDefinition,dutiesMd,voiceMd});
 session='outside_'+randomUUID().replaceAll('-','');admissionNonce=createHash('sha256').update(randomUUID()).digest('base64url');
 await pool.query("UPDATE agent_definitions SET definition=$1,hash=$2 WHERE name=$3",[roleDefinition,definitionHash,agent]);
 await pool.query('UPDATE agent_resources SET applied_definition=$1 WHERE name=$2',[roleDefinition,agent]);
 expect(await new PgGrantStore(pool).captureUse(ids.member,agent)).toBeDefined();
 await bindConsoleSession({agent,incarnation,sessionId:session,memberId:ids.member,admissionNonce},pool as never,env);
 const {resolveOutsideTools}=await import('../../../packages/agent-kit/src/outside-connections.js');
 const tools=await resolveOutsideTools(roleDefinition,{acceptedTools:async()=>[{name:'lookup',inputSchema:{type:'object'}}],
  approval:(connection,tool)=>({request:ctx=>requestOutsideApproval(connection,tool,ctx),response:ctx=>respondOutsideApproval(connection,tool,ctx)}),
  executor:(connection,tool)=>(input,ctx)=>runOutsideTool(connection,tool,input,ctx)});
 const tool=tools!['registry__lookup']! as any,input={company:'Example'},call={callId:randomUUID(),connectionName:'registry',toolName:'lookup',input};
 const toolName='registry__lookup',requestId=randomUUID(),human=memberAuth('human'),resolver=answeredAuth(requestId);
 const {turnId,opened}=await openTurn(80);
 const context={callId:call.callId,toolName,toolInput:input,session:{id:session,turn:{id:turnId,sequence:80},auth:{current:human,initiator:human}}};
 expect(await tool.approval.request(context)).toBe('user-approval');
 // eve 1.0 names the card on `interaction.opened`; the tool and its input come from the session view.
 const eve=eveSession();eve.call(call.callId,toolName,input);
 await makeApprovalRecord()['interaction.opened'](eve.open(requestId,call.callId),{...context,view:eve.view} as never);
 await runtime('turn.close',{turnCapability:opened.turnCapability,turnId,sequence:80});
 const response={request:{interactionId:requestId,callId:call.callId,toolName,toolInput:input},response:{decision:'approve' as const,principal:resolver},
  session:{id:session,initiator:human,turn:{id:'answer-turn',sequence:81}}};
 // The resumed call runs as the requester; the answerer is `approval.responder`.
 const resumed={...context,approval:{responder:resolver},session:{...context.session,turn:{id:'answer-turn',sequence:81},auth:{current:human,initiator:human}}};
 if(options.answer!==false)expect(await tool.approval.response(response)).toEqual({status:'allowed'});
 const binding={sessionId:session,memberId:ids.member,admissionNonce};
 // Keep the receipt strictly secret-free: the production recorder rejects unknown keys.
 ids.outsideApprove.mockImplementation(async(binding,requested,approved,deadline)=>{
  deadline.assertCurrent();await recordOutsideExecutionApproval(receipts,{callId:requested.callId,requestId:approved.requestId,
   agent:binding.agent,incarnation:binding.incarnation,sessionId:binding.sessionId,memberId:binding.memberId,
   approverMemberId:binding.approverMemberId,definitionHash:approved.definitionHash,connectionName:requested.connectionName,
   accountId:'55555555-5555-4555-8555-555555555555',credentialRevision:1,toolName:requested.toolName,
   payloadHash:outsidePayloadHash(requested.toolName,requested.input),expiresAt:approved.expiresAt});
 });
 ids.outsideDispatch.mockImplementation(async(binding,requested,deadline)=>{
  deadline.assertCurrent();const row=(await receipts.query('SELECT request_id FROM outside_execution_approvals WHERE call_id=$1',[requested.callId])).rows[0];
  await consumeOutsideExecutionApproval(receipts,{callId:requested.callId,requestId:row.request_id,
   agent:binding.agent,incarnation:binding.incarnation,sessionId:binding.sessionId,memberId:binding.memberId,
   approverMemberId:binding.approverMemberId,definitionHash,connectionName:requested.connectionName,
   accountId:'55555555-5555-4555-8555-555555555555',credentialRevision:1,toolName:requested.toolName,
   payloadHash:outsidePayloadHash(requested.toolName,requested.input)});
  return {content:[{type:'text',text:'Fixture result'}]};
 });
 return {tool,input,call,binding,response,resumed,context,eve};
}
it('resumes the real outside tool after original turn closure exactly once under concurrent responses',async()=>{
 const f=await exactOutsideFixture();
 const results=await Promise.allSettled([f.tool.execute(f.input,f.resumed),f.tool.execute(f.input,f.resumed)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(ids.outsideApprove).toHaveBeenCalledOnce();expect(ids.outsideDispatch).toHaveBeenCalledOnce();
 await expect(f.tool.execute(f.input,f.resumed)).rejects.toThrow();expect(ids.outsideDispatch).toHaveBeenCalledOnce();
 expect((await pool.query('SELECT use_count FROM approval_asks WHERE call_id=$1',[f.call.callId])).rows[0].use_count).toBe(1);
});
it.each(['rejection','different-responder','changed-payload','changed-member','changed-session','revocation','expiry','human-resume'])(
 'outside tool refuses %s before custody/provider',async(kind)=>{
 const f=await exactOutsideFixture({answer:kind!=='rejection'&&kind!=='different-responder'});
 let ctx:any=f.resumed,input=f.input;
 if(kind==='rejection')await makeApprovalRecord()['interaction.settled'](f.eve.settle(f.response.request.interactionId,'declined','deny'),{...f.resumed,view:f.eve.view} as never);
 if(kind==='different-responder'){
  await expect(f.tool.approval.response({...f.response,response:{...f.response.response,principal:{...memberAuth('resolver'),attributes:{...memberAuth('resolver').attributes,lares_member_id:'member-backup'}}}})).rejects.toThrow();
 }
 if(kind==='changed-payload')input={company:'Changed'};
 if(kind==='changed-member')ctx={...ctx,approval:{responder:{...memberAuth('resolver'),attributes:{...memberAuth('resolver').attributes,lares_member_id:'member-backup'}}}};
 if(kind==='changed-session')ctx={...ctx,session:{...ctx.session,id:'another-session'}};
 if(kind==='revocation')await pool.query('UPDATE console_session_bindings SET revoked_at=clock_timestamp() WHERE session_id=$1',[session]);
 if(kind==='human-resume')ctx=f.context;
 if(kind==='expiry'){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+25*60*60_000);}
 try{await expect(f.tool.execute(input,ctx)).rejects.toThrow();}
 finally{vi.useRealTimers();}
 expect(ids.outsideApprove).not.toHaveBeenCalled();expect(ids.outsideDispatch).not.toHaveBeenCalled();
});
it('the exact-call handle cannot read Vault/open a turn, and altered calls consume it without dispatch',async()=>{
 const f=await exactOutsideFixture(),approved=await runtime('outside.approve',{...f.binding,call:f.call});
 await expect(runtime('vault.read',{...f.binding,turnCapability:approved.outsideCapability,turnId:'answer-turn',sequence:81,operation:'read',area:'private',path:'owner.md'})).rejects.toThrow();
 await expect(runtime('turn.open',{pendingReceipt:approved.outsideCapability,...f.binding,turnId:'answer-turn',sequence:81,definition:{definition:roleDefinition,dutiesMd,voiceMd,hash:definitionHash}})).rejects.toThrow();
 await expect(runtime('outside.execute',{...f.binding,...approved,call:{...f.call,input:{company:'Changed'}}})).rejects.toThrow();
 await expect(runtime('outside.execute',{...f.binding,...approved,call:f.call})).rejects.toThrow();
 expect(ids.outsideDispatch).not.toHaveBeenCalled();
});
it('a lost receipt response or broker restart cannot regrant a claimed ask',async()=>{
 const f=await exactOutsideFixture();ids.outsideApprove.mockRejectedValueOnce(new Error('uncertain receipt outcome'));
 await expect(runtime('outside.approve',{...f.binding,call:f.call})).rejects.toThrow();
 await stopBroker?.();stopBroker=await startBroker();
 await expect(runtime('outside.approve',{...f.binding,call:f.call})).rejects.toThrow();
 expect(ids.outsideApprove).toHaveBeenCalledOnce();expect(ids.outsideDispatch).not.toHaveBeenCalled();
});
it('capability expiry refuses before provider dispatch',async()=>{
 const f=await exactOutsideFixture(),approved=await runtime('outside.approve',{...f.binding,call:f.call});
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+61_000);
 try{await expect(runtime('outside.execute',{...f.binding,...approved,call:f.call})).rejects.toThrow();}
 finally{vi.useRealTimers();}
 expect(ids.outsideDispatch).not.toHaveBeenCalled();
});

it.each(['session-revoked','approval-cancelled','policy-changed','wrong-member','wrong-payload','old-turn-fallback'])(
 'an issued handle refuses %s before provider dispatch',async(kind)=>{
 const f=await exactOutsideFixture(),approved=await runtime('outside.approve',{...f.binding,call:f.call});
 if(kind==='session-revoked')await pool.query('UPDATE console_session_bindings SET revoked_at=clock_timestamp() WHERE session_id=$1',[session]);
 if(kind==='approval-cancelled')await makeApprovalRecord()['interaction.settled'](f.eve.settle(f.response.request.interactionId,'declined','deny'),{...f.resumed,view:f.eve.view} as never);
 if(kind==='policy-changed')await pool.query("INSERT INTO ratchet(agent,capability,action,level) VALUES($1,'outside','','never')",[agent]);
 const request={...f.binding,...approved,call:f.call};
 if(kind==='wrong-member')request.memberId='member-backup';
 if(kind==='wrong-payload')request.call={...f.call,input:{company:'Changed'}};
 if(kind==='old-turn-fallback'){delete request.outsideCapability;Object.assign(request,{turnCapability:'copied-turn',turnId:'original-turn',sequence:80});}
 await expect(runtime('outside.execute',request)).rejects.toThrow();expect(ids.outsideDispatch).not.toHaveBeenCalled();
});
it('a broker restart loses an issued handle and cannot issue another for the consumed ask',async()=>{
 const f=await exactOutsideFixture(),approved=await runtime('outside.approve',{...f.binding,call:f.call});
 await stopBroker?.();stopBroker=await startBroker();
 await expect(runtime('outside.execute',{...f.binding,...approved,call:f.call})).rejects.toThrow();
 await expect(runtime('outside.approve',{...f.binding,call:f.call})).rejects.toThrow();expect(ids.outsideDispatch).not.toHaveBeenCalled();
});

const insertNever="INSERT INTO ratchet(agent,capability,action,level) VALUES($1,'outside','','never')";
it('holds an absent ratchet override against the first never insertion until provider dispatch finishes',async()=>{
 const f=await exactOutsideFixture(),approved=await runtime('outside.approve',{...f.binding,call:f.call});
 expect((await pool.query("SELECT 1 FROM ratchet WHERE agent=$1 AND capability='outside'",[agent])).rowCount).toBe(0);
 const originalDispatch=ids.outsideDispatch.getMockImplementation()!;
 let enterDispatch!:()=>void,releaseDispatch!:()=>void,insertCommitted=false,providerCalls=0;
 const entered=new Promise<void>(resolve=>{enterDispatch=resolve}),released=new Promise<void>(resolve=>{releaseDispatch=resolve});
 ids.outsideDispatch.mockImplementation(async(...args)=>{
  enterDispatch();await released;
  expect(insertCommitted).toBe(false);providerCalls++;
  return originalDispatch(...args);
 });
 const writer=await pool.connect();let execution:Promise<unknown>|undefined,mutation:Promise<void>|undefined;
 try{
  const pid=Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  execution=runtime('outside.execute',{...f.binding,...approved,call:f.call});
  await entered;
  await writer.query('BEGIN');
  mutation=(async()=>{await writer.query(insertNever,[agent]);await writer.query('COMMIT');insertCommitted=true;})();
  let waiting=false;
  for(let attempt=0;attempt<100;attempt++){
   const locks=await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='relation'
    AND relation='ratchet'::regclass AND mode='RowExclusiveLock' AND NOT granted`,[pid]);
   if(locks.rowCount===1){waiting=true;break;}
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(waiting).toBe(true);expect(insertCommitted).toBe(false);expect(providerCalls).toBe(0);
  releaseDispatch();await execution;await mutation;
  expect(providerCalls).toBe(1);expect(insertCommitted).toBe(true);
  expect((await pool.query("SELECT level FROM ratchet WHERE agent=$1 AND capability='outside'",[agent])).rows[0].level).toBe('never');
 }finally{
  releaseDispatch();await Promise.allSettled([...(execution?[execution]:[]),...(mutation?[mutation]:[])]);
  await writer.query('ROLLBACK');writer.release();
 }
});
it('refuses before custody/provider when the first never override commits before dispatch',async()=>{
 const f=await exactOutsideFixture(),approved=await runtime('outside.approve',{...f.binding,call:f.call});
 const writer=await pool.connect();
 try{
  await writer.query('BEGIN');await writer.query(insertNever,[agent]);await writer.query('COMMIT');
  await expect(runtime('outside.execute',{...f.binding,...approved,call:f.call})).rejects.toThrow();
  expect(ids.outsideDispatch).not.toHaveBeenCalled();
 }finally{await writer.query('ROLLBACK');writer.release();}
});
it.each(['pending','issued'])('does not revive an %s approval after absent -> never -> deleted restoration',async(stage)=>{
 const f=await exactOutsideFixture({answer:stage!=='pending'});
 const approved=stage==='issued'?await runtime('outside.approve',{...f.binding,call:f.call}):undefined;
 await pool.query(insertNever,[agent]);
 await pool.query("DELETE FROM ratchet WHERE agent=$1 AND capability='outside' AND action=''",[agent]);
 expect((await pool.query("SELECT 1 FROM ratchet WHERE agent=$1 AND capability='outside'",[agent])).rowCount).toBe(0);
 expect((await pool.query("SELECT count(*)::int AS count FROM ratchet_audit WHERE agent=$1 AND capability='outside'",[agent])).rows[0].count).toBe(2);
 if(stage==='pending')await expect(f.tool.approval.response(f.response)).rejects.toThrow();
 else await expect(runtime('outside.execute',{...f.binding,...approved,call:f.call})).rejects.toThrow();
 expect(ids.outsideDispatch).not.toHaveBeenCalled();
 if(stage==='pending')expect(ids.outsideApprove).not.toHaveBeenCalled();
});

// ── vault.scheduled: scheduled jobs reading and saving notes without a person or a card ──
const rev = (c: string) => c.repeat(64);
const sched = (schedule: string, operation: string, extra: Record<string, unknown> = {}) =>
  runtime('vault.scheduled', { schedule, operation, area: 'private', ...extra });
const dreamNote = { path: '_meta/dream/2026-11-01.md', frontmatter: { at: '2026-11-01T03:00:00.000Z', cursor: '2026-11-01T03:00:00.000Z', promoted: 2, added: ['a', 'b'], all_rejected: false }, body: 'Nothing to learn.', message: 'learning: 2026-11-01' };
const setVaultGrant = async (change: Record<string, unknown>, autonomy?: string) => {
  roleDefinition = definitionSchema.parse({ ...roleDefinition, ...(autonomy ? { autonomy: { ...roleDefinition.autonomy, vault: autonomy } } : {}),
    grants: roleDefinition.grants.map(grant => grant.capability === 'vault' ? { ...grant, ...change } : grant) });
  await pool.query('UPDATE agent_resources SET applied_definition=$2::jsonb WHERE name=$1', [agent, JSON.stringify(roleDefinition)]);
};
function signedFrame(op: string, input: unknown) {
  const body = { agent, incarnation, requestId: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '').slice(0, 8), timestamp: Date.now(), op, input };
  return JSON.stringify({ ...body, mac: createHmac('sha256', Buffer.from(runtimeKey, 'hex')).update(JSON.stringify(body)).digest('base64url') }) + '\n';
}
const sendFrame = (frame: string) => new Promise<any>((resolve, reject) => {
  const socket = createConnection(process.env.LARES_VAULT_RUNTIME_SOCKET!); let data = '';
  socket.once('error', reject); socket.once('connect', () => socket.write(frame));
  socket.on('data', chunk => { data += chunk.toString(); if (data.includes('\n')) { socket.destroy(); resolve(JSON.parse(data)); } });
});

it('a scheduled write saves a dated note as an agent-origin note under a job authority, and does not touch the approval ledger', async () => {
  const saved = await sched('dream', 'write', dreamNote);
  expect(saved.commit).toMatch(/^commit-/);
  expect(ids.lastBinding).toMatchObject({ relativePath: '_meta/dream/2026-11-01.md', expectedContentRevision: null, approvedOrigin: 'agent',
    authority: { origin: 'job', jobId: 'dream', actingMemberId: ids.member, spokenByMemberId: null, agentId: agent } });
  expect(ids.lastBinding.authority.runId).toMatch(/^[0-9a-f-]{36}$/);
  expect(ids.trackFiles.get('_meta/dream/2026-11-01.md')?.content).toContain('cursor: 2026-11-01T03:00:00.000Z');
  expect((await pool.query('SELECT count(*)::int AS n FROM approval_asks')).rows[0].n).toBe(0);
  // The owner comes from the agent's access record: a request naming someone else changes nothing.
  await sched('dream', 'write', { ...dreamNote, ownerMemberId: 'someone-else', path: '_meta/dream/2026-11-02.md' });
  expect(ids.lastBinding.authority.actingMemberId).toBe(ids.member);
});

it('a scheduled list pages in order, with a cursor, and a read returns the note', async () => {
  for (const n of ['a', 'b', 'c']) ids.trackFiles.set(`_inbox/clip-${n}.md`, { content: `---\nurl: https://example.com/${n}\n---\n\nbody ${n}`, contentRevision: rev(n) });
  ids.trackFiles.set('_inbox/clip-x.md', { content: 'x', contentRevision: rev('x') });
  const first = await sched('clipping-requests', 'list', { prefix: '_inbox/', limit: 2 });
  expect(first).toMatchObject({ paths: ['_inbox/clip-a.md', '_inbox/clip-b.md'], nextCursor: '_inbox/clip-b.md' });
  const second = await sched('clipping-requests', 'list', { prefix: '_inbox/', limit: 2, cursor: first.nextCursor });
  expect(second.paths).toEqual(['_inbox/clip-c.md', '_inbox/clip-x.md']);
  expect(second.nextCursor).toBeUndefined();
  expect(await sched('clipping-requests', 'read', { path: '_inbox/clip-a.md' })).toMatchObject({ found: true, content: expect.stringContaining('body a'), contentRevision: rev('a') });
  expect(await sched('clipping-requests', 'read', { path: '_inbox/clip-a.md', probe: true })).toEqual({ ok: true, found: true, contentRevision: rev('a') });
  expect(await sched('clipping-requests', 'read', { path: '_inbox/clip-missing.md' })).toEqual({ ok: true, found: false });
});

it('a scheduled remove deletes one clip under the current revision, and a missing clip is not an error; a move needs a free destination', async () => {
  ids.trackFiles.set('_inbox/clip-a.md', { content: 'a', contentRevision: rev('a') });
  expect(await sched('clipping-requests', 'remove', { path: '_inbox/clip-a.md' })).toMatchObject({ removed: true });
  expect(ids.lastBinding).toMatchObject({ relativePath: '_inbox/clip-a.md', expectedContentRevision: rev('a'), authority: { origin: 'job', jobId: 'clipping-requests' } });
  expect(ids.trackFiles.has('_inbox/clip-a.md')).toBe(false);
  expect(await sched('clipping-requests', 'remove', { path: '_inbox/clip-a.md' })).toMatchObject({ removed: false });
  ids.trackFiles.set('_inbox/clip-b.md', { content: 'b', contentRevision: rev('b') });
  await expect(sched('clipping-requests', 'move', { path: '_inbox/clip-b.md', destination: '_inbox/clip-b.md' })).rejects.toThrow('Vault reader unavailable');
  ids.trackFiles.set('_inbox/clip-c.md', { content: 'c', contentRevision: rev('c') });
  await expect(sched('clipping-requests', 'move', { path: '_inbox/clip-b.md', destination: '_inbox/clip-c.md' })).rejects.toThrow('Vault reader unavailable');
});

it('a scheduled operation is refused outside the schedule policy, and nothing is written', async () => {
  const refused = (run: Promise<unknown>) => expect(run).rejects.toThrow('Vault reader unavailable');
  await refused(sched('briefing', 'list', { prefix: '_inbox/' }));                                              // not on the allowlist
  await refused(sched('weekly-summary', 'write', dreamNote));                                                   // unknown schedule
  await refused(sched('dream', 'write', { ...dreamNote, path: 'notes/loose.md' }));                             // path outside the schedule
  await refused(sched('dream', 'write', { ...dreamNote, path: '_meta/dream/../../secret.md' }));               // traversal
  await refused(sched('dream', 'write', { ...dreamNote, path: '_meta/dream/.hidden.md' }));
  await refused(sched('dream', 'remove', { path: '_meta/dream/2026-11-01.md' }));                               // dream never removes
  await refused(sched('dream', 'list', { prefix: '_inbox/' }));                                                  // a prefix of another schedule
  await refused(sched('dream', 'list', { prefix: '' }));                                                         // only the digest may name the whole area
  await refused(sched('clipping-requests', 'list', { prefix: '' }));
  await refused(sched('clipping-requests', 'write', { ...dreamNote, path: '_inbox/sub/x.md' }));
  await refused(sched('clipping-requests', 'read', { path: '_meta/dream/2026-11-01.md' }));
  await refused(sched('clipping-requests', 'write', { path: '_inbox/clip-a.md', frontmatter: { 'bad key': 'x' }, body: 'x' }));
  await refused(sched('clipping-requests', 'write', { path: '_inbox/clip-a.md', frontmatter: { a: { nested: true } }, body: 'x' }));
  await refused(sched('clipping-requests', 'write', { path: '_inbox/clip-a.md', frontmatter: {}, body: 'x', message: 'two\nlines' }));
  await refused(sched('clipping-requests', 'write', { path: '_inbox/clip-a.md', frontmatter: {}, body: 'x'.repeat(193 * 1024) }));  // over one frame
  await refused(runtime('vault.scheduled', { schedule: 'dream', operation: 'write', area: 'shared', ...dreamNote }));      // wrong area
  await refused(runtime('vault.scheduled', { schedule: 'dream', operation: 'write', area: 'place', ...dreamNote }));
  await refused(sched('dream', 'copy', dreamNote));
  expect(ids.writes).toBe(0);
});

it('a scheduled write needs the agent\'s own write grant on the area: read-only, never, another area, none or no vault grant all refuse', async () => {
  const refused = (run: Promise<unknown>) => expect(run).rejects.toThrow('Vault reader unavailable');
  await setVaultGrant({ scope: 'read' });
  await refused(sched('dream', 'write', dreamNote));
  await refused(sched('clipping-requests', 'remove', { path: '_inbox/clip-a.md' }));
  ids.trackFiles.set('_inbox/clip-a.md', { content: 'a', contentRevision: rev('a') });
  expect(await sched('clipping-requests', 'read', { path: '_inbox/clip-a.md' })).toMatchObject({ found: true });   // a read grant still reads
  await setVaultGrant({ scope: 'write' }, 'never');
  await refused(sched('dream', 'write', dreamNote));
  await refused(sched('clipping-requests', 'read', { path: '_inbox/clip-a.md' }));
  await setVaultGrant({ scope: 'write', areas: ['shared', 'facts'] }, 'gated');
  await refused(sched('dream', 'write', dreamNote));
  await setVaultGrant({ scope: 'none', areas: ['private'] });
  await refused(sched('dream', 'write', dreamNote));
  roleDefinition = definitionSchema.parse({ ...roleDefinition, grants: roleDefinition.grants.filter(grant => grant.capability !== 'vault') });
  await pool.query('UPDATE agent_resources SET applied_definition=$2::jsonb WHERE name=$1', [agent, JSON.stringify(roleDefinition)]);
  await refused(sched('dream', 'write', dreamNote));
  expect(ids.writes).toBe(0);
});

it('a scheduled operation is refused for a stale incarnation, a removed owner, an invalid definition and a member policy that withdrew the capability', async () => {
  const refused = (run: Promise<unknown>) => expect(run).rejects.toThrow('Vault reader unavailable');
  await pool.query("UPDATE agent_resources SET ownership_token='55555555-5555-4555-8555-555555555555' WHERE name=$1", [agent]);
  await refused(sched('dream', 'write', dreamNote));
  await pool.query('UPDATE agent_resources SET ownership_token=$2::uuid WHERE name=$1', [agent, incarnation]);
  await pool.query("UPDATE users SET status='removed' WHERE id=$1", [ids.member]);
  await refused(sched('dream', 'write', dreamNote));
  await pool.query("UPDATE users SET status='active' WHERE id=$1", [ids.member]);
  await pool.query("UPDATE agent_definitions SET status='invalid' WHERE name=$1", [agent]);
  await refused(sched('dream', 'write', dreamNote));
  await pool.query("UPDATE agent_definitions SET status='valid' WHERE name=$1", [agent]);
  // The owner's member policy no longer allows the capability: nothing can be written.
  await pool.query("UPDATE org_member_policy SET allowed_capabilities=ARRAY[]::text[] WHERE user_id=$1", [ids.member]);
  await refused(sched('dream', 'write', dreamNote));
  expect(ids.writes).toBe(0);
});

const digestClip = { path: '_inbox/karakeep-b1.md', frontmatter: { url: 'https://example.com/a', source: 'karakeep' }, body: 'saved' };
const digestFiled = { path: 'reads/a-note.md', frontmatter: { title: 'A note', type: 'reference', filed_by: 'digest' }, body: 'Summary.', message: 'digest: file A note' };

it('the digest may pull, read, list, move out of the inbox and rewrite into its folders, as a job with the agent origin', async () => {
  await sched('digest', 'write', digestClip);
  expect(ids.lastBinding).toMatchObject({ relativePath: '_inbox/karakeep-b1.md', approvedOrigin: 'agent', authority: { origin: 'job', jobId: 'digest', actingMemberId: ids.member } });
  ids.trackFiles.set('inspiration/old.md', { content: 'old', contentRevision: rev('c') });
  ids.trackFiles.set('Project A/transcripts/call.md', { content: 'call', contentRevision: rev('d') });
  // The whole area is listed for note names (fixture's list also answers its own owner note).
  const all = await sched('digest', 'list', { prefix: '' });
  expect(all.paths).toEqual(expect.arrayContaining(['_inbox/karakeep-b1.md', 'inspiration/old.md', 'Project A/transcripts/call.md']));
  expect((await sched('digest', 'list', { prefix: '_inbox/' })).paths).toEqual(['_inbox/karakeep-b1.md']);
  expect(await sched('digest', 'read', { path: '_inbox/karakeep-b1.md' })).toMatchObject({ found: true });
  expect(await sched('digest', 'read', { path: 'reads/a-note.md', probe: true })).toEqual({ ok: true, found: false });
  // Move first (the inbox note is gone), then rewrite at the new place.
  await sched('digest', 'move', { path: '_inbox/karakeep-b1.md', destination: 'reads/a-note.md' });
  expect(ids.trackFiles.has('_inbox/karakeep-b1.md')).toBe(false);
  expect(ids.lastBinding).toMatchObject({ relativePath: '_inbox/karakeep-b1.md', authority: { origin: 'job', jobId: 'digest' } });
  await sched('digest', 'write', digestFiled);
  expect(ids.trackFiles.get('reads/a-note.md')?.content).toContain('Summary.');
  await sched('digest', 'write', { ...digestFiled, path: 'Project A/transcripts/call-two.md' });
  expect(ids.trackFiles.has('Project A/transcripts/call-two.md')).toBe(true);
  await sched('digest', 'write', { ...digestFiled, path: 'writing-seeds/idea.md' });
  ids.trackFiles.set('_inbox/other.md', { content: 'x', contentRevision: rev('e') });
  expect(await sched('digest', 'remove', { path: '_inbox/other.md' })).toMatchObject({ removed: true });
  expect((await pool.query('SELECT count(*)::int AS n FROM approval_asks')).rows[0].n).toBe(0);
});

it('the digest is refused outside its own paths, areas and operations, and nothing is written', async () => {
  const refused = (run: Promise<unknown>) => expect(run).rejects.toThrow('Vault reader unavailable');
  ids.trackFiles.set('_inbox/a.md', { content: 'a', contentRevision: rev('a') });
  ids.trackFiles.set('reads/keep.md', { content: 'k', contentRevision: rev('b') });
  await refused(sched('digest', 'write', { ...digestFiled, path: 'notes/loose.md' }));                           // a folder the classifier cannot name
  await refused(sched('digest', 'write', { ...digestFiled, path: 'reads/sub/deep.md' }));
  await refused(sched('digest', 'write', { ...digestFiled, path: 'reads/Not-A-Slug.md' }));
  await refused(sched('digest', 'write', { ...digestFiled, path: '_inbox/loose.md' }));                           // the digest pulls only clip-* and karakeep-* into the inbox
  await refused(sched('digest', 'write', { ...digestFiled, path: '_meta/dream/2026-11-01.md' }));
  await refused(sched('digest', 'write', { ...digestFiled, path: '_inbox/../reads/x.md' }));
  await refused(sched('digest', 'write', { ...digestFiled, path: '_templates/transcripts/x.md' }));               // a project folder never starts with _ or .
  await refused(sched('digest', 'write', { ...digestFiled, path: '.git/transcripts/x.md' }));
  await refused(sched('digest', 'write', { ...digestFiled, path: 'articles/x.md' }));                             // articles are not filed through this yet
  await refused(sched('digest', 'read', { path: '_meta/dream/2026-11-01.md' }));
  await refused(sched('digest', 'read', { path: 'notes/loose.md' }));
  await refused(sched('digest', 'remove', { path: 'reads/keep.md' }));                                            // only inbox notes are ever removed
  await refused(sched('digest', 'remove', { path: '_inbox/sub/x.md' }));
  await refused(sched('digest', 'move', { path: 'reads/keep.md', destination: 'inspiration/keep.md' }));         // the source must be in the inbox
  await refused(sched('digest', 'move', { path: '_inbox/a.md', destination: 'notes/loose.md' }));
  await refused(sched('digest', 'move', { path: '_inbox/a.md', destination: 'reads/keep.md' }));                 // a note that is already there is never replaced by a move
  await refused(sched('digest', 'list', { prefix: 'reads/' }));
  await refused(sched('digest', 'list', { prefix: '_meta/' }));
  await refused(runtime('vault.scheduled', { schedule: 'digest', operation: 'write', area: 'shared', ...digestFiled }));   // the shared rule saves articles only
  await refused(runtime('vault.scheduled', { schedule: 'digest', operation: 'list', area: 'shared', prefix: '' }));
  expect(ids.writes).toBe(0);
  expect(ids.trackFiles.get('reads/keep.md')?.content).toBe('k');
});

it('the digest needs the agent\'s own write grant on the private area to write, and only a read grant to list', async () => {
  const refused = (run: Promise<unknown>) => expect(run).rejects.toThrow('Vault reader unavailable');
  ids.trackFiles.set('_inbox/a.md', { content: 'a', contentRevision: rev('a') });
  await setVaultGrant({ scope: 'read' });
  expect((await sched('digest', 'list', { prefix: '_inbox/' })).paths).toEqual(['_inbox/a.md']);
  await refused(sched('digest', 'write', digestFiled));
  await refused(sched('digest', 'move', { path: '_inbox/a.md', destination: 'reads/a.md' }));
  await refused(sched('digest', 'remove', { path: '_inbox/a.md' }));
  await setVaultGrant({ scope: 'write' }, 'never');
  await refused(sched('digest', 'write', digestFiled));
  expect(ids.writes).toBe(0);
});

it('with the real writer the digest moves a pulled clip out of the inbox into reads/, rewrites it there, and lists note names across the area', async () => {
  await realAreasAndTurn();
  const privateRoot = join(root, 'vault-files', `vault/private/${ids.area}`);
  await sched('digest', 'write', digestClip);
  expect(readFileSync(join(privateRoot, digestClip.path), 'utf8')).toContain('lares_origin: agent');
  await sched('digest', 'move', { path: digestClip.path, destination: 'reads/a-note.md' });
  expect(() => readFileSync(join(privateRoot, digestClip.path))).toThrow();
  expect(readFileSync(join(privateRoot, 'reads/a-note.md'), 'utf8')).toContain('saved');
  await sched('digest', 'write', digestFiled);
  const filed = readFileSync(join(privateRoot, 'reads/a-note.md'), 'utf8');
  expect(filed).toContain('Summary.'); expect(filed).toContain('filed_by: digest'); expect(filed).not.toContain('karakeep');
  // The destination now exists, so a second move onto it is refused and the note is left as it is.
  await sched('digest', 'write', digestClip);
  await expect(sched('digest', 'move', { path: digestClip.path, destination: 'reads/a-note.md' })).rejects.toThrow('Vault reader unavailable');
  expect(readFileSync(join(privateRoot, 'reads/a-note.md'), 'utf8')).toBe(filed);
  expect((await sched('digest', 'list', { prefix: '' })).paths).toEqual(expect.arrayContaining(['_inbox/karakeep-b1.md', 'reads/a-note.md']));
});

it('a replayed scheduled request is refused the second time and writes once', async () => {
  const frame = signedFrame('vault.scheduled', { schedule: 'dream', operation: 'write', area: 'private', ...dreamNote });
  expect(await sendFrame(frame)).toMatchObject({ ok: true, commit: expect.any(String) });
  expect(await sendFrame(frame)).toEqual({ ok: false });
  expect(ids.writes).toBe(1);
});

it('with the real writer a scheduled note reaches the private area under _meta/, is listed there, is not repeated, and a commit fits the deadline (measured)', async () => {
  await realAreasAndTurn();
  const privateRoot = join(root, 'vault-files', `vault/private/${ids.area}`), origin = join(root, 'vault-origins', `${ids.area}.git`);
  const started = performance.now();
  const saved = await sched('dream', 'write', dreamNote);
  const writeMs = performance.now() - started;
  console.log(`vault.scheduled real commit + push to the bare origin: ${writeMs.toFixed(0)} ms (keeper deadline 8000 ms)`);
  expect(writeMs).toBeLessThan(4000);
  const content = readFileSync(join(privateRoot, '_meta/dream/2026-11-01.md'), 'utf8');
  expect(content).toContain('lares_origin: agent'); expect(content).toContain('added: ["a","b"]'); expect(content).toContain('Nothing to learn.');
  expect(execFileSync('git', ['-C', origin, 'log', '-1', '--format=%H%n%s'], { encoding: 'utf8' })).toMatch(new RegExp(`^${saved.commit}[0-9a-f]*\nlearning: 2026-11-01`));
  // The normal listing hides _meta/; naming the folder finds it, so the cursor can be resolved.
  expect(await sched('dream', 'list', { prefix: '_meta/dream/' })).toMatchObject({ paths: ['_meta/dream/2026-11-01.md'] });
  expect(await sched('dream', 'list', { prefix: '_meta/conversations/' })).toMatchObject({ paths: [] });
  expect(await sched('dream', 'read', { path: '_meta/dream/2026-11-01.md' })).toMatchObject({ found: true, content });
  expect(await sched('dream', 'write', dreamNote)).toMatchObject({ path: '_meta/dream/2026-11-01.md', unchanged: true });
  // A clip is replaced under its current revision, then removed.
  const clip = { path: '_inbox/clip-s1-p1.md', frontmatter: { url: 'https://example.com/a', title: 'A' }, body: 'one' };
  await sched('clipping-requests', 'write', clip);
  await sched('clipping-requests', 'write', { ...clip, body: 'two' });
  expect(readFileSync(join(privateRoot, clip.path), 'utf8')).toContain('two');
  const removeStarted = performance.now();
  expect(await sched('clipping-requests', 'remove', { path: clip.path })).toMatchObject({ removed: true });
  console.log(`vault.scheduled real remove: ${(performance.now() - removeStarted).toFixed(0)} ms`);
  expect(() => readFileSync(join(privateRoot, clip.path))).toThrow();
});

// ── vault.scheduled write-verbatim: a file saved exactly as sent, for the digest's articles ──
const articleMd = '---\ntitle: A page\nlares_origin: third_party\nsources:\n  - resource: https://example.com/a\n    fetched: 2026-11-01\ngenerated:\n  by: digest\n---\n\nSummary.\n';
const verbatim = (extra: Record<string, unknown>) => sched('digest', 'write-verbatim', extra);

it('a verbatim write saves the article and its companion exactly as sent, as a job, and the same bytes again change nothing', async () => {
  expect(await verbatim({ path: 'articles/a-page.md', content: articleMd, message: 'digest: file article a-page' })).toMatchObject({ path: 'articles/a-page.md', commit: 'verbatim-1' });
  expect(ids.lastBinding).toMatchObject({ relativePath: 'articles/a-page.md', expectedContentRevision: null, approvedOrigin: 'third_party',
    authority: { origin: 'job', jobId: 'digest', actingMemberId: ids.member } });
  expect(ids.trackFiles.get('articles/a-page.md')?.content).toBe(articleMd);
  expect(await verbatim({ path: 'articles/a-page-1f2e3d.txt', content: 'Plain text\nof the page.\n' })).toMatchObject({ commit: 'verbatim-2' });
  expect(ids.trackFiles.get('articles/a-page-1f2e3d.txt')?.content).toBe('Plain text\nof the page.\n');
  expect(await verbatim({ path: 'articles/a-page.md', content: articleMd })).toEqual({ ok: true, path: 'articles/a-page.md', unchanged: true });
  expect(ids.writes).toBe(2);
  // A changed file replaces the old one under its current revision.
  await verbatim({ path: 'articles/a-page.md', content: articleMd.replace('Summary.', 'Longer summary.') });
  expect(ids.lastBinding.expectedContentRevision).toBe('0'.repeat(63) + '1');
  expect(ids.writes).toBe(3);
});

it('a verbatim write is refused for a path, an origin, a front matter, a size or a text the schedule may not save, and nothing is written', async () => {
  const refused = (run: Promise<unknown>) => expect(run).rejects.toThrow('Vault reader unavailable');
  const withOrigin = (origin: string) => articleMd.replace('lares_origin: third_party', `lares_origin: ${origin}`);
  await refused(verbatim({ path: 'reads/a-note.md', content: articleMd }));                    // a folder the rule does not name
  await refused(verbatim({ path: 'articles/sub/a.md', content: articleMd }));
  await refused(verbatim({ path: 'articles/A-Page.md', content: articleMd }));                 // not a slug
  await refused(verbatim({ path: 'articles/a-page.json', content: '{}' }));
  await refused(verbatim({ path: 'articles/.hidden.md', content: articleMd }));
  await refused(verbatim({ path: 'articles/../_inbox/x.md', content: articleMd }));
  await refused(verbatim({ path: '_inbox/karakeep-b1.md', content: articleMd }));
  await refused(verbatim({ path: 'articles/a-page.md', content: 'no front matter at all' }));
  await refused(verbatim({ path: 'articles/a-page.md', content: articleMd.replace(/^---\n/, '\n---\n') }));   // does not start with the block
  await refused(verbatim({ path: 'articles/a-page.md', content: '---\ntitle: x\n---\n\nbody' }));        // no origin line
  for (const origin of ['agent', 'owner', 'synced', 'system', 'third_party ', '"third_party"']) await refused(verbatim({ path: 'articles/a-page.md', content: withOrigin(origin) }));
  await refused(verbatim({ path: 'articles/a-page.md', content: articleMd.replace('title: A page', 'lares_origin: third_party\ntitle: A page') }));   // two origin lines
  await refused(verbatim({ path: 'articles/a-page.md', content: articleMd.replace('title: A page', 'lares_origin: agent\ntitle: A page') }));       // a second, different one
  await refused(verbatim({ path: 'articles/a-page.md', content: articleMd.replace('title: A page', '"lares_origin": owner\ntitle: A page') }));
  await refused(verbatim({ path: 'articles/a-page.md', content: articleMd.replaceAll('\n', '\r\n') }));
  await refused(verbatim({ path: 'articles/a-page-1f2e3d.txt', content: '---\nlares_origin: third_party\n---\ntext' }));        // a companion with front matter
  await refused(verbatim({ path: 'articles/a-page.md', content: `${articleMd}\u0000` }));
  await refused(verbatim({ path: 'articles/a-page-1f2e3d.txt', content: 'text\u0000more' }));
  await refused(verbatim({ path: 'articles/a-page-1f2e3d.txt', content: 'lone \ud800 surrogate' }));
  await refused(verbatim({ path: 'articles/a-page-1f2e3d.txt', content: 'x'.repeat(193 * 1024) }));
  await refused(verbatim({ path: 'articles/a-page-1f2e3d.txt', content: 42 }));
  await refused(verbatim({ path: 'articles/a-page-1f2e3d.txt' }));
  await refused(verbatim({ path: 'articles/a-page-1f2e3d.txt', content: 'ok', message: 'two\nlines' }));
  // Only a rule that names verbatim paths may use the operation, whatever the file says.
  await refused(sched('dream', 'write-verbatim', { path: '_meta/dream/2026-11-01.md', content: withOrigin('third_party') }));
  await refused(sched('clipping-requests', 'write-verbatim', { path: '_inbox/clip-a.md', content: withOrigin('third_party') }));
  expect(ids.writes).toBe(0);
});

it('a verbatim write needs the agent\'s own write grant on the area', async () => {
  const refused = (run: Promise<unknown>) => expect(run).rejects.toThrow('Vault reader unavailable');
  await setVaultGrant({ scope: 'read' });
  await refused(verbatim({ path: 'articles/a-page.md', content: articleMd }));
  await setVaultGrant({ scope: 'write' }, 'never');
  await refused(verbatim({ path: 'articles/a-page.md', content: articleMd }));
  await setVaultGrant({ scope: 'write', areas: ['shared'] }, 'gated');
  await refused(verbatim({ path: 'articles/a-page.md', content: articleMd }));
  expect(ids.writes).toBe(0);
});

it('with the real writer a verbatim article reaches the private area byte for byte, with its companion, in the origin, and can be read and listed', async () => {
  await realAreasAndTurn();
  const privateRoot = join(root, 'vault-files', `vault/private/${ids.area}`), origin = join(root, 'vault-origins', `${ids.area}.git`);
  const saved = await verbatim({ path: 'articles/a-page.md', content: articleMd, message: 'digest: file article a-page' });
  expect(readFileSync(join(privateRoot, 'articles/a-page.md'), 'utf8')).toBe(articleMd);
  expect(execFileSync('git', ['-C', origin, 'log', '-1', '--format=%H%n%s'], { encoding: 'utf8' })).toMatch(new RegExp(`^${saved.commit}[0-9a-f]*\ndigest: file article a-page`));
  await verbatim({ path: 'articles/a-page.txt', content: 'Full text.\n' });
  expect(readFileSync(join(privateRoot, 'articles/a-page.txt'), 'utf8')).toBe('Full text.\n');
  expect(await verbatim({ path: 'articles/a-page.md', content: articleMd })).toMatchObject({ unchanged: true });
  expect(await verbatim({ path: 'articles/a-page.txt', content: 'Full text.\n' })).toMatchObject({ unchanged: true });
  expect(await sched('digest', 'read', { path: 'articles/a-page.md' })).toMatchObject({ found: true, content: articleMd });
  expect((await sched('digest', 'list', { prefix: 'articles/' })).paths).toEqual(['articles/a-page.md']); // a listing names notes only; the text companion is not a note
});

// ── the digest's shared rule: a filed article and its companion, nothing else ──
const schedShared = (operation: string, extra: Record<string, unknown> = {}) => runtime('vault.scheduled', { schedule: 'digest', operation, area: 'shared', ...extra });

it('a shared article and its companion are saved verbatim in the shared area, as a job, with the grant', async () => {
  expect(await schedShared('write-verbatim', { path: 'articles/a-page.txt', content: 'Full text.\n' })).toMatchObject({ commit: 'verbatim-1' });
  expect(ids.lastBinding).toMatchObject({ areaId: ids.sharedArea, relativePath: 'articles/a-page.txt', approvedOrigin: 'third_party', authority: { origin: 'job', jobId: 'digest' } });
  expect(await schedShared('write-verbatim', { path: 'articles/a-page.md', content: articleMd, message: 'digest: file article a-page' })).toMatchObject({ commit: 'verbatim-2' });
  expect(ids.lastBinding.areaId).toBe(ids.sharedArea);
  expect(await schedShared('write-verbatim', { path: 'articles/a-page.md', content: articleMd })).toMatchObject({ unchanged: true });
  expect((await schedShared('list', { prefix: 'articles/' })).paths).toEqual(['articles/a-page.md', 'articles/a-page.txt']);
  expect(await schedShared('read', { path: 'articles/a-page.md' })).toMatchObject({ found: true, content: articleMd });
});

it('a shared article is refused without the shared write grant, and a read grant still lists', async () => {
  const refused = (run: Promise<unknown>) => expect(run).rejects.toThrow('Vault reader unavailable');
  await setVaultGrant({ scope: 'write', areas: ['private'] }, 'gated');
  await refused(schedShared('write-verbatim', { path: 'articles/a-page.md', content: articleMd }));
  await refused(schedShared('list', { prefix: 'articles/' }));
  await setVaultGrant({ scope: 'read', areas: ['private', 'shared'] });
  await refused(schedShared('write-verbatim', { path: 'articles/a-page.md', content: articleMd }));
  expect((await schedShared('list', { prefix: 'articles/' })).paths).toEqual([]);
  await setVaultGrant({ scope: 'write', areas: ['private', 'shared'] }, 'never');
  await refused(schedShared('write-verbatim', { path: 'articles/a-page.md', content: articleMd }));
  expect(ids.writes).toBe(0);
});

it('in the shared area the digest cannot save outside articles/, write a note, remove, move or list the whole area', async () => {
  const refused = (run: Promise<unknown>) => expect(run).rejects.toThrow('Vault reader unavailable');
  ids.trackFiles.set('articles/a-page.md', { content: articleMd, contentRevision: rev('a') });
  ids.trackFiles.set('reads/keep.md', { content: 'k', contentRevision: rev('b') });
  ids.trackFiles.set('_inbox/clip-a.md', { content: 'c', contentRevision: rev('c') });
  await refused(schedShared('write-verbatim', { path: 'reads/a-note.md', content: articleMd }));
  await refused(schedShared('write-verbatim', { path: 'articles/sub/a.md', content: articleMd }));
  await refused(schedShared('write-verbatim', { path: '_inbox/clip-a.md', content: articleMd }));
  await refused(schedShared('write-verbatim', { path: 'articles/a-page.md', content: articleMd.replace('third_party', 'agent') }));
  await refused(schedShared('write', { ...digestFiled, path: 'articles/x.md' }));
  await refused(schedShared('write', digestFiled));
  await refused(schedShared('write', { ...digestClip }));
  await refused(schedShared('remove', { path: 'articles/a-page.md' }));
  await refused(schedShared('remove', { path: '_inbox/clip-a.md' }));
  await refused(schedShared('move', { path: '_inbox/clip-a.md', destination: 'reads/x.md' }));
  await refused(schedShared('list', { prefix: '' }));
  await refused(schedShared('list', { prefix: '_inbox/' }));
  await refused(schedShared('read', { path: 'reads/keep.md' }));
  await refused(schedShared('read', { path: 'articles/a-page.txt' }));
  expect(ids.writes).toBe(0);
  expect(ids.trackFiles.get('reads/keep.md')?.content).toBe('k');
  expect(ids.trackFiles.has('articles/a-page.md')).toBe(true);
});

// ── A chat door's pass: the claimed person in a private chat, found by Keeper itself ───────────────
// Door-neutral: every door in the door table runs the same checks. The pass names the door and the claim,
// never a member; Keeper takes the member from its own configuration and rechecks on every read.
const DOOR_KINDS = [...new Set(Object.values(DOORS).map(row => row.door))];
const DOOR_REVISION = '6d1c0000-0000-4000-8000-000000000001';
const DOOR_PRINCIPAL = 'U0DOORPERSON';
const OWNER_EMAIL = 'owner@example.test';
async function doorFixture(kind: string, over: { principal?: string; email?: string; revision?: string } = {}) {
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_doors(agent text NOT NULL,kind text NOT NULL,enabled boolean NOT NULL DEFAULT false,secret_set_at timestamptz,settings jsonb NOT NULL DEFAULT '{}'::jsonb,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS agent_door_connections(agent text NOT NULL,kind text NOT NULL,incarnation uuid NOT NULL,revision uuid NOT NULL,owner_email text NOT NULL,code_hash text,expires_at timestamptz,attempts integer NOT NULL DEFAULT 0,principal text,org text,mailbox text,claimed_at timestamptz,applied_revision uuid,applied_connection jsonb,webhook_set_at timestamptz)`);
  await pool.query('UPDATE users SET primary_email=$2 WHERE id=$1', [ids.member, over.email ?? OWNER_EMAIL]);
  await pool.query('DELETE FROM agent_doors WHERE agent=$1 AND kind=$2', [agent, kind]);
  await pool.query('DELETE FROM agent_door_connections WHERE agent=$1 AND kind=$2', [agent, kind]);
  await pool.query('INSERT INTO agent_doors(agent,kind,enabled) VALUES($1,$2,true)', [agent, kind]);
  const revision = over.revision ?? DOOR_REVISION;
  await pool.query('INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal,claimed_at,applied_revision) VALUES($1,$2,$3,$4,$5,$6,now(),$4)',
    [agent, kind, incarnation, revision, OWNER_EMAIL, over.principal ?? DOOR_PRINCIPAL]);
  const doors = DOOR_KINDS.map(k => ({ kind: k, enabled: true }));
  await pool.query('UPDATE agent_resources SET applied_definition=$2::jsonb WHERE name=$1', [agent, JSON.stringify({ ...roleDefinition, doors })]);
}
const doorOpenInput = (kind: string, over: Record<string, unknown> = {}) => ({ door: kind, principal: DOOR_PRINCIPAL, claimRevision: DOOR_REVISION, chat: 'private',
  sessionId: 'door_session_1', turnId: 'turn_0', sequence: 0, definition: { definition: roleDefinition, dutiesMd, voiceMd, hash: definitionHash }, ...over });
const doorRead = (kind: string, capability: string, over: Record<string, unknown> = {}) => ({ turnCapability: capability, turnId: 'turn_0', sequence: 0, sessionId: 'door_session_1',
  door: kind, principal: DOOR_PRINCIPAL, claimRevision: DOOR_REVISION, area: 'private', operation: 'list', ...over });
async function openDoorPass(kind: string, over: Record<string, unknown> = {}): Promise<string> {
  const opened = await runtime('door.turn.open', doorOpenInput(kind, over));
  return opened.turnCapability as string;
}
const refusedByKeeper = (promise: Promise<unknown>) => expect(promise).rejects.toThrow('Vault reader unavailable');

it('every door in the door table: the claimed person in a private chat lists, reads and searches only their own private area', async () => {
  expect(DOOR_KINDS.length).toBeGreaterThan(0);
  for (const kind of DOOR_KINDS) {
    await doorFixture(kind);
    const capability = await openDoorPass(kind);
    expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(runtime('vault.read', doorRead(kind, capability))).resolves.toMatchObject({ notes: ['owner.md'] });
    await expect(runtime('vault.read', doorRead(kind, capability, { operation: 'read', path: 'owner.md' }))).resolves.toMatchObject({ path: 'owner.md', content: 'private note content' });
    await expect(runtime('vault.read', doorRead(kind, capability, { operation: 'search', q: 'note' }))).resolves.toMatchObject({ hits: [] });
    // The pass for one door and claim is no pass for another door.
    for (const other of DOOR_KINDS.filter(k => k !== kind)) await refusedByKeeper(runtime('vault.read', doorRead(kind, capability, { door: other })));
    await runtime('door.turn.close', { turnCapability: capability, turnId: 'turn_0', sequence: 0 });
    await refusedByKeeper(runtime('vault.read', doorRead(kind, capability)));
  }
});

it('a door pass is refused for the wrong principal, a stale claim, a demoted or removed owner, a shared room and a changed definition', async () => {
  const kind = DOOR_KINDS[0]!;
  await doorFixture(kind);
  await refusedByKeeper(runtime('door.turn.open', doorOpenInput(kind, { principal: 'U0SOMEONEELSE' })));
  await refusedByKeeper(runtime('door.turn.open', doorOpenInput(kind, { claimRevision: '6d1c0000-0000-4000-8000-000000000002' })));
  await refusedByKeeper(runtime('door.turn.open', doorOpenInput(kind, { chat: 'shared-room' })));
  await refusedByKeeper(runtime('door.turn.open', doorOpenInput(kind, { chat: undefined })));
  await refusedByKeeper(runtime('door.turn.open', doorOpenInput('not-a-door')));
  await refusedByKeeper(runtime('door.turn.open', { ...doorOpenInput(kind), memberId: ids.member }));
  await refusedByKeeper(runtime('door.turn.open', doorOpenInput(kind, { definition: { definition: roleDefinition, dutiesMd, voiceMd: 'changed', hash: definitionHash } })));
  // The claim was issued by an address the owner no longer has.
  await pool.query('UPDATE users SET primary_email=$2 WHERE id=$1', [ids.member, 'someone-else@example.test']);
  await refusedByKeeper(runtime('door.turn.open', doorOpenInput(kind)));
  await pool.query('UPDATE users SET primary_email=$2 WHERE id=$1', [ids.member, OWNER_EMAIL]);
  // A demoted owner, before and after the pass was given. Changing a role moves the member's access revision, so a
  // pass given earlier stays dead even if the role is restored; a new pass can be had.
  const capability = await openDoorPass(kind);
  await pool.query("UPDATE users SET org_role='member' WHERE id=$1", [ids.member]);
  await refusedByKeeper(runtime('vault.read', doorRead(kind, capability)));
  await refusedByKeeper(runtime('door.turn.open', doorOpenInput(kind)));
  await pool.query("UPDATE users SET org_role='owner' WHERE id=$1", [ids.member]);
  await refusedByKeeper(runtime('vault.read', doorRead(kind, capability)));
  const renewed = await openDoorPass(kind);
  await expect(runtime('vault.read', doorRead(kind, renewed))).resolves.toMatchObject({ notes: ['owner.md'] });
  // The claim moved on (another revision was applied): the old pass is dead.
  await pool.query("UPDATE agent_door_connections SET revision='6d1c0000-0000-4000-8000-000000000009',applied_revision='6d1c0000-0000-4000-8000-000000000009' WHERE agent=$1 AND kind=$2", [agent, kind]);
  await refusedByKeeper(runtime('vault.read', doorRead(kind, renewed)));
});

it('a door pass is refused after the use grant changed, with no area binding, once expired, and for another session or turn', async () => {
  const kind = DOOR_KINDS[0]!;
  await doorFixture(kind);
  let capability = await openDoorPass(kind);
  await refusedByKeeper(runtime('vault.read', doorRead(kind, capability, { sessionId: 'door_session_2' })));
  await refusedByKeeper(runtime('vault.read', doorRead(kind, capability, { turnId: 'turn_1', sequence: 1 })));
  await refusedByKeeper(runtime('vault.read', doorRead(kind, capability, { memberId: ids.member })));
  await refusedByKeeper(runtime('vault.read', doorRead(kind, capability, { area: 'taste' })));
  await refusedByKeeper(runtime('door.turn.close', { turnCapability: capability, turnId: 'turn_1', sequence: 1 }));
  // The member's access to the agent changed after the pass was given.
  await pool.query("UPDATE agent_access SET revision=nextval('resource_access_revision_seq') WHERE agent_name=$1", [agent]);
  await refusedByKeeper(runtime('vault.read', doorRead(kind, capability)));
  // Expiry: five minutes on Keeper's clock.
  capability = await openDoorPass(kind);
  await expect(runtime('vault.read', doorRead(kind, capability))).resolves.toMatchObject({ notes: ['owner.md'] });
  ids.clock += 5 * 60_000 + 1;
  await refusedByKeeper(runtime('vault.read', doorRead(kind, capability)));
  ids.clock = Date.now();
  // A removed member gets no pass at all (and a pass given earlier is dead).
  await pool.query("UPDATE users SET status='removed' WHERE id=$1", [ids.member]);
  await refusedByKeeper(runtime('door.turn.open', doorOpenInput(kind)));
});

it('with no binding to the private area a door read of it is refused, and with none to any area there is no pass', async () => {
  const kind = DOOR_KINDS[0]!;
  await doorFixture(kind);
  const capability = await openDoorPass(kind);
  await pool.query("UPDATE vault_areas SET status='retired',revision=nextval('vault_access_revision_seq') WHERE kind='private'");
  await refusedByKeeper(runtime('vault.read', doorRead(kind, capability)));
  await pool.query("UPDATE vault_areas SET status='retired',revision=nextval('vault_access_revision_seq') WHERE status='active'");
  await refusedByKeeper(runtime('door.turn.open', doorOpenInput(kind)));
});

it('a web chat capability does not read as a door pass, and a door pass is no web chat capability', async () => {
  const kind = DOOR_KINDS[0]!;
  await doorFixture(kind);
  const door = await openDoorPass(kind);
  await refusedByKeeper(runtime('vault.read', { turnCapability: door, turnId: 'turn_0', sequence: 0, sessionId: 'door_session_1', memberId: ids.member, admissionNonce, operation: 'list', area: 'private' }));
  const console = await openTurn(0);
  await refusedByKeeper(runtime('vault.read', doorRead(kind, console.opened.turnCapability)));
});

it('a door pass reads a note saved in a real repository-backed Vault: only the private area of the claimed person, and searches find it', async () => {
  await realAreasAndTurn();
  const approved = await approvedExactTrack('agent-kit__vault_write', noteInput, vaultNoteApprovalAdapter);
  await runtime('vault.write', { sessionId: session, memberId: ids.member, admissionNonce, approval: noteProof(approved), input: noteInput });
  for (const kind of DOOR_KINDS) {
    await doorFixture(kind);
    const capability = await openDoorPass(kind);
    const listed = await runtime('vault.read', doorRead(kind, capability));
    expect(listed.notes).toContain('_inbox/oslo.md');
    const note = await runtime('vault.read', doorRead(kind, capability, { operation: 'read', path: '_inbox/oslo.md' }));
    expect(note.content).toContain('Trip to Oslo Wednesday');
    const found = await runtime('vault.read', doorRead(kind, capability, { operation: 'search', q: 'Oslo' }));
    expect(JSON.stringify(found)).toContain('oslo');
    // The shared area is a different area: the private note is not in it.
    const shared = await runtime('vault.read', doorRead(kind, capability, { area: 'shared' }));
    expect(shared.notes).not.toContain('_inbox/oslo.md');
    await refusedByKeeper(runtime('vault.read', doorRead(kind, capability, { operation: 'read', path: '../outside.md' })));
  }
});

// ── A note saved from a chat door, from the claimed person's exact approved card ───────────────────
// Door-neutral: every door in the door table runs the same steps. The card is reserved before it is shown (through the pass),
// answered by the claimed owner on that door, and written by Keeper, which names the member itself and rechecks the claim,
// the grant, the card (answered on this door, shown in full, unused) and the note.
const DOOR_FIXTURE_ATTRIBUTES: Record<string, Record<string, unknown>> = { slack: { channel_id: 'D0DOORDM', author_type: 'user' }, telegram: { chat_type: 'private' } };
const doorPerson = (kind: string, user = DOOR_PRINCIPAL) => ({ authenticator: Object.entries(DOORS).find(([, row]) => row.door === kind)![0], principalType: 'user',
  attributes: { user_id: user, ...DOOR_FIXTURE_ATTRIBUTES[kind]! } });
const DOOR_NOTE_CALL = 'door-call-1', DOOR_NOTE_SESSION = 'door_session_1';
const doorNoteDeps = (kind: string, now?: Date): DoorExactDeps => ({ now,
  adapter: { ...vaultNoteApprovalAdapter, readTarget: async (_db: unknown, _input: unknown, memberId: string) =>
    ({ kind: 'vault-note' as const, id: '_inbox/oslo.md', ownerMemberId: memberId, fingerprint: vaultNoteTargetFingerprint(null), approvedOrigin: 'agent' as const }) },
  pass: async () => ({ memberId: ids.member, route: { door: kind, principal: DOOR_PRINCIPAL, claimRevision: DOOR_REVISION },
    point: { sessionId: DOOR_NOTE_SESSION, turnId: 'turn_0', sequence: 0, incarnation }, capability: 'c'.repeat(43) }),
  isOwner: (_authenticator, userId) => userId === DOOR_PRINCIPAL, db: pool as never, env: process.env,
});
const doorNoteCtx = (kind: string) => ({ callId: DOOR_NOTE_CALL, toolInput: noteInput,
  session: { id: DOOR_NOTE_SESSION, turn: { id: 'turn_0', sequence: 0 }, auth: { current: doorPerson(kind), initiator: doorPerson(kind) } } });
/** A door card, reserved, shown, answered by the owner and read back as the running call sees it. */
async function approvedDoorNote(kind: string, shown: boolean | null = true, now?: Date) {
  await realAreasAndTurn();
  await doorFixture(kind);
  vi.stubEnv(claimEnvNames(kind).principal, DOOR_PRINCIPAL); vi.stubEnv(claimEnvNames(kind).revision, DOOR_REVISION);
  const ctx = doorNoteCtx(kind), deps = doorNoteDeps(kind, now), person = doorPerson(kind);
  await reserveDoorExactApproval(ctx, 'agent-kit__vault_write', deps);
  await attachDoorExactApproval({ requestId: 'door-request-1', callId: DOOR_NOTE_CALL, tool: 'agent-kit__vault_write', input: noteInput }, pool as never);
  await pool.query('UPDATE approval_asks SET door=$1, shown_whole=$2 WHERE call_id=$3', [kind, shown, DOOR_NOTE_CALL]);
  expect(await approveDoorExactResponse({ request: { interactionId: 'door-request-1', callId: DOOR_NOTE_CALL, toolName: 'agent-kit__vault_write', toolInput: noteInput },
    response: { decision: 'approve', principal: person }, session: { id: DOOR_NOTE_SESSION, initiator: person } }, deps)).toEqual({ status: 'allowed' });
  const approved = await requireDoorApprovedExecution({ ...ctx, approval: { responder: person } } as never, 'agent-kit__vault_write', noteInput, deps).catch(() => undefined);
  return { approved, ctx, deps, person };
}
const doorWrite = (kind: string, approved: any, over: Record<string, unknown> = {}) => runtime('vault.write', { sessionId: DOOR_NOTE_SESSION, door: kind, principal: DOOR_PRINCIPAL,
  claimRevision: DOOR_REVISION, approval: noteProof(approved), input: noteInput, ...over });
const doorNoteUses = async () => (await pool.query('SELECT use_count FROM approval_asks WHERE call_id=$1', [DOOR_NOTE_CALL])).rows[0].use_count;

it('has a door fixture here for every door in the table, so a new door cannot skip the note checks', () => {
  expect([...DOOR_KINDS].sort()).toEqual(Object.keys(DOOR_FIXTURE_ATTRIBUTES).sort());
});

for (const kind of DOOR_KINDS) {
  it(`${kind}: writes one private note from the claimed person's approved card, once, as the member Keeper names`, async () => {
    const { approved } = await approvedDoorNote(kind);
    expect(approved).toBeDefined();
    const vaultRoot = join(root, 'vault-files'), notePath = join(vaultRoot, `vault/private/${ids.area}/_inbox/oslo.md`);
    // The agent names the door claim and never a member or an admission; Keeper refuses a call that names either.
    await refusedByKeeper(doorWrite(kind, approved, { memberId: ids.member }));
    await refusedByKeeper(doorWrite(kind, approved, { admissionNonce }));
    await refusedByKeeper(doorWrite(kind, approved, { input: { ...noteInput, body: 'Changed after approval' } }));
    expect(await doorNoteUses()).toBe(0);
    const result = await doorWrite(kind, approved);
    expect(result.path).toBe('_inbox/oslo.md');
    const content = readFileSync(notePath, 'utf8');
    expect(content).toContain('title: Oslo');
    expect(content).toContain('lares_origin: agent');
    expect(content).toContain('Trip to Oslo Wednesday');
    expect(execFileSync('git', ['-C', join(root, 'vault-origins', `${ids.area}.git`), 'log', '-1', '--format=%H'], { encoding: 'utf8' }).trim()).toMatch(new RegExp(`^${result.commit}`));
    expect(await doorNoteUses()).toBe(1);
    // A replay writes nothing.
    await refusedByKeeper(doorWrite(kind, approved));
    expect(await doorNoteUses()).toBe(1);
  });

  it(`${kind}: refuses a door note card that was cut or whose record cannot say it was whole, another door, another claim and a swapped card kind`, async () => {
    const { approved, deps, ctx, person } = await approvedDoorNote(kind, false);
    // The agent-side check already refuses a cut card, so take the call from an approval that was whole, then cut the record.
    expect(approved).toBeUndefined();
    await pool.query('UPDATE approval_asks SET shown_whole=true WHERE call_id=$1', [DOOR_NOTE_CALL]);
    const whole = await requireDoorApprovedExecution({ ...ctx, approval: { responder: person } } as never, 'agent-kit__vault_write', noteInput, deps);
    for (const shown of [false, null]) {
      await pool.query('UPDATE approval_asks SET shown_whole=$1 WHERE call_id=$2', [shown, DOOR_NOTE_CALL]);
      await refusedByKeeper(doorWrite(kind, whole));
    }
    await pool.query('UPDATE approval_asks SET shown_whole=true WHERE call_id=$1', [DOOR_NOTE_CALL]);
    for (const other of DOOR_KINDS.filter((k) => k !== kind)) await refusedByKeeper(doorWrite(kind, whole, { door: other }));
    await refusedByKeeper(doorWrite(kind, whole, { principal: 'U0SOMEONEELSE' }));
    await refusedByKeeper(doorWrite(kind, whole, { claimRevision: '6d1c0000-0000-4000-8000-000000000002' }));
    await refusedByKeeper(doorWrite(kind, whole, { sessionId: 'door_session_2' }));
    await refusedByKeeper(doorWrite(kind, whole, { extra: true }));
    // Answered under another door's name: not this door's card.
    await pool.query('UPDATE approval_asks SET answered_via=$1 WHERE call_id=$2', ['console', DOOR_NOTE_CALL]);
    await refusedByKeeper(doorWrite(kind, whole));
    await pool.query('UPDATE approval_asks SET answered_via=$1 WHERE call_id=$2', [kind, DOOR_NOTE_CALL]);
    // A door card is no console card.
    await refusedByKeeper(runtime('vault.write', { sessionId: DOOR_NOTE_SESSION, memberId: ids.member, admissionNonce, approval: noteProof(whole), input: noteInput }));
    expect(await doorNoteUses()).toBe(0);
    await expect(doorWrite(kind, whole)).resolves.toMatchObject({ path: '_inbox/oslo.md' });
  });

  it(`${kind}: refuses once the claim moved on, the owner was demoted or the use grant changed, and a note that appeared after the card`, async () => {
    const { approved } = await approvedDoorNote(kind);
    const repo = join(root, 'vault-files', `vault/private/${ids.area}`), notePath = join(repo, '_inbox/oslo.md');
    await pool.query("UPDATE agent_door_connections SET revision='6d1c0000-0000-4000-8000-000000000009',applied_revision='6d1c0000-0000-4000-8000-000000000009' WHERE agent=$1 AND kind=$2", [agent, kind]);
    await refusedByKeeper(doorWrite(kind, approved));
    await pool.query('UPDATE agent_door_connections SET revision=$3,applied_revision=$3 WHERE agent=$1 AND kind=$2', [agent, kind, DOOR_REVISION]);
    await pool.query("UPDATE users SET org_role='member' WHERE id=$1", [ids.member]);
    await refusedByKeeper(doorWrite(kind, approved));
    await pool.query("UPDATE users SET org_role='owner' WHERE id=$1", [ids.member]);
    expect(await doorNoteUses()).toBe(0);
    mkdirSync(dirname(notePath), { recursive: true }); writeFileSync(notePath, 'written meanwhile');
    execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' }); execFileSync('git', ['-C', repo, 'commit', '-m', 'meanwhile'], { stdio: 'ignore' });
    await refusedByKeeper(doorWrite(kind, approved));
    expect(await doorNoteUses()).toBe(0);
    expect(readFileSync(notePath, 'utf8')).toBe('written meanwhile');
  });

  it(`${kind}: refuses a door card that has run out`, async () => {
    // The card was made a day and a minute ago (the agent side, on that clock, still takes it); Keeper's clock says it has run out.
    const { approved } = await approvedDoorNote(kind, true, new Date(Date.now() - 24 * 60 * 60 * 1000 - 60_000 + 5_000));
    expect(approved).toBeDefined();
    await refusedByKeeper(doorWrite(kind, approved));
    expect(await doorNoteUses()).toBe(0);
  });
}

// ─── A lookup the owner let run without a card ─────────────────────────────────────────────
describe('a lookup under the owner\'s standing trust',()=>{
 const lookupTool={name:'lookup',description:'Looks up a company.',inputSchema:{type:'object'}};
 const createTool={name:'create_note',description:'Writes a note.',inputSchema:{type:'object'}};
 async function trustedFixture(over:{trust?:'none'|'write'|'stale-pin'|'danger'|'danger-stale';pinRow?:'ok'|'missing'|'unaccepted'|'moved'}={}){
  const {toolPinHash,entryConfigHash}=await import('../../../packages/agent-kit/src/outside-pins.js');
  const grant={tool:over.trust==='write'?'create_note':'lookup',by:ids.member,at:'2026-11-20T10:00:00.000Z',
   pin:toolPinHash(over.trust==='stale-pin'?{...lookupTool,description:'Older words.'}:lookupTool)};
  const dangerGrant={tool:'create_note',by:ids.member,at:'2026-11-25T10:00:00.000Z',pin:toolPinHash(over.trust==='danger-stale'?{...createTool,description:'Older words.'}:createTool)};
  const isDanger=over.trust==='danger'||over.trust==='danger-stale';
  const tools={allow:['lookup','create_note'],read:['lookup'],...(over.trust==='none'?{}:isDanger?{danger:[dangerGrant]}:{trusted:[grant]})};
  roleDefinition=definitionSchema.parse({...defaultRoleDefinition,
   grants:[...defaultRoleDefinition.grants,{capability:'outside',scope:'write-with-confirm'}],autonomy:{...defaultRoleDefinition.autonomy,outside:'gated'},
   outsideTools:[{name:'registry',url:'https://tools.example.org/mcp',description:'Lookup',token:true,tools}]});
  definitionHash=hashOf({definition:roleDefinition,dutiesMd,voiceMd});
  session='trusted_'+randomUUID().replaceAll('-','');admissionNonce=createHash('sha256').update(randomUUID()).digest('base64url');
  await pool.query("UPDATE agent_definitions SET definition=$1,hash=$2 WHERE name=$3",[roleDefinition,definitionHash,agent]);
  await pool.query('UPDATE agent_resources SET applied_definition=$1 WHERE name=$2',[roleDefinition,agent]);
  await pool.query('DELETE FROM outside_tool_pins WHERE agent=$1',[agent]);
  const entry=roleDefinition.outsideTools![0]!;
  if(over.pinRow!=='missing')await pool.query(
   `INSERT INTO outside_tool_pins(agent,tool,config_hash,pin_hash,pin_tools,seen_hash) VALUES($1,'registry',$2,$3,$4::jsonb,$5)`,
   [agent,entryConfigHash(entry),'e'.repeat(64),JSON.stringify([over.pinRow==='moved'?{...lookupTool,description:'Changed words.'}:lookupTool,over.pinRow==='moved'?{...createTool,description:'Changed words.'}:createTool]),over.pinRow==='unaccepted'?'f'.repeat(64):null]);
  expect(await new PgGrantStore(pool).captureUse(ids.member,agent)).toBeDefined();
  await bindConsoleSession({agent,incarnation,sessionId:session,memberId:ids.member,admissionNonce},pool as never,env);
  ids.outsideApprove.mockResolvedValue(undefined);
  ids.outsideDispatch.mockResolvedValue({content:[{type:'text',text:'Fixture result'}]});
  const call={callId:randomUUID(),connectionName:'registry',toolName:over.trust==='write'||over.trust==='danger'||over.trust==='danger-stale'?'create_note':'lookup',input:{company:'Example'}};
  return {call,binding:{sessionId:session,memberId:ids.member,admissionNonce}};
 }
 const audits=async()=>(await pool.query("SELECT actor,input,outcome,detail FROM keeper_audit WHERE action='outside.run-trusted'")).rows;

 it('runs a trusted lookup with no card, writes who granted the trust, and passes the call through the same custody path',async()=>{
  const f=await trustedFixture();
  expect(await runtime('outside.run-trusted',{...f.binding,call:f.call})).toMatchObject({result:{content:[{type:'text',text:'Fixture result'}]}});
  expect(ids.outsideApprove).toHaveBeenCalledOnce();expect(ids.outsideDispatch).toHaveBeenCalledOnce();
  const rows=await audits();expect(rows).toHaveLength(1);
  expect(rows[0]!.input).toMatchObject({agent,connection:'registry',tool:'lookup',sessionId:session,callId:f.call.callId,trustGrantedBy:ids.member,trustGrantedAt:'2026-11-20T10:00:00.000Z'});
  expect(rows[0]!.outcome).toBe('ok');
 });
 it('runs a tool from the danger zone with no card, and the audit says it was the danger zone',async()=>{
  const f=await trustedFixture({trust:'danger'});
  expect(await runtime('outside.run-trusted',{...f.binding,call:f.call})).toMatchObject({result:{content:[{type:'text',text:'Fixture result'}]}});
  const rows=await audits();expect(rows).toHaveLength(1);
  expect(rows[0]!.input).toMatchObject({agent,connection:'registry',tool:'create_note',dangerZone:true,trustGrantedBy:ids.member,trustGrantedAt:'2026-11-25T10:00:00.000Z',trustPin:expect.stringMatching(/^[0-9a-f]{64}$/)});
  expect(rows[0]!.outcome).toBe('ok');
 });
 it('refuses a danger-zone tool once its description moved, was never accepted, or its stored words are gone',async()=>{
  for(const over of [{trust:'danger-stale' as const},{trust:'danger' as const,pinRow:'moved' as const},{trust:'danger' as const,pinRow:'unaccepted' as const},{trust:'danger' as const,pinRow:'missing' as const}]){
   const f=await trustedFixture(over);
   await expect(runtime('outside.run-trusted',{...f.binding,call:f.call})).rejects.toThrow();
  }
  expect(ids.outsideDispatch).not.toHaveBeenCalled();
 });
 it('never writes the call\'s arguments into the audit, whatever strings they hold',async()=>{
  const f=await trustedFixture();
  f.call.input={company:'Example-secret-one',nested:{note:'Example-secret-two',list:['Example-secret-three']},n:42} as never;
  await runtime('outside.run-trusted',{...f.binding,call:f.call});
  const text=JSON.stringify(await audits());
  for(const secret of ['Example-secret-one','Example-secret-two','Example-secret-three'])expect(text).not.toContain(secret);
 });
 it('records the real outcome: failed when the custody dispatch fails',async()=>{
  const f=await trustedFixture();ids.outsideDispatch.mockRejectedValue(new Error('provider down'));
  await expect(runtime('outside.run-trusted',{...f.binding,call:f.call})).rejects.toThrow();
  const rows=await audits();expect(rows).toHaveLength(1);expect(rows[0]!.outcome).toBe('failed');
 });
 it('says so loudly and opens a repair when the audit row cannot be closed, instead of leaving a run pending unnoticed',async()=>{
  const f=await trustedFixture();
  const logged=vi.spyOn(console,'error').mockImplementation(()=>{});
  ids.outsideDispatch.mockImplementation(async()=>{
   // The audit table disappears for the closing write only; the broker awaits that write before it answers.
   await pool.query('ALTER TABLE keeper_audit RENAME TO keeper_audit_away');
   return {content:[{type:'text',text:'Fixture result'}]};
  });
  try{
   await runtime('outside.run-trusted',{...f.binding,call:f.call});
   await pool.query('ALTER TABLE keeper_audit_away RENAME TO keeper_audit');
   expect(logged.mock.calls.map(c=>String(c[0])).join('\n')).toMatch(/could not close the audit row/);
   const repairs=await pool.query("SELECT kind,severity,what FROM repairs WHERE kind='outside-audit-open'");
   expect(repairs.rows).toHaveLength(1);expect(repairs.rows[0].severity).toBe('error');
   expect((await audits())[0]!.outcome).toBe('pending');
  }finally{logged.mockRestore();await pool.query('ALTER TABLE IF EXISTS keeper_audit_away RENAME TO keeper_audit').catch(()=>{});}
 });
 it.each(['session','member','nonce'])('refuses a call under the wrong %s, before any custody call',async(kind)=>{
  const f=await trustedFixture();
  const binding={...f.binding,...(kind==='session'?{sessionId:'another-session'}:kind==='member'?{memberId:'member-backup'}:{admissionNonce:'x'.repeat(43)})};
  await expect(runtime('outside.run-trusted',{...binding,call:f.call})).rejects.toThrow();
  expect(ids.outsideApprove).not.toHaveBeenCalled();expect(ids.outsideDispatch).not.toHaveBeenCalled();
  expect(await audits()).toHaveLength(0);
 });
 it.each([
  ['the tool was never switched on',{trust:'none' as const}],
  ['a tool that changes something is listed as trusted',{trust:'write' as const}],
  ['the description the owner switched on has changed',{trust:'stale-pin' as const}],
  ['the pinned description has moved on',{pinRow:'moved' as const}],
  ['a description change is waiting for the owner',{pinRow:'unaccepted' as const}],
  ['no description has been pinned yet',{pinRow:'missing' as const}],
 ])('refuses when %s, before any custody call',async(_name,over)=>{
  const f=await trustedFixture(over);
  await expect(runtime('outside.run-trusted',{...f.binding,call:f.call})).rejects.toThrow();
  expect(ids.outsideApprove).not.toHaveBeenCalled();expect(ids.outsideDispatch).not.toHaveBeenCalled();
  expect(await audits()).toHaveLength(0);
 });
 it('refuses when the session is revoked or the outside level is never',async()=>{
  let f=await trustedFixture();
  await pool.query('UPDATE console_session_bindings SET revoked_at=clock_timestamp() WHERE session_id=$1',[session]);
  await expect(runtime('outside.run-trusted',{...f.binding,call:f.call})).rejects.toThrow();
  f=await trustedFixture();
  await pool.query("INSERT INTO ratchet(agent,capability,action,level) VALUES($1,'outside','','never') ON CONFLICT DO NOTHING",[agent]);
  await expect(runtime('outside.run-trusted',{...f.binding,call:f.call})).rejects.toThrow();
  expect(ids.outsideDispatch).not.toHaveBeenCalled();
 });
 it('records the accepted descriptions as the pin each time they are read, so a switch can be made and a changed description ends it',async()=>{
  const {toolPinHash}=await import('../../../packages/agent-kit/src/outside-pins.js');
  const f=await trustedFixture({pinRow:'missing'});
  expect((await pool.query('SELECT 1 FROM outside_tool_pins WHERE agent=$1',[agent])).rows).toHaveLength(0);
  ids.outsideTools.mockResolvedValue([lookupTool]);
  await runtime('outside.tools',{sessionId:session,memberId:ids.member,admissionNonce,connectionName:'registry'});
  const pinned=await pool.query('SELECT pin_tools,seen_hash FROM outside_tool_pins WHERE agent=$1 AND tool=$2',[agent,'registry']);
  expect(pinned.rows).toHaveLength(1);expect(pinned.rows[0].seen_hash).toBeNull();expect(toolPinHash(pinned.rows[0].pin_tools[0])).toBe(toolPinHash(lookupTool));
  // The trust made for those words now runs; after the owner accepts new words, it no longer matches and the call is refused.
  expect(await runtime('outside.run-trusted',{...f.binding,call:f.call})).toMatchObject({result:expect.anything()});
  ids.outsideTools.mockResolvedValue([{...lookupTool,description:'New words.'}]);
  await runtime('outside.tools',{sessionId:session,memberId:ids.member,admissionNonce,connectionName:'registry'});
  await expect(runtime('outside.run-trusted',{...f.binding,call:{...f.call,callId:randomUUID()}})).rejects.toThrow();
 });
 describe('on a chat door: the claimed person in a private chat, no console session',()=>{
  const doorInput=(kind:string,f:{call:unknown},over:Record<string,unknown>={})=>({door:kind,principal:DOOR_PRINCIPAL,claimRevision:DOOR_REVISION,chat:'private',sessionId:'door_session_1',call:f.call,...over});
  it.each(DOOR_KINDS)('%s: runs a trusted lookup under the claim, asks custody as a door call for Keeper\'s own owner, and audits the door',async(kind)=>{
   const f=await trustedFixture();await doorFixture(kind);
   expect(await runtime('outside.run-trusted',doorInput(kind,f))).toMatchObject({result:{content:[{type:'text',text:'Fixture result'}]}});
   expect(ids.outsideApprove).toHaveBeenCalledOnce();expect(ids.outsideDispatch).toHaveBeenCalledOnce();
   expect(ids.outsideApprove.mock.calls[0]![0]).toMatchObject({agent,incarnation,sessionId:'door_session_1',memberId:ids.member,approverMemberId:ids.member,door:true,admissionNonce:''});
   expect(ids.outsideDispatch.mock.calls[0]![0]).toMatchObject({memberId:ids.member,door:true});
   const rows=await audits();expect(rows).toHaveLength(1);expect(rows[0]!.input).toMatchObject({door:kind,connection:'registry',tool:'lookup',trustGrantedBy:ids.member});expect(rows[0]!.outcome).toBe('ok');
  });
  it.each([
   ['the wrong person',{principal:'U0SOMEONEELSE'}],['a stale claim',{claimRevision:'6d1c0000-0000-4000-8000-000000000002'}],
   ['a shared room',{chat:'shared-room'}],['no chat kind',{chat:undefined}],['an unknown door',{door:'carrier-pigeon'}],
   ['a member named by the agent',{memberId:ids.member}],['an admission sent along',{admissionNonce:'x'.repeat(43)}],
  ])('refuses %s, before any custody call',async(_name,over)=>{
   const kind=DOOR_KINDS[0]!,f=await trustedFixture();await doorFixture(kind);
   await expect(runtime('outside.run-trusted',doorInput(kind,f,over))).rejects.toThrow();
   expect(ids.outsideApprove).not.toHaveBeenCalled();expect(ids.outsideDispatch).not.toHaveBeenCalled();expect(await audits()).toHaveLength(0);
  });
  it('refuses a tool the owner did not switch on, a demoted owner and a door that is no longer claimed, before any custody call',async()=>{
   const kind=DOOR_KINDS[0]!;
   let f=await trustedFixture({trust:'none'});await doorFixture(kind);
   await expect(runtime('outside.run-trusted',doorInput(kind,f))).rejects.toThrow();
   f=await trustedFixture();await doorFixture(kind);
   await pool.query("UPDATE users SET org_role='member' WHERE id=$1",[ids.member]);
   try{await expect(runtime('outside.run-trusted',doorInput(kind,f))).rejects.toThrow();}finally{await pool.query("UPDATE users SET org_role='owner' WHERE id=$1",[ids.member]);}
   f=await trustedFixture();await pool.query('DELETE FROM agent_door_connections WHERE agent=$1',[agent]);
   await expect(runtime('outside.run-trusted',doorInput(kind,f))).rejects.toThrow();
   expect(ids.outsideApprove).not.toHaveBeenCalled();expect(ids.outsideDispatch).not.toHaveBeenCalled();expect(await audits()).toHaveLength(0);
  });
  it.each(DOOR_KINDS)('%s: lists the accepted descriptions for the claimed person, and only under a good claim',async(kind)=>{
   await trustedFixture();await doorFixture(kind);ids.outsideTools.mockResolvedValue([lookupTool]);
   const ask=(over:Record<string,unknown>={})=>runtime('outside.tools',{door:kind,principal:DOOR_PRINCIPAL,claimRevision:DOOR_REVISION,chat:'private',sessionId:'door_session_1',connectionName:'registry',...over});
   expect(await ask()).toMatchObject({tools:[lookupTool]});
   expect(ids.outsideTools.mock.calls[0]![0]).toMatchObject({memberId:ids.member,door:true,sessionId:'door_session_1'});
   ids.outsideTools.mockClear();
   for(const over of [{principal:'U0SOMEONEELSE'},{chat:'shared-room'},{memberId:ids.member}])await expect(ask(over)).rejects.toThrow();
   expect(ids.outsideTools).not.toHaveBeenCalled();
  });
 });
 it('refuses when the definition the agent runs under no longer lists the trust',async()=>{
  const f=await trustedFixture();
  const without=definitionSchema.parse({...roleDefinition,outsideTools:[{...roleDefinition.outsideTools![0]!,tools:{allow:['lookup','create_note'],read:['lookup']}}]});
  await pool.query('UPDATE agent_resources SET applied_definition=$1 WHERE name=$2',[without,agent]);
  await expect(runtime('outside.run-trusted',{...f.binding,call:f.call})).rejects.toThrow();
  expect(ids.outsideDispatch).not.toHaveBeenCalled();
 });
});
