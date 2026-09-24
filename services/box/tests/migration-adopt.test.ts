// Adoption: the one-time act that lets the runner meet a database migrated before it existed.
// The cases that matter are the two ways the operator can be WRONG about `through` — too early
// (files that really ran will run again) and too late (a file that never ran is recorded as
// applied) — and what the runner can and cannot do about each.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { adoptMigrations, looksAlreadyMigrated, runMigrations } from "../lib/migration-runner.js";
import { ensureLedger, listApplied, recordApplied } from "../lib/migration-ledger.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

const tempDirs: string[] = [];
function tempDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  tempDirs.push(dir);
  return dir;
}

let db: TestDb;
beforeAll(async () => { db = await startTestDb(); }, 180_000);
afterAll(async () => {
  await db?.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
// The 001-019 tables startTestDb applies are left in place on purpose: a database with a schema
// and no ledger is exactly the thing this file is about.
beforeEach(async () => { await db.pool.query("DROP TABLE IF EXISTS schema_migrations, a, b, c, d"); });

describe("adopting an already-migrated database", () => {
  it("recognises a database that has a schema but no ledger", async () => {
    expect(await looksAlreadyMigrated(db.pool)).toBe(true);   // helpers/pg.ts already applied 001-019
  });

  it("does not count the ledger table itself as a schema", async () => {
    await ensureLedger(db.pool);
    expect(await looksAlreadyMigrated(db.pool)).toBe(true);   // still true: the 001-019 tables
  });

  it("recognises a genuinely empty database", async () => {
    // startTestDb() takes no arguments and always applies 001-019 (tests/helpers/pg.ts:38),
    // so an empty database is made here directly rather than by parameterising that helper —
    // this slice must NOT change startTestDb's signature or any existing caller's behaviour.
    const empty = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const pool = new Pool({ connectionString: empty.getConnectionUri() });
    try {
      expect(await looksAlreadyMigrated(pool)).toBe(false);
      await ensureLedger(pool);
      // The ledger alone is still an empty database as far as adoption is concerned.
      expect(await looksAlreadyMigrated(pool)).toBe(false);
    } finally {
      await pool.end();
      await empty.stop();
    }
  }, 180_000);

  it("refuses to run against a populated database with an empty ledger, and says what to do", async () => {
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    await expect(runMigrations(db.pool, dir)).rejects.toThrow(/already has a schema but no migration ledger.*--adopt/s);
  });

  it("refuses the same way when the ledger table exists but is empty — the CLI's own path", async () => {
    // W3D-s5's `main` calls ensureLedger before runMigrations, so on the live installation the
    // table exists and holds nothing. That must refuse exactly as the missing table does.
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    await expect(runMigrations(db.pool, dir)).rejects.toThrow(/already has a schema but no migration ledger.*--adopt/s);
    expect(await listApplied(db.pool)).toEqual([]);
    await expect(db.pool.query("SELECT 1 FROM a")).rejects.toThrow(/does not exist/);
  });

  it("does NOT refuse a dry run — looking is how the operator decides what to adopt", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    const r = await runMigrations(db.pool, dir, { dryRun: true });
    expect(r).toEqual({ applied: [], skipped: [], refused: [] });
    await expect(db.pool.query("SELECT 1 FROM a")).rejects.toThrow(/does not exist/);
  });

  it("adopts through a named file and applies only what comes after", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "001_a.sql": "SELECT 1/0;", "002_b.sql": "SELECT 1/0;", "003_c.sql": "CREATE TABLE c(i int);" });
    const { adopted } = await adoptMigrations(db.pool, dir, { through: "002_b.sql", confirmWillRun: true });
    expect(adopted).toEqual(["001_a.sql", "002_b.sql"]);
    // The adopted files would have thrown if they had actually run.
    expect((await runMigrations(db.pool, dir)).applied).toEqual(["003_c.sql"]);
  });

  it("records adoptions with the real checksum, so a later edit is still caught", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "001_a.sql": "SELECT 1;" });
    await adoptMigrations(db.pool, dir, { through: "001_a.sql" });
    writeFileSync(join(dir, "001_a.sql"), "SELECT 2;");
    expect((await runMigrations(db.pool, dir)).refused[0]!.reason).toMatch(/changed since it was applied/i);
  });

  it("records every adoption as how='adopted', with took_ms 0", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "001_a.sql": "SELECT 1;", "002_b.sql": "SELECT 1;" });
    await adoptMigrations(db.pool, dir, { through: "002_b.sql" });
    const rows = await listApplied(db.pool);
    expect(rows.map((r) => [r.filename, r.how, r.tookMs])).toEqual([
      ["001_a.sql", "adopted", 0],
      ["002_b.sql", "adopted", 0],
    ]);
  });

  it("refuses a second adoption", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "001_a.sql": "SELECT 1;", "002_b.sql": "SELECT 1;" });
    await adoptMigrations(db.pool, dir, { through: "001_a.sql", confirmWillRun: true });
    await expect(adoptMigrations(db.pool, dir, { through: "002_b.sql" })).rejects.toThrow(/already holds .* adoption is a one-time/i);
  });

  it("refuses adoption once the ledger holds an ordinary applied row", async () => {
    await ensureLedger(db.pool);
    await recordApplied(db.pool, { filename: "001_a.sql", number: 1, checksum: "x", how: "applied", tookMs: 3 });
    const dir = tempDirWith({ "001_a.sql": "SELECT 1;", "002_b.sql": "SELECT 1;" });
    await expect(adoptMigrations(db.pool, dir, { through: "002_b.sql" })).rejects.toThrow(/adoption is a one-time/i);
  });

  it("refuses a through that names no file in the directory", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "001_a.sql": "SELECT 1;" });
    await expect(adoptMigrations(db.pool, dir, { through: "099_nope.sql" })).rejects.toThrow(/099_nope\.sql/);
    expect(await listApplied(db.pool)).toEqual([]);
  });

  it("adopts nothing on a dry run, and still reports what it would do", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "001_a.sql": "SELECT 1;", "002_b.sql": "SELECT 1;", "003_c.sql": "SELECT 1;" });
    const r = await adoptMigrations(db.pool, dir, { through: "002_b.sql", dryRun: true });
    expect(r.adopted).toEqual(["001_a.sql", "002_b.sql"]);
    expect(r.willRunNext).toEqual(["003_c.sql"]);
    expect(r.report).toMatch(/would adopt/i);
    expect(await listApplied(db.pool)).toEqual([]);
  });

  it("a dry run creates no ledger table either, against the database adoption is really for", async () => {
    const dir = tempDirWith({ "001_a.sql": "SELECT 1;" });
    await adoptMigrations(db.pool, dir, { through: "001_a.sql", dryRun: true });
    await expect(db.pool.query("SELECT 1 FROM schema_migrations")).rejects.toThrow(/does not exist/);
  });

  it("a real adoption creates the ledger it is about to write to", async () => {
    // The database adoption exists for has no ledger table at all — needing one first would be a
    // trap. A dry run still creates nothing (above).
    const dir = tempDirWith({ "001_a.sql": "SELECT 1;" });
    await adoptMigrations(db.pool, dir, { through: "001_a.sql" });
    expect((await listApplied(db.pool)).map((r) => r.filename)).toEqual(["001_a.sql"]);
  });

  // ---- through named TOO EARLY: files that really ran will run again -----------------------

  it("refuses without confirmation, and names exactly the files that will run next", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({
      "001_a.sql": "SELECT 1;", "002_b.sql": "SELECT 1;", "003_c.sql": "SELECT 1;", "004_d.sql": "SELECT 1;",
    });
    const refusal = await adoptMigrations(db.pool, dir, { through: "002_b.sql" }).catch((e: Error) => e.message);
    expect(refusal).toContain("003_c.sql");
    expect(refusal).toContain("004_d.sql");
    expect(refusal).not.toContain("001_a.sql");
    expect(refusal).toMatch(/--confirm-will-run/);
    expect(refusal).toMatch(/cannot tell whether that is safe/i);
    expect(await listApplied(db.pool)).toEqual([]);
  });

  it("needs no confirmation when adoption leaves nothing to run", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "001_a.sql": "SELECT 1;", "002_b.sql": "SELECT 1;" });
    const r = await adoptMigrations(db.pool, dir, { through: "002_b.sql" });
    expect(r.willRunNext).toEqual([]);
    expect(r.report).toMatch(/nothing is left to apply/i);
  });

  it("says plainly that adoption asserts rather than verifies", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "001_a.sql": "SELECT 1;" });
    const r = await adoptMigrations(db.pool, dir, { through: "001_a.sql" });
    expect(r.report).toMatch(/ADOPTION ASSERTS; IT DOES NOT VERIFY/);
    expect(r.report).toMatch(/did not run these files and cannot check that\s+they ever ran/i);
  });

  // ---- through named TOO LATE: a file that never ran is recorded as applied ----------------

  it("cannot detect a file adopted that never ran, and the report says so", async () => {
    // 002_b.sql was never applied by hand, but the operator names it anyway. Nothing catches it:
    // the runner has no per-migration "is this applied?" predicate and never will (ADR-0021 / D2).
    // The cost lands later, far from here, as a missing table.
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "001_a.sql": "SELECT 1;", "002_b.sql": "CREATE TABLE b(i int);", "003_c.sql": "CREATE TABLE c(i int);" });
    const r = await adoptMigrations(db.pool, dir, { through: "002_b.sql", confirmWillRun: true });
    expect(r.adopted).toEqual(["001_a.sql", "002_b.sql"]);
    expect((await runMigrations(db.pool, dir)).applied).toEqual(["003_c.sql"]);
    // b was never created and never will be. This is the accepted limit, pinned so it is a
    // decision rather than a surprise.
    await expect(db.pool.query("SELECT 1 FROM b")).rejects.toThrow(/does not exist/);
    expect(r.report).toMatch(/nothing will ever apply it/i);
    expect(r.report).toMatch(/delete that row from schema_migrations/i);
  });

  // ---- the two irregularities services/box/sql really has ----------------------------------

  it("adopting through the second of two files numbered 019 adopts both", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "019_atlas_sync.sql": "SELECT 1;", "019_obligations.sql": "SELECT 1;" });
    const r = await adoptMigrations(db.pool, dir, { through: "019_obligations.sql" });
    expect(r.adopted).toEqual(["019_atlas_sync.sql", "019_obligations.sql"]);
    expect(r.willRunNext).toEqual([]);
  });

  it("adopting through the first of the two 019s leaves the second to run, and that is not out of order", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "019_atlas_sync.sql": "SELECT 1;", "019_obligations.sql": "CREATE TABLE d(i int);" });
    const r = await adoptMigrations(db.pool, dir, { through: "019_atlas_sync.sql", confirmWillRun: true });
    expect(r.adopted).toEqual(["019_atlas_sync.sql"]);
    expect(r.willRunNext).toEqual(["019_obligations.sql"]);
    const run = await runMigrations(db.pool, dir);
    expect(run.refused).toEqual([]);
    expect(run.applied).toEqual(["019_obligations.sql"]);
  });

  it("tolerates the missing 047 — a gap is not a file, and adoption skips over it", async () => {
    await ensureLedger(db.pool);
    const dir = tempDirWith({ "046_x.sql": "SELECT 1;", "048_y.sql": "SELECT 1;", "050_z.sql": "SELECT 1;" });
    const r = await adoptMigrations(db.pool, dir, { through: "048_y.sql", confirmWillRun: true });
    expect(r.adopted).toEqual(["046_x.sql", "048_y.sql"]);
    expect(r.willRunNext).toEqual(["050_z.sql"]);
  });
});
