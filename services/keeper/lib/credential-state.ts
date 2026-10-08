import { z } from 'zod';

export const CREDENTIAL_SLOT = 'notion:shared' as const;
const revision = z.uuid().nullable();
const name = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export const credentialConfigSchema = z.object({
  // Same principal namespace as the authenticated app socket. No implicit first member.
  administrator: z.email().max(254).optional(),
  slot: z.literal(CREDENTIAL_SLOT),
  binding: z.literal('NOTION_TOKEN_FILE'),
  prepared: z.boolean(),
  inventoryComplete: z.boolean(),
  retainedConsumers: z.array(z.object({
    name, category: z.enum(['unmanaged-service', 'external-binding']),
  }).strict()).max(100),
}).strict();
export type CredentialConfig = z.infer<typeof credentialConfigSchema>;
const consumer = z.object({
  name, category: z.enum(['owned-agent', 'unmanaged-service', 'external-binding', 'runtime-not-ready']),
  incarnation: revision,
}).strict();
const progress = z.object({ name, revision, state: z.enum(['pending', 'complete', 'failed']) }).strict();
const test = z.object({
  revision: z.uuid(), outcome: z.enum(['passed', 'refused', 'rate-limited', 'unavailable', 'unexpected']),
  at: z.iso.datetime(),
}).strict();
export const credentialRecordSchema = z.object({
  slot: z.literal(CREDENTIAL_SLOT), version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  activeRevision: revision, candidateRevision: revision, rollbackRevision: revision,
  phase: z.enum(['not-configured', 'staging', 'pending-test', 'test-failed', 'pending-apply', 'discarding', 'applying', 'applied', 'disconnected', 'rolling-back', 'recovery-required']),
  operation: z.object({ id: z.uuid(), kind: z.enum(['stage', 'test', 'discard', 'apply', 'disconnect', 'recover']) }).strict().nullable(),
  test: test.nullable(), consumers: z.array(consumer).max(200),
  activation: z.array(progress).max(200), rollback: z.array(progress).max(200),
}).strict().superRefine((r, ctx) => {
  const invalid = (message: string) => ctx.addIssue({code:'custom',message});
  if (['not-configured', 'disconnected'].includes(r.phase) && (r.activeRevision || r.candidateRevision || r.rollbackRevision || r.test))
    invalid('Empty state must have no credential custody or test evidence');
  if (r.candidateRevision && r.candidateRevision === r.activeRevision) invalid('Candidate must have a new revision');
  if (r.test && ![r.activeRevision, r.candidateRevision, r.rollbackRevision].includes(r.test.revision))
    invalid('Test evidence must reference retained custody');
  if (r.phase === 'staging' && (r.operation?.kind !== 'stage' || r.test || r.rollbackRevision))
    invalid('Staging requires its own intent without test or rollback');
  if (r.phase === 'pending-test' && (r.operation?.kind !== 'stage' || r.test || r.rollbackRevision))
    invalid('Pending test requires a staged untested candidate');
  if (r.phase === 'test-failed' && (r.operation?.kind !== 'test' || !r.test || r.test.outcome === 'passed' || r.test.revision !== r.candidateRevision))
    invalid('Failed test requires exact failed candidate evidence');
  if (r.phase === 'discarding' && (r.operation?.kind !== 'discard' || r.rollbackRevision))
    invalid('Discard requires its own intent and no rollback');
  if (r.phase === 'pending-apply' && (r.operation?.kind !== 'test' || r.rollbackRevision))
    invalid('Pending apply requires completed test intent');
  if (r.phase === 'applying' && (r.operation?.kind !== 'apply' || !r.candidateRevision || r.test?.outcome !== 'passed' || r.test.revision !== r.candidateRevision))
    invalid('Apply requires exact successfully tested candidate intent');
  if (r.phase === 'rolling-back' && !r.operation) invalid('Rollback requires durable intent');
  if (r.phase === 'applied' && (r.candidateRevision || r.rollbackRevision)) invalid('Applied state requires completed custody cleanup');
  if (['staging', 'pending-test', 'test-failed', 'pending-apply', 'discarding'].includes(r.phase) && !r.candidateRevision)
    ctx.addIssue({ code: 'custom', message: 'Candidate required' });
  if (r.phase === 'pending-apply' && (r.test?.outcome !== 'passed' || r.test.revision !== r.candidateRevision))
    ctx.addIssue({ code: 'custom', message: 'Exact tested candidate required' });
  if (r.phase === 'applied' && !r.activeRevision)
    ctx.addIssue({ code: 'custom', message: 'Active revision required' });
});
export type CredentialRecord = z.infer<typeof credentialRecordSchema>;
export type CredentialConsumer = z.infer<typeof consumer>;
export const initialCredentialRecord = (): CredentialRecord => ({
  slot: CREDENTIAL_SLOT, version: 0, activeRevision: null, candidateRevision: null, rollbackRevision: null,
  phase: 'not-configured', operation: null, test: null, consumers: [], activation: [], rollback: [],
});
export const credentialStatusSchema = z.object({
  slot: z.literal(CREDENTIAL_SLOT),
  state: z.enum(['unavailable', 'not-configured', 'host-administration-required', 'pending-test', 'test-failed', 'pending-apply', 'applying', 'applied', 'disconnected', 'recovery-required']),
  guidance: z.enum(['configure-administrator', 'prepare-managed-slot', 'prepare-writable-storage', 'review-consumers', 'inspect-journal', 'status-unavailable']).nullable(),
  revision: z.number().int().min(0).nullable(), activeRevision: revision, candidateRevision: revision,
  phase: credentialRecordSchema.shape.phase.nullable(), test: test.nullable(),
  consumers: z.array(consumer).max(200), activation: z.array(progress).max(200), rollback: z.array(progress).max(200),
}).strict();
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;
export const interruptedCredential = (r: CredentialRecord): boolean =>
  ['staging', 'discarding', 'applying', 'rolling-back', 'recovery-required'].includes(r.phase);
