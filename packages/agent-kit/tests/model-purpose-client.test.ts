import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  modelPurposeAckFields,
  modelPurposeMac,
  type ModelPurposeRuntimeEnvelope,
} from '../src/model-purpose-protocol.js';

const fixture = vi.hoisted(() => ({
  fileMode: 0o100440,
  fileUid: 0,
  fileGid: 10_001,
  keyText: '1'.repeat(64),
  openedFlags: 0,
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const directoryStat = {
    uid: 0, mode: 0o40755, isSymbolicLink: () => false, isDirectory: () => true,
  };
  return {
    ...actual,
    lstatSync: vi.fn(() => directoryStat),
    openSync: vi.fn((_path: string, flags: number) => { fixture.openedFlags = flags; return 42; }),
    closeSync: vi.fn(),
    fstatSync: vi.fn(() => ({ uid: fixture.fileUid, gid: fixture.fileGid, mode: fixture.fileMode,
      size: fixture.keyText.length, nlink: 1, isFile: () => true })),
    readSync: vi.fn((_fd: number, buffer: Buffer, offset: number, length: number) => {
      const bytes = Buffer.from(fixture.keyText);
      const count = Math.min(length, bytes.length);
      bytes.copy(buffer, offset, 0, count);
      return count;
    }),
  };
});

const root = mkdtempSync(join(tmpdir(), 'lares-model-purpose-client-'));
const socketPath = join(root, 'keeper.sock');
const keyFile = join(root, 'runtime-key');
const sockets = new Set<Socket>();
const key = Buffer.from(fixture.keyText, 'hex');
let server: Server;
let mode = 'valid';
let connections = 0;

const result = { capability: 'C'.repeat(43), expiresAt: Date.now() + 30_000 };
function responseFor(envelope: ModelPurposeRuntimeEnvelope, responseResult = result) {
  const fields = modelPurposeAckFields(envelope, responseResult);
  return JSON.stringify({ ok: true, ...responseResult,
    responseMac: modelPurposeMac(key, fields).toString('base64url'),
    responseRequestDigest: fields.requestDigest,
    responseOutcomeDigest: fields.outcomeDigest,
    responsePayloadDigest: fields.payloadDigest,
  }) + '\n';
}

beforeAll(async () => {
  process.env.LARES_AGENT_NAME = 'neutral-helper';
  process.env.LARES_AGENT_INCARNATION = '123e4567-e89b-42d3-a456-426614174000';
  process.env.LARES_RUNTIME_CONTROL_SECRET_FILE = keyFile;
  process.env.LARES_MODEL_PURPOSE_RUNTIME_SOCKET = socketPath;
  server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let bytes = '';
    socket.on('data', chunk => {
      bytes += chunk.toString('utf8');
      if (!bytes.includes('\n')) return;
      connections++;
      const envelope = JSON.parse(bytes.slice(0, bytes.indexOf('\n'))) as ModelPurposeRuntimeEnvelope;
      if (mode === 'stall') {
        setTimeout(() => { if (!socket.destroyed) socket.end(responseFor(envelope)); }, 2_300);
        return;
      }
      if (mode === 'oversize') { socket.end(`${'x'.repeat(33_000)}\n`); return; }
      if (mode === 'tampered-timestamp') {
        socket.end(responseFor({ ...envelope, timestamp: Number(envelope.timestamp) + 1 })); return;
      }
      if (mode === 'wrong-identity') {
        socket.end(responseFor({ ...envelope, agent: 'other-agent' })); return;
      }
      if (mode === 'bad-outcome') {
        const response = JSON.parse(responseFor(envelope));
        response.responseOutcomeDigest = 'f'.repeat(64);
        socket.end(JSON.stringify(response) + '\n'); return;
      }
      if (mode === 'bad-payload') {
        const response = JSON.parse(responseFor(envelope));
        response.expiresAt++;
        socket.end(JSON.stringify(response) + '\n'); return;
      }
      socket.end(responseFor(envelope));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
});

beforeEach(() => { mode = 'valid'; fixture.fileMode = 0o100440; fixture.fileUid = 0; fixture.fileGid = 10_001; });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const name of ['LARES_AGENT_NAME', 'LARES_AGENT_INCARNATION', 'LARES_RUNTIME_CONTROL_SECRET_FILE', 'LARES_MODEL_PURPOSE_RUNTIME_SOCKET']) delete process.env[name];
  rmSync(root, { recursive: true, force: true });
});

describe('bounded runtime model-purpose client', () => {
  it('sends a fresh envelope and accepts only its matching signed ACK', async () => {
    const { modelPurposeRequest } = await import('../src/model-purpose-client.js');
    await expect(modelPurposeRequest('turn.open', { pendingReceipt: 'P'.repeat(43) })).resolves.toEqual(result);
  });

  it.each(['tampered-timestamp', 'wrong-identity', 'bad-outcome', 'bad-payload', 'oversize'])(
    'rejects a %s response', async invalidMode => {
      mode = invalidMode;
      const { modelPurposeRequest } = await import('../src/model-purpose-client.js');
      await expect(modelPurposeRequest('turn.open', { pendingReceipt: 'P'.repeat(43) })).rejects.toThrow('Model purpose authority is not available');
    });

  it('burns the request before awaiting a response and rejects a late ACK', async () => {
    mode = 'stall';
    const { modelPurposeRequest } = await import('../src/model-purpose-client.js');
    const started = Date.now();
    await expect(modelPurposeRequest('turn.open', { pendingReceipt: 'P'.repeat(43) })).rejects.toThrow('Model purpose authority is not available');
    await delay(350);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 5_000);

  it('bounds outgoing frames before opening the socket and enforces protected key ownership and mode', async () => {
    const { modelPurposeRequest } = await import('../src/model-purpose-client.js');
    const connectedBefore = connections;
    await expect(modelPurposeRequest('request.admit', { capsule: 'x'.repeat(40_000) })).rejects.toThrow();
    expect(connections).toBe(connectedBefore);

    for (const invalid of [
      { fileUid: 1, fileGid: 10_001, fileMode: 0o100440 },
      { fileUid: 0, fileGid: 20, fileMode: 0o100440 },
      { fileUid: 0, fileGid: 10_001, fileMode: 0o100600 },
    ]) {
      Object.assign(fixture, invalid);
      await expect(modelPurposeRequest('turn.open', { pendingReceipt: 'P'.repeat(43) })).rejects.toThrow();
    }
  });
});
