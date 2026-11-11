import { createConnection } from 'node:net';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { VAULT_BROKER_REFUSAL_REASONS, vaultBrokerRequest } from '@lares/agent-kit/vault-broker-client';
import { createBoundedVaultBrokerServer, prepareVaultRuntimeDirectory, serveConsoleVaultBroker } from '../lib/vault-console-broker.js';

const servers: import('node:net').Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('prepares only a real root-owned-mode runtime directory and refuses symlink or file paths', async () => {
  const created = await mkdtemp(join(tmpdir(), 'vault-runtime-dir-')), root = await realpath(created); roots.push(created);
  const ready = join(root, 'run', 'vault');
  await prepareVaultRuntimeDirectory(ready, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
  const stat = await lstat(ready);
  expect(stat.isDirectory()).toBe(true); expect(stat.isSymbolicLink()).toBe(false);
  expect(stat.mode & 0o777).toBe(0o750); expect(stat.uid).toBe(process.getuid?.() ?? 0);
  const target = join(root, 'target'); await mkdir(target);
  const link = join(root, 'link'); await symlink(target, link);
  await expect(prepareVaultRuntimeDirectory(join(link, 'vault'), process.getuid?.() ?? 0, process.getgid?.() ?? 0)).rejects.toThrow('runtime directory');
  const file = join(root, 'file'); await writeFile(file, 'x');
  await expect(prepareVaultRuntimeDirectory(join(file, 'vault'), process.getuid?.() ?? 0, process.getgid?.() ?? 0)).rejects.toThrow('runtime directory');
});

it('refuses missing and malformed console keys before opening broker sockets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-key-custody-')); roots.push(root);
  const consoleSocket = join(root, 'console.sock'), runtimeSocket = join(root, 'runtime', 'read.sock');
  const key = join(root, 'console-vault-signing-key');
  await expect(serveConsoleVaultBroker({} as never, key, root, runtimeSocket, { consoleSocket, rootUid: process.getuid?.() ?? 0 })).rejects.toThrow();
  await writeFile(key, 'not-a-key');
  await expect(serveConsoleVaultBroker({} as never, key, root, runtimeSocket, { consoleSocket, rootUid: process.getuid?.() ?? 0 })).rejects.toThrow();
  await expect(lstat(consoleSocket)).rejects.toThrow();
});

it('absorbs a client reset during a pending reply and continues serving bounded requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-broker-socket-')); roots.push(root);
  const path = join(root, 'read.sock'), state = { clients: new Set<import('node:net').Socket>(), inFlight: 0 };
  let calls = 0;
  const server = createBoundedVaultBrokerServer(async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 40));
    return { value: 'ok' };
  }, state);
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });

  const abandoned = createConnection(path);
  await new Promise<void>((resolve, reject) => { abandoned.once('error', reject); abandoned.once('connect', resolve); });
  abandoned.on('error', () => {});
  abandoned.write('{"op":"reset"}\n');
  await new Promise(resolve => setTimeout(resolve, 5));
  abandoned.destroy();
  await new Promise(resolve => setTimeout(resolve, 60));

  const response = await new Promise<string>((resolve, reject) => {
    const client = createConnection(path); let data = '';
    client.once('error', reject);
    client.once('connect', () => client.write('{"op":"next"}\n'));
    client.on('data', chunk => { data += chunk.toString('utf8'); if (data.includes('\n')) { client.end(); resolve(data); } });
  });
  for (let i = 0; i < 20 && (state.inFlight !== 0 || state.clients.size !== 0); i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  expect(JSON.parse(response)).toEqual({ ok: true, value: 'ok' });
  expect(calls).toBe(2);
  expect(state.inFlight).toBe(0);
  expect(state.clients.size).toBe(0);
});

