import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb } from "./helpers/pg.js";
import { ensureLedger, listApplied, recordApplied, checksumOf, LEDGER_DDL } from "../lib/migration-ledger.js";

let db: TestDb;
beforeAll(async () => { db = await startTestDb(); }, 180_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await db.pool.query("DROP TABLE IF EXISTS schema_migrations"); });

describe("the ledger", () => {
  it("062 applies cleanly twice", async () => {
    const sql = readFileSync(join(__dirname, "..", "sql", "062_schema_migrations.sql"), "utf8");
    await db.pool.query(sql);
    await db.pool.query(sql);
  });

  it("ensureLedger is the same thing, callable from code", async () => {
    await ensureLedger(db.pool);
    await ensureLedger(db.pool);
    expect(await listApplied(db.pool)).toEqual([]);
  });

  it("records and reads back a run", async () => {
    await ensureLedger(db.pool);
    await recordApplied(db.pool, { filename: "060_conversation_entries.sql", number: 60, checksum: checksumOf("x"), how: "applied", tookMs: 12 });
    const [row] = await listApplied(db.pool);
    expect(row).toMatchObject({ filename: "060_conversation_entries.sql", number: 60, how: "applied", tookMs: 12 });
    expect(row!.appliedAt).toBeInstanceOf(Date);
  });

  it("returns rows in the order they were applied, not alphabetically", async () => {
    await ensureLedger(db.pool);
    await recordApplied(db.pool, { filename: "019_obligations.sql", number: 19, checksum: "a", how: "adopted", tookMs: 0 });
    await recordApplied(db.pool, { filename: "019_atlas_sync.sql", number: 19, checksum: "b", how: "adopted", tookMs: 0 });
    expect((await listApplied(db.pool)).map((r) => r.filename)).toEqual(["019_obligations.sql", "019_atlas_sync.sql"]);
  });

  it("refuses to record the same filename twice", async () => {
    await ensureLedger(db.pool);
    const m = { filename: "060_x.sql", number: 60, checksum: "a", how: "applied" as const, tookMs: 1 };
    await recordApplied(db.pool, m);
    await expect(recordApplied(db.pool, m)).rejects.toThrow(/schema_migrations_pkey/);
  });

  it("refuses a how it does not recognise", async () => {
    await ensureLedger(db.pool);
    await expect(
      db.pool.query("INSERT INTO schema_migrations (filename, number, checksum, how, took_ms) VALUES ('x.sql', 1, 'a', 'guessed', 0)"),
    ).rejects.toThrow(/schema_migrations_how_check/);
  });

  it("checksumOf is the plain sha256 of the exact bytes", () => {
    expect(checksumOf("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    expect(checksumOf("a ")).not.toBe(checksumOf("a"));
  });

  // The literal ensureLedger runs and the committed sql/062_schema_migrations.sql file must say
  // the same thing: ensureLedger can't read the file off disk (that would be circular — it has to
  // be able to build its own table on a database where 062 has never been applied), so the two are
  // proved identical here instead, the engine-drift.test.ts technique.
  it("the LEDGER_DDL literal matches sql/062_schema_migrations.sql, comments and whitespace aside", () => {
    const normalise = (sql: string): string =>
      sql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    const fileSql = readFileSync(join(__dirname, "..", "sql", "062_schema_migrations.sql"), "utf8");
    expect(normalise(LEDGER_DDL)).toBe(normalise(fileSql));
  });
});
