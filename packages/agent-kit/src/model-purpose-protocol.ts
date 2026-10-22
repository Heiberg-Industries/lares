import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Shared wire primitives for the Console, runtime client, and Keeper broker. Keep changes
 * compatible with the v1 fields/domains; these values are part of the authentication contract. */
export type ModelPurposeDirection =
  | 'console-to-keeper'
  | 'runtime-to-keeper'
  | 'keeper-to-runtime'
  | 'keeper-to-console';

export interface ModelPurposeMacFields {
  direction: ModelPurposeDirection;
  domain: string;
  agent: string;
  incarnation: string;
  operation: string;
  requestId: string;
  requestDigest: string;
  outcomeDigest: string;
  payloadDigest: string;
}

export interface ModelPurposeRuntimeEnvelope {
  agent: unknown;
  incarnation: unknown;
  requestId: unknown;
  timestamp: unknown;
  op: unknown;
  input: unknown;
  outcomeDigest: unknown;
  payloadDigest: unknown;
  mac?: unknown;
}

/** A separate MAC domain for the bounded model-dispatch hop. It deliberately signs the
 * gateway's canonical exact-request hash, rather than JSON-decoding and re-encoding a body. */
export interface ModelPurposeDispatchFields {
  method: 'POST';
  path: string;
  requestHash: string;
  ticket: string;
  agent: string;
  incarnation: string;
  nonce: string;
  deadline: number;
}

export const MODEL_PURPOSE_EMPTY_DIGEST = createHash('sha256').update('').digest('hex');
export const MODEL_PURPOSE_DISPATCH_BODY_MAX = 8 * 1024 * 1024;

export function modelPurposeCanonical(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Model purpose protocol value is not serializable');
  return encoded;
}

/** This matches Keeper's original canonical JSON digest exactly. */
export function modelPurposeDigest(value: unknown): string {
  return createHash('sha256').update(modelPurposeCanonical(value)).digest('hex');
}

/** This matches Keeper's original v1 tuple encoding exactly. */
export function modelPurposeMac(key: Buffer, fields: ModelPurposeMacFields): Buffer {
  return createHmac('sha256', key).update(modelPurposeCanonical([
    'lares-model-purpose-v1', fields.direction, fields.domain, fields.agent,
    fields.incarnation, fields.operation, fields.requestId, fields.requestDigest,
    fields.outcomeDigest, fields.payloadDigest,
  ])).digest();
}

export function modelPurposeDispatchMac(key: Buffer, fields: ModelPurposeDispatchFields): Buffer {
  if (key.length !== 32 || fields.method !== 'POST' ||
      (fields.path !== '/v1/messages' && fields.path !== '/v1/chat/completions') ||
      !/^[a-f0-9]{64}$/.test(fields.requestHash) || !/^[A-Za-z0-9_-]{43}$/.test(fields.ticket) ||
      !/^[a-z][a-z0-9-]{1,30}$/.test(fields.agent) || !/^[a-f0-9-]{36}$/.test(fields.incarnation) ||
      !/^[A-Za-z0-9_-]{43}$/.test(fields.nonce) || !Number.isSafeInteger(fields.deadline)) {
    throw new Error('Invalid model-purpose dispatch authentication');
  }
  return createHmac('sha256', key).update(modelPurposeCanonical([
    'lares-model-purpose-dispatch-v1', 'runtime-to-keeper', fields.method, fields.path,
    fields.requestHash, fields.ticket, fields.agent, fields.incarnation, fields.nonce, fields.deadline,
  ])).digest();
}

export function modelPurposeEqualMac(given: unknown, expected: Buffer): boolean {
  if (typeof given !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(given)) return false;
  const bytes = Buffer.from(given, 'base64url');
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

export function modelPurposeChallengeFields(
  request: { agent: string; incarnation: string; requestId: string },
  requestDigest: string,
  challenge: string,
  expiresAt: number,
): ModelPurposeMacFields {
  return {
    direction: 'keeper-to-console', domain: 'model-purpose-challenge',
    agent: request.agent, incarnation: request.incarnation,
    operation: 'request.challenge', requestId: request.requestId,
    requestDigest, outcomeDigest: MODEL_PURPOSE_EMPTY_DIGEST,
    payloadDigest: modelPurposeDigest({ challenge, expiresAt, requestDigest }),
  };
}

export function modelPurposeConsoleRequestFields(
  request: { agent: string; incarnation: string; requestId: string },
  requestDigest: string,
  payloadDigest: string,
): ModelPurposeMacFields {
  return {
    direction: 'console-to-keeper', domain: 'model-purpose-request',
    agent: request.agent, incarnation: request.incarnation,
    operation: 'request.admit', requestId: request.requestId,
    requestDigest, outcomeDigest: MODEL_PURPOSE_EMPTY_DIGEST, payloadDigest,
  };
}

/** Keeper authenticates the exact envelope body, including timestamp and both digests. */
export function modelPurposeRuntimeRequestFields(envelope: ModelPurposeRuntimeEnvelope): ModelPurposeMacFields {
  const { mac: _mac, ...signedEnvelope } = envelope;
  if (typeof envelope.agent !== 'string' || typeof envelope.incarnation !== 'string' ||
      typeof envelope.requestId !== 'string' || typeof envelope.op !== 'string' ||
      typeof envelope.outcomeDigest !== 'string' || typeof envelope.payloadDigest !== 'string') {
    throw new Error('Model purpose runtime envelope is invalid');
  }
  return {
    direction: 'runtime-to-keeper', domain: 'model-purpose-runtime',
    agent: envelope.agent, incarnation: envelope.incarnation,
    operation: envelope.op, requestId: envelope.requestId,
    requestDigest: modelPurposeDigest(signedEnvelope),
    outcomeDigest: envelope.outcomeDigest, payloadDigest: envelope.payloadDigest,
  };
}

export function modelPurposeAckFields(
  envelope: ModelPurposeRuntimeEnvelope,
  result: Record<string, unknown>,
): ModelPurposeMacFields {
  const request = modelPurposeRuntimeRequestFields(envelope);
  return {
    ...request,
    direction: 'keeper-to-runtime', domain: 'model-purpose-ack',
    outcomeDigest: modelPurposeDigest({ accepted: true, operation: envelope.op }),
    payloadDigest: modelPurposeDigest(result),
  };
}

/** Broker signs the step event itself as payload; other operations sign their input object. */
export function modelPurposeRuntimePayloadDigest(operation: string, input: unknown): string {
  if (operation === 'step.claim' && input && typeof input === 'object' && !Array.isArray(input)) {
    return modelPurposeDigest((input as { event?: unknown }).event);
  }
  return modelPurposeDigest(input);
}