// A request shaped like a real one, carrying everything a log line must never repeat.
const SECRETS = { path: 'clients/private-plan.md', title: 'Private plan', member: 'member-7f3a', capability: 'cap-9d2e41', token: 'c'.repeat(64) };
const frame = (fail: unknown, op: unknown = 'vault.read', operation = 'list') => JSON.stringify({
  agent: 'proof-agent', incarnation: '11111111-1111-4111-8111-111111111111', requestId: 'r'.repeat(32), timestamp: 1, op, mac: SECRETS.token, fail,
  input: { operation, area: 'private', path: SECRETS.path, title: SECRETS.title, memberId: SECRETS.member, turnCapability: SECRETS.capability },
}) + '\n';
/** A broker whose handler fails the way the request asks, so one server covers every code. */
async function failingBroker() {
  const root = await mkdtemp(join(tmpdir(), 'vault-broker-failure-')); roots.push(root);
  const path = join(root, 'read.sock'), state = { clients: new Set<import('node:net').Socket>(), inFlight: 0 };
  const server = createBoundedVaultBrokerServer(async line => {
    const fail = JSON.parse(line).fail;
    await new Promise(resolve => setTimeout(resolve, typeof fail === 'object' && fail ? 40 : 0));
    if (fail === undefined) return { value: 'ok' };
    if (typeof fail === 'object' && fail) throw new Error(String(fail.late));
    if (fail === 'not an Error') throw fail;
    throw new Error(String(fail));
  }, state);
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const send = (text: string) => new Promise<unknown>((resolve, reject) => {
    const client = createConnection(path); let data = '';
    client.once('error', reject);
    client.once('connect', () => client.write(text));
    client.on('data', chunk => { data += chunk.toString('utf8'); if (data.includes('\n')) { client.end(); resolve(JSON.parse(data)); } });
  });
  return { path, state, send };
}
const warned = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
const noSecrets = (line: string) => { for (const secret of Object.values(SECRETS)) expect(line).not.toContain(secret); };

it('names a listed refusal in the reply and logs one line with the operation, the code and the time', async () => {
  const warn = warned(), broker = await failingBroker();
  expect(await broker.send(frame('deadline'))).toEqual({ ok: false, reason: 'deadline' });
  expect(await broker.send(frame('listing', 'vault.read', 'read'))).toEqual({ ok: false, reason: 'listing' });
  expect(await broker.send(frame('authority', 'challenge'))).toEqual({ ok: false, reason: 'authority' });
  expect(warn.mock.calls.map(call => call.length)).toEqual([1, 1, 1]);
  const lines = warn.mock.calls.map(call => String(call[0]));
  expect(lines[0]).toMatch(/^keeper: Vault request failed: vault\.read list, deadline, \d+ ms$/);
  expect(lines[1]).toMatch(/^keeper: Vault request failed: vault\.read read, listing, \d+ ms$/);
  expect(lines[2]).toMatch(/^keeper: Vault request failed: challenge, authority, \d+ ms$/);
  lines.forEach(noSecrets);
});

