import { spawn } from 'node:child_process';
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
    return { root, env, eve: join(root, 'node_modules/.bin/eve'), dispose: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
