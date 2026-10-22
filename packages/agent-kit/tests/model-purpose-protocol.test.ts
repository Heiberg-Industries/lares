import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  modelPurposeAckFields,
  modelPurposeDigest,
  modelPurposeMac,
  modelPurposeRuntimeRequestFields,
  type ModelPurposeRuntimeEnvelope,
} from '../src/model-purpose-protocol.js';

const canonical = (value: unknown) => JSON.stringify(value);
const independentDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const independentMac = (key: Buffer, fields: readonly unknown[]) => createHmac('sha256', key)
  .update(canonical(['lares-model-purpose-v1', ...fields])).digest('base64url');

describe('model purpose shared wire protocol', () => {
  it('preserves the original whole-envelope MAC, including the authenticated timestamp', () => {
    const key = Buffer.from('0'.repeat(64), 'hex');
    const envelope: ModelPurposeRuntimeEnvelope = {
      agent: 'neutral-helper',
      incarnation: '123e4567-e89b-42d3-a456-426614174000',
      requestId: 'R'.repeat(43),
      timestamp: 1_735_689_600_123,
      op: 'turn.open',
      input: { pendingReceipt: 'P'.repeat(43), context: { session: { id: 'session_1', turn: { id: 'turn-1', sequence: 4 }, auth: { current: {}, initiator: {} } } } },
      outcomeDigest: createHash('sha256').update('').digest('hex'),
      payloadDigest: '2c673e140f7fa3de3c99eeb2f53fd1e7403455c8ee4812cf9ba876d9b0253637',
    };
    const requestDigest = independentDigest(envelope);
    expect(requestDigest).toBe('77c5b96688e25feb6631c28e5f39c179f2922289e8cbfb9f984f4c38289e7604');
    expect(modelPurposeRuntimeRequestFields(envelope).requestDigest).toBe(requestDigest);
    const requestFields = [
      'runtime-to-keeper', 'model-purpose-runtime', envelope.agent, envelope.incarnation,
      envelope.op, envelope.requestId, requestDigest, envelope.outcomeDigest, envelope.payloadDigest,
    ];
    const oldIndependentMac = independentMac(key, requestFields);
    expect(oldIndependentMac).toBe('nkaDs4iGjlKlfu4N7awaQOkTV3NPF-vdqLQ0Btml0zA');
    expect(modelPurposeMac(key, modelPurposeRuntimeRequestFields(envelope)).toString('base64url')).toBe(oldIndependentMac);

    const result = { capability: 'C'.repeat(43), expiresAt: 1_735_689_900_123 };
    const ack = modelPurposeAckFields(envelope, result);
    const ackFields = [
      'keeper-to-runtime', 'model-purpose-ack', envelope.agent, envelope.incarnation,
      envelope.op, envelope.requestId, requestDigest,
      independentDigest({ accepted: true, operation: envelope.op }), independentDigest(result),
    ];
    const oldIndependentAckMac = independentMac(key, ackFields);
    expect(oldIndependentAckMac).toBe('ceaJLTkEsWa4xpSxmC9t7OAte6FU_5wAhUCPkiDTNcQ');
    expect(modelPurposeMac(key, ack).toString('base64url')).toBe(oldIndependentAckMac);

    const changedTimestamp = { ...envelope, timestamp: (envelope.timestamp as number) + 1 };
    expect(modelPurposeDigest(changedTimestamp)).not.toBe(requestDigest);
    expect(modelPurposeMac(key, modelPurposeRuntimeRequestFields(changedTimestamp)).toString('base64url')).not.toBe(oldIndependentMac);
  });
});
