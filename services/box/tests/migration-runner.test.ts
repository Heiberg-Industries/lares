import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrations, planMigrations, runMigrations } from "../lib/migration-runner.js";
import { checksumOf, ensureLedger, listApplied } from "../lib/migration-ledger.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

const f = (filename: string, bytes: string) => ({ filename, number: Number(filename.slice(0, 3)), path: `/x/${filename}`, bytes, checksum: checksumOf(bytes) });
const appliedFrom = (file: ReturnType<typeof f>, how: "applied" | "adopted" = "applied") =>
  ({ filename: file.filename, number: file.number, checksum: file.checksum, appliedAt: new Date(), how, tookMs: 1 });

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
// Every run test builds its own tables from scratch, against its own empty ledger — on a database
// that is genuinely EMPTY. startTestDb applies 001-019, and from W3D-s4 a real run against a
// database that has a schema and an empty ledger refuses until someone adopts (see
// tests/migration-adopt.test.ts). None of the cases below wants that; every one of them means
// "a fresh installation", so the schema is dropped rather than three tables of it.
beforeEach(async () => { await db.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); });

describe("readMigrations", () => {
  it("orders by number, then by filename — so today's two 019s are stable and not arbitrary", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    for (const n of ["019_obligations.sql", "019_atlas_sync.sql", "002_task_state.sql", "050_brief_settings.sql"]) {
      writeFileSync(join(dir, n), `-- ${n}\n`);
    }
    expect(readMigrations(dir).map((m) => m.filename)).toEqual([
      "002_task_state.sql", "019_atlas_sync.sql", "019_obligations.sql", "050_brief_settings.sql",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts both naming conventions in the repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "001-eve-workflow.sql"), "--\n");
    writeFileSync(join(dir, "002_task_state.sql"), "--\n");
    expect(readMigrations(dir).map((m) => m.number)).toEqual([1, 2]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a file whose name carries no number, rather than sorting it somewhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "fixup.sql"), "--\n");
    expect(() => readMigrations(dir)).toThrow(/fixup\.sql/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores anything that is not .sql", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "001_a.sql"), "--\n");
    writeFileSync(join(dir, "README.md"), "x\n");
    expect(readMigrations(dir)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("planMigrations", () => {
  const a = f("001_a.sql", "create table a();");
  const b = f("002_b.sql", "create table b();");
  const c = f("003_c.sql", "create table c();");

  it("applies everything against an empty ledger", () => {
    expect(planMigrations([a, b], []).steps.map((s) => s.action)).toEqual(["apply", "apply"]);
  });

  it("skips what the ledger already holds, and applies the rest", () => {
    const p = planMigrations([a, b], [appliedFrom(a)]);
    expect(p.steps.map((s) => [s.action, s.file.filename])).toEqual([["skip", "001_a.sql"], ["apply", "002_b.sql"]]);
    expect(p.refusals).toEqual([]);
  });

  it("refuses a file that changed after it was applied, and names it", () => {
    const edited = f("001_a.sql", "create table a(x int);");
    const p = planMigrations([edited], [appliedFrom(a)]);
    expect(p.refusals).toHaveLength(1);
    expect(p.refusals[0]!.reason).toMatch(/changed since it was applied/i);
  });

  it("refuses a NEW file numbered below something already applied", () => {
    const p = planMigrations([a, b, c], [appliedFrom(c)]);
    expect(p.refusals.map((r) => r.file.filename)).toEqual(["001_a.sql", "002_b.sql"]);
    expect(p.refusals[0]!.reason).toMatch(/out of order/i);
  });

  it("does NOT call a gap out of order — 047 is missing from services/box/sql and that is fine", () => {
    const forty6 = f("046_x.sql", "x"); const forty8 = f("048_y.sql", "y");
    expect(planMigrations([forty6, forty8], [appliedFrom(forty6)]).refusals).toEqual([]);
  });

  it("does NOT call a second file with the same number out of order", () => {
    const one = f("019_atlas_sync.sql", "x"); const two = f("019_obligations.sql", "y");
    expect(planMigrations([one, two], [appliedFrom(one)]).refusals).toEqual([]);
  });

  it("refuses a ledger row whose file has vanished, rather than ignoring it", () => {
    const p = planMigrations([b], [appliedFrom(a), appliedFrom(b)]);
    expect(p.refusals.map((r) => r.reason)).toEqual([expect.stringMatching(/no longer on disk/i)]);
  });

  it("an adopted row counts as applied for every rule", () => {
    expect(planMigrations([a, b], [appliedFrom(a, "adopted")]).steps.map((s) => s.action)).toEqual(["skip", "apply"]);
  });
});

describe("runMigrations", () => {
  it("applies in order, records each, and is a no-op on a second run", async () => {
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);", "002_b.sql": "CREATE TABLE b(i int);" });
    await ensureLedger(db.pool);
    expect((await runMigrations(db.pool, dir)).applied).toEqual(["001_a.sql", "002_b.sql"]);
    expect((await runMigrations(db.pool, dir)).applied).toEqual([]);
    expect((await listApplied(db.pool)).map((r) => r.filename)).toEqual(["001_a.sql", "002_b.sql"]);
  });

  it("applies NOTHING when the plan contains any refusal — not even the valid files before it", async () => {
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    await ensureLedger(db.pool);
    await runMigrations(db.pool, dir);
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a(i int, j int);");
    writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b(i int);");
    const r = await runMigrations(db.pool, dir);
    expect(r.applied).toEqual([]);
    expect(r.refused.map((x) => x.filename)).toEqual(["001_a.sql"]);
    await expect(db.pool.query("SELECT 1 FROM b")).rejects.toThrow(/does not exist/);
  });

  it("a failing migration leaves no ledger row and no half-applied schema", async () => {
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int); SELECT 1/0;" });
    await ensureLedger(db.pool);
    await expect(runMigrations(db.pool, dir)).rejects.toThrow(/001_a\.sql/);
    expect(await listApplied(db.pool)).toEqual([]);
    await expect(db.pool.query("SELECT 1 FROM a")).rejects.toThrow(/does not exist/);
  });

  it("stops at the first failure and does not apply the files after it", async () => {
    const dir = tempDirWith({ "001_a.sql": "SELECT 1/0;", "002_b.sql": "CREATE TABLE b(i int);" });
    await ensureLedger(db.pool);
    await expect(runMigrations(db.pool, dir)).rejects.toThrow();
    await expect(db.pool.query("SELECT 1 FROM b")).rejects.toThrow(/does not exist/);
  });

  // 20 of the 51 files in services/box/sql ship their own BEGIN;…COMMIT; — the house style. The
  // three cases below are what that costs and what it must still guarantee.
  it("a migration that ships its own BEGIN/COMMIT applies, and is recorded", async () => {
    const dir = tempDirWith({ "001_a.sql": "BEGIN;\nCREATE TABLE a(i int);\nCOMMIT;\n" });
    await ensureLedger(db.pool);
    expect((await runMigrations(db.pool, dir)).applied).toEqual(["001_a.sql"]);
    expect((await listApplied(db.pool)).map((r) => r.filename)).toEqual(["001_a.sql"]);
    await db.pool.query("SELECT 1 FROM a");
  });

  it("a migration that ships its own BEGIN/COMMIT and then fails leaves nothing behind", async () => {
    const dir = tempDirWith({ "001_a.sql": "BEGIN;\nCREATE TABLE a(i int);\nSELECT 1/0;\nCOMMIT;\n" });
    await ensureLedger(db.pool);
    await expect(runMigrations(db.pool, dir)).rejects.toThrow(/001_a\.sql/);
    expect(await listApplied(db.pool)).toEqual([]);
    await expect(db.pool.query("SELECT 1 FROM a")).rejects.toThrow(/does not exist/);
  });

  it("the schema change and its ledger row stand or fall together, even inside the file's own transaction", async () => {
    // The distinguishing case. A file's own COMMIT ends whatever transaction is open — Postgres has
    // no nested transactions — so if the ledger row were written after the file, that COMMIT would
    // land the schema change and leave the row to a second, separate commit. Here the ledger write
    // is made to fail; the schema change must not survive it.
    const dir = tempDirWith({ "001_a.sql": "BEGIN;\nCREATE TABLE a(i int);\nCOMMIT;\n" });
    await ensureLedger(db.pool);
    await db.pool.query("ALTER TABLE schema_migrations ADD CONSTRAINT probe_no_a CHECK (filename <> '001_a.sql')");
    await expect(runMigrations(db.pool, dir)).rejects.toThrow(/001_a\.sql/);
    await expect(db.pool.query("SELECT 1 FROM a")).rejects.toThrow(/does not exist/);
    expect(await listApplied(db.pool)).toEqual([]);
  });

  it("a dry run reports the work and changes nothing", async () => {
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    await ensureLedger(db.pool);
    const r = await runMigrations(db.pool, dir, { dryRun: true });
    expect(r.applied).toEqual([]);
    expect(await listApplied(db.pool)).toEqual([]);
    await expect(db.pool.query("SELECT 1 FROM a")).rejects.toThrow(/does not exist/);
  });
});
