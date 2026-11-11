// A backup from the release before this one, restored onto this release, against a real PostgreSQL.
//
// What is real: the server; the workflow roles as bin/database-setup.ts creates them; an agent
// store built EXACTLY as the previous release's workflow package left it (its first 20 schema
// steps, from the steps this checkout's package ships, applied by the package's own migrator) with
// the previous release's grants and rows the agents wrote; a real `pg_dump -Fc` of it; the real
// `pg_restore` output restore.sh reads before changing anything (ops/workflow-backup-layout.py);
// a real `pg_restore --create` as restore.sh runs it; and the shared steps restore.sh and update.sh
// both run on such a store (ops/workflow-store-steps.sh), with ops/workflow-store-migrate.mjs and
// bin/workflow-template.ts doing the work.
//
// What is not: restore.sh itself (tests/restore.test.ts drives its order and refusals with stubs)
// and the role image (the store program runs on this machine's node, from services/creative, as
// tests/workflow-store-update.integration.test.ts runs it).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKFLOW_SCHEMA_STEPS, WORKFLOW_SCHEMA_STEPS_BEFORE } from '../lib/workflow-database-privileges.js';
import { quiet } from './helpers/quiet-pool.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const box = join(repo, 'services/box');
const creative = join(repo, 'services/creative');
const tsx = join(repo, 'node_modules/.bin/tsx');
const STORE = `lares_${'c'.repeat(32)}`;
const PREVIOUS_TABLES = ['workflow_event_slots', 'workflow_events', 'workflow_hooks', 'workflow_runs', 'workflow_steps', 'workflow_stream_chunks', 'workflow_waits'];
const QUEUE_TABLES = ['_private_job_queues', '_private_jobs', '_private_known_crontabs', '_private_tasks'];

const work = mkdtempSync(join(tmpdir(), 'lares-restore-older-'));
chmodSync(work, 0o700);
const secret = (name: string) => join(work, `${name}-password`);
for (const name of ['operator', 'app', 'financial', 'outside', 'provisioner', 'workflow', 'gateway']) {
  writeFileSync(secret(name), randomBytes(36).toString('base64url'), { mode: 0o600 });
}
const password = (name: string) => readFileSync(secret(name), 'utf8').trim();

let pg: StartedPostgreSqlContainer;
let admin: Pool;
let host = '';
let port = '';
const env = () => ({ ...process.env, PGHOST: host, PGPORT: port });
const login = (user: string, name: string, database: string, options?: string) =>
  quiet(new Pool({ host, port: Number(port), database, user, password: password(name), max: 1, options }));
async function using<T>(pool: Pool, job: (pool: Pool) => Promise<T>): Promise<T> {
  try { return await job(pool); } finally { await pool.end(); }
}
const asOwner = <T>(database: string, job: (pool: Pool) => Promise<T>) => using(login('lares_workflow_provisioner', 'provisioner', database, '-c role=lares_workflow_owner'), job);
const asRuntime = <T>(database: string, job: (pool: Pool) => Promise<T>) => using(login('lares_workflow', 'workflow', database), job);
const engine = (args: string[]) => spawnSync(tsx, args, { cwd: box, env: env(), encoding: 'utf8', timeout: 120_000 });

// The previous release's schema, as tests/workflow-store-update.integration.test.ts builds it.
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

