// The updater's agent-store step against a real PostgreSQL, with the real roles.
//
// What is real here: the server, the three workflow roles as bin/database-setup.ts creates them,
// databases built EXACTLY as the previous release's workflow package left them (its first 20
// schema steps, applied by the package's own migrator as the provisioner with the owner role),
// the previous release's grants, and every program the updater runs: bin/workflow-template.ts
// (update-plan, apply, apply-database, verify-database), bin/database-setup.ts
// --verify-workflow-template, and ops/workflow-store-migrate.mjs fed to node on standard input
// from services/creative, as the role image runs it.
//
// What is not: update.sh itself (tests/update-script.test.ts drives its order and its refusals
// with stubs) and the role image (the program runs on this machine's node, from the checkout).
// `upgradeStores` below is the same sequence update.sh runs, in the same order.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKFLOW_SCHEMA_STEPS, WORKFLOW_SCHEMA_STEPS_BEFORE, verifyWorkflowRuntimePrivileges } from '../lib/workflow-database-privileges.js';
import { quiet } from './helpers/quiet-pool.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const box = join(repo, 'services/box');
const creative = join(repo, 'services/creative');
const tsx = join(repo, 'node_modules/.bin/tsx');
const program = readFileSync(join(box, 'ops/workflow-store-migrate.mjs'));
const TEMPLATE = 'empty_workflow';
const STORE_A = `lares_${'a'.repeat(32)}`;
const STORE_B = `lares_${'b'.repeat(32)}`;
const ALL = [TEMPLATE, STORE_A, STORE_B];
const PREVIOUS_TABLES = ['workflow_event_slots', 'workflow_events', 'workflow_hooks', 'workflow_runs', 'workflow_steps', 'workflow_stream_chunks', 'workflow_waits'];
const NEW_TABLES = ['workflow_invocations', 'workflow_snapshots', 'workflow_start_hook_admissions'];
const QUEUE_TABLES = ['_private_job_queues', '_private_jobs', '_private_known_crontabs', '_private_tasks'];

const secretDir = mkdtempSync(join(tmpdir(), 'lares-store-update-'));
chmodSync(secretDir, 0o700);
const secretPaths = new Map<string, string>();
for (const name of ['operator', 'app', 'financial', 'outside', 'provisioner', 'workflow', 'gateway']) {
  const path = join(secretDir, `${name}-password`);
  writeFileSync(path, randomBytes(36).toString('base64url'), { mode: 0o600 });
  secretPaths.set(name, path);
}
const secret = (name: string) => secretPaths.get(name)!;
const password = (name: string) => readFileSync(secret(name), 'utf8').trim();

type Outcome = { code: number | null; stdout: string; stderr: string };
function run(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: Buffer | string; timeout?: number; onStart?: (kill: () => void) => void }): Promise<Outcome> {
  return new Promise((done, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 120_000);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
    child.stdin.end(options.input ?? '');
    options.onStart?.(() => child.kill('SIGKILL'));
  });
}

let pg: StartedPostgreSqlContainer;
let admin: Pool;
let env: NodeJS.ProcessEnv;
let host = '';
let port = '';

const login = (user: string, secretName: string, database: string, options?: string) =>
  quiet(new Pool({ host, port: Number(port), database, user, password: password(secretName), max: 1, options }));
async function using<T>(pool: Pool, work: (pool: Pool) => Promise<T>): Promise<T> {
  try { return await work(pool); } finally { await pool.end(); }
}
const asOwner = <T>(database: string, work: (pool: Pool) => Promise<T>) => using(login('lares_workflow_provisioner', 'provisioner', database, '-c role=lares_workflow_owner'), work);
const asRuntime = <T>(database: string, work: (pool: Pool) => Promise<T>) => using(login('lares_workflow', 'workflow', database), work);
const asOperator = <T>(database: string, work: (pool: Pool) => Promise<T>) => using(login('lares_operator', 'operator', database), work);

/** One of the box's own programs, exactly as update.sh runs it on a checkout. */
const engine = (args: string[]) => run(tsx, args, { cwd: box, env });
/** ops/workflow-store-migrate.mjs on standard input from the role's folder, as the role image runs it. */
const storeStep = (mode: string, database: string, onStart?: (kill: () => void) => void) =>
  run(process.execPath, ['--input-type=module', '-', mode, database], {
    cwd: creative, input: program, onStart,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, PGPASSWORD: password('provisioner'), PGOPTIONS: '-c role=lares_workflow_owner',
      WORKFLOW_POSTGRES_URL: `postgres://lares_workflow_provisioner@${host}:${port}/${database}`,
    },
  });
const planArgs = (quietToo = false) => ['bin/workflow-template.ts', 'update-plan', '--host', host, '--port', port,
  '--operator-password-file', secret('operator'), ...(quietToo ? ['--require-quiet'] : [])];
const applyArgs = (database: string) => ['bin/workflow-template.ts', database === TEMPLATE ? 'apply' : 'apply-database', '--host', host, '--port', port,
  ...(database === TEMPLATE ? [] : ['--database', database]),
  '--provisioner-password-file', secret('provisioner'), '--runtime-password-file', secret('workflow')];
const verifyArgs = (database: string) => ['bin/workflow-template.ts', 'verify-database', '--host', host, '--port', port,
  '--database', database, '--runtime-password-file', secret('workflow')];
