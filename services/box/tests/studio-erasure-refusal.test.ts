import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startThreeSpellingsDb, FIXTURE_OWNER, type TestDb } from "./helpers/three-spellings.js";
import { runErase } from "../lib/run-erase.js";
import { HostFinancialJournal } from "../../keeper/lib/financial-journal.js";
import { observeFinancialDatabase } from "../../keeper/lib/financial-continuity.js";
import { platformTestJournalLock, testJournalUid } from "../../keeper/tests/helpers/financial-journal.js";

let db: TestDb | undefined;
let journal: HostFinancialJournal | undefined;
let parent: string | undefined;
let vault: string | undefined;

afterEach(async () => {
  journal?.close();
  if (db) await db.stop();
  if (parent) rmSync(parent, { recursive: true, force: true });
});

describe("studio history erasure refusal", () => {
  it("stops an apply before removing vault files when a legacy studio owner is unknown", async () => {
    db = await startThreeSpellingsDb({ vaultAreas: false, beforeMigration: async (pool, migration) => {
      if (migration !== "028_studio_ownership.sql") return;
      await pool.query(`CREATE TABLE studio_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brief text NOT NULL, consensus text NOT NULL,
        spread jsonb NOT NULL, picks jsonb, principal text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
      await pool.query(`INSERT INTO studio_runs(brief,consensus,spread,principal)
        VALUES('private legacy brief','legacy grounding','[]'::jsonb,'U_legacy')`);
    }});

    parent = mkdtempSync(join(realpathSync(tmpdir()), "studio-erasure-refusal-"));
    vault = join(parent, "vault");
    mkdirSync(join(vault, "people"), { recursive: true });
    const note = join(vault, "people", "fixture-owner.md");
    writeFileSync(note, `---\nowner: ${FIXTURE_OWNER}\nscope: private\n---\n\nPrivate fixture note.\n`);
    execFileSync("git", ["-C", vault, "init", "--quiet"]);
    execFileSync("git", ["-C", vault, "config", "user.name", "Fixture Operator"]);
    execFileSync("git", ["-C", vault, "config", "user.email", "fixture@example.invalid"]);
    execFileSync("git", ["-C", vault, "add", "--", "people/fixture-owner.md"]);
    execFileSync("git", ["-C", vault, "commit", "--quiet", "-m", "fixture note"]);
    const original = readFileSync(note);
    const head = execFileSync("git", ["-C", vault, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const custodyRoot = join(parent, "custody");
    const preparation = HostFinancialJournal.prepareFresh(custodyRoot, await observeFinancialDatabase(db.pool), {
      ownershipUid: testJournalUid,
      lock: platformTestJournalLock,
    });
    try { preparation.complete(); } finally { preparation.close(); }
    journal = HostFinancialJournal.openExisting(custodyRoot, {
      ownershipUid: testJournalUid,
      lock: platformTestJournalLock,
      requirePrepared: true,
    });

    const result = await runErase({ db: db.pool, person: FIXTURE_OWNER, vaults: [vault], apply: true, journal });

    expect(result.dbReport.refusals.join(" ")).toMatch(/studio history contains records with no recorded owner/i);
    expect(result.vaults).toEqual([]);
    expect(existsSync(note)).toBe(true);
    expect(readFileSync(note).equals(original)).toBe(true);
    expect(execFileSync("git", ["-C", vault, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(head);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM studio_runs WHERE owner_member_id IS NULL")).rows[0].n).toBe(1);
  }, 240_000);
});
