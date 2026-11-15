import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyWorkflowRuntimePrivileges, WORKFLOW_SCHEMA_STEPS } from '../lib/workflow-database-privileges.js';
import { engineDatabasePrivilegesMatch } from '../lib/database-privileges.js';
import { quiet } from './helpers/quiet-pool.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const box = join(repo, 'services/box');
const creative = join(repo, 'services/creative');
const tsx = join(repo, 'node_modules/.bin/tsx');
const secretDir = mkdtempSync(join(tmpdir(), 'lares-db-cutover-'));
chmodSync(secretDir, 0o700);
const secretPaths = new Map<string, string>();
for (const name of ['operator', 'app', 'financial', 'outside', 'provisioner', 'workflow', 'gateway']) {
  const path = join(secretDir, `${name}-password`);
  writeFileSync(path, randomBytes(36).toString('base64url'), { mode: 0o600 });
  secretPaths.set(name, path);
}
const password = (name: string) => readFileSync(secretPaths.get(name)!, 'utf8').trim();
function exec(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Buffer | string; timeout?: number } = {}): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeout ?? 60_000);
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code === 0 && !timedOut) resolve(result);
      else reject(new Error(`${file} ${args[0] ?? ''} exited ${timedOut ? 'after timeout' : code}: ${result.stderr.toString('utf8')}`));
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}
async function failureMessage(command: Promise<unknown>): Promise<string> {
  try {
    await command;
  } catch (error) {
    const message = String(error);
    expect(message).not.toContain('after timeout');
    return message;
  }
  throw new Error('expected command to fail');
}

let pg: StartedPostgreSqlContainer;
let admin: Pool;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const connection = new URL(pg.getConnectionUri());
  admin = quiet(new Pool({ connectionString: pg.getConnectionUri(), max: 1 }));
  await admin.query(`CREATE ROLE lares_operator LOGIN SUPERUSER PASSWORD '${password('operator')}'`);
  env = {
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: String(connection.port),
  };
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await pg?.stop();
  rmSync(secretDir, { recursive: true, force: true });
});

