import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeMarketsStore } from "../src/markets/markets-store.js";
import type { MarketsPool } from "../src/markets/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "..", "..", "services", "box", "sql");
const sql = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

// Adapted from services/agent-runtime/tests/tyche-markets-store.test.ts (ORB-189 Task 1).
// The runtime's version seeded through upsertMarket; the kit's store is the READ half only, so
// the fake pool hands back pg-shaped rows directly — snake_case keys, jsonb already parsed,
// timestamptz as a Date — which is exactly the boundary the mapper has to get right.
// The SQL itself is exercised against a real Postgres in markets-db-integration.test.ts.
function poolReturning(rows: Record<string, any>[]): MarketsPool {
  return { async query() { return { rows }; } };
}

const row = (over: Record<string, any> = {}) => ({
  id: "m1",
  label: "World Cup Winner",
  pm_market_id: "world-cup-winner",
  kalshi_event_ticker: "KXWORLDCUP-26",
  outcome_aliases: { Brazil: ["Brasil"] },
  end_date: new Date("2026-07-20T15:00:00.000Z"),
  market_type: "mutually_exclusive",
  match_source: null,
  match_checked_at: null,
  match_result: null,
  match_confidence: null,
  ...over,
});

describe("makeMarketsStore", () => {
  it("listMarkets maps a pg row to camelCase", async () => {
    const list = await makeMarketsStore(poolReturning([row()])).listMarkets();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("m1");
    expect(list[0].label).toBe("World Cup Winner");
    expect(list[0].pmMarketId).toBe("world-cup-winner");
    expect(list[0].kalshiEventTicker).toBe("KXWORLDCUP-26");
    expect(list[0].outcomeAliases).toEqual({ Brazil: ["Brasil"] });
    expect(list[0].endDateIso).toBe("2026-07-20T15:00:00.000Z");
  });

  it("defaults: null venue ids stay null, null aliases → {}, null market_type → 'mutually_exclusive'", async () => {
    const list = await makeMarketsStore(poolReturning([
      row({ pm_market_id: null, kalshi_event_ticker: null, outcome_aliases: null, market_type: null, end_date: null }),
    ])).listMarkets();
    expect(list[0].pmMarketId).toBeNull();
    expect(list[0].kalshiEventTicker).toBeNull();
    expect(list[0].outcomeAliases).toEqual({});
    expect(list[0].marketType).toBe("mutually_exclusive");
    expect(list[0].endDateIso).toBeNull();
  });

  it("marketType 'independent' survives the mapping — it is what forbids de-vig", async () => {
    const list = await makeMarketsStore(poolReturning([row({ market_type: "independent" })])).listMarkets();
    expect(list[0].marketType).toBe("independent");
  });

  it("outcome_aliases arriving as a JSON STRING is parsed (jsonb can come back either way)", async () => {
    const list = await makeMarketsStore(poolReturning([
      row({ outcome_aliases: '{"Spain":["Espana"]}' }),
    ])).listMarkets();
    expect(list[0].outcomeAliases).toEqual({ Spain: ["Espana"] });
  });

  it("match bookkeeping columns come through, with timestamptz mapped to ISO", async () => {
    const list = await makeMarketsStore(poolReturning([
      row({ match_source: "auto", match_result: "matched", match_confidence: 0.92,
            match_checked_at: new Date("2026-03-01T00:00:00.000Z") }),
    ])).listMarkets();
    expect(list[0].matchSource).toBe("auto");
    expect(list[0].matchResult).toBe("matched");
    expect(list[0].matchConfidence).toBeCloseTo(0.92, 6);
    expect(list[0].matchCheckedAtIso).toBe("2026-03-01T00:00:00.000Z");
  });

  it("an empty watchlist is an empty list, not a throw", async () => {
    expect(await makeMarketsStore(poolReturning([])).listMarkets()).toEqual([]);
  });

  it("the surface is the read verb plus the refresh job's two writes — and nothing else", async () => {
    // ORB-214 item 1 (Task 6): `upsertPmFields` and `deleteMarket` came back for the watchlist
    // refresh. The pairing half (upsertMarket, recordMatch, recordMiss, loadMatchMap,
    // listMatchEligible, backfillSeedSource) stayed retired with the LLM match judge — aliases
    // and Kalshi links are manual (ORB-214 item 2), so nothing here can write them.
    const store = makeMarketsStore(poolReturning([]));
    expect(Object.keys(store).sort()).toEqual(["deleteMarket", "listMarkets", "upsertPmFields"]);
  });
});

