import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseEvent, type GammaEvent } from "../src/markets/polymarket-parse.js";
import { makePolymarketProducer, discoverCandidateEvents } from "../src/markets/polymarket-producer.js";
import { normalizeSource } from "../src/markets/probability/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const event = JSON.parse(readFileSync(join(here, "fixtures", "polymarket", "event-worldcup.json"), "utf8")) as GammaEvent;

const fakeClob = (asks: Record<string, number>) => ({
  fetchAsks: async (ids: string[]) => new Map(ids.filter((id) => id in asks).map((id) => [id, asks[id]])),
});

describe("polymarket producer", () => {
  // ORB-214 (7) — `unpriced` is judged at PARSE time from Gamma's lagged display price. A real,
  // live CLOB ask for that same outcome must win: the flag says the lagged price is a placeholder,
  // not that the outcome is unpriceable. Latent (never bit live), closed before it could.
  it("prices a parse-time-unpriced outcome from a real live ask, and still skips it when no live ask exists", async () => {
    const spec = parseEvent(event);
    const target = spec.outcomes.find((o) => o.tokenId === "tok-spain-yes")!;
    const flagged = { ...spec, outcomes: spec.outcomes.map((o) => (o === target ? { ...o, unpriced: true, laggedPrice: 0.5 } : o)) };

    const withLive = makePolymarketProducer({ clob: fakeClob({ "tok-spain-yes": 0.42, "tok-brazil-yes": 0.225 }), now: () => 1_000 });
    const est = await withLive.estimate(flagged);
    expect(est.raw["tok-spain-yes"]).toBeCloseTo(0.42, 6);

    const withoutLive = makePolymarketProducer({ clob: fakeClob({ "tok-brazil-yes": 0.225 }), now: () => 1_000 });
    const est2 = await withoutLive.estimate(flagged);
    expect(est2.raw["tok-spain-yes"]).toBeUndefined();
  });

  it("builds a SourceEstimate of live asks keyed by outcome token, with meta", async () => {
    const spec = parseEvent(event);
    const producer = makePolymarketProducer({
      clob: fakeClob({ "tok-spain-yes": 0.14, "tok-brazil-yes": 0.225, "tok-nz-yes": 0.0006 }),
      now: () => 1_000,
    });
    const est = await producer.estimate(spec);
    expect(est.source).toBe("polymarket");
    expect(est.raw["tok-spain-yes"]).toBeCloseTo(0.14, 6);
    expect((est.meta as any).marketId).toBe("world-cup-winner");
    expect((est.meta as any).labels["tok-spain-yes"]).toBe("Spain");
    expect((est.meta as any).ts).toBe(1_000);
  });

  it("falls back to the lagged Gamma price when a token has no live ask", async () => {
    const spec = parseEvent(event);
    const producer = makePolymarketProducer({ clob: fakeClob({ "tok-spain-yes": 0.14 }) }); // brazil/nz missing
    const est = await producer.estimate(spec);
    expect(est.raw["tok-brazil-yes"]).toBeCloseTo(0.22, 6);  // laggedPrice
    expect(est.raw["tok-nz-yes"]).toBeCloseTo(0.0005, 6);    // laggedPrice
  });

  it("feeds the engine: normalizeSource de-vigs the estimate to sum 1", async () => {
    const spec = parseEvent(event);
    const producer = makePolymarketProducer({ clob: fakeClob({ "tok-spain-yes": 0.14, "tok-brazil-yes": 0.225, "tok-nz-yes": 0.0006 }) });
    const est = await producer.estimate(spec);
    const norm = normalizeSource(est);
    const sum = Object.values(norm.fair).reduce((a, b) => a + (b as number), 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(norm.overround).toBeLessThan(0); // three independent Yes outcomes sum <1 before de-vig
  });
});

describe("discoverCandidateEvents", () => {
  it("lists, parses, and filters events by summed liquidity", async () => {
    const lowLiqEvent: GammaEvent = {
      slug: "tiny", title: "Tiny", negRisk: true,
      markets: [{ question: "q", slug: "q", conditionId: "0xq", groupItemTitle: "A",
        outcomes: "[\"Yes\", \"No\"]", outcomePrices: "[\"0.5\", \"0.5\"]", clobTokenIds: "[\"t-a\", \"t-a-no\"]", liquidityNum: 100 }],
    };
    const lister = { listEvents: async () => [event, lowLiqEvent] };
    const specs = await discoverCandidateEvents(lister, { minLiquidityUsd: 1_000_000 });
    expect(specs.map((s) => s.marketId)).toEqual(["world-cup-winner"]); // tiny dropped (100 < 1e6)
  });
});
