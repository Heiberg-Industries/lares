/**
 * "This agent is the owner's alone": the ONE text of the condition an owner job needs.
 *
 * The owner pays for an owner job (a scheduled brief, a call outside any conversation), so the
 * agent must be the owner's own and reach nobody else. Any current grant on it, to use or to edit,
 * held by another member, or by an organisation with another active member who is not restricted,
 * fails it. A missing agent row fails it too.
 *
 * Two readers, one text:
 *  - the payment path (`budget-model-authority.ts`) runs the LOCKING statement inside its own
 *    financial transaction, and refuses the job when it finds no row. That refusal is the guard;
 *  - the console asks the plain read-only question before it offers to send a test brief, so the
 *    owner gets a sentence instead of an error in the chat. Its answer is a courtesy and is never
 *    treated as permission anywhere.
 *
 * No imports, on purpose: the console reads this without pulling in the financial machinery.
 */

/** The condition itself, over `agent_access a`, with `$1` the owner's member id and `$2` the agent. */
export const OWNER_ONLY_AGENT_CONDITION = `a.agent_name=$2 AND a.owner_member_id=$1
    AND NOT EXISTS(SELECT 1 FROM resource_grants g WHERE g.resource_kind='agent' AND g.resource_id=a.agent_name
      AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
      AND ((g.principal_member_id IS NOT NULL AND g.principal_member_id<>$1)
        OR (g.principal_organisation_id IS NOT NULL AND EXISTS(SELECT 1 FROM users u
          WHERE u.org_id=g.principal_organisation_id AND u.id<>$1 AND u.status='active' AND u.org_role<>'restricted'))))`;

/** The statement over that condition. `share` adds the payment path's row lock on the agent row. */
export function ownerOnlyAgentStatement(lock: 'share' | 'none'): string {
  return `SELECT 1 FROM agent_access a WHERE ${OWNER_ONLY_AGENT_CONDITION}${lock === 'share' ? `
    FOR SHARE OF a` : ''}`;
}

/** The read-only question: may owner jobs run for this agent right now? Takes no lock. */
export async function ownerJobsMayRun(
  db: { query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  ownerId: string,
  agentName: string,
): Promise<boolean> {
  const { rows } = await db.query(ownerOnlyAgentStatement('none'), [ownerId, agentName]);
  return rows.length === 1;
}
