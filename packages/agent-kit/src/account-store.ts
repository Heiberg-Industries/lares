/** Personal-account persistence and explicit association to existing custody, not authentication.
 * Only trusted server adapters may supply verifiers; never expose them as model tools.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { currentMember } from './member-store.js';
import { associateAccountCredential, readAccountCredential, type OAuthCredentialCommit, type StoredAccountCredential } from './account-credentials.js';
import {
  connectedAccountViewSchema, providerIdentitySchema, resourceBindingSchema,
  type ConnectedAccountView, type ResourceBinding,
} from './authority-contract.js';

const text = z.string().trim().min(1);
const verifiedAccountSchema = providerIdentitySchema.extend({ label: text });
const verifiedResourceSchema = z.strictObject({ resourceKind: text, externalId: z.string().min(1), providerLabel: text });
const resourceSelectionSchema = z.strictObject({
  accountId: text, generation: z.number().int().nonnegative(), resourceBindingId: text,
});
export type PersonalResourceSelection = z.infer<typeof resourceSelectionSchema>;
export interface ResolvedPersonalResource { account: ConnectedAccountView; resource: ResourceBinding }
const updateSchema = z.strictObject({
  accountId: text, generation: z.number().int().nonnegative(), lifecycleRevision: z.number().int().nonnegative(),
});
export type AccountUpdate = z.infer<typeof updateSchema>;
/** Verifiers validate provider responses/ownership with maintained SDKs outside this store.
 * Their evidence input may be untrusted; their returned identity/resources must be verified.
 * Labels are display metadata, never proof. Return no raw errors, tokens or custody handles.
 */
export interface TrustedAccountAdapter {
  connectorId: string;
  verifyAccount(evidence: unknown): Promise<z.infer<typeof verifiedAccountSchema>>;
  verifyResource(account: ConnectedAccountView, evidence: unknown): Promise<z.infer<typeof verifiedResourceSchema>>;
}
interface Row {
  id: string; owner_member_id: string; connector_id: string;
  provider_issuer: string; provider_subject: string; provider_tenant_id: string; provider_label: string;
  status: ConnectedAccountView['status']; status_reason: string | null; generation: number;
  lifecycle_revision: number; last_used_at: Date | null;
}
export class AccountAccessError extends Error {
  constructor() { super('Account unavailable or authority changed'); }
}
function view(r: Row): ConnectedAccountView {
  return connectedAccountViewSchema.parse({
    id: r.id, connectorId: r.connector_id, owner: { kind: 'member', id: r.owner_member_id },
    automationMode: 'draft-and-ask',
    providerAccount: { issuer: r.provider_issuer, subject: r.provider_subject,
      ...(r.provider_tenant_id ? { tenantId: r.provider_tenant_id } : {}), label: r.provider_label },
    status: r.status, statusReason: r.status_reason, generation: r.generation,
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
  });
}
const sameIdentity = (r: Row, p: z.infer<typeof verifiedAccountSchema>) =>
  r.provider_issuer === p.issuer && r.provider_subject === p.subject && r.provider_tenant_id === (p.tenantId ?? '');

