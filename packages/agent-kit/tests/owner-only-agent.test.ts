import { describe, expect, it } from "vitest";
import { OWNER_ONLY_AGENT_CONDITION, ownerJobsMayRun, ownerOnlyAgentStatement } from "../src/owner-only-agent.js";

// The statement the owner-job path ran before the condition moved into its own module, byte for
// byte. The payment path must keep executing exactly this; the console's read is the same text
// without the row lock.
const PAYMENT_PATH_STATEMENT = `SELECT 1 FROM agent_access a WHERE a.agent_name=$2 AND a.owner_member_id=$1
    AND NOT EXISTS(SELECT 1 FROM resource_grants g WHERE g.resource_kind='agent' AND g.resource_id=a.agent_name
      AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
      AND ((g.principal_member_id IS NOT NULL AND g.principal_member_id<>$1)
        OR (g.principal_organisation_id IS NOT NULL AND EXISTS(SELECT 1 FROM users u
          WHERE u.org_id=g.principal_organisation_id AND u.id<>$1 AND u.status='active' AND u.org_role<>'restricted'))))
    FOR SHARE OF a`;

describe("the one definition of 'this agent is the owner's alone'", () => {
  it("the payment path's locking statement is unchanged, byte for byte", () => {
    expect(ownerOnlyAgentStatement("share")).toBe(PAYMENT_PATH_STATEMENT);
  });

  it("the read-only form is the same condition without the lock", () => {
    const plain = ownerOnlyAgentStatement("none");
    expect(plain).toBe(`SELECT 1 FROM agent_access a WHERE ${OWNER_ONLY_AGENT_CONDITION}`);
    expect(PAYMENT_PATH_STATEMENT).toBe(`${plain}\n    FOR SHARE OF a`);
    expect(plain).not.toMatch(/FOR SHARE|FOR UPDATE/);
  });

  it("the payment path imports the shared statement and has no copy of its own", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../src/budget-model-authority.ts", import.meta.url), "utf8");
    expect(source).toContain("ownerOnlyAgentStatement('share')");
    expect(source).not.toContain("FROM resource_grants g WHERE g.resource_kind='agent'");
  });

  it("answers true only for exactly one row, with the owner and agent as $1 and $2", async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const db = (rows: unknown[]) => ({ query: async (sql: string, values?: unknown[]) => { calls.push({ sql, values }); return { rows }; } });
    expect(await ownerJobsMayRun(db([{ "?column?": 1 }]), "owner-1", "chief")).toBe(true);
    expect(await ownerJobsMayRun(db([]), "owner-1", "chief")).toBe(false);
    expect(calls[0]).toEqual({ sql: ownerOnlyAgentStatement("none"), values: ["owner-1", "chief"] });
  });
});
