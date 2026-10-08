import { expect, it } from 'vitest';
import { credentialMutationInput, credentialStatusSchema } from '../src/credential-lifecycle.js';
it('accepts only the named slot and strict generated revision commands', () => {
  const command = { operation: 'test_save', slot: 'notion:shared', expectedRevision: 0, token: 'synthetic-only' };
  expect(credentialMutationInput.safeParse(command).success).toBe(true);
  for (const change of [{ actor: 'injected' }, { path: '/arbitrary' }, { slot: 'arbitrary' }, { token: 'a b' }, { token: 'é'.repeat(5000) }])
    expect(credentialMutationInput.safeParse({ ...command, ...change }).success).toBe(false);
});
it('rejects secret fields and custody metadata in strict status replies', () => {
  const status = { slot: 'notion:shared', state: 'unavailable', guidance: 'status-unavailable', revision: null, activeRevision: null, candidateRevision: null, phase: null, test: null, consumers: [], activation: [], rollback: [] };
  expect(credentialStatusSchema.safeParse(status).success).toBe(true);
  for (const change of [{ token: 'synthetic-only' }, { suffix: '1234' }, { testedCustody: {} }, { activationIntent: {} }, { fingerprint: 'abc' }, { path: '/arbitrary' }])
    expect(credentialStatusSchema.safeParse({ ...status, ...change }).success).toBe(false);
});
