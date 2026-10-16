// A guard against the numbering going wrong (ADR-0021 rule 3).
//
// This is a repository test, not runtime code: it reads services/box/sql (and each per-service
// sql/ folder) straight off disk every time it runs, so it keeps catching real mistakes as new
// files land, rather than only pinning what is true today.
//
// The box schema starts at one baseline file, 001_baseline.sql. Every later change is a new file
// numbered above the highest one already in the folder. What this guard catches is the mistake two
// people working in parallel are most likely to make: a duplicate number, or a new file that
// reuses a number below ones already in the repository.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { BASELINE_FILENAME, readMigrations } from "../lib/migration-runner.js";

const BOX = join(__dirname, "..", "sql");
const PER_SERVICE = ["chief-of-staff"].map((s) => join(__dirname, "..", "..", s, "sql"));

describe("the migration files in this repository", () => {
  it("every box migration is readable and numbered", () => {
    expect(() => readMigrations(BOX)).not.toThrow();
  });

  it("every per-service migration is readable and numbered", () => {
    for (const dir of PER_SERVICE) expect(() => readMigrations(dir)).not.toThrow();
  });

  it("starts at the baseline", () => {
    const [first] = readMigrations(BOX);
    expect(first?.filename).toBe(BASELINE_FILENAME);
    expect(first?.number).toBe(1);
  });

  it("has no duplicate numbers", () => {
    const counts = new Map<number, number>();
    for (const m of readMigrations(BOX)) counts.set(m.number, (counts.get(m.number) ?? 0) + 1);
    expect([...counts].filter(([, count]) => count > 1)).toEqual([]);
  });

  it("every file name matches its own number", () => {
    for (const m of readMigrations(BOX)) {
      expect(m.filename.startsWith(String(m.number).padStart(3, "0"))).toBe(true);
    }
  });

  it("no migration file is empty or comment-only", () => {
    for (const m of readMigrations(BOX)) {
      const code = m.bytes
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("--"))
        .join("");
      expect(code.length, `${m.filename} has no statements`).toBeGreaterThan(0);
    }
  });
});
