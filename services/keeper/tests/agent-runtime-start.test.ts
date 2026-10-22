import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('keeps the app password in PGPASSWORD and adds the workflow password only to Eve process environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lares-runtime-entrypoint-'));
  try {
    mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
    const script = resolve('../../images/agent-runtime/start.sh');
    writeFileSync(join(dir, 'guard.sh'), 'exit 0\n');
    writeFileSync(join(dir, 'app-password'), 'app-only-secret\n');
    writeFileSync(join(dir, 'workflow-password'), 'workflow:@secret\n');
    writeFileSync(join(dir, 'node_modules/.bin/eve'), '#!/bin/sh\nprintf "%s\\n%s\\n%s\\n" "$WORKFLOW_POSTGRES_URL" "$PGPASSWORD" "${WORKFLOW_POSTGRES_PASSWORD_FILE-unset}"\n', { mode: 0o755 });
    const capture = execFileSync('/bin/sh', [script], { cwd: dir, env: {
      ...process.env,
      LARES_REQUIRED_SETTINGS: join(dir, 'guard.sh'),
      DATABASE_PASSWORD_FILE: join(dir, 'app-password'),
      WORKFLOW_POSTGRES_PASSWORD_FILE: join(dir, 'workflow-password'),
      WORKFLOW_POSTGRES_URL: 'postgres://lares_workflow@db/lares_abc',
    }, encoding: 'utf8' });
    expect(capture).toBe('postgres://lares_workflow:workflow%3A%40secret@db/lares_abc\napp-only-secret\nunset\n');
    expect(capture).not.toContain('workflow-password');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ['missing', undefined],
  ['unreadable', 'missing-workflow-password'],
  ['empty', ''],
  ['newline-only', '\n'],
  ['multiple newlines', '\n\n'],
])('refuses %s workflow password before Eve runs', (_label, password) => {
  const dir = mkdtempSync(join(tmpdir(), 'lares-runtime-entrypoint-refuse-'));
  const eveMarker = join(dir, 'eve-ran');
  try {
    mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
    const script = resolve('../../images/agent-runtime/start.sh');
    writeFileSync(join(dir, 'guard.sh'), 'exit 0\n');
    writeFileSync(join(dir, 'app-password'), 'app-only-secret\n');
    if (password !== undefined && password !== 'missing-workflow-password') writeFileSync(join(dir, 'workflow-password'), password);
    writeFileSync(join(dir, 'node_modules/.bin/eve'), `#!/bin/sh\nprintf ran > '${eveMarker}'\n`, { mode: 0o755 });
    expect(() => execFileSync('/bin/sh', [script], { cwd: dir, env: {
      ...process.env,
      LARES_REQUIRED_SETTINGS: join(dir, 'guard.sh'),
      DATABASE_PASSWORD_FILE: join(dir, 'app-password'),
      WORKFLOW_POSTGRES_PASSWORD_FILE: password === undefined ? undefined : join(dir, password === 'missing-workflow-password' ? 'missing' : 'workflow-password'),
      WORKFLOW_POSTGRES_URL: 'postgres://lares_workflow@db/lares_abc',
    }, encoding: 'utf8', stdio: 'pipe' })).toThrow();
    expect(() => readFileSync(eveMarker, 'utf8')).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
