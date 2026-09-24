// The 60-outcome event, and the settled book — the two halves of the ORB-189 deploy acceptance
// defect, both driven through the ASSEMBLED path (`makeMarkets`), because that is where the
// symptom actually appeared and no unit test below it could see it.
//
// THE SYMPTOM. Through Saga's HTTP route, `market_edge {action:"find", query:"World Cup winner"}`
// returned `{cards: []}` — the shape `edge.ts` reserves for "the watchlist was read and holds
// nothing matching" — for a market that IS on the watchlist. The model read that, correctly, as
// "not on the watchlist".
//
// WHAT THE LIVE DIAGNOSIS FOUND (2026-09-03, both venues, real calls, per CLAUDE.md's rule that
// only a live call is what an API does). The per-stage outcome counts for `wc26-winner`:
//
//     gamma.getEvent("world-cup-winner")  →  1 event, 60 sub-markets
//     parseEvent                          →  60 outcomes, ALL 60 flagged `unpriced`
//     clob.fetchAsks(60 tokens)           →  1 token carried a SELL, at ≥0.999
//     pmProducer.estimate                 →  raw = {}                 ← drops to 0 HERE
//     kalshi.listMarketsForEvent          →  31 markets, all status "finalized"
//     parseKalshiEvent                    →  31 outcomes, ALL 31 `unpriced`
//     kalshiProducer.estimate             →  raw = {}                 ← and HERE
//
// The 2026 World Cup SETTLED on 2026-07-19. Gamma now serves Spain at 1.00 and the other 59 teams
// at 0.00; every Kalshi market is finalized at ask 1.0000 / bid 0.0000. `isPlaceholderQuote`
// refuses all of them, and it is RIGHT to: a settlement marker is not a price, and a stuck 1.00
// fed into de-vig crushes every other outcome's fair. So zero live outcomes was the correct
// reading of a resolved market — the defect was that `marketState` reported it as `ok: true` with
// an empty `outcomes` array, which is indistinguishable from a quote of a market with no
// outcomes, and which `edge.ts` then renders as that bare `{cards: []}`.
//
// BOTH DIRECTIONS, per CLAUDE.md, because a fix for one of these breaks the other:
//   * the over-rejection — a big, PRICED event must still yield all its outcomes and pair the
//     aliased ones. The same live sweep measured 43-52 priced outcomes de-vigging to exactly
//     1.0000 on three open 128-sub-market negRisk events, so "60 outcomes collapse" is NOT a
//     thing that happens; `describe("a 60-outcome event…")` pins that it stays not a thing.
//   * the leak — a settled/unpriced book must NOT come back as a successful quote of nothing.
import { describe, it, expect } from "vitest";
import type { Pool } from "pg";
import { makeMarkets } from "../src/markets/index.js";
import { runMarketEdge } from "../src/markets/edge.js";

// ── a 60-team event, shaped like the real one ────────────────────────────────────────────────

/** The three spelling exceptions the seed script actually writes, plus 57 fillers. The three are
 *  spelled the CANONICAL way here (the Polymarket side) and the ALIAS way on Kalshi below — the
 *  pairing is the alias table doing its job, not the labels happening to match. */
const TEAMS = [
  "Spain", "England", "France", "Brazil", "Argentina", "Germany",
  "Turkey", "Curacao", "Bosnia and Herzegovina",
  ...Array.from({ length: 51 }, (_, i) => `Team ${String(i + 1).padStart(2, "0")}`),
];

/** Long-tail asks that sum to ~1.19 — a real negRisk book carries vig, so `fair` must differ
 *  from `ask` and the fairs must sum to 1. Deliberately NOT uniform: a uniform book would hide a
 *  de-vig that silently returned its input. */
const askFor = (i: number): number => Number((i < 6 ? [0.30, 0.18, 0.16, 0.14, 0.12, 0.09][i] : 0.004).toFixed(4));

/** CLOB token ids are ~76-digit numeric strings (verbatim shape, live probe, 2026-09-03). Nothing
 *  about one pairs it to a Kalshi `KX…` ticker except the outcome LABEL. */
const tok = (i: number): string => `${9 - (i % 9)}${String(i).padStart(3, "0")}${"7".repeat(72)}`;

/** `settled: true` swaps every quote for its SETTLEMENT value — the winner at 1.00, everyone else
 *  at 0.00 — which is precisely what both venues serve for `wc26-winner` today. */
