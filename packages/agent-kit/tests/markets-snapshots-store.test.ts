import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeSnapshotsStore } from "../src/markets/snapshots-store.js";
import type { MarketsPool } from "../src/markets/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "..", "..", "services", "box", "sql");
const sql = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

// Adapted from services/agent-runtime/tests/tyche-snapshots-store.test.ts (ORB-189 Task 1).
// The runtime's version seeded through append(); the kit's store is the READ half only, so the
// fake pool hands back pg-shaped rows — numerics as STRINGS and bigserial as a string, which is
// what node-postgres really does and what the Number() coercion exists for.
function poolReturning(rows: Record<string, any>[]): { pool: MarketsPool; seen: unknown[][] } {
  const seen: unknown[][] = [];
  return {
    seen,
    pool: { async query(_sql: string, params?: unknown[]) { seen.push(params ?? []); return { rows }; } },
  };
}

const snap = (over: Record<string, any> = {}) => ({
  id: "42",                      // bigserial → string
  market_id: "m1",
  outcome_id: "tok-1",
  label: "Spain",
  venue: "polymarket",
  bid: "0.15",
  ask: "0.16",
  mid: "0.155",
  liquidity: "4000",
  ts: new Date("2026-01-03T00:00:00.000Z"),
  ...over,
});

describe("makeSnapshotsStore", () => {
  it("recentForOutcome coerces numeric strings to numbers and bigserial to a number", async () => {
    const { pool } = poolReturning([snap()]);
    const rows = await makeSnapshotsStore(pool).recentForOutcome({ marketId: "m1", outcomeId: "tok-1", venue: "polymarket", limit: 2 });
    expect(rows).toHaveLength(1);
    expect(typeof rows[0].id).toBe("number");
    expect(rows[0].id).toBe(42);
    expect(typeof rows[0].ask).toBe("number");
    expect(rows[0].ask).toBeCloseTo(0.16, 6);
    expect(rows[0].bid).toBeCloseTo(0.15, 6);
    expect(rows[0].mid).toBeCloseTo(0.155, 6);
    expect(rows[0].liquidity).toBeCloseTo(4000, 6);
    expect(rows[0].tsIso).toBe("2026-01-03T00:00:00.000Z");
  });

  it("null prices map to null, not 0 — an absent quote is not a zero quote", async () => {
    const { pool } = poolReturning([snap({ bid: null, mid: null, liquidity: null })]);
    const rows = await makeSnapshotsStore(pool).recentForOutcome({ marketId: "m1", outcomeId: "tok-1", venue: "polymarket", limit: 1 });
    expect(rows[0].bid).toBeNull();
    expect(rows[0].mid).toBeNull();
    expect(rows[0].liquidity).toBeNull();
  });

  it("the human label round-trips, and a missing one is null", async () => {
    const { pool } = poolReturning([snap(), snap({ label: null })]);
    const rows = await makeSnapshotsStore(pool).recentForOutcome({ marketId: "m1", outcomeId: "tok-1", venue: "polymarket", limit: 2 });
    expect(rows[0].label).toBe("Spain");
    expect(rows[1].label).toBeNull();
  });

  it("recentForOutcome scopes the query by (market, outcome, venue, limit)", async () => {
    const { pool, seen } = poolReturning([]);
    await makeSnapshotsStore(pool).recentForOutcome({ marketId: "m1", outcomeId: "tok-1", venue: "kalshi", limit: 7 });
    expect(seen[0]).toEqual(["m1", "tok-1", "kalshi", 7]);
  });

  it("recentByMarketVenue scopes by (market, venue, limit) — all outcomes of one instant", async () => {
    const { pool, seen } = poolReturning([snap({ outcome_id: "a" }), snap({ outcome_id: "b" })]);
    const rows = await makeSnapshotsStore(pool).recentByMarketVenue({ marketId: "m1", venue: "polymarket", limit: 40 });
    expect(seen[0]).toEqual(["m1", "polymarket", 40]);
    expect(rows.map((r) => r.outcomeId)).toEqual(["a", "b"]);
  });

  it("a ts arriving as an ISO string (not a Date) still maps to ISO", async () => {
    const { pool } = poolReturning([snap({ ts: "2026-01-03T00:00:00.000Z" })]);
    const rows = await makeSnapshotsStore(pool).recentByMarketVenue({ marketId: "m1", venue: "polymarket", limit: 1 });
    expect(rows[0].tsIso).toBe("2026-01-03T00:00:00.000Z");
  });

  it("the surface is the two reads plus `append` — the refresh job's one write (ORB-214 item 1)", async () => {
    const { pool } = poolReturning([]);
    expect(Object.keys(makeSnapshotsStore(pool)).sort()).toEqual(["append", "recentByMarketVenue", "recentForOutcome"]);
  });
});

