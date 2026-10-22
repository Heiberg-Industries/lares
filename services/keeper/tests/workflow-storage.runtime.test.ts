import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WorkflowStorage } from '../lib/workflow-storage.js';
import { applyWorkflowRuntimePrivileges, verifyWorkflowRuntimePrivileges } from '../../box/lib/workflow-database-privileges.js';
import { releaseStaleWorkflowLocks } from '@lares/agent-kit/release-stale-workflow-locks';
import { quiet } from './helpers/quiet-pool.js';

const execFileAsync = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const creativeDir = join(repo, 'services/creative');
const creativeRequire = createRequire(join(creativeDir, 'package.json'));
const worldEntry = creativeRequire.resolve('@workflow/world-postgres');
const graphile = createRequire(worldEntry)('graphile-worker') as {
  makeWorkerUtils(options: { connectionString: string }): Promise<{ addJob(name: string, payload: object, spec?: { queueName?: string }): Promise<{ id: number }>; release(): Promise<void> }>;
  runOnce(options: { connectionString: string; concurrency: number }, tasks: Record<string, () => Promise<void>>): Promise<void>;
};

const provisionerPassword = 'test-only-provisioner-password';
const runtimePassword = 'test-only-workflow-password';
const owner = 'lares_workflow_owner';
const provisioner = 'lares_workflow_provisioner';
const runtime = 'lares_workflow';
let pg: StartedPostgreSqlContainer;
let admin: Pool;
let registry: Pool;
let storage: WorkflowStorage;
let rootUrl: URL;
const pools: Pool[] = [];

function connectionUrl(database: string, user: string, password?: string, role?: string): string {
  const url = new URL(rootUrl.toString());
  url.username = user;
  url.password = password ?? '';
  url.pathname = `/${database}`;
  url.search = '';
  if (role) url.searchParams.set('options', `-c role=${role}`);
  return url.toString();
}

function pool(database: string, user: string, password?: string, role?: string): Pool {
  const selected = quiet(new Pool({ connectionString: connectionUrl(database, user, password, role), max: 2, connectionTimeoutMillis: 3000 }));
  pools.push(selected);
  return selected;
}