function gammaEvent(opts: { settled: boolean }) {
  return {
    slug: "world-cup-winner",
    title: "World Cup Winner",
    negRisk: true,
    endDate: "2026-07-20T00:00:00Z",
    markets: TEAMS.map((team, i) => ({
      question: `Will ${team} win the 2026 FIFA World Cup?`,
      slug: `will-${team.toLowerCase().replace(/\s+/g, "-")}-win`,
      conditionId: `0x${String(i).padStart(64, "0")}`,
      groupItemTitle: team,
      outcomes: '["Yes", "No"]',
      outcomePrices: opts.settled
        ? (i === 0 ? '["1", "0"]' : '["0", "1"]')
        : `["${askFor(i)}", "${(1 - askFor(i)).toFixed(4)}"]`,
      clobTokenIds: `["${tok(i)}", "tok-no-${i}"]`,
      liquidityNum: 5000 - i,
      active: true,
      closed: opts.settled,
    })),
  };
}

const kalshiEvent = { event_ticker: "KXMENWORLDCUP-26", title: "World Cup Winner", mutually_exclusive: true };

/** Kalshi carries only 31 of the 60 — the real event does too, which is why an outcome present on
 *  one venue only has to survive alignment rather than sink it. The three exceptions ride under
 *  their OTHER-VENUE spellings, exactly as `outcome_aliases` claims they do. */
const KALSHI_LABELS = [
  "Spain", "England", "France", "Brazil", "Argentina", "Germany",
  "Turkiye", "Curaçao", "Bosnia-Herzegovina",
  ...Array.from({ length: 22 }, (_, i) => `Team ${String(i + 1).padStart(2, "0")}`),
];

function kalshiMarkets(opts: { settled: boolean }) {
  return KALSHI_LABELS.map((label, i) => ({
    ticker: `KXMENWORLDCUP-26-${String(i).padStart(2, "0")}`,
    event_ticker: "KXMENWORLDCUP-26",
    title: label,
    yes_sub_title: label,
    // A finalized Kalshi book quotes ask 1.0000 against bid 0.0000 on EVERY market, winner and
    // loser alike (measured live) — the placeholder test's exact target.
    yes_ask_dollars: opts.settled ? "1.0000" : (askFor(i) + 0.01).toFixed(4),
    yes_bid_dollars: opts.settled ? "0.0000" : (askFor(i) - 0.001).toFixed(4),
    last_price_dollars: opts.settled ? (i === 0 ? "1.0000" : "0.0010") : askFor(i).toFixed(4),
    status: opts.settled ? "finalized" : "active",
    close_time: "2026-07-20T15:00:00Z",
  }));
}

/** The production row, verbatim from `tyche_markets` on the agent box (2026-09-03). */
const marketsRow = {
  id: "wc26-winner",
  label: "World Cup Winner",
  pm_market_id: "world-cup-winner",
  kalshi_event_ticker: "KXMENWORLDCUP-26",
  outcome_aliases: { Turkey: ["Turkiye"], Curacao: ["Curaçao"], "Bosnia and Herzegovina": ["Bosnia-Herzegovina"] },
  end_date: null,
  market_type: "mutually_exclusive",
  match_source: null,
  match_checked_at: null,
  match_result: null,
  match_confidence: null,
};

const SNAP_TS = new Date("2026-09-01T06:00:00.000Z");

function snapshotRows() {
  return [0, 1, 2].map((i) => ({
    id: i,
    market_id: "wc26-winner",
    outcome_id: tok(i),
    label: TEAMS[i],
    venue: "polymarket",
    bid: null,
    ask: askFor(i),
    mid: null,
    liquidity: 5000,
    ts: SNAP_TS,
  }));
}

function stubs(opts: { settled: boolean; stored?: boolean }) {
  const fetchStub = (async (url: string, init?: { method?: string }) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes("/events/KXMENWORLDCUP-26")) return json({ event: kalshiEvent });
    if (url.includes("/markets?event_ticker=")) return json({ markets: kalshiMarkets(opts) });
    if (url.includes("/events?slug=")) return json([gammaEvent(opts)]);
    if (url.endsWith("/prices")) {
      // The CLOB answers for every token the producer asks about, at the same settled/live prices
      // Gamma shows. `chunkSize` is 50, so 60 tokens is genuinely TWO chunks — the batching the
      // brief suspected of dropping the market gets exercised, not stubbed past.
      const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "[]")) as Array<{ token_id: string }>;
      const out: Record<string, { SELL: string }> = {};
      for (const { token_id } of body) {
        const i = TEAMS.findIndex((_, n) => tok(n) === token_id);
        if (i === -1) continue;
        if (opts.settled) { if (i === 0) out[token_id] = { SELL: "1.0000" }; continue; }
        out[token_id] = { SELL: askFor(i).toFixed(4) };
      }
      return json(out);
    }
    throw new Error(`unstubbed URL: ${url}`);
  }) as unknown as typeof fetch;

  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM tyche_markets")) return { rows: [marketsRow] };
      if (sql.includes("FROM tyche_market_snapshots")) {
        return { rows: opts.stored && sql.includes("venue = $2") ? snapshotRows() : [] };
      }
      return { rows: [] }; // tyche_alert_state: nothing recorded
    },
  } as unknown as Pool;

  return makeMarkets({
    fetch: fetchStub,
    pool,
    kalshiBase: "https://k.test",
    polymarketGammaBase: "https://g.test",
    polymarketClobBase: "https://c.test",
  });
}

