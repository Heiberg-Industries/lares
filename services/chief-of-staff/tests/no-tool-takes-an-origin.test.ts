import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The origin spec's hard rule (docs/specs/2026-09-18-origin-model-design.md:108-114): no
 * model-facing tool anywhere accepts an origin argument. A tool schema that ever grows an
 * `origin`, `source` or `class` field the model can set is the design defect this test exists
 * to catch. Read as TEXT, the engine-drift.test.ts technique — it needs no runtime and cannot
 * be fooled by a re-export.
 */
const FORBIDDEN = /^\s*(origin|source|class|lares_origin|provenance|trust)\s*:\s*z\./m;

function schemaBlocks(src: string): string[] {
  const out: string[] = [];
  let i = src.indexOf("inputSchema:");
  while (i !== -1) {
    out.push(src.slice(i, src.indexOf("\n  }", i) + 4 || src.length));
    i = src.indexOf("inputSchema:", i + 1);
  }
  return out;
}

/**
 * DEVIATION FROM THE SLICE'S GIVEN TEST CODE, and why (reported per BUILDER.md).
 *
 * The plan's literal fixture scans only `services/chief-of-staff/catalogue`. Running it as
 * given surfaces two real gaps:
 *
 *  1. Three of chief-of-staff's own catalogue entries — `agent-kit__vault_write.ts` among them,
 *     the exact file this slice changes — are THIN RE-EXPORTS with no `inputSchema:` text of
 *     their own (`import { vault_write } from "@lares/agent-kit/tools"; export default
 *     vault_write;`). The schema this test cares about lives in
 *     `packages/agent-kit/extension/tools/*.ts`, which a chief-of-staff-only scope never reads.
 *     This docstring's own claim above ("cannot be fooled by a re-export") is true of the
 *     text-matching technique in isolation, but was false of the given SCOPE, which never
 *     looked at the re-export's target — the vault write tools would have been invisible to
 *     this guard. So the kit's own tools directory is scanned directly, not only through the
 *     mount.
 *  2. W3A-s5's own register-completeness audit (`origin-taint-reads.test.ts:11-19`) already
 *     established the precedent that a catalogue-wide guard in this track enumerates the THREE
 *     role services (chief-of-staff, travel, creative) straight off the filesystem, not one —
 *     "a tool added to any catalogue later and left unclassified fails this suite until someone
 *     looks at it." Matched here for the same reason: a tool added to travel's or creative's
 *     catalogue with an origin field must fail this suite too, not only a chief-of-staff one.
 */
const CATALOGUE_DIRS: ReadonlyArray<{ label: string; dir: string; minFiles: number }> = [
  { label: "chief-of-staff/catalogue", dir: join(__dirname, "..", "catalogue"), minFiles: 50 },
  { label: "travel/catalogue", dir: join(__dirname, "..", "..", "travel", "catalogue"), minFiles: 15 },
  { label: "creative/catalogue", dir: join(__dirname, "..", "..", "creative", "catalogue"), minFiles: 3 },
  {
    label: "agent-kit/extension/tools",
    dir: join(__dirname, "..", "..", "..", "packages", "agent-kit", "extension", "tools"),
    minFiles: 8,
  },
];

/**
 * KNOWN, DOCUMENTED EXCEPTION — not a re-interpretation of the rule. `deadline_add.ts`'s
 * `source` field classifies WHAT KIND of obligation this is (statutory/accounting/contract/
 * subscription/manual/renewal — none of them an Origin class) — a business classification the
 * model reports as ordinary content, unrelated to this spec's five-class provenance vocabulary
 * (owner/agent/synced/system/third_party) and predating this spec entirely (ORB-180's deadline
 * tracker). A naming collision only, scoped to this one field on this one file so every OTHER
 * field — on this file or any other, today or added later — still fails until it complies.
 */
const KNOWN_EXCEPTIONS: Record<string, readonly string[]> = {
  "deadline_add.ts": ["source"],
};

function withoutKnownExceptions(file: string, block: string): string {
  const exceptions = KNOWN_EXCEPTIONS[file];
  if (!exceptions) return block;
  return block
    .split("\n")
    .filter((line) => !exceptions.some((name) => new RegExp(`^\\s*${name}\\s*:\\s*z\\.`).test(line)))
    .join("\n");
}

describe("no model-facing tool accepts an origin", () => {
  for (const { label, dir, minFiles } of CATALOGUE_DIRS) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts");

    it(`covers ${label}`, () => {
      expect(files.length).toBeGreaterThan(minFiles);
    });

    for (const f of files) {
      it(`${label}/${f} takes only content fields`, () => {
        for (const block of schemaBlocks(readFileSync(join(dir, f), "utf8"))) {
          expect(withoutKnownExceptions(f, block)).not.toMatch(FORBIDDEN);
        }
      });
    }
  }
});
