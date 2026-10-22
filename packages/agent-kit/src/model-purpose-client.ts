import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { createConnection } from 'node:net';
import { isAbsolute, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  MODEL_PURPOSE_EMPTY_DIGEST,
  modelPurposeAckFields,
  modelPurposeEqualMac,
  modelPurposeMac,
  modelPurposeRuntimePayloadDigest,
  modelPurposeRuntimeRequestFields,
  type ModelPurposeRuntimeEnvelope,
} from './model-purpose-protocol.js';

const DEFAULT_SOCKET = '/run/lares/run/model-purpose.sock';
const FRAME_LIMIT = 32_768;
const REQUEST_TIMEOUT_MS = 2_000;
const REQUEST_TOMBSTONE_MS = 60_000;
const MAX_REQUEST_TOMBSTONES = 2_048;
const denied = () => new Error('Model purpose authority is not available');
type Operation = 'request.admit' | 'turn.open' | 'step.claim' | 'turn.close';
interface RuntimeIdentity { agent: string; incarnation: string; key: Buffer }

// IDs are burned before connecting, so timeout, refusal, or late ACK cannot retry a request.
const requestIds = new Map<string, number>();
function reserveRequestId(now: number): string {
  for (const [id, expiresAt] of requestIds) if (expiresAt <= now) requestIds.delete(id);
  if (requestIds.size >= MAX_REQUEST_TOMBSTONES) throw denied();
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = randomBytes(32).toString('base64url');
    if (!requestIds.has(id)) {
      requestIds.set(id, now + REQUEST_TOMBSTONE_MS);
      return id;
    }
  }
  throw denied();
}

function protectedKey(file: string, expectedUid = 0, expectedGid = 10_001): Buffer {
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
    const value = Buffer.alloc(stat.size);
    const length = requireRead(fd, value);
    const text = value.subarray(0, length).toString('utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(text)) throw denied();
    return Buffer.from(text, 'hex');
  } finally {
    closeSync(fd);
  }
}

// Read the already-verified descriptor. A pathname replacement after open cannot change this key.
function requireRead(fd: number, into: Buffer): number {
  return readSync(fd, into, 0, into.length, 0);
}

function identity(): RuntimeIdentity {
  const agent = process.env.LARES_AGENT_NAME;
  const incarnation = process.env.LARES_AGENT_INCARNATION;
  const file = process.env.LARES_RUNTIME_CONTROL_SECRET_FILE ?? '/run/secrets/runtime-control';
  if (!agent || !/^[a-z][a-z0-9-]{1,30}$/.test(agent) ||
      !incarnation || !/^[a-f0-9-]{36}$/.test(incarnation)) throw denied();
  return { agent, incarnation, key: protectedKey(file) };
}

function validFrameValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Send one Keeper operation over the authenticated, bounded Unix-socket protocol. The
 * response is returned only after its exact request/outcome/payload binding verifies. */
export async function modelPurposeRequest<T extends Record<string, unknown>>(
  operation: Operation,
  input: Record<string, unknown>,
): Promise<T> {
  const { agent, incarnation, key } = identity();
  const timestamp = Date.now();
  const requestId = reserveRequestId(timestamp);
  const unsigned = {
    agent, incarnation, requestId, timestamp, op: operation, input,
    outcomeDigest: MODEL_PURPOSE_EMPTY_DIGEST,
    payloadDigest: modelPurposeRuntimePayloadDigest(operation, input),
  };
  const fields = modelPurposeRuntimeRequestFields(unsigned);
  const envelope = { ...unsigned, mac: modelPurposeMac(key, fields).toString('base64url') };
  const frame = Buffer.from(JSON.stringify(envelope) + '\n', 'utf8');
  if (frame.length > FRAME_LIMIT) throw denied();
  const socketPath = process.env.LARES_MODEL_PURPOSE_RUNTIME_SOCKET ?? DEFAULT_SOCKET;

  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: unknown, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(denied());
      else resolve(result!);
    };
    const deadline = setTimeout(() => finish(new Error('deadline')), REQUEST_TIMEOUT_MS);
    socket.once('error', finish);
    socket.once('end', () => finish(new Error('eof')));
    socket.once('close', () => { if (!settled) finish(new Error('close')); });
    socket.once('connect', () => socket.write(frame));
    socket.on('data', chunk => {
      if (settled) return;
      received = Buffer.concat([received, chunk]);
      if (received.length > FRAME_LIMIT) { finish(new Error('size')); return; }
      const newline = received.indexOf(10);
      if (newline < 0) return;
      if (newline !== received.length - 1) { finish(new Error('trailing')); return; }
      try {
        const response = JSON.parse(received.subarray(0, newline).toString('utf8')) as Record<string, unknown>;
        if (response.ok !== true || typeof response.responseMac !== 'string' ||
            typeof response.responseRequestDigest !== 'string' || typeof response.responseOutcomeDigest !== 'string' ||
            typeof response.responsePayloadDigest !== 'string') throw denied();
        const { ok: _ok, responseMac, responseRequestDigest, responseOutcomeDigest, responsePayloadDigest, ...result } = response;
        if (!validFrameValue(result)) throw denied();
        const ack = modelPurposeAckFields(unsigned, result);
        if (responseRequestDigest !== fields.requestDigest || responseOutcomeDigest !== ack.outcomeDigest ||
            responsePayloadDigest !== ack.payloadDigest || !modelPurposeEqualMac(responseMac, modelPurposeMac(key, ack))) {
          throw denied();
        }
        finish(undefined, result as T);
      } catch (error) {
        finish(error);
      }
    });
  });
}
