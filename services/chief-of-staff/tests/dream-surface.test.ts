/**
 * W5X-s7 — `resolve()` is deleted, and pinned deleted.
 *
 * A deletion with a grep-shaped failing test; nothing to design.
 * The plan file calls this slice a deletion slice.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import * as surface from "../lib/dream/surface.js";

/**
 * Walk .ts files under the two roots, skip node_modules, dist, test files, and this test file,
 * return path:line for each match, excluding comments.
 */
function grepRepo(pattern: RegExp, roots: string[]): string[] {
  const fs = require("fs");
  const path = require("path");
  const results: string[] = [];

  function walk(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        // Skip exclusions
        // `.eve` and `.output` are gitignored build/dev-runtime trees: anyone who has run
        // `eve dev` here has old COPIES of the source in them, which are not the repo.
        if (["node_modules", "dist", "tests", ".eve", ".output"].includes(entry.name)) continue;
        if (fullPath.includes("dream-surface.test.ts")) continue;

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
          const content = fs.readFileSync(fullPath, "utf8");
          const lines = content.split("\n");
          lines.forEach((line: string, idx: number) => {
            // Skip comments and empty lines
            const trimmed = line.trim();
            if (trimmed.startsWith("//") || trimmed.startsWith("*") || !trimmed) return;
            if (pattern.test(line)) {
              results.push(`${fullPath}:${idx + 1}`);
            }
          });
        }
      }
    } catch {
      // Skip unreadable dirs
    }
  }

  for (const root of roots) {
    walk(root);
  }

  return results;
}

describe("dream/surface.ts deletion", () => {
  it("has no resolve path left: the proposal lane is the only way to answer a confirmation", () => {
    expect(Object.keys(surface).sort()).toEqual([
      "DREAM_CONFIRM_MAX_PER_RUN",
      "deriveRef",
      "selectForConfirmation",
    ]);
  });

  it("names nobody", () => {
    const src = readFileSync(join(__dirname, "../lib/dream/surface.ts"), "utf8");
    expect(src).not.toMatch(/\b(Saga|Marcel|Calliope|Bendik|bendik|heiberg)\b/);
  });

  it("is not reached by any other module", () => {
    const hits = grepRepo(
      /makeIdentitySurfacer|SurfacerStore|surfacer\.resolve|buildProposalText|buildConfirmationNotice/,
      [
        `${__dirname}/../../`,
        `${__dirname}/../../../packages`,
      ],
    );
    expect(hits).toEqual([]);
  });
});
