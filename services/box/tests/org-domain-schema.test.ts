import { beforeAll, afterAll, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startTestDb, type TestDb } from "./helpers/pg.js";
let db: TestDb;
const sql = readFileSync(resolve(import.meta.dirname, "../sql/032_org_domains.sql"), "utf8");
beforeAll(async () => { db = await startTestDb(); }, 180_000);
afterAll(async () => { await db?.stop(); });
it("creates no assumed domains and preserves configured domains when repeated", async () => {
  await db.pool.query("CREATE TABLE orgs (id text PRIMARY KEY, display_name text NOT NULL); INSERT INTO orgs VALUES ('example', 'Example Org');");
  await db.pool.query(sql);
  expect((await db.pool.query("SELECT domains FROM orgs WHERE id = 'example'")).rows[0].domains).toEqual([]);
  await db.pool.query("UPDATE orgs SET domains = ARRAY['example.org'] WHERE id = 'example'");
  await db.pool.query(sql);
  expect((await db.pool.query("SELECT domains FROM orgs WHERE id = 'example'")).rows[0].domains).toEqual(['example.org']);
});

it("schema-only identity migrations preserve existing members, aliases, organisation and policy", async () => {
  const migration = (name: string) => readFileSync(resolve(import.meta.dirname, "../sql", name), "utf8");
  await db.pool.query(migration("028_orgs.sql"));
  await db.pool.query(migration("029_cross_member.sql"));
  await db.pool.query(`INSERT INTO users (id, display_name, primary_email, org_id, org_role)
    VALUES ('existing-owner', 'Existing Owner', 'owner@example.org', 'example', 'owner');
    INSERT INTO user_aliases (system, alias, user_id) VALUES ('legacy', 'OLD_OWNER', 'existing-owner');
    INSERT INTO org_member_policy (user_id, allowed_capabilities, may_create_agents)
    VALUES ('existing-owner', ARRAY['calendar'], false);`);
  const snapshot = async () => Promise.all(['users', 'user_aliases', 'orgs', 'org_member_policy'].map(async table =>
    (await db.pool.query(`SELECT * FROM ${table}`)).rows));
  const before = await snapshot();
  for (const name of ['014_identity.sql', '028_orgs.sql', '029_cross_member.sql', '032_org_domains.sql']) {
    await db.pool.query(migration(name));
  }
  expect(await snapshot()).toEqual(before);
});

it("removes a legacy owner default without changing records and rejects unowned writes", async () => {
  await db.pool.query("ALTER TABLE reminders ALTER COLUMN owner SET DEFAULT 'legacy-owner'");
  await db.pool.query(`INSERT INTO reminders (agent, owner, due_at, payload, created_by)
    VALUES ('fixture', 'existing-owner', now(), '{}', 'fixture')`);
  const before = (await db.pool.query('SELECT * FROM reminders')).rows;
  const sql = readFileSync(resolve(import.meta.dirname, '../sql/088_explicit_owner_defaults.sql'), 'utf8');
  await db.pool.query(sql);
  await db.pool.query(sql);
  expect((await db.pool.query('SELECT * FROM reminders')).rows).toEqual(before);
  await expect(db.pool.query(`INSERT INTO reminders (agent, due_at, payload, created_by)
    VALUES ('fixture', now(), '{}', 'fixture')`)).rejects.toMatchObject({ code: '23502', column: 'owner' });
  await db.pool.query(`INSERT INTO reminders (agent, owner, due_at, payload, created_by)
    VALUES ('fixture', 'explicit-owner', now(), '{}', 'fixture')`);
});
