import { expect, it } from 'vitest';
import { credentialGrantPreviewInput, credentialGrantPreviewSchema, credentialMutationInput, credentialStatusSchema } from '../src/credential-lifecycle.js';
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
it('accepts strict grant and revoke commands for the clipping purpose only', () => {
  const command = { operation: 'grant', slot: 'notion:shared', expectedRevision: 3, expectedActiveRevision: '8b2f7f0e-5d55-4c0e-9c1e-0d5a2e0f6a11', inventoryRevision: 'a'.repeat(64), confirmRestart: true, agent: 'chief', purpose: 'clipping' };
  expect(credentialMutationInput.safeParse(command).success).toBe(true);
  expect(credentialMutationInput.safeParse({ ...command, operation: 'revoke' }).success).toBe(true);
  for (const change of [{ purpose: 'email' }, { agent: 'Bad Name' }, { confirmRestart: false }, { path: '/x' }, { agent: undefined }])
    expect(credentialMutationInput.safeParse({ ...command, ...change }).success).toBe(false);
});
it('status carries secret-free grants, one entry per agent', () => {
  const status = { slot: 'notion:shared', state: 'applied', guidance: null, revision: 1, activeRevision: null, candidateRevision: null, phase: 'applied', test: null, consumers: [], activation: [], rollback: [] };
  expect(credentialStatusSchema.safeParse({ ...status, grants: [{ agent: 'chief', purposes: ['clipping'] }] }).success).toBe(true);
  expect(credentialStatusSchema.safeParse({ ...status, grants: [{ agent: 'chief', purposes: ['clipping'] }, { agent: 'chief', purposes: ['clipping'] }] }).success).toBe(false);
  expect(credentialStatusSchema.safeParse({ ...status, grants: [{ agent: 'chief', purposes: [] }] }).success).toBe(false);
});
it('status marks a grant whose agent is gone as stale, and stale is the only extra field', () => {
  const status = { slot: 'notion:shared', state: 'applied', guidance: null, revision: 1, activeRevision: null, candidateRevision: null, phase: 'applied', test: null, consumers: [], activation: [], rollback: [] };
  expect(credentialStatusSchema.safeParse({ ...status, grants: [{ agent: 'chief', purposes: ['clipping'], stale: true }] }).success).toBe(true);
  for (const bad of [{ stale: false }, { stale: 'yes' }, { path: '/x' }])
    expect(credentialStatusSchema.safeParse({ ...status, grants: [{ agent: 'chief', purposes: ['clipping'], ...bad }] }).success).toBe(false);
});
it('grant preview takes a strict slot, agent and purpose and returns a secret-free inventory', () => {
  const input = { slot: 'notion:shared', agent: 'chief', purpose: 'clipping' };
  expect(credentialGrantPreviewInput.safeParse(input).success).toBe(true);
  for (const change of [{ purpose: 'email' }, { slot: 'x' }, { path: '/x' }, { agent: undefined }])
    expect(credentialGrantPreviewInput.safeParse({ ...input, ...change }).success).toBe(false);
  const reply = { agent: 'chief', purpose: 'clipping', inventoryRevision: 'a'.repeat(64), consumers: [{ name: 'chief', category: 'owned-agent', incarnation: null }] };
  expect(credentialGrantPreviewSchema.safeParse(reply).success).toBe(true);
  expect(credentialGrantPreviewSchema.safeParse({ ...reply, token: 'x' }).success).toBe(false);
});
