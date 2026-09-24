import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { enrolFirstOrganisation } from "../lib/first-organisation.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  for (const name of ["014_identity.sql", "028_orgs.sql", "029_cross_member.sql", "032_org_domains.sql"]) {
    await pool.query(readFileSync(new URL(`../sql/${name}`, import.meta.url), "utf8"));
  }
  await pool.query(
    "INSERT INTO users (id, display_name, primary_email) VALUES ('owner', 'Owner', 'owner@example.invalid')",
  );
}, 180_000);
afterAll(async () => { await pool?.end(); await container?.stop(); });

const input = { ownerId: "owner", ownerEmail: "owner@example.invalid", domain: "home.example.invalid" };

it("enrols one fresh owner and preserves the organisation on repair", async () => {
  expect(await enrolFirstOrganisation(pool, input)).toBe("created");
  expect((await pool.query("SELECT id, display_name, domains FROM orgs")).rows).toEqual([
    { id: input.domain, display_name: input.domain, domains: [] },
  ]);
  expect((await pool.query("SELECT org_id, org_role FROM users WHERE id='owner'")).rows).toEqual([
    { org_id: input.domain, org_role: "owner" },
  ]);
  expect((await pool.query("SELECT user_id, may_create_agents FROM org_member_policy")).rows).toEqual([
    { user_id: "owner", may_create_agents: true },
  ]);

  await pool.query("UPDATE orgs SET display_name = 'Our Home' WHERE id = $1", [input.domain]);
  expect(await enrolFirstOrganisation(pool, input)).toBe("already");
  expect((await pool.query("SELECT display_name FROM orgs")).rows[0]?.display_name).toBe("Our Home");
});

it("refuses changed identity and organisation without changing records", async () => {
  await expect(enrolFirstOrganisation(pool, { ...input, ownerEmail: "someone@example.invalid" }))
    .rejects.toThrow(/does not match/);
  await expect(enrolFirstOrganisation(pool, { ...input, domain: "other.example.invalid" }))
    .rejects.toThrow(/differs/);
  expect((await pool.query("SELECT count(*)::int AS n FROM orgs")).rows[0]?.n).toBe(1);
});

it("refuses partial or unrelated organisation state without creating another one", async () => {
  await pool.query("UPDATE users SET org_id = NULL, org_role = 'member' WHERE id = 'owner'");
  await expect(enrolFirstOrganisation(pool, input)).rejects.toThrow(/manual review/);
  expect((await pool.query("SELECT org_id FROM users WHERE id='owner'")).rows[0]?.org_id).toBeNull();
});