async function previousReleaseStore(database: string): Promise<void> {
  await admin.query(`CREATE DATABASE "${database}" OWNER lares_workflow_owner`);
  await admin.query(`COMMENT ON DATABASE "${database}" IS 'lares-owned:11111111-1111-4111-8111-111111111111'`);
  await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO lares_workflow_provisioner`);
  const built = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: creative, input: PREVIOUS_SCHEMA, encoding: 'utf8', timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PGPASSWORD: password('provisioner'), PGOPTIONS: '-c role=lares_workflow_owner',
      WORKFLOW_POSTGRES_URL: `postgres://lares_workflow_provisioner@${host}:${port}/${database}` },
  });
  expect(built.status, built.stderr).toBe(0);
  // The grants the previous release gave the agent login: its seven tables, nothing newer.
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
      await owner.query(`CREATE POLICY "runtime_${table}" ON graphile_worker."${table}" FOR ALL TO lares_workflow USING (true) WITH CHECK (true)`);
      await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON graphile_worker."${table}" TO lares_workflow`);
    }
    await owner.query('GRANT USAGE ON SEQUENCE graphile_worker.job_queues_id_seq, graphile_worker.jobs_id_seq1, graphile_worker.tasks_id_seq TO lares_workflow');
    await owner.query('REVOKE USAGE ON TYPE workflow.status, workflow.step_status, workflow.wait_status, graphile_worker.job_spec FROM PUBLIC');
    await owner.query('GRANT USAGE ON TYPE graphile_worker.job_spec TO lares_workflow');
    await owner.query(`GRANT EXECUTE ON FUNCTION graphile_worker.add_job(text,json,text,timestamptz,integer,text,integer,text[],text),
      graphile_worker.add_jobs(graphile_worker.job_spec[],boolean), graphile_worker.force_unlock_workers(text[]) TO lares_workflow`);
  });
}

/** One row in a table of the previous schema, as the agent login wrote it, every required column filled by its type. */
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
const rowsOf = (database: string) => asOwner(database, async (owner) => ({
  runs: (await owner.query("SELECT id,extract(epoch FROM created_at)::text AS created FROM workflow.workflow_runs ORDER BY id")).rows,
  events: (await owner.query('SELECT id,run_id FROM workflow.workflow_events ORDER BY id')).rows,
}));
const stepCount = (database: string) => asOwner(database, async (owner) => (await owner.query('SELECT count(*)::int AS n FROM workflow_drizzle.workflow_migrations')).rows[0].n as number);

async function inContainer(command: string): Promise<string> {
  const result = await pg.exec(['sh', '-c', command]);
  expect(result.exitCode, result.output).toBe(0);
  return result.stdout;
}
/** What restore.sh does before anything changes: read the layout out of the dump, no database involved. */
async function layoutOf(dump: string): Promise<{ code: number | null; out: string; err: string }> {
  writeFileSync(join(work, 'toc'), await inContainer(`pg_restore -l ${dump}`));
  writeFileSync(join(work, 'data'), await inContainer(`pg_restore --data-only -n workflow_drizzle -n graphile_worker -t workflow_migrations -t migrations -f - ${dump}`));
  const result = spawnSync('python3', [join(box, 'ops/workflow-backup-layout.py'), join(box, 'lib/workflow-database-privileges.ts'),
    join(box, 'ops/workflow-store-migrate.mjs'), join(work, 'toc'), join(work, 'data')], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}
const user = () => pg.getUsername();
const dumpStore = (file: string) => inContainer(`pg_dump -U ${user()} -Fc -f ${file} ${STORE}`);

/**
 * restore.sh's store step after pg_restore: the shared steps, sourced exactly as restore.sh sources
 * them. Only workflow_store_step (engine-run.sh: the role image) and workflow_apply_one (restore's
 * guarded engine job) are replaced, by the same programs run on this machine.
 */
function restoreStoreStep(failUpgrade = false) {
  const script = `
set -euo pipefail
. ${JSON.stringify(join(box, 'ops/workflow-store-steps.sh'))}
workflow_store_step() { # ROLE_IMAGE MODE DATABASE HOST PORT PROVISIONER_PASSWORD_FILE
  if [ "$2" = upgrade ] && [ "${failUpgrade ? 1 : 0}" = 1 ]; then echo "workflow store: the step was stopped (test)" >&2; return 1; fi
  (cd ${JSON.stringify(creative)} && PGPASSWORD="$(cat "$6")" PGOPTIONS='-c role=lares_workflow_owner' \\
    WORKFLOW_POSTGRES_URL="postgres://lares_workflow_provisioner@$4:$5/$3" node --input-type=module - "$2" "$3" < ${JSON.stringify(join(box, 'ops/workflow-store-migrate.mjs'))})
}
workflow_apply_one() { # KIND DATABASE ERRFILE
  (cd ${JSON.stringify(box)} && ${JSON.stringify(tsx)} bin/workflow-template.ts apply-database --host "$HOST" --port "$PORT" --database "$2" \\
    --provisioner-password-file ${JSON.stringify(secret('provisioner'))} --runtime-password-file ${JSON.stringify(secret('workflow'))}) >/dev/null 2> "$3"
}
state=$(workflow_store_state role-image "$STORE" "$HOST" "$PORT" ${JSON.stringify(secret('provisioner'))} "$WORK/check.err") || { cat "$WORK/check.err" >&2; exit 1; }
[ "$state" = old ] || { echo "state $state" >&2; exit 1; }
workflow_store_bring_current restore role-image "$HOST" "$PORT" ${JSON.stringify(secret('provisioner'))} "$WORK" store "$STORE" old "the agent store $STORE" \\
  || { echo "$WORKFLOW_REASON" >&2; exit 75; }
