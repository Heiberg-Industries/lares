// The `market-edge` code skill (ORB-189 Task 2): the card math and the POLICY, which is the
// half a persona cannot enforce. `../src/markets/read.ts` is covered by tests/markets-read.test.ts;
// this file covers only what the skill adds on top of the three verbs:
//
//   1. `caveat` is REQUIRED non-empty on every card, synthesised in code — never left to the
//      model. A card with no caveat source still gets one ("an edge is a hypothesis, not a fact").
//   2. `edge` is never an input. On `find`/`state` it is COMPUTED as fair − ask to 4 dp — where
//      `fair` is the CROSS-VENUE MEAN on a paired outcome (so the edge can actually be positive)
//      and the single venue's own de-vig otherwise, which the card admits cannot be. On `best`
//      it is the edge the survey RECORDED, carried through with the date it was recorded.
//   3. Absent ≠ empty. A feed that could not be read comes back as `unavailable`; a search that
//      genuinely matched nothing comes back as `cards: []` with no `unavailable` at all.
//   4. `limit` is applied HERE, by slicing an ORDERED list — the verbs take no limit (Ruling 9).
//   5. A stale recorded edge is still returned, with the date in the caveat — never dropped.
import { describe, it, expect } from "vitest";

import {
  runMarketEdge,
  rejectUncaveatedCards,
  type MarketCard,
  type MarketEdgeVerbs,
  type MarketStateResult,
  type QuotedState,
  type RankedEntry,
} from "../src/markets/edge.js";
import marketEdge, { createMarketEdgeTool } from "../extension/tools/market_edge.js";
import extension from "../extension/extension.js";

// ── fakes ────────────────────────────────────────────────────────────────────────────────────

/** Only the three verbs cross the seam, so a fake is three functions and no HTTP, no pg. */
function verbs(over: Partial<MarketEdgeVerbs> = {}): MarketEdgeVerbs {
  return {
    async findMarkets() {
      return { matches: [] };
    },
    async marketState(idOrLabel: string) {
      return { ok: false as const, reason: `no curated market matching "${idOrLabel}"` };
    },
    async bestBets() {
      return { ranked: [] };
    },
    ...over,
  };
}

/** A live, two-venue, de-vigged state: the case with NO caveat source of its own. */
function liveState(): QuotedState {
  return {
    ok: true,
    source: "live",
    asOfIso: null,
    market: { id: "wc26-winner", label: "World Cup Winner", endDateIso: "2026-07-19T15:00:00.000Z" },
    outcomes: [
      {
        outcomeId: "tok-brazil",
        label: "Brazil",
        polymarket: { ask: 0.66, fair: 0.6226 },
        kalshi: { ask: 0.64, fair: 0.6154 },
        lastEdge: null,
        lastBasis: null,
        recordedAtIso: null,
        lastAlertedAtIso: null,
      },
    ],
  };
}

function rankedEntry(over: Partial<RankedEntry> = {}): RankedEntry {
  return {
    marketId: "wc26-winner",
    marketLabel: "World Cup Winner",
    outcomeId: "tok-spain",
    outcomeLabel: "Spain",
    lastEdge: 0.042,
    lastBasis: 0.61,
    lastAlertedAtIso: null,
    recordedAtIso: "2026-08-21T09:14:00.000Z",
    referenced: true,
    venue: "polymarket",
    ask: 0.14,
    fair: 0.1321,
    quotedAtIso: "2026-08-21T09:14:00.000Z",
    ...over,
  };
}

const CTX = {} as never;

// ── (a) an outage is never an empty answer ───────────────────────────────────────────────────

describe("absent ≠ empty", () => {
  it("(a) a bestBets outage returns unavailable and NO cards", async () => {
    const v = verbs({
      async bestBets() {
        throw new Error("ECONNREFUSED clob.polymarket.com");
      },
    });
    const res = await runMarketEdge(v, { action: "best", limit: 8 });
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toBeTruthy();
    expect(res.unavailable).toMatch(/ECONNREFUSED/);
  });

  it("a findMarkets outage returns unavailable, not 'nothing matched'", async () => {
    const v = verbs({
      async findMarkets() {
        throw new Error("relation \"tyche_markets\" does not exist");
      },
    });
    const res = await runMarketEdge(v, { action: "find", query: "world cup", limit: 8 });
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toMatch(/tyche_markets/);
  });

  it("(h) a find that genuinely matched nothing is a REAL empty — no unavailable", async () => {
    const res = await runMarketEdge(verbs(), { action: "find", query: "curling", limit: 8 });
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toBeUndefined();
  });

  it("best with nothing recorded is a real empty too", async () => {
    const res = await runMarketEdge(verbs(), { action: "best", limit: 8 });
    expect(res).toEqual({ cards: [] });
  });
});

