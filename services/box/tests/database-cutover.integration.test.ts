import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyWorkflowRuntimePrivileges } from '../lib/workflow-database-privileges.js';
import { quiet } from './helpers/quiet-pool.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const box = join(repo, 'services/box');
const creative = join(repo, 'services/creative');
const tsx = join(repo, 'node_modules/.bin/tsx');
const secretDir = mkdtempSync(join(tmpdir(), 'lares-db-cutover-'));
chmodSync(secretDir, 0o700);
const secretPaths = new Map<string, string>();
for (const name of ['operator', 'app', 'financial', 'provisioner', 'workflow', 'gateway']) {
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
    '--financial-password-file', secretPaths.get('financial')!], { cwd: box, env, timeout: 10_000 }));
  expect(missingEngineDatabase).toMatch(/lares_state|database|connect/i);

  const setup = await exec(tsx, ['bin/database-setup.ts',
    '--operator-password-file', secretPaths.get('operator')!,
    '--app-password-file', secretPaths.get('app')!,
    '--financial-password-file', secretPaths.get('financial')!,
    '--workflow-provisioner-password-file', secretPaths.get('provisioner')!,
    '--workflow-password-file', secretPaths.get('workflow')!,
    '--gateway-password-file', secretPaths.get('gateway')!,
  ], { cwd: box, env });
  expect(setup.stdout.toString() + setup.stderr.toString()).not.toContain(password('operator'));

  const workflowUrl = `postgres://lares_workflow_provisioner@${env.PGHOST}:${env.PGPORT}/empty_workflow`;
  const setupWorkflow = await exec(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    process.env.PGPASSWORD = readFileSync(process.env.PROVISIONER_PASSWORD_FILE, 'utf8').trim();
    delete process.env.PROVISIONER_PASSWORD_FILE;
    const { Pool } = await import('pg');
    const { setupDatabase } = await import('@workflow/world-postgres/cli');
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 1 });
    try {
      const identity = await pool.query('SELECT current_user, session_user, current_database()');
      if (identity.rows[0]?.current_user !== 'lares_workflow_owner' || identity.rows[0]?.session_user !== 'lares_workflow_provisioner' || identity.rows[0]?.current_database !== 'empty_workflow') throw new Error('workflow setup identity failed');
    } finally { await pool.end(); }
    await setupDatabase();
  `], {
    cwd: creative,
    env: { ...env, WORKFLOW_POSTGRES_URL: workflowUrl, PROVISIONER_PASSWORD_FILE: secretPaths.get('provisioner')!, PGOPTIONS: '-c role=lares_workflow_owner' },
  });
  expect(setupWorkflow.stdout.toString()).toContain('Database schema created successfully');
  expect(setupWorkflow.stdout.toString() + setupWorkflow.stderr.toString()).not.toContain(password('provisioner'));

  await exec(tsx, ['bin/workflow-template.ts', 'apply', '--host', env.PGHOST!, '--port', env.PGPORT!,
    '--provisioner-password-file', secretPaths.get('provisioner')!, '--runtime-password-file', secretPaths.get('workflow')!], { cwd: box, env });
  // Wrong runtime credentials fail closed and release both short-lived pools.
  const wrongWorkflowPassword = await failureMessage(exec(tsx, ['bin/workflow-template.ts', 'verify-database', '--host', env.PGHOST!, '--port', env.PGPORT!,
    '--database', 'empty_workflow', '--runtime-password-file', secretPaths.get('app')!], { cwd: box, env, timeout: 10_000 }));
  expect(wrongWorkflowPassword).toMatch(/authentication|password|failed/i);
  await exec(tsx, ['bin/database-setup.ts', '--finalize-workflow-template', ...operatorArgs], { cwd: box, env });
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
    '--financial-password-file', secretPaths.get('financial')!], { cwd: box, env });
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
  } finally { await runtime.end(); }
}, 60_000);
