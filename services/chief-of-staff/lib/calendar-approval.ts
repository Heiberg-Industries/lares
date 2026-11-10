import { payloadFingerprint } from '@lares/agent-kit/approval-ledger';
import type { ExactApprovalAdapter, ExactApprovalTarget } from '@lares/agent-kit/approval-execution';
import type { AuthorityDatabase } from '@lares/agent-kit/console-turn-authority';
import { autonomyOf, grantFor, scopeAtLeast } from '@lares/agent-kit/manifest';
import { parseDefinition } from '@lares/agent-kit/definition';
import { checkAgentMailboxOn } from '@lares/agent-kit/agent-mailbox-store';
import { managedIdentity } from '@lares/agent-kit/door-authority';

const CALENDAR_TOOLS = ['calendar_create_event', 'calendar_update_event', 'calendar_delete_event'] as const;
const unavailable = () => new Error('Exact calendar target is unavailable');

/** The agent's ready, valid, applied definition, read under a share lock. */
async function appliedDefinition(db: AuthorityDatabase, agent: string, incarnation: string) {
  const { rows } = await db.query(`SELECT r.applied_definition,a.hash FROM agent_resources r JOIN agent_definitions a ON a.name=r.name
    WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token AND r.state='ready'
    AND NOT r.pending AND a.status='valid' AND r.applied_definition IS NOT NULL FOR SHARE OF r,a`, [agent, incarnation]);
  if (rows.length !== 1) throw new Error('Exact calendar policy is unavailable');
  return { definition: parseDefinition(rows[0].applied_definition), hash: rows[0].hash as string };
}

/**
 * Exact private-Console authorization for event changes on the chosen mailbox's calendar.
 *
 * Reads the database only, never Google: who owns the agent now, which mailbox the owner chose
 * (account, generation, revision) and that mailbox's address. The target fingerprint covers the
 * exact call and that whole choice, so an owner who switches mailbox, reconnects the account or
 * hands the agent over between the card and Approve invalidates the card.
 */
export const calendarApprovalAdapter: ExactApprovalAdapter = {
  toolNames: CALENDAR_TOOLS,
  async readPolicyHash(db: AuthorityDatabase, agent: string, incarnation: string) {
    const { definition, hash } = await appliedDefinition(db, agent, incarnation);
    if (!scopeAtLeast(grantFor(definition, 'calendar')?.scope ?? 'none', 'write-with-confirm') || autonomyOf(definition, 'calendar') === 'never')
      throw new Error('Exact calendar policy is unavailable');
    const { rows: board } = await db.query("SELECT level,updated_at::text AS updated_at FROM ratchet WHERE agent=$1 AND capability='calendar' AND action='' FOR SHARE", [agent]);
    const level = board[0]?.level ?? autonomyOf(definition, 'calendar');
    if (!['gated', 'autonomous'].includes(level)) throw new Error('Exact calendar policy is unavailable');
    return payloadFingerprint('calendar-write-policy-v1', { definition, hash, board: board[0] ?? null, level });
  },
  async readTarget(db, input, memberId, tool, _ctx, reservedTarget) {
    if (!tool || !CALENDAR_TOOLS.includes(tool as typeof CALENDAR_TOOLS[number]) || !input || typeof input !== 'object' || Array.isArray(input)) throw unavailable();
    const raw = input as Record<string, unknown>;
    const own = managedIdentity(process.env);
    if (!own) throw unavailable();
    // Only the agent's owner as of now, checked before anything else is read.
    const owner = (await db.query(`SELECT x.owner_member_id FROM agent_resources r JOIN agent_definitions d ON d.name=r.name
      JOIN agent_access x ON x.agent_name=r.name WHERE r.name=$1 AND r.ownership_token=$2::uuid
      AND r.runtime_control_token=r.ownership_token AND NOT r.pending AND r.state='ready' AND d.status='valid' FOR SHARE OF x`,
      [own.name, own.incarnation])).rows[0]?.owner_member_id;
    if (typeof owner !== 'string' || owner !== memberId) throw unavailable();
    const { definition } = await appliedDefinition(db, own.name, own.incarnation);
    const chosen = await checkAgentMailboxOn(db, own.name, definition);
    if (!chosen.ok || chosen.binding.ownerMemberId !== memberId) throw unavailable();
    const b = chosen.binding;
    const mailbox = (await db.query(`SELECT t.email_address FROM connected_account_credentials cc
      JOIN oauth_tokens t ON t.id=cc.oauth_token_id AND t.principal=cc.owner_member_id AND t.provider=cc.connector_id
      WHERE cc.account_id=$1 AND cc.owner_member_id=$2 AND cc.account_generation=$3`,
      [b.accountId, b.ownerMemberId, b.accountGeneration])).rows[0]?.email_address;
    if (typeof mailbox !== 'string' || mailbox === '') throw unavailable();
    // The tool works on the chosen mailbox only; a named account must be that exact address.
    if (raw.account !== undefined && raw.account !== mailbox) throw unavailable();
    const eventId = raw.eventId;
    if (tool !== 'calendar_create_event' && (typeof eventId !== 'string' || eventId === '')) throw unavailable();
    const calendarId = typeof raw.calendarId === 'string' && raw.calendarId !== '' ? raw.calendarId : 'primary';
    const target: ExactApprovalTarget = { kind: 'calendar-event', id: `calendar:${b.accountId}:${calendarId}:${typeof eventId === 'string' ? eventId : 'new'}`,
      ownerMemberId: memberId, fingerprint: payloadFingerprint('calendar-target-v1',
        { tool, input, accountId: b.accountId, resourceBindingId: b.resourceBindingId, accountGeneration: b.accountGeneration, revision: b.revision }) };
    if (reservedTarget && payloadFingerprint('authority', target) !== payloadFingerprint('authority', reservedTarget))
      throw new Error('Exact calendar target changed');
    return target;
  },
};
