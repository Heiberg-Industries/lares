import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrossMemberDeniedError, hasStandingGrant, readWithGrant, recordCrossMemberRead } from "../src/cross-member.js";

describe("cross-member grants — tier 2 of the access model", () => {
  let pool: Pool;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const c = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: c.getConnectionUri() });
    stop = async () => { await pool.end(); await c.stop(); };
    await pool.query(`
      CREATE TABLE users (id text PRIMARY KEY);
      INSERT INTO users VALUES ('bendik'), ('stefan');
      CREATE TABLE cross_member_grants (id bigserial PRIMARY KEY, grantor_user_id text NOT NULL REFERENCES users(id),
        capability text NOT NULL, granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
      CREATE TABLE cross_member_reads (id bigserial PRIMARY KEY, grantor_user_id text NOT NULL, capability text NOT NULL,
        requested_by_user_id text NOT NULL, agent text NOT NULL, read_at timestamptz NOT NULL DEFAULT now());
    `);
  }, 120_000);

  afterAll(async () => { await stop(); });

  it("no grant → denied, and NO read happens", async () => {
    let invoked = false;
    await expect(
      readWithGrant(pool, { grantorUserId: "stefan", capability: "calendar", requestedByUserId: "bendik", agent: "saga" }, async () => { invoked = true; return "contents"; }),
    ).rejects.toBeInstanceOf(CrossMemberDeniedError);
    expect(invoked).toBe(false);
  });

  it("a standing grant admits the read and lands the audit row first", async () => {
    await pool.query(`INSERT INTO cross_member_grants (grantor_user_id, capability) VALUES ('stefan', 'calendar')`);
    const result = await readWithGrant(pool, { grantorUserId: "stefan", capability: "calendar", requestedByUserId: "bendik", agent: "saga" }, async () => "contents");
    expect(result).toBe("contents");
    const { rows } = await pool.query(`SELECT * FROM cross_member_reads WHERE grantor_user_id = 'stefan'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].requested_by_user_id).toBe("bendik");
  });

  it("a revoked grant no longer admits", async () => {
    await pool.query(`UPDATE cross_member_grants SET revoked_at = now() WHERE grantor_user_id = 'stefan'`);
    expect(await hasStandingGrant(pool, "stefan", "calendar")).toBe(false);
  });

  it("audit lands BEFORE the read — even if the read throws, the audit row exists", async () => {
    // Fresh grant to avoid collision with earlier tests' rows
    await pool.query(`INSERT INTO cross_member_grants (grantor_user_id, capability) VALUES ('stefan', 'email')`);

    const readError = new Error("read exploded");
    await expect(
      readWithGrant(pool, { grantorUserId: "stefan", capability: "email", requestedByUserId: "bendik", agent: "saga" }, async () => { throw readError; }),
    ).rejects.toThrow("read exploded");

    // Audit row must exist, proving it was written before the read was invoked
    const { rows } = await pool.query(`SELECT * FROM cross_member_reads WHERE grantor_user_id = 'stefan' AND capability = 'email'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].requested_by_user_id).toBe("bendik");
  });
});
