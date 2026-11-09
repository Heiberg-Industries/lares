/** Which of its owner's connected Google mailboxes an agent works on (read, triage, drafts).
 * The row names the account and the generation it was chosen at; it holds no credential, and
 * nothing here reads or returns credential material (only the stored consent scope list).
 * Only the agent's current owner may choose, and only one of their own accounts.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AccountAccessError, PgAccountStore } from './account-store.js';
import { autonomyOf, grantFor } from './manifest.js';
import type { AgentDefinition } from './definition.js';
import { validateGooglePersonalScopes } from './personal-consent.js';

const PURPOSE = 'mailbox';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const selectionSchema = z.strictObject({ accountId: z.string().trim().min(1), resourceBindingId: z.string().trim().min(1) });

/** Why a stored choice can no longer be used. Closed and stable: the runtime refuses on any of
 * them and the console turns each into one sentence. Add to the end only. */
export const AGENT_MAILBOX_REASONS = ['none', 'member-inactive', 'account-not-ok', 'generation-changed',
  'owner-changed', 'scopes-not-draft', 'not-granted'] as const;
export type AgentMailboxReason = typeof AGENT_MAILBOX_REASONS[number];
/** Why `set` or `clear` refused: the reasons above that can apply, plus two that only apply when choosing. */
export const AGENT_MAILBOX_REFUSALS = ['not-owner', 'account-unavailable', 'not-granted', 'scopes-not-draft'] as const;
export type AgentMailboxRefusal = typeof AGENT_MAILBOX_REFUSALS[number];
export class AgentMailboxRefused extends Error {
  constructor(readonly reason: AgentMailboxRefusal) { super(`Mailbox choice refused: ${reason}`); }
}

export interface AgentMailboxBinding {
  agent: string; ownerMemberId: string; accountId: string; resourceBindingId: string;
  accountGeneration: number; revision: string; setAt: string; accountLabel: string;
}
export type AgentMailboxCheck = { ok: true; binding: AgentMailboxBinding } | { ok: false; reason: AgentMailboxReason };
/** The owner's view: the stored choice (when there is one) and whether it still works. */
export type AgentMailboxView = { binding?: AgentMailboxBinding; reason?: Exclude<AgentMailboxReason, 'not-granted'> };

/** Whether this definition lets the agent use a personal Google mailbox. Same rule as the keeper's
 * decision to mount the personal Google files (a chief of staff holding a gmail grant above `none`
 * that its autonomy has not set to `never`). */
export function agentMayUsePersonalMailbox(definition: AgentDefinition): boolean {
  if (definition.role !== 'chief-of-staff') return false;
  const grant = grantFor(definition, 'gmail');
  return !!grant && grant.scope !== 'none' && autonomyOf(definition, 'gmail') !== 'never';
}

interface JoinedRow {
  agent: string; binding_owner: string; account_id: string; resource_binding_id: string; account_generation: number;
  revision: string; set_at: Date; access_owner: string; member_status: string; member_org: string | null;
  account_status: string; generation: number; connector_id: string; issuer: string; label: string;
  resource_kind: string; resource_external_id: string; subject: string; scopes: string[] | null;
}

const JOINED = `SELECT b.agent, b.owner_member_id AS binding_owner, b.connected_account_id AS account_id, b.resource_binding_id,
    b.account_generation, b.revision, b.set_at, a.owner_member_id AS access_owner, u.status AS member_status, u.org_id AS member_org,
    c.status AS account_status, c.generation, c.connector_id, c.provider_issuer AS issuer, c.provider_label AS label,
    c.provider_subject AS subject, r.resource_kind, r.external_id AS resource_external_id,
    (SELECT t.scopes FROM connected_account_credentials cc
       JOIN oauth_tokens t ON t.id=cc.oauth_token_id AND t.principal=cc.owner_member_id AND t.provider=cc.connector_id
      WHERE cc.account_id=c.id AND cc.owner_member_id=c.owner_member_id AND cc.account_generation=c.generation) AS scopes
  FROM agent_account_bindings b
  JOIN agent_access a ON a.agent_name=b.agent
  JOIN users u ON u.id=b.owner_member_id
  JOIN connected_accounts c ON c.id=b.connected_account_id AND c.owner_member_id=b.owner_member_id
  JOIN connected_resource_bindings r ON r.id=b.resource_binding_id
  WHERE b.agent=$1 AND b.purpose='${PURPOSE}'`;

function bindingOf(r: JoinedRow): AgentMailboxBinding {
  return { agent: r.agent, ownerMemberId: r.binding_owner, accountId: r.account_id, resourceBindingId: r.resource_binding_id,
    accountGeneration: r.account_generation, revision: r.revision, setAt: r.set_at.toISOString(), accountLabel: r.label };
}
function draftCapable(scopes: string[] | null): boolean {
  if (!scopes) return false;
  try { validateGooglePersonalScopes(scopes, 'read+mail-draft'); return true; } catch { return false; }
}
/** The first reason, in a fixed order, that the stored choice cannot be used; undefined when it can. */
function problem(r: JoinedRow, granted: boolean | undefined): AgentMailboxReason | undefined {
  if (r.access_owner !== r.binding_owner) return 'owner-changed';
  if (r.member_status !== 'active' || r.member_org === null) return 'member-inactive';
  if (granted === false) return 'not-granted';
  if (r.account_status !== 'ok' || r.connector_id !== 'google' || r.issuer !== GOOGLE_ISSUER ||
    r.resource_kind !== 'mailbox' || r.resource_external_id !== r.subject || r.scopes === null) return 'account-not-ok';
  if (r.generation !== r.account_generation) return 'generation-changed';
  if (!draftCapable(r.scopes)) return 'scopes-not-draft';
  return undefined;
}