`;
  return spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', timeout: 240_000, env: { ...env(), HOST: host, PORT: port, STORE, WORK: work } });
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const connection = new URL(pg.getConnectionUri());
  host = connection.hostname;
  port = String(connection.port);
  admin = quiet(new Pool({ connectionString: pg.getConnectionUri(), max: 1 }));
  await admin.query(`CREATE ROLE lares_operator LOGIN SUPERUSER PASSWORD '${password('operator')}'`);
  const setup = engine(['bin/database-setup.ts',
    '--operator-password-file', secret('operator'), '--app-password-file', secret('app'),
    '--financial-password-file', secret('financial'), '--outside-custody-password-file', secret('outside'),
    '--workflow-provisioner-password-file', secret('provisioner'), '--workflow-password-file', secret('workflow'),
    '--gateway-password-file', secret('gateway')]);
  expect(setup.status, setup.stderr).toBe(0);
  await previousReleaseStore(STORE);
  await asRuntime(STORE, async (runtime) => {
    await seedRow(runtime, 'workflow_runs', { id: 'run_one' });
    await seedRow(runtime, 'workflow_runs', { id: 'run_two', started_at: '2026-11-01T10:00:00.000Z' });
    await seedRow(runtime, 'workflow_events', { id: 'evt_1', run_id: 'run_one' });
  });
  await dumpStore('/tmp/older.dump');
}, 300_000);
afterAll(async () => {
  await admin?.end();
  await pg?.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('restoring an agent store from the release before this one', () => {
  it('reads the older layout out of the backup before anything changes', async () => {
    expect(await layoutOf('/tmp/older.dump')).toEqual({ code: 0, out: 'old', err: '' });
  });

  it('a failed upgrade leaves the restored store as the backup had it, and the same steps then finish it', async () => {
    const before = await rowsOf(STORE);
    await admin.query(`DROP DATABASE "${STORE}" WITH (FORCE)`);
    await inContainer(`pg_restore --exit-on-error --create -U ${user()} -d postgres /tmp/older.dump`);
    const failed = restoreStoreStep(true);
    expect(failed.status, failed.stderr).toBe(75);
    expect(failed.stderr).toContain(`the agent store ${STORE}: the step was stopped (test)`);
    expect(await stepCount(STORE)).toBe(WORKFLOW_SCHEMA_STEPS_BEFORE);

    // What a second run of the same restore does: drop, restore from the backup again, upgrade.
    await admin.query(`DROP DATABASE "${STORE}" WITH (FORCE)`);
    await inContainer(`pg_restore --exit-on-error --create -U ${user()} -d postgres /tmp/older.dump`);
    const done = restoreStoreStep();
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain(`restore: upgrading the agent store ${STORE}.`);
    expect(done.stdout + done.stderr).not.toContain(password('provisioner'));

    // restore.sh's own final check, as the agents' login: exactly this release's 30 steps and grants.
    const verified = engine(['bin/workflow-template.ts', 'verify-database', '--host', host, '--port', port, '--database', STORE,
      '--runtime-password-file', secret('workflow')]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(await stepCount(STORE)).toBe(WORKFLOW_SCHEMA_STEPS.length);
    expect(await rowsOf(STORE)).toEqual(before);
    const owner = await admin.query("SELECT pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [STORE]);
    expect(owner.rows[0]).toEqual({ owner: 'lares_workflow_owner', marker: 'lares-owned:11111111-1111-4111-8111-111111111111' });
  }, 300_000);

  it('reads a store from this release as current, and refuses one from a newer release', async () => {
    await dumpStore('/tmp/current.dump');
    expect(await layoutOf('/tmp/current.dump')).toEqual({ code: 0, out: 'current', err: '' });
    await asOwner(STORE, (owner) => owner.query("INSERT INTO workflow_drizzle.workflow_migrations(hash,created_at) VALUES($1,$2)", ['f'.repeat(64), 1790300000000]));
    await dumpStore('/tmp/newer.dump');
    const newer = await layoutOf('/tmp/newer.dump');
    expect(newer.code).toBe(3);
    expect(newer.err).toBe(`it was written by a newer release: it has ${WORKFLOW_SCHEMA_STEPS.length + 1} schema steps recorded, and this release knows ${WORKFLOW_SCHEMA_STEPS.length}`);
  }, 120_000);
});
