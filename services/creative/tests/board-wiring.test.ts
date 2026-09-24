// Every gated tool asks the permissions board, by its own name; every always-ask tool this service
// ships carries the check. A bare `approval: always()` would ignore the board forever.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mustAlwaysAsk, TOOL_CATEGORIES } from "@lares/agent-kit/always-ask";
import { describe, expect, it } from "vitest";

// BOTH directories, since ORB-278 step 2 (ADR-0015 rule 3): the real tools live in the
// `catalogue/` pool and what is left under agent/tools/ is the `disableTool()` sentinels plus the
// one resolver. Reading only agent/tools/ would have left `vault_write` — the single gated tool
// this whole file exists to watch — unchecked, and every assertion below vacuously green.
const here = dirname(fileURLToPath(import.meta.url));
const DIRS = [join(here, "../agent/tools"), join(here, "../catalogue")];
const paths = new Map<string, string>();
for (const dir of DIRS) {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "index.ts")) {
    paths.set(f, join(dir, f));
  }
}
const files = [...paths.keys()].sort();
const src = (f: string) => readFileSync(paths.get(f)!, "utf8");
// The two meeting follow-up tools keep their own series-level check (ORB-156) — board-controlled contact.
const OWN_POLICY = new Set(["meeting_followup_auto.ts", "meeting_followup_send.ts"]);

describe("board wiring", () => {
  it("no tool carries a bare always() any more", () => {
    expect(files.filter((f) => /approval:\s*always\(\)/.test(src(f)))).toEqual([]);
  });
  it("each approvalFor names its own tool", () => {
    const wrong = files.filter((f) => {
      const m = /approvalFor\("([^"]+)"\)/.exec(src(f));
      return m && m[1] !== basename(f, ".ts");
    });
    expect(wrong).toEqual([]);
  });
  it("every always-ask tool here carries the check", () => {
    const missing = files
      .filter((f) => !OWN_POLICY.has(f) && !/disableTool/.test(src(f)))
      .map((f) => basename(f, ".ts"))
      .filter((t) => TOOL_CATEGORIES[t] !== undefined && mustAlwaysAsk(t).ask)
      .filter((t) => !src(`${t}.ts`).includes(`approvalFor("${t}")`));
    expect(missing).toEqual([]);
  });
});
