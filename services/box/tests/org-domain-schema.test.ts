import { beforeAll, afterAll, it, expect } from "vitest";
import { startTestDb, type TestDb } from "./helpers/pg.js";
let db: TestDb;
beforeAll(async () => { db = await startTestDb(); }, 180_000);
afterAll(async () => { await db?.stop(); });

it("the baseline seeds no identity, organisation or policy: installation data is added, never shipped", async () => {
  for (const table of ["users", "user_aliases", "orgs", "org_member_policy"]) {
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
  }
});

it("an organisation has no assumed domains and keeps the configured ones", async () => {
  await db.pool.query("INSERT INTO orgs (id, display_name) VALUES ('example', 'Example Org')");
  expect((await db.pool.query("SELECT domains FROM orgs WHERE id = 'example'")).rows[0].domains).toEqual([]);
  await db.pool.query("UPDATE orgs SET domains = ARRAY['example.org'] WHERE id = 'example'");
  expect((await db.pool.query("SELECT domains FROM orgs WHERE id = 'example'")).rows[0].domains).toEqual(['example.org']);
});

it("a reminder has no default owner and rejects unowned writes", async () => {
  await db.pool.query(`INSERT INTO reminders (agent, owner, due_at, payload, created_by)
    VALUES ('fixture', 'existing-owner', now(), '{}', 'fixture')`);
  await expect(db.pool.query(`INSERT INTO reminders (agent, due_at, payload, created_by)
    VALUES ('fixture', now(), '{}', 'fixture')`)).rejects.toMatchObject({ code: '23502', column: 'owner' });
  await db.pool.query(`INSERT INTO reminders (agent, owner, due_at, payload, created_by)
    VALUES ('fixture', 'explicit-owner', now(), '{}', 'fixture')`);
});