export class PgAgentMailboxStore {
  private readonly accounts: PgAccountStore;
  constructor(private readonly pool: Pool) { this.accounts = new PgAccountStore(pool); }

  /** The owner chooses one of their own Google accounts for the agent's mailbox. */
  async set(memberId: string, agent: string, selection: { accountId: string; resourceBindingId: string },
    definition: AgentDefinition): Promise<AgentMailboxBinding> {
    const chosen = selectionSchema.parse(selection);
    return this.accounts.transaction(memberId, async db => {
      await this.requireOwner(db, memberId, agent);
      if (!agentMayUsePersonalMailbox(definition)) throw new AgentMailboxRefused('not-granted');
      const generation = (await db.query<{ generation: number }>(
        'SELECT generation FROM connected_accounts WHERE id=$1 AND owner_member_id=$2', [chosen.accountId, memberId])).rows[0]?.generation;
      if (generation === undefined) throw new AgentMailboxRefused('account-unavailable');
      let resolved;
      try {
        resolved = await this.accounts.personalResource(db, memberId,
          { accountId: chosen.accountId, generation, resourceBindingId: chosen.resourceBindingId }, PURPOSE);
      } catch (e) {
        if (e instanceof AccountAccessError) throw new AgentMailboxRefused('account-unavailable');
        throw e;
      }
      const { account, resource } = resolved.selection;
      if (account.connectorId !== 'google' || account.providerAccount.issuer !== GOOGLE_ISSUER ||
        resource.externalId !== account.providerAccount.subject) throw new AgentMailboxRefused('account-unavailable');
      const scopes = (await db.query<{ scopes: string[] }>(
        `SELECT t.scopes FROM connected_account_credentials cc
           JOIN oauth_tokens t ON t.id=cc.oauth_token_id AND t.principal=cc.owner_member_id AND t.provider=cc.connector_id
          WHERE cc.account_id=$1 AND cc.owner_member_id=$2 AND cc.account_generation=$3`,
        [chosen.accountId, memberId, generation])).rows[0]?.scopes;
      if (!scopes) throw new AgentMailboxRefused('account-unavailable');
      if (!draftCapable(scopes)) throw new AgentMailboxRefused('scopes-not-draft');
      await db.query(`INSERT INTO agent_account_bindings
          (agent,purpose,owner_member_id,connected_account_id,resource_binding_id,account_generation,revision)
        VALUES ($1,'${PURPOSE}',$2,$3,$4,$5,$6)
        ON CONFLICT (agent,purpose) DO UPDATE SET owner_member_id=EXCLUDED.owner_member_id,
          connected_account_id=EXCLUDED.connected_account_id, resource_binding_id=EXCLUDED.resource_binding_id,
          account_generation=EXCLUDED.account_generation, revision=EXCLUDED.revision, set_at=clock_timestamp()`,
        [agent, memberId, chosen.accountId, chosen.resourceBindingId, generation, randomUUID()]);
      const row = (await db.query<JoinedRow>(JOINED, [agent])).rows[0];
      if (!row) throw new AgentMailboxRefused('account-unavailable');
      return bindingOf(row);
    });
  }

  /** Remove the agent's mailbox choice. Only the agent's owner may. */
  async clear(memberId: string, agent: string): Promise<void> {
    await this.accounts.transaction(memberId, async db => {
      await this.requireOwner(db, memberId, agent);
      await db.query(`DELETE FROM agent_account_bindings WHERE agent=$1 AND purpose='${PURPOSE}'`, [agent]);
    });
  }

  /** The owner's view of the stored choice and whether it still works. No credentials. */
  async get(memberId: string, agent: string): Promise<AgentMailboxView> {
    return this.accounts.transaction(memberId, async db => {
      await this.requireOwner(db, memberId, agent);
      const row = (await db.query<JoinedRow>(JOINED, [agent])).rows[0];
      if (!row) return { reason: 'none' };
      return { binding: bindingOf(row), ...(problem(row, undefined) ? { reason: problem(row, undefined) as AgentMailboxView['reason'] } : {}) };
    });
  }

  /** Is the stored choice usable right now? One read-only statement: no lock is held after it,
   * so the caller repeats it before each draft. Never touches credential material. */
  async check(agent: string, definition: AgentDefinition): Promise<AgentMailboxCheck> {
    const row = (await this.pool.query<JoinedRow>(JOINED, [agent])).rows[0];
    if (!row) return { ok: false, reason: 'none' };
    const reason = problem(row, agentMayUsePersonalMailbox(definition));
    return reason ? { ok: false, reason } : { ok: true, binding: bindingOf(row) };
  }

  private async requireOwner(db: PoolClient, memberId: string, agent: string): Promise<void> {
    const owner = (await db.query<{ owner_member_id: string }>(
      'SELECT owner_member_id FROM agent_access WHERE agent_name=$1 FOR SHARE', [agent])).rows[0]?.owner_member_id;
    if (owner !== memberId) throw new AgentMailboxRefused('not-owner');
  }
}
