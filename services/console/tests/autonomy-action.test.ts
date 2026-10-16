import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { startTestDb, type TestDb } from "@lares/agent-box/tests/helpers/pg.js";
import { PgRatchet } from "@lares/agent-kit/ratchet-store";

let tdb: TestDb;
let db: Pool;

beforeAll(async () => {
  tdb = await startTestDb();
  db = tdb.pool;
}, 120_000);

afterAll(async () => {
  await tdb?.stop();
});

describe("setAutonomy persistence", () => {
  it("flip writes a ratchet row that decideAction will honour", async () => {
    const r = new PgRatchet(db);
    await r.setLevel("sales-agent", "gmail", "autonomous", "send", "owner@owner.example");
    expect(await r.level("sales-agent", "gmail", "send")).toBe("autonomous");
    const { rows } = await db.query(
      `SELECT updated_by FROM ratchet WHERE agent='sales-agent' AND capability='gmail' AND action='send'`,
    );
    expect(rows[0].updated_by).toBe("owner@owner.example");
  });
});
