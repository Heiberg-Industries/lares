// The migrate CLI: argument parsing, exit codes and the plain-language output a non-developer
// owner reads when something about the database is already wrong. The rules being exercised
// through it (order, checksum, adoption) are already proven in migration-runner.test.ts and
// migration-adopt.test.ts — this file is about the CLI wrapper: flags, what gets printed, and
// what code main() returns.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { parseArgs, main } from "../migrate.js";

const tempDirs: string[] = [];
function tempDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-cli-"));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  tempDirs.push(dir);
  return dir;
}

let container: StartedPostgreSqlContainer;
let pool: Pool;
beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
}, 180_000);
afterAll(async () => {
  await pool?.end();
  await container?.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
// A bare database with no schema of its own: this file tests the CLI's mechanics (flags, exit
// codes, what gets printed), not adoption — migration-adopt.test.ts owns that, against the
// box's real 001-019 schema. `pre_existing` is the one table a test creates by hand to stand in
// for "a database that already has a schema".
beforeEach(async () => {
  await pool.query("DROP TABLE IF EXISTS schema_migrations, a, b, pre_existing");
});

describe("the migrate CLI", () => {
  describe("parseArgs", () => {
    it("defaults to the box's own sql directory", () => {
      expect(parseArgs([])).toEqual({ dryRun: false, help: false });
    });

    it("parses the flags", () => {
      expect(parseArgs(["--dry-run"])).toMatchObject({ dryRun: true });
      expect(parseArgs(["--adopt-through", "050_brief_settings.sql"])).toMatchObject({
        adoptThrough: "050_brief_settings.sql",
      });
      expect(parseArgs(["--dir", "/srv/sql"])).toMatchObject({ dir: "/srv/sql" });
      expect(parseArgs(["--confirm-will-run"])).toMatchObject({ confirmWillRun: true });
      expect(parseArgs(["--help"])).toMatchObject({ help: true });
    });

    it("refuses an unknown flag rather than ignoring it", () => {
      expect(() => parseArgs(["--force"])).toThrow(/--force/);
    });

    it("refuses --adopt-through with no value", () => {
      expect(() => parseArgs(["--adopt-through"])).toThrow(/needs a filename/i);
    });

    it("refuses --dir with no value", () => {
      expect(() => parseArgs(["--dir"])).toThrow(/needs a directory/i);
    });
  });

  it("--help prints the flags and exit codes, and touches nothing", async () => {
    const out: string[] = [];
    expect(await main(["--help"], { db: pool, out: (s) => out.push(s) })).toBe(0);
    expect(out.join("\n")).toContain("--adopt-through");
    expect(out.join("\n")).toContain("Exit codes");
  });

  it("returns 0 when there is nothing to do", async () => {
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    const out: string[] = [];
    expect(await main(["--dir", dir], { db: pool, out: (s) => out.push(s) })).toBe(0);
    // everything applied on the first run, so the second says so and still exits 0
    expect(await main(["--dir", dir], { db: pool, out: (s) => out.push(s) })).toBe(0);
    expect(out.join("\n")).toContain("nothing to apply");
    await expect(pool.query("SELECT 1 FROM a")).resolves.toBeDefined();
  });

  it("returns 1 on a refusal and applies nothing", async () => {
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    await main(["--dir", dir], { db: pool, out: () => {} });
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a(i int, j int);");
    const out: string[] = [];
    expect(await main(["--dir", dir], { db: pool, out: (s) => out.push(s) })).toBe(1);
    expect(out.join("\n")).toContain("REFUSED");
  });

  it("prints the plan, returns 2 and applies nothing on --dry-run", async () => {
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    const out: string[] = [];
    expect(await main(["--dir", dir, "--dry-run"], { db: pool, out: (s) => out.push(s) })).toBe(2);
    expect(out.join("\n")).toContain("apply  001_a.sql");
    await expect(pool.query("SELECT 1 FROM a")).rejects.toThrow(/does not exist/);
  });

  it("refuses to run at all against a populated database with an empty ledger", async () => {
    await pool.query("CREATE TABLE pre_existing(i int);");
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    const out: string[] = [];
    expect(await main(["--dir", dir], { db: pool, out: (s) => out.push(s) })).toBe(1);
    expect(out.join("\n")).toContain("--adopt-through");
    await expect(pool.query("SELECT 1 FROM a")).rejects.toThrow(/does not exist/);
  });

  it("a dry run against the same populated-and-unadopted database says so too, alongside the plan", async () => {
    await pool.query("CREATE TABLE pre_existing(i int);");
    const dir = tempDirWith({ "001_a.sql": "CREATE TABLE a(i int);" });
    const out: string[] = [];
    expect(await main(["--dir", dir, "--dry-run"], { db: pool, out: (s) => out.push(s) })).toBe(1);
    const printed = out.join("\n");
    expect(printed).toContain("apply  001_a.sql"); // the plan is still shown
    expect(printed).toContain("--adopt-through"); // and so is the refusal a real run would hit
    await expect(pool.query("SELECT 1 FROM a")).rejects.toThrow(/does not exist/);
  });

  it("names the regeneration remedy when a generated file's checksum changed", async () => {
    // 001-eve-workflow.sql is regenerated per eve bump; the refusal must say so, not just
    // "changed since it was applied".
    const dir = tempDirWith({ "001-eve-workflow.sql": "SELECT 1;" });
    await main(["--dir", dir], { db: pool, out: () => {} });
    writeFileSync(join(dir, "001-eve-workflow.sql"), "SELECT 2;");
    const out: string[] = [];
    await main(["--dir", dir], { db: pool, out: (s) => out.push(s) });
    expect(out.join("\n")).toMatch(/regen:eve-sql/);
  });

  describe("--adopt-through", () => {
    it("adopts through a named file, prints AdoptResult.report, and returns 0", async () => {
      const dir = tempDirWith({ "001_a.sql": "SELECT 1;", "002_b.sql": "CREATE TABLE b(i int);" });
      const out: string[] = [];
      const code = await main(
        ["--dir", dir, "--adopt-through", "001_a.sql", "--confirm-will-run"],
        { db: pool, out: (s) => out.push(s) },
      );
      expect(code).toBe(0);
      expect(out.join("\n")).toMatch(/adopted 1 file/i);

      // The adopted file is not re-run; only what comes after it applies.
      const out2: string[] = [];
      expect(await main(["--dir", dir], { db: pool, out: (s) => out2.push(s) })).toBe(0);
      await expect(pool.query("SELECT 1 FROM b")).resolves.toBeDefined();
    });

    it("refuses without --confirm-will-run when adoption would leave files to run", async () => {
      const dir = tempDirWith({ "001_a.sql": "SELECT 1;", "002_b.sql": "SELECT 1;" });
      const out: string[] = [];
      const code = await main(["--dir", dir, "--adopt-through", "001_a.sql"], {
        db: pool,
        out: (s) => out.push(s),
      });
      expect(code).toBe(1);
      expect(out.join("\n")).toMatch(/--confirm-will-run/);
    });

    it("adopts nothing and still reports on --adopt-through --dry-run, returning 2", async () => {
      const dir = tempDirWith({ "001_a.sql": "SELECT 1;" });
      const out: string[] = [];
      const code = await main(["--dir", dir, "--adopt-through", "001_a.sql", "--dry-run"], {
        db: pool,
        out: (s) => out.push(s),
      });
      expect(code).toBe(2);
      expect(out.join("\n")).toMatch(/would adopt/i);
    });
  });
});
