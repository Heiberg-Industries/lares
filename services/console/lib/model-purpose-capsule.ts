import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import {
  modelPurposeChallengeFields,
  modelPurposeConsoleRequestFields,
  modelPurposeDigest,
  modelPurposeEqualMac,
  modelPurposeMac,
} from '@lares/agent-kit/model-purpose-protocol';

export const PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER = 'x-lares-model-capsule';
const DEFAULT_SOCKET = '/run/lares/model-purpose-console.sock';
const DEFAULT_KEY_FILE = '/run/secrets/console-model-purpose-signing-key';
const MAX_FRAME = 16_384;
const MAX_CAPSULE_CHARS = 8_192;
const CHALLENGE_TIMEOUT_MS = 1_500;
const denied = () => new Error('Model request authority unavailable');

export interface ModelPurposeRequest {
  agent: string;
  incarnation: string;
  session: string;
  member: string;
  admissionNonce: string;
  method: 'POST';
  path: string;
  rawBodyHash: string;
  policyRevision: number;
  definitionHash: string;
  purpose: 'human' | 'resume';
  requestId: string;
  resume?: { requestId: string; optionId: 'approve' | 'cancel' };
}

/** Overrides are dependency seams for isolated socket/file tests. Production uses the fixed
 * Console secret policy: root:runtime-group, 0440. */
export interface ModelPurposeCapsuleTestOptions {
  socketPath?: string;
  keyFile?: string;
  expectedUid?: number;
  expectedGid?: number;
}

function protectedKey(file: string, expectedUid: number, expectedGid: number): Buffer {
  if (!isAbsolute(file)) throw denied();
  let parent = '/';
  for (const part of dirname(file).split('/').filter(Boolean)) {
    parent = join(parent, part);
    const directory = lstatSync(parent);
    const stickyRoot = directory.uid === 0 && (directory.mode & 0o1000) !== 0;
    if (directory.isSymbolicLink() || !directory.isDirectory() ||
        (directory.uid !== 0 && directory.uid !== process.getuid?.()) ||
        ((directory.mode & 0o022) !== 0 && !stickyRoot)) throw denied();
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== expectedUid || stat.gid !== expectedGid ||
        (stat.mode & 0o777) !== 0o440 || stat.size > 1_024) throw denied();
    const bytes = Buffer.alloc(stat.size);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, length).toString('utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(text)) throw denied();
    return Buffer.from(text, 'hex');
  } finally {
    closeSync(fd);
  }
}

async function requestChallenge(input: ModelPurposeRequest, socketPath: string): Promise<{
  challenge: string; requestDigest: string; expiresAt: number; challengeMac: string;
}> {
  const frame = Buffer.from(JSON.stringify({ op: 'request.challenge', input }) + '\n', 'utf8');
  if (frame.length > MAX_FRAME) throw denied();
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: unknown, result?: { challenge: string; requestDigest: string; expiresAt: number; challengeMac: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(denied());
      else resolve(result!);
    };
    const deadline = setTimeout(() => finish(new Error('deadline')), CHALLENGE_TIMEOUT_MS);
    socket.once('error', finish);
    socket.once('end', () => finish(new Error('eof')));
    socket.once('close', () => { if (!settled) finish(new Error('close')); });
    socket.once('connect', () => socket.write(frame));
    socket.on('data', chunk => {
      if (settled) return;
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_FRAME) { finish(new Error('size')); return; }
      const newline = received.indexOf(10);
      if (newline < 0) return;
      if (newline !== received.length - 1) { finish(new Error('trailing')); return; }
      try {
        const response = JSON.parse(received.subarray(0, newline).toString('utf8')) as Record<string, unknown>;
        if (response.ok !== true || typeof response.challenge !== 'string' ||
            !/^[A-Za-z0-9_-]{43}$/.test(response.challenge) || typeof response.requestDigest !== 'string' ||
            !/^[a-f0-9]{64}$/.test(response.requestDigest) || typeof response.expiresAt !== 'number' ||
            !Number.isSafeInteger(response.expiresAt) || typeof response.challengeMac !== 'string') throw denied();
        finish(undefined, {
          challenge: response.challenge,
          requestDigest: response.requestDigest,
          expiresAt: response.expiresAt,
          challengeMac: response.challengeMac,
        });
      } catch (error) { finish(error); }
    });
  });
}

/** Create a Console capsule only after Keeper has issued a one-use challenge for this exact
 * request. The receipt consumer still binds the capsule to the raw Eve request bytes. */
export async function signPrivateModelPurposeRequest(
  request: ModelPurposeRequest,
  options: ModelPurposeCapsuleTestOptions = {},
): Promise<string> {
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 10_001;
  const key = protectedKey(options.keyFile ?? process.env.CONSOLE_MODEL_PURPOSE_SIGNING_KEY_FILE ?? DEFAULT_KEY_FILE, expectedUid, expectedGid);
  const issued = await requestChallenge(request, options.socketPath ?? process.env.LARES_MODEL_PURPOSE_CONSOLE_SOCKET ?? DEFAULT_SOCKET);
  const requestDigest = modelPurposeDigest(request);
  if (issued.requestDigest !== requestDigest || issued.expiresAt <= Date.now() ||
      !modelPurposeEqualMac(issued.challengeMac, modelPurposeMac(key, modelPurposeChallengeFields(request, requestDigest, issued.challenge, issued.expiresAt)))) {
    throw denied();
  }
  const payload = {
    version: 1,
    request,
    requestDigest,
    challenge: issued.challenge,
    challengeMac: issued.challengeMac,
    expiresAt: issued.expiresAt,
  };
  const signature = modelPurposeMac(key, modelPurposeConsoleRequestFields(request, requestDigest, modelPurposeDigest(payload))).toString('base64url');
  const capsule = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
  if (capsule.length > MAX_CAPSULE_CHARS) throw denied();
  return capsule;
}

export function modelPurposeRawBodyHash(rawBody: Uint8Array | string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** An absent default key is the legacy optional path. An explicitly named key, or any
 * existing default path (including an unreadable or malformed file), means custody was
 * configured and signing failures must refuse the marked request. */
export function modelPurposeSigningConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.CONSOLE_MODEL_PURPOSE_SIGNING_KEY_FILE;
  if (explicit !== undefined) return true;
  try { lstatSync(DEFAULT_KEY_FILE); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; return true; }
}
