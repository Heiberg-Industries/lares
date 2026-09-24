// services/box/tests/run-erase.test.ts — W5B-s8: the vault pass and the database pass, wired
// together in the one order that keeps both halves' promises.
//
// WHY A REAL POSTGRES AND A REAL GIT REPOSITORY TOGETHER. The two things this wiring can get
// wrong are exactly the things a mock would agree with: a vault file removed before the database
// erase turns out to refuse, and a "database touched" that is really "database untouched because
// the vault pass never got that far". So every test here runs the shared three-spellings fixture
// (a disposable Postgres with the real schema) against a real `git init` in a throwaway directory,
// the same combination erase-person-vault.test.ts and erase-person-db.test.ts each use alone.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startThreeSpellingsDb, FIXTURE_OWNER, type TestDb } from "./helpers/three-spellings.js";
import { runErase, renderRunEraseReport } from "../lib/run-erase.js";

let db: TestDb;
let vaultRoot: string;

function write(relPath: string, body: string): void {
  const abs = join(vaultRoot, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", vaultRoot, ...args], { encoding: "utf8" });
}

beforeEach(async () => {
  db = await startThreeSpellingsDb();

  vaultRoot = mkdtempSync(join(tmpdir(), "run-erase-vault-"));
  write("people/ada.md", "---\nowner: fixture-owner\nscope: private\n---\n\nA note.\n");
  git("init", "-q");
  git("config", "user.name", "Fixture Operator");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "the vault as it stood");
}, 180_000);

afterEach(async () => {
  await db.stop();
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe("runErase — the order of operations", () => {
  it("a database refusal leaves the vault byte-identical", async () => {
    await db.pool.query("DROP TABLE memory_reads");
    const before = readFileSync(join(vaultRoot, "people/ada.md"));

    const result = await runErase({
      db: db.pool,
      person: FIXTURE_OWNER,
      vaults: [vaultRoot],
      apply: true,
    });

    expect(result.dbReport.refusals.join(" ")).toContain("memory_reads");
    expect(result.vaults).toEqual([]);
    expect(existsSync(join(vaultRoot, "people/ada.md"))).toBe(true);
    expect(readFileSync(join(vaultRoot, "people/ada.md")).equals(before)).toBe(true);
  }, 240_000);

  it("removes the vault file, then clears its sync-state row, in one --apply run", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
       VALUES ('people/ada.md', 'p1', 'docs', 'two_way')`,
    );

    const result = await runErase({
      db: db.pool,
      person: FIXTURE_OWNER,
      vaults: [vaultRoot],
      apply: true,
    });

    expect(result.dbReport.refusals).toEqual([]);
    expect(existsSync(join(vaultRoot, "people/ada.md"))).toBe(false);
    expect(result.vaults[0]!.removed).toEqual(["people/ada.md"]);
    expect((await db.pool.query("SELECT 1 FROM notion_sync_docs")).rows).toHaveLength(0);
  }, 240_000);

  it("a vault pass that throws stops before the database is touched", async () => {
    write("projects/unrelated.md", "---\nowner: fixture-second\n---\nstaged by somebody else\n");
    git("add", "projects/unrelated.md");

    const before = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM standing_facts WHERE user_id = $1",
      [FIXTURE_OWNER],
    );
    expect(before.rows[0]!.n).toBeGreaterThan(0);

    const result = await runErase({
      db: db.pool,
      person: FIXTURE_OWNER,
      vaults: [vaultRoot],
      apply: true,
    });

    expect(result.vaultError).toMatch(/staged/i);
    expect(result.vaults).toEqual([]);

    const after = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM standing_facts WHERE user_id = $1",
      [FIXTURE_OWNER],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(existsSync(join(vaultRoot, "people/ada.md"))).toBe(true);
  }, 240_000);

  it("two vaults, the second one fails: the first one's removal is reported, never dropped, and the database is untouched", async () => {
    const second = mkdtempSync(join(tmpdir(), "run-erase-vault2-"));
    const g2 = (...args: string[]): string =>
      execFileSync("git", ["-C", second, ...args], { encoding: "utf8" });
    try {
      mkdirSync(join(second, "people"), { recursive: true });
      writeFileSync(join(second, "people/ada.md"), "---\nowner: fixture-owner\n---\n\nAnother note.\n");
      g2("init", "-q");
      g2("config", "user.name", "Fixture Operator");
      g2("config", "user.email", "fixture@example.invalid");
      g2("config", "commit.gpgsign", "false");
      g2("add", "-A");
      g2("commit", "-q", "-m", "the second vault as it stood");
      writeFileSync(join(second, "staged.md"), "---\nowner: fixture-second\n---\nstaged by somebody else\n");
      g2("add", "staged.md");

      const result = await runErase({
        db: db.pool,
        person: FIXTURE_OWNER,
        vaults: [vaultRoot, second],
        apply: true,
      });

      expect(result.vaultError).toMatch(/staged/i);
      expect(result.vaults.map((v) => v.vaultRoot)).toEqual([vaultRoot]);
      expect(result.vaults[0]!.commit).not.toBe(null);
      const md = renderRunEraseReport(result);
      expect(md).toContain(vaultRoot);
      expect(md).toMatch(/already been removed/i);
      expect(md).toMatch(/run the same command again/i);

      const after = await db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM standing_facts WHERE user_id = $1",
        [FIXTURE_OWNER],
      );
      expect(after.rows[0]!.n).toBeGreaterThan(0);
      expect(existsSync(join(second, "people/ada.md"))).toBe(true);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  }, 240_000);

  it("no --vault given: a real run still erases the database, and says the vault was not looked at", async () => {
    const result = await runErase({ db: db.pool, person: FIXTURE_OWNER, vaults: [], apply: true });
    expect(result.dbReport.refusals).toEqual([]);
    expect(result.noVaultGiven).toBe(true);
    expect(renderRunEraseReport(result)).toMatch(/vault was not looked at/i);
  }, 240_000);

  it("without --apply, nothing is written anywhere, and the report says so for both halves", async () => {
    const result = await runErase({
      db: db.pool,
      person: FIXTURE_OWNER,
      vaults: [vaultRoot],
      apply: false,
    });
    expect(existsSync(join(vaultRoot, "people/ada.md"))).toBe(true);
    expect(result.dbReport.dryRun).toBe(true);
    const md = renderRunEraseReport(result);
    expect(md).toMatch(/practice run/i);
    expect(md).toContain("people/ada.md");
  }, 240_000);

  it("names the push command per vault, and never runs it", async () => {
    const result = await runErase({
      db: db.pool,
      person: FIXTURE_OWNER,
      vaults: [vaultRoot],
      apply: true,
    });
    expect(git("log", "--oneline", "-1")).toContain("erase: 1 file(s) for one person");

    const md = renderRunEraseReport(result);
    expect(md).toContain(`git -C ${vaultRoot} push`);
  }, 240_000);
});
