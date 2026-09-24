import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeEdgeStateStore } from "../src/markets/edge-state.js";
import type { MarketsPool } from "../src/markets/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "..", "..", "services", "box", "sql");
const sql = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

// Adapted from services/agent-runtime/tests/tyche-alert-state-store.test.ts (ORB-189 Task 1).
// The runtime's version drove `record` (the write half, which stays behind with the retired
// survey loop) and read it back. The kit keeps only `get`, so the fake pool returns pg-shaped
// rows: numerics as strings, timestamptz as Dates.
function poolReturning(rows: Record<string, any>[]): { pool: MarketsPool; seen: unknown[][]; sql: string[] } {
  const seen: unknown[][] = [];
  const sql: string[] = [];
  return {
    seen, sql,
    pool: { async query(s: string, params?: unknown[]) { sql.push(s); seen.push(params ?? []); return { rows }; } },
  };
}

const stateRow = (over: Record<string, any> = {}) => ({
  market_id: "m1",
  outcome_id: "o1",
  last_edge: "0.05",
  last_basis: "0.4",
  last_alerted_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-02-02T09:30:00.000Z"),
  ...over,
});

describe("makeEdgeStateStore", () => {
  it("get returns null when nothing was ever recorded", async () => {
    const { pool } = poolReturning([]);
    expect(await makeEdgeStateStore(pool).get({ marketId: "m1", outcomeId: "o1" })).toBeNull();
  });

  it("get maps the row, coercing numeric strings to numbers", async () => {
    const { pool, seen } = poolReturning([stateRow()]);
    const st = await makeEdgeStateStore(pool).get({ marketId: "m1", outcomeId: "o1" });
    expect(seen[0]).toEqual(["m1", "o1"]);
    expect(st).not.toBeNull();
    expect(typeof st!.lastEdge).toBe("number");
    expect(st!.lastEdge).toBeCloseTo(0.05, 6);
    expect(st!.lastBasis).toBeCloseTo(0.4, 6);
    expect(st!.lastAlertedAtIso).toBe("2026-01-01T00:00:00.000Z");
  });

  it("recordedAtIso is the row's updated_at — when the edge was RECORDED, not re-quoted", async () => {
    const { pool } = poolReturning([stateRow()]);
    const st = await makeEdgeStateStore(pool).get({ marketId: "m1", outcomeId: "o1" });
    expect(st!.recordedAtIso).toBe("2026-02-02T09:30:00.000Z");
  });

  it("an outcome measured but never announced has recordedAtIso set and lastAlertedAtIso null", async () => {
    const { pool } = poolReturning([stateRow({ last_alerted_at: null })]);
    const st = await makeEdgeStateStore(pool).get({ marketId: "m1", outcomeId: "o1" });
    expect(st!.lastAlertedAtIso).toBeNull();
    expect(st!.recordedAtIso).toBe("2026-02-02T09:30:00.000Z");
  });

  it("null edge and basis stay null — an unmeasured edge is not a zero edge", async () => {
    const { pool } = poolReturning([stateRow({ last_edge: null, last_basis: null })]);
    const st = await makeEdgeStateStore(pool).get({ marketId: "m1", outcomeId: "o1" });
    expect(st!.lastEdge).toBeNull();
    expect(st!.lastBasis).toBeNull();
  });

  it("`get` is still a pure SELECT, and the surface is get + the refresh job's `record`", async () => {
    const { pool, sql } = poolReturning([]);
    const store = makeEdgeStateStore(pool);
    expect(Object.keys(store).sort()).toEqual(["get", "record"]);
    await store.get({ marketId: "m1", outcomeId: "o1" });
    expect(sql[0].trim().startsWith("SELECT")).toBe(true);
    expect(/\b(INSERT|UPDATE|DELETE)\b/i.test(sql[0])).toBe(false);
  });

  it("record never sends an alert time it was not given — the job passes null every time", async () => {
    const { pool, seen } = poolReturning([]);
    await makeEdgeStateStore(pool).record({ marketId: "m1", outcomeId: "o1", edge: 0.05, basis: 0.4, alertedAtIso: null });
    expect(seen[0]).toEqual(["m1", "o1", 0.05, 0.4, null]);
  });
});