it('sends every listed reason, and only those: codes kept for the log leave the reply bare', async () => {
  const warn = warned(), broker = await failingBroker();
  for (const reason of VAULT_BROKER_REFUSAL_REASONS) expect(await broker.send(frame(reason))).toEqual({ ok: false, reason });
  for (const kept of ['identity', 'signature', 'not found', 'note exists', 'track target changed']) {
    warn.mockClear();
    expect(await broker.send(frame(kept))).toEqual({ ok: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(new RegExp(`^keeper: Vault request failed: vault\\.read list, ${kept}, \\d+ ms$`));
  }
});

it('logs a fixed word for an error it does not know, and repeats none of it in the log or the reply', async () => {
  const warn = warned(), broker = await failingBroker();
  const unknown = [
    `ENOENT: no such file or directory, open '/srv/vault/private/${SECRETS.path}'`,
    `duplicate key value violates unique constraint (member_id)=(${SECRETS.member})`,
    'Deadline', 'deadline ', 'error', '', 'not an Error',
  ];
  for (const fail of unknown) {
    warn.mockClear();
    expect(await broker.send(frame(fail))).toEqual({ ok: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^keeper: Vault request failed: vault\.read list, error, \d+ ms$/);
    noSecrets(String(warn.mock.calls[0]![0]));
  }
});

it('logs an operation it does not serve, or a request it cannot read, as unknown', async () => {
  const warn = warned(), broker = await failingBroker();
  expect(await broker.send(frame('operation', SECRETS.path))).toEqual({ ok: false, reason: 'operation' });
  expect(await broker.send(frame('operation', { toString: 'x' }))).toEqual({ ok: false, reason: 'operation' });
  expect(await broker.send(frame('read', 'vault.read', SECRETS.title))).toEqual({ ok: false, reason: 'read' });
  expect(await broker.send(`${SECRETS.path} is not JSON\n`)).toEqual({ ok: false });
  const lines = warn.mock.calls.map(call => String(call[0]));
  expect(lines[0]).toMatch(/^keeper: Vault request failed: unknown, operation, \d+ ms$/);
  expect(lines[1]).toMatch(/^keeper: Vault request failed: unknown, operation, \d+ ms$/);
  expect(lines[2]).toMatch(/^keeper: Vault request failed: vault\.read, read, \d+ ms$/);
  expect(lines[3]).toMatch(/^keeper: Vault request failed: unknown, error, \d+ ms$/);
  expect(lines).toHaveLength(4); lines.forEach(noSecrets);
});

it('logs a failure whose caller has gone, and logs nothing for a request that succeeds', async () => {
  const warn = warned(), broker = await failingBroker();
  expect(await broker.send(frame(undefined))).toEqual({ ok: true, value: 'ok' });
  expect(warn).not.toHaveBeenCalled();
  const abandoned = createConnection(broker.path);
  await new Promise<void>((resolve, reject) => { abandoned.once('error', reject); abandoned.once('connect', resolve); });
  abandoned.on('error', () => {});
  abandoned.write(frame({ late: 'deadline' }));
  await new Promise(resolve => setTimeout(resolve, 5));
  abandoned.destroy();
  for (let i = 0; i < 100 && (warn.mock.calls.length === 0 || broker.state.inFlight !== 0); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]![0])).toMatch(/^keeper: Vault request failed: vault\.read list, deadline, \d+ ms, no reply sent$/);
  expect(await broker.send(frame(undefined))).toEqual({ ok: true, value: 'ok' });
  expect(broker.state.inFlight).toBe(0);
});

it('reaches the agent through the real client as a plain reason, with the words callers match on', async () => {
  warned();
  const root = await mkdtemp(join(tmpdir(), 'vault-broker-client-')); roots.push(root);
  const path = join(root, 'read.sock'), key = join(root, 'runtime-control'), state = { clients: new Set<import('node:net').Socket>(), inFlight: 0 };
  await writeFile(key, '3'.repeat(64));
  // The real client signs its own frame, so this handler reads what to fail with from the request's input.
  const server = createBoundedVaultBrokerServer(async line => { throw new Error(String(JSON.parse(line).input.fail)); }, state, 256 * 1024);
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const env = { LARES_AGENT_NAME: 'proof-agent', LARES_AGENT_INCARNATION: '11111111-1111-4111-8111-111111111111', LARES_RUNTIME_CONTROL_SECRET_FILE: key, LARES_VAULT_RUNTIME_SOCKET: path };
  const before = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    const said = async (fail: string) => { try { await vaultBrokerRequest('vault.read', { operation: 'list', fail }); } catch (error) { return (error as Error).message; } throw new Error('not refused'); };
    expect(await said('listing')).toBe('Vault reader unavailable (the keeper refused: listing)');
    expect(await said('deadline')).toBe('Vault reader unavailable (the keeper refused: deadline)');
    expect(await said('signature')).toBe('Vault reader unavailable (the keeper refused)');
    expect(await said(`could not open ${SECRETS.path}`)).toBe('Vault reader unavailable (the keeper refused)');
  } finally {
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
