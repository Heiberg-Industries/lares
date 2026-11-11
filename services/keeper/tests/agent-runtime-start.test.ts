import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

// The start script runs the built server itself (`exec node ./.output/server/index.mjs`), with no
// eve launcher in between. The stub server stands where the built one would; the stub `eve`
// only leaves a marker, so a start that still went through the launcher is caught.
const SERVER_STUB = `import { writeFileSync } from 'node:fs';
const e = process.env;
if (e.LARES_TEST_SERVER_RECORD) writeFileSync(e.LARES_TEST_SERVER_RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  set: { HOST: e.HOST, NITRO_HOST: e.NITRO_HOST, PORT: e.PORT, NITRO_PORT: e.NITRO_PORT },
  stripped: ['CI', 'TEST', 'SERVER_SHUTDOWN_TIMEOUT', 'NITRO_UNIX_SOCKET'].filter(name => name in e),
  schedulesDisabled: e.EVE_SCHEDULES_DISABLED ?? null,
}));
process.stdout.write([e.WORKFLOW_POSTGRES_URL, e.PGPASSWORD, e.WORKFLOW_POSTGRES_PASSWORD_FILE ?? 'unset'].join('\\n') + '\\n');
`;
function stubRuntime(dir: string) {
  mkdirSync(join(dir, '.output/server'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(dir, '.output/server/index.mjs'), SERVER_STUB);
  writeFileSync(join(dir, 'node_modules/.bin/eve'), `#!/bin/sh\nprintf ran > '${join(dir, 'eve-ran')}'\n`, { mode: 0o755 });
}

it('keeps the app password in PGPASSWORD and adds the workflow password only to the server process environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lares-runtime-entrypoint-'));
  try {
    stubRuntime(dir);
    const script = resolve('../../images/agent-runtime/start.sh');
    writeFileSync(join(dir, 'guard.sh'), 'exit 0\n');
    writeFileSync(join(dir, 'app-password'), 'app-only-secret\n');
    writeFileSync(join(dir, 'workflow-password'), 'workflow:@secret\n');
    const capture = execFileSync('/bin/sh', [script], { cwd: dir, env: {
      ...process.env,
      LARES_REQUIRED_SETTINGS: join(dir, 'guard.sh'),
      DATABASE_PASSWORD_FILE: join(dir, 'app-password'),
      WORKFLOW_POSTGRES_PASSWORD_FILE: join(dir, 'workflow-password'),
      WORKFLOW_POSTGRES_URL: 'postgres://lares_workflow@db/lares_abc',
    }, encoding: 'utf8' });
    expect(capture).toBe('postgres://lares_workflow:workflow%3A%40secret@db/lares_abc\napp-only-secret\nunset\n');
    expect(capture).not.toContain('workflow-password');
    expect(existsSync(join(dir, 'eve-ran'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('runs the built server directly on 0.0.0.0:3000, without the eve launcher and without the variables the launcher stripped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lares-runtime-entrypoint-direct-'));
  try {
    stubRuntime(dir);
    const script = resolve('../../images/agent-runtime/start.sh');
    writeFileSync(join(dir, 'guard.sh'), 'exit 0\n');
    writeFileSync(join(dir, 'app-password'), 'app-only-secret\n');
    writeFileSync(join(dir, 'workflow-password'), 'workflow-secret\n');
    const record = join(dir, 'server-record.json');
    const env: Record<string, string | undefined> = {
      ...process.env,
      LARES_REQUIRED_SETTINGS: join(dir, 'guard.sh'),
      DATABASE_PASSWORD_FILE: join(dir, 'app-password'),
      WORKFLOW_POSTGRES_PASSWORD_FILE: join(dir, 'workflow-password'),
      WORKFLOW_POSTGRES_URL: 'postgres://lares_workflow@db/lares_abc',
      LARES_TEST_SERVER_RECORD: record,
      // What a caller's environment could carry in: each must be gone or overridden at the server.
      CI: 'true', TEST: '1', SERVER_SHUTDOWN_TIMEOUT: '1', NITRO_UNIX_SOCKET: '/tmp/never.sock',
      HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', PORT: '9', NITRO_PORT: '9',
    };
    delete env.EVE_SCHEDULES_DISABLED;
    execFileSync('/bin/sh', [script], { cwd: dir, env, encoding: 'utf8' });
    const seen = JSON.parse(readFileSync(record, 'utf8'));
    expect(seen.argv).toEqual([]);
    expect(seen.set).toEqual({ HOST: '0.0.0.0', NITRO_HOST: '0.0.0.0', PORT: '3000', NITRO_PORT: '3000' });
    expect(seen.stripped).toEqual([]);
    // Schedules stay on: the script never sets the variable that turns them off.
    expect(seen.schedulesDisabled).toBeNull();
    expect(existsSync(join(dir, 'eve-ran'))).toBe(false);
    const source = readFileSync(script, 'utf8');
    expect(source).toMatch(/^exec node \.\/\.output\/server\/index\.mjs$/m);
    expect(source.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')).not.toMatch(/\beve\b/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ['missing', undefined],
  ['unreadable', 'missing-workflow-password'],
  ['empty', ''],
  ['newline-only', '\n'],
  ['multiple newlines', '\n\n'],
])('refuses %s workflow password before the server runs', (_label, password) => {
  const dir = mkdtempSync(join(tmpdir(), 'lares-runtime-entrypoint-refuse-'));
  const serverMarker = join(dir, 'server-record.json');
  try {
    stubRuntime(dir);
    const script = resolve('../../images/agent-runtime/start.sh');
    writeFileSync(join(dir, 'guard.sh'), 'exit 0\n');
    writeFileSync(join(dir, 'app-password'), 'app-only-secret\n');
    if (password !== undefined && password !== 'missing-workflow-password') writeFileSync(join(dir, 'workflow-password'), password);
    expect(() => execFileSync('/bin/sh', [script], { cwd: dir, env: {
      ...process.env,
      LARES_REQUIRED_SETTINGS: join(dir, 'guard.sh'),
      DATABASE_PASSWORD_FILE: join(dir, 'app-password'),
      WORKFLOW_POSTGRES_PASSWORD_FILE: password === undefined ? undefined : join(dir, password === 'missing-workflow-password' ? 'missing' : 'workflow-password'),
      WORKFLOW_POSTGRES_URL: 'postgres://lares_workflow@db/lares_abc',
      LARES_TEST_SERVER_RECORD: serverMarker,
    }, encoding: 'utf8', stdio: 'pipe' })).toThrow();
    expect(existsSync(serverMarker)).toBe(false);
    expect(existsSync(join(dir, 'eve-ran'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
