// Proves how a role container starts: maintenance admission, then the start script, then the built
// server, with nothing in between.
//
//   maintenance-admission.sh (opens the gate lock as descriptor 9, takes the shared lock, checks
//   the receipt)  ->  exec start.sh (settings guard, database passwords)  ->  exec node
//   ./.output/server/index.mjs
//
// Every step is an `exec`, so the server IS the process the wrapper was started as, and it holds
// the very descriptor the wrapper locked. There is no eve launcher in the chain: eve 1.0's
// `eve start` spawns the server with three stdio entries, which would drop descriptor 9 and with
// it the lock that keeps agents stopped during maintenance.
//
// This runs the REAL wrapper and the REAL start script from this checkout against a stub server
// that records what it was started with. Root only: the wrapper insists on root-owned custody
// files under a root-owned path, exactly as on an installation.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

if (process.getuid?.() !== 0) throw new Error('Startup admission proof requires the isolated CI root fixture');

const role = process.argv[2];
if (role !== 'chief-of-staff' && role !== 'creative') throw new Error('pass the role image being proved');

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const wrapper = path.join(repo, 'services/box/ops/maintenance-admission.sh');
const startScript = path.join(repo, 'images/agent-runtime/start.sh');
// The same generated settings check each role's image bakes in (see the role Dockerfiles).
const settingsGuard = path.join(repo, 'images/agent-runtime',
  role === 'chief-of-staff' ? 'required-settings-chief-of-staff.sh' : 'required-settings.sh');

// The start script must not go through the launcher, and the installed launcher must be the
// framework's own: it carries no maintenance handoff, so nothing may rely on it for one.
const startSource = readFileSync(startScript, 'utf8');
const startCommands = startSource.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
assert.match(startCommands, /^exec node \.\/\.output\/server\/index\.mjs$/m, 'the start script does not exec the built server');
assert.doesNotMatch(startCommands, /\beve\b/, 'the start script still calls the eve launcher');
const roleRequire = createRequire(new URL(`../../${role}/package.json`, import.meta.url));
function eveRoot() {
  let current = path.dirname(roleRequire.resolve('eve'));
  while (current !== path.dirname(current)) {
    const packageFile = path.join(current, 'package.json');
    if (existsSync(packageFile) && JSON.parse(readFileSync(packageFile, 'utf8')).name === 'eve') return current;
    current = path.dirname(current);
  }
  throw new Error('could not locate the installed eve package');
}
const launcher = readFileSync(path.join(eveRoot(), 'dist/src/internal/nitro/host/start-production-server.js'), 'utf8');
assert.ok(!launcher.includes('LARES_MAINTENANCE'), 'the installed eve launcher carries a maintenance patch nothing uses any more');
assert.ok(launcher.includes('stdio:[`ignore`,`pipe`,`pipe`]'),
  'the installed eve launcher no longer starts the server with three stdio entries; re-read it before trusting this proof');

const parentDir = '/run/lares-maintenance';
const admissionDir = '/run/lares-maintenance/admission';
if (existsSync(parentDir)) throw new Error('fixed admission test path already exists on the CI runner');
mkdirSync(parentDir, { mode: 0o755 });
mkdirSync(admissionDir, { mode: 0o755 });
const installationId = '11111111-1111-4111-8111-111111111111';
const epoch = '7';
const gatePath = path.join(admissionDir, 'service-gate.lock');
const intentPath = path.join(admissionDir, 'intent.json');
const writeGate = () => { rmSync(gatePath, { force: true }); writeFileSync(gatePath, '', { mode: 0o444 }); };
const writeIntent = (state = 'normal') => {
  rmSync(intentPath, { force: true });
  writeFileSync(intentPath, JSON.stringify({ epoch: Number(epoch), installationId, state, version: 1 }) + '\n', { mode: 0o444 });
};
writeGate();
writeIntent();