const verifyTemplateArgs = () => ['bin/database-setup.ts', '--verify-workflow-template',
  '--operator-password-file', secret('operator'), '--workflow-password-file', secret('workflow')];

class Refused extends Error {}

/** What update.sh's workflow_survey does: the plan, then `check` on every database it names. */
async function survey(quietToo = false): Promise<Array<{ database: string; state: string }>> {
  const plan = await engine(planArgs(quietToo));
  if (plan.code !== 0) throw new Refused(plan.stderr.trim());
  const targets = plan.stdout.trim().split('\n').map((line) => line.split('\t'));
  expect(targets[0]).toEqual(['template', TEMPLATE]);
  const states: Array<{ database: string; state: string }> = [];
  for (const [, database] of targets) {
    const checked = await storeStep('check', database!);
    if (checked.code !== 0) throw new Refused(`${database}: ${checked.stderr.trim()}`);
    const state = checked.stdout.trim();
    if (state !== 'old' && state !== 'current') throw new Refused(`${database}: ${state}`);
    states.push({ database: database!, state });
  }
  return states;
}

/** The updater's agent-store step, in update.sh's order. Returns which databases it migrated. */
async function upgradeStores(): Promise<string[]> {
  await survey();                         // the look before anything is stopped
  const states = await survey(true);      // the same look again, with nothing else connected
  const migrated: string[] = [];
  for (const { database, state } of states) {
    if (state === 'old') {
      const step = await storeStep('upgrade', database);
      expect(step.code, step.stderr).toBe(0);
      expect(step.stdout + step.stderr).not.toContain(password('provisioner'));
      expect((await storeStep('check', database)).stdout.trim()).toBe('current');
      migrated.push(database);
    }
    const applied = await engine(applyArgs(database));
    expect(applied.code, applied.stderr).toBe(0);
  }
  const template = await engine(verifyTemplateArgs());
  expect(template.code, template.stderr).toBe(0);
  for (const { database } of states) {
    if (database === TEMPLATE) continue;
    const verified = await engine(verifyArgs(database));
    expect(verified.code, verified.stderr).toBe(0);
  }
  return migrated;
}

// Builds the previous release's schema in one database: the package's own first 20 steps through
// its own migrator, then its job queue, as its setupDatabase() did. Run like the store program.
const PREVIOUS_SCHEMA = `
import { createRequire } from 'node:module';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(import.meta.resolve('@workflow/world-postgres/cli'));
const load = createRequire(cli);
const { Pool } = load('pg');
const { drizzle } = load('drizzle-orm/node-postgres');
const { migrate } = load('drizzle-orm/node-postgres/migrator');
const { makeWorkerUtils } = load('graphile-worker');
const folder = mkdtempSync(join(tmpdir(), 'workflow-previous-'));
try {
  cpSync(join(dirname(cli), '..', 'src', 'drizzle', 'migrations'), folder, { recursive: true });
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, ${WORKFLOW_SCHEMA_STEPS_BEFORE});
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  for (const file of readdirSync(folder)) if (file.endsWith('.sql') && !journal.entries.some((entry) => entry.tag + '.sql' === file)) rmSync(join(folder, file));
  const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 1 });
  await migrate(drizzle(pool), { migrationsFolder: folder, migrationsTable: 'workflow_migrations', migrationsSchema: 'workflow_drizzle' });
  const utils = await makeWorkerUtils({ pgPool: pool });
  await utils.migrate();
  await utils.release();
  await pool.end();
} finally { rmSync(folder, { recursive: true, force: true }); }
`;

