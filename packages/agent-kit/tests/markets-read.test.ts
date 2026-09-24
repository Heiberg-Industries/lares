import { describe, it, expect } from "vitest";
import { makeMarketsRead, BEST_BETS_SCAN_MAX } from "../src/markets/read.js";
import type { MarketRow, SnapshotRow, AlertState } from "../src/markets/types.js";
import type { QuotedMarket } from "../src/markets/venue-quotes.js";
import { prob } from "../src/markets/probability/types.js";

const markets: MarketRow[] = [
  { id: "wc", label: "World Cup Winner", pmMarketId: "wc-pm", kalshiEventTicker: "KXWC",
    outcomeAliases: {}, endDateIso: "2026-07-20T15:00:00.000Z", marketType: "mutually_exclusive" },
];
// newest instant t2 has Yes+No on polymarket; alert_state holds the last edge for Yes.
function snap(outcomeId: string, venue: string, ask: number | null, tsIso: string, label: string | null = null): SnapshotRow {
  return { id: 0, marketId: "wc", outcomeId, label, venue, bid: null, ask, mid: null, liquidity: 4000, tsIso };
}
function fakeDeps() {
  const rowsByVenue: Record<string, SnapshotRow[]> = {
    polymarket: [
      snap("Yes", "polymarket", 0.66, "2026-02-02T00:00:00.000Z"),
      snap("No", "polymarket", 0.40, "2026-02-02T00:00:00.000Z"),
      snap("Yes", "polymarket", 0.60, "2026-02-01T00:00:00.000Z"),
    ],
    kalshi: [],
  };
  const alerts: Record<string, AlertState> = {
    "wc Yes": { marketId: "wc", outcomeId: "Yes", lastEdge: 0.05, lastBasis: 0.71, lastAlertedAtIso: "2026-02-02T00:00:00.000Z" },
  };
  return {
    markets: { async listMarkets() { return markets; } },
    snapshots: { async recentByMarketVenue(a: { marketId: string; venue: string; limit: number }) { return rowsByVenue[a.venue] ?? []; } },
    alertState: { async get(a: { marketId: string; outcomeId: string }) { return alerts[`${a.marketId} ${a.outcomeId}`] ?? null; } },
    now: () => new Date("2026-06-01T00:00:00.000Z"), // fixtures are OPEN markets — see makeStoredDeps
  };
}

