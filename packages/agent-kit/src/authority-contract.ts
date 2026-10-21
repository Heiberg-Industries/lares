/** Shared, secret-free wire shapes. Parsing NEVER authenticates or authorizes anyone.
 * Trusted admission and current execution checks belong to future runtime consumers.
 */
import { z } from 'zod';
import type { OrgRole } from './identity.js';
import { ORIGIN_CLASSES } from './origin.js';

const id = z.string().trim().min(1);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const resource = z.strictObject({ kind: id, id });
const owner = z.strictObject({ kind: z.enum(['member', 'organisation']), id });
const accountRef = z.strictObject({ accountId: id, generation: revision });
const automationMode = z.enum(['draft-and-ask', 'expanded']);
const role = z.enum(['owner', 'member', 'restricted'] satisfies OrgRole[]);

export const memberSchema = z.strictObject({
  id, organisationId: id, role, automationMode, status: z.enum(['invited', 'active', 'removed']),
});
export type Member = z.infer<typeof memberSchema>;
export const newMemberSchema = memberSchema.refine(m => m.automationMode === 'draft-and-ask',
  'New members begin draft-and-ask');
// Provider identifiers are opaque: trimming can conflate different authenticated subjects.
const providerId = z.string().min(1).refine(value => value.trim().length > 0, 'Blank provider identifier');
export const providerIdentitySchema = z.strictObject({ issuer: providerId, subject: providerId, tenantId: providerId.optional() });
export type ProviderIdentity = z.infer<typeof providerIdentitySchema>;

export const audienceParticipantSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('member'), memberId: id }),
  z.strictObject({ kind: z.literal('external'), platform: id, workspaceId: id, subject: id }),
]);
export type AudienceParticipant = z.infer<typeof audienceParticipantSchema>;
const participantKey = (p: AudienceParticipant): string => p.kind === 'member'
  ? JSON.stringify(['member', p.memberId]) : JSON.stringify(['external', p.platform, p.workspaceId, p.subject]);
const participants = z.array(audienceParticipantSchema).min(1)
  .refine(ps => new Set(ps.map(participantKey)).size === ps.length, 'Duplicate audience participant');
export const audienceSchema = z.strictObject({ placeId: id, revision, participants });
export type Audience = z.infer<typeof audienceSchema>;
export const sourceAccessSchema = z.strictObject({
  resource, revision, currentReaders: participants, capturedReaders: participants.optional(),
});
export type SourceAccess = z.infer<typeof sourceAccessSchema>;

/** Pure comparison only: callers must resolve current membership/revisions before calling.
 * Missing, unknown, or malformed reader/audience snapshots refuse rather than broaden.
 */
export function audienceWithinReaders(audience: unknown, source: unknown): boolean {
  const a = audienceSchema.safeParse(audience);
  const s = sourceAccessSchema.safeParse(source);
  if (!a.success || !s.success) return false;
  const current = new Set(s.data.currentReaders.map(participantKey));
  const captured = s.data.capturedReaders && new Set(s.data.capturedReaders.map(participantKey));
  return a.data.participants.every(p => current.has(participantKey(p)) && (!captured || captured.has(participantKey(p))));
}
/** Any new participant needs a fresh session; revisions still need trusted resolution. */
export function audienceWidens(previous: Audience, next: Audience): boolean {
  const before = new Set(audienceSchema.parse(previous).participants.map(participantKey));
  const after = audienceSchema.parse(next);
  return previous.placeId !== after.placeId || after.participants.some(p => !before.has(participantKey(p)));
}

