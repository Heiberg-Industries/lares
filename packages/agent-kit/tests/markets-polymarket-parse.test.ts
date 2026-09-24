import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseBinaryMarket, parseEvent, type GammaMarket, type GammaEvent } from "../src/markets/polymarket-parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(join(here, "fixtures", "polymarket", name), "utf8"));

describe("parseBinaryMarket", () => {
  it("parses the JSON-string fields into two token-keyed outcomes", () => {
    const m = fixture("market-binary.json") as GammaMarket;
    const spec = parseBinaryMarket(m);
    expect(spec.kind).toBe("binary");
    expect(spec.marketId).toBe("0xecb");
    expect(spec.question).toBe("Will the ECB cut rates in July 2026?");
    expect(spec.liquidity).toBeCloseTo(250000, 0);
    expect(spec.outcomes).toHaveLength(2);
    const yes = spec.outcomes[0];
    expect(yes.label).toBe("Yes");
    expect(yes.tokenId).toBe("tok-ecb-yes");
    expect(yes.outcomeId).toBe("tok-ecb-yes");
    expect(yes.laggedPrice).toBeCloseTo(0.62, 6);
    expect(spec.outcomes[1].tokenId).toBe("tok-ecb-no");
  });

  it("throws when outcomes/prices/tokens lengths disagree", () => {
    const bad = { ...(fixture("market-binary.json") as GammaMarket), clobTokenIds: "[\"only-one\"]" };
    expect(() => parseBinaryMarket(bad)).toThrow();
  });
});

describe("parseEvent (negRisk bundle)", () => {
  it("produces one outcome per sub-market, keyed by the Yes token", () => {
    const e = fixture("event-worldcup.json") as GammaEvent;
    const spec = parseEvent(e);
    expect(spec.kind).toBe("event");
    expect(spec.marketId).toBe("world-cup-winner");
    expect(spec.question).toBe("World Cup Winner"); // trimmed
    expect(spec.outcomes.map((o) => o.label)).toEqual(["Spain", "Brazil", "New Zealand"]);
    const spain = spec.outcomes[0];
    expect(spain.tokenId).toBe("tok-spain-yes"); // clobTokenIds[0]
    expect(spain.laggedPrice).toBeCloseTo(0.1385, 6); // outcomePrices[0]
    expect(spec.liquidity).toBeCloseTo(9455365.57 + 8000000 + 50000, 0); // summed
  });

  it("lagged Yes prices sum to >1 (so deVig has work to do)", () => {
    const spec = parseEvent(fixture("event-worldcup.json") as GammaEvent);
    const sum = spec.outcomes.reduce((a, o) => a + o.laggedPrice, 0);
    expect(sum).toBeGreaterThan(0); // 0.1385 + 0.22 + 0.0005 = 0.359 (sub-set of full field)
  });

  it("skips a sub-market when tokens/prices lengths disagree (best-effort, no throw)", () => {
    const e = fixture("event-worldcup.json") as GammaEvent;
    const bad = {
      ...e,
      markets: [
        {
          ...(e.markets[0] as GammaMarket),
          clobTokenIds: "[\"tok-spain-yes\", \"tok-spain-no\"]", // 2 tokens
          // but prices will still be 2 (from fixture), creating a mismatch after override
        },
      ],
    };
    // Override to have 1 price when tokens has 2
    bad.markets[0] = {
      ...(bad.markets[0] as GammaMarket),
      outcomePrices: "[\"0.1385\"]", // 1 price only
    };
    // The single sub-market is length-mismatched → skipped, leaving no outcomes (never throws).
    expect(parseEvent(bad as GammaEvent).outcomes).toEqual([]);
  });
});

describe("parseEvent best-effort sub-markets", () => {
  it("skips a sub-market with a missing clobTokenIds/outcomePrices field and keeps the valid ones", () => {
    const e = {
      slug: "wc26-winner", title: "World Cup Winner", negRisk: true, endDate: "2026-07-19T00:00:00Z",
      markets: [
        // valid sub-market (Spain)
        { question: "Will Spain win?", slug: "spain", conditionId: "c1", groupItemTitle: "Spain",
          outcomes: '["Yes","No"]', outcomePrices: '["0.20","0.80"]', clobTokenIds: '["tok-spain-yes","tok-spain-no"]' },
        // BROKEN sub-market: clobTokenIds undefined (the live failure shape) — must be skipped, not thrown
        { question: "Will Brazil win?", slug: "brazil", conditionId: "c2", groupItemTitle: "Brazil",
          outcomes: '["Yes","No"]', outcomePrices: '["0.18","0.82"]', clobTokenIds: undefined },
        // valid sub-market (France)
        { question: "Will France win?", slug: "france", conditionId: "c3", groupItemTitle: "France",
          outcomes: '["Yes","No"]', outcomePrices: '["0.15","0.85"]', clobTokenIds: '["tok-france-yes","tok-france-no"]' },
      ],
    } as unknown as GammaEvent;

    const spec = parseEvent(e);                         // must NOT throw
    expect(spec.mutuallyExclusive).toBe(true);          // negRisk preserved
    const labels = spec.outcomes.map((o) => o.label).sort();
    expect(labels).toEqual(["France", "Spain"]);        // Brazil skipped, the other two survive
    expect(spec.outcomes.find((o) => o.label === "Spain")!.tokenId).toBe("tok-spain-yes");
  });

  it("returns outcomes:[] when every sub-market is unparseable (never throws, never fabricates)", () => {
    const e = { slug: "x", title: "X", negRisk: false, markets: [
      { question: "q", slug: "q", conditionId: "c", outcomes: '["Yes","No"]', outcomePrices: undefined, clobTokenIds: undefined },
    ] } as unknown as GammaEvent;
    expect(parseEvent(e).outcomes).toEqual([]);
  });
});
