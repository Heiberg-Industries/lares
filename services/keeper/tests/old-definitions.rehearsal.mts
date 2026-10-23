//  local rehearsal (made-up data). Drives the keeper's own code (definition actions + agent
// lifecycle) against the rehearsal database, with Docker replaced by a recorder, to see what the NEW
// keeper does with two OLD-style stored definitions (grants `brain`/`atlas`/`memory`).
// It is NOT a test and is not run by `pnpm test`. Run by hand from services/keeper:
//   REHEARSAL_DATABASE_URL=postgres://lares:<password>@127.0.0.1:55432/<the rehearsal database> npx tsx tests/old-definitions.rehearsal.mts
// Needs the rehearsal database (agent_resources
// rows for chief-of-staff/creative, old-style agent_definitions rows, the identity-register rename already applied).
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { loadDefinition, doorsOf } from '@lares/agent-kit/definition';
import { deployedToolsFor } from '@lares/agent-kit/persona';
import { registerDefinitionActions } from '../lib/definitions.js';
import { resetActions, runAction } from '../lib/actions.js';
import { AgentLifecycle } from '../lib/lifecycle.js';
import type { DockerBoundary } from '../lib/docker.js';

const repo = resolve('../..');
const url = process.env.REHEARSAL_DATABASE_URL;
if (!url) throw new Error('set REHEARSAL_DATABASE_URL (the local rehearsal database, never a real one)');
const pool = new Pool({ connectionString: url });
const root = mkdtempSync(join(tmpdir(), 'lar98-keeper-'));
const dirs = Object.fromEntries(['agents', 'retired', 'secrets', 'egress'].map((d) => [d, join(root, d)]));
for (const d of Object.values(dirs)) mkdirSync(d);
const image = 'example/image@sha256:' + 'a'.repeat(64);
const ROLE: Record<string, string> = { 'chief-of-staff': 'chief-of-staff', creative: 'creative' };
const OLD: Record<string, string[]> = { 'chief-of-staff': ['brain', 'atlas', 'memory'], creative: ['atlas'] };

function template(role: string, name: string) {
  const d = JSON.parse(readFileSync(join(repo, 'packages/agent-kit/templates', role, 'definition.json'), 'utf8'));
  d.name = name; d.duties = 'duties.md';
  return d;
}
function oldStyle(name: string) {
  const d = template(ROLE[name]!, name);
  d.grants = d.grants.flatMap((g: any) => g.capability === 'vault' ? OLD[name]!.map((c) => ({ capability: c, scope: c === 'memory' ? 'write' : g.scope })) : [g]);
  d.autonomy = Object.fromEntries(Object.entries(d.autonomy).flatMap(([k, v]) => k === 'vault' ? OLD[name]!.map((c) => [c, v]) : [[k, v]]));
  return d;
}
const newStyle = (name: string) => template(ROLE[name]!, name);

