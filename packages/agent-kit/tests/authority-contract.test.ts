import { describe, expect, it } from 'vitest';
import {
  memberSchema, newMemberSchema, newConnectedAccountViewSchema, providerIdentitySchema, audienceSchema, audienceWithinReaders, audienceWidens,
  turnAuthoritySchema, grantSchema, connectedAccountViewSchema, resourceBindingSchema,
  actionReceiptSchema, exactActionApprovalSchema, memberJobSchema, importedMemberJobSchema,
  budgetAttributionSchema, budgetDecisionSchema, vaultAreaBindingSchema, vaultWriteBindingSchema,
  IMPORT_CATEGORIES, importManifestSchema, importReceiptSchema, importInventoryReconciled,
} from '../src/authority-contract.js';

const hash = 'a'.repeat(64);
const at = '2026-01-01T00:00:00Z';
const member = (memberId: string) => ({ kind: 'member' as const, memberId });
const external = (workspaceId: string) => ({ kind: 'external' as const, platform: 'chat', workspaceId, subject: 'participant' });
const audience = { placeId: 'place', revision: 1, participants: [member('actor')] };
const source = { resource: { kind: 'note', id: 'note' }, revision: 1, currentReaders: [member('actor'), member('resolver')] };
const turn = { agentId: 'agent', turnId: 'turn', sessionId: 'session', placeId: 'place', audience, policyRevision: 1,
  origin: 'human', actingMemberId: 'actor', spokenByMemberId: 'speaker' };
const account = { id: 'account', connectorId: 'connector', automationMode: 'draft-and-ask', owner: { kind: 'member', id: 'actor' },
  providerAccount: { issuer: 'provider', subject: 'subject', tenantId: 'tenant', label: 'Display label' },
  status: 'ok', statusReason: null, generation: 1, lastUsedAt: null };
const approval = { requestId: 'request', callId: 'call', agentId: 'agent', actingMemberId: 'actor', placeId: 'place',
  audienceRevision: 1, accountId: 'account', accountGeneration: 1, action: 'send', payloadHash: hash,
  policyRevision: 1, expiresAt: at, resolvedByMemberId: 'resolver', resolution: 'approved' };
const job = { id: 'job', agentId: 'agent', ownerMemberId: 'actor', delivery: audience, requiredAccounts: [{ accountId: 'account', generation: 1 }],
  templateId: 'template', templateHash: hash, scopeHash: hash, timeZone: 'Europe/Oslo', authority: { id: 'authority', revision: 1 },
  enabled: true, adoption: 'current', disabledReason: null };
function receipt() {
  return { version: 1, manifest: { version: 1, sourceVersion: 'old', destinationVersion: 'new',
    inventory: Object.fromEntries(IMPORT_CATEGORIES.map(c => [c, { count: 0, checksum: hash, disposition: 'preserved' }])),
    mappings: [] as Array<{ category: string; sourceId: string; destinationId: string | null; provenance: string }>,
    recoverableArchiveId: 'archive', protectedTransferInventory: [] as Array<{ accountId: string; disposition: string }> },
    reconciliation: 'reconciled', importedJobsEnabled: false, importedApprovalsEnabled: false, importedActionsEnabled: false };
}