// ── the write half, against a REAL Postgres ──────────────────────────────────────────────────
//
// `append` is append-only INSERT with a COALESCE default on `ts`, writing into `numeric` columns
// that come back as strings. None of that is observable through a fake pool. The DDL is
// `sql/037_tyche.sql` (LAR-32), applied verbatim from disk.
describe("makeSnapshotsStore write half against real Postgres", () => {
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
    await pool.query("TRUNCATE tyche_market_snapshots");
  });

  it("append writes one observation and reads back through the store's own SELECT", async () => {
    const store = makeSnapshotsStore(pool);
    const { id } = await store.append({
      marketId: "m1", outcomeId: "spain", label: "Spain", venue: "polymarket",
      ask: 0.3125, bid: null, mid: null, liquidity: null, ts: "2026-09-08T12:00:00.000Z",
    });
    expect(typeof id).toBe("number");

    const rows = await store.recentForOutcome({ marketId: "m1", outcomeId: "spain", venue: "polymarket", limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0].ask).toBeCloseTo(0.3125, 6);   // real numeric → number, sub-cent preserved
    expect(rows[0].bid).toBeNull();
    expect(rows[0].mid).toBeNull();
    expect(rows[0].liquidity).toBeNull();
    expect(rows[0].label).toBe("Spain");
    expect(rows[0].tsIso).toBe("2026-09-08T12:00:00.000Z");
  });

  it("an omitted ts defaults to now() in the DB, not to null", async () => {
    const store = makeSnapshotsStore(pool);
    await store.append({ marketId: "m1", outcomeId: "o", venue: "kalshi", ask: 0.5 });
    const [row] = await store.recentForOutcome({ marketId: "m1", outcomeId: "o", venue: "kalshi", limit: 1 });
    expect(Number.isFinite(Date.parse(row.tsIso))).toBe(true);
  });

  it("it is APPEND-only: the same (market, outcome, venue) at two instants keeps both rows", async () => {
    const store = makeSnapshotsStore(pool);
    await store.append({ marketId: "m1", outcomeId: "o", venue: "polymarket", ask: 0.4, ts: "2026-09-07T12:00:00.000Z" });
    await store.append({ marketId: "m1", outcomeId: "o", venue: "polymarket", ask: 0.5, ts: "2026-09-08T12:00:00.000Z" });
    const rows = await store.recentForOutcome({ marketId: "m1", outcomeId: "o", venue: "polymarket", limit: 5 });
    expect(rows.map((r) => r.ask)).toEqual([0.5, 0.4]); // newest first
  });

  it("one refresh's writes share ONE ts, so recentByMarketVenue can group the book by instant", async () => {
    const store = makeSnapshotsStore(pool);
    const ts = "2026-09-08T12:00:00.000Z";
    for (const [outcome, ask] of [["a", 0.3], ["b", 0.7]] as const) {
      await store.append({ marketId: "m1", outcomeId: outcome, label: outcome.toUpperCase(), venue: "polymarket", ask, ts });
    }
    const rows = await store.recentByMarketVenue({ marketId: "m1", venue: "polymarket", limit: 40 });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.tsIso)).size).toBe(1);
  });
});
