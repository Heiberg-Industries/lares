// export-runbook.test.ts (LAR-21-s3) — the leave-cleanly runbook is kept honest against the
// script it documents.
//
// `docs/runbooks/export-and-teardown.md` is the written procedure for taking an installation
// somewhere else and then erasing the one left behind. A runbook that has drifted from the
// script is worse than no runbook: it reads as if someone checked. So this file asserts the
// four things that would actually hurt if they went stale, plus the two house rules.
//
// 1. EVERY SETTING THE SCRIPT READS IS NAMED. export.sh's defaults are narrower than the
//    nightly backup's path list, so an owner who does not set EXPORT_VAULT_PATHS and
//    EXPORT_DATA_PATHS leaves data behind without being told which. The names are extracted
//    from the script itself (`${NAME:-default}`), never listed by hand here, so a new setting
//    fails this test until the runbook mentions it.
// 2. EVERY FILE NAME THE ARCHIVE CONTAINS IS NAMED — the owner has to recognise what they are
//    looking at when they unpack it, and the proof step in section 4 is per-file-kind.
// 3. THE PROOF COMES BEFORE THE DESTRUCTION. Every destructive block in the runbook is marked
//    with a `# DESTRUCTIVE` comment line, and all four readability checks (checksums,
//    `pg_restore --list`, `git bundle verify`, `tar -tf`) must appear earlier in the document
//    than the first of those markers. This is the slice's stated acceptance test.
// 4. No person, host or installation is named (CLAUDE.md: this repository is the engine), and
//    the word the install decision retired is not used (docs/decisions/0022, "tested path").
//
// Text only: nothing here runs the script, touches Docker, or reads anything outside the repo.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "export.sh");
const RUNBOOK = join(here, "..", "..", "..", "docs", "runbooks", "export-and-teardown.md");

const script = readFileSync(SCRIPT, "utf8");
const runbook = readFileSync(RUNBOOK, "utf8");

/** Every environment variable export.sh reads, taken from the script's own `${NAME:-default}`
 *  forms — the only way it reads a setting. Extracted, not transcribed, so the list cannot
 *  fall behind the script. */
function settingsTheScriptReads(): string[] {
  const names = new Set<string>();
  for (const m of script.matchAll(/\$\{([A-Z][A-Z0-9_]*):-/g)) names.add(m[1]!);
  return [...names].sort();
}

/** The position of the first `# DESTRUCTIVE` marker line, or -1. */
function firstDestructiveAt(): number {
  return runbook.search(/^\s*# DESTRUCTIVE\b/m);
}

describe("the export-and-teardown runbook", () => {
  it("names every setting export.sh reads", () => {
    const names = settingsTheScriptReads();
    // A sanity floor: if the extraction ever silently matches nothing, the loop below would
    // pass vacuously and this test would stop protecting anything.
    expect(names.length).toBeGreaterThanOrEqual(7);
    const missing = names.filter((n) => !runbook.includes(n));
    expect(missing).toEqual([]);
  });

  it("names every kind of file the archive holds", () => {
    for (const name of ["globals.sql", ".dump", ".bundle", ".tar", "manifest.json"]) {
      expect(runbook).toContain(name);
    }
  });

  it("proves the export is readable before the first destructive command", () => {
    const destructiveAt = firstDestructiveAt();
    expect(destructiveAt).toBeGreaterThan(-1);
    for (const proof of ["sha256sum -c", "pg_restore --list", "git bundle verify", "tar -tf"]) {
      const at = runbook.indexOf(proof);
      expect(at, `the runbook never runs \`${proof}\``).toBeGreaterThan(-1);
      expect(at, `\`${proof}\` comes after the first destructive block`).toBeLessThan(destructiveAt);
    }
  });

  it("names no person, host or installation", () => {
    const matches = runbook.match(/Saga|Marcel|Calliope|bendik|heiberg|zero7|100\.76/gi) ?? [];
    expect(matches).toEqual([]);
  });

  it("says 'tested path', never the word docs/decisions/0022 retired", () => {
    expect(runbook.toLowerCase()).not.toContain("supported");
  });
});