it('sets up, finalizes, migrates, and restores the exact managed database roles and ACLs', async () => {
  const operatorArgs = ['--operator-password-file', secretPaths.get('operator')!, '--workflow-password-file', secretPaths.get('workflow')!];

  // A missing template must fail promptly and release the already-open admin client.
  const missingTemplate = await failureMessage(exec(tsx, ['bin/database-setup.ts', '--finalize-workflow-template', ...operatorArgs], { cwd: box, env, timeout: 10_000 }));
  expect(missingTemplate).toMatch(/database .*empty_workflow|connect/i);
  // The restore verifier must likewise close its pool when the expected engine database is absent.
  const missingEngineDatabase = await failureMessage(exec(tsx, ['bin/database-setup.ts', '--verify-restored-engine',
    '--operator-password-file', secretPaths.get('operator')!, '--app-password-file', secretPaths.get('app')!,
    '--financial-password-file', secretPaths.get('financial')!, '--outside-custody-password-file', secretPaths.get('outside')!], { cwd: box, env, timeout: 10_000 }));
  expect(missingEngineDatabase).toMatch(/lares_state|database|connect/i);

  const setup = await exec(tsx, ['bin/database-setup.ts',
    '--operator-password-file', secretPaths.get('operator')!,
    '--app-password-file', secretPaths.get('app')!,
    '--financial-password-file', secretPaths.get('financial')!,
    '--outside-custody-password-file', secretPaths.get('outside')!,
    '--workflow-provisioner-password-file', secretPaths.get('provisioner')!,
    '--workflow-password-file', secretPaths.get('workflow')!,
    '--gateway-password-file', secretPaths.get('gateway')!,
  ], { cwd: box, env });
  expect(setup.stdout.toString() + setup.stderr.toString()).not.toContain(password('operator'));

  const workflowUrl = `postgres://lares_workflow_provisioner@${env.PGHOST}:${env.PGPORT}/empty_workflow`;
  // The workflow package's own schema step, through the one program the installer and the updater
  // share, fed to node on standard input from the role's folder as the role image runs it.
  const storeProgram = readFileSync(join(box, 'ops/workflow-store-migrate.mjs'));
  const storeStep = (mode: string) => exec(process.execPath, ['--input-type=module', '-', mode, 'empty_workflow'], {
    cwd: creative, input: storeProgram,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, WORKFLOW_POSTGRES_URL: workflowUrl, PGPASSWORD: password('provisioner'), PGOPTIONS: '-c role=lares_workflow_owner' },
  });
  expect((await storeStep('check')).stdout.toString().trim()).toBe('empty');
  const setupWorkflow = await storeStep('create');
  expect((await storeStep('check')).stdout.toString().trim()).toBe('current');
  expect(setupWorkflow.stdout.toString()).toContain('Database schema created successfully');
  expect(setupWorkflow.stdout.toString() + setupWorkflow.stderr.toString()).not.toContain(password('provisioner'));

  await exec(tsx, ['bin/workflow-template.ts', 'apply', '--host', env.PGHOST!, '--port', env.PGPORT!,
    '--provisioner-password-file', secretPaths.get('provisioner')!, '--runtime-password-file', secretPaths.get('workflow')!], { cwd: box, env });
  // Wrong runtime credentials fail closed and release both short-lived pools.
  const wrongWorkflowPassword = await failureMessage(exec(tsx, ['bin/workflow-template.ts', 'verify-database', '--host', env.PGHOST!, '--port', env.PGPORT!,
    '--database', 'empty_workflow', '--runtime-password-file', secretPaths.get('app')!], { cwd: box, env, timeout: 10_000 }));
  expect(wrongWorkflowPassword).toMatch(/authentication|password|failed/i);
  // Before it is finalized the template is not a template yet, so the update's check refuses it.
  const notYet = await failureMessage(exec(tsx, ['bin/database-setup.ts', '--verify-workflow-template', ...operatorArgs], { cwd: box, env, timeout: 20_000 }));
  expect(notYet).toContain('workflow template owner or template state is unexpected');
  await exec(tsx, ['bin/database-setup.ts', '--finalize-workflow-template', ...operatorArgs], { cwd: box, env });
  // Finalized: the update's check passes and changes nothing; finalizing twice is refused.
  const verified = await exec(tsx, ['bin/database-setup.ts', '--verify-workflow-template', ...operatorArgs], { cwd: box, env });
  expect(verified.stdout.toString()).toContain("workflow template verified: empty, owned, and at this release's workflow schema");
  const twice = await failureMessage(exec(tsx, ['bin/database-setup.ts', '--finalize-workflow-template', ...operatorArgs], { cwd: box, env, timeout: 20_000 }));
  expect(twice).toContain('workflow template owner or pre-finalized state is unexpected');
  expect((await admin.query('SELECT datistemplate FROM pg_database WHERE datname=$1', ['empty_workflow'])).rows[0].datistemplate).toBe(true);
  await exec(tsx, ['migrate.ts', '--schema-owner'], {
    cwd: box,
    env: { ...env, PGUSER: 'lares_operator', PGDATABASE: 'lares_state', DATABASE_PASSWORD_FILE: secretPaths.get('operator')!, LARES_OPERATOR_PASSWORD_FILE: secretPaths.get('operator')! },
  });

  // Exercise the same custom archive format and create-aware restore path used by maintenance.
  // The Testcontainers image does not contain the host secret mount. Inject only a disposable
  // file into this one local test container, then use it for the actual pg_dump/pg_restore calls.
  const operatorMount = `/tmp/${randomBytes(12).toString('hex')}-operator`;
  await exec('docker', ['cp', secretPaths.get('operator')!, `${pg.getId()}:${operatorMount}`], { env });
  await exec('docker', ['exec', pg.getId(), 'chmod', '600', operatorMount], { env });
  const engineDump = await exec('docker', ['exec', pg.getId(), 'sh', '-ec',
    `export PGHOST=127.0.0.1 PGPASSWORD="$(cat '${operatorMount}')"; exec pg_dump -U lares_operator --create --format=custom -d lares_state`], { env });
  const workflowName = `lares_${'a'.repeat(32)}`;
  await admin.query(`CREATE DATABASE "${workflowName}" WITH TEMPLATE empty_workflow OWNER lares_workflow_owner`);
  const token = '11111111-1111-4111-8111-111111111111';
  await admin.query(`COMMENT ON DATABASE "${workflowName}" IS 'lares-owned:${token}'`);
  const provisioner = quiet(new Pool({
    host: env.PGHOST, port: Number(env.PGPORT), database: workflowName,
    user: 'lares_workflow_provisioner', password: password('provisioner'), max: 1,
  }));
  const provisionerClient = await provisioner.connect();
  try {
    const identity = await provisionerClient.query('SELECT current_user,session_user');
    expect(identity.rows[0]).toEqual({ current_user: 'lares_workflow_provisioner', session_user: 'lares_workflow_provisioner' });
    await provisionerClient.query('SET ROLE lares_workflow_owner');
    await applyWorkflowRuntimePrivileges(provisionerClient);
    await provisionerClient.query('RESET ROLE');
  } finally {
    provisionerClient.release();
    await provisioner.end();
  }
  const workflowDump = await exec('docker', ['exec', pg.getId(), 'sh', '-ec',
    `export PGHOST=127.0.0.1 PGPASSWORD="$(cat '${operatorMount}')"; exec pg_dump -U lares_operator --create --format=custom -d '${workflowName}'`], { env });
  expect(engineDump.stdout.length).toBeGreaterThan(0);

  await admin.query('DROP DATABASE lares_state');
  await exec('docker', ['exec', '-i', pg.getId(), 'sh', '-ec',
    `export PGHOST=127.0.0.1 PGPASSWORD="$(cat '${operatorMount}')"; exec pg_restore --exit-on-error --create -U lares_operator -d postgres`], { env, input: engineDump.stdout });
  await exec('docker', ['exec', pg.getId(), 'dropdb', '-U', 'lares_operator', workflowName], { env });
  await exec('docker', ['exec', '-i', pg.getId(), 'sh', '-ec',
    `export PGHOST=127.0.0.1 PGPASSWORD="$(cat '${operatorMount}')"; exec pg_restore --exit-on-error --create -U lares_operator -d postgres`], { env, input: workflowDump.stdout });

  await exec(tsx, ['bin/database-setup.ts', '--verify-restored-engine',
    '--operator-password-file', secretPaths.get('operator')!, '--app-password-file', secretPaths.get('app')!,
    '--financial-password-file', secretPaths.get('financial')!, '--outside-custody-password-file', secretPaths.get('outside')!], { cwd: box, env });
  await exec(tsx, ['bin/workflow-template.ts', 'verify-database', '--host', env.PGHOST!, '--port', env.PGPORT!,
    '--database', workflowName, '--runtime-password-file', secretPaths.get('workflow')!], { cwd: box, env });

  const workflowMeta = await admin.query('SELECT pg_get_userbyid(datdba) AS owner, shobj_description(oid,\'pg_database\') AS marker FROM pg_database WHERE datname=$1', [workflowName]);
  expect(workflowMeta.rows[0].owner).toBe('lares_workflow_owner');
  expect(workflowMeta.rows[0].marker).toBe(`lares-owned:${token}`);
  const runtime = quiet(new Pool({ host: env.PGHOST, port: Number(env.PGPORT), database: workflowName, user: 'lares_workflow', password: password('workflow'), max: 1 }));
  try {
    const acl = await runtime.query(`SELECT
      has_database_privilege(current_user,current_database(),'CONNECT') AS connect,
      has_database_privilege(current_user,current_database(),'CREATE') AS create,
      has_database_privilege(current_user,current_database(),'TEMP') AS temp,
      current_user,session_user`);
    expect(acl.rows[0]).toEqual({ connect: true, create: false, temp: false, current_user: 'lares_workflow', session_user: 'lares_workflow' });
    // A fresh install's store, after a dump and restore, is at this release's full list of schema
    // steps, and the agent login has the new tables and the sequence one of them needs.
    const steps = await runtime.query<{ hash: string; created_at: string }>('SELECT hash,created_at::text AS created_at FROM workflow_drizzle.workflow_migrations ORDER BY id');
    expect(steps.rows.map((row) => [row.created_at, row.hash])).toEqual(WORKFLOW_SCHEMA_STEPS.map((step) => [...step]));
    expect(steps.rows).toHaveLength(31);
    for (const table of ['workflow_invocations', 'workflow_job_lock_holders', 'workflow_snapshots', 'workflow_start_hook_admissions']) {
      const granted = await runtime.query(`SELECT has_table_privilege(current_user,'workflow.${table}','SELECT,INSERT,UPDATE,DELETE') AS use,
        has_table_privilege(current_user,'workflow.${table}','TRUNCATE') AS truncate`);
      expect(granted.rows[0], table).toEqual({ use: true, truncate: false });
    }
    await runtime.query("INSERT INTO workflow.workflow_invocations(run_id,request_id,payload,fingerprint) VALUES('run','request','\\x01','f')");
    expect((await runtime.query('SELECT sequence FROM workflow.workflow_invocations')).rows).toHaveLength(1);
  } finally { await runtime.end(); }
}, 240_000);

