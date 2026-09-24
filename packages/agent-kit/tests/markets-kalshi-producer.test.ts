import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseKalshiEvent, type KalshiEvent, type KalshiMarket } from "../src/markets/kalshi-parse.js";
import { makeKalshiProducer } from "../src/markets/kalshi-producer.js";
import { normalizeSource } from "../src/markets/probability/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const wc = JSON.parse(readFileSync(join(here, "fixtures", "kalshi", "event-worldcup.json"), "utf8")) as { event: KalshiEvent; markets: KalshiMarket[] };

describe("kalshi producer", () => {
  it("builds a SourceEstimate keyed by outcome ticker, with meta", async () => {
    const spec = parseKalshiEvent(wc.event, wc.markets);
    const est = await makeKalshiProducer({ now: () => 2_000 }).estimate(spec);
    expect(est.source).toBe("kalshi");
    expect(est.raw["KXWORLDCUP-26-ESP"]).toBeCloseTo(0.15, 6);
    expect(est.raw["KXWORLDCUP-26-NZL"]).toBeCloseTo(0.001, 6);
    expect((est.meta as any).marketId).toBe("KXWORLDCUP-26");
    expect((est.meta as any).mutuallyExclusive).toBe(true); // ORB-214 (5): explicit, feeds a user-facing fair
    expect((est.meta as any).labels["KXWORLDCUP-26-BRA"]).toBe("Brasil");
    expect((est.meta as any).ts).toBe(2_000);
  });

  it("feeds the engine: normalizeSource de-vigs the estimate to sum 1", async () => {
    const spec = parseKalshiEvent(wc.event, wc.markets);
    const est = await makeKalshiProducer().estimate(spec);
    const norm = normalizeSource(est);
    const sum = Object.values(norm.fair).reduce((a, b) => a + (b as number), 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it("excludes placeholder/stuck legs from the book, fixing de-vig distortion", async () => {
    const ev = { event_ticker: "KXMENWORLDCUP-26", title: "2026 World Cup Winner", mutually_exclusive: true };
    const markets = [
      { ticker: "FR", event_ticker: "KXMENWORLDCUP-26", title: "France", yes_sub_title: "France", yes_ask_dollars: "0.199", yes_bid_dollars: "0.197" },
      { ticker: "ES", event_ticker: "KXMENWORLDCUP-26", title: "Spain",  yes_sub_title: "Spain",  yes_ask_dollars: "0.134", yes_bid_dollars: "0.130" },
      { ticker: "TR", event_ticker: "KXMENWORLDCUP-26", title: "Turkey", yes_sub_title: "Turkey", yes_ask_dollars: "1.00",  yes_bid_dollars: "0" },
      { ticker: "QA", event_ticker: "KXMENWORLDCUP-26", title: "Qatar",  yes_sub_title: "Qatar",  yes_ask_dollars: "1.00",  yes_bid_dollars: "0" },
    ];
    const spec = parseKalshiEvent(ev as any, markets as any);
    const est = await makeKalshiProducer().estimate(spec);

    // Verify that Turkey/Qatar are excluded from raw
    expect("TR" in est.raw).toBe(false);
    expect("QA" in est.raw).toBe(false);

    // Verify France's fair probability is correct among real legs (FR + ES only)
    const norm = normalizeSource(est);
    expect(norm.fair["FR"]).toBeGreaterThan(0.15);  // was ~0.025 in broken version; now honest
  });
});
