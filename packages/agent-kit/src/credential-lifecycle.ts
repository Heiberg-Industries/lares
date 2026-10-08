import { z } from 'zod';

/** Secret-free status and strict named-slot commands shared by keeper and console. */
export const CREDENTIAL_SLOT = 'notion:shared' as const;
const revision = z.uuid().nullable();
const name = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export const credentialPhaseSchema = z.enum(['not-configured', 'staging', 'testing', 'pending-test', 'test-failed', 'pending-apply', 'discarding', 'applying', 'disconnecting', 'applied', 'disconnected', 'rolling-back', 'recovery-required']);
export const credentialConsumerSchema = z.object({
  name, category: z.enum(['owned-agent', 'unmanaged-service', 'external-binding', 'runtime-not-ready']),
  incarnation: revision,
}).strict();
export const credentialProgressSchema = z.object({ name, revision, state: z.enum(['pending', 'complete', 'failed']) }).strict();
export const credentialTestSchema = z.object({
  revision: z.uuid(), outcome: z.enum(['passed', 'refused', 'rate-limited', 'unavailable', 'unexpected']),
  at: z.iso.datetime(),
  identity: z.object({ kind: z.literal('internal-bot'), botId: z.uuid() }).strict().optional(),
}).strict();
export const credentialStatusSchema = z.object({
  slot: z.literal(CREDENTIAL_SLOT),
  state: z.enum(['unavailable', 'not-configured', 'host-administration-required', 'pending-test', 'test-failed', 'pending-apply', 'applying', 'disconnecting', 'applied', 'disconnected', 'recovery-required']),
  guidance: z.enum(['configure-administrator', 'prepare-managed-slot', 'prepare-writable-storage', 'review-consumers', 'inspect-journal', 'status-unavailable']).nullable(),
  revision: z.number().int().min(0).nullable(), activeRevision: revision, candidateRevision: revision,
  phase: credentialPhaseSchema.nullable(), test: credentialTestSchema.nullable(),
  consumers: z.array(credentialConsumerSchema).max(200), activation: z.array(credentialProgressSchema).max(200), rollback: z.array(credentialProgressSchema).max(200),
  inventoryRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
}).strict();
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

export type CredentialConsumer = z.infer<typeof credentialConsumerSchema>;
export const credentialSlotInput = z.object({ slot: z.literal(CREDENTIAL_SLOT) }).strict();
export const credentialRevisionInput = credentialSlotInput.extend({ expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
export const credentialTokenInput = z.string().min(1).max(8192).refine(v => new TextEncoder().encode(v).length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(v));
export const credentialActivationInput = credentialRevisionInput.extend({ expectedActiveRevision: z.uuid().nullable(), inventoryRevision: z.string().regex(/^[a-f0-9]{64}$/), confirmRestart: z.literal(true) }).strict();
export const credentialMutationInput = z.discriminatedUnion('operation', [
  credentialRevisionInput.extend({ operation: z.literal('test_save'), token: credentialTokenInput }).strict(),
  ...(['test_current', 'test_pending', 'discard'] as const).map(operation => credentialRevisionInput.extend({ operation: z.literal(operation) }).strict()),
  ...(['apply', 'disconnect'] as const).map(operation => credentialActivationInput.extend({ operation: z.literal(operation) }).strict()),
]);
export type CredentialMutation = z.infer<typeof credentialMutationInput>;