describe("makeMarketsRead", () => {


  it("marketState de-vigs the newest instant and surfaces the last alert edge", async () => {
    const read = makeMarketsRead(fakeDeps());
    const res = (await read.marketState("World Cup Winner")) as any;
    expect(res.market.id).toBe("wc");
    const yes = res.outcomes.find((o: any) => o.outcomeId === "Yes");
    expect(yes.polymarket.ask).toBeCloseTo(0.66, 6);
    expect(yes.polymarket.fair).toBeCloseTo(0.66 / 1.06, 6); // deVig {Yes:0.66,No:0.40}
    expect(yes.lastEdge).toBeCloseTo(0.05, 6);
    expect(yes.lastAlertedAtIso).toBe("2026-02-02T00:00:00.000Z");
  });

  it("surfaces the human label, and files a token-id outcome under that label", async () => {
    // A CLOB token id says nothing and matches nothing on the other venue; the label is both the
    // human name and the only thing the two venues share, so it is the key (see alignOutcomes).
    const deps = fakeDeps();
    deps.snapshots.recentByMarketVenue = async (a: { marketId: string; venue: string; limit: number }) => {
      if (a.venue === "polymarket") {
        return [
          snap("tok-66830", "polymarket", 0.30, "2026-02-02T00:00:00.000Z", "Brazil"),
          snap("tok-07569", "polymarket", 0.14, "2026-02-02T00:00:00.000Z", "Spain"),
        ];
      }
      return [];
    };
    const res = (await makeMarketsRead(deps).marketState("wc")) as any;
    const brazil = res.outcomes.find((o: any) => o.label === "Brazil");
    expect(brazil.outcomeId).toBe("brazil");        // canonical key, not the token id
    expect(brazil.polymarket.ask).toBeCloseTo(0.30, 6);
  });

  it("marketState on an unknown market returns ok:false", async () => {
    const read = makeMarketsRead(fakeDeps());
    const res = (await read.marketState("nope")) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it("marketState with degenerate single outcome returns ask as-is with fair:null", async () => {
    const deps = fakeDeps();
    // Override snapshots to have only a single outcome (degenerate book)
    deps.snapshots.recentByMarketVenue = async (a: { marketId: string; venue: string; limit: number }) => {
      if (a.venue === "polymarket") {
        return [snap("Yes", "polymarket", 0.55, "2026-02-02T00:00:00.000Z")];
      }
      return [];
    };
    const read = makeMarketsRead(deps);
    const res = (await read.marketState("World Cup Winner")) as any;
    expect(res.market.id).toBe("wc");
    const yes = res.outcomes.find((o: any) => o.outcomeId === "Yes");
    expect(yes.polymarket.ask).toBeCloseTo(0.55, 6);
    expect(yes.polymarket.fair).toBe(null); // degenerate book, no fair value
  });
});

// Build a QuotedMarket whose pmEstimate carries meta.mutuallyExclusive, plus a matching pmSpec for labels.
function liveQuotedPM(opts: { me: boolean; raw: Record<string, number>; labels: Record<string, string> }): QuotedMarket {
  const outcomes = Object.keys(opts.raw).map((id) => ({ outcomeId: id, label: opts.labels[id] ?? id, tokenId: id, laggedPrice: opts.raw[id] }));
  const raw: Record<string, any> = {};
  for (const [k, v] of Object.entries(opts.raw)) raw[k] = prob(v);
  return {
    row: { id: "wc", pmMarketId: "wc-pm", kalshiEventTicker: null, endDateIso: null },
    pmSpec: { marketId: "wc-pm", kind: "event", question: "WC", mutuallyExclusive: opts.me, outcomes } as any,
    pmEstimate: { source: "polymarket", raw, meta: { mutuallyExclusive: opts.me } } as any,
    kalshiSpec: null, kalshiEstimate: null, kalshiUnavailable: null, liquidityByOutcome: {},
  };
}

describe("makeMarketsRead live-on-ask", () => {
  it("independent market: live fair == raw ask (NOT normalized), source=live", async () => {
    const deps = fakeDeps();
    const q = liveQuotedPM({ me: false, raw: { fr: 0.89, es: 0.83 }, labels: { fr: "France", es: "Spain" } });
    const hand = makeMarketsRead({ ...deps, liveQuotes: { async get() { return q; } } });
    const res = (await hand.marketState("wc")) as any;
    expect(res.source).toBe("live");
    const fr = res.outcomes.find((o: any) => o.outcomeId === "france");
    expect(fr.polymarket.ask).toBeCloseTo(0.89, 6);
    expect(fr.polymarket.fair).toBeCloseTo(0.89, 6);   // independent → raw IS the probability
    expect(fr.label).toBe("France");
  });

  it("mutually-exclusive market: live fair de-vigs (sums to 1)", async () => {
    const deps = fakeDeps();
    const q = liveQuotedPM({ me: true, raw: { Yes: 0.66, No: 0.40 }, labels: {} });
    const hand = makeMarketsRead({ ...deps, liveQuotes: { async get() { return q; } } });
    const res = (await hand.marketState("wc")) as any;
    expect(res.source).toBe("live");
    const yes = res.outcomes.find((o: any) => o.outcomeId === "yes");
    expect(yes.polymarket.fair).toBeCloseTo(0.66 / 1.06, 6); // de-vigged
  });

  it("falls back to stored when the live quote carries no venue estimate", async () => {
    const deps = fakeDeps();
    const empty: QuotedMarket = { row: { id: "wc", pmMarketId: "wc-pm", kalshiEventTicker: null, endDateIso: null },
      pmSpec: null, pmEstimate: null, kalshiSpec: null, kalshiEstimate: null, kalshiUnavailable: null, liquidityByOutcome: {} };
    const hand = makeMarketsRead({ ...deps, liveQuotes: { async get() { return empty; } } });
    const res = (await hand.marketState("World Cup Winner")) as any;
    expect(res.source).toBe("stored");
    const yes = res.outcomes.find((o: any) => o.outcomeId === "Yes");
    expect(yes.polymarket.fair).toBeCloseTo(0.66 / 1.06, 6); // from stored snapshots (existing fixture)
  });

  it("no liveQuotes dep → stored path, source=stored (back-compat)", async () => {
    const res = (await makeMarketsRead(fakeDeps()).marketState("wc")) as any;
    expect(res.source).toBe("stored");
  });

  it("does not de-vig an independent (yes/no) market in the stored path", async () => {
    // market_type independent; two outcomes whose asks sum to 1.3
    const T = "2026-02-02T00:00:00.000Z";
    const rowsByVenue: Record<string, SnapshotRow[]> = {
      polymarket: [
        { id: 0, marketId: "reach-r16", outcomeId: "ARG", label: "Argentina", venue: "polymarket", bid: null, ask: 0.80, mid: null, liquidity: 4000, tsIso: T },
        { id: 0, marketId: "reach-r16", outcomeId: "BRA", label: "Brazil",    venue: "polymarket", bid: null, ask: 0.50, mid: null, liquidity: 4000, tsIso: T },
      ],
      kalshi: [],
    };
    const alerts: Record<string, AlertState> = {};
    const deps = {
      markets: { async listMarkets() { return [{ id: "reach-r16", label: "Reach R16", pmMarketId: null, kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "independent" as const }]; } },
      snapshots: { async recentByMarketVenue(a: { marketId: string; venue: string; limit: number }) { return rowsByVenue[a.venue] ?? []; } },
      alertState: { async get(a: { marketId: string; outcomeId: string }) { return alerts[`${a.marketId} ${a.outcomeId}`] ?? null; } },
    };
    const hand = makeMarketsRead(deps);
    const res: any = await hand.marketState("reach-r16");
    const arg = res.outcomes.find((o: any) => o.label === "Argentina");
    expect(arg.polymarket.fair).toBeCloseTo(0.80, 5); // raw ask, not de-vigged (0.80/1.3=0.615)
  });
});

// ── bestBets ranking tests ────────────────────────────────────────────────────

function makeMultiMarketDeps() {
  const mkt1: MarketRow = { id: "wc", label: "World Cup Winner", pmMarketId: "wc-pm", kalshiEventTicker: "KXWC",
    outcomeAliases: {}, endDateIso: "2026-07-20T15:00:00.000Z", marketType: "mutually_exclusive" };
  const mkt2: MarketRow = { id: "us-election", label: "US Election", pmMarketId: "us-pm", kalshiEventTicker: null,
    outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" };

  const T = "2026-02-02T00:00:00.000Z";

  const rowsByMarketVenue: Record<string, SnapshotRow[]> = {
    "wc-polymarket": [
      snap("Yes", "polymarket", 0.60, T),
      snap("No", "polymarket", 0.50, T),
    ],
    "us-election-polymarket": [
      snap("Dem", "polymarket", 0.55, T),
      snap("Rep", "polymarket", 0.48, T),
    ],
    "wc-kalshi": [],
    "us-election-kalshi": [],
  };

  const alertsByKey: Record<string, AlertState> = {
    // wc/Yes: edge 0.05 (small)
    "wc Yes": { marketId: "wc", outcomeId: "Yes", lastEdge: 0.05, lastBasis: 0.65, lastAlertedAtIso: T },
    // us-election/Dem: edge 0.18 (strongest)
    "us-election Dem": { marketId: "us-election", outcomeId: "Dem", lastEdge: 0.18, lastBasis: 0.73, lastAlertedAtIso: T },
    // us-election/Rep: edge -0.10 (mid, negative)
    "us-election Rep": { marketId: "us-election", outcomeId: "Rep", lastEdge: -0.10, lastBasis: 0.38, lastAlertedAtIso: T },
    // wc/No: no edge → omitted from bestBets
  };

  return {
    markets: { async listMarkets() { return [mkt1, mkt2]; } },
    snapshots: {
      async recentByMarketVenue(a: { marketId: string; venue: string; limit: number }) {
        return rowsByMarketVenue[`${a.marketId}-${a.venue}`] ?? [];
      },
    },
    alertState: {
      async get(a: { marketId: string; outcomeId: string }) {
        return alertsByKey[`${a.marketId} ${a.outcomeId}`] ?? null;
      },
    },
    now: () => new Date("2026-06-01T00:00:00.000Z"),
  };
}

describe("makeMarketsRead bestBets", () => {
  it("returns ranked entries: referenced (cross-venue) first, then strongest |edge| within group", async () => {
    // wc has kalshiEventTicker (referenced), us-election does not.
    // wc/Yes is referenced with |edge|=0.05; us-election/{Dem,Rep} unreferenced with |edge|=0.18,0.10.
    // New sort: referenced first (wc/Yes), then unreferenced by |edge| desc (Dem, Rep).
    const read = makeMarketsRead(makeMultiMarketDeps());
    const res = (await read.bestBets()) as { ranked: Array<{ outcomeId: string; lastEdge: number; referenced: boolean }> };
    expect(res.ranked[0].outcomeId).toBe("Yes");         // referenced, ranks first despite small edge
    expect(res.ranked[0].referenced).toBe(true);
    expect(res.ranked[1].outcomeId).toBe("Dem");         // unreferenced, |0.18| strongest in group
    expect(res.ranked[1].referenced).toBe(false);
    expect(res.ranked[2].outcomeId).toBe("Rep");         // unreferenced, |0.10| second
    expect(res.ranked).toHaveLength(3);
  });

  it("omits outcomes with no lastEdge", async () => {
    const read = makeMarketsRead(makeMultiMarketDeps());
    const res = (await read.bestBets()) as { ranked: Array<{ outcomeId: string }> };
    const ids = res.ranked.map((r) => r.outcomeId);
    expect(ids).not.toContain("No"); // wc/No has no alertState → no lastEdge
  });

  it("includes marketLabel and outcomeLabel in each entry", async () => {
    const read = makeMarketsRead(makeMultiMarketDeps());
    const res = (await read.bestBets()) as { ranked: Array<{ marketLabel: string; outcomeLabel: string | null; referenced: boolean }> };
    // wc/Yes is referenced → ranks first; verify marketLabel is surfaced
    expect(res.ranked[0].marketLabel).toBe("World Cup Winner");
    // confirm the referenced field is present
    expect(typeof res.ranked[0].referenced).toBe("boolean");
  });


  it("bestBets never invokes liveQuotes even when the dep is wired in", async () => {
    // Wire a liveQuotes dep that throws if called — bestBets must not trigger it.
    let liveCallCount = 0;
    const liveQuotes = {
      async get(_row: MarketRow): Promise<QuotedMarket> {
        liveCallCount++;
        throw new Error("live fetch must NOT be called by bestBets");
      },
    };
    const read = makeMarketsRead({ ...makeMultiMarketDeps(), liveQuotes });
    const res = (await read.bestBets()) as { ranked: Array<{ outcomeId: string; lastEdge: number; referenced: boolean }> };
    // Ranking: wc/Yes is referenced → first; then us-election/{Dem,Rep} by |edge| desc.
    expect(res.ranked[0].outcomeId).toBe("Yes");
    expect(res.ranked[0].referenced).toBe(true);
    expect(res.ranked[1].outcomeId).toBe("Dem");
    expect(res.ranked[2].outcomeId).toBe("Rep");
    expect(res.ranked).toHaveLength(3);
    // And the live path was never hit
    expect(liveCallCount).toBe(0);
  });
});

// ── bestBets filter / sort / cap tests ──────────────────────────────────────

const EDGE_BASIS_EPS = 0.02; // mirror the constant in read-hand.ts

/** Build a minimal MarketRow with optional kalshiEventTicker */
function mktRow(id: string, kalshiEventTicker: string | null = null): MarketRow {
  return { id, label: `Market ${id}`, pmMarketId: null, kalshiEventTicker, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" };
}

/** Build deps from a list of (marketRow, outcomeId, lastEdge, lastBasis) tuples.
 *  All markets share a single snapshot row so storedState has something to iterate. */
function makeDepsFromEdges(
  entries: Array<{ market: MarketRow; outcomeId: string; lastEdge: number; lastBasis: number | null }>
) {
  const markets = [...new Map(entries.map((e) => [e.market.id, e.market])).values()];
  const T = "2026-02-02T00:00:00.000Z";
  const alertsByKey: Record<string, AlertState> = {};
  for (const e of entries) {
    alertsByKey[`${e.market.id} ${e.outcomeId}`] = {
      marketId: e.market.id, outcomeId: e.outcomeId,
      lastEdge: e.lastEdge, lastBasis: e.lastBasis, lastAlertedAtIso: T,
    };
  }
  // Each market needs at least one snapshot row so the storedState loop yields outcomes
  const snapsByMarketVenue: Record<string, SnapshotRow[]> = {};
  for (const e of entries) {
    const key = `${e.market.id}-polymarket`;
    if (!snapsByMarketVenue[key]) snapsByMarketVenue[key] = [];
    snapsByMarketVenue[key].push({ id: 0, marketId: e.market.id, outcomeId: e.outcomeId, label: e.outcomeId, venue: "polymarket", bid: null, ask: 0.50, mid: null, liquidity: 1000, tsIso: T });
  }
  return {
    markets: { async listMarkets() { return markets; } },
    snapshots: { async recentByMarketVenue(a: { marketId: string; venue: string; limit: number }) { return snapsByMarketVenue[`${a.marketId}-${a.venue}`] ?? []; } },
    now: () => new Date("2026-06-01T00:00:00.000Z"), // see makeStoredDeps
    alertState: { async get(a: { marketId: string; outcomeId: string }) { return alertsByKey[`${a.marketId} ${a.outcomeId}`] ?? null; } },
  };
}

// ── findMarkets search tests ────────────────────────────────────────────────

/** Helper to build deps with custom markets.
 *
 *  Every market gets a two-outcome polymarket snapshot, because the tests below are about which
 *  market a name RESOLVES to and they read that off a successful answer. `marketState` no longer
 *  answers `ok: true` for a market with nothing to quote (a resolved market with an empty book is
 *  now `ok: false` with a reason — see read.ts's NO_QUOTES_REASON), so a market with no snapshots
 *  would make every one of these fail for a reason that has nothing to do with resolution. */
function makeStoredDeps(opts: { markets?: MarketRow[] } = {}) {
  const markets = opts.markets ?? [];
  const T = "2026-02-02T00:00:00.000Z";
  return {
    markets: { async listMarkets() { return markets; } },
    snapshots: {
      async recentByMarketVenue(a: { marketId: string; venue: string; limit: number }) {
        if (a.venue !== "polymarket") return [];
        return ["Yes", "No"].map((outcomeId, i): SnapshotRow => ({
          id: i, marketId: a.marketId, outcomeId, label: outcomeId, venue: "polymarket",
          bid: null, ask: i === 0 ? 0.6 : 0.45, mid: null, liquidity: 1000, tsIso: T,
        }));
      },
    },
    // A fixed clock before every fixture's July end date — the settled rule (ORB-214 item 6) reads
    // a past `endDateIso` as closed, and these fixtures describe OPEN markets.
    now: () => new Date("2026-06-01T00:00:00.000Z"),
    alertState: { async get(_a: { marketId: string; outcomeId: string }) { return null; } },
  };
}

describe("makeMarketsRead marketState — resolveMarket substring", () => {
  it("marketState resolves a unique label substring (not just exact)", async () => {
    const hand = makeMarketsRead(makeStoredDeps({
      markets: [
        { id: "fr-pres-2027", label: "Next French Presidential Election", pmMarketId: "fr-pm", kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
        { id: "us-election-2028", label: "US Presidential Election 2028", pmMarketId: "us-pm", kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
      ],
    }));
    const res: any = await hand.marketState("french presidential");
    expect(res.ok).toBe(true);
    expect(res.market.label).toBe("Next French Presidential Election");
  });

  it("marketState returns ok:false when substring matches multiple markets (ambiguous)", async () => {
    const hand = makeMarketsRead(makeStoredDeps({
      markets: [
        { id: "fr-pres-2027", label: "Next French Presidential Election", pmMarketId: "fr-pm", kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
        { id: "us-pres-2028", label: "US Presidential Election 2028", pmMarketId: "us-pm", kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
      ],
    }));
    const res: any = await hand.marketState("presidential");
    expect(res.ok).toBe(false);
    // WHICH ok:false — there are two now, and only this one means "not on the watchlist".
    expect(res.reason).toMatch(/no curated market matching "presidential"/);
  });

  it("marketState still resolves exact matches before trying substring", async () => {
    const hand = makeMarketsRead(makeStoredDeps({
      markets: [
        { id: "france", label: "France Presidential Election", pmMarketId: "fr-pm", kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
        { id: "us-election-2028", label: "US Election (France v Brazil)", pmMarketId: "us-pm", kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
      ],
    }));
    // "france" is an exact id match; should resolve despite "france" also appearing in second market label
    const res: any = await hand.marketState("france");
    expect(res.ok).toBe(true);
    expect(res.market.id).toBe("france");
  });
});

// ORB-214 (6) — a settled market sat on the watchlist and answered "no quotes" (its venues serve
// settlement markers, 1.00 / 0.00, which the placeholder guard correctly refuses). Honest, but the
// real answer is "settled — <outcome> won". The read path now knows a past end date and says so,
// naming the venue's settlement marker when the stored book carries one, and never touches the
// live path for a market that has closed.
describe("makeMarketsRead — settled markets (ORB-214 item 6)", () => {
  const NOW = new Date("2026-09-03T12:00:00.000Z");
  const settledRow = {
    id: "wc26-winner", label: "World Cup 2026 Winner", pmMarketId: "wc-pm", kalshiEventTicker: "KXWC",
    outcomeAliases: {}, endDateIso: "2026-07-19T22:00:00.000Z", marketType: "mutually_exclusive" as const,
  };
  it("marketState says settled, names the settlement marker, and never tries the live path", async () => {
    let liveCalls = 0;
    const hand = makeMarketsRead({
      ...makeStoredDeps({ markets: [settledRow] }),
      snapshots: {
        async recentByMarketVenue(a: { marketId: string; venue: string; limit: number }) {
          if (a.venue !== "polymarket") return [];
          return [
            { id: 1, marketId: a.marketId, outcomeId: "spain", label: "Spain", venue: "polymarket", bid: null, ask: 1.0, mid: null, liquidity: 0, tsIso: "2026-07-20T00:00:00.000Z" },
            { id: 2, marketId: a.marketId, outcomeId: "france", label: "France", venue: "polymarket", bid: null, ask: 0.0, mid: null, liquidity: 0, tsIso: "2026-07-20T00:00:00.000Z" },
          ] as SnapshotRow[];
        },
      },
      liveQuotes: { async get() { liveCalls += 1; return null as never; } },
      now: () => NOW,
    });
    const res: any = await hand.marketState("wc26-winner");
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/settled/);
    expect(res.reason).toContain("2026-07-19");
    expect(res.reason).toContain("Spain");
    expect(liveCalls).toBe(0);
  });

  it("marketState still quotes a market whose end date is in the future", async () => {
    const hand = makeMarketsRead({ ...makeStoredDeps({ markets: [{ ...settledRow, endDateIso: "2026-12-31T00:00:00.000Z" }] }), now: () => NOW });
    const res: any = await hand.marketState("wc26-winner");
    expect(res.ok).toBe(true);
  });

  it("bestBets leaves a settled market out of the ranking — its recorded edge is history", async () => {
    const old = { market: { ...mktRow("old"), endDateIso: "2026-07-19T22:00:00.000Z" }, outcomeId: "Yes", lastEdge: 0.2, lastBasis: 0.5 };
    const live = { market: mktRow("live"), outcomeId: "Yes", lastEdge: 0.1, lastBasis: 0.3 };
    const read = makeMarketsRead({ ...makeDepsFromEdges([old, live]), now: () => NOW });
    const res = (await read.bestBets()) as { ranked: Array<{ marketId: string }> };
    expect(res.ranked.map((r) => r.marketId)).toEqual(["live"]);
  });

  it("bestBets scans at most BEST_BETS_SCAN_MAX open markets, soonest-closing first, and says how many it covered (item 3)", async () => {
    const rows = Array.from({ length: BEST_BETS_SCAN_MAX + 1 }, (_, i) => ({
      market: { ...mktRow(`m${String(i).padStart(3, "0")}`), endDateIso: `2027-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z` },
      outcomeId: "Yes", lastEdge: 0.1, lastBasis: 0.3,
    }));
    // The one that closes LAST is the one the bound must leave out.
    rows[0] = { ...rows[0]!, market: { ...rows[0]!.market, endDateIso: "2030-01-01T00:00:00.000Z" } };
    const read = makeMarketsRead({ ...makeDepsFromEdges(rows), now: () => NOW });
    const res = (await read.bestBets()) as { ranked: Array<{ marketId: string }>; scanned: number; open: number };
    expect(res.open).toBe(BEST_BETS_SCAN_MAX + 1);
    expect(res.scanned).toBe(BEST_BETS_SCAN_MAX);
    expect(res.ranked.map((r) => r.marketId)).not.toContain("m000");
  });

  it("findMarkets marks a settled match so the card can say so instead of quoting it", async () => {
    const hand = makeMarketsRead({ ...makeStoredDeps({ markets: [settledRow] }), now: () => NOW });
    const res: any = await hand.findMarkets("world cup winner");
    expect(res.matches).toEqual([expect.objectContaining({ id: "wc26-winner", settled: true, settledOn: "2026-07-19" })]);
  });
});

describe("makeMarketsRead findMarkets", () => {
  it("findMarkets matches by label substring, case-insensitive", async () => {
    const hand = makeMarketsRead(makeStoredDeps({
      markets: [
        { id: "wc26-brazil-presidential-election", label: "Brazil Presidential Election", pmMarketId: null, kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
        { id: "wc26-france-winner", label: "France World Cup Winner", pmMarketId: null, kalshiEventTicker: "KXFR", outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
      ],
    }));
    const res: any = await hand.findMarkets("brazil");
    expect(res.matches.map((m: any) => m.id)).toContain("wc26-brazil-presidential-election");
    expect(res.matches[0].hasKalshi).toBe(false);
    const none: any = await hand.findMarkets("zzz-no-such");
    expect(none.matches).toEqual([]);
  });

  it("findMarkets matches by id substring, case-insensitive", async () => {
    const hand = makeMarketsRead(makeStoredDeps({
      markets: [
        { id: "wc26-brazil-presidential-election", label: "Brazil Presidential Election", pmMarketId: null, kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
      ],
    }));
    const res: any = await hand.findMarkets("wc26-brazil");
    expect(res.matches.map((m: any) => m.id)).toContain("wc26-brazil-presidential-election");
  });

  it("findMarkets returns hasKalshi=true when kalshiEventTicker is set and non-empty", async () => {
    const hand = makeMarketsRead(makeStoredDeps({
      markets: [
        { id: "wc26-france-winner", label: "France World Cup Winner", pmMarketId: null, kalshiEventTicker: "KXFR", outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
      ],
    }));
    const res: any = await hand.findMarkets("france");
    expect(res.matches[0].hasKalshi).toBe(true);
  });

  it("findMarkets returns empty matches for empty query", async () => {
    const hand = makeMarketsRead(makeStoredDeps({
      markets: [
        { id: "wc26-brazil-presidential-election", label: "Brazil Presidential Election", pmMarketId: null, kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
      ],
    }));
    const res: any = await hand.findMarkets("");
    expect(res.matches).toEqual([]);
  });
});

// ── findMarkets token matching (ORB-189 acceptance) ─────────────────────────
//
// The live failure: Saga asked `find` with "Brazil presidential election first round second
// place" and then "Brazil election"; the watchlist row was labelled "Brazil Presidential
// Election First Round: 2nd Place" (id
// "wc26-brazil-presidential-election-first-round-2nd-place"). The old whole-phrase substring test
// matched neither, both came back `{cards: []}`, and Saga told Bendik the market was not on the
// watchlist. It was — `find` is the entry point for everything the skill does.
const BRAZIL_ID = "wc26-brazil-presidential-election-first-round-2nd-place";
const BRAZIL_LABEL = "Brazil Presidential Election First Round: 2nd Place";

function makeBrazilDeps(extra: MarketRow[] = []) {
  return makeStoredDeps({
    markets: [
      { id: BRAZIL_ID, label: BRAZIL_LABEL, pmMarketId: null, kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
      ...extra,
    ],
  });
}

describe("makeMarketsRead findMarkets — token matching", () => {
  it("finds the Brazil row on the shorter live-incident phrase ('Brazil election'), which the old whole-phrase test missed", async () => {
    const hand = makeMarketsRead(makeBrazilDeps());
    const res: any = await hand.findMarkets("Brazil election");
    expect(res.matches.map((m: any) => m.id)).toContain(BRAZIL_ID);
  });

  it("finds the Brazil row on a long, reordered-relative-to-label paraphrase, matching label AND id fragments", async () => {
    // Same shape as the longer live phrase ("...first round second place"), but with the digit
    // ordinal the row's label and id actually carry ("2nd") rather than the spelled-out word
    // ("second") — tokenizeQuery folds punctuation to whitespace, not number words to digits (see
    // its NOT COVERED note in read.ts), so "second" and "2nd" share no substring either way; the
    // live phrase's own wording therefore still does not match the row on this fix, verified below.
    const hand = makeMarketsRead(makeBrazilDeps());
    const res: any = await hand.findMarkets("Brazil presidential election first round 2nd place");
    expect(res.matches.map((m: any) => m.id)).toContain(BRAZIL_ID);
  });

  // ORB-214 (9) — closed: "second" and "2nd" share no substring, so the word form missed a
  // label carrying only the digit form (the ORB-189 acceptance round hit exactly this). Both
  // sides are now folded to the digit form before matching, in either direction.
  it("bridges a spelled-out ordinal to the row's digit form, in both directions", async () => {
    const hand = makeMarketsRead(makeBrazilDeps());
    const word: any = await hand.findMarkets("Brazil presidential election first round second place");
    expect(word.matches.map((m: any) => m.id)).toContain(BRAZIL_ID);
    const digit: any = await hand.findMarkets("brazil 1st round 2nd place");
    expect(digit.matches.map((m: any) => m.id)).toContain(BRAZIL_ID);
  });

  it("matches 'fed' against a Fed-decision row (single token, unchanged from the old substring behaviour)", async () => {
    const hand = makeMarketsRead(makeBrazilDeps([
      { id: "fed-sept-2026", label: "Fed Decision in September?", pmMarketId: null, kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
    ]));
    const res: any = await hand.findMarkets("fed");
    expect(res.matches.map((m: any) => m.id)).toEqual(["fed-sept-2026"]);
  });

  it("matches when the query's tokens are split across label and id, present in neither field alone", async () => {
    // id deliberately does NOT carry "presidential" (short internal id, not a slugified label), and
    // the label does not carry "wc26" — each query token is a substring of the concatenation only.
    const hand = makeMarketsRead(makeStoredDeps({
      markets: [
        { id: "wc26-brazil", label: "Brazil Presidential Election First Round: 2nd Place", pmMarketId: null, kalshiEventTicker: null, outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
      ],
    }));
    const res: any = await hand.findMarkets("wc26 presidential");
    expect(res.matches.map((m: any) => m.id)).toContain("wc26-brazil");
  });

  it("requires every token — one absent token drops the market entirely", async () => {
    const hand = makeMarketsRead(makeBrazilDeps());
    const res: any = await hand.findMarkets("brazil argentina");
    expect(res.matches).toEqual([]);
  });

  it("is insensitive to punctuation and case in the query", async () => {
    const hand = makeMarketsRead(makeBrazilDeps());
    const res: any = await hand.findMarkets("BRAZIL, ELECTION!!");
    expect(res.matches.map((m: any) => m.id)).toContain(BRAZIL_ID);
  });

  it("regression: a single-word query still matches by label or id substring, as before the fix", async () => {
    const hand = makeMarketsRead(makeBrazilDeps([
      { id: "wc26-france-winner", label: "France World Cup Winner", pmMarketId: null, kalshiEventTicker: "KXFR", outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" },
    ]));
    const byLabel: any = await hand.findMarkets("brazil");
    expect(byLabel.matches.map((m: any) => m.id)).toEqual([BRAZIL_ID]);
    const byId: any = await hand.findMarkets("wc26-france");
    expect(byId.matches.map((m: any) => m.id)).toEqual(["wc26-france-winner"]);
  });
});

describe("makeMarketsRead bestBets — filter/sort/cap", () => {
  it("drops artifact entries where |lastEdge| - lastBasis < EPS (i.e. edge == basis)", async () => {
    // lastEdge=0.879, lastBasis=0.879 → |0.879 - 0.879| = 0 < EPS → artifact, drop
    const artifact = { market: mktRow("art1"), outcomeId: "Yes", lastEdge: 0.879, lastBasis: 0.879 };
    // a legit entry beside it, so "dropped" is distinguishable from "nothing ranked at all"
    const legit = { market: mktRow("legit1"), outcomeId: "Yes", lastEdge: 0.10, lastBasis: 0.30 };
    const read = makeMarketsRead(makeDepsFromEdges([artifact, legit]));
    const res = (await read.bestBets()) as { ranked: Array<{ outcomeId: string; marketId: string }> };
    const ids = res.ranked.map((r) => r.marketId);
    expect(ids).not.toContain("art1");   // artifact dropped
    expect(ids).toContain("legit1");     // legit kept
  });

  it("does NOT drop entries where lastBasis is null (even if lastEdge is large)", async () => {
    // lastBasis null → cannot compute edge-basis diff → NOT an artifact
    const entry = { market: mktRow("no-basis"), outcomeId: "Yes", lastEdge: 0.95, lastBasis: null };
    const read = makeMarketsRead(makeDepsFromEdges([entry]));
    const res = (await read.bestBets()) as { ranked: Array<{ marketId: string }> };
    expect(res.ranked.map((r) => r.marketId)).toContain("no-basis");
  });

  it("cross-venue (referenced) entry ranks before a larger |edge| unreferenced entry", async () => {
    // Market A: has kalshiEventTicker (referenced), |edge|=0.15
    const mktA = mktRow("mktA", "KX-A");
    // Market B: no kalshiEventTicker (unreferenced), |edge|=0.40 (bigger)
    const mktB = mktRow("mktB", null);
    const deps = makeDepsFromEdges([
      { market: mktA, outcomeId: "Yes", lastEdge: 0.15, lastBasis: 0.50 },
      { market: mktB, outcomeId: "Yes", lastEdge: 0.40, lastBasis: 0.75 },
    ]);
    const read = makeMarketsRead(deps);
    const res = (await read.bestBets()) as { ranked: Array<{ marketId: string; referenced: boolean }> };
    expect(res.ranked[0].marketId).toBe("mktA"); // referenced first, even with smaller edge
    expect(res.ranked[0].referenced).toBe(true);
    expect(res.ranked[1].marketId).toBe("mktB");
    expect(res.ranked[1].referenced).toBe(false);
  });

  it("within referenced group, larger |edge| ranks first", async () => {
    const mktA = mktRow("refA", "KX-A"); // |edge|=0.20
    const mktB = mktRow("refB", "KX-B"); // |edge|=0.35
    const deps = makeDepsFromEdges([
      { market: mktA, outcomeId: "Yes", lastEdge: 0.20, lastBasis: 0.50 },
      { market: mktB, outcomeId: "Yes", lastEdge: 0.35, lastBasis: 0.60 },
    ]);
    const read = makeMarketsRead(deps);
    const res = (await read.bestBets()) as { ranked: Array<{ marketId: string }> };
    expect(res.ranked[0].marketId).toBe("refB"); // larger |edge| first within referenced group
    expect(res.ranked[1].marketId).toBe("refA");
  });

  it("caps at 12 entries even when >12 valid entries exist", async () => {
    // Build 15 distinct legit entries
    const entries = Array.from({ length: 15 }, (_, i) => ({
      market: mktRow(`m${i}`, i < 5 ? `KX-${i}` : null), // first 5 referenced
      outcomeId: "Yes",
      lastEdge: 0.05 + i * 0.01, // distinct edges
      lastBasis: 0.80,            // well away from edges (no artifact)
    }));
    const read = makeMarketsRead(makeDepsFromEdges(entries));
    const res = (await read.bestBets()) as { ranked: Array<{ marketId: string }> };
    expect(res.ranked.length).toBeLessThanOrEqual(12);
    expect(res.ranked.length).toBe(12);
  });

});

// ── cross-venue outcome alignment (ORB-189 final review, round 2) ─────────────────────────────
//
// The bug this section exists for: outcome ids are venue-scoped (PM = CLOB token id, Kalshi =
// market ticker), so keying the quote map by them meant a market quoted on BOTH venues still
// produced one single-venue outcome per venue — `edge.ts`'s `paired` was unreachable on real data
// and every card said "one venue only". `outcomeAliases` is the alignment key, and these are the
// three cases that matter: it pairs, it declines to pair, and it says when a venue went missing.

/** A live QuotedMarket for both venues, with REALISTIC venue-scoped ids. */
function liveQuotedBoth(opts: {
  pm: Array<{ id: string; label: string; ask: number }>;
  kalshi: Array<{ id: string; label: string; ask: number }>;
  kalshiUnavailable?: string | null;
}): QuotedMarket {
  const spec = (marketId: string, os: Array<{ id: string; label: string; ask: number }>) =>
    ({ marketId, kind: "event", question: "WC", mutuallyExclusive: true,
       outcomes: os.map((o) => ({ outcomeId: o.id, label: o.label, tokenId: o.id, laggedPrice: o.ask })) }) as any;
  const est = (source: string, os: Array<{ id: string; label: string; ask: number }>) => {
    const raw: Record<string, any> = {};
    for (const o of os) raw[o.id] = prob(o.ask);
    return { source, raw, meta: { mutuallyExclusive: true } } as any;
  };
  const kalshiPresent = opts.kalshi.length > 0;
  return {
    row: { id: "wc", pmMarketId: "wc-pm", kalshiEventTicker: "KXWC", endDateIso: null },
    pmSpec: spec("wc-pm", opts.pm),
    pmEstimate: est("polymarket", opts.pm),
    kalshiSpec: kalshiPresent ? spec("KXWC", opts.kalshi) : null,
    kalshiEstimate: kalshiPresent ? est("kalshi", opts.kalshi) : null,
    kalshiUnavailable: opts.kalshiUnavailable ?? null,
    liquidityByOutcome: {},
  };
}

/** The real id shapes, from tests/live/markets.live.mts's own output. */
const PM_SPAIN = "4394372887385518214471608448209527405727552777602031099972143344338178308080";
const PM_TURKEY = "1029384756102938475610293847561029384756102938475610293847561029384756102938";

function alignDeps(row: Partial<MarketRow>, q: QuotedMarket) {
  const m: MarketRow = { id: "wc", label: "World Cup Winner", pmMarketId: "wc-pm", kalshiEventTicker: "KXWC",
    outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive", ...row };
  return {
    markets: { async listMarkets() { return [m]; } },
    snapshots: { async recentByMarketVenue() { return []; } },
    alertState: { async get() { return null; } },
    liveQuotes: { async get() { return q; } },
  };
}

describe("makeMarketsRead cross-venue alignment", () => {
  it("pairs a 70-digit CLOB token id with a KX… ticker under the shared label", async () => {
    const q = liveQuotedBoth({
      pm: [{ id: PM_SPAIN, label: "Spain", ask: 0.30 }, { id: PM_TURKEY, label: "Turkiye", ask: 0.70 }],
      kalshi: [{ id: "KXWC-ESP", label: "Spain", ask: 0.32 }, { id: "KXWC-TUR", label: "Turkey", ask: 0.68 }],
    });
    const res = (await makeMarketsRead(alignDeps({}, q)).marketState("wc")) as any;
    // Spain is spelled the same on both venues — it pairs with NO alias entry at all, which is
    // the retired matcher's own fallback and the only reason production rows (aliases: {}) pair.
    const spain = res.outcomes.find((o: any) => o.outcomeId === "spain");
    expect(spain.polymarket.ask).toBeCloseTo(0.30, 6);
    expect(spain.kalshi.ask).toBeCloseTo(0.32, 6);
    expect(spain.label).toBe("Spain");
    expect(spain.polymarket.fair).not.toBeNull();
    expect(spain.kalshi.fair).not.toBeNull();
  });

  it("does NOT pair differently-spelled outcomes without the alias, and DOES with it", async () => {
    const pm = [{ id: PM_SPAIN, label: "Spain", ask: 0.30 }, { id: PM_TURKEY, label: "Turkiye", ask: 0.70 }];
    const kalshi = [{ id: "KXWC-ESP", label: "Spain", ask: 0.32 }, { id: "KXWC-TUR", label: "Turkey", ask: 0.68 }];

    const without = (await makeMarketsRead(alignDeps({}, liveQuotedBoth({ pm, kalshi }))).marketState("wc")) as any;
    expect(without.outcomes.find((o: any) => o.outcomeId === "turkiye").kalshi).toBeNull();
    expect(without.outcomes.find((o: any) => o.outcomeId === "turkey").polymarket).toBeNull();

    // The seed script's real alias for this exact market: canonical Turkey ← PM spelling Turkiye.
    const withAlias = (await makeMarketsRead(
      alignDeps({ outcomeAliases: { Turkey: ["Turkiye"] } }, liveQuotedBoth({ pm, kalshi })),
    ).marketState("wc")) as any;
    const turkey = withAlias.outcomes.find((o: any) => o.outcomeId === "turkey");
    expect(turkey.polymarket.ask).toBeCloseTo(0.70, 6);
    expect(turkey.kalshi.ask).toBeCloseTo(0.68, 6);
    expect(turkey.label).toBe("Turkiye");        // display label follows Polymarket, the subject venue
    expect(withAlias.outcomes.find((o: any) => o.outcomeId === "turkiye")).toBeUndefined();
  });

  it("declines to align an ambiguous label rather than guessing which outcome it is", async () => {
    // Two Polymarket outcomes that canonicalise to the same key: neither is "the" Spain, so both
    // revert to their venue ids and are quoted single-venue. Nothing pairs and nothing vanishes.
    const q = liveQuotedBoth({
      pm: [{ id: PM_SPAIN, label: "Spain", ask: 0.30 }, { id: PM_TURKEY, label: "spain", ask: 0.70 }],
      kalshi: [{ id: "KXWC-ESP", label: "Spain", ask: 0.32 }],
    });
    const res = (await makeMarketsRead(alignDeps({}, q)).marketState("wc")) as any;
    expect(res.outcomes.find((o: any) => o.outcomeId === PM_SPAIN).kalshi).toBeNull();
    expect(res.outcomes.find((o: any) => o.outcomeId === PM_TURKEY).kalshi).toBeNull();
    expect(res.outcomes.find((o: any) => o.outcomeId === "spain").polymarket).toBeNull();  // kalshi's, alone
    expect(res.outcomes).toHaveLength(3);
    expect(res.declinedAlignments).toBe(2); // ORB-214 (2): the decline is counted, not silent
  });

  it("carries WHY Kalshi is missing, so a card need not call this a one-venue market", async () => {
    const q = liveQuotedBoth({
      pm: [{ id: PM_SPAIN, label: "Spain", ask: 0.30 }, { id: PM_TURKEY, label: "Turkiye", ask: 0.70 }],
      kalshi: [],
      kalshiUnavailable: "kalshi /events/KXWC → 503",
    });
    const res = (await makeMarketsRead(alignDeps({}, q)).marketState("wc")) as any;
    expect(res.source).toBe("live");                        // the Polymarket side is a real answer
    expect(res.kalshiUnavailable).toBe("kalshi /events/KXWC → 503");
    expect(res.outcomes.find((o: any) => o.outcomeId === "spain").kalshi).toBeNull();
  });

  it("the stored path aligns the same way, and never claims a Kalshi outage", async () => {
    const deps = {
      markets: { async listMarkets() {
        return [{ id: "wc", label: "World Cup Winner", pmMarketId: "wc-pm", kalshiEventTicker: "KXWC",
          outcomeAliases: { Turkey: ["Turkiye"] }, endDateIso: null, marketType: "mutually_exclusive" as const }];
      } },
      snapshots: { async recentByMarketVenue(a: { marketId: string; venue: string; limit: number }) {
        const T = "2026-02-02T00:00:00.000Z";
        return a.venue === "polymarket"
          ? [snapWc(PM_SPAIN, "polymarket", 0.30, T, "Spain"), snapWc(PM_TURKEY, "polymarket", 0.70, T, "Turkiye")]
          : [snapWc("KXWC-ESP", "kalshi", 0.32, T, "Spain"), snapWc("KXWC-TUR", "kalshi", 0.68, T, "Turkey")];
      } },
      alertState: { async get() { return null; } },
    };
    const res = (await makeMarketsRead(deps).marketState("wc")) as any;
    expect(res.source).toBe("stored");
    expect(res.kalshiUnavailable).toBeNull();
    const turkey = res.outcomes.find((o: any) => o.outcomeId === "turkey");
    expect(turkey.polymarket.ask).toBeCloseTo(0.70, 6);
    expect(turkey.kalshi.ask).toBeCloseTo(0.68, 6);
  });
});

function snapWc(outcomeId: string, venue: string, ask: number, tsIso: string, label: string): SnapshotRow {
  return { id: 0, marketId: "wc", outcomeId, label, venue, bid: null, ask, mid: null, liquidity: 4000, tsIso };
}

// ── the recorded edge lives under EITHER venue's id (ORB-189 final review, round 3) ───────────
//
// The regression: aligning outcomes made the alert lookup resolve to the POLYMARKET id whenever
// an outcome had one, but the retired survey wrote `tyche_alert_state` rows under Kalshi ids too
// (`market-survey/detect.ts` emits its within-market signal over both venues, and
// `alert-state-store.record` keys the row on whichever candidate produced it). A Kalshi-keyed
// edge therefore became unreachable and `bestBets` returned [] with no `unavailable` — an edge
// that exists, reported as no edges at all.

function bothVenueDeps(alerts: Record<string, AlertState>) {
  const T = "2026-02-02T00:00:00.000Z";
  return {
    markets: { async listMarkets() {
      return [{ id: "wc", label: "World Cup Winner", pmMarketId: "wc-pm", kalshiEventTicker: "KXWC",
        outcomeAliases: {}, endDateIso: null, marketType: "mutually_exclusive" as const }];
    } },
    snapshots: { async recentByMarketVenue(a: { marketId: string; venue: string; limit: number }) {
      return a.venue === "polymarket"
        ? [snapWc("tok-esp", "polymarket", 0.30, T, "Spain"), snapWc("tok-bra", "polymarket", 0.60, T, "Brazil")]
        : [snapWc("KXWC-ESP", "kalshi", 0.32, T, "Spain"), snapWc("KXWC-BRA", "kalshi", 0.58, T, "Brazil")];
    } },
    alertState: { async get(a: { marketId: string; outcomeId: string }) {
      return alerts[`${a.marketId} ${a.outcomeId}`] ?? null;
    } },
  };
}

const alert = (outcomeId: string, lastEdge: number, recordedAtIso: string): AlertState =>
  ({ marketId: "wc", outcomeId, lastEdge, lastBasis: null, lastAlertedAtIso: null, recordedAtIso });

describe("makeMarketsRead recorded edges across venue ids", () => {
  it("finds an edge recorded under the KALSHI id of an aligned outcome, and ranks it", async () => {
    // Spain aligns (both venues, same label) but its only recorded edge is filed under the
    // Kalshi ticker. Resolving the lookup to the Polymarket id alone loses it entirely.
    const read = makeMarketsRead(bothVenueDeps({ "wc KXWC-ESP": alert("KXWC-ESP", 0.12, "2026-02-02T09:30:00.000Z") }));

    const state = (await read.marketState("wc")) as any;
    const spain = state.outcomes.find((o: any) => o.outcomeId === "spain");
    expect(spain.lastEdge).toBeCloseTo(0.12, 6);
    expect(spain.recordedAtIso).toBe("2026-02-02T09:30:00.000Z");

    const best = await read.bestBets();
    expect(best.ranked.map((e) => e.outcomeId)).toEqual(["spain"]);
    expect(best.ranked[0].lastEdge).toBeCloseTo(0.12, 6);
  });

  it("prefers the NEWER row when both venues recorded one", async () => {
    // What bestBets ranks on, and what the card prints beside "recorded <date>": ranking on a
    // stale Polymarket row while a fresher Kalshi measurement sits unread is a worse answer that
    // still looks correct.
    const read = makeMarketsRead(bothVenueDeps({
      "wc tok-esp": alert("tok-esp", 0.04, "2026-02-01T09:30:00.000Z"),
      "wc KXWC-ESP": alert("KXWC-ESP", 0.19, "2026-02-02T09:30:00.000Z"),
    }));
    const spain = ((await read.marketState("wc")) as any).outcomes.find((o: any) => o.outcomeId === "spain");
    expect(spain.lastEdge).toBeCloseTo(0.19, 6);
    expect(spain.recordedAtIso).toBe("2026-02-02T09:30:00.000Z");
  });

  it("breaks a tie on Polymarket — the subject venue of every cross-market signal", async () => {
    const T = "2026-02-02T09:30:00.000Z";
    const read = makeMarketsRead(bothVenueDeps({
      "wc tok-esp": alert("tok-esp", 0.04, T),
      "wc KXWC-ESP": alert("KXWC-ESP", 0.19, T),
    }));
    const spain = ((await read.marketState("wc")) as any).outcomes.find((o: any) => o.outcomeId === "spain");
    expect(spain.lastEdge).toBeCloseTo(0.04, 6);   // the Polymarket row, on an equal timestamp
  });
});