describe('authority contract shapes are not authentication', () => {
  it('reuses member roles and requires scoped provider identity, never email linking', () => {
    expect(memberSchema.parse({ id: 'member', organisationId: 'org', role: 'restricted', automationMode: 'draft-and-ask', status: 'removed' }).role).toBe('restricted');
    expect(providerIdentitySchema.safeParse({ email: 'person@example.invalid' }).success).toBe(false);
    expect(providerIdentitySchema.safeParse({ issuer: 'issuer', subject: 'subject', email: 'person@example.invalid' }).success).toBe(false);
  });
  it('keeps actor, authentic speaker and resolver separate, without elevating resolver', () => {
    expect(turnAuthoritySchema.parse(turn).actingMemberId).toBe('actor');
    const resumed = turnAuthoritySchema.parse({ ...turn, origin: 'approval-resume', requestId: 'request', resolvedByMemberId: 'resolver' });
    expect(resumed.actingMemberId).toBe('actor');
    expect(resumed.spokenByMemberId).toBe('speaker');
    expect(turnAuthoritySchema.safeParse({ ...turn, resolvedByMemberId: 'resolver' }).success).toBe(false);
  });
  it('only allows null actors for unknown-speaker place access and binds place', () => {
    expect(turnAuthoritySchema.safeParse({ ...turn, actingMemberId: null, spokenByMemberId: null }).success).toBe(true);
    expect(turnAuthoritySchema.safeParse({ ...turn, actingMemberId: null }).success).toBe(false);
    expect(turnAuthoritySchema.safeParse({ ...turn, placeId: 'another' }).success).toBe(false);
    expect(turnAuthoritySchema.safeParse({ ...turn, jobId: 'job' }).success).toBe(false);
  });
  it('resumes preserve paired job provenance and never invent a human speaker', () => {
    const resumed = { ...turn, origin: 'approval-resume', requestId: 'request', resolvedByMemberId: 'resolver',
      jobId: 'job', runId: 'run', spokenByMemberId: null };
    expect(turnAuthoritySchema.parse(resumed)).toMatchObject({ actingMemberId: 'actor', jobId: 'job', runId: 'run' });
    expect(turnAuthoritySchema.safeParse({ ...resumed, runId: undefined }).success).toBe(false);
    expect(turnAuthoritySchema.safeParse({ ...resumed, spokenByMemberId: 'resolver' }).success).toBe(false);
  });
  it('machine jobs never claim human speech and always carry job/run identity', () => {
    const scheduled = { ...turn, origin: 'job', jobId: 'job', runId: 'run', spokenByMemberId: null };
    expect(turnAuthoritySchema.safeParse(scheduled).success).toBe(true);
    for (const patch of [{ spokenByMemberId: 'actor' }, { actingMemberId: null }, { runId: undefined }])
      expect(turnAuthoritySchema.safeParse({ ...scheduled, ...patch }).success).toBe(false);
  });
});

describe('audience comparison', () => {
  it('requires known nonempty audiences and reader sets', () => {
    for (const bad of [null, { ...audience, participants: [] }, { ...audience, unknown: true }, { ...audience, participants: ['handle'] }])
      expect(audienceWithinReaders(bad, source)).toBe(false);
    expect(audienceWithinReaders(audience, { ...source, currentReaders: [] })).toBe(false);
    expect(audienceWithinReaders(audience, { ...source, currentReaders: undefined })).toBe(false);
    expect(audienceSchema.safeParse({ ...audience, participants: [member('actor'), member('actor')] }).success).toBe(false);
  });
  it('intersects captured and current readers in both directions', () => {
    expect(audienceWithinReaders(audience, source)).toBe(true);
    expect(audienceWithinReaders(audience, { ...source, capturedReaders: [member('resolver')] })).toBe(false);
    expect(audienceWithinReaders(audience, { ...source, capturedReaders: [member('actor')], currentReaders: [member('resolver')] })).toBe(false);
    expect(audienceWithinReaders(audience, { ...source, capturedReaders: [] })).toBe(false);
  });
  it('scopes external participants to platform and workspace', () => {
    const a = { ...audience, participants: [external('workspace-a')] };
    expect(audienceWithinReaders(a, { ...source, currentReaders: [external('workspace-b')] })).toBe(false);
    expect(audienceWithinReaders(a, { ...source, currentReaders: [external('workspace-a')] })).toBe(true);
  });
  it('detects widening and place changes, permits narrowing without granting freshness', () => {
    const shared = { ...audience, participants: [member('actor'), member('resolver')] };
    expect(audienceWidens(audience, shared)).toBe(true);
    expect(audienceWidens(shared, audience)).toBe(false);
    expect(audienceWidens(audience, { ...audience, placeId: 'another' })).toBe(true);
  });
});

