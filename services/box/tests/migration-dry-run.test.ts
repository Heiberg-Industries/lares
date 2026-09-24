import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planMigrations, runMigrations, renderPlan, exitCodeFor } from "../lib/migration-runner.js";
import { checksumOf, ensureLedger, listApplied } from "../lib/migration-ledger.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

const f = (filename: string, bytes: string) => ({ filename, number: Number(filename.slice(0, 3)), path: `/x/${filename}`, bytes, checksum: checksumOf(bytes) });
const appliedFrom = (file: ReturnType<typeof f>, how: "applied" | "adopted" = "applied") =>
  ({ filename: file.filename, number: file.number, checksum: file.checksum, appliedAt: new Date(), how, tookMs: 1 });

const a = f("001_a.sql", "create table a();");
const b = f("002_b.sql", "create table b();");

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
// Every run test builds its own tables from scratch, against its own empty (or absent) ledger.
beforeEach(async () => { await db.pool.query("DROP TABLE IF EXISTS schema_migrations, a, b"); });

describe("dry run", () => {
  it("names every file and what would happen to it", () => {
    const out = renderPlan(planMigrations([a, b], [appliedFrom(a)]), { dir: "/srv/sql" });
    expect(out).toContain("skip   001_a.sql  (already applied)");
    expect(out).toContain("apply  002_b.sql");
    expect(out).toContain("1 to apply, 1 already applied, 0 refused");
  });

  it("puts every refusal at the end, with its reason, so it is the last thing read", () => {
    const edited = f("001_a.sql", "changed");
    const out = renderPlan(planMigrations([edited, b], [appliedFrom(a)]), { dir: "/srv/sql" });
    expect(out.trimEnd().split("\n").at(-1)).toMatch(/changed since it was applied/);
    expect(out).toContain("REFUSED");
  });

  it("says so plainly when there is nothing to do", () => {
    expect(renderPlan(planMigrations([a], [appliedFrom(a)]), { dir: "/srv/sql" })).toContain("nothing to apply");
  });

  it("exit codes: 0 nothing, 2 work, 1 refusal — refusal wins over work", () => {
    expect(exitCodeFor(planMigrations([a], [appliedFrom(a)]))).toBe(0);
    expect(exitCodeFor(planMigrations([a, b], [appliedFrom(a)]))).toBe(2);
    expect(exitCodeFor(planMigrations([f("001_a.sql", "changed"), b], [appliedFrom(a)]))).toBe(1);
  });

  it("a dry run writes nothing at all", async () => {
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    await ensureLedger(db.pool);
    const r = await runMigrations(db.pool, dir, { dryRun: true });
    expect(r.applied).toEqual([]);
    expect(await listApplied(db.pool)).toEqual([]);
    await expect(db.pool.query("SELECT 1 FROM a")).rejects.toThrow(/does not exist/);
  });

  // W3D-s2 deliberately left runMigrations NOT calling ensureLedger, so that a dry run touches the
  // database for nothing but the read. On a fresh installation that means the ledger table itself
  // does not exist yet — a dry run must treat that as an empty ledger, not create the table and not
  // fail, since "what would happen" is exactly the question someone asks before anything exists.
  it("a dry run against a database with no ledger table treats it as empty, and creates nothing", async () => {
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    await expect(db.pool.query("SELECT 1 FROM schema_migrations")).rejects.toThrow(/does not exist/);
    const r = await runMigrations(db.pool, dir, { dryRun: true });
    expect(r).toEqual({ applied: [], skipped: [], refused: [] });
    await expect(db.pool.query("SELECT 1 FROM schema_migrations")).rejects.toThrow(/does not exist/);
    await expect(db.pool.query("SELECT 1 FROM a")).rejects.toThrow(/does not exist/);
  });
});
