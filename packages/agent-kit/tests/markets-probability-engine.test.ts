import { describe, it, expect } from "vitest";
import { prob, type SourceEstimate } from "../src/markets/probability/types.js";
import { deVig, normalizeSource, combineSources, computeDivergence, computeDispersion, computeConsistency } from "../src/markets/probability/engine.js";

describe("deVig", () => {
  it("removes the overround so fair probabilities sum to 1 (Norway–Senegal 3-way)", () => {
    // Polymarket-style raw implied probs that sum to >1 by the bookmaker margin.
    const raw = { NOR: prob(0.45), DRAW: prob(0.28), SEN: prob(0.32) }; // sum = 1.05
    const { fair, overround } = deVig(raw);

    expect(overround).toBeCloseTo(0.05, 6);
    expect(fair.NOR).toBeCloseTo(0.428571, 5);
    expect(fair.DRAW).toBeCloseTo(0.266667, 5);
    expect(fair.SEN).toBeCloseTo(0.304762, 5);
    expect(fair.NOR + fair.DRAW + fair.SEN).toBeCloseTo(1, 9);
  });

  it("leaves an already-fair source (sums to 1) unchanged, overround 0", () => {
    const raw = { NOR: prob(0.436), DRAW: prob(0.251), SEN: prob(0.313) }; // supercomputer model, sums to 1
    const { fair, overround } = deVig(raw);
    expect(overround).toBeCloseTo(0, 9);
    expect(fair.NOR).toBeCloseTo(0.436, 9);
  });

  it("throws on an empty market (no outcomes)", () => {
    expect(() => deVig({})).toThrow();
  });
});

describe("normalizeSource", () => {
  it("produces a fair map summing to 1 and records the overround", () => {
    const est: SourceEstimate = { source: "polymarket", raw: { NOR: prob(0.45), DRAW: prob(0.28), SEN: prob(0.32) } };
    const n = normalizeSource(est);
    expect(n.source).toBe("polymarket");
    expect(n.overround).toBeCloseTo(0.05, 6);
    expect(n.fair.NOR).toBeCloseTo(0.428571, 5);
    expect(n.raw.NOR).toBeCloseTo(0.45, 9); // raw preserved for transparency
  });
});

describe("normalizeSource market-type awareness", () => {
  it("de-vigs a mutually-exclusive book (asks ~sum to 1)", () => {
    const est = { source: "polymarket" as const,
      raw: { a: prob(0.55), b: prob(0.50) },                  // sum 1.05, one winner
      meta: { mutuallyExclusive: true } } as any;
    const n = normalizeSource(est);
    expect((n.fair.a as number) + (n.fair.b as number)).toBeCloseTo(1, 6); // normalized
    expect(n.fair.a as number).toBeCloseTo(0.55 / 1.05, 6);
  });

  it("does NOT normalize an independent book (asks sum >> 1) — raw ask is the probability", () => {
    const est = { source: "polymarket" as const,
      raw: { fr: prob(0.89), es: prob(0.83), br: prob(0.70) }, // 'reach R16': sum 2.42, NOT one winner
      meta: { mutuallyExclusive: false } } as any;
    const n = normalizeSource(est);
    expect(n.fair.fr as number).toBeCloseTo(0.89, 6); // unchanged — raw IS the probability
    expect(n.fair.es as number).toBeCloseTo(0.83, 6);
    expect((n.fair.fr as number) + (n.fair.es as number) + (n.fair.br as number)).toBeCloseTo(2.42, 6);
  });
});

describe("combineSources", () => {
  const kalshi = normalizeSource({ source: "kalshi", raw: { NOR: prob(0.44), SEN: prob(0.56) } });
  const pinnacle = normalizeSource({ source: "pinnacle", raw: { NOR: prob(0.40), SEN: prob(0.60) } });

  it("mean averages each outcome across sources", () => {
    const c = combineSources([kalshi, pinnacle], "mean");
    expect(c.NOR).toBeCloseTo(0.42, 6);
    expect(c.SEN).toBeCloseTo(0.58, 6);
  });

  it("weighted favours the higher-weight source", () => {
    const c = combineSources([kalshi, pinnacle], "weighted", { pinnacle: 3, kalshi: 1 });
    // (0.44*1 + 0.40*3) / 4 = 0.41
    expect(c.NOR).toBeCloseTo(0.41, 6);
  });

  it("best picks the single highest-weight source unchanged", () => {
    const c = combineSources([kalshi, pinnacle], "best", { pinnacle: 3, kalshi: 1 });
    expect(c.NOR).toBeCloseTo(0.40, 6); // pinnacle wins, returned as-is
  });
});

describe("computeDivergence", () => {
  it("gapPoints = anchor - subject; positive means subject looks cheap", () => {
    const subject = normalizeSource({ source: "polymarket", raw: { NOR: prob(0.40), SEN: prob(0.60) } });
    const anchor = { NOR: prob(0.46) as any, SEN: prob(0.54) as any };
    const d = computeDivergence({ subject, anchor });
    const nor = d.find((x) => x.outcomeId === "NOR")!;
    expect(nor.gapPoints).toBeCloseTo(0.06, 6); // 0.46 - 0.40
    expect(nor.subject).toBeCloseTo(0.40, 6);
    expect(nor.anchor).toBeCloseTo(0.46, 6);
  });
});

describe("computeDispersion", () => {
  it("reports spread (max-min) and stdev across sources per outcome", () => {
    const a = normalizeSource({ source: "polymarket", raw: { NOR: prob(0.40), SEN: prob(0.60) } });
    const b = normalizeSource({ source: "kalshi", raw: { NOR: prob(0.50), SEN: prob(0.50) } });
    const disp = computeDispersion([a, b]);
    const nor = disp.find((x) => x.outcomeId === "NOR")!;
    expect(nor.mean).toBeCloseTo(0.45, 6);
    expect(nor.spreadPoints).toBeCloseTo(0.10, 6);
    expect(nor.stdevPoints).toBeCloseTo(0.05, 6); // population stdev of {0.40,0.50}
    expect(nor.bySource.polymarket).toBeCloseTo(0.40, 6);
  });
});

describe("computeConsistency", () => {
  it("a normal book (sum > 1) has positive overround and no arb", () => {
    const c = computeConsistency({ NOR: prob(0.45), DRAW: prob(0.28), SEN: prob(0.32) }); // 1.05
    expect(c.impliedSum).toBeCloseTo(1.05, 6);
    expect(c.overround).toBeCloseTo(0.05, 6);
    expect(c.arbProfitPoints).toBeCloseTo(0, 9);
    expect(c.outcomeIds).toEqual(["NOR", "DRAW", "SEN"]);
  });

  it("a sub-100% book (sum < 1) flags a near-arbitrage profit", () => {
    const c = computeConsistency({ YES: prob(0.47), NO: prob(0.50) }); // 0.97
    expect(c.overround).toBeCloseTo(-0.03, 6);
    expect(c.arbProfitPoints).toBeCloseTo(0.03, 6); // buy both for 0.97, guaranteed 1.00
  });
});