it('an update whose migration adds a table gives the engine logins that table\'s permissions', async () => {
  // The state an earlier release leaves behind: set up with the logins, then a newer migration
  // creates a table under the schema owner, with no grants. Made here by taking the newest table
  // away and forgetting its migration, so the next run applies it exactly as an update does.
  const connection = new URL(pg.getConnectionUri());
  connection.pathname = '/lares_state';
  const engine = quiet(new Pool({ connectionString: connection.toString(), max: 1 }));
  const migrateEnv = { ...env, PGUSER: 'lares_operator', PGDATABASE: 'lares_state', DATABASE_PASSWORD_FILE: secretPaths.get('operator')!, LARES_OPERATOR_PASSWORD_FILE: secretPaths.get('operator')! };
  const loginPool = (role: string, secret: string) => quiet(new Pool({ host: env.PGHOST, port: Number(env.PGPORT), database: 'lares_state', user: role, password: password(secret), max: 1 }));
  const financial = loginPool('lares_financial', 'financial');
  const app = loginPool('lares_app', 'app');
  try {
    expect(await engineDatabasePrivilegesMatch(engine)).toBe(true);
    // Every migration after 035 is taken away too: the runner refuses to slot a file beneath
    // one already applied, so they all reapply in order, as on a real update.
    await engine.query('DROP TABLE agent_account_bindings');
    await engine.query("DELETE FROM schema_migrations WHERE filename='036_agent_account_bindings.sql'");
    await engine.query('DROP TABLE agent_provider_keys');
    await engine.query("DELETE FROM schema_migrations WHERE filename='035_agent_provider_keys.sql'");
    await engine.query('SET ROLE lares_schema_owner');
    await engine.query(readFileSync(join(box, 'sql/035_agent_provider_keys.sql'), 'utf8'));
    await engine.query('RESET ROLE');
    // This is what an updated server had: the spend check's provider-key lookup is refused.
    await expect(financial.query("SELECT revision FROM agent_provider_keys WHERE agent=$1 AND state='active'", ['proof-agent'])).rejects.toMatchObject({ code: '42501' });
    expect(await engineDatabasePrivilegesMatch(engine)).toBe(false);
    await engine.query('DROP TABLE agent_provider_keys');

    const update = await exec(tsx, ['migrate.ts', '--schema-owner'], { cwd: box, env: migrateEnv });
    expect(update.stdout.toString()).toContain('035_agent_provider_keys.sql');
    expect((await financial.query("SELECT revision FROM agent_provider_keys WHERE agent=$1 AND state='active'", ['proof-agent'])).rows).toEqual([]);
    expect((await app.query('SELECT revision FROM agent_provider_keys')).rows).toEqual([]);
    expect(update.stdout.toString()).toContain("the database logins were given the permissions this release's tables need");
    await expect(financial.query('SELECT set_at FROM agent_provider_keys')).rejects.toMatchObject({ code: '42501' });
    expect(await engineDatabasePrivilegesMatch(engine)).toBe(true);

    // Running it again changes nothing, and says so.
    const again = await exec(tsx, ['migrate.ts', '--schema-owner'], { cwd: box, env: migrateEnv });
    expect(again.stdout.toString()).toContain("the database logins' permissions already match this release");
    await exec(tsx, ['bin/database-setup.ts', '--verify-restored-engine',
      '--operator-password-file', secretPaths.get('operator')!, '--app-password-file', secretPaths.get('app')!,
      '--financial-password-file', secretPaths.get('financial')!, '--outside-custody-password-file', secretPaths.get('outside')!], { cwd: box, env });
  } finally {
    await Promise.all([engine.end(), financial.end(), app.end()]);
  }
}, 60_000);
