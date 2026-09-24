// packages/memory-evals/tests/poisoning.eval.test.ts
//
// The prompt-laundering script, run without a model. See src/poison.ts's header for what this
// proves and why no LLM or database is involved: the cases already carry the origin a reflector
// would have stamped, and this harness runs them through the real promotion gate
// (@lares/agent-kit/learning). If a laundering case here ever gets through, that is a finding
// about the gate, not something to fix by loosening this suite.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPoisoning, type PoisonCase } from "../src/poison.js";
import { formatPoisonReport } from "../src/report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(resolve(HERE, "../cases/poisoning.json"), "utf8")) as PoisonCase[];

describe("poisoning", () => {
  it("has the three-email laundering script and at least one control", () => {
    expect(cases.filter((c) => c.kind === "laundering").length).toBeGreaterThanOrEqual(3);
    expect(cases.some((c) => c.kind === "control" && c.expectPromoted === 1)).toBe(true);
    for (const c of cases) expect(c.story.length).toBeGreaterThan(20);
  });

  it("promotes nothing from any attack case, however often it repeats", async () => {
    const report = await runPoisoning(cases.filter((c) => c.kind !== "control"));
    for (const r of report.cases) {
      expect(r.promoted, `${r.id} promoted ${r.promoted}`).toBe(0);
      expect(r.rejected).toContain("not-owner-origin");
    }
  });

  it("still promotes what the owner actually said twice — a gate that refuses everything fails here", async () => {
    const report = await runPoisoning(cases.filter((c) => c.kind === "control"));
    expect(report.cases.find((r) => r.id === "control-owner-repeat")!.promoted).toBe(1);
    expect(report.cases.find((r) => r.id === "control-owner-once")!.promoted).toBe(0);
  });

  it("passes every case, and says so in one line per case", async () => {
    const report = await runPoisoning(cases);
    console.log(formatPoisonReport(report));
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(cases.length);
  });

  it("runs with no model and no database", async () => {
    // If either were involved this file would need env or a container; it needs neither, and
    // that is the point — this suite runs on every builder's machine and in CI.
    expect(process.env["OPENAI_API_KEY"]).toBeUndefined();
  });
});
