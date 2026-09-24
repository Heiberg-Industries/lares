// A guard against the numbering going wrong (ADR-0021 rule 3).
//
// This is a repository test, not runtime code — it reads services/box/sql (and each
// per-service sql/ folder) straight off disk every time it runs, so it keeps catching real
// mistakes as new files land, rather than only pinning what is true today.
//
// Historical facts this guard must accept and never flag, pinned so nobody "fixes" them by
// renaming, and so a future reader does not mistake them for the bug this test exists to catch:
//
//   - 019 is used by two files (019_atlas_sync.sql, 019_obligations.sql). Grandfathered.
//   - 047 does not exist (claimed by LAR-22-s1, never built) and may never exist. A gap is not a
//     mistake — migration-runner.ts's own header says the runner never demands a gapless
//     sequence, it only refuses to slot a new file beneath work a database has already applied.
//   - 063-066 belongs to a different session working in parallel on its own number block. It may
//     or may not have landed in a given checkout (063_deadline_renewals.sql already has, in
//     others); either way it is not this programme's range and this guard has nothing to say
//     about it — it is neither asserted present nor absent. One exception: 066 was reserved for
//     LAR-21's erasure log and is now RELEASED and permanently unused — 076_forget_ledger.sql IS
//     that log. Never file a second erasure ledger, and never use 066.
//   - 067-069 sits between that other session's block (063-066) and this programme's own 070+
//     block. Nobody owns it: it is an intentional gap, deliberately left empty, not a claim left
//     unbuilt. If a file ever appears there, that IS the numbering going wrong — this programme's
//     own later work already reaches past it, so a database that has applied any of that later
//     work would refuse a late-arriving 067-069 file as "out of order". Better to catch the
//     mistake here than on a live installation.
//
// What this guard exists to catch, going forward, is exactly the two mistakes two sessions
// working in parallel are most likely to make: a NEW duplicate number, or a new file that reuses
// a number below the ones already in the repository without checking first.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readMigrations } from "../lib/migration-runner.js";

const BOX = join(__dirname, "..", "sql");
const PER_SERVICE = ["chief-of-staff"].map((s) => join(__dirname, "..", "..", s, "sql"));

const GRANDFATHERED_DUPLICATE_NUMBERS = [19];
const INTENTIONAL_GAP_BETWEEN_THE_OTHER_SESSION_AND_070_PLUS = [67, 68, 69];

describe("the migration files in this repository", () => {
  it("every box migration is readable and numbered", () => {
    expect(() => readMigrations(BOX)).not.toThrow();
  });

  it("every per-service migration is readable and numbered", () => {
    for (const dir of PER_SERVICE) expect(() => readMigrations(dir)).not.toThrow();
  });

  it("tolerates today's two 019s, and pins that fact so nobody 'fixes' it by renaming", () => {
    const nineteens = readMigrations(BOX)
      .filter((m) => m.number === 19)
      .map((m) => m.filename);
    expect(nineteens).toEqual(["019_atlas_sync.sql", "019_obligations.sql"]);
  });

  it("tolerates the gap at 047, and pins it", () => {
    const numbers = new Set(readMigrations(BOX).map((m) => m.number));
    expect(numbers.has(47)).toBe(false);
  });

  it("has no NEW duplicate numbers beyond the one grandfathered pair", () => {
    const counts = new Map<number, number>();
    for (const m of readMigrations(BOX)) counts.set(m.number, (counts.get(m.number) ?? 0) + 1);
    const dupes = [...counts]
      .filter(([, count]) => count > 1)
      .map(([number]) => number)
      .sort((a, b) => a - b);
    expect(dupes).toEqual(GRANDFATHERED_DUPLICATE_NUMBERS);
  });

  it("keeps the 067-069 gap empty between the other session's block and this programme's 070+", () => {
    const numbers = new Set(readMigrations(BOX).map((m) => m.number));
    for (const n of INTENTIONAL_GAP_BETWEEN_THE_OTHER_SESSION_AND_070_PLUS) {
      expect(numbers.has(n), `${n} should stay an intentional gap, not a filed migration`).toBe(false);
    }
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
