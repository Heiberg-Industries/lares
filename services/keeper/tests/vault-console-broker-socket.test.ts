import { createConnection } from 'node:net';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createBoundedVaultBrokerServer, prepareVaultRuntimeDirectory, serveConsoleVaultBroker } from '../lib/vault-console-broker.js';

const servers: import('node:net').Server[] = [];
const roots: string[] = [];
afterEach(async () => {
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
