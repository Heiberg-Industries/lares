import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { createConnection } from 'node:net';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { isAbsolute, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gatewayRawRequestHash } from './gateway-admission-protocol.js';
import {
  MODEL_PURPOSE_EMPTY_DIGEST,
  modelPurposeAckFields,
  modelPurposeEqualMac,
  modelPurposeMac,
  modelPurposeRuntimePayloadDigest,
  modelPurposeRuntimeRequestFields,
  modelPurposeDispatchMac,
  MODEL_PURPOSE_DISPATCH_BODY_MAX,
  type ModelPurposeDispatchFields,
  type ModelPurposeRuntimeEnvelope,
} from './model-purpose-protocol.js';

export const DEFAULT_MODEL_PURPOSE_RUNTIME_SOCKET = '/run/lares/model-purpose/model-purpose.sock';
export const DEFAULT_MODEL_PURPOSE_GATEWAY_SOCKET = join(dirname(DEFAULT_MODEL_PURPOSE_RUNTIME_SOCKET),'gateway.sock');
export { MODEL_PURPOSE_DISPATCH_BODY_MAX };
const FRAME_LIMIT = 32_768;
const REQUEST_TIMEOUT_MS = 2_000;
const REQUEST_TOMBSTONE_MS = 60_000;
const MAX_REQUEST_TOMBSTONES = 2_048;
const denied = () => new Error('Model purpose authority is not available');
type Operation = 'request.admit' | 'turn.open' | 'step.claim' | 'step.consume' | 'turn.close';
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
  const socketPath = process.env.LARES_MODEL_PURPOSE_RUNTIME_SOCKET ?? DEFAULT_MODEL_PURPOSE_RUNTIME_SOCKET;

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

/** Route a prepared model call through Keeper. The destination is a fixed local socket;
 * only the exact request bytes and a ticket already issued to this runtime are carried. */
export async function modelPurposeDispatchRequest(input: {
  ticket: string;
  method: 'POST';
  path: '/v1/messages' | '/v1/chat/completions';
  rawBody: Uint8Array;
  deadline: number;
  headers?: HeadersInit;
  signal?: AbortSignal;
}): Promise<Response> {
  if (input.rawBody.byteLength > MODEL_PURPOSE_DISPATCH_BODY_MAX ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.ticket) || !Number.isSafeInteger(input.deadline) ||
      input.deadline <= Date.now() || input.signal?.aborted) throw denied();
  const { agent, incarnation, key } = identity();
  const nonce = randomBytes(32).toString('base64url');
  const rawBody = Buffer.from(input.rawBody);
  const requestHash = gatewayRawRequestHash(input.method, input.path, rawBody);
  const fields: ModelPurposeDispatchFields = {
    method: input.method, path: input.path, requestHash, ticket: input.ticket,
    agent, incarnation, nonce, deadline: input.deadline,
  };
  let mac:string;
  try { mac=modelPurposeDispatchMac(key, fields).toString('base64url'); }
  finally { key.fill(0); }
  const headers = new Headers(input.headers);
  const outgoing: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(rawBody.length),
    'x-lares-budget-intent': input.ticket,
    'x-lares-purpose-agent': agent,
    'x-lares-purpose-incarnation': incarnation,
    'x-lares-purpose-request-hash': requestHash,
    'x-lares-purpose-nonce': nonce,
    'x-lares-purpose-deadline': String(input.deadline),
    'x-lares-purpose-mac': mac!,
  };
  for (const name of ['accept', 'accept-encoding', 'anthropic-version', 'anthropic-beta'] as const) {
    const value = headers.get(name);
    if (value && value.length <= 512 && /^[\x20-\x7e]+$/.test(value)) outgoing[name] = value;
  }
  const runtimeSocket=process.env.LARES_MODEL_PURPOSE_RUNTIME_SOCKET??DEFAULT_MODEL_PURPOSE_RUNTIME_SOCKET;
  const socketPath=join(dirname(runtimeSocket),'gateway.sock');
  return new Promise<Response>((resolve, reject) => {
    let settled=false,incomingResponse:import('node:http').IncomingMessage|undefined;
    let request:ReturnType<typeof httpRequest>;
    let headerDeadline:NodeJS.Timeout|undefined;
    const cleanup = () => {
      if(headerDeadline)clearTimeout(headerDeadline);
      input.signal?.removeEventListener('abort', abort);
    };
    const abort = () => {request.destroy(denied());incomingResponse?.destroy();};
    request = httpRequest({ socketPath, method: input.method, path: input.path, headers: outgoing,
      agent: false, timeout: 20_000 }, incoming => {
      incomingResponse=incoming;if(headerDeadline)clearTimeout(headerDeadline);
      const responseHeaders = new Headers();
      for (const name of ['content-type', 'cache-control', 'retry-after', 'anthropic-version', 'x-request-id'] as const) {
        const value = incoming.headers[name];
        if (typeof value === 'string' && value.length <= 2_048) responseHeaders.set(name, value);
      }
      incoming.once('end',cleanup);
      incoming.once('close',()=>{if(!incoming.complete)request.destroy();cleanup();});
      incoming.once('error',cleanup);
      settled=true;
      const body=incoming.statusCode===204||incoming.statusCode===205||incoming.statusCode===304?null:Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, {
        status: incoming.statusCode ?? 502, headers: responseHeaders,
      }));
    });
    headerDeadline=setTimeout(() => request.destroy(denied()), Math.max(1, input.deadline - Date.now()));
    request.once('error', error => { cleanup();if(!settled)reject(denied());else incomingResponse?.destroy(); });
    request.once('timeout', () => request.destroy(denied()));
    input.signal?.addEventListener('abort', abort, { once: true });
    if(input.signal?.aborted){abort();return;}
    request.end(rawBody);
  });
}