/** The grants the previous release's box gave the agent login: its seven tables, nothing newer. */
async function previousReleasePrivileges(database: string): Promise<void> {
  await asOwner(database, async (owner) => {
    await owner.query(`REVOKE CONNECT, TEMP ON DATABASE "${database}" FROM PUBLIC`);
    await owner.query(`GRANT CONNECT ON DATABASE "${database}" TO lares_workflow, lares_workflow_provisioner`);
    for (const schema of ['workflow', 'workflow_drizzle', 'graphile_worker']) {
      await owner.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
      await owner.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC`);
      await owner.query(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`);
      await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO lares_workflow`);
    }
    for (const table of PREVIOUS_TABLES) await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON workflow.${table} TO lares_workflow`);
    await owner.query('GRANT SELECT ON workflow_drizzle.workflow_migrations, graphile_worker.migrations TO lares_workflow');
    for (const table of QUEUE_TABLES) {
      const exists = await owner.query('SELECT 1 FROM pg_policies WHERE schemaname=$1 AND tablename=$2', ['graphile_worker', table]);
      if (!exists.rows.length) await owner.query(`CREATE POLICY "runtime_${table}" ON graphile_worker."${table}" FOR ALL TO lares_workflow USING (true) WITH CHECK (true)`);
      await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON graphile_worker."${table}" TO lares_workflow`);
    }
    await owner.query('GRANT USAGE ON SEQUENCE graphile_worker.job_queues_id_seq, graphile_worker.jobs_id_seq1, graphile_worker.tasks_id_seq TO lares_workflow');
    await owner.query('REVOKE USAGE ON TYPE workflow.status, workflow.step_status, workflow.wait_status, graphile_worker.job_spec FROM PUBLIC');
    await owner.query('GRANT USAGE ON TYPE graphile_worker.job_spec TO lares_workflow');
    await owner.query(`GRANT EXECUTE ON FUNCTION graphile_worker.add_job(text,json,text,timestamptz,integer,text,integer,text[],text),
      graphile_worker.add_jobs(graphile_worker.job_spec[],boolean), graphile_worker.force_unlock_workers(text[]) TO lares_workflow`);
  });
}

/** A server exactly as the previous release left it: the template and one store per agent. */
async function previousInstallation(agents: Array<{ name: string; database: string; state?: string }>): Promise<void> {
  const existing = await admin.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname=$1 OR datname ~ '^lares_[0-9a-f]{32}$'", [TEMPLATE]);
  for (const { datname } of existing.rows) {
    if (datname === TEMPLATE) await admin.query(`ALTER DATABASE "${TEMPLATE}" IS_TEMPLATE false`);
    await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`);
  }
  await asOperator('lares_state', (state) => state.query('DELETE FROM agent_resources'));
  await admin.query(`CREATE DATABASE "${TEMPLATE}" OWNER lares_workflow_owner`);
  await admin.query(`REVOKE CONNECT, CREATE, TEMP ON DATABASE "${TEMPLATE}" FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE "${TEMPLATE}" TO lares_workflow_provisioner`);
  const built = await run(process.execPath, ['--input-type=module', '-'], {
    cwd: creative, input: PREVIOUS_SCHEMA,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, PGPASSWORD: password('provisioner'), PGOPTIONS: '-c role=lares_workflow_owner',
      WORKFLOW_POSTGRES_URL: `postgres://lares_workflow_provisioner@${host}:${port}/${TEMPLATE}`,
    },
  });
  expect(built.code, built.stderr).toBe(0);
  await previousReleasePrivileges(TEMPLATE);
  await admin.query(`ALTER DATABASE "${TEMPLATE}" IS_TEMPLATE true`);
  let index = 0;
  for (const agent of agents) {
    const token = `${String(++index).repeat(8)}-1111-4111-8111-111111111111`;
    await admin.query(`CREATE DATABASE "${agent.database}" WITH TEMPLATE "${TEMPLATE}" OWNER lares_workflow_owner`);
    await admin.query(`COMMENT ON DATABASE "${agent.database}" IS 'lares-owned:${token}'`);
    await previousReleasePrivileges(agent.database);
    await asOperator('lares_state', (state) => state.query(
      "INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state) VALUES($1,$2,$3,'owned',$4,$4,$5)",
      [agent.name, `172.30.0.${10 + index}`, agent.database, token, agent.state ?? 'ready']));
  }
}
const twoAgents = () => previousInstallation([{ name: 'example-agent', database: STORE_A }, { name: 'other-agent', database: STORE_B }]);

const recorded = (database: string) => asOwner(database, async (owner) =>
  (await owner.query<{ id: number; hash: string; created_at: string }>('SELECT id,hash,created_at::text AS created_at FROM workflow_drizzle.workflow_migrations ORDER BY id')).rows);
const pinned = (count: number) => WORKFLOW_SCHEMA_STEPS.slice(0, count).map(([created_at, hash]) => ({ created_at, hash }));
const stepsOf = async (database: string) => (await recorded(database)).map(({ hash, created_at }) => ({ created_at, hash }));
const queueSteps = (database: string) => asOwner(database, async (owner) => (await owner.query('SELECT count(*)::int AS n FROM graphile_worker.migrations')).rows[0].n as number);
const createdAtType = (database: string) => asOwner(database, async (owner) => (await owner.query(
  "SELECT data_type FROM information_schema.columns WHERE table_schema='workflow' AND table_name='workflow_runs' AND column_name='created_at'")).rows[0].data_type as string);
const hasNewTables = (database: string) => asOwner(database, async (owner) => (await owner.query(
  "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='workflow' AND c.relname=ANY($1::text[])", [NEW_TABLES])).rows[0].n as number);
/** The whole schema, grants included, as text: what "nothing was changed" is measured against. */
async function schemaOf(database: string): Promise<string> {
  const dumped = await pg.exec(['pg_dump', '-U', pg.getUsername(), '--schema-only', '-d', database]);
  expect(dumped.exitCode, dumped.output).toBe(0);
  return dumped.output.split('\n').filter((line) => !line.startsWith('\\restrict') && !line.startsWith('\\unrestrict')).join('\n');
}
const schemas = async () => Object.fromEntries(await Promise.all(ALL.map(async (database) => [database, await schemaOf(database)] as const)));

