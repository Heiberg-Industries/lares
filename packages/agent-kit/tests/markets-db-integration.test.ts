import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { makeMarketsStore } from "../src/markets/markets-store.js";
import { makeSnapshotsStore } from "../src/markets/snapshots-store.js";
import { makeEdgeStateStore } from "../src/markets/edge-state.js";

/**
 * The three read stores against a REAL Postgres, not a fake pool.
 *
 * Root CLAUDE.md: "a fixture is what we believe an API does; only a live call is what it does."
 * The same holds one layer down for SQL — the sibling unit tests hand these stores canned rows,
 * so they prove the mapping and nothing about the queries. This file is what proves the SELECTs
 * that came across in the ORB-189 copy still parse and still return the columns the mappers
 * read, against the real column types.
 *
 * The DDL is `sql/037_tyche.sql` (LAR-32), applied verbatim from disk — the tables were
 * hand-applied on the box, which has no auto-migrate, and 037 is now their migration of record.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "..", "..", "services", "box", "sql");
const sql = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

describe("markets read stores against real Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(sql("037_tyche.sql"));

    await pool.query(
      `INSERT INTO tyche_markets (id, label, pm_market_id, kalshi_event_ticker, outcome_aliases, end_date, updated_at, market_type, match_source, match_result, match_confidence, match_checked_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)`,
      ["wc", "World Cup Winner", "wc-pm", "KXWC", JSON.stringify({ Brazil: ["Brasil"] }),
       "2026-07-20T15:00:00.000Z", "2026-02-02T00:00:00.000Z", "mutually_exclusive",
       "auto", "matched", 0.92, "2026-03-01T00:00:00.000Z"],
    );
    await pool.query(
      `INSERT INTO tyche_markets (id, label, pm_market_id, updated_at, market_type)
       VALUES ($1,$2,$3,$4,$5)`,
      ["fr", "French Presidential", "fr-pm", "2026-02-03T00:00:00.000Z", "independent"],
    );

    for (const [outcome, venue, bid, ask, ts, label] of [
      ["tok-a", "polymarket", 0.15, 0.16, "2026-02-02T00:00:00.000Z", "Spain"],
      ["tok-b", "polymarket", 0.39, 0.40, "2026-02-02T00:00:00.000Z", "Brazil"],
      ["tok-a", "polymarket", 0.19, 0.20, "2026-02-01T00:00:00.000Z", null],
    ] as const) {
      await pool.query(
        `INSERT INTO tyche_market_snapshots (market_id, outcome_id, label, venue, bid, ask, liquidity, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        ["wc", outcome, label, venue, bid, ask, 4000, ts],
      );
    }

    await pool.query(
      `INSERT INTO tyche_alert_state (market_id, outcome_id, last_edge, last_basis, last_alerted_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      ["wc", "tok-a", 0.05, 0.4, "2026-02-02T00:00:00.000Z", "2026-02-02T09:30:00.000Z"],
    );
    await pool.query(
      `INSERT INTO tyche_alert_state (market_id, outcome_id, last_edge, last_basis, last_alerted_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      ["wc", "tok-b", 0.11, null, null, "2026-02-02T09:30:00.000Z"],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("listMarkets runs, orders by updated_at DESC, and maps every column", async () => {
    const rows = await makeMarketsStore(pool).listMarkets();
    expect(rows.map((r) => r.id)).toEqual(["fr", "wc"]);   // newest update first
    const wc = rows.find((r) => r.id === "wc")!;
    expect(wc.pmMarketId).toBe("wc-pm");
    expect(wc.kalshiEventTicker).toBe("KXWC");
    expect(wc.outcomeAliases).toEqual({ Brazil: ["Brasil"] });   // real jsonb
    expect(wc.endDateIso).toBe("2026-07-20T15:00:00.000Z");
    expect(wc.marketType).toBe("mutually_exclusive");
    expect(wc.matchSource).toBe("auto");
    expect(wc.matchResult).toBe("matched");
    expect(wc.matchConfidence).toBeCloseTo(0.92, 5);
    expect(wc.matchCheckedAtIso).toBe("2026-03-01T00:00:00.000Z");
    expect(rows.find((r) => r.id === "fr")!.marketType).toBe("independent");
  });

  it("recentByMarketVenue returns every outcome of the newest instant, newest first, prices as numbers", async () => {
    const rows = await makeSnapshotsStore(pool).recentByMarketVenue({ marketId: "wc", venue: "polymarket", limit: 40 });
    expect(rows).toHaveLength(3);
    expect(rows[0].tsIso).toBe("2026-02-02T00:00:00.000Z");
    const newest = rows.filter((r) => r.tsIso === rows[0].tsIso);
    expect(newest.map((r) => r.outcomeId).sort()).toEqual(["tok-a", "tok-b"]);
    expect(typeof newest[0].ask).toBe("number");        // real numeric → number
    expect(typeof rows[0].id).toBe("number");           // real bigserial → number
    expect(newest.find((r) => r.outcomeId === "tok-a")!.ask).toBeCloseTo(0.16, 6);
  });

  it("recentForOutcome scopes to one (market, outcome, venue) and honours the limit", async () => {
    const store = makeSnapshotsStore(pool);
    const rows = await store.recentForOutcome({ marketId: "wc", outcomeId: "tok-a", venue: "polymarket", limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0].ask).toBeCloseTo(0.16, 6);           // newest first
    expect(rows[0].label).toBe("Spain");
    expect(rows[1].label).toBeNull();
    expect(rows[1].mid).toBeNull();                     // an unwritten numeric stays null
    const capped = await store.recentForOutcome({ marketId: "wc", outcomeId: "tok-a", venue: "polymarket", limit: 1 });
    expect(capped).toHaveLength(1);
  });

  it("edge-state get reads last_edge and updated_at as recordedAtIso", async () => {
    const store = makeEdgeStateStore(pool);
    const a = await store.get({ marketId: "wc", outcomeId: "tok-a" });
    expect(a!.lastEdge).toBeCloseTo(0.05, 6);
    expect(a!.lastBasis).toBeCloseTo(0.4, 6);
    expect(a!.lastAlertedAtIso).toBe("2026-02-02T00:00:00.000Z");
    expect(a!.recordedAtIso).toBe("2026-02-02T09:30:00.000Z");

    // measured but never announced: recorded, not alerted
    const b = await store.get({ marketId: "wc", outcomeId: "tok-b" });
    expect(b!.lastEdge).toBeCloseTo(0.11, 6);
    expect(b!.lastBasis).toBeNull();
    expect(b!.lastAlertedAtIso).toBeNull();
    expect(b!.recordedAtIso).toBe("2026-02-02T09:30:00.000Z");

    expect(await store.get({ marketId: "wc", outcomeId: "nope" })).toBeNull();
  });

  it("the three verbs run end-to-end over the real tables", async () => {
    const { makeMarketsRead } = await import("../src/markets/read.js");
    const read = makeMarketsRead({
      markets: makeMarketsStore(pool),
      snapshots: makeSnapshotsStore(pool),
      alertState: makeEdgeStateStore(pool),
      // The seeded rows carry June/July 2026 end dates; a real clock would read them as settled
      // (ORB-214 item 6) and this test is about the three verbs over OPEN rows.
      now: () => new Date("2026-06-27T00:00:00.000Z"),
    });

    expect((await read.findMarkets("world cup")).matches.map((m) => m.id)).toEqual(["wc"]);

    const state = await read.marketState("wc");
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.source).toBe("stored");
    // Keyed by the CANONICAL outcome key (the alias-folded label), not the CLOB token id — that
    // is what lets the Kalshi side of the same outcome land here too.
    const spain = state.outcomes.find((o) => o.outcomeId === "spain")!;
    expect(spain.label).toBe("Spain");
    expect(spain.polymarket!.ask).toBeCloseTo(0.16, 6);
    // one-winner book, two priced outcomes → de-vigged: 0.16 / (0.16 + 0.40)
    expect(spain.polymarket!.fair).toBeCloseTo(0.16 / 0.56, 6);
    // And the RECORDED edge still resolves, over the REAL table: `tyche_alert_state` is keyed by
    // the venue's own outcome id (`tok-a`), so canonicalising the map key must not change what is
    // asked of that table. This assertion is the proof that it did not.
    expect(spain.recordedAtIso).toBe("2026-02-02T09:30:00.000Z");
    expect(spain.lastEdge).toBeCloseTo(0.05, 6);

    const best = await read.bestBets();
    expect(Object.keys(best).sort()).toEqual(["open", "ranked", "scanned"]); // nothing in the kit posts anywhere — no delivery flag to even lie about; the scan says what it covered (ORB-214 item 3)
    expect(best.ranked.map((e) => e.outcomeId)).toEqual(["brazil", "spain"]);  // |0.11| > |0.05|
    expect(best.ranked.map((e) => e.outcomeLabel)).toEqual(["Brazil", "Spain"]);
    expect(best.ranked[0].recordedAtIso).toBe("2026-02-02T09:30:00.000Z");
  });
});