const root = path.join(os.tmpdir(), `lares-startup-admission-${process.pid}-${Date.now()}`);
mkdirSync(root, { mode: 0o700 });
const appRoot = path.join(root, 'app');
mkdirSync(path.join(appRoot, '.output/server'), { recursive: true });
// Stands where the built server would. It records the descriptor it inherited and how it was
// started, then stays alive like a server until it is told to stop.
writeFileSync(path.join(appRoot, '.output/server/index.mjs'), `import { fstatSync, writeFileSync } from 'node:fs';
const e = process.env;
const gate = (() => { try { const s = fstatSync(9); return { dev: s.dev, ino: s.ino, isFile: s.isFile() }; } catch (error) { return { error: error.code }; } })();
writeFileSync(e.LARES_TEST_SERVER_RECORD, JSON.stringify({
  pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), gate,
  listen: { HOST: e.HOST, NITRO_HOST: e.NITRO_HOST, PORT: e.PORT, NITRO_PORT: e.NITRO_PORT },
  stripped: ['CI', 'TEST', 'SERVER_SHUTDOWN_TIMEOUT', 'NITRO_UNIX_SOCKET'].filter(name => name in e),
  schedulesDisabled: e.EVE_SCHEDULES_DISABLED ?? null,
  workflowUrl: e.WORKFLOW_POSTGRES_URL, workflowPasswordFile: e.WORKFLOW_POSTGRES_PASSWORD_FILE ?? null,
  admission: [e.LARES_MAINTENANCE_ADMISSION_DIR, e.LARES_MAINTENANCE_INSTALLATION_ID, e.LARES_MAINTENANCE_EPOCH],
}));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
// A stand-in launcher: a start that still went through `eve start` leaves this marker.
const launcherMarker = path.join(root, 'launcher-ran');
mkdirSync(path.join(appRoot, 'node_modules/.bin'), { recursive: true });
writeFileSync(path.join(appRoot, 'node_modules/.bin/eve'), `#!/bin/sh\nprintf ran > '${launcherMarker}'\n`, { mode: 0o755 });
const secrets = path.join(root, 'secrets');
mkdirSync(secrets, { mode: 0o700 });
for (const name of ['database-password', 'workflow-password', 'gateway-key']) writeFileSync(path.join(secrets, name), `${name}-fixture\n`, { mode: 0o400 });
mkdirSync(path.join(root, 'definition'));

function environment(label, changes = {}) {
  const env = {
    // The wrapper and the start script call `node` by name; make sure it is this one.
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`,
    LARES_REQUIRED_SETTINGS: settingsGuard,
    DATABASE_URL: 'postgres://proof@db/proof',
    WORKFLOW_POSTGRES_URL: 'postgres://proof@db/proof',
    DATABASE_PASSWORD_FILE: path.join(secrets, 'database-password'),
    WORKFLOW_POSTGRES_PASSWORD_FILE: path.join(secrets, 'workflow-password'),
    GATEWAY_URL: 'http://gateway.invalid:4000',
    GATEWAY_KEY_FILE: path.join(secrets, 'gateway-key'),
    LARES_AGENT_NAME: 'helper',
    LARES_DEFINITION_DIR: path.join(root, 'definition'),
    LARES_TEST_SERVER_RECORD: path.join(root, `${label}.server`),
    // What the caller's environment may carry in. The server must see none of the first four,
    // and must listen where the image says rather than where these point.
    CI: 'true', TEST: '1', SERVER_SHUTDOWN_TIMEOUT: '1', NITRO_UNIX_SOCKET: '/tmp/never.sock',
    HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', PORT: '9', NITRO_PORT: '9',
    ...changes,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}
// The container's own command line: the wrapper as entrypoint with the receipt directory, the
// installation and the epoch, then the start script as its command, from the role's app folder.
const command = (wantedEpoch = epoch) => [wrapper, admissionDir, installationId, wantedEpoch, '--', '/bin/sh', startScript];
const record = label => path.join(root, `${label}.server`);

function refusedBeforeServer(label, { wantedEpoch, changes, expectStderr } = {}) {
  const result = spawnSync('/bin/sh', command(wantedEpoch), { cwd: appRoot, env: environment(label, changes), encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 78, `${label} status; stdout=${result.stdout} stderr=${result.stderr}`);
  if (expectStderr) expectStderr(result.stderr);
  else assert.equal(result.stderr.trim(), 'maintenance admission refused');
  assert.equal(existsSync(record(label)), false, `${label} reached the server`);
  assert.equal(existsSync(launcherMarker), false, `${label} reached the eve launcher`);
}
const exclusiveLock = () => spawnSync('flock', ['--exclusive', '--nonblock', gatePath, 'true'], { encoding: 'utf8', timeout: 10000 }).status;
async function waitFor(check, what) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`timed out waiting for ${what}`);
}

test('a valid receipt starts the built server as the admitted process, holding the gate lock for its whole life', async () => {
  const label = 'valid';
  assert.equal(exclusiveLock(), 0, 'the gate was already locked before anything started');
  const child = spawn('/bin/sh', command(), { cwd: appRoot, env: environment(label), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await waitFor(() => existsSync(record(label)) || child.exitCode !== null, 'the server to start');
    assert.ok(existsSync(record(label)), `the server never ran; output=${output}`);
    const seen = JSON.parse(readFileSync(record(label), 'utf8'));
    const gate = statSync(gatePath);

    // The server is the process the wrapper was started as: every step exec'd, nothing spawned.
    assert.equal(seen.pid, child.pid, 'a process sits between the admission wrapper and the server');
    const commandLine = readFileSync(`/proc/${child.pid}/cmdline`).toString().split('\0').filter(Boolean);
    assert.equal(path.basename(commandLine[0]), 'node');
    assert.deepEqual(commandLine.slice(1), ['./.output/server/index.mjs']);
    assert.deepEqual(seen.argv, []);
    assert.equal(seen.cwd, appRoot, 'the wrapper did not return to the role folder before the start script ran');
    assert.equal(existsSync(launcherMarker), false, 'the start went through the eve launcher');

    // It holds the wrapper's own open descriptor on the gate file, seen from inside and outside.
    assert.equal(seen.gate.error, undefined, `the server has no descriptor 9: ${seen.gate.error}`);
    assert.equal(seen.gate.isFile, true);
    assert.deepEqual([seen.gate.dev, seen.gate.ino], [gate.dev, gate.ino], 'descriptor 9 is not the gate file');
    const outside = statSync(`/proc/${child.pid}/fd/9`);
    assert.deepEqual([outside.dev, outside.ino], [gate.dev, gate.ino]);
    // Maintenance takes the lock exclusively; it cannot while the server lives.
    assert.equal(exclusiveLock(), 1, 'maintenance could take the gate while the server was running');

    assert.deepEqual(seen.listen, { HOST: '0.0.0.0', NITRO_HOST: '0.0.0.0', PORT: '3000', NITRO_PORT: '3000' });
    assert.deepEqual(seen.stripped, []);
    assert.equal(seen.schedulesDisabled, null, 'the start script turned schedules off');
    assert.equal(seen.workflowUrl, 'postgres://proof:workflow-password-fixture@db/proof');
    assert.equal(seen.workflowPasswordFile, null);
    assert.deepEqual(seen.admission, [admissionDir, installationId, epoch]);
  } finally {
    child.kill('SIGTERM');
    const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 10000))]);
    if (result === null) { child.kill('SIGKILL'); await exited; }
  }
  // ... and it is free again the moment the server is gone.
  assert.equal(exclusiveLock(), 0, 'the gate stayed locked after the server stopped');
});

test('a missing receipt is refused before the server runs', () => {
  rmSync(intentPath, { force: true });
  try { refusedBeforeServer('missing-receipt'); } finally { writeIntent(); }
});

test('a receipt for another epoch is refused before the server runs', () => {
  refusedBeforeServer('wrong-epoch', { wantedEpoch: '8' });
});

test('a receipt for another installation is refused before the server runs', () => {
  const result = spawnSync('/bin/sh', [wrapper, admissionDir, '22222222-2222-4222-8222-222222222222', epoch, '--', '/bin/sh', startScript],
    { cwd: appRoot, env: environment('wrong-installation'), encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 78);
  assert.equal(result.stderr.trim(), 'maintenance admission refused');
  assert.equal(existsSync(record('wrong-installation')), false);
});

test('maintenance that is entering is refused before the server runs', () => {
  writeIntent('entering');
  try { refusedBeforeServer('entering'); } finally { writeIntent(); }
});

test('a gate file that root does not own is refused before the server runs', () => {
  chownSync(gatePath, 10001, 10001);
  try { refusedBeforeServer('wrong-owner'); } finally { writeGate(); }
});

test('a receipt anyone could rewrite is refused before the server runs', () => {
  rmSync(intentPath, { force: true });
  writeFileSync(intentPath, JSON.stringify({ epoch: Number(epoch), installationId, state: 'normal', version: 1 }) + '\n', { mode: 0o644 });
  try { refusedBeforeServer('writable-receipt'); } finally { writeIntent(); }
});

test('while maintenance holds the gate, an agent cannot start', async () => {
  // Its own process group, so the stand-in and the `sleep` it runs are stopped together.
  const holder = spawn('flock', ['--exclusive', '--nonblock', gatePath, 'sleep', '30'], { stdio: 'ignore', detached: true });
  const holderExited = new Promise(resolve => holder.once('exit', resolve));
  try {
    await waitFor(() => exclusiveLock() === 1, 'the maintenance stand-in to take the gate');
    refusedBeforeServer('maintenance-holds-gate');
  } finally {
    try { process.kill(-holder.pid, 'SIGKILL'); } catch { holder.kill('SIGKILL'); }
    await holderExited;
  }
  await waitFor(() => exclusiveLock() === 0, 'the gate to be released');
});

test('a missing required setting is refused after admission and before the server runs', () => {
  refusedBeforeServer('missing-setting', {
    changes: { GATEWAY_URL: undefined },
    expectStderr: stderr => {
      assert.match(stderr, /GATEWAY_URL/);
      assert.doesNotMatch(stderr, /maintenance admission refused/);
      assert.doesNotMatch(stderr, /-fixture/, 'the refusal printed a secret');
    },
  });
  // The refused start let go of the gate again.
  assert.equal(exclusiveLock(), 0);
});

test.after(() => {
  rmSync(parentDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
