import type { TransactionPool } from "./installation-settings.js";

interface OwnerRow {
  id: string;
  primary_email: string | null;
  org_id: string | null;
  org_role: string;
}

/** Enrol only an empty, single-owner installation. Never adopt or rewrite an existing org. */
export async function enrolFirstOrganisation(
  db: TransactionPool,
  input: { ownerId: string; ownerEmail: string; domain: string },
): Promise<"created" | "already"> {
  const { ownerId, ownerEmail, domain } = input;
  if (!ownerId.trim() || !ownerEmail.trim() || !/^[a-z0-9.-]+$/.test(domain) || !domain.includes(".")) {
    throw new Error("first organisation: owner id, email or domain is invalid");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Serialise two installer invocations without locking unrelated installation work.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('lares-first-organisation'))");
    const { rows: owners } = await client.query<OwnerRow>(
      "SELECT id, primary_email, org_id, org_role FROM users WHERE id = $1 FOR UPDATE",
      [ownerId],
    );
    const owner = owners[0];
    if (!owner || owner.primary_email !== ownerEmail) {
      throw new Error("first organisation: the configured owner does not match the identity register");
    }

    if (owner.org_id !== null) {
      const { rows: orgs } = await client.query<{ id: string }>("SELECT id FROM orgs WHERE id = $1", [owner.org_id]);
      const { rows: policies } = await client.query<{ user_id: string }>(
        "SELECT user_id FROM org_member_policy WHERE user_id = $1", [ownerId],
      );
      if (owner.org_id !== domain || owner.org_role !== "owner" || orgs.length !== 1 || policies.length !== 1) {
        throw new Error("first organisation: existing membership differs from this installation; review it by hand");
      }
      await client.query("COMMIT");
      return "already";
    }

    const { rows: counts } = await client.query<{ users: number; orgs: number; policies: number }>(
      `SELECT (SELECT count(*)::int FROM users) AS users,
              (SELECT count(*)::int FROM orgs) AS orgs,
              (SELECT count(*)::int FROM org_member_policy) AS policies`,
    );
    const countsRow = counts[0];
    if (countsRow?.users !== 1 || countsRow.orgs !== 0 || countsRow.policies !== 0) {
      throw new Error("first organisation: existing people, organisations or policies need manual review");
    }

    await client.query("INSERT INTO orgs (id, display_name) VALUES ($1, $2)", [domain, domain]);
    await client.query("UPDATE users SET org_id = $1, org_role = 'owner' WHERE id = $2", [domain, ownerId]);
    await client.query("INSERT INTO org_member_policy (user_id) VALUES ($1)", [ownerId]);
    await client.query("COMMIT");
    return "created";
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original refusal. */ }
    throw error;
  } finally {
    client.release();
  }
}
