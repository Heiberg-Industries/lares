import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, "..", "lib");

// adapters/ is the ONLY place allowed to import vendor SDKs or zod.
//
// This scan is substring-based over each file's own source text — it checks direct
// imports, not the transitive import graph. lib/index.ts re-exports ./cli.js, which
// imports ./adapters/calendar-source.js, which reaches googleapis; that chain is by
// design. cli.ts is the composition root where dependencies are wired, and the
// adapters/ boundary is what keeps the pure core (config.ts, attendees.ts, run.ts,
// store.ts) free of vendor coupling. A file that merely imports the composition root
// is not itself vendor-coupled, so substring semantics — not a graph walk — are the
// intended semantics here.
const FORBIDDEN = ["@anthropic-ai", "@slack/", "telegraf", "from \"pg\"", "pg-boss", "\"zod\"", "googleapis"];

function collectTs(dir: string, skip: string[] = []): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (skip.some((s) => full.includes(s))) continue;
    if (entry.isDirectory()) result.push(...collectTs(full, skip));
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(full);
  }
  return result;
}

describe("notion-sync core vendor-neutrality", () => {
  it("no core lib file outside adapters/ imports a vendor SDK or zod", () => {
    const coreFiles = collectTs(libDir, ["adapters"]);
    expect(coreFiles.length, "core file set must not be empty").toBeGreaterThan(0);
    for (const file of coreFiles) {
      const src = readFileSync(file, "utf8");
      for (const bad of FORBIDDEN) {
        expect(src.includes(bad), `${file} must not reference ${bad}`).toBe(false);
      }
    }
  });

  it("carries no hard-coded project names — the mapping is config", () => {
    const names = ["Zero7", "Orakel", "heiberg", "Heiberg", "Vol de Nuit", "cratedigger"];
    // cli.ts names the two Google OAuth org suffixes, which are deployment env-var
    // names rather than content. Exempt those two literals ONLY — exempting the
    // whole file would leave any Heiberg content added there later unguarded.
    const allowedInCli = new Map([["cli.ts", ['"HEIBERG"', '"ZERO7"']]]);

    for (const file of collectTs(libDir)) {
      const exemptions = [...allowedInCli]
        .filter(([suffix]) => file.endsWith(suffix))
        .flatMap(([, literals]) => literals);
      // Blank out the exempt literals, then scan what is left of the file.
      const src = exemptions.reduce(
        (text, literal) => text.split(literal).join('""'),
        readFileSync(file, "utf8"),
      );
      for (const name of names) {
        expect(src.includes(name), `${file} must not hard-code "${name}"`).toBe(false);
      }
    }
  });
});
