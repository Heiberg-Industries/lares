/** HAND-RUN synthetic local probe. No providers, real credentials or installation files.
 * pnpm -C services/keeper exec tsx tests/credential-runtime.probe.mts
 * Uses an already-cached pinned node image; never pulls, builds or publishes an image.
 * Actual Docker compose recreation/mounts/health are exercised through production lifecycle.
 * Registry and seal commands are injected; their ordering/SQL are covered by focused tests.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Pool } from 'pg';
import { hashOf, parseDefinition } from '@lares/agent-kit/definition';
import { CredentialFiles } from '../lib/credential-files.js';
import { CredentialActivation } from '../lib/credential-activation.js';
import { OwnedCredentialRuntime } from '../lib/credential-runtime.js';
import { Credentials, registerCredentialActions } from '../lib/credentials.js';
import { credentialRecordSchema, initialCredentialRecord } from '../lib/credential-state.js';
import { AgentLifecycle } from '../lib/lifecycle.js';
import { ownedDocker } from '../lib/docker.js';
import { nextAddress } from '../lib/compose-agents.js';
import type { KeeperConfig } from '../lib/config.js';
import { runAction, resetActions } from '../lib/actions.js';
import type { CredentialJournal } from '../lib/credential-store.js';

const execute = promisify(execFile);
const run = async (args: string[]) => (await execute('docker', args, { timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.trim();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'lares-credential-probe-')));
const project = `lares-credential-probe-${randomUUID().slice(0, 8)}`, network = `${project}_isolated`;
const composeFile = join(root, 'compose.yaml'); let networkCreated = false;
const compose = (args: string[]) => run(['compose', '--project-name', project, '--project-directory', root, '-f', composeFile, ...args]);
try {
  const image = JSON.parse(await run(['image', 'inspect', 'node:24-bookworm-slim', '--format', '{{json .RepoDigests}}']))[0];
  assert.match(image, /@sha256:[a-f0-9]{64}$/);
  await run(['network', 'create', '--internal', network]); networkCreated = true;
  const net = JSON.parse(await run(['network', 'inspect', network]))[0];
  const subnet = net.IPAM.Config[0].Subnet, address = nextAddress([net.IPAM.Config[0].Gateway], subnet);
  const agentsDir = join(root, 'agents'), secretsDir = join(root, 'secrets'), egressDir = join(root, 'egress'), dir = join(agentsDir, 'example');
  mkdirSync(dir, { recursive: true }); mkdirSync(secretsDir, { mode: 0o700 }); chmodSync(secretsDir, 0o700); mkdirSync(egressDir);
  const definition = parseDefinition({ ...JSON.parse(readFileSync(new URL('../../../packages/agent-kit/templates/creative/agent.json', import.meta.url), 'utf8')), name: 'example', role: 'creative', doors: [], grants: [], autonomy: {} });
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(definition)); writeFileSync(join(dir, 'duties.md'), ''); writeFileSync(join(dir, 'voice.md'), '');
  writeFileSync(join(dir, 'probe.mjs'), `import{openSync,readFileSync,fstatSync}from'node:fs';import{createServer}from'node:http';
const fd=process.env.NOTION_TOKEN_FILE?openSync(process.env.NOTION_TOKEN_FILE,'r'):null;
createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/eve/v1/health'?{ok:true}:fd===null?{value:'absent',inode:null}:{value:readFileSync(fd,'utf8'),inode:String(fstatSync(fd).ino)}));}).listen(3000,'0.0.0.0');`);
  for (const file of ['gateway', 'db', 'example-runtime-control', 'unrelated']) writeFileSync(join(secretsDir, file), 'synthetic-only', { mode: 0o600 });
  const files = new CredentialFiles(secretsDir, { uid: process.getuid!(), gid: process.getgid!() });
  writeFileSync(files.activePath, 'old-synthetic', { mode: 0o600 });
  const oldRevision = randomUUID(), incarnation = randomUUID();
  let record = { ...initialCredentialRecord(), version: 1, activeRevision: oldRevision, phase: 'applied' as const };
  const journal: CredentialJournal = { read: async () => record, save: async (old, next) => { assert.equal(old.version, record.version); record = credentialRecordSchema.parse({ ...next, version: old.version + 1 }) as typeof record; return record; } };
  const store = { read: journal.read, locked: async <T,>(fn: (j: CredentialJournal) => Promise<T>) => fn(journal) };
  const row = { name: 'example', definition, applied_definition: definition, duties: '', voice: '', hash: hashOf({ definition, dutiesMd: '', voiceMd: '' }), status: 'valid', address,
    workflow_database: 'probe_workflow', ownership: 'owned', ownership_token: incarnation, runtime_control_token: incarnation, state: 'ready', pending: false };
  const pool = { query: async (sql: string) => ({ rows: sql.includes('agent_door_connections') ? [] : [row] }), connect: async () => ({ query: async () => ({ rows: [{ acquired: true }] }), release: () => {} }) } as unknown as Pool;
  const config = { project, dir: root, agentsDir, secretsDir, credentials: { administrator: 'admin@example.invalid', slot: 'notion:shared', binding: 'NOTION_TOKEN_FILE', prepared: true, inventoryComplete: true, retainedConsumers: [] }, lifecycle: {
    network, subnet, reservedAddresses: [], composeFile, egressDir, imageByRole: { creative: image, travel: image, 'chief-of-staff': image }, proxyContainer: 'lares-egress-proxy', squidImage: image, firewallImage: image,
    workflowTemplate: 'probe_template', workflowOwner: 'probe_owner', runtime: { schedulesLive: false, databaseUrl: 'postgres://probe@db/test', workflowServer: 'postgres://probe@db/', gatewayUrl: 'https://gateway.example.invalid', proxyUrl: 'http://proxy:8888', passwordFile: join(secretsDir, 'db'), gatewayKeys: { example: join(secretsDir, 'gateway') } },
    bindings: { example: { role: 'creative', mounts: [], environment: {}, secrets: { NOTION_TOKEN_FILE: files.activePath, EVE_ROUTE_PASSWORD_FILE: join(secretsDir, 'unrelated') } } },
    egress: { endpoints: {}, legacyConsumers: [], internalNetworks: [subnet], directDestinations: [], infrastructureHosts: [] }, installationPrepared: true,
  } } as unknown as KeeperConfig;
  const request = async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    const body = await compose(['exec', '-T', 'lares-example', 'node', '-e', `fetch('http://127.0.0.1:3000${path}',{signal:AbortSignal.timeout(1000)}).then(r=>r.text()).then(console.log).catch(()=>process.exit(1))`]);
    return new Response(body, { status: 200 });
  };
  const real = ownedDocker({ ...config.lifecycle!, project, dir: root }, request as typeof fetch, async () => {});
  let failStart = false;
  const docker = { ...real, validateSquid: async () => {}, reloadSquid: async () => {}, firewall: async () => {},
    config: async () => {
      const doc = parse(readFileSync(composeFile, 'utf8'));
      // Synthetic root-only test service; no engine, providers or real secrets are loaded.
      doc.services['lares-example'].user = '0:0'; doc.services['lares-example'].entrypoint = ['node', '/definition/probe.mjs'];
      writeFileSync(composeFile, stringify(doc)); await real.config();
    },
    start: async (name: string, ip: string, force?: boolean) => { if (failStart) { failStart = false; throw new Error('synthetic restart failure'); } await real.start(name, ip, force); },
  };
  const lifecycle = new AgentLifecycle(pool, pool, config.lifecycle!, config, docker, () => {}, () => {}, { ensure: async () => { throw new Error('Provider forbidden'); }, remove: async () => { throw new Error('Provider forbidden'); } });
  lifecycle.setCredentialState(store.read);
  // Bootstrap the synthetic old runtime through the same reconciler, then complete its journal.
  const completed = record;
  record = { ...record, effectiveRevision: oldRevision, activationIntent: { previousRevision: oldRevision, targetRevision: oldRevision, prepared: true, finishing: false, inventoryRevision: 'a'.repeat(64) } } as typeof record;
  await lifecycle.reconcileCredential('example', oldRevision); record = completed;
  const read = async () => JSON.parse(await (await request(`http://${address}:3000/probe`)).text());
  const before = await read(); assert.equal(before.value, 'old-synthetic');
  const consumers = [{ name: 'example', category: 'owned-agent' as const, incarnation }];
  const credentials = new Credentials(config.credentials, store, files, async () => consumers, { ready: () => true, test: async () => ({ outcome: 'passed' }) }, new CredentialActivation(files, new OwnedCredentialRuntime(pool, config, lifecycle, docker)));
  registerCredentialActions(credentials); const ctx = { actor: 'admin@example.invalid', audit: async () => {} };
  const stage = () => runAction('credential.test_save', { slot: 'notion:shared', expectedRevision: record.version, token: 'new-synthetic' }, ctx);
  const apply = async () => { const status = await credentials.status(ctx); return runAction('credential.apply', { slot: 'notion:shared', expectedRevision: record.version, expectedActiveRevision: record.activeRevision, inventoryRevision: status.inventoryRevision, confirmRestart: true }, ctx); };
  await stage(); assert.equal((await read()).inode, before.inode); assert.equal(files.readActive(), 'old-synthetic');
  failStart = true; await assert.rejects(apply(), /outcome uncertain/); assert.equal(files.readActive(), 'old-synthetic'); assert.equal((await read()).value, 'old-synthetic'); assert.equal(record.phase, 'applied');
  await stage(); await apply(); const after = await read(); assert.equal(after.value, 'new-synthetic'); assert.notEqual(after.inode, before.inode); assert.equal(record.phase, 'applied');
  console.log(JSON.stringify({ outcome: 'passed', synthetic: true, providerCalls: 0, stagePreservedRunningInode: true, restartFailureRolledBack: true, recreatedNewInode: true, scope: 'local-container-lifecycle', databaseAndSeals: 'injected' }));
} finally {
  if (networkCreated) {
    try { if (readFileSync(composeFile, 'utf8')) await compose(['down', '--timeout', '2']); } finally { await run(['network', 'rm', network]); }
  }
  resetActions(); rmSync(root, { recursive: true, force: true });
}