describe('secret-free account and exact-action shapes', () => {
  it('requires draft-and-ask at member/company-account creation', () => {
    const m = { id: 'member', organisationId: 'org', role: 'member', status: 'invited', automationMode: 'draft-and-ask' };
    expect(newMemberSchema.safeParse(m).success).toBe(true);
    expect(newMemberSchema.safeParse({ ...m, automationMode: 'expanded' }).success).toBe(false);
    const company = { ...account, owner: { kind: 'organisation', id: 'org' } };
    expect(newConnectedAccountViewSchema.safeParse(company).success).toBe(true);
    expect(newConnectedAccountViewSchema.safeParse({ ...company, automationMode: 'expanded' }).success).toBe(false);
  });
  it('rejects custody and credential fields even when nested', () => {
    expect(connectedAccountViewSchema.safeParse(account).success).toBe(true);
    for (const field of ['credentialRef', 'token', 'path', 'custodyHandle']) {
      expect(connectedAccountViewSchema.safeParse({ ...account, [field]: 'forbidden' }).success).toBe(false);
      expect(connectedAccountViewSchema.safeParse({ ...account, providerAccount: { ...account.providerAccount, [field]: 'forbidden' } }).success).toBe(false);
    }
    expect(resourceBindingSchema.safeParse({ id: 'binding', connectedAccountId: 'account', resourceKind: 'mailbox', externalId: 'mailbox',
      providerLabel: 'Inbox', boundTo: { kind: 'brand', id: 'brand' } }).success).toBe(true);
  });
  it('requires precise approval binding and a human resolver for a human decision', () => {
    expect(exactActionApprovalSchema.safeParse(approval).success).toBe(true);
    for (const patch of [{ payloadHash: 'payload' }, { accountGeneration: undefined }, { actingMemberId: undefined },
      { resolvedByMemberId: null }, { credentialRef: 'forbidden' }])
      expect(exactActionApprovalSchema.safeParse({ ...approval, ...patch }).success).toBe(false);
  });
  it('receipts include provenance but no raw payload and grants cannot pre-expire', () => {
    const r = { actingMemberId: 'actor', agentId: 'agent', action: 'send', accountId: 'account', resourceBindingId: 'binding',
      providerReceiptId: 'receipt', at, provenance: { kind: 'approval', requestId: 'request' } };
    expect(actionReceiptSchema.safeParse(r).success).toBe(true);
    const automated = { ...r, provenance: { kind: 'automation', automationAuthorityId: 'authority', authorityRevision: 1 } };
    expect(actionReceiptSchema.safeParse(automated).success).toBe(true);
    expect(actionReceiptSchema.safeParse({ ...automated, provenance: { ...automated.provenance, jobId: 'job' } }).success).toBe(false);
    expect(actionReceiptSchema.safeParse({ ...automated, provenance: { ...automated.provenance, jobId: 'job', runId: 'run' } }).success).toBe(true);
    expect(actionReceiptSchema.safeParse({ ...r, payload: 'raw' }).success).toBe(false);
    expect(grantSchema.safeParse({ resource: source.resource, principal: { kind: 'organisation', id: 'org' }, permission: 'use',
      grantorMemberId: 'actor', createdAt: at, expiresAt: at }).success).toBe(false);
  });
});