/** One row in a table of the previous schema, with every required column filled by its type. */
async function seedRow(pool: Pool, table: string, fixed: Record<string, unknown>): Promise<void> {
  const columns = (await pool.query<{ name: string; type: string; enum_type: string | null }>(`
    SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
      CASE WHEN t.typtype='e' THEN t.oid::regtype::text END AS enum_type
    FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
    WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull AND NOT a.atthasdef AND a.attidentity=''`, [`workflow.${table}`])).rows;
  const values: Record<string, unknown> = { ...fixed };
  for (const column of columns) {
    if (column.name in values) continue;
    if (column.enum_type) values[column.name] = (await pool.query(`SELECT (enum_range(NULL::${column.enum_type}))[1]::text AS label`)).rows[0].label;
    else if (column.type === 'bytea') values[column.name] = Buffer.from([1, 2, 3]);
    else if (column.type.startsWith('timestamp')) values[column.name] = '2026-11-01T10:00:00.000Z';
    else if (column.type === 'boolean') values[column.name] = false;
    else if (/int|numeric/.test(column.type)) values[column.name] = 1;
    else if (column.type.startsWith('json')) values[column.name] = '{}';
    else values[column.name] = `seed-${column.name}`;
  }
  const names = Object.keys(values);
  await pool.query(`INSERT INTO workflow.${table}(${names.map((name) => `"${name}"`).join(',')}) VALUES(${names.map((_, at) => `$${at + 1}`).join(',')})`, names.map((name) => values[name]));
}
/** Rows as the agent login wrote them, on the previous software. */
async function seedConversations(database: string): Promise<void> {
  await asRuntime(database, async (runtime) => {
    await seedRow(runtime, 'workflow_runs', { id: 'run_now' });
    await seedRow(runtime, 'workflow_runs', { id: 'run_js', started_at: '2026-11-01T10:00:00.000Z' });
    await seedRow(runtime, 'workflow_events', { id: 'evt_1', run_id: 'run_now' });
    await seedRow(runtime, 'workflow_hooks', { run_id: 'run_now' });
    await seedRow(runtime, 'workflow_waits', { run_id: 'run_now' });
    await seedRow(runtime, 'workflow_event_slots', { run_id: 'run_now' });
  });
}
/** Every seeded row, restricted to the columns that existed before, with each time as an instant. */
async function conversations(database: string, columnsBefore?: Record<string, string[]>): Promise<{ columns: Record<string, string[]>; rows: Record<string, unknown[]> }> {
  return asOwner(database, async (owner) => {
    const columns: Record<string, string[]> = {}, rows: Record<string, unknown[]> = {};
    for (const table of ['workflow_runs', 'workflow_events', 'workflow_hooks', 'workflow_waits', 'workflow_event_slots']) {
      const described = (await owner.query<{ name: string; type: string }>(
        "SELECT column_name AS name,data_type AS type FROM information_schema.columns WHERE table_schema='workflow' AND table_name=$1 ORDER BY column_name", [table])).rows;
      columns[table] = columnsBefore?.[table] ?? described.map((column) => column.name);
      const types = new Map(described.map((column) => [column.name, column.type]));
      const selected = columns[table]!.map((name) => types.get(name)!.startsWith('timestamp')
        ? `extract(epoch FROM "${name}")::text AS "${name}"` : types.get(name) === 'bytea' ? `encode("${name}",'hex') AS "${name}"` : `"${name}"::text AS "${name}"`);
      rows[table] = (await owner.query(`SELECT ${selected.join(',')} FROM workflow.${table} ORDER BY 1`)).rows;
      expect(rows[table]!.length).toBeGreaterThan(0);
    }
    return { columns, rows };
  });
}

async function startServer(command?: string[]): Promise<void> {
  const container = new PostgreSqlContainer('pgvector/pgvector:pg16');
  pg = await (command ? container.withCommand(command) : container).start();
  const connection = new URL(pg.getConnectionUri());
  host = connection.hostname;
  port = String(connection.port);
  admin = quiet(new Pool({ connectionString: pg.getConnectionUri(), max: 1 }));
  await admin.query(`CREATE ROLE lares_operator LOGIN SUPERUSER PASSWORD '${password('operator')}'`);
  env = { ...process.env, PGHOST: host, PGPORT: port };
  // The real roles and the engine database (with agent_resources), from the installer's own program.
  const setup = await engine(['bin/database-setup.ts',
    '--operator-password-file', secret('operator'), '--app-password-file', secret('app'),
    '--financial-password-file', secret('financial'), '--outside-custody-password-file', secret('outside'),
    '--workflow-provisioner-password-file', secret('provisioner'), '--workflow-password-file', secret('workflow'),
    '--gateway-password-file', secret('gateway')]);
  expect(setup.code, setup.stderr).toBe(0);
}
async function stopServer(): Promise<void> {
  await admin?.end();
  await pg?.stop();
}
afterAll(() => rmSync(secretDir, { recursive: true, force: true }));

describe('the pinned lists of schema steps', () => {
  it('agree with each other and with the workflow package this checkout installs', () => {
    const folder = join(creative, 'node_modules/@workflow/world-postgres/src/drizzle/migrations');
    const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> };
    const packaged = journal.entries.map((entry) => [String(entry.when), createHash('sha256').update(readFileSync(join(folder, `${entry.tag}.sql`))).digest('hex')]);
    expect(packaged).toEqual(WORKFLOW_SCHEMA_STEPS.map((step) => [...step]));
    expect(WORKFLOW_SCHEMA_STEPS).toHaveLength(30);
    const inProgram = [...program.toString('utf8').matchAll(/"(\d{13}) ([0-9a-f]{64})"/g)].map((match) => [match[1], match[2]]);
    expect(inProgram).toEqual(WORKFLOW_SCHEMA_STEPS.slice(0, WORKFLOW_SCHEMA_STEPS_BEFORE).map((step) => [...step]));
    expect(WORKFLOW_SCHEMA_STEPS_BEFORE).toBe(20);
  });
});