// ── the over-rejection direction: a big PRICED event still quotes, and still pairs ───────────

describe("a 60-outcome negRisk event quotes live", () => {
  it("yields every outcome, de-vigs across all 60, and does not collapse", async () => {
    const state = await stubs({ settled: false }).marketState("wc26-winner");
    if (!state.ok) throw new Error(`expected a quotable market, got: ${state.reason}`);
    expect(state.source).toBe("live");
    expect(state.outcomes).toHaveLength(60);

    // De-vig over 60 outcomes whose asks sum well above 1 — the brief's first suspect. The fairs
    // sum to 1 and every one is strictly below its own ask, which is what a de-vig DOES.
    const fairs = state.outcomes.map((o) => o.polymarket!.fair!);
    expect(fairs.every((f) => typeof f === "number" && Number.isFinite(f))).toBe(true);
    expect(fairs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    for (const o of state.outcomes) expect(o.polymarket!.fair!).toBeLessThan(o.polymarket!.ask);
  });

  it("pairs the ALIASED outcomes across venues — the alias table, not a coincidence of spelling", async () => {
    const state = await stubs({ settled: false }).marketState("wc26-winner");
    if (!state.ok) throw new Error("expected a quotable market");

    // The three production aliases: canonical on Polymarket, other spelling on Kalshi, one outcome.
    for (const canonical of ["turkey", "curacao", "bosnia and herzegovina"]) {
      const o = state.outcomes.find((x) => x.outcomeId === canonical);
      expect(o, `expected an outcome keyed "${canonical}"`).toBeDefined();
      expect(o!.polymarket, `${canonical} polymarket side`).not.toBeNull();
      expect(o!.kalshi, `${canonical} kalshi side`).not.toBeNull();
    }

    // A label that matches with NO alias entry still pairs (aliases carry only the exceptions).
    const spain = state.outcomes.find((o) => o.outcomeId === "spain")!;
    expect(spain.polymarket).not.toBeNull();
    expect(spain.kalshi).not.toBeNull();

    // …and one of the 29 teams Kalshi does not list stays single-venue rather than sinking.
    const pmOnly = state.outcomes.find((o) => o.outcomeId === "team 51")!;
    expect(pmOnly.polymarket).not.toBeNull();
    expect(pmOnly.kalshi).toBeNull();
  });
});

// ── the leak direction: a settled book is never a successful quote of nothing ────────────────

describe("a settled market with no stored snapshots says so", () => {
  it("marketState returns ok:false naming what could not be quoted", async () => {
    const state = await stubs({ settled: true }).marketState("wc26-winner");
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("no quotes — the venues returned no outcomes and there are no stored snapshots");
  });

  it("find reports `could not read:` for a market that IS on the watchlist — never a bare empty", async () => {
    const res = await runMarketEdge(stubs({ settled: true }), { action: "find", query: "World Cup winner", limit: 8 });
    expect(res.cards).toEqual([]);
    // The regression itself: `{cards: []}` with NO `unavailable` is the shape that means "the
    // watchlist holds nothing matching", and the model read it exactly that way.
    expect(res.unavailable).toBeDefined();
    expect(res.unavailable).toMatch(/could not read: World Cup Winner: no quotes/);
  });

  it("state names the reason and does NOT claim the market is off the watchlist", async () => {
    const res = await runMarketEdge(stubs({ settled: true }), { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toBe("no quotes — the venues returned no outcomes and there are no stored snapshots");
    expect(res.unavailable).not.toMatch(/nothing on the watchlist/);
  });
});

describe("a settled market WITH stored snapshots falls back to them", () => {
  it("an empty live quote is a failure of the live path, not an answer", async () => {
    const state = await stubs({ settled: true, stored: true }).marketState("wc26-winner");
    if (!state.ok) throw new Error(`expected the stored fallback, got: ${state.reason}`);
    expect(state.source).toBe("stored");
    expect(state.outcomes).toHaveLength(3);
    expect(state.asOfIso).toBe(SNAP_TS.toISOString());
    const spain = state.outcomes.find((o) => o.label === "Spain")!;
    expect(spain.polymarket!.ask).toBeCloseTo(askFor(0), 6);
  });
});