describe('jobs, budgets and Vault bindings', () => {
  it('requires disabled pending adoption for imported jobs', () => {
    expect(memberJobSchema.safeParse(job).success).toBe(true);
    expect(memberJobSchema.safeParse({ ...job, adoption: 'pending' }).success).toBe(false);
    expect(importedMemberJobSchema.safeParse(job).success).toBe(false);
    expect(importedMemberJobSchema.safeParse({ ...job, enabled: false, adoption: 'pending', disabledReason: 'imported' }).success).toBe(true);
  });
  it('requires complete attribution and one endpoint; unavailable remains explicit', () => {
    const a = { installationId: 'installation', memberId: 'actor', agentId: 'agent', placeId: 'place', gatewayEndpointId: 'gateway' };
    expect(budgetAttributionSchema.safeParse(a).success).toBe(true);
    expect(budgetAttributionSchema.safeParse({ ...a, memberId: undefined }).success).toBe(false);
    expect(budgetAttributionSchema.safeParse({ ...a, jobId: 'job' }).success).toBe(false);
    expect(budgetAttributionSchema.safeParse({ ...a, fallbackEndpointId: 'other' }).success).toBe(false);
    expect(budgetDecisionSchema.parse({ outcome: 'unavailable', scope: 'member', reason: 'unreachable' }).outcome).toBe('unavailable');
  });
  it('binds a write to an area, revisions and origin without ownership frontmatter', () => {
    const b = { areaId: 'area', kind: 'private', owner: account.owner, resource: source.resource,
      backingStoreId: 'store', relativePath: 'notes/note.md', accessRevision: 1 };
    expect(vaultAreaBindingSchema.safeParse(b).success).toBe(true);
    for (const path of ['/absolute', '../outside', 'notes/../outside', 'notes\\outside', './note', 'notes//note'])
      expect(vaultAreaBindingSchema.safeParse({ ...b, relativePath: path }).success).toBe(false);
    const w = { areaId: 'area', relativePath: 'notes/note.md', expectedContentRevision: hash, accessRevision: 1, approvedOrigin: 'synced', authority: turn };
    expect(vaultWriteBindingSchema.safeParse(w).success).toBe(true);
    expect(vaultWriteBindingSchema.safeParse({ ...w, owner: account.owner }).success).toBe(false);
    expect(vaultWriteBindingSchema.safeParse({ ...w, expectedContentRevision: undefined }).success).toBe(false);
  });
});

describe('all-data import reconciliation', () => {
  it('requires every category, checksum and disabled executable state', () => {
    expect(importInventoryReconciled(receipt())).toBe(true);
    for (const c of IMPORT_CATEGORIES) {
      const r = receipt(); delete r.manifest.inventory[c];
      expect(importManifestSchema.safeParse(r.manifest).success).toBe(false);
    }
    for (const key of ['importedJobsEnabled', 'importedApprovalsEnabled', 'importedActionsEnabled'])
      expect(importReceiptSchema.safeParse({ ...receipt(), [key]: true }).success).toBe(false);
    expect(importManifestSchema.safeParse({ ...receipt().manifest, secrets: ['forbidden'] }).success).toBe(false);
  });
  it('only conversations can use the recoverable archive fallback', () => {
    for (const c of IMPORT_CATEGORIES) {
      const r = receipt(); r.manifest.inventory[c]!.disposition = 'archive-only';
      expect(importInventoryReconciled(r)).toBe(c === 'conversations');
    }
  });
  it('blocks missing/unresolved/duplicate mappings and reconnects', () => {
    const r = receipt(); r.manifest.inventory.members!.count = 1;
    expect(importInventoryReconciled(r)).toBe(false);
    r.manifest.mappings = [{ category: 'members', sourceId: 'old', destinationId: null, provenance: 'source' }];
    expect(importInventoryReconciled(r)).toBe(false);
    r.manifest.mappings[0]!.destinationId = 'new';
    expect(importInventoryReconciled(r)).toBe(true);
    r.manifest.mappings.push({ ...r.manifest.mappings[0]! }); r.manifest.inventory.members!.count = 2;
    expect(importInventoryReconciled(r)).toBe(false);
    const pending = receipt(); pending.reconciliation = 'pending';
    expect(importInventoryReconciled(pending)).toBe(false);
    const reconnect = receipt(); reconnect.manifest.protectedTransferInventory.push({ accountId: 'account', disposition: 'reconnect-required' });
    expect(importInventoryReconciled(reconnect)).toBe(false);
  });
});