export class PgAccountStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(memberId: string, work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await this.requireActiveMember(db, memberId);
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  private async requireActiveMember(db: PoolClient, memberId: string): Promise<void> {
    if (!await currentMember(db, memberId, { lock: 'share' })) throw new AccountAccessError();
  }

  private async row(db: PoolClient, memberId: string, id: string): Promise<Row> {
    const { rows } = await db.query<Row>(
      'SELECT * FROM connected_accounts WHERE id = $1 AND owner_member_id = $2 FOR UPDATE', [id, memberId]);
    if (!rows[0]) throw new AccountAccessError();
    return rows[0];
  }
  private async current(db: PoolClient, memberId: string, input: AccountUpdate): Promise<Row> {
    const expected = updateSchema.parse(input);
    const r = await this.row(db, memberId, expected.accountId);
    if (r.generation !== expected.generation || r.lifecycle_revision !== expected.lifecycleRevision)
      throw new AccountAccessError();
    return r;
  }
  async list(memberId: string): Promise<ConnectedAccountView[]> {
    return this.transaction(memberId, async db => {
      const { rows } = await db.query<Row>('SELECT * FROM connected_accounts WHERE owner_member_id = $1 ORDER BY id', [memberId]);
      return rows.map(view);
    });
  }
  async read(memberId: string, accountId: string): Promise<ConnectedAccountView> {
    return this.transaction(memberId, async db => view(await this.row(db, memberId, accountId)));
  }
  /** Capture BEFORE asynchronous provider work; completion must compare both counters.
   * lifecycleRevision serializes callbacks; generation invalidates execution authority.
   */
  async beginUpdate(memberId: string, accountId: string, generation: number): Promise<AccountUpdate> {
    return this.transaction(memberId, async db => {
      const r = await this.row(db, memberId, accountId);
      if (r.generation !== generation) throw new AccountAccessError();
      return { accountId, generation, lifecycleRevision: r.lifecycle_revision };
    });
  }
  async setStatus(memberId: string, input: AccountUpdate,
    status: 'needs_reconsent' | 'revoked' | 'error'): Promise<ConnectedAccountView> {
    const expected = updateSchema.parse(input);
    const reasons = { needs_reconsent: 'consent-required', revoked: 'revoked-by-member', error: 'provider-unavailable' } as const;
    if (!Object.hasOwn(reasons, status)) throw new AccountAccessError();
    return this.transaction(memberId, async db => {
      const r = await this.current(db, memberId, expected);
      const { rows } = await db.query<Row>(`UPDATE connected_accounts SET status=$2, status_reason=$3,
        generation=generation+1, lifecycle_revision=lifecycle_revision+1 WHERE id=$1 RETURNING *`, [r.id, status, reasons[status]]);
      return view(rows[0]);
    });
  }
  async listResources(memberId: string, accountId: string, generation: number): Promise<ResourceBinding[]> {
    return this.transaction(memberId, async db => {
      const r = await this.row(db, memberId, accountId);
      if (r.status !== 'ok' || r.generation !== generation) throw new AccountAccessError();
      const { rows } = await db.query('SELECT * FROM connected_resource_bindings WHERE connected_account_id=$1 AND owner_member_id=$2 ORDER BY id', [accountId, memberId]);
      return rows.map(b => resourceBindingSchema.parse({ id: b.id, connectedAccountId: b.connected_account_id,
        resourceKind: b.resource_kind, externalId: b.external_id, providerLabel: b.provider_label,
        boundTo: { kind: 'member', id: b.owner_member_id } }));
    });
  }
  private async personalResource(db: PoolClient, memberId: string,
    expected: PersonalResourceSelection, resourceKind: string): Promise<{ row: Row; selection: ResolvedPersonalResource }> {
    const r = await this.row(db, memberId, expected.accountId);
    if (r.status !== 'ok' || r.generation !== expected.generation) throw new AccountAccessError();
    const { rows } = await db.query(`SELECT * FROM connected_resource_bindings
      WHERE id=$1 AND connected_account_id=$2 AND owner_member_id=$3 AND resource_kind=$4 FOR SHARE`,
      [expected.resourceBindingId, r.id, memberId, resourceKind]);
    const b = rows[0];
    if (!b) throw new AccountAccessError();
    return { row: r, selection: { account: view(r), resource: resourceBindingSchema.parse({
      id: b.id, connectedAccountId: b.connected_account_id, resourceKind: b.resource_kind,
      externalId: b.external_id, providerLabel: b.provider_label, boundTo: { kind: 'member', id: memberId },
    }) } };
  }
  /** A secret-free current snapshot, not a credential capability. Recheck at point of use. */
  async resolvePersonalResource(memberId: string, input: PersonalResourceSelection,
    resourceKind: string): Promise<ResolvedPersonalResource> {
    const expected = resourceSelectionSchema.parse(input), kind = text.parse(resourceKind);
    return this.transaction(memberId, async db => (await this.personalResource(db, memberId, expected, kind)).selection);
  }
  /** Server-only point of use. Active member, account generation/status, selected resource and
   * exact custody association remain locked through work. Trusted admission/grants/approvals must
   * be checked by the runtime caller; supplying a member ID or reference never authenticates it.
   * The callback DB is this same locked server transaction, for current authority checks.
   * Never return that client/credential material or hold this transaction for a user approval.
   */
  async withPersonalResourceCredential<T>(memberId: string, input: PersonalResourceSelection,
    resourceKind: string, work: (selection: ResolvedPersonalResource, credential: StoredAccountCredential, db: PoolClient) => Promise<T>): Promise<T> {
    const expected = resourceSelectionSchema.parse(input), kind = text.parse(resourceKind);
    return this.transaction(memberId, async db => {
      const { row, selection } = await this.personalResource(db, memberId, expected, kind);
      const credential = await readAccountCredential(db, { id: row.id, ownerMemberId: memberId,
        connectorId: row.connector_id, generation: row.generation });
      return work(selection, credential, db);
    });
  }
  async createCompanyAccount(): Promise<never> {
    throw new Error('Company accounts require account-manager and grant integration');
  }
  private async persistResources(db: PoolClient, account: Row,
    resources: readonly z.infer<typeof verifiedResourceSchema>[]): Promise<void> {
    // This table also preserves provenance. Refuse changed resource sets rather than leaving
    // an old resource selectable after consent, or deleting historical binding IDs.
    if (resources.length) {
      const current = await db.query<{resource_kind:string;external_id:string}>(`SELECT resource_kind,external_id
        FROM connected_resource_bindings WHERE connected_account_id=$1 FOR UPDATE`, [account.id]);
      const kinds = new Set(resources.map(resource => resource.resourceKind));
      if (current.rows.some(row => kinds.has(row.resource_kind) && !resources.some(resource =>
        resource.resourceKind === row.resource_kind && resource.externalId === row.external_id))) throw new AccountAccessError();
    }
    for (const resource of resources) await db.query(`INSERT INTO connected_resource_bindings
      (id,owner_member_id,connected_account_id,resource_kind,external_id,provider_label)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (connected_account_id,resource_kind,external_id)
      DO UPDATE SET provider_label=EXCLUDED.provider_label`,
      [randomUUID(), account.owner_member_id, account.id, resource.resourceKind, resource.externalId, resource.providerLabel]);
  }
  /** Trusted admission only. This object is not a model-facing binding API. */
  forTrustedAdapter(adapter: TrustedAccountAdapter) {
    const connectorId = text.parse(adapter.connectorId);
    const complete = async (memberId: string, input: AccountUpdate, evidence: unknown, replacement: boolean, credential?: OAuthCredentialCommit, resourceEvidence: readonly unknown[] = []) => {
      const persist = credential?.persist;
      const expected = updateSchema.parse(input);
      const evidenceSnapshot = [...resourceEvidence];
      // Do not start provider work for another member's account or an already-stale ticket.
      const before = await this.transaction(memberId, async db => {
        const r = await this.current(db, memberId, expected);
        if (r.connector_id !== connectorId) throw new AccountAccessError();
        return view(r);
      });
      const identity = verifiedAccountSchema.parse(await adapter.verifyAccount(evidence));
      const resources = await Promise.all(evidenceSnapshot.map(async value =>
        verifiedResourceSchema.parse(await adapter.verifyResource(before, value))));
      return this.transaction(memberId, async db => {
        const r = await this.current(db, memberId, expected);
        if (r.connector_id !== connectorId || (replacement ? sameIdentity(r, identity) : !sameIdentity(r, identity)))
          throw new AccountAccessError();
        if (replacement) {
          // Preserve the old identity and bindings for receipts/provenance. They are unusable
          // through the revoked account; explicit selection creates new binding IDs.
          await db.query(`UPDATE connected_accounts SET status='revoked', status_reason='account-replaced',
            generation=generation+1, lifecycle_revision=lifecycle_revision+1 WHERE id=$1`, [r.id]);
          const { rows } = await db.query<Row>(`INSERT INTO connected_accounts
            (id,owner_member_id,connector_id,provider_issuer,provider_subject,provider_tenant_id,provider_label,status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'ok') RETURNING *`,
            [randomUUID(), memberId, connectorId, identity.issuer, identity.subject, identity.tenantId ?? '', identity.label]);
          if (persist) await associateAccountCredential(db, { id: rows[0].id, ownerMemberId: memberId, connectorId, generation: rows[0].generation }, persist);
          await this.persistResources(db, rows[0], resources);
          return view(rows[0]);
        }
        const { rows } = await db.query<Row>(`UPDATE connected_accounts SET provider_issuer=$2,
          provider_subject=$3, provider_tenant_id=$4, provider_label=$5, status='ok', status_reason=NULL,
          generation=generation+$6, lifecycle_revision=lifecycle_revision+1 WHERE id=$1 RETURNING *`,
          [r.id, identity.issuer, identity.subject, identity.tenantId ?? '', identity.label, r.status !== 'ok' ? 1 : 0]);
        if (persist) await associateAccountCredential(db, { id: rows[0].id, ownerMemberId: memberId, connectorId, generation: rows[0].generation }, persist);
        await this.persistResources(db, rows[0], resources);
        return view(rows[0]);
      });
    };
    return {
      createPersonalAccount: async (memberId: string, evidence: unknown, credential?: OAuthCredentialCommit, resourceEvidence: readonly unknown[] = []): Promise<ConnectedAccountView> => {
        const persist = credential?.persist;
        const evidenceSnapshot = [...resourceEvidence];
        const id = randomUUID();
        await this.transaction(memberId, async () => undefined);
        const identity = verifiedAccountSchema.parse(await adapter.verifyAccount(evidence));
        const proposed = connectedAccountViewSchema.parse({ id, connectorId, owner: { kind: 'member', id: memberId },
          automationMode: 'draft-and-ask', providerAccount: identity, status: 'ok', statusReason: null, generation: 0, lastUsedAt: null });
        const resources = await Promise.all(evidenceSnapshot.map(async value =>
          verifiedResourceSchema.parse(await adapter.verifyResource(proposed, value))));
        return this.transaction(memberId, async db => {
          const { rows } = await db.query<Row>(`INSERT INTO connected_accounts
            (id,owner_member_id,connector_id,provider_issuer,provider_subject,provider_tenant_id,provider_label,status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'ok') RETURNING *`,
            [id, memberId, connectorId, identity.issuer, identity.subject, identity.tenantId ?? '', identity.label]);
          if (persist) await associateAccountCredential(db, { id: rows[0].id, ownerMemberId: memberId, connectorId, generation: rows[0].generation }, persist);
          await this.persistResources(db, rows[0], resources);
          return view(rows[0]);
        });
      },
      renew: (memberId: string, expected: AccountUpdate, evidence: unknown, credential?: OAuthCredentialCommit, resourceEvidence: readonly unknown[] = []) => complete(memberId, expected, evidence, false, credential, resourceEvidence),
      replace: (memberId: string, expected: AccountUpdate, evidence: unknown, review: { reviewedReplacement: true }, credential?: OAuthCredentialCommit) => {
        z.strictObject({ reviewedReplacement: z.literal(true) }).parse(review);
        return complete(memberId, expected, evidence, true, credential);
      },
      bindResource: async (memberId: string, input: AccountUpdate, evidence: unknown): Promise<ResourceBinding> => {
        const expected = updateSchema.parse(input);
        const account = await this.transaction(memberId, async db => {
          const r = await this.current(db, memberId, expected);
          if (r.status !== 'ok' || r.connector_id !== connectorId) throw new AccountAccessError();
          return view(r);
        });
        const resource = verifiedResourceSchema.parse(await adapter.verifyResource(account, evidence));
        return this.transaction(memberId, async db => {
          const r = await this.current(db, memberId, expected);
          if (r.status !== 'ok') throw new AccountAccessError();
          const { rows } = await db.query(`INSERT INTO connected_resource_bindings
            (id,owner_member_id,connected_account_id,resource_kind,external_id,provider_label)
            VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (connected_account_id,resource_kind,external_id)
            DO UPDATE SET provider_label=EXCLUDED.provider_label RETURNING *`,
            [randomUUID(), memberId, r.id, resource.resourceKind, resource.externalId, resource.providerLabel]);
          return resourceBindingSchema.parse({ id: rows[0].id, connectedAccountId: r.id, ...resource,
            boundTo: { kind: 'member', id: memberId } });
        });
      },
    };
  }
}