const turn = {
  agentId: id, turnId: id, sessionId: id, placeId: id, audience: audienceSchema, policyRevision: revision,
};
export const turnAuthoritySchema = z.discriminatedUnion('origin', [
  z.strictObject({ ...turn, origin: z.literal('human'), actingMemberId: id.nullable(), spokenByMemberId: id.nullable() }),
  z.strictObject({ ...turn, origin: z.literal('job'), actingMemberId: id, spokenByMemberId: z.null(), jobId: id, runId: id }),
  z.strictObject({ ...turn, origin: z.literal('approval-resume'), actingMemberId: id, spokenByMemberId: id.nullable(), resolvedByMemberId: id, requestId: id, jobId: id.optional(), runId: id.optional() }),
]).superRefine((v, ctx) => {
  if (v.origin === 'approval-resume' && ((v.jobId === undefined) !== (v.runId === undefined) ||
    (v.jobId !== undefined && v.spokenByMemberId !== null)))
    ctx.addIssue({ code: 'custom', message: 'Resumed job requires paired job/run provenance and no human speaker' });
  if (v.placeId !== v.audience.placeId) ctx.addIssue({ code: 'custom', message: 'Audience belongs to another place' });
  if (v.actingMemberId === null && v.spokenByMemberId !== null) ctx.addIssue({ code: 'custom', message: 'Unknown actor is place-only unknown-speaker access' });
});
export type TurnAuthority = z.infer<typeof turnAuthoritySchema>;
export const grantSchema = z.strictObject({
  resource, principal: z.strictObject({ kind: z.enum(['member', 'organisation', 'place']), id }),
  permission: z.enum(['use', 'edit', 'approve', 'act_for_brand']), grantorMemberId: id,
  createdAt: timestamp, expiresAt: timestamp.nullable(),
}).refine(g => g.expiresAt === null || Date.parse(g.expiresAt) > Date.parse(g.createdAt), 'Grant expiry must follow creation');
export type Grant = z.infer<typeof grantSchema>;
/** Ownership is separate from grants, agent stewardship and credential custody. */
export const resourceOwnershipSchema = z.strictObject({ resource, owner });
export type ResourceOwnership = z.infer<typeof resourceOwnershipSchema>;

export const connectedAccountViewSchema = z.strictObject({
  id, connectorId: id, owner, automationMode,
  providerAccount: providerIdentitySchema.extend({ label: id }),
  status: z.enum(['ok', 'needs_reconsent', 'revoked', 'error']), statusReason: id.nullable(),
  generation: revision, lastUsedAt: timestamp.nullable(),
});
export type ConnectedAccountView = z.infer<typeof connectedAccountViewSchema>;
export const newConnectedAccountViewSchema = connectedAccountViewSchema.refine(a =>
  a.owner.kind !== 'organisation' || a.automationMode === 'draft-and-ask',
  'New company accounts begin draft-and-ask');
export const resourceBindingSchema = z.strictObject({
  id, connectedAccountId: id, resourceKind: id, externalId: providerId, providerLabel: id,
  boundTo: z.strictObject({ kind: z.enum(['member', 'brand', 'organisation']), id }),
});
export type ResourceBinding = z.infer<typeof resourceBindingSchema>;
/** Mailbox/calendar selection uses stable references; display labels confer no authority. */
export const accountResourceReferenceSchema = z.strictObject({ accountId: id, resourceBindingId: id });
export type AccountResourceReference = z.infer<typeof accountResourceReferenceSchema>;
const provenance = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('approval'), requestId: id }),
  z.strictObject({ kind: z.literal('automation'), automationAuthorityId: id, authorityRevision: revision, jobId: id.optional(), runId: id.optional() })
    .refine(p => (p.jobId === undefined) === (p.runId === undefined), 'Job provenance must include job and run together'),
]);
export const actionReceiptSchema = z.strictObject({
  actingMemberId: id, agentId: id, action: id, accountId: id, resourceBindingId: id,
  providerReceiptId: id, at: timestamp, provenance,
});
export type ActionReceipt = z.infer<typeof actionReceiptSchema>;
export const exactActionApprovalSchema = z.strictObject({
  requestId: id, callId: id, agentId: id, actingMemberId: id, placeId: id, audienceRevision: revision,
  accountId: id, accountGeneration: revision, resourceBindingId: id.optional(), brandId: id.optional(),
  action: id, payloadHash: hash, templateHash: hash.optional(), policyRevision: revision, expiresAt: timestamp,
  resolvedByMemberId: id.nullable(), resolution: z.enum(['pending', 'approved', 'refused', 'expired', 'revoked']),
}).refine(a => (a.resolution !== 'approved' && a.resolution !== 'refused') || a.resolvedByMemberId !== null,
  'Human resolution requires its resolver');
export type ExactActionApproval = z.infer<typeof exactActionApprovalSchema>;

const job = {
  id, agentId: id, ownerMemberId: id, delivery: audienceSchema, requiredAccounts: z.array(accountRef),
  templateId: id, templateHash: hash, scopeHash: hash, timeZone: id,
  authority: z.strictObject({ id, revision }),
};
export const memberJobSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ ...job, enabled: z.literal(true), adoption: z.literal('current'), disabledReason: z.null() }),
  z.strictObject({ ...job, enabled: z.literal(false), adoption: z.enum(['current', 'pending']), disabledReason: id }),
]);
export type MemberJob = z.infer<typeof memberJobSchema>;
export const importedMemberJobSchema = memberJobSchema.refine(j => !j.enabled && j.adoption === 'pending',
  'Imported jobs require explicit adoption and renewed authority');
