//
// FORWARD identity resolution: a channel-native address (a Slack user id, a Telegram numeric
// id, an email) to the canonical org member behind it, via the box's user_aliases registry
// (014_identity.sql) and org membership (028_orgs.sql). The REVERSE direction (canonical id →
// aliases) lives in eve-saga's identity-client and is a different consumer's concern.
//
// Posture: unknown alias → undefined (the caller decides — a scope filter fails closed, a
// greeter says hello); registry unreachable → IdentityUnavailableError, NEVER undefined. An
// infra failure that reads as "stranger" would silently deny a member their own private notes
// — or worse, silently hand a stranger the unscoped legacy path.
import type { Pool } from "pg";

export type OrgRole = "owner" | "member" | "restricted";

export interface ResolvedUser {
  id: string;
  orgId: string;
  orgRole: OrgRole;
  displayName: string;
}

export class IdentityUnavailableError extends Error {
  constructor(cause: unknown) {
    super("identity registry is unreachable; refusing to guess who is asking");
    this.name = "IdentityUnavailableError";
    this.cause = cause;
  }
}

export async function resolveUser(db: Pool, system: string, alias: string): Promise<ResolvedUser | undefined> {
  let rows: Array<{ id: string; org_id: string | null; org_role: OrgRole; display_name: string }>;
  try {
    ({ rows } = await db.query(
      `SELECT u.id, u.org_id, u.org_role, u.display_name
         FROM user_aliases a JOIN users u ON u.id = a.user_id
        WHERE a.system = $1 AND a.alias = $2`,
      [system, alias],
    ));
  } catch (err) {
    throw new IdentityUnavailableError(err);
  }
  const row = rows[0];
  if (row === undefined) return undefined;
  // org_id is NULL only in the window before 028 is applied; treat that as unavailable, not
  // as a memberless user — the single-org invariant means every user has exactly one org.
  if (row.org_id === null) throw new IdentityUnavailableError(new Error(`user ${row.id} has no org_id — is 028_orgs.sql applied?`));
  return { id: row.id, orgId: row.org_id, orgRole: row.org_role, displayName: row.display_name };
}