// ── the write half, against a REAL Postgres ──────────────────────────────────────────────────
//
// `record`'s whole subtlety is one SQL word: the COALESCE that keeps a PRIOR `last_alerted_at`
// when this call did not alert. A fake pool can only show the parameters going in; it cannot show
// what the row keeps. Since the refresh job passes `alertedAtIso: null` on EVERY call (it never
// announces anything), this is the assertion that a nightly re-quote cannot erase the record of
// an alert some other era fired. DDL is `sql/037_tyche.sql` (LAR-32), applied verbatim from disk.
describe("makeEdgeStateStore write half against real Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(sql("037_tyche.sql"));
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE tyche_alert_state");
  });

  it("record inserts a measured edge with no alert time at all", async () => {
    const store = makeEdgeStateStore(pool);
    await store.record({ marketId: "m1", outcomeId: "spain", edge: 0.0213, basis: 0.32, alertedAtIso: null });
    const st = await store.get({ marketId: "m1", outcomeId: "spain" });
    expect(st!.lastEdge).toBeCloseTo(0.0213, 6);
    expect(st!.lastBasis).toBeCloseTo(0.32, 6);
    expect(st!.lastAlertedAtIso).toBeNull();
    expect(Number.isFinite(Date.parse(st!.recordedAtIso!))).toBe(true);
  });

  it("a second record overwrites edge and basis and ADVANCES updated_at", async () => {
    const store = makeEdgeStateStore(pool);
    await store.record({ marketId: "m1", outcomeId: "spain", edge: 0.02, basis: 0.32, alertedAtIso: null });
    const first = (await store.get({ marketId: "m1", outcomeId: "spain" }))!.recordedAtIso!;
    await new Promise((r) => setTimeout(r, 10));
    await store.record({ marketId: "m1", outcomeId: "spain", edge: -0.04, basis: 0.28, alertedAtIso: null });
    const st = (await store.get({ marketId: "m1", outcomeId: "spain" }))!;
    expect(st.lastEdge).toBeCloseTo(-0.04, 6);
    expect(st.lastBasis).toBeCloseTo(0.28, 6);
    expect(Date.parse(st.recordedAtIso!)).toBeGreaterThan(Date.parse(first));
  });

  it("a null alertedAtIso KEEPS a prior last_alerted_at — the COALESCE, proved against the real row", async () => {
    const store = makeEdgeStateStore(pool);
    await pool.query(
      `INSERT INTO tyche_alert_state (market_id, outcome_id, last_edge, last_basis, last_alerted_at)
       VALUES ($1,$2,$3,$4,$5)`,
      ["m1", "spain", 0.09, 0.5, "2026-01-01T00:00:00.000Z"],
    );

    await store.record({ marketId: "m1", outcomeId: "spain", edge: 0.01, basis: 0.31, alertedAtIso: null });

    const st = (await store.get({ marketId: "m1", outcomeId: "spain" }))!;
    expect(st.lastEdge).toBeCloseTo(0.01, 6);
    expect(st.lastAlertedAtIso).toBe("2026-01-01T00:00:00.000Z"); // never advanced by a re-quote
  });

  it("record scopes to one (market, outcome) — a sibling outcome is untouched", async () => {
    const store = makeEdgeStateStore(pool);
    await store.record({ marketId: "m1", outcomeId: "a", edge: 0.01, basis: 0.3, alertedAtIso: null });
    await store.record({ marketId: "m1", outcomeId: "b", edge: 0.02, basis: 0.4, alertedAtIso: null });
    await store.record({ marketId: "m1", outcomeId: "a", edge: 0.05, basis: 0.33, alertedAtIso: null });
    expect((await store.get({ marketId: "m1", outcomeId: "b" }))!.lastEdge).toBeCloseTo(0.02, 6);
    expect((await store.get({ marketId: "m1", outcomeId: "a" }))!.lastEdge).toBeCloseTo(0.05, 6);
  });
});