export const budgetAttributionSchema = z.strictObject({
  installationId: id, memberId: id, agentId: id, placeId: id, gatewayEndpointId: id,
  jobId: id.optional(), runId: id.optional(),
}).refine(a => (a.jobId === undefined) === (a.runId === undefined), 'Job and run attribution must occur together');
export type BudgetAttribution = z.infer<typeof budgetAttributionSchema>;
export const budgetDecisionSchema = z.strictObject({
  outcome: z.enum(['allowed', 'denied', 'unavailable']), scope: z.enum(['member', 'installation']), reason: id,
});
export type BudgetDecision = z.infer<typeof budgetDecisionSchema>;

const relativePath = id.refine(p => !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') &&
  p.split('/').every(part => part !== '..' && part !== '.' && part !== ''), 'Expected a relative path without traversal');
export const vaultAreaBindingSchema = z.strictObject({
  areaId: id, kind: z.enum(['private', 'shared', 'place', 'taste']), owner, resource,
  backingStoreId: id, relativePath, accessRevision: revision,
});
export type VaultAreaBinding = z.infer<typeof vaultAreaBindingSchema>;
export const vaultWriteBindingSchema = z.strictObject({
  areaId: id, relativePath, expectedContentRevision: hash, accessRevision: revision,
  approvedOrigin: z.enum(ORIGIN_CLASSES), authority: turnAuthoritySchema,
});
export type VaultWriteBinding = z.infer<typeof vaultWriteBindingSchema>;

/** Every category must be inventoried, including zero-count categories. No credential data. */
export const IMPORT_CATEGORIES = [
  'members', 'identities', 'grants', 'agents', 'accounts', 'resource-bindings', 'conversations',
  'vault', 'facts', 'taste', 'archives', 'jobs', 'approvals', 'actions', 'budgets', 'settings',
  'safety', 'sync', 'suppression', 'contacts', 'source-links', 'domain-records',
] as const;
const category = z.enum(IMPORT_CATEGORIES);
const inventoryEntry = z.strictObject({
  count: revision, checksum: hash,
  disposition: z.enum(['preserved', 'reconnect-required', 'archive-only', 'blocked']),
});
export const importManifestSchema = z.strictObject({
  version: z.literal(1), sourceVersion: id, destinationVersion: id,
  inventory: z.record(category, inventoryEntry),
  mappings: z.array(z.strictObject({ category, sourceId: id, destinationId: id.nullable(), provenance: id })),
  recoverableArchiveId: id,
  protectedTransferInventory: z.array(z.strictObject({ accountId: id, disposition: z.enum(['protected-transfer', 'reconnect-required']) })),
});
export type ImportManifest = z.infer<typeof importManifestSchema>;
export const importReceiptSchema = z.strictObject({
  version: z.literal(1), manifest: importManifestSchema,
  reconciliation: z.enum(['pending', 'blocked', 'reconciled']),
  importedJobsEnabled: z.literal(false), importedApprovalsEnabled: z.literal(false), importedActionsEnabled: z.literal(false),
});
export type ImportReceipt = z.infer<typeof importReceiptSchema>;
/** Inventory consistency only, never permission to perform a move. Reconnect is outstanding. */
export function importInventoryReconciled(receipt: unknown): boolean {
  const parsed = importReceiptSchema.safeParse(receipt);
  if (!parsed.success || parsed.data.reconciliation !== 'reconciled') return false;
  const m = parsed.data.manifest;
  const keys = m.mappings.map(x => JSON.stringify([x.category, x.sourceId]));
  if (new Set(keys).size !== keys.length) return false;
  const destinations = m.mappings.filter(x => x.destinationId !== null).map(x => JSON.stringify([x.category, x.destinationId]));
  if (new Set(destinations).size !== destinations.length) return false;
  return IMPORT_CATEGORIES.every(c =>
    m.mappings.filter(x => x.category === c).length === m.inventory[c].count) &&
    IMPORT_CATEGORIES.every(c => m.inventory[c].disposition === 'preserved' ||
    (c === 'conversations' && m.inventory[c].disposition === 'archive-only')) &&
    m.mappings.every(x => x.destinationId !== null ||
      (x.category === 'conversations' && m.inventory.conversations.disposition === 'archive-only')) &&
    m.protectedTransferInventory.every(x => x.disposition !== 'reconnect-required');
}
