import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { startBoss } from "../lib/boss.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";
import type PgBoss from "pg-boss";

let tdb: TestDb;
let db: Pool;
let boss: PgBoss;
let connectionString: string;

beforeAll(async () => {
  tdb = await startTestDb();
  db = tdb.pool;
  connectionString = tdb.connectionString;
}, 120_000);

afterAll(async () => {
  await boss?.stop();
  await tdb?.stop();
});

describe("pg-boss bootstrap", () => {
  it("creates the pgboss schema on first start", async () => {
    boss = await startBoss(connectionString);
    const { rows } = await db.query(
      `SELECT nspname FROM pg_namespace WHERE nspname = 'pgboss'`,
    );
    expect(rows.map((r) => r.nspname)).toContain("pgboss");
  });
});
