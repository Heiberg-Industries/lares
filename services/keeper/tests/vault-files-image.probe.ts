/** CI-only end-to-end proof for the real Keeper broker and managed Git filesystem. */
import { createHmac, randomBytes, createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { definitionSchema, hashOf } from '@lares/agent-kit/definition';
import { PgGrantStore } from '@lares/agent-kit/grant-store';
import { bindConsoleSession } from '@lares/agent-kit/console-turn-authority';
import { applyVaultStorage, previewVaultStorage, verifyVaultStorageFiles, VAULT_RECOVERY_SCRIPTS, VAULT_RECOVERY_UNITS, type VaultStorageInventory } from '@lares/agent-box/lib/vault-storage.js';
import { serveConsoleVaultBroker } from '../lib/vault-console-broker.js';
import { renderKeeperConfig } from '../../box/lib/keeper-config.js';

const root = '/proof-root', dbUrl = process.env.VAULT_PROBE_DATABASE_URL;
const member = 'vault-probe-member', organisation = 'vault-probe-org', agent = 'vault-probe-agent';
const incarnation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', admissionNonce = 'v'.repeat(43), session = 'wrun_vault_image_probe';
const runtimeKey = 'b'.repeat(64), consoleKey = 'c'.repeat(64), dutiesMd = '', voiceMd = '';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 1000, query_timeout: 2500, options: '-c statement_timeout=2500 -c lock_timeout=1000' });
let stopActiveBroker: (() => Promise<void>) | undefined;

function assertProductionKeyPath() {
  const digest = 'example.invalid/keeper@sha256:' + 'a'.repeat(64);
  const config = renderKeeperConfig({ release: '2026-10-01', images: {
    'lares-keeper': digest, 'lares-egress-proxy': digest, 'lares-firewall-helper': digest,
    'chief-of-staff': digest, creative: digest,
  }, migrations: { box: '001_baseline.sql' }, breaking: [] }, {
    project: 'vault-proof', network: 'vault-proof-network', subnet: '172.30.0.0/24',
    maintenanceAdmission: { hostDirectory: '/var/lib/lares-maintenance/admission', installationId: '11111111-1111-4111-8111-111111111111', epoch: 7 },
    proxyAddress: '172.30.0.2',
    dir: '/srv/lares', agentsDir: '/srv/lares/agents', retiredDir: '/srv/lares/retired', backupDir: '/srv/lares/backup',
    egressDir: '/srv/lares/egress', secretsDir: '/etc/lares/secrets', pgDatabase: 'lares_state',
    gatewayUrl: 'http://gateway:4000', ownerId: member, publicDoorOrigin: 'https://example.invalid',
  });
  if (config.vaultConsoleSigningKeyFile !== '/etc/lares/secrets/console-vault-signing-key')
    throw new Error('production Keeper key path changed');
}