// ── (c) a missing marketId is a MESSAGE, not a throw ─────────────────────────────────────────

describe("state needs a marketId", () => {
  it("(c) refuses with a returned message rather than throwing", async () => {
    const res = await runMarketEdge(verbs(), { action: "state", limit: 8 });
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toBe("state needs a marketId — use find first");
  });

  it("a marketId that resolves to nothing says so rather than reporting 'no edge'", async () => {
    const res = await runMarketEdge(verbs(), { action: "state", marketId: "nordic-curling", limit: 8 });
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toMatch(/no curated market matching "nordic-curling"/);
  });
});

// ── (b) + the caveat policy ──────────────────────────────────────────────────────────────────

describe("caveat is required, and synthesised in code", () => {
  it("(b) a market with NO caveat source still gets an honest caveat", async () => {
    const v = verbs({ async marketState() { return liveState(); } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards.length).toBeGreaterThan(0);
    for (const c of res.cards) expect(c.caveat.trim()).not.toBe("");
    expect(res.cards[0].caveat).toMatch(/hypothesis/);
  });

  it("a stored quote is caveated as stale, naming the day it was observed", async () => {
    const stored: QuotedState = {
      ...liveState(),
      source: "stored",
      asOfIso: "2026-08-20T22:00:00.000Z",
    };
    const v = verbs({ async marketState() { return stored; } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards[0].caveat).toMatch(/2026-08-20/);
    expect(res.cards[0].caveat).toMatch(/stale/i);
  });

  it("an outcome only one venue quotes says so", async () => {
    const one = liveState();
    one.outcomes[0].kalshi = null;
    const v = verbs({ async marketState() { return one; } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards[0].caveat).toMatch(/one venue only/);
  });

  it("a Kalshi OUTAGE is caveated as an outage, never as 'one venue only'", async () => {
    // Two different facts: "this market is on one venue" and "this market is on two venues and we
    // could not reach one of them". The second printed as the first is a false claim about our
    // own coverage — and it is the one a reader would act on.
    const down = liveState();
    down.outcomes[0].kalshi = null;
    down.kalshiUnavailable = "kalshi /events/KXWC → 503";
    const v = verbs({ async marketState() { return down; } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].caveat).toMatch(/Kalshi could not be read \(kalshi \/events\/KXWC → 503\)/);
    expect(res.cards[0].caveat).not.toMatch(/one venue only/);
    // The Polymarket side ANSWERED, so this card is real: `method` still describes what this
    // number is, and nothing is reported as unreadable at the result level.
    expect(res.cards[0].method).toMatch(/single-venue de-vig/);
    expect(res.unavailable).toBeUndefined();
  });

  it("a STORED state with no snapshot timestamp emits no card at all", async () => {
    // The old behaviour fell back to `now`, which made a card claim prices from now that are
    // not from now. Refusing is the only answer that stays true (review round 1).
    const untimed: QuotedState = { ...liveState(), source: "stored", asOfIso: null };
    const v = verbs({ async marketState() { return untimed; } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toMatch(/carry no timestamp/);
  });

  it("rejectUncaveatedCards drops a card whose caveat is blank — the policy, not the prompt", () => {
    const good: MarketCard = {
      market: "World Cup Winner — Brazil", venue: "polymarket", fair: 0.62, method: "de-vigged",
      ask: 0.66, edge: -0.04, caveat: "one venue only", asOf: "2026-09-02T00:00:00.000Z",
    };
    const blank: MarketCard = { ...good, caveat: "   " };
    expect(rejectUncaveatedCards([good, blank])).toEqual([good]);
  });
});

// ── (d) edge is computed, never carried in ───────────────────────────────────────────────────

describe("the edge math", () => {
  it("(d) edge === fair − ask to 4 dp on a quoted card", async () => {
    const v = verbs({ async marketState() { return liveState(); } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    for (const c of res.cards) expect(c.edge).toBeCloseTo(c.fair - c.ask, 4);
    const pm = res.cards.find((c) => c.venue === "polymarket")!;
    // PAIRED: fair is the mean of the two venues' de-vigged fairs — (0.6226 + 0.6154) / 2 —
    // and BOTH cards carry it; only the ask differs, which is the point.
    expect(pm.fair).toBe(0.619);
    expect(pm.ask).toBe(0.66);
    expect(pm.edge).toBe(-0.041);
    const kalshi = res.cards.find((c) => c.venue === "kalshi")!;
    expect(kalshi.fair).toBe(0.619);
    expect(kalshi.edge).toBe(-0.021);
  });

  it("a paired outcome can carry a POSITIVE edge — the venue that is cheap against the other", async () => {
    const paired: QuotedState = {
      ok: true,
      source: "live",
      asOfIso: null,
      market: { id: "wc26-winner", label: "World Cup Winner", endDateIso: null },
      outcomes: [
        {
          outcomeId: "tok-spain",
          label: "Spain",
          polymarket: { ask: 0.14, fair: 0.1321 },   // cheap side
          kalshi: { ask: 0.19, fair: 0.1827 },
          lastEdge: null, lastBasis: null, recordedAtIso: null, lastAlertedAtIso: null,
        },
      ],
    };
    const v = verbs({ async marketState() { return paired; } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    const pm = res.cards.find((c) => c.venue === "polymarket")!;
    expect(pm.fair).toBe(0.1574);           // (0.1321 + 0.1827) / 2
    expect(pm.edge).toBe(0.0174);           // positive: polymarket is cheap against kalshi
    expect(pm.method).toBe("cross-venue mean fair (polymarket + kalshi), live venue books");
    // And the expensive side of the same outcome is negative by the same arithmetic.
    expect(res.cards.find((c) => c.venue === "kalshi")!.edge).toBe(-0.0326);
  });

  it("an UNPAIRED card says its edge is the vig share and cannot be positive", async () => {
    const one = liveState();
    one.outcomes[0].kalshi = null;
    const v = verbs({ async marketState() { return one; } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].fair).toBe(0.6226);   // this venue's own de-vig, not a mean
    expect(res.cards[0].edge).toBe(-0.0374);
    expect(res.cards[0].method).toBe(
      "single-venue de-vig (live venue book) — this edge is the vig share and cannot be positive",
    );
  });

  it("a LIVE unpaired card on a sub-100% book calls it a momentary arb, not an impossibility", async () => {
    // Proportional de-vig scales every ask by 1/Σ. Σ > 1 is the normal case and the edge is the
    // vig share. But a LIVE book can sum below 100% — `probability/engine.ts` records it as
    // `overround < 0` — and there the same de-vig scales the ask UP, fair > ask, and the edge is
    // genuinely positive. The old wording printed "cannot be positive" on that very card.
    const arb = liveState();
    arb.outcomes[0].kalshi = null;
    arb.outcomes[0].polymarket = { ask: 0.45, fair: 0.4737 };
    const v = verbs({ async marketState() { return arb; } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].edge).toBe(0.0237);
    expect(res.cards[0].method).toBe(
      "single-venue de-vig on a sub-100% book (a momentary arb) — live quotes",
    );
    expect(res.cards[0].method).not.toMatch(/cannot be positive/);
    // Still one venue: the caveat that matters is unchanged, and `method` refuses the upgrade
    // to "cross-venue check" that a positive number might otherwise imply.
    expect(res.cards[0].caveat).toMatch(/one venue only/);
  });

  it("a STORED unpaired card on a sub-100% book blames the PAGING, never claims an arb", async () => {
    // The stored path de-vigs `recentByMarketVenue({ limit: STORED_BOOK_WINDOW })` (200 since ORB-214 item 3; was 40). Any venue with more outcomes
    // than that (the live probe counts 60 on `world-cup-winner`) yields a TRUNCATED book, which
    // sums under 1 because outcomes are missing — not because anything is mispriced. Calling
    // that a momentary arb would invent an opportunity out of our own paging.
    const arb: QuotedState = { ...liveState(), source: "stored", asOfIso: "2026-08-20T22:00:00.000Z" };
    arb.outcomes[0].kalshi = null;
    arb.outcomes[0].polymarket = { ask: 0.45, fair: 0.4737 };
    const v = verbs({ async marketState() { return arb; } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].edge).toBe(0.0237);        // the same positive number, a different claim
    expect(res.cards[0].method).toBe(
      "single-venue de-vig on the last 200 stored snapshots — not a cross-venue check", // STORED_BOOK_WINDOW (ORB-214 item 3)
    );
    expect(res.cards[0].method).not.toMatch(/arb/);
    expect(res.cards[0].caveat).toMatch(/stale quote — prices last observed 2026-08-20/);
  });

  it("a price that is not a number never reaches a card — it counts as unquotable", async () => {
    // `ask`/`fair` are typed `number`, but they arrive from pg `numeric` through `Number()`,
    // where an unparseable value is NaN rather than a throw. `round4(NaN)` is NaN and serialises
    // to JSON `null`, so a missing price would be presented on the card AS a price.
    const nan = liveState();
    nan.outcomes[0].polymarket = { ask: Number.NaN, fair: 0.62 };
    nan.outcomes[0].kalshi = { ask: 0.64, fair: Number.NaN };
    const v = verbs({ async marketState() { return nan; } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toMatch(/1 outcome could not be quoted/);
  });

  it("a venue whose fair is null does not count as a second venue", async () => {
    // Both venues returned an ask, but only one has an honest fair — so this is UNPAIRED, and
    // the caveat has to be keyed to what could be QUOTED, not to what answered.
    const half = liveState();
    half.outcomes[0].kalshi = { ask: 0.64, fair: null };
    const v = verbs({ async marketState() { return half; } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].caveat).toMatch(/one venue only/);
    expect(res.cards[0].method).toMatch(/vig share/);
  });

  it("an outcome with no honest de-vigged fair produces no card — never a fabricated one", async () => {
    const degenerate = liveState();
    degenerate.outcomes[0].polymarket = { ask: 0.66, fair: null };
    degenerate.outcomes[0].kalshi = null;
    const v = verbs({ async marketState() { return degenerate; } });
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toMatch(/no de-vigged fair/);
  });
});

// ── (e) limit is applied here, over a known ordering ─────────────────────────────────────────

describe("limit", () => {
  it("(e) slices to `limit`, best SIGNED edge first", async () => {
    // Two paired outcomes, four cards. The fairs are each venue's own book de-vigged
    // proportionally (pm sums to 1.06, kalshi to 1.04), so this is a shape the feed can really
    // produce — and the edges are NOT proportional to the asks, which is what makes the
    // assertion discriminate: under the old |edge| ordering the top two would be
    // X/kalshi (0.0676) and Y/polymarket (0.044), the two WORST cards on the board.
    const many: QuotedState = {
      ok: true,
      source: "live",
      asOfIso: null,
      market: { id: "wc26-winner", label: "World Cup Winner", endDateIso: null },
      outcomes: [
        {
          outcomeId: "tok-x",
          label: "X",
          polymarket: { ask: 0.55, fair: 0.519 },
          kalshi: { ask: 0.63, fair: 0.6058 },
          lastEdge: null, lastBasis: null, recordedAtIso: null, lastAlertedAtIso: null,
        },
        {
          outcomeId: "tok-y",
          label: "Y",
          polymarket: { ask: 0.32, fair: 0.302 },
          kalshi: { ask: 0.26, fair: 0.25 },
          lastEdge: null, lastBasis: null, recordedAtIso: null, lastAlertedAtIso: null,
        },
      ],
    };
    const v = verbs({ async marketState() { return many; } });

    const all = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(all.cards.map((c) => `${c.market.slice(-1)}/${c.venue}/${c.edge}`)).toEqual([
      "Y/kalshi/0.016",         // mean 0.276  vs ask 0.26
      "X/polymarket/0.0124",    // mean 0.5624 vs ask 0.55
      "Y/polymarket/-0.044",    // mean 0.276  vs ask 0.32
      "X/kalshi/-0.0676",       // mean 0.5624 vs ask 0.63
    ]);

    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: 2 });
    expect(res.cards).toHaveLength(2);
    expect(res.cards.map((c) => `${c.market} (${c.venue})`)).toEqual([
      "World Cup Winner — Y (kalshi)",
      "World Cup Winner — X (polymarket)",
    ]);
  });

  it("a limit that is not a finite number falls back to 8, never to nothing", async () => {
    const outcomes = Array.from({ length: 12 }, (_, i) => ({
      outcomeId: `tok-${i}`,
      label: `Team ${i}`,
      polymarket: { ask: 0.05 + i / 100, fair: (0.05 + i / 100) * 0.95 },
      kalshi: null,
      lastEdge: null, lastBasis: null, recordedAtIso: null, lastAlertedAtIso: null,
    }));
    const many: QuotedState = {
      ok: true, source: "live", asOfIso: null,
      market: { id: "wc26-winner", label: "World Cup Winner", endDateIso: null },
      outcomes,
    };
    const v = verbs({ async marketState() { return many; } });
    // Math.floor(NaN) is NaN and slice(0, NaN) returns [] — a silent empty answer.
    const res = await runMarketEdge(v, { action: "state", marketId: "wc26-winner", limit: Number.NaN });
    expect(res.cards).toHaveLength(8);
  });

  it("slices best to `limit`, keeping bestBets' own ranking", async () => {
    const v = verbs({
      async bestBets() {
        return {
          ranked: [
            rankedEntry({ outcomeId: "a", outcomeLabel: "A", lastEdge: 0.09 }),
            rankedEntry({ outcomeId: "b", outcomeLabel: "B", lastEdge: 0.05 }),
            rankedEntry({ outcomeId: "c", outcomeLabel: "C", lastEdge: 0.03 }),
          ],
        };
      },
    });
    const res = await runMarketEdge(v, { action: "best", limit: 2 });
    expect(res.cards.map((c) => c.market)).toEqual([
      "World Cup Winner — A",
      "World Cup Winner — B",
    ]);
  });
});

// ── best cards: the recorded edge, said out loud ─────────────────────────────────────────────

describe("best", () => {
  it("carries the recorded edge with the date it was recorded — never silently dropped", async () => {
    const v = verbs({
      async bestBets() {
        return { ranked: [rankedEntry()] };
      },
    });
    const res = await runMarketEdge(v, { action: "best", limit: 8 });
    expect(res.cards).toHaveLength(1);
    const card = res.cards[0];
    expect(card.edge).toBe(0.042);
    expect(card.venue).toBe("polymarket");
    expect(card.fair).toBe(0.1321);
    expect(card.ask).toBe(0.14);
    expect(card.asOf).toBe("2026-08-21T09:14:00.000Z");
    expect(card.caveat).toMatch(/recorded 2026-08-21, not re-quoted/);
  });

  it("names the SNAPSHOT day too when the prices are not from the day the edge was recorded", async () => {
    // Two instants, one `asOf`: the edge was recorded on the 21st, the prices beside it were
    // last observed on the 25th. One date must not be allowed to stand for both.
    const v = verbs({
      async bestBets() {
        return {
          ranked: [rankedEntry({ quotedAtIso: "2026-08-25T06:30:00.000Z" })],
        };
      },
    });
    const res = await runMarketEdge(v, { action: "best", limit: 8 });
    expect(res.cards[0].asOf).toBe("2026-08-21T09:14:00.000Z");
    expect(res.cards[0].caveat).toMatch(/recorded 2026-08-21, not re-quoted/);
    expect(res.cards[0].caveat).toMatch(/prices from 2026-08-25/);
  });

  it("says nothing extra when both instants fall on the same day", async () => {
    const v = verbs({
      async bestBets() {
        return { ranked: [rankedEntry({ quotedAtIso: "2026-08-21T23:59:00.000Z" })] };
      },
    });
    const res = await runMarketEdge(v, { action: "best", limit: 8 });
    expect(res.cards[0].caveat).not.toMatch(/prices from/);
  });

  it("a ranked entry with no stored quote is reported, not silently dropped", async () => {
    const v = verbs({
      async bestBets() {
        return { ranked: [rankedEntry({ venue: null, ask: null, fair: null })] };
      },
    });
    const res = await runMarketEdge(v, { action: "best", limit: 8 });
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toMatch(/could not be quoted/);
  });
});

// ── find ─────────────────────────────────────────────────────────────────────────────────────

describe("find", () => {
  it("quotes each match and returns its cards", async () => {
    const v = verbs({
      async findMarkets() {
        return { matches: [{ id: "wc26-winner", label: "World Cup Winner", hasKalshi: true }] };
      },
      async marketState() {
        return liveState();
      },
    });
    const res = await runMarketEdge(v, { action: "find", query: "world cup", limit: 8 });
    expect(res.cards.map((c) => c.venue).sort()).toEqual(["kalshi", "polymarket"]);
    expect(res.unavailable).toBeUndefined();
  });

  // ORB-214 (5) — the `!paired && undevigged` caveat gate had no test of its own.
  it("says 'the de-vig moved nothing' only on an unpaired card whose ask IS its fair", async () => {
    const single = liveState();
    single.outcomes = [
      { ...single.outcomes[0]!, outcomeId: "tok-yes", label: "Yes", polymarket: { ask: 0.4, fair: 0.4 }, kalshi: null },
    ];
    const res = await runMarketEdge({ ...verbs(), async marketState() { return single; } }, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]!.caveat).toContain("the de-vig moved nothing here — the ask is the probability");

    const paired = await runMarketEdge({ ...verbs(), async marketState() { return liveState(); } }, { action: "state", marketId: "wc26-winner", limit: 8 });
    expect(paired.cards.every((c) => !c.caveat.includes("moved nothing"))).toBe(true);
  });

  it("best says on every card when the scan did not cover every open market (ORB-214 item 3)", async () => {
    const v = verbs();
    const res = await runMarketEdge(
      { ...v, async bestBets() { return { ranked: [rankedEntry()], scanned: 60, open: 104 }; } },
      { action: "best", limit: 8 },
    );
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]!.caveat).toContain("ranked over the 60 soonest-closing of 104 open markets");
    const full = await runMarketEdge(
      { ...v, async bestBets() { return { ranked: [rankedEntry()], scanned: 12, open: 12 }; } },
      { action: "best", limit: 8 },
    );
    expect(full.cards[0]!.caveat).not.toContain("soonest-closing");
  });

  it("find lists a settled match by name and never quotes it (ORB-214 item 6)", async () => {
    let quoted = 0;
    const v = verbs();
    const res = await runMarketEdge(
      {
        ...v,
        async findMarkets() {
          return { matches: [{ id: "wc26", label: "World Cup 2026 Winner", hasKalshi: true, settled: true, settledOn: "2026-07-19" }] };
        },
        async marketState(id: string) {
          quoted += 1;
          return v.marketState(id);
        },
      },
      { action: "find", query: "world cup", limit: 8 },
    );
    expect(quoted).toBe(0);
    expect(res.cards).toEqual([]);
    expect(res.settled).toEqual(["World Cup 2026 Winner (settled 2026-07-19)"]);
    expect(res.unavailable).toBeUndefined();
  });

  it("find without a query says so rather than listing the whole watchlist", async () => {
    const res = await runMarketEdge(verbs(), { action: "find", limit: 8 });
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toMatch(/needs a query/);
  });
});

// ── the tool ─────────────────────────────────────────────────────────────────────────────────

describe("market_edge tool", () => {
  it("(g) an agent with no markets config gets a message, never a crash", async () => {
    const tool = createMarketEdgeTool({ verbs: () => null });
    const res = (await tool.execute({ action: "best", limit: 8 }, CTX)) as { cards: unknown[]; unavailable?: string };
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toBe("the markets feed is not configured for this agent");
  });

  it("a feed that THROWS while being built answers with the error, not an exception", async () => {
    const tool = createMarketEdgeTool({
      verbs: () => {
        throw new Error("DATABASE_URL is not set; getPool() cannot connect.");
      },
    });
    const res = (await tool.execute({ action: "best", limit: 8 }, CTX)) as { cards: unknown[]; unavailable?: string };
    expect(res.cards).toEqual([]);
    expect(res.unavailable).toMatch(/could not be built — DATABASE_URL is not set/);
  });

  it("binds runMarketEdge to the configured verbs", async () => {
    const tool = createMarketEdgeTool({ verbs: () => verbs({ async marketState() { return liveState(); } }) });
    const res = (await tool.execute({ action: "state", marketId: "wc26-winner", limit: 8 }, CTX)) as {
      cards: MarketCard[];
    };
    expect(res.cards[0].market).toBe("World Cup Winner — Brazil");
  });

  it("states the three hard limits where the model reads them", () => {
    const description = (marketEdge as { description: string }).description;
    expect(description).toMatch(/never advise (a )?stake/i);
    expect(description).toMatch(/never place/i);
    expect(description).toMatch(/never invent/i);
  });
});

// ── the mount seam ───────────────────────────────────────────────────────────────────────────

/**
 * ORB-189 Task 3, Ruling 12. `markets.pool` is a GETTER, not a live `pg.Pool`, and that is the
 * whole content of these three assertions.
 *
 * Each service's own `agent/extensions/agent-kit/extension.ts` mount file is a module
 * `eve build` EVALUATES — inside a docker build, with no secrets and no Postgres. `getPool()`
 * throws there ("DATABASE_URL is not set"), so a mount site written `pool: getPool()` fails the
 * image build of any agent that grants `markets`; written `pool: () => getPool()` it does not,
 * and the connection is opened on the tool's first real call instead. eve validates config
 * synchronously AT MOUNT, so this schema is what enforces the difference — not a convention.
 */
describe("the markets config schema", () => {
  const schema = extension.schema as unknown as {
    safeParse(v: unknown): { success: boolean };
  };
  const config = (markets: unknown) => schema.safeParse({ markets });

  it("accepts a pool GETTER — what a mount can safely evaluate at build time", () => {
    expect(config({ fetch: (() => {}) as unknown, pool: () => ({ query: () => {} }) }).success).toBe(true);
  });

  it("REJECTS a live pool — the shape that only fails inside a docker build", () => {
    // A `pg.Pool` is an object with a `query` method, which is precisely what the old schema
    // accepted. Rejecting it here is what turns "the mount must defer the pool" from a comment
    // into a failure at the mount site, where it is one line to fix.
    expect(config({ fetch: (() => {}) as unknown, pool: { query: () => {} } }).success).toBe(false);
  });

  it("still refuses a mount with no fetch — Node's built-in is never the right one", () => {
    expect(config({ pool: () => ({ query: () => {} }) }).success).toBe(false);
  });
});

// ── the wall clock ───────────────────────────────────────────────────────────────────────────

describe("find's quote budget", () => {
  it("stops quoting when the budget runs out and NAMES what it did not reach", async () => {
    const matches = [1, 2, 3, 4].map((n) => ({ id: `m${n}`, label: `Market ${n}`, hasKalshi: true }));
    const quoted: string[] = [];
    const v = verbs({
      async findMarkets() {
        return { matches };
      },
      async marketState(id: string) {
        quoted.push(id);
        return liveState();
      },
    });
    // A clock that jumps 12s per read: the first market is quoted, and the check before the
    // second is already past the 10s budget.
    let t = Date.parse("2026-09-02T08:00:00.000Z");
    const clock = () => new Date((t += 12_000));

    const res = await runMarketEdge(v, { action: "find", query: "market", limit: 4 }, clock);
    expect(quoted).toEqual(["m1"]);
    expect(res.cards.length).toBeGreaterThan(0);
    expect(res.unavailable).toMatch(/3 further matches not quoted/);
  });

  it("quotes every match when the clock does not move", async () => {
    const matches = [1, 2, 3].map((n) => ({ id: `m${n}`, label: `Market ${n}`, hasKalshi: true }));
    const quoted: string[] = [];
    const v = verbs({
      async findMarkets() {
        return { matches };
      },
      async marketState(id: string) {
        quoted.push(id);
        return liveState();
      },
    });
    const frozen = () => new Date("2026-09-02T08:00:00.000Z");
    const res = await runMarketEdge(v, { action: "find", query: "market", limit: 3 }, frozen);
    expect(quoted).toEqual(["m1", "m2", "m3"]);
    expect(res.unavailable).toBeUndefined();
    expect(res.cards[0].asOf).toBe("2026-09-02T08:00:00.000Z");
  });
});
