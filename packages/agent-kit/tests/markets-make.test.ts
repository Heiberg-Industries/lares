// The ASSEMBLY, which had no test at all: `makeMarkets(cfg)` — the one call every mount makes —
// wires nine pieces together, and a wiring mistake there is invisible to every unit test in this
// directory because each piece passes its own.
//
// That is exactly how two bugs survived review. (1) `listKalshiEvents` was wired to
// `kalshi.listEvents()` — a generic `GET /events?status=open&limit=100` over a venue with
// thousands of open events — so the paired event was never on the page and the Kalshi side
// vanished from every quote. (2) Even with both venues answering, outcomes were keyed by the
// VENUE's own id — a 70-digit CLOB token id on one side, a `KX…` ticker on the other — so they
// could never land on the same outcome, and every card still said "one venue only". Nothing
// threw; nothing was red.
//
// So the fixtures here use the REAL id shapes (a 76-digit token id, from the live probe's own
// output, and a `KXWC-…` ticker), and the assertions run all the way to the CARD, because
// `method` is where a pairing failure actually shows up.
import { describe, it, expect } from "vitest";
import type { Pool } from "pg";
import { makeMarkets } from "../src/markets/index.js";
import { runMarketEdge } from "../src/markets/edge.js";

// ── the venues, as minimal but parser-valid payloads ─────────────────────────────────────────

// Verbatim shape from tests/live/markets.live.mts (2026-09-03): CLOB token ids are ~76-digit
// numeric strings, Polymarket condition ids are 0x + 64 hex. Nothing pairs these to a Kalshi
// ticker except the outcome LABEL, which is the point.
const TOK_SPAIN = "4394372887385518214471608448209527405727552777602031099972143344338178308080";
const TOK_BRAZIL = "8571029384756102938475610293847561029384756102938475610293847561029384756102";

/** Gamma returns a BARE array (no {events:[…]} wrapper); negRisk ⇒ mutually exclusive ⇒ de-vig. */
const gammaEvent = {
  slug: "wc-pm",
  title: "World Cup Winner",
  negRisk: true,
  endDate: "2026-07-20",
  markets: [
    {
      question: "Will Spain win the 2026 FIFA World Cup?", slug: "will-spain-win",
      conditionId: "0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892",
      groupItemTitle: "Spain", outcomes: '["Yes", "No"]', outcomePrices: '["0.30", "0.70"]',
      clobTokenIds: `["${TOK_SPAIN}", "tok-spain-no"]`, liquidityNum: 5000, active: true, closed: false,
    },
    {
      question: "Will Brazil win the 2026 FIFA World Cup?", slug: "will-brazil-win",
      conditionId: "0x1176b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992111",
      groupItemTitle: "Brazil", outcomes: '["Yes", "No"]', outcomePrices: '["0.55", "0.45"]',
      clobTokenIds: `["${TOK_BRAZIL}", "tok-brazil-no"]`, liquidityNum: 4000, active: true, closed: false,
    },
  ],
};

/** Kalshi wraps a single event as {event: …} and its markets as {markets: […]}. */
const kalshiEvent = { event_ticker: "KXWC", title: "World Cup Winner", mutually_exclusive: true };
const kalshiMarkets = [
  // Spain is spelled identically on both venues — it pairs with no alias at all.
  { ticker: "KXWC-ESP", event_ticker: "KXWC", title: "Spain", yes_sub_title: "Spain", yes_ask_dollars: "0.3200", close_time: "2026-07-20T15:00:00Z" },
  // Brazil is not — it pairs only because the row says "Brasil" means "Brazil".
  { ticker: "KXWC-BRA", event_ticker: "KXWC", title: "Brasil", yes_sub_title: "Brasil", yes_ask_dollars: "0.5300", close_time: "2026-07-20T15:00:00Z" },
];

/** ONE curated row, paired to both venues, carrying the one spelling exception as an alias —
 *  the exact shape `bin/tyche-seed-wc.ts` writes (canonical label → other-venue spellings). */
const marketsRow = {
  id: "wc26-winner", label: "World Cup Winner", pm_market_id: "wc-pm", kalshi_event_ticker: "KXWC",
  outcome_aliases: { Brazil: ["Brasil"] }, end_date: null, market_type: "mutually_exclusive",
  match_source: null, match_checked_at: null, match_result: null, match_confidence: null,
};

function stubs(over: { kalshiStatus?: number; kalshiEmptyBody?: boolean } = {}) {
  const urls: string[] = [];
  const fetchStub = (async (url: string, init?: { method?: string }) => {
    urls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes("/events/KXWC")) {
      if (over.kalshiEmptyBody) return json({});          // 200, but no `event` in the body
      return over.kalshiStatus && over.kalshiStatus !== 200
        ? { ok: false, status: over.kalshiStatus, json: async () => ({}) }
        : json({ event: kalshiEvent });
    }
    if (url.includes("/markets?event_ticker=")) return json({ markets: kalshiMarkets });
    if (url.includes("/events?slug=")) return json([gammaEvent]);
    if (url.endsWith("/prices")) {
      return json({ [TOK_SPAIN]: { SELL: "0.31" }, [TOK_BRAZIL]: { SELL: "0.56" } });
    }
    throw new Error(`unstubbed URL: ${url}`);
  }) as unknown as typeof fetch;

  // Only the reads the live path makes. A snapshots query would mean the STORED fallback ran.
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM tyche_markets")) return { rows: [marketsRow] };
      return { rows: [] };            // tyche_alert_state: nothing recorded for these outcomes
    },
  } as unknown as Pool;

  const feed = makeMarkets({
    fetch: fetchStub, pool,
    kalshiBase: "https://k.test", polymarketGammaBase: "https://g.test", polymarketClobBase: "https://c.test",
  });
  return { urls, queries, feed };
}

