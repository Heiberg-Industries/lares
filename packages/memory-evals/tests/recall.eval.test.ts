// packages/memory-evals/tests/recall.eval.test.ts
//
// W0-4a — the recall baseline. See README.md for what this measures (and
// does not). No model, no Docker, no network: this is `searchNotes` from
// @lares/agent-kit/notes-store run over a fixed fixture vault and a fixed
// question set, scored deterministically.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runRecall, type CaseKind, type KindStats, type RecallCase } from "../src/run.js";
import { formatReport } from "../src/report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const VAULT = join(PKG_ROOT, "fixtures/vault");
const CASES_PATH = join(PKG_ROOT, "cases/recall.json");
const BASELINE_PATH = join(PKG_ROOT, "baseline.json");

interface BaselineFile {
  recordedAt: string;
  engine: string;
  overall: KindStats;
  byKind: Record<CaseKind, KindStats>;
}

const cases: RecallCase[] = JSON.parse(readFileSync(CASES_PATH, "utf8"));

/** Every markdown file under the fixture vault, including `_meta` — unlike
 *  notes-store's own walk, this one does NOT exclude anything, because the
 *  point here is to validate the fixture itself (including the one file
 *  that must never come back from search). */
function allMarkdownFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...allMarkdownFiles(abs, base));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      out.push(relative(base, abs).split("\\").join("/"));
    }
  }
  return out;
}

function frontmatterType(raw: string): string | undefined {
  if (!raw.startsWith("---\n")) return undefined;
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return undefined;
  const head = raw.slice(4, end);
  const m = head.match(/^type:\s*(.+)$/m);
  return m?.[1]?.trim();
}

describe("fixture vault", () => {
  const vaultFiles = allMarkdownFiles(VAULT);

  it("has between 30 and 36 notes across wiki/ and journal/ (excluding _meta)", () => {
    const counted = vaultFiles.filter((f) => !f.startsWith("_meta/"));
    expect(counted.length).toBeGreaterThanOrEqual(30);
    expect(counted.length).toBeLessThanOrEqual(36);
  });

  it("gives every fixture note frontmatter with a `type:` key", () => {
    for (const f of vaultFiles) {
      const raw = readFileSync(join(VAULT, f), "utf8");
      const type = frontmatterType(raw);
      expect(type, `${f} has no \`type:\` in its frontmatter`).toBeTruthy();
    }
  });

  it("has at least one file under _meta/conversations/2026-09-01/", () => {
    expect(vaultFiles.some((f) => f.startsWith("_meta/conversations/2026-09-01/"))).toBe(true);
  });

  it("has an `expect` path for every case that actually exists in the vault", () => {
    for (const c of cases) {
      for (const p of c.expect) {
        expect(vaultFiles, `case "${c.id}" expects "${p}", which is not in the fixture vault`).toContain(p);
      }
    }
  });
});

describe("cases/recall.json", () => {
  it("has 28-32 cases with at least 3 of each kind", () => {
    expect(cases.length).toBeGreaterThanOrEqual(28);
    expect(cases.length).toBeLessThanOrEqual(32);
    const byKind = new Map<string, number>();
    for (const c of cases) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
    for (const [kind, n] of byKind) {
      expect(n, `kind "${kind}" has only ${n} case(s)`).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives every excluded-kind case an empty expect list", () => {
    for (const c of cases.filter((c) => c.kind === "excluded")) {
      expect(c.expect).toEqual([]);
    }
  });
});

describe("runRecall", () => {
  const report = runRecall(VAULT, cases);

  it("runs every case and logs the recall report", () => {
    expect(report.overall.n).toBe(cases.length);
    console.log(formatReport(report));
  });

  it("never returns a path under _meta/ for an excluded-kind case", () => {
    for (const r of report.results.filter((r) => r.kind === "excluded")) {
      const leaked = r.hits.filter((h) => h === "_meta" || h.startsWith("_meta/"));
      expect(leaked, `case "${r.id}" returned _meta path(s): ${leaked.join(", ")}`).toEqual([]);
    }
  });

  if (process.env.UPDATE_BASELINE === "1") {
    it("records the baseline", () => {
      const baseline: BaselineFile = {
        recordedAt: new Date().toISOString().slice(0, 10),
        engine: "notes-store keyword search",
        overall: report.overall,
        byKind: report.byKind,
      };
      writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
      expect(report.overall.n).toBe(cases.length);
    });
  } else {
    it("does not fall below the committed baseline (tolerance 1e-9)", () => {
      const baseline: BaselineFile = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
      const TOL = 1e-9;
      expect(report.overall.hitAt3).toBeGreaterThanOrEqual(baseline.overall.hitAt3 - TOL);
      expect(report.overall.mrr).toBeGreaterThanOrEqual(baseline.overall.mrr - TOL);
    });
  }
});