function definition() {
  const source = JSON.parse(readFileSync(join(repo, 'packages/agent-kit/templates/chief-of-staff/agent.json'), 'utf8'));
  const parsed = definitionSchema.parse({ ...source, name: agent, grants: source.grants.map((grant: any) => grant.capability === 'vault' ? { ...grant, areas: ['private'] } : grant) });
  return parsed;
}
function syncFile(path: string, bytes: string, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  writeFileSync(path, bytes, { flag: 'w', mode });
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function stageRecoveryTooling() {
  const files: Record<string, string> = {};
  mkdirSync(join(root, 'opt/lares'), { recursive: true, mode: 0o755 });
  mkdirSync(join(root, 'etc/systemd/system'), { recursive: true, mode: 0o755 });
  for (const name of VAULT_RECOVERY_SCRIPTS) {
    const source = join(repo, 'services/box/ops', name), target = join(root, 'opt/lares', name);
    copyFileSync(source, target); files[name] = createHash('sha256').update(readFileSync(target)).digest('hex');
    chmodSync(target, 0o644);
  }
  for (const name of VAULT_RECOVERY_UNITS) {
    const source = join(repo, 'services/box/ops', name), target = join(root, 'etc/systemd/system', name);
    copyFileSync(source, target); files[name] = createHash('sha256').update(readFileSync(target)).digest('hex');
    chmodSync(target, 0o644);
  }
  const image = 'example.invalid/keeper@sha256:' + 'a'.repeat(64);
  syncFile(join(root, 'opt/lares/vault-recovery-engine-image'), image + '\n', 0o644);
  syncFile(join(root, 'opt/lares/vault-recovery.json'), JSON.stringify({ version: 1, engineImage: image, files }) + '\n', 0o644);
}
async function setup() {
  const d = definition(), definitionHash = hashOf({ definition: d, dutiesMd, voiceMd });
  await pool.query("INSERT INTO orgs(id,display_name) VALUES($1,'Vault image probe')", [organisation]);
  await pool.query("INSERT INTO users(id,display_name,status,org_role,org_id) VALUES($1,'Probe owner','active','owner',$2)", [member, organisation]);
  await pool.query('INSERT INTO org_member_policy VALUES($1,NULL)', [member]);
  await pool.query('INSERT INTO agent_definitions(name,status,hash,definition) VALUES($1,\'valid\',$2,$3::jsonb)', [agent, definitionHash, JSON.stringify(d)]);
  await pool.query(`INSERT INTO agent_resources
    (name,address,workflow_database,ownership,ownership_token,state,runtime_control_token,pending)
    VALUES($1,'172.30.0.31','vault_probe_workflow','owned',$2,'ready',$2,false)`, [agent, incarnation]);
  await new PgGrantStore(pool).adoptAgent(member, { agentName: agent, expectedDefinitionHash: definitionHash }, { designatedOwnerMemberId: member });
  await bindConsoleSession({ agent, incarnation, sessionId: session, memberId: member, admissionNonce }, pool as never, { LARES_AGENT_NAME: agent, LARES_AGENT_INCARNATION: incarnation, AGENT_OWNER_USER_ID: member });
  mkdirSync(join(root, 'secrets'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'managed-secrets'), { recursive: true, mode: 0o700 });
  syncFile(join(root, 'secrets/console-vault-signing-key'), consoleKey + '\n');
  syncFile(join(root, `managed-secrets/${agent}-runtime-control`), runtimeKey + '\n');
  stageRecoveryTooling();
  // The real-image proof must initialize and guard the same canonical paths the
  // runtime broker uses. The host-side prepare/publish steps still use a temp
  // prefix, but those bind mounts appear here as /srv and /var/lib/lares-vault-git.
  const inventory = await previewVaultStorage(pool, member);
  process.stdout.write(JSON.stringify({ inventory }));
}
async function applyStorage() {
  const inventory = await applyVaultStorage(pool, member, { rootUid: 0, runtimeUid: 10001 });
  verifyVaultStorageFiles(inventory, { rootUid: 0, runtimeUid: 10001 });
  process.stdout.write(JSON.stringify(inventory));
}
async function addCanary() {
  const inventory = JSON.parse(readFileSync(join(root, 'srv/lares/installation/vault-storage.json'), 'utf8')) as VaultStorageInventory;
  const area = inventory.areas.find(item => item.kind === 'private')!;
  const working = join(root, 'srv', area.relativePath);
  syncFile(join(working, 'owner.md'), 'PRIVATE_FILE_CANARY_VAULT_IMAGE_PROBE\n', 0o640);
  execFileSync('git', ['-C', working, 'add', '--', 'owner.md']);
  execFileSync('git', ['-C', working, 'commit', '--quiet', '-m', 'Add disposable private read canary']);
  execFileSync('git', ['-C', working, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  process.stdout.write('canary committed to the managed working and bare repositories');
}
function socketRequest(path: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(path); let data = '', settled = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolveRequest(result!);
    };
    const timer = setTimeout(() => finish(new Error('socket deadline')), 2500);
    socket.once('error', error => finish(error));
    socket.once('connect', () => socket.write(JSON.stringify(body) + '\n'));
    socket.on('data', chunk => { data += chunk.toString('utf8'); if (data.includes('\n')) { try { finish(undefined, JSON.parse(data.slice(0, data.indexOf('\n')))); } catch { finish(new Error('invalid broker response')); } } });
    socket.once('end', () => { if (!settled) finish(new Error('broker closed without a response')); });
    socket.once('close', () => { if (!settled) finish(new Error('broker closed without a response')); });
  });
}
async function brokerProof() {
  const inventory = JSON.parse(readFileSync('/srv/lares/installation/vault-storage.json', 'utf8')) as VaultStorageInventory;
  const privateArea = inventory.areas.find(item => item.kind === 'private')!, socketDir = join(root, 'run/vault');
  const consoleSocket = join(socketDir, 'console.sock'), runtimeSocket = join(socketDir, 'read.sock');
  let now = Date.now();
  const stop = await serveConsoleVaultBroker(pool as never, '/etc/lares/secrets/console-vault-signing-key', '/srv/lares/secrets', runtimeSocket, { consoleSocket, rootUid: 0, socketUid: 0, socketGid: 0, turnClockForTests: () => now });
  stopActiveBroker = stop;
  let requestCounter = 0;
  const runtime = (op: string, requestInput: Record<string, unknown>) => {
    const body = { agent, incarnation, requestId: randomBytes(24).toString('base64url'), timestamp: Date.now(), op, input: requestInput };
    const mac = createHmac('sha256', Buffer.from(runtimeKey, 'hex')).update(JSON.stringify(body)).digest('base64url'); requestCounter++;
    return socketRequest(runtimeSocket, { ...body, mac });
  };
  const turnInput = async (sessionId: string, nonce: string) => ({ agent, incarnation, session: sessionId, member, admissionNonce: nonce, method: 'POST', path: `/eve/v1/session/${sessionId}`, rawBodyHash: createHash('sha256').update(sessionId).digest('hex'), policyRevision: (await pool.query('SELECT policy_revision FROM console_session_bindings WHERE session_id=$1', [sessionId])).rows[0].policy_revision, definitionHash: hashOf({ definition: definition(), dutiesMd, voiceMd }) });
  const openTurn = async (sessionId: string, nonce: string, sequence: number) => {
    const input = await turnInput(sessionId, nonce), challenge = await socketRequest(consoleSocket, { op: 'challenge', input });
    if (challenge.ok !== true) throw new Error('real Keeper challenge refused');
    const capsuleBody = Buffer.from(JSON.stringify({ ...input, version: 1, purpose: 'human', challenge: challenge.challenge, nonce: randomBytes(24).toString('base64url'), expiry: challenge.expiry })).toString('base64url');
    const capsule = capsuleBody + '.' + createHmac('sha256', Buffer.from(consoleKey, 'hex')).update(capsuleBody).digest('base64url');
    const admitted = await runtime('request.admit', { capsule, receipt: { method: input.method, path: input.path, rawBodyHash: input.rawBodyHash } });
    if (admitted.ok !== true) throw new Error('real Keeper admission refused');
    const turnId = `01JAZ9K3M0EVE8QW4S7P1K2H${sequence ? '6S' : '6R'}`;
    const opened = await runtime('turn.open', { pendingReceipt: admitted.pendingReceipt, sessionId, memberId: member, admissionNonce: nonce, turnId, sequence, definition: { definition: definition(), dutiesMd, voiceMd, hash: input.definitionHash } });
    if (opened.ok !== true) throw new Error('real Keeper turn open refused');
    return { turnId, opened };
  };
  const first = await openTurn(session, admissionNonce, 0), turnId = first.turnId, opened = first.opened;
  const captures = await pool.query('SELECT area_id FROM console_vault_source_captures WHERE session_id=$1 ORDER BY area_id', [session]);
  if (captures.rows.length !== 1 || captures.rows[0].area_id !== privateArea.areaId) throw new Error('loaded private-only definition captured a non-private area');
  const base = { turnCapability: opened.turnCapability, sessionId: session, memberId: member, admissionNonce, turnId, sequence: 0 };
  const note = await runtime('vault.read', { ...base, operation: 'read', area: 'private', path: 'owner.md' });
  if (note.ok !== true || !(note.content as string)?.includes('PRIVATE_FILE_CANARY_VAULT_IMAGE_PROBE')) throw new Error('real managed Git private file was not returned');
  const wrongMember = await runtime('vault.read', { ...base, memberId: 'another-member', operation: 'read', area: 'private', path: 'owner.md' });
  const shared = await runtime('vault.read', { ...base, operation: 'read', area: 'shared', path: 'owner.md' });
  if (wrongMember.ok !== false || shared.ok !== false) throw new Error('wrong-member or ungranted shared read was not refused');
  const closed = await runtime('turn.close', { turnCapability: opened.turnCapability, turnId, sequence: 0 });
  const replay = await runtime('vault.read', { ...base, operation: 'read', area: 'private', path: 'owner.md' });
  if (closed.ok !== true || replay.ok !== false) throw new Error('closed capability was replayable');
  const expirySession = 'wrun_vault_expiry_probe', expiryNonce = 'w'.repeat(43);
  await bindConsoleSession({ agent, incarnation, sessionId: expirySession, memberId: member, admissionNonce: expiryNonce }, pool as never, { LARES_AGENT_NAME: agent, LARES_AGENT_INCARNATION: incarnation, AGENT_OWNER_USER_ID: member });
  const second = await openTurn(expirySession, expiryNonce, 1), secondBase = { turnCapability: second.opened.turnCapability, sessionId: expirySession, memberId: member, admissionNonce: expiryNonce, turnId: second.turnId, sequence: 1 };
  now = Number(second.opened.expiresAt) + 1;
  const expired = await runtime('vault.read', { ...secondBase, operation: 'read', area: 'private', path: 'owner.md' });
  if (expired.ok !== false) throw new Error('expired turn capability still read a file');
  await stop();
  stopActiveBroker = undefined;
  process.stdout.write(JSON.stringify({ status: 'PASS', realKeeperBroker: true, realPostgresAuthority: true, realManagedVaultInventory: true, actualGuardedVaultFiles: true, actualPrivateWorkingAndBareGit: true, privateCanary: true, privateOnlyCapture: true, wrongMemberDenied: true, sharedDeniedWithoutCapture: true, expiredCapabilityDenied: true, closedCapabilityDenied: true, providerCalls: 0, runtimeRequests: requestCounter }));
}

async function main() {
  if (!dbUrl) throw new Error('Vault probe database URL missing');
  try {
    assertProductionKeyPath();
    const mode = process.argv[2];
    if (mode === 'setup') await setup();
    else if (mode === 'apply') await applyStorage();
    else if (mode === 'canary') await addCanary();
    else if (mode === 'broker') await brokerProof();
    else throw new Error('unknown Vault proof phase');
  } finally { try { await stopActiveBroker?.(); } finally { await pool.end(); } }
}
void main().catch(error => { process.stderr.write(`Vault image probe failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