const NOW = () => new Date("2026-09-03T08:00:00.000Z");

describe("makeMarkets — the assembled read path", () => {
  it("fetches the paired Kalshi event BY TICKER, never a generic open listing", async () => {
    const { urls, feed } = stubs();
    const state = await feed.marketState("wc26-winner");
    expect(urls.some((u) => u.includes("/events/KXWC"))).toBe(true);
    // The regression itself: a `status=open` page never contains the paired event.
    expect(urls.filter((u) => u.includes("/events?status=open"))).toEqual([]);
    expect(state.ok).toBe(true);
  });

  it("returns a PAIRED live quote — both venues on ONE outcome, despite venue-scoped ids", async () => {
    const { queries, feed } = stubs();
    const state = await feed.marketState("World Cup Winner");
    if (!state.ok) throw new Error("expected a quotable market");
    expect(state.source).toBe("live");

    // Spain: a 76-digit CLOB token id and a KXWC-ESP ticker, on the SAME outcome, keyed by the
    // label they share. Nothing else about these two ids has anything in common.
    const spain = state.outcomes.find((o) => o.outcomeId === "spain")!;
    expect(spain.polymarket!.ask).toBeCloseTo(0.31, 6);   // the live CLOB ask, not Gamma's 0.30
    expect(spain.kalshi!.ask).toBeCloseTo(0.32, 6);
    expect(spain.polymarket!.fair).not.toBeNull();
    expect(spain.kalshi!.fair).not.toBeNull();

    // Brazil: paired only via the row's alias ("Brasil" means "Brazil").
    const brazil = state.outcomes.find((o) => o.outcomeId === "brazil")!;
    expect(brazil.polymarket!.ask).toBeCloseTo(0.56, 6);
    expect(brazil.kalshi!.ask).toBeCloseTo(0.53, 6);

    // A live answer must not have fallen back to stored snapshots.
    expect(queries.some((q) => q.includes("tyche_market_snapshots"))).toBe(false);
  });

  it("its CARD says cross-venue mean fair — the claim that was unreachable before", async () => {
    const { feed } = stubs();
    const res = await runMarketEdge(feed, { action: "state", marketId: "wc26-winner", limit: 8 }, NOW);
    expect(res.unavailable).toBeUndefined();
    expect(res.cards.length).toBe(4);               // 2 outcomes × 2 venues
    for (const c of res.cards) {
      expect(c.method).toBe("cross-venue mean fair (polymarket + kalshi), live venue books");
      expect(c.caveat).not.toMatch(/one venue only/);
    }
    // Both venues price Spain against ONE fair, so the two cards differ only by the ask.
    const spain = res.cards.filter((c) => c.market === "World Cup Winner — Spain");
    expect(spain).toHaveLength(2);
    expect(spain[0].fair).toBe(spain[1].fair);
    expect(spain.map((c) => c.venue).sort()).toEqual(["kalshi", "polymarket"]);
  });

  it("a downed Kalshi degrades to Polymarket-only AND the card says why", async () => {
    const { urls, feed } = stubs({ kalshiStatus: 503 });
    const state = await feed.marketState("wc26-winner");
    if (!state.ok) throw new Error("a downed Kalshi must not make the market unquotable");
    expect(state.source).toBe("live");
    expect(state.kalshiUnavailable).toMatch(/503/);
    expect(state.outcomes.every((o) => o.kalshi === null)).toBe(true);
    // And it never asked for that event's markets, having no event to parse them against.
    expect(urls.filter((u) => u.includes("/markets?event_ticker="))).toEqual([]);

    const res = await runMarketEdge(feed, { action: "state", marketId: "wc26-winner", limit: 8 }, NOW);
    expect(res.unavailable).toBeUndefined();        // the Polymarket side answered: this is real
    for (const c of res.cards) {
      expect(c.caveat).toMatch(/Kalshi could not be read/);
      expect(c.caveat).not.toMatch(/one venue only/);
    }
  });

  it("a 200 with no event in the body reads as an outage, not as a crash", async () => {
    // `getEvent` returns `body.event`. Without a shape check that undefined reaches
    // venue-quotes.ts's `find`, which throws — and the THROW's message is what the caveat prints,
    // so the reader was shown "Cannot read properties of undefined (reading 'event_ticker')".
    const { feed } = stubs({ kalshiEmptyBody: true });
    const state = await feed.marketState("wc26-winner");
    if (!state.ok) throw new Error("a malformed Kalshi answer must not make the market unquotable");
    expect(state.kalshiUnavailable).toBe("Kalshi returned no event for KXWC");

    const res = await runMarketEdge(feed, { action: "state", marketId: "wc26-winner", limit: 8 }, NOW);
    expect(res.cards.length).toBeGreaterThan(0);
    for (const c of res.cards) {
      expect(c.caveat).toContain("Kalshi could not be read (Kalshi returned no event for KXWC)");
      expect(c.caveat).not.toMatch(/Cannot read properties/);
    }
  });
});