const say = (s: string) => console.log(s);
const steps: string[] = [];
const docker: DockerBoundary = {
  inventory: async () => ['172.30.0.1'], config: async () => { steps.push('compose-config'); },
  start: async (n) => { steps.push('start:' + n); }, stop: async (n) => { steps.push('stop:' + n); }, remove: async () => {},
  validateSquid: async () => { steps.push('validate-squid'); }, reloadSquid: async () => { steps.push('reload-squid'); }, firewall: async (_s, check) => { steps.push('firewall:' + (check ? 'check' : 'apply')); },
};
const secret = (n: string) => { const p = join(dirs.secrets!, n); writeFileSync(p, 'made-up'); return p; };
const config: any = {
  network: 'lar98-net', subnet: '172.30.0.0/24', reservedAddresses: [], composeFile: join(root, 'compose.agents.yaml'), egressDir: dirs.egress,
  imageByRole: { 'chief-of-staff': image, creative: image }, proxyContainer: 'lares-egress-proxy', squidImage: image, firewallImage: image,
  adminDb: { host: 'db', port: 5432, user: 'lares_workflow_provisioner', database: 'postgres', passwordFile: '/secret' }, workflowTemplate: 'lares_workflow_template', workflowOwner: 'lares_workflow_owner',
  runtime: { schedulesLive: false, databaseUrl: 'postgres://lares_app@db/lares_state', workflowServer: 'postgres://lares_workflow@db/', gatewayUrl: 'https://gateway.example.test', proxyUrl: 'http://proxy:8888', passwordFile: secret('db'), workflowPasswordFile:secret('workflow-db'),
    gatewayKeys: { 'chief-of-staff': secret('cos-key'), creative: secret('creative-key') },
    google: { principal: process.env.REHEARSAL_KEEPER_PRINCIPAL ?? 'owner', tokenKeyFile: secret('token-key'), clients: { acme: { clientIdFile: secret('cid'), clientSecretFile: secret('csec') } } } },
  egress: { endpoints: {}, legacyConsumers: [], internalNetworks: ['172.30.0.0/24'], directDestinations: [], infrastructureHosts: ['gateway.example.test'] }, installationPrepared: true,
};
const lifecycle = new AgentLifecycle(pool, pool, config, { mode: 'overlay', agentsDir: dirs.agents!, secretsDir: dirs.secrets! }, docker, () => {}, () => {});
// Show the real cause behind the keeper's generic "action failed" answer.
for (const method of ['prepare', 'saved', 'reconcile'] as const) {
  const original = (lifecycle as any)[method].bind(lifecycle);
  (lifecycle as any)[method] = async (...args: unknown[]) => { try { return await original(...args); } catch (e: any) { say(`   [${method} threw] ${String(e.message).slice(0, 300).replace(/\n/g, ' / ')}`); throw e; } };
}
resetActions();
registerDefinitionActions({
  pool, agentsDir: dirs.agents!, retiredDir: dirs.retired!, secretsDir: dirs.secrets!, ceiling: async () => 3, compose: lifecycle as any, backup: { commit: async () => 'disabled' } as any,
  roleInfo: (r) => ({ roleMd: readFileSync(join(repo, 'packages/agent-kit/templates', r, 'role.md'), 'utf8'), deployedTools: deployedToolsFor(join(repo, 'services', r)) }),
});
const ctx = { actor: 'owner@example.test', audit: async () => {} };
async function attempt(label: string, fn: () => Promise<unknown>) {
  steps.length = 0;
  try { const r = await fn(); say(`${label}: OK ${JSON.stringify(r).slice(0, 220)}${steps.length ? ' | docker steps: ' + steps.join(',') : ''}`); return true; }
  catch (e: any) { say(`${label}: REFUSED/FAILED -> ${String(e.message).slice(0, 400).replace(/\n/g, ' / ')}${steps.length ? ' | docker steps: ' + steps.join(',') : ''}`); return false; }
}
const save = (name: string, definition: any) => runAction('definition.save', { name, definition, duties: 'Made-up duties.\n', voice: 'Be concise.\n' }, ctx);
const email = { kind: 'email', enabled: true, settings: {} };

try {
  // Put the two OLD-style folders on disk exactly as the keeper keeps them, and the same in the table.
  for (const name of Object.keys(ROLE)) {
    const dir = join(dirs.agents!, name); mkdirSync(dir);
    writeFileSync(join(dir, 'agent.json'), JSON.stringify(oldStyle(name), null, 2) + '\n');
    writeFileSync(join(dir, 'duties.md'), 'Made-up duties.\n'); writeFileSync(join(dir, 'voice.md'), 'Be concise.\n');
  }
  await pool.query("UPDATE agent_definitions SET definition = $2::jsonb, status='valid' WHERE name=$1", ['chief-of-staff', JSON.stringify(oldStyle('chief-of-staff'))]);
  say('--- A. the new keeper READS the three old-style definitions');
  await attempt('definition.list', async () => (await runAction('definition.list', {}, ctx) as any[]).map((x) => `${x.name}:${x.status}`));
  for (const n of Object.keys(ROLE)) await attempt('definition.get ' + n, async () => { const r: any = await runAction('definition.get', { name: n }, ctx); return JSON.parse(r.definition).grants.map((g: any) => g.capability).filter((c: string) => ['brain', 'atlas', 'memory', 'vault'].includes(c)); });
  say('--- B. save ONE definition in the new style while the other stays old-style');
  const chief = newStyle('chief-of-staff'); chief.doors = [email];
  await attempt('save chief-of-staff (new style, email door on, keeper setting ' + config.runtime.google.principal + ')', () => save('chief-of-staff', chief));
  await attempt('save creative (new style)', () => save('creative', newStyle('creative')));
  say('--- C. apply connection changes (reconcile) for chief-of-staff while the other is whatever they are now');
  const hash = (await pool.query("SELECT hash FROM agent_definitions WHERE name='chief-of-staff'")).rows[0].hash;
  await attempt('definition.reconcile chief-of-staff', () => runAction('definition.reconcile', { name: 'chief-of-staff', hash }, ctx));
  say('--- D. stored rows now');
  for (const r of (await pool.query("SELECT name,pending,pending_reason FROM agent_resources ORDER BY name")).rows) say(`resource ${r.name}: pending=${r.pending} reason=${r.pending_reason}`);
  for (const r of (await pool.query("SELECT name,status,(SELECT string_agg(g->>'capability',',') FROM jsonb_array_elements(definition->'grants') g WHERE g->>'capability' IN ('brain','atlas','memory','vault')) caps FROM agent_definitions ORDER BY name")).rows) say(`${r.name}: ${r.status} | ${r.caps}`);
} finally {
  await pool.end(); rmSync(root, { recursive: true, force: true });
}
