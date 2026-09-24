import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityUnavailableError, resolveUser } from "../src/identity.js";

describe("resolveUser — channel address to canonical org member", () => {
  let pool: Pool;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    stop = async () => { await pool.end(); await container.stop(); };
    // Minimal live shape: 014 + 028, seeded like the box.
    await pool.query(`
      CREATE TABLE orgs (id text PRIMARY KEY, display_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE users (id text PRIMARY KEY, display_name text NOT NULL, primary_email text,
        created_at timestamptz NOT NULL DEFAULT now(), org_id text REFERENCES orgs(id),
        org_role text NOT NULL DEFAULT 'member' CHECK (org_role IN ('owner','member','restricted')));
      CREATE TABLE user_aliases (system text NOT NULL, alias text NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (system, alias));
      INSERT INTO orgs (id, display_name) VALUES ('heiberg', 'Heiberg Industries');
      INSERT INTO users (id, display_name, org_id, org_role) VALUES ('bendik', 'Bendik Heiberg', 'heiberg', 'owner');
      INSERT INTO user_aliases (system, alias, user_id) VALUES ('slack', 'U_EXAMPLE_OWNER', 'bendik');
    `);
  }, 120_000);

  afterAll(async () => { await stop(); });

  it("resolves a known alias to the canonical member", async () => {
    const u = await resolveUser(pool, "slack", "U_EXAMPLE_OWNER");
    expect(u).toEqual({ id: "bendik", orgId: "heiberg", orgRole: "owner", displayName: "Bendik Heiberg" });
  });

  it("returns undefined for an unknown alias — the caller owns the posture", async () => {
    expect(await resolveUser(pool, "slack", "U_NOBODY")).toBeUndefined();
  });

  it("throws IdentityUnavailableError when the query fails — infra failure must never read as stranger", async () => {
    const dead = new Pool({ connectionString: "postgresql://nobody:nope@127.0.0.1:1/none", connectionTimeoutMillis: 300 });
    await expect(resolveUser(dead, "slack", "U_EXAMPLE_OWNER")).rejects.toBeInstanceOf(IdentityUnavailableError);
    await dead.end();
  });
});
