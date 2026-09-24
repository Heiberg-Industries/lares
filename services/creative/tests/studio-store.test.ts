/**
 * `lib/studio/store.ts` (ORB-135) — the run-history writer Task 5 calls after every spread.
 *
 * These use a recording fake pool, and that is a deliberate limit: per the ORB-45 lesson a fake
 * that never executes SQL cannot prove the statement is VALID Postgres. It is not trying to.
 * What it proves is the two things the PORT could have broken — that the inlined `MiniPool`
 * type still accepts a pool-shaped object without the old runtime's `heartbeat.ts`, and that the
 * insert still writes the same four columns into the same unqualified `studio_runs` table that
 * the old Calliope has been writing to on `lares_state`. The statement itself is unchanged from
 * a table that already exists and is already in daily use, so the remaining risk is the wiring,
 * which is what is checked here. A container test would earn its place the day the SQL changes.
 */
import { describe, it, expect } from "vitest";
import { ensureStudioTables, makeStudioStore, type MiniPool } from "../lib/studio/store.js";
import type { StudioRun } from "../lib/studio/types.js";

function fakeDb() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db: MiniPool & { calls: typeof calls } = {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: /INSERT INTO studio_runs/.test(sql) ? [{ id: "run-1" }] : [] };
    },
  };
  return db;
}

const run: StudioRun = {
  brief: "three wedges for murmur",
  consensus: "murmur turns meetings into structured notes",
  spread: [{
    id: "l1-0", lens: "l1", title: "An idea", body: "why", oddsTypical: 0.2,
    coherence: 0.9, novelty: 0.8, relevance: 0.7, kind: "outlier", rationale: "bold",
  }],
};

describe("studio store (ported)", () => {
  /** Idempotent by construction — it runs on every startup, and on the box the table already
   *  exists because old Calliope created it. `IF NOT EXISTS` is why no hand-applied DDL is
   *  needed for this table (unlike sql/001-eve-workflow.sql, which does need applying). */
  it("ensureStudioTables issues an idempotent, UNQUALIFIED create", async () => {
    const db = fakeDb();
    await ensureStudioTables(db);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.sql).toMatch(/CREATE TABLE IF NOT EXISTS studio_runs/);
    // No schema prefix: the table lands in whatever database DATABASE_URL points at, which the
    // port keeps on lares_state so her run history carries across the cutover.
    expect(db.calls[0]!.sql).not.toMatch(/studio_runs\s*\./);
    expect(db.calls[0]!.sql).not.toMatch(/\w+\.studio_runs/);
  });

  /** The row Task 5 will write. `spread` must be serialised — handing the array straight to pg
   *  writes a Postgres array literal into a jsonb column and fails at runtime, not at compile. */
  it("recordRun writes brief, consensus, serialised spread and principal, returning the id", async () => {
    const db = fakeDb();
    const { id } = await makeStudioStore(db).recordRun(run, { principal: "U_bendik" });

    expect(id).toBe("run-1");
    const insert = db.calls.find((c) => /INSERT INTO studio_runs/.test(c.sql))!;
    expect(insert.sql).toMatch(/\(brief, consensus, spread, principal\)/);
    expect(insert.params).toEqual([
      run.brief, run.consensus, JSON.stringify(run.spread), "U_bendik",
    ]);
    expect(JSON.parse(String(insert.params![2])) as unknown).toEqual(run.spread);
  });
});