describe('on a server in UTC, as a fresh install leaves it', () => {
  beforeAll(() => startServer(), 240_000);
  afterAll(stopServer, 120_000);

  it('a fresh server reports UTC, and the previous release left exactly the 20 pinned steps', async () => {
    expect((await admin.query('SHOW TimeZone')).rows[0].TimeZone).toBe('Etc/UTC');
    await twoAgents();
    for (const database of ALL) {
      expect(await stepsOf(database)).toEqual(pinned(20));
      expect(await queueSteps(database)).toBe(18);
      expect((await storeStep('check', database)).stdout.trim()).toBe('old');
    }
    // The previous release's own check accepted these stores; this release's refuses them, which is
    // what stops a keeper from starting an agent on a store the updater has not upgraded.
    await asRuntime(STORE_A, async (runtime) => {
      await expect(verifyWorkflowRuntimePrivileges(runtime)).rejects.toThrow('Workflow schema step record is not at the pinned head (20 recorded, 30 expected)');
    });
  }, 240_000);

  it('upgrades the template and every store, keeps every row, and leaves the agent login exactly its rights', async () => {
    await twoAgents();
    await seedConversations(STORE_A);
    const before = await conversations(STORE_A);
    expect(await createdAtType(STORE_A)).toBe('timestamp without time zone');

    expect(await upgradeStores()).toEqual(ALL);

    for (const database of ALL) {
      expect(await stepsOf(database)).toEqual(pinned(30));
      expect(await queueSteps(database)).toBe(18);
      expect(await createdAtType(database)).toBe('timestamp with time zone');
      const owned = await asOwner(database, async (owner) => (await owner.query<{ name: string; kind: string; owner: string }>(`
        SELECT c.relname AS name,c.relkind AS kind,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='workflow' AND c.relname=ANY($1::text[]) ORDER BY 1`, [[...NEW_TABLES, 'workflow_invocations_sequence_seq']])).rows);
      expect(owned).toEqual([
        { name: 'workflow_invocations', kind: 'r', owner: 'lares_workflow_owner' },
        { name: 'workflow_invocations_sequence_seq', kind: 'S', owner: 'lares_workflow_owner' },
        { name: 'workflow_snapshots', kind: 'r', owner: 'lares_workflow_owner' },
        { name: 'workflow_start_hook_admissions', kind: 'r', owner: 'lares_workflow_owner' },
      ]);
    }
    // Same values, and every time the same instant, in every column that existed before.
    expect((await conversations(STORE_A, before.columns)).rows).toEqual(before.rows);
    const template = (await admin.query('SELECT datistemplate,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [TEMPLATE])).rows[0];
    expect(template).toEqual({ datistemplate: true, owner: 'lares_workflow_owner' });
    await asOwner(TEMPLATE, async (owner) => {
      for (const table of [...PREVIOUS_TABLES, ...NEW_TABLES]) expect((await owner.query(`SELECT count(*)::int AS n FROM workflow.${table}`)).rows[0].n).toBe(0);
    });

    // As the agent login itself: a real login with its own password, never a superuser, never SET ROLE.
    await asRuntime(STORE_A, async (runtime) => {
      expect((await runtime.query('SELECT current_user,session_user')).rows[0]).toEqual({ current_user: 'lares_workflow', session_user: 'lares_workflow' });
      await verifyWorkflowRuntimePrivileges(runtime);
      const first = await runtime.query("INSERT INTO workflow.workflow_invocations(run_id,request_id,payload,fingerprint) VALUES('run_now','req_1','\\x01','f1') RETURNING sequence");
      const second = await runtime.query("INSERT INTO workflow.workflow_invocations(run_id,request_id,payload,fingerprint) VALUES('run_now','req_2','\\x01','f2') RETURNING sequence");
      expect(Number(second.rows[0].sequence)).toBe(Number(first.rows[0].sequence) + 1);
      expect((await runtime.query("UPDATE workflow.workflow_invocations SET result='\\x02',responded_at=now() WHERE request_id='req_1'")).rowCount).toBe(1);
      expect((await runtime.query('SELECT count(*)::int AS n FROM workflow.workflow_invocations')).rows[0].n).toBe(2);
      expect((await runtime.query("DELETE FROM workflow.workflow_invocations WHERE request_id='req_2'")).rowCount).toBe(1);
      await runtime.query("INSERT INTO workflow.workflow_snapshots(run_id,data) VALUES('run_now','\\x01') ON CONFLICT (run_id) DO UPDATE SET data=excluded.data");
      expect((await runtime.query("UPDATE workflow.workflow_snapshots SET events_cursor='c' WHERE run_id='run_now'")).rowCount).toBe(1);
      expect((await runtime.query('SELECT run_id FROM workflow.workflow_snapshots')).rows).toEqual([{ run_id: 'run_now' }]);
      expect((await runtime.query("DELETE FROM workflow.workflow_snapshots WHERE run_id='run_now'")).rowCount).toBe(1);
      await runtime.query("INSERT INTO workflow.workflow_start_hook_admissions(run_id,token,decision) VALUES('run_now','t','accepted')");
      expect((await runtime.query("UPDATE workflow.workflow_start_hook_admissions SET decision='rejected' WHERE run_id='run_now'")).rowCount).toBe(1);
      expect((await runtime.query('SELECT decision FROM workflow.workflow_start_hook_admissions')).rows).toEqual([{ decision: 'rejected' }]);
      expect((await runtime.query("DELETE FROM workflow.workflow_start_hook_admissions WHERE run_id='run_now'")).rowCount).toBe(1);
      for (const table of NEW_TABLES) await expect(runtime.query(`TRUNCATE workflow.${table}`)).rejects.toMatchObject({ code: '42501' });
      const sequence = (await runtime.query(`SELECT
        has_sequence_privilege(current_user,'workflow.workflow_invocations_sequence_seq','USAGE') AS usage,
        has_sequence_privilege(current_user,'workflow.workflow_invocations_sequence_seq','SELECT') AS read,
        has_sequence_privilege(current_user,'workflow.workflow_invocations_sequence_seq','UPDATE') AS write`)).rows[0];
      expect(sequence).toEqual({ usage: true, read: false, write: false });
      await expect(runtime.query("SELECT setval('workflow.workflow_invocations_sequence_seq', 1)")).rejects.toMatchObject({ code: '42501' });
      await expect(runtime.query("INSERT INTO workflow_drizzle.workflow_migrations(hash,created_at) VALUES('x',1)")).rejects.toMatchObject({ code: '42501' });
      await expect(runtime.query('DELETE FROM workflow_drizzle.workflow_migrations')).rejects.toMatchObject({ code: '42501' });
      await expect(runtime.query('CREATE TABLE workflow.mine(id int)')).rejects.toMatchObject({ code: '42501' });
    });

    // Run again on a fully upgraded server: nothing is migrated, nothing is recorded twice, all verifies.
    const ids = await recorded(STORE_B);
    expect(await upgradeStores()).toEqual([]);
    expect(await recorded(STORE_B)).toEqual(ids);
    // A new agent made from the upgraded template gets this release's schema.
    const cloned = `lares_${'c'.repeat(32)}`;
    await admin.query(`CREATE DATABASE "${cloned}" WITH TEMPLATE "${TEMPLATE}" OWNER lares_workflow_owner`);
    expect((await storeStep('check', cloned)).stdout.trim()).toBe('current');
    await admin.query(`DROP DATABASE "${cloned}"`);
  }, 600_000);

  it('refuses a store whose record is not exactly what the previous release left, before anything is changed', async () => {
    await twoAgents();
    const untouched = await schemas();
    const original = await recorded(STORE_B);
    const superuser = (sql: string, values: unknown[] = []) => using(quiet(new Pool({ host, port: Number(port), database: STORE_B, user: pg.getUsername(), password: pg.getPassword(), max: 1 })), (pool) => pool.query(sql, values));
    const restore = async () => {
      await superuser('TRUNCATE workflow_drizzle.workflow_migrations');
      for (const row of original) await superuser('INSERT INTO workflow_drizzle.workflow_migrations(id,hash,created_at) VALUES($1,$2,$3)', [row.id, row.hash, row.created_at]);
    };
    const variants: Array<[string, () => Promise<unknown>, RegExp]> = [
      ['no steps recorded (a store built by hand)', () => superuser('TRUNCATE workflow_drizzle.workflow_migrations'), /it has 0 schema steps recorded/],
      ['19 steps', () => superuser('DELETE FROM workflow_drizzle.workflow_migrations WHERE id=(SELECT max(id) FROM workflow_drizzle.workflow_migrations)'), /it has 19 schema steps recorded/],
      ['20 steps, one with another hash', () => superuser("UPDATE workflow_drizzle.workflow_migrations SET hash=repeat('0',64) WHERE id=7"), /it has 20 schema steps recorded, and at least one is not a step this release knows/],
      ['20 steps, one with another date', () => superuser('UPDATE workflow_drizzle.workflow_migrations SET created_at=created_at+1 WHERE id=7'), /it has 20 schema steps recorded, and at least one is not a step this release knows/],
      ['21 steps', () => superuser('INSERT INTO workflow_drizzle.workflow_migrations(hash,created_at) VALUES($1,$2)', [WORKFLOW_SCHEMA_STEPS[20]![1], WORKFLOW_SCHEMA_STEPS[20]![0]]), /it has 21 schema steps recorded/],
      ['30 steps, one with another hash', async () => {
        for (const [created_at, hash] of WORKFLOW_SCHEMA_STEPS.slice(20)) await superuser('INSERT INTO workflow_drizzle.workflow_migrations(hash,created_at) VALUES($1,$2)', [hash, created_at]);
        await superuser("UPDATE workflow_drizzle.workflow_migrations SET hash=repeat('0',64) WHERE id=(SELECT max(id) FROM workflow_drizzle.workflow_migrations)");
      }, /it has 30 schema steps recorded, and at least one is not a step this release knows/],
      ['30 correct steps beside the previous tables (a record somebody edited)', async () => {
        for (const [created_at, hash] of WORKFLOW_SCHEMA_STEPS.slice(20)) await superuser('INSERT INTO workflow_drizzle.workflow_migrations(hash,created_at) VALUES($1,$2)', [hash, created_at]);
      }, /tables this release adds are missing/],
    ];
    for (const [name, change, reason] of variants) {
      await change();
      const changedRecord = await recorded(STORE_B);
      await expect(upgradeStores(), name).rejects.toThrow(reason);
      // Refused before anything is migrated: the healthy template and the healthy store too.
      expect(await recorded(STORE_B), name).toEqual(changedRecord);
      for (const database of [TEMPLATE, STORE_A]) expect(await stepsOf(database), name).toEqual(pinned(20));
      // `upgrade` on its own refuses the same store: the refusal does not depend on the caller's order.
      const direct = await storeStep('upgrade', STORE_B);
      expect(direct.code, name).toBe(3);
      expect(direct.stderr, name).toMatch(reason);
      await restore();
      expect(await schemas(), name).toEqual(untouched);
    }
    // A store with workflow tables and no record at all, and a completely empty one.
    await superuser('ALTER TABLE workflow_drizzle.workflow_migrations RENAME TO workflow_migrations_gone');
    await expect(upgradeStores()).rejects.toThrow(/workflow tables but no record of applied schema steps/);
    await superuser('ALTER TABLE workflow_drizzle.workflow_migrations_gone RENAME TO workflow_migrations');
    expect(await schemas()).toEqual(untouched);
    // After every refusal the same stores still upgrade cleanly.
    expect(await upgradeStores()).toEqual(ALL);
  }, 900_000);

  it('refuses a database the box cannot prove it owns, an agent without a store, and a busy store', async () => {
    await twoAgents();
    const untouched = await schemas();
    const refusal = async () => { const plan = await engine(planArgs(true)); expect(plan.code).toBe(1); expect(plan.stdout).toBe(''); return plan.stderr; };
    const stray = `lares_${'d'.repeat(32)}`;
    await admin.query(`CREATE DATABASE "${stray}" WITH TEMPLATE "${TEMPLATE}" OWNER lares_workflow_owner`);
    expect(await refusal()).toContain(`database ${stray} looks like an agent store but no agent record names it`);
    await admin.query(`DROP DATABASE "${stray}"`);
    await admin.query(`COMMENT ON DATABASE "${STORE_B}" IS 'lares-owned:99999999-1111-4111-8111-111111111111'`);
    expect(await refusal()).toContain("the store of agent other-agent does not carry this installation's ownership marker");
    await admin.query(`COMMENT ON DATABASE "${STORE_B}" IS 'lares-owned:22222222-1111-4111-8111-111111111111'`);
    await asOperator('lares_state', (state) => state.query("UPDATE agent_resources SET workflow_database=$1 WHERE name='other-agent'", [stray]));
    expect(await refusal()).toMatch(/agent other-agent has no store on this server|no agent record names it/);
    await asOperator('lares_state', (state) => state.query("UPDATE agent_resources SET workflow_database=$1,state='deleting' WHERE name='other-agent'", [STORE_B]));
    expect(await refusal()).toContain('agent other-agent is half removed: its store still exists');
    await asOperator('lares_state', (state) => state.query("UPDATE agent_resources SET state='ready' WHERE name='other-agent'"));
    // Something still connected to a store: refused only by the look that runs with everything stopped.
    const held = login('lares_workflow', 'workflow', STORE_A);
    try {
      await held.query('SELECT 1');
      expect((await engine(planArgs(false))).code).toBe(0);
      expect(await refusal()).toContain(`something is still connected to ${STORE_A}`);
    } finally { await held.end(); }
    const plan = await engine(planArgs(true));
    expect(plan.stdout).toBe(`template\t${TEMPLATE}\nstore\t${STORE_A}\texample-agent\nstore\t${STORE_B}\tother-agent\n`);
    expect(plan.stdout + plan.stderr).not.toContain(password('operator'));
    expect(await schemas()).toEqual(untouched);
  }, 600_000);

  it('refuses a time zone setting on one database, and changes nothing', async () => {
    await twoAgents();
    await seedConversations(STORE_B);
    const untouched = await schemas();
    for (const [setting, reason] of [
      ["SET timezone='Europe/Oslo'", /time zone/], ["SET workflow.legacy_timezone='Europe/Berlin'", /time zone/],
    ] as const) {
      await admin.query(`ALTER DATABASE "${STORE_B}" ${setting}`);
      await expect(upgradeStores()).rejects.toThrow(reason);
      // The store program refuses on its own as well: the session that would migrate is not in UTC.
      const direct = await storeStep('upgrade', STORE_B);
      expect(direct.code).toBe(3);
      expect(direct.stderr).toMatch(/only safe on UTC/);
      await admin.query(`ALTER DATABASE "${STORE_B}" RESET ALL`);
    }
    await admin.query("ALTER ROLE lares_workflow_provisioner SET timezone='Europe/Oslo'");
    await expect(upgradeStores()).rejects.toThrow(/time zone/);
    await admin.query('ALTER ROLE lares_workflow_provisioner RESET ALL');
    for (const database of ALL) {
      expect(await stepsOf(database)).toEqual(pinned(20));
      expect(await createdAtType(database)).toBe('timestamp without time zone');
    }
    expect(await schemas()).toEqual(untouched);
  }, 600_000);

  it('continues an interrupted run: skips what is upgraded, upgrades the rest, and applies permissions an earlier run never reached', async () => {
    await twoAgents();
    await seedConversations(STORE_B);
    const before = await conversations(STORE_B);
    // An earlier run upgraded the template and the first store and ended before giving either its
    // permissions: both have the new tables, and the agent login cannot use them.
    for (const database of [TEMPLATE, STORE_A]) expect((await storeStep('upgrade', database)).code).toBe(0);
    const half = await engine(verifyArgs(STORE_A));
    expect(half.code).toBe(1);
    await asRuntime(STORE_A, (runtime) => expect(runtime.query('SELECT 1 FROM workflow.workflow_invocations')).rejects.toMatchObject({ code: '42501' }));
    const idsA = await recorded(STORE_A);

    expect(await upgradeStores()).toEqual([STORE_B]);

    expect(await recorded(STORE_A)).toEqual(idsA);
    for (const database of ALL) expect(await stepsOf(database)).toEqual(pinned(30));
    await asRuntime(STORE_A, async (runtime) => {
      await verifyWorkflowRuntimePrivileges(runtime);
      expect((await runtime.query('SELECT count(*)::int AS n FROM workflow.workflow_invocations')).rows[0].n).toBe(0);
    });
    expect((await conversations(STORE_B, before.columns)).rows).toEqual(before.rows);
  }, 600_000);

  it('a migration killed part-way leaves the store exactly as it was, and the next run upgrades it', async () => {
    await twoAgents();
    await seedConversations(STORE_A);
    const untouched = await schemaOf(STORE_A);
    const before = await conversations(STORE_A);
    // Hold a lock on a table the step only reaches at its 28th file. The step applies the files
    // before it inside its one transaction, then waits here; that is when it is killed.
    const blocker = login('lares_workflow_provisioner', 'provisioner', STORE_A, '-c role=lares_workflow_owner');
    const holder = await blocker.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE workflow.workflow_steps IN ACCESS SHARE MODE');
      let kill = () => {};
      const running = storeStep('upgrade', STORE_A, (stop) => { kill = stop; });
      const deadline = Date.now() + 60_000;
      for (;;) {
        const waiting = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'", [STORE_A]);
        if (waiting.rows[0].n > 0) break;
        if (Date.now() > deadline) throw new Error('the migration never reached the held lock');
        await new Promise((next) => setTimeout(next, 100));
      }
      // Part-way for real: inside its transaction the step has already created the new tables.
      kill();
      expect((await running).code).not.toBe(0);
      for (;;) {
        const left = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND pid<>$2 AND backend_type='client backend'", [STORE_A, (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid]);
        if (left.rows[0].n === 0) break;
        if (Date.now() > deadline) throw new Error('the killed migration is still connected');
        await new Promise((next) => setTimeout(next, 100));
      }
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
      await blocker.end();
    }
    expect((await storeStep('check', STORE_A)).stdout.trim()).toBe('old');
    expect(await stepsOf(STORE_A)).toEqual(pinned(20));
    expect(await hasNewTables(STORE_A)).toBe(0);
    expect(await schemaOf(STORE_A)).toEqual(untouched);
    expect((await conversations(STORE_A, before.columns)).rows).toEqual(before.rows);

    expect(await upgradeStores()).toEqual(ALL);
    // The killed attempt used up record ids without leaving a row: ids are not what is pinned.
    expect(await stepsOf(STORE_A)).toEqual(pinned(30));
    expect((await recorded(STORE_A)).map((row) => row.id)).not.toEqual(Array.from({ length: 30 }, (_, at) => at + 1));
    expect((await conversations(STORE_A, before.columns)).rows).toEqual(before.rows);
  }, 600_000);

  it('a fresh install: an empty template gets the full list, and an update never treats an empty database as a store', async () => {
    await previousInstallation([]);
    await admin.query(`ALTER DATABASE "${TEMPLATE}" IS_TEMPLATE false`);
    await admin.query(`DROP DATABASE "${TEMPLATE}"`);
    await admin.query(`CREATE DATABASE "${TEMPLATE}" OWNER lares_workflow_owner`);
    await admin.query(`REVOKE CONNECT, CREATE, TEMP ON DATABASE "${TEMPLATE}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${TEMPLATE}" TO lares_workflow_provisioner`);
    expect((await storeStep('check', TEMPLATE)).stdout.trim()).toBe('empty');
    const asUpdate = await storeStep('upgrade', TEMPLATE);
    expect(asUpdate.code).toBe(3);
    expect(asUpdate.stderr).toContain('it is empty; an update only upgrades a store the previous release left');
    expect((await storeStep('check', TEMPLATE)).stdout.trim()).toBe('empty');
    const fresh = await storeStep('create', TEMPLATE);
    expect(fresh.code, fresh.stderr).toBe(0);
    expect(fresh.stdout + fresh.stderr).not.toContain(password('provisioner'));
    expect((await storeStep('check', TEMPLATE)).stdout.trim()).toBe('current');
    expect(await stepsOf(TEMPLATE)).toEqual(pinned(30));
    const again = await storeStep('create', TEMPLATE);
    expect(again.code).toBe(3);
    expect(again.stderr).toContain('a fresh install expects an empty database');
  }, 600_000);
});

describe('on a server whose time zone is not UTC', () => {
  beforeAll(() => startServer(['postgres', '-c', 'timezone=Europe/Oslo']), 240_000);
  afterAll(stopServer, 120_000);

  it('refuses, and leaves every record and every stored time as it was', async () => {
    expect((await admin.query('SHOW TimeZone')).rows[0].TimeZone).toBe('Europe/Oslo');
    await twoAgents();
    await seedConversations(STORE_A);
    const untouched = await schemas();
    const before = await conversations(STORE_A);
    await expect(upgradeStores()).rejects.toThrow('the database is set to time zone Europe/Oslo; this update changes every stored time and is only safe on UTC');
    for (const database of ALL) {
      for (const mode of ['check', 'upgrade']) {
        const direct = await storeStep(mode, database);
        expect(direct.code).toBe(3);
        expect(direct.stderr).toContain('the database is set to time zone Europe/Oslo');
      }
      expect(await stepsOf(database)).toEqual(pinned(20));
      expect(await createdAtType(database)).toBe('timestamp without time zone');
      expect(await hasNewTables(database)).toBe(0);
    }
    expect(await schemas()).toEqual(untouched);
    expect((await conversations(STORE_A, before.columns)).rows).toEqual(before.rows);
  }, 600_000);
});
