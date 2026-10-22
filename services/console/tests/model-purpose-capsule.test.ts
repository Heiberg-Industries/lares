import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  modelPurposeChallengeFields,
  modelPurposeConsoleRequestFields,
  modelPurposeDigest,
  modelPurposeMac,
} from '@lares/agent-kit/model-purpose-protocol';
import { PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER, assertPrivateConsoleRequest, verifiedPrivateConsoleModelMessageReceipt } from '@lares/agent-kit/private-console-envelope';
import { modelPurposeRawBodyHash, signPrivateModelPurposeRequest, type ModelPurposeRequest } from '../lib/model-purpose-capsule.js';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'lares-model-purpose-capsule-'));
const socketPath = join(root, 'keeper.sock');
const keyPath = join(root, 'console-key');
const symlinkPath = join(root, 'console-key-link');
const key = Buffer.from('2'.repeat(64), 'hex');
const sockets = new Set<Socket>();
let server: Server;
let mode = 'valid';
let connections = 0;
let request: ModelPurposeRequest;

function challengeReply(input: ModelPurposeRequest) {
  const digest = modelPurposeDigest(input);
  const challenge = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 10_000;
  return { ok: true, challenge, requestDigest: digest, expiresAt,
    challengeMac: modelPurposeMac(key, modelPurposeChallengeFields(input, digest, challenge, expiresAt)).toString('base64url') };
}

beforeAll(async () => {
  writeFileSync(keyPath, '2'.repeat(64), { mode: 0o440 });
  chmodSync(keyPath, 0o440);
  symlinkSync(keyPath, symlinkPath);
  request = { agent: 'neutral-helper', incarnation: '123e4567-e89b-42d3-a456-426614174000',
    session: 'session_1', member: 'member_1', admissionNonce: 'a'.repeat(43), method: 'POST',
    path: '/eve/v1/session/session_1', rawBodyHash: 'b'.repeat(64), policyRevision: 2,
    definitionHash: 'c'.repeat(64), purpose: 'human', requestId: 'd'.repeat(43) };
  server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let bytes = '';
    socket.on('data', chunk => {
      bytes += chunk.toString('utf8');
      if (!bytes.includes('\n')) return;
      connections++;
      const input = JSON.parse(bytes.slice(0, bytes.indexOf('\n'))).input as ModelPurposeRequest;
      if (mode === 'stall') return;
      let response: Record<string, unknown> = challengeReply(input);
      if (mode === 'wrong-request') response.requestDigest = 'f'.repeat(64);
      if (mode === 'wrong-mac') response.challengeMac = 'A'.repeat(43);
      if (mode === 'expired') response.expiresAt = Date.now() - 1;
      if (mode === 'oversize') response = { ...response, extra: 'x'.repeat(17_000) };
      socket.end(JSON.stringify(response) + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
});

beforeEach(() => { mode = 'valid'; chmodSync(keyPath, 0o440); });
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe('Console model-purpose challenge and capsule client', () => {
  it('creates a capsule only after verifying the matching challenge', async () => {
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const body=JSON.stringify({message:'signed human question'});
    const signedRequest={...request,rawBodyHash:modelPurposeRawBodyHash(body)};
    const capsule = await signPrivateModelPurposeRequest(signedRequest, { socketPath, keyFile: keyPath, expectedUid: uid, expectedGid: gid });
    const [encoded, signature] = capsule.split('.');
    const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
    expect(payload.request).toEqual(signedRequest);
    expect(payload.requestDigest).toBe(modelPurposeDigest(signedRequest));
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const fields = modelPurposeConsoleRequestFields(signedRequest, payload.requestDigest, modelPurposeDigest(payload));
    expect(signature).toBe(modelPurposeMac(key, fields).toString('base64url'));

    const rawRequest=new Request(`https://example.invalid${signedRequest.path}`,{method:'POST',
      headers:{[PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER]:capsule},body});
    await assertPrivateConsoleRequest(rawRequest);
    const parsed=await rawRequest.json();
    expect(verifiedPrivateConsoleModelMessageReceipt(rawRequest,parsed.message)).toEqual({method:'POST',path:signedRequest.path,
      rawBodyHash:modelPurposeRawBodyHash(body),requestId:signedRequest.requestId,purpose:'human',modelCapsule:capsule});
  });

  it.each(['wrong-request', 'wrong-mac', 'expired', 'oversize', 'stall'])(
    'refuses %s challenge data', async invalidMode => {
      mode = invalidMode;
      const uid = process.getuid?.() ?? 0;
      const gid = process.getgid?.() ?? 0;
      const started = Date.now();
      await expect(signPrivateModelPurposeRequest(request, { socketPath, keyFile: keyPath, expectedUid: uid, expectedGid: gid })).rejects.toThrow('Model request authority unavailable');
      if (invalidMode === 'stall') expect(Date.now() - started).toBeLessThan(2_200);
    }, 5_000);

  it('refuses oversized outgoing requests before connecting and rejects unsafe key files', async () => {
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const connectedBefore = connections;
    await expect(signPrivateModelPurposeRequest({ ...request, member: 'm'.repeat(20_000) },
      { socketPath, keyFile: keyPath, expectedUid: uid, expectedGid: gid })).rejects.toThrow();
    expect(connections).toBe(connectedBefore);
    await expect(signPrivateModelPurposeRequest(request,
      { socketPath, keyFile: symlinkPath, expectedUid: uid, expectedGid: gid })).rejects.toThrow();
    chmodSync(keyPath, 0o600);
    await expect(signPrivateModelPurposeRequest(request,
      { socketPath, keyFile: keyPath, expectedUid: uid, expectedGid: gid })).rejects.toThrow();
  });
});