async function asOwner(database: string, action: (client: import('pg').PoolClient) => Promise<void>): Promise<void> {
  const selected = pool(database, provisioner, provisionerPassword, owner);
  try {
    const client = await selected.connect();
    try {
      const identity = await client.query('SELECT current_user,session_user');
      expect(identity.rows[0]).toEqual({ current_user: owner, session_user: provisioner });
      await action(client);
    } finally { client.release(); }
  } finally { await selected.end(); pools.splice(pools.indexOf(selected), 1); }
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  rootUrl = new URL(pg.getConnectionUri());
  admin = pool('postgres', pg.getUsername(), pg.getPassword());
  await admin.query(`CREATE ROLE ${owner} NOLOGIN NOINHERIT`);
  await admin.query(`CREATE ROLE ${provisioner} LOGIN NOINHERIT CREATEDB PASSWORD '${provisionerPassword}'`);
  await admin.query(`GRANT ${owner} TO ${provisioner}`);
  await admin.query(`CREATE ROLE ${runtime} LOGIN NOINHERIT PASSWORD '${runtimePassword}'`);
  await admin.query("CREATE ROLE lares_workflow_outsider LOGIN NOINHERIT PASSWORD 'test-only-outsider-password'");
  await admin.query("CREATE ROLE lares_app LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD 'test-only-app-password'");
  await admin.query("CREATE ROLE lares_financial LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD 'test-only-financial-password'");
  await admin.query('CREATE DATABASE lares_state');
  await admin.query('REVOKE CONNECT, TEMP ON DATABASE lares_state FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE lares_state TO lares_app, lares_financial');
  await admin.query(`CREATE DATABASE empty_workflow OWNER ${owner}`);

  // Run the exact pinned image setup entrypoint under the provisioner login and owner
  // session role. Secrets stay in the child process environment, never in URL or argv.
  const passwordDir = mkdtempSync(join(tmpdir(), 'lares-workflow-runtime-'));
  chmodSync(passwordDir, 0o700);
  const passwordPath = join(passwordDir, 'provisioner-password');
  writeFileSync(passwordPath, provisionerPassword, { mode: 0o600 });
  let setup: { stdout: string; stderr: string };
  try {
    setup = await execFileAsync(process.execPath, ['--input-type=module', '-e', "import { readFileSync } from 'node:fs'; process.env.PGPASSWORD = readFileSync(process.env.PGPASSWORD_FILE, 'utf8'); delete process.env.PGPASSWORD_FILE; import { Pool } from 'pg'; import { setupDatabase } from '@workflow/world-postgres/cli'; const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 1 }); try { const r = await pool.query('SELECT current_user, session_user, current_database()'); if (r.rows[0]?.current_user !== 'lares_workflow_owner' || r.rows[0]?.session_user !== 'lares_workflow_provisioner' || r.rows[0]?.current_database !== 'empty_workflow') throw new Error('workflow template authority check failed'); } finally { await pool.end(); } await setupDatabase();"], {
      cwd: creativeDir,
      env: {
      ...process.env,
      WORKFLOW_POSTGRES_URL: connectionUrl('empty_workflow', provisioner),
      PGPASSWORD_FILE: passwordPath,
      PGOPTIONS: `-c role=${owner}`,
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } finally { rmSync(passwordDir, { recursive: true, force: true }); }
  expect(setup.stdout).toContain('Database schema created successfully');
  expect(setup.stdout + setup.stderr).not.toContain(provisionerPassword);
  expect(setup.stdout + setup.stderr).not.toContain(runtimePassword);

  await asOwner('empty_workflow', async client => applyWorkflowRuntimePrivileges(client));
  const templateRuntime = pool('empty_workflow', runtime, runtimePassword);
  try {
    const client = await templateRuntime.connect();
    try {
      await verifyWorkflowRuntimePrivileges(client);
      const empty = await client.query(`SELECT
        (SELECT count(*)::int FROM workflow.workflow_event_slots) AS event_slots,
        (SELECT count(*)::int FROM workflow.workflow_events) AS events,
        (SELECT count(*)::int FROM workflow.workflow_hooks) AS hooks,
        (SELECT count(*)::int FROM workflow.workflow_runs) AS runs,
        (SELECT count(*)::int FROM workflow.workflow_steps) AS steps,
        (SELECT count(*)::int FROM workflow.workflow_stream_chunks) AS stream_chunks,
        (SELECT count(*)::int FROM workflow.workflow_waits) AS waits,
        (SELECT count(*)::int FROM graphile_worker._private_job_queues) AS queues,
        (SELECT count(*)::int FROM graphile_worker._private_jobs) AS jobs,
        (SELECT count(*)::int FROM graphile_worker._private_known_crontabs) AS crontabs,
        (SELECT count(*)::int FROM graphile_worker._private_tasks) AS tasks`);
      expect(Object.values(empty.rows[0]).every(value => value === 0)).toBe(true);
    }
    finally { client.release(); }
  } finally { await templateRuntime.end(); pools.splice(pools.indexOf(templateRuntime), 1); }
  // PostgreSQL otherwise lets only the template owner/superuser copy this database.
  // The install-time operator marks this prepared, owner-only template as cloneable.
  await admin.query('ALTER DATABASE empty_workflow IS_TEMPLATE true');

  await admin.query(`CREATE TABLE agent_resources (
    name text PRIMARY KEY, address inet NOT NULL, workflow_database text NOT NULL UNIQUE,
    ownership text NOT NULL, ownership_token uuid NOT NULL, runtime_control_token uuid,
    state text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  registry = admin;
  const provisionerPool = (database: string) => pool(database, provisioner, provisionerPassword);
  const runtimePool = (database: string) => pool(database, runtime, runtimePassword);
  storage = new WorkflowStorage(registry, pool('postgres', provisioner, provisionerPassword), 'empty_workflow', owner, {
    provisioner: provisionerPool,
    runtime: runtimePool,
  });
}, 60_000);

afterAll(async () => {
  for (const selected of pools.splice(0)) await selected.end().catch(() => undefined);
  await pg?.stop();
});

it('refuses an existing same-name workflow database when the owned marker was never recorded', async () => {
  const token = randomUUID();
  const database = `lares_${'b'.repeat(32)}`;
  await admin.query(`CREATE DATABASE ${database} OWNER ${owner} TEMPLATE empty_workflow`);
  await registry.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state)
    VALUES('unmarked-agent','127.0.0.3',$1,'owned',$2,$2,'provisioning')`, [database, token]);
  await expect(storage.provision('unmarked-agent', '127.0.0.3')).rejects.toThrow('Database ownership cannot be verified');
  expect((await registry.query("SELECT state FROM agent_resources WHERE name='unmarked-agent'")).rows[0].state).toBe('provisioning');
  expect((await admin.query(`SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [database])).rows[0].marker).toBeNull();
  await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await registry.query("DELETE FROM agent_resources WHERE name='unmarked-agent'");
});

it('clones verified workflow storage and starts the pinned world as the DML-only runtime login', async () => {
  const row = await storage.provision('proof-agent', '127.0.0.2');
  expect(row.state).toBe('ready');
  expect(row.workflow_database).toMatch(/^lares_[a-f0-9]{32}$/);
  expect((await admin.query('SELECT datistemplate FROM pg_database WHERE datname=$1', [row.workflow_database])).rows[0].datistemplate).toBe(false);

  await asOwner(row.workflow_database, client => client.query(`CREATE POLICY startup_gate_review ON graphile_worker._private_jobs FOR SELECT TO ${runtime} USING (true)`).then(() => undefined));
  await expect(storage.verifyReadyDatabases()).rejects.toThrow('unknown row policy');
  await asOwner(row.workflow_database, client => client.query('DROP POLICY startup_gate_review ON graphile_worker._private_jobs').then(() => undefined));
  await storage.verifyReadyDatabases();

  await asOwner(row.workflow_database, client => client.query('REVOKE EXECUTE ON FUNCTION graphile_worker.force_unlock_workers(text[]) FROM lares_workflow').then(() => undefined));
  await expect(storage.verifyReadyDatabases()).rejects.toThrow('function privileges are incomplete');
  await asOwner(row.workflow_database, async client => {
    const missingGrant = await client.query<{ allowed: boolean }>(`SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed`, [runtime, 'graphile_worker.force_unlock_workers(text[])']);
    expect(missingGrant.rows[0]?.allowed).toBe(false);
  });
  await asOwner(row.workflow_database, client => applyWorkflowRuntimePrivileges(client));
  await storage.verifyReadyDatabases();

  const engineDb = pool('lares_state', runtime, runtimePassword);
  try { await expect(engineDb.query('SELECT 1')).rejects.toMatchObject({ code: '42501' }); }
  finally { await engineDb.end(); pools.splice(pools.indexOf(engineDb), 1); }

  const runtimeUrl = connectionUrl(row.workflow_database, runtime, runtimePassword);
  const selectedRuntime = pool(row.workflow_database, runtime, runtimePassword);
  let completed = false;
  let world: { start(): Promise<void>; close(): Promise<void> } | undefined;
  try {
    const identity = await selectedRuntime.query(`SELECT current_user,session_user,current_database(),
      has_database_privilege(current_user,current_database(),'CONNECT') AS can_connect,
      has_database_privilege(current_user,current_database(),'CREATE') AS can_create,
      has_database_privilege(current_user,current_database(),'TEMP') AS can_temp,
      (SELECT max(id) FROM graphile_worker.migrations) AS graphile_head`);
    expect(identity.rows[0]).toEqual({ current_user: runtime, session_user: runtime, current_database: row.workflow_database, can_connect: true, can_create: false, can_temp: false, graphile_head: 18 });

    const { createWorld } = await import(pathToFileURL(worldEntry).href);
    const startedWorld = createWorld({ connectionString: runtimeUrl, maxPoolSize: 2, queueConcurrency: 1, applicationManagedShutdown: true });
    world = startedWorld;
    await startedWorld.start();
    const worker = await graphile.makeWorkerUtils({ connectionString: runtimeUrl });
    let job: { id: number };
    try { job = await worker.addJob('workflow-runtime-proof', { proof: true }); }
    finally { await worker.release(); }
    await startedWorld.close(); world = undefined;
    await graphile.runOnce({ connectionString: runtimeUrl, concurrency: 1 }, {
      'workflow-runtime-proof': async () => { completed = true; },
    });
    expect(completed).toBe(true);
    expect((await selectedRuntime.query('SELECT id FROM graphile_worker._private_jobs WHERE id=$1', [job.id])).rows).toHaveLength(0);

    const lockWorker = await graphile.makeWorkerUtils({ connectionString: runtimeUrl });
    let staleJob: { id: number };
    let recentJob: { id: number };
    try {
      staleJob = await lockWorker.addJob('workflow-stale-lock-proof', { proof: 'stale' }, { queueName: 'stale-lock-proof' });
      recentJob = await lockWorker.addJob('workflow-stale-lock-proof', { proof: 'recent' }, { queueName: 'recent-lock-proof' });
    } finally { await lockWorker.release(); }
    await selectedRuntime.query(`UPDATE graphile_worker._private_jobs SET locked_by='stale-worker-proof',locked_at=now()-interval '2 minutes',attempts=3 WHERE id=$1`, [staleJob.id]);
    await selectedRuntime.query(`UPDATE graphile_worker._private_job_queues SET locked_by='stale-worker-proof',locked_at=now()-interval '2 minutes' WHERE queue_name='stale-lock-proof'`);
    await selectedRuntime.query(`UPDATE graphile_worker._private_jobs SET locked_by='recent-worker-proof',locked_at=now(),attempts=2 WHERE id=$1`, [recentJob.id]);
    await selectedRuntime.query(`UPDATE graphile_worker._private_job_queues SET locked_by='recent-worker-proof',locked_at=now() WHERE queue_name='recent-lock-proof'`);

    const recoveryLogs: string[] = [];
    const released = await releaseStaleWorkflowLocks({
      env: { WORKFLOW_POSTGRES_URL: runtimeUrl },
      uptimeSeconds: () => 60,
      log: line => recoveryLogs.push(line),
      warn: line => { throw new Error(line); },
    });
    expect(released).toBe(1);
    expect(recoveryLogs).toHaveLength(1);
    const lockState = await selectedRuntime.query(`SELECT id,locked_by,locked_at,attempts FROM graphile_worker._private_jobs WHERE id=ANY($1::bigint[]) ORDER BY id`, [[staleJob.id, recentJob.id]]);
    expect(lockState.rows).toEqual([
      { id: staleJob.id, locked_by: null, locked_at: null, attempts: 3 },
      { id: recentJob.id, locked_by: 'recent-worker-proof', locked_at: expect.any(Date), attempts: 2 },
    ]);
    const queueState = await selectedRuntime.query(`SELECT queue_name,locked_by,locked_at FROM graphile_worker._private_job_queues WHERE queue_name=ANY($1::text[]) ORDER BY queue_name`, [['recent-lock-proof', 'stale-lock-proof']]);
    expect(queueState.rows).toEqual([
      { queue_name: 'recent-lock-proof', locked_by: 'recent-worker-proof', locked_at: expect.any(Date) },
      { queue_name: 'stale-lock-proof', locked_by: null, locked_at: null },
    ]);

    for (const sql of [
      'CREATE SCHEMA runtime_must_not_create',
      'CREATE TEMP TABLE runtime_must_not_create(id integer)',
      'CREATE TABLE workflow.runtime_must_not_create(id integer)',
      'ALTER TABLE graphile_worker._private_jobs ADD COLUMN runtime_must_not_add integer',
      'TRUNCATE graphile_worker._private_jobs',
      'GRANT EXECUTE ON FUNCTION graphile_worker.remove_job(text) TO PUBLIC',
      `SET ROLE ${owner}`,
    ]) await expect(selectedRuntime.query(sql)).rejects.toMatchObject({ code: '42501' });

    await asOwner(row.workflow_database, client => client.query(`GRANT INSERT ON graphile_worker.migrations TO ${runtime}`).then(() => undefined));
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('migration ledger');
    await asOwner(row.workflow_database, client => client.query(`REVOKE INSERT ON graphile_worker.migrations FROM ${runtime}`).then(() => undefined));

    await asOwner(row.workflow_database, client => client.query(`CREATE POLICY unexpected_runtime_policy ON graphile_worker._private_jobs FOR SELECT TO ${runtime} USING (true)`).then(() => undefined));
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('unknown row policy');
    await asOwner(row.workflow_database, client => client.query('DROP POLICY unexpected_runtime_policy ON graphile_worker._private_jobs').then(() => undefined));

    await asOwner(row.workflow_database, client => client.query(`DROP POLICY runtime__private_tasks ON graphile_worker._private_tasks; CREATE POLICY runtime__private_tasks ON graphile_worker._private_tasks AS RESTRICTIVE FOR ALL TO ${runtime} USING (true) WITH CHECK (true)`).then(() => undefined));
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('row policy');
    await expect(applyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('row policies');
    await expect(selectedRuntime.query("INSERT INTO graphile_worker._private_tasks(identifier) VALUES ('review-restrictive-policy')")).rejects.toMatchObject({ code: '42501' });
    await asOwner(row.workflow_database, client => client.query(`DROP POLICY runtime__private_tasks ON graphile_worker._private_tasks; CREATE POLICY runtime__private_tasks ON graphile_worker._private_tasks AS PERMISSIVE FOR ALL TO ${runtime} USING (true) WITH CHECK (true)`).then(() => undefined));
    await verifyWorkflowRuntimePrivileges(selectedRuntime);

    await asOwner(row.workflow_database, client => client.query(`GRANT EXECUTE ON FUNCTION graphile_worker.remove_job(text) TO ${runtime}`).then(() => undefined));
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('function inventory');
    await asOwner(row.workflow_database, client => client.query(`REVOKE EXECUTE ON FUNCTION graphile_worker.remove_job(text) FROM ${runtime}`).then(() => undefined));

    await asOwner(row.workflow_database, client => client.query(`GRANT SELECT ON graphile_worker._private_jobs TO lares_workflow_outsider`).then(() => undefined));
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('table ACL');
    await asOwner(row.workflow_database, client => client.query(`REVOKE SELECT ON graphile_worker._private_jobs FROM lares_workflow_outsider`).then(() => undefined));

    await asOwner(row.workflow_database, client => client.query(`GRANT SELECT ON graphile_worker._private_jobs TO ${runtime} WITH GRANT OPTION`).then(() => undefined));
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('table ACL');
    await asOwner(row.workflow_database, client => client.query(`REVOKE SELECT ON graphile_worker._private_jobs FROM ${runtime}`).then(() => undefined));
    await asOwner(row.workflow_database, client => client.query(`GRANT SELECT ON graphile_worker._private_jobs TO ${runtime}`).then(() => undefined));
    await asOwner(row.workflow_database, client => client.query(`GRANT SELECT (id) ON graphile_worker._private_jobs TO lares_workflow_outsider`).then(() => undefined));
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('column ACL');
    await asOwner(row.workflow_database, client => client.query(`REVOKE SELECT (id) ON graphile_worker._private_jobs FROM lares_workflow_outsider`).then(() => undefined));

    await asOwner(row.workflow_database, client => client.query('CREATE FUNCTION graphile_worker.review_unknown() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$').then(() => undefined));
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('function inventory');
    await asOwner(row.workflow_database, client => client.query('DROP FUNCTION graphile_worker.review_unknown()').then(() => undefined));

    await asOwner(row.workflow_database, client => client.query('CREATE FUNCTION graphile_worker.review_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER review_trigger BEFORE INSERT ON graphile_worker._private_jobs FOR EACH ROW EXECUTE FUNCTION graphile_worker.review_trigger()').then(() => undefined));
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('function inventory');
    await asOwner(row.workflow_database, client => client.query('DROP TRIGGER review_trigger ON graphile_worker._private_jobs; DROP FUNCTION graphile_worker.review_trigger()').then(() => undefined));

    const rootDatabase = pool(row.workflow_database, pg.getUsername(), pg.getPassword());
    try {
      await rootDatabase.query(`ALTER SCHEMA workflow OWNER TO ${runtime}`);
      await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('schema ownership');
      await rootDatabase.query(`ALTER SCHEMA workflow OWNER TO ${owner}`);
    } finally { await rootDatabase.end(); pools.splice(pools.indexOf(rootDatabase), 1); }
    await asOwner(row.workflow_database, client => applyWorkflowRuntimePrivileges(client));

    await admin.query("GRANT SET ON PARAMETER session_replication_role TO lares_workflow");
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('replication-role');
    await admin.query("REVOKE SET ON PARAMETER session_replication_role FROM lares_workflow");

    await admin.query(`GRANT CONNECT ON DATABASE ${row.workflow_database} TO lares_workflow_outsider`);
    await admin.query(`GRANT ${runtime} TO lares_workflow_outsider`);
    const outsider = pool(row.workflow_database, 'lares_workflow_outsider', 'test-only-outsider-password');
    try {
      expect((await outsider.query('SELECT current_user,session_user')).rows[0]).toEqual({ current_user: 'lares_workflow_outsider', session_user: 'lares_workflow_outsider' });
      await outsider.query(`SET ROLE ${runtime}`);
      expect((await outsider.query('SELECT current_user,session_user')).rows[0]).toEqual({ current_user: runtime, session_user: 'lares_workflow_outsider' });
    } finally { await outsider.end(); pools.splice(pools.indexOf(outsider), 1); }
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('runtime-role');
    await admin.query(`REVOKE ${runtime} FROM lares_workflow_outsider`);
    await admin.query(`REVOKE CONNECT ON DATABASE ${row.workflow_database} FROM lares_workflow_outsider`);

    await admin.query(`GRANT ${owner} TO ${runtime}`);
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('role identity');
    await admin.query(`REVOKE ${owner} FROM ${runtime}`);
    await admin.query(`ALTER ROLE ${runtime} BYPASSRLS`);
    await expect(verifyWorkflowRuntimePrivileges(selectedRuntime)).rejects.toThrow('runtime-role');
    await admin.query(`ALTER ROLE ${runtime} NOBYPASSRLS`);
    await verifyWorkflowRuntimePrivileges(selectedRuntime);

    // Simulate a process crash after ACL initialization and before the registry ready write.
    await registry.query("UPDATE agent_resources SET state='provisioning' WHERE name='proof-agent'");
    const repaired = await storage.provision('proof-agent', '127.0.0.2');
    expect(repaired.state).toBe('ready');
    expect((await registry.query("SELECT state FROM agent_resources WHERE name='proof-agent'")).rows[0].state).toBe('ready');
  } finally {
    if (world) await world.close().catch(() => undefined);
    await selectedRuntime.end(); pools.splice(pools.indexOf(selectedRuntime), 1);
  }
});
