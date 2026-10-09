import { z } from 'zod';
import type { CredentialGrant } from '@lares/agent-kit/credential-lifecycle';

import { CREDENTIAL_SLOT, credentialConsumerSchema as consumer, credentialProgressSchema as progress, credentialTestSchema as test, credentialPhaseSchema, credentialGrantsSchema } from '@lares/agent-kit/credential-lifecycle';
export { CREDENTIAL_SLOT, credentialStatusSchema, type CredentialStatus, type CredentialConsumer, type CredentialGrant } from '@lares/agent-kit/credential-lifecycle';
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
export const credentialCustodySchema = z.object({ device: z.string(), inode: z.string(), size: z.number().int(), modified: z.string(), changed: z.string() }).strict();
const grantChange = z.object({ agent: name, purpose: z.literal('clipping'), to: z.boolean() }).strict();
const activationIntent = z.object({
  previousRevision: revision, targetRevision: revision, inventoryRevision: z.string().regex(/^[a-f0-9]{64}$/),
  prepared: z.boolean(), finishing: z.boolean(),
  // Grant/revoke only: the intended change and the exact grants on both sides, so recovery restores either.
  grantChange: grantChange.optional(), grantsBefore: credentialGrantsSchema.optional(), grantsAfter: credentialGrantsSchema.optional(),
}).strict();
export const credentialRecordSchema = z.object({
  slot: z.literal(CREDENTIAL_SLOT), version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  activeRevision: revision, candidateRevision: revision, rollbackRevision: revision,
  phase: credentialPhaseSchema,
  operation: z.object({ id: z.uuid(), kind: z.enum(['stage', 'test', 'discard', 'apply', 'disconnect', 'grant', 'revoke', 'recover']) }).strict().nullable(),
  test: test.nullable(), consumers: z.array(consumer).max(200),
  activation: z.array(progress).max(200), rollback: z.array(progress).max(200),
  // Internal custody/activation data never appears in the socket DTO.
  testedCustody: credentialCustodySchema.optional(),
  // Who may receive the managed key. Absent on records written before grants existed.
  grants: credentialGrantsSchema.optional(),
  effectiveRevision: revision.optional(), effectiveGrants: credentialGrantsSchema.optional(), activationIntent: activationIntent.nullable().optional(),
}).strict().superRefine((r, ctx) => {
  const invalid = (message: string) => ctx.addIssue({code:'custom',message});
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (r.activationIntent) {
    const i = r.activationIntent, kind = r.operation?.kind ?? '';
    const grantOp = kind === 'grant' || kind === 'revoke';
    if (!['applying', 'disconnecting', 'rolling-back', 'recovery-required'].includes(r.phase) ||
      !['apply', 'disconnect', 'grant', 'revoke'].includes(kind) || r.rollbackRevision !== i.previousRevision ||
      kind === 'apply' && i.targetRevision !== r.candidateRevision ||
      kind === 'disconnect' && i.targetRevision !== null ||
      r.effectiveRevision !== undefined && ![i.previousRevision, i.targetRevision].includes(r.effectiveRevision))
      invalid('Activation intent contradicts retained custody');
    // A grant change never moves the active key: same revision on every side, nothing staged.
    if (grantOp ? !i.grantChange || !i.grantsBefore || !i.grantsAfter || !i.previousRevision || i.previousRevision !== i.targetRevision ||
        i.previousRevision !== r.activeRevision || r.candidateRevision || i.grantChange.to !== (kind === 'grant') ||
        !same(r.grants ?? [], i.grantsBefore) ||
        r.effectiveGrants !== undefined && !same(r.effectiveGrants, i.grantsBefore) && !same(r.effectiveGrants, i.grantsAfter)
      : i.grantChange || i.grantsBefore || i.grantsAfter || r.effectiveGrants !== undefined && !same(r.effectiveGrants, r.grants ?? []))
      invalid('Grant change contradicts retained custody');
  } else {
    if (r.effectiveRevision !== undefined && r.effectiveRevision !== r.activeRevision) invalid('Effective binding must agree with completed custody');
    if (r.effectiveGrants !== undefined) invalid('Effective grants must agree with completed custody');
  }
  if (r.test?.identity && r.test.outcome !== 'passed') invalid('Only passed tests retain identity evidence');
  if (r.phase === 'testing' && (r.operation?.kind !== 'test' || r.test || r.rollbackRevision || !(r.candidateRevision || r.activeRevision)))
    invalid('Testing requires retained custody and cleared evidence');
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
  if (r.phase === 'applying' && !['grant', 'revoke'].includes(r.operation?.kind ?? '') &&
    (r.operation?.kind !== 'apply' || !r.candidateRevision || r.test?.outcome !== 'passed' || r.test.revision !== r.candidateRevision))
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
export const initialCredentialRecord = (): CredentialRecord => ({
  slot: CREDENTIAL_SLOT, version: 0, activeRevision: null, candidateRevision: null, rollbackRevision: null,
  phase: 'not-configured', operation: null, test: null, consumers: [], activation: [], rollback: [],
});
/** Grants the inventory is computed over. During a grant change it is the larger of the two sides
 * (after a grant, before a revoke) from the first journal write until finish, so the digest is stable
 * while the mount moves and rollback can still reach the agent. */
export const inventoryGrants = (r: CredentialRecord): CredentialGrant[] => {
  const i = r.activationIntent;
  if (i?.grantChange) return (i.grantChange.to ? i.grantsAfter : i.grantsBefore) ?? [];
  return r.grants ?? [];
};
/** Agents switched on for a purpose, as currently in effect for the runtime. */
export const effectiveGrantedAgents = (r: CredentialRecord | undefined, purpose = 'clipping'): Set<string> =>
  new Set((r ? r.effectiveGrants ?? r.grants ?? [] : []).filter(g => (g.purposes as string[]).includes(purpose)).map(g => g.agent));
export const interruptedCredential = (r: CredentialRecord): boolean =>
  ['staging', 'testing', 'discarding', 'applying', 'disconnecting', 'rolling-back', 'recovery-required'].includes(r.phase);