// ── the write half, against a REAL Postgres ──────────────────────────────────────────────────
//
// The fake pool above proves the mapping and nothing about the SQL. `upsertPmFields`' whole
// reason to exist is a NEGATIVE: what its ON CONFLICT clause does NOT touch. A fake pool cannot
// show that — only a real row, re-upserted, can. The DDL is `sql/037_tyche.sql` (LAR-32), applied
// verbatim from disk; the box has no auto-migrate and these tables were hand-applied there.
describe("makeMarketsStore write half against real Postgres", () => {
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
    await pool.query("TRUNCATE tyche_markets");
  });

  it("upsertPmFields inserts a new row with the Polymarket fields", async () => {
    const store = makeMarketsStore(pool);
    await store.upsertPmFields({
      id: "wc26-uk-election", label: "Next UK PM", pmMarketId: "uk-election",
      marketType: "mutually_exclusive", endDateIso: "2027-01-20T00:00:00.000Z",
    });
    const rows = await store.listMarkets();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "wc26-uk-election", label: "Next UK PM", pmMarketId: "uk-election",
      kalshiEventTicker: null, outcomeAliases: {}, marketType: "mutually_exclusive",
      endDateIso: "2027-01-20T00:00:00.000Z",
    });
  });

  it("a second upsert KEEPS kalshi_event_ticker and outcome_aliases — the manual pairing survives discovery", async () => {
    const store = makeMarketsStore(pool);
    await store.upsertPmFields({ id: "m1", label: "First label", pmMarketId: "slug-1", marketType: "mutually_exclusive", endDateIso: null });
    // the link and the aliases arrive by hand, exactly as they do in production (ORB-214 item 2)
    await pool.query(
      `UPDATE tyche_markets SET kalshi_event_ticker = $1, outcome_aliases = $2::jsonb WHERE id = $3`,
      ["KXWC", JSON.stringify({ Brazil: ["Brasil"] }), "m1"],
    );

    await store.upsertPmFields({ id: "m1", label: "Second label", pmMarketId: "slug-2", marketType: "independent", endDateIso: "2026-12-01T00:00:00.000Z" });

    const [row] = await store.listMarkets();
    expect(row.kalshiEventTicker).toBe("KXWC");                 // never nulled
    expect(row.outcomeAliases).toEqual({ Brazil: ["Brasil"] }); // never touched
    expect(row.label).toBe("Second label");                     // and the PM fields DO refresh
    expect(row.pmMarketId).toBe("slug-2");
    expect(row.marketType).toBe("independent");
    expect(row.endDateIso).toBe("2026-12-01T00:00:00.000Z");
  });

  it("the match bookkeeping columns are untouched by an upsert — only the retired judge ever wrote them", async () => {
    const store = makeMarketsStore(pool);
    await store.upsertPmFields({ id: "m1", label: "L", pmMarketId: "s" });
    await pool.query(`UPDATE tyche_markets SET match_source = 'seed', match_result = 'matched' WHERE id = 'm1'`);
    await store.upsertPmFields({ id: "m1", label: "L2", pmMarketId: "s2" });
    const [row] = await store.listMarkets();
    expect(row.matchSource).toBe("seed");
    expect(row.matchResult).toBe("matched");
  });

  it("upsertPmFields advances updated_at, so the refresh's own touch is visible", async () => {
    const store = makeMarketsStore(pool);
    await store.upsertPmFields({ id: "m1", label: "L", pmMarketId: "s" });
    const before = (await pool.query(`SELECT updated_at FROM tyche_markets WHERE id = 'm1'`)).rows[0].updated_at;
    await new Promise((r) => setTimeout(r, 10));
    await store.upsertPmFields({ id: "m1", label: "L2", pmMarketId: "s" });
    const after = (await pool.query(`SELECT updated_at, created_at FROM tyche_markets WHERE id = 'm1'`)).rows[0];
    expect(after.updated_at.getTime()).toBeGreaterThan(before.getTime());
  });

  it("deleteMarket removes exactly the named row, and deleting an unknown id is a no-op", async () => {
    const store = makeMarketsStore(pool);
    await store.upsertPmFields({ id: "a", label: "A", pmMarketId: "a" });
    await store.upsertPmFields({ id: "b", label: "B", pmMarketId: "b" });
    await store.deleteMarket("a");
    expect((await store.listMarkets()).map((r) => r.id)).toEqual(["b"]);
    await store.deleteMarket("nope");
    expect((await store.listMarkets()).map((r) => r.id)).toEqual(["b"]);
  });
});
