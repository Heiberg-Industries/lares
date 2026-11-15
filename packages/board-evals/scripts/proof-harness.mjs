import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
export const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(signal)));
// `probe-extension` is not a pnpm workspace member (see its package.json comment) and ships no
// `dist/`: nothing runs `eve extension build` inside it as part of install or `eve build`. Every
// entry point that copies this package and then runs `eve build` against the copy needs that
// `dist/` to exist in THIS source tree first, since the copy is a plain `cpSync` — a missing
// `dist/` here means a missing one in every temp copy too. Built once, here, so repeat runs
// (and every temp copy) reuse it instead of rebuilding per invocation.
export async function ensureProbeExtensionBuilt() {
  const dist = join(source, 'probe-extension/dist');
  if (existsSync(dist)) return;
  const eve = join(source, 'node_modules/.bin/eve');
  await run(eve, ['extension', 'build'], { cwd: join(source, 'probe-extension'), env: { ...process.env, EVE_TELEMETRY_DISABLED: '1' } });
}
export function run(command, args, { cwd, env, input, acceptedCodes = [0], timeout = 300_000 } = {}) {
  abort.signal.throwIfAborted();
  return new Promise((resolveRun, reject) => {
    // A dedicated process group lets cleanup reach only this runner's descendants.
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const stop = () => { stopped = abort.signal.reason ?? new Error('Command timed out'); kill(); };
    const timer = setTimeout(stop, timeout);
    abort.signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.stdin.on('error', error => { stopped = error; kill(); });
    child.stdin.end(input);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer); abort.signal.removeEventListener('abort', stop);
      let surviving = false;
      try { process.kill(-child.pid, 0); surviving = true; } catch {}
      kill();
      if (stopped || !acceptedCodes.includes(code) || surviving) reject(Object.assign(stopped ?? new Error(`${command} ${args.join(' ')} exited ${code}${surviving ? '; owned descendants survived' : ''}\n${stdout}\n${stderr}`), { stdout, stderr }));
      else resolveRun({ stdout, stderr, pid: child.pid });
    });
  });
}
export function makeApp(databaseUrl, live = '1') {
  const root = mkdtempSync(join(tmpdir(), 'lares-eight-evals-'));
  try {
    cpSync(source, root, { recursive: true, filter: path => !['node_modules', '.eve', '.output', '.workflow-data', '.git'].includes(basename(path)) && !basename(path).startsWith('.env') });
    symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'));
    // An allowlist prevents inherited model credentials, workflow stores and owner settings.
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    Object.assign(env, { EVE_TELEMETRY_DISABLED: '1', DATABASE_URL: databaseUrl, EVE_SCHEDULES_LIVE: live, NODE_ENV: 'production', LARES_DEFINITION_DIR: join(root, 'definition'), LARES_AGENT_NAME: 'board-evals', LARES_AGENT_INCARNATION: '11111111-1111-4111-8111-111111111111', LARES_SLACK_CLAIM_REVISION: '22222222-2222-4222-8222-222222222222', LARES_SLACK_PRINCIPAL: 'U_SYNTHETIC' });
    mkdirSync(env.LARES_DEFINITION_DIR);
    for (const [key, value] of Object.entries({ SEAM_GRANTS: '[]', BOARD_LEVELS: '{}', BOARD_SKEW: '0', BOARD_LOG: '', BOARD_EVENTS: '', PROOF_MODEL_LOG: '' })) {
      env[key] = join(root, key); writeFileSync(env[key], value);
    }
    writeFileSync(env.BOARD_EVENTS + '.resumed', '');
    writeFileSync(join(env.LARES_DEFINITION_DIR, 'agent.json'), JSON.stringify({ name: 'board-evals', model: 'fixture-brain', persona: 'voice.md', role: 'creative', grants: [{ capability: 'vault', scope: 'write-with-confirm', areas: ['shared'] }], autonomy: { vault: 'autonomous' }, schedules: { 'probe-tick': { on: true } } }));
    writeFileSync(join(env.LARES_DEFINITION_DIR, 'voice.md'), 'A synthetic voice.');
    writeFileSync(join(env.LARES_DEFINITION_DIR, 'duties.md'), 'Mind the synthetic shop.');
    // The launcher is addressed in the SOURCE tree: pnpm's launcher script finds eve by a path relative
    // to its own location, which the copy's symlinked node_modules does not preserve.
    return { root, env, eve: join(source, 'node_modules/.bin/eve'), dispose: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

// The fixture has no HTTP door of its own (`eve eval` brings its own local one). A proof that
// drives a BUILT server with `eve start` writes this one into its disposable copy before building:
// eve's own door, behind a throwaway password that exists nowhere else.
export const FIXTURE_DOOR = { username: 'fixture', password: 'disposable-fixture-only' };
export const FIXTURE_DOOR_SRC = `import { eveChannel } from 'eve/channels/eve';
import { httpBasic } from 'eve/channels/auth';
export default eveChannel({ auth: [httpBasic({ username: '${FIXTURE_DOOR.username}', password: '${FIXTURE_DOOR.password}' })] });
`;
export function addFixtureDoor(root) {
  mkdirSync(join(root, 'agent/channels'), { recursive: true });
  writeFileSync(join(root, 'agent/channels/eve.ts'), FIXTURE_DOOR_SRC);
}
const freePort = () => new Promise((done, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
});
/**
 * One `eve start` process for an already-built app, in its own process group. `stop()` kills the
 * whole group and resolves only once the group is gone, so a caller that starts another server
 * afterwards has a real process boundary between the two.
 */
export async function startServer(app) {
  abort.signal.throwIfAborted();
  const port = await freePort();
  const child = spawn(app.eve, ['start', '--host', '127.0.0.1', '--port', String(port)], { cwd: app.root, env: app.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  const closed = new Promise(done => child.once('close', done));
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  abort.signal.addEventListener('abort', kill, { once: true });
  // A clean stop first (SIGTERM, as a container runtime sends), so the process boundary is the one
  // a restart or an upgrade makes; the hard kill is only the fallback for a server that will not go.
  // PROOF_HARD_KILL=1 skips the clean stop, to measure a crash instead.
  const stop = async () => {
    if (!process.env.PROOF_HARD_KILL) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await Promise.race([closed, new Promise(r => setTimeout(r, 15_000))]);
    }
    kill(); await closed;
    for (let i = 0; i < 100; i += 1) {
      try { process.kill(-child.pid, 0); } catch { abort.signal.removeEventListener('abort', kill); return; }
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`eve start (pid ${child.pid}) left processes behind`);
  };
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i += 1) {
      if (child.exitCode !== null) throw new Error(`eve start exited ${child.exitCode}\n${log}`);
      try { if ((await fetch(`${url}/eve/v1/health`)).ok) break; } catch {}
      if (i >= 300) throw new Error(`eve start never answered\n${log}`);
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (error) { await stop().catch(() => {}); throw error; }
  return { url, pid: child.pid, stop, log: () => log };
}
