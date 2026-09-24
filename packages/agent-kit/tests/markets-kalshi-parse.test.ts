import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseKalshiEvent, type KalshiEvent, type KalshiMarket } from "../src/markets/kalshi-parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(join(here, "fixtures", "kalshi", name), "utf8"));

describe("parseKalshiEvent", () => {
  it("maps a Kalshi event + candidate markets into a token-keyed MarketSpec", () => {
    const { event, markets } = fixture("event-worldcup.json") as { event: KalshiEvent; markets: KalshiMarket[] };
    const spec = parseKalshiEvent(event, markets);
    expect(spec.kind).toBe("event");
    expect(spec.marketId).toBe("KXWORLDCUP-26");
    expect(spec.question).toBe("World Cup Winner");
    expect(spec.outcomes.map((o) => o.label)).toEqual(["Spain", "Brasil", "New Zealand"]);
    const spain = spec.outcomes[0];
    expect(spain.outcomeId).toBe("KXWORLDCUP-26-ESP");
    expect(spain.tokenId).toBe("KXWORLDCUP-26-ESP");
    expect(spain.laggedPrice).toBeCloseTo(0.15, 6); // yes_ask_dollars (the inline live ask)
    expect(spec.liquidity).toBeCloseTo(120000 + 90000 + 5000, 0); // summed liquidity_dollars
    expect(spec.endDateIso).toBe("2026-07-20T15:00:00Z");
  });

  it("handles a single standalone binary market (N=1)", () => {
    const m = fixture("market-binary.json") as KalshiMarket;
    const ev: KalshiEvent = { event_ticker: m.event_ticker, title: m.title };
    const spec = parseKalshiEvent(ev, [m]);
    expect(spec.outcomes).toHaveLength(1);
    expect(spec.outcomes[0].label).toBe("Pietro Parolin");
    expect(spec.outcomes[0].laggedPrice).toBeCloseTo(0.051, 6);
  });

  it("falls back to last_price_dollars when yes_ask_dollars is missing", () => {
    const ev: KalshiEvent = { event_ticker: "E", title: "E" };
    const m = { ticker: "E-A", event_ticker: "E", title: "A", yes_sub_title: "A",
      yes_ask_dollars: "", last_price_dollars: "0.42" } as unknown as KalshiMarket;
    const spec = parseKalshiEvent(ev, [m]);
    expect(spec.outcomes[0].laggedPrice).toBeCloseTo(0.42, 6);
  });

  it("throws on an event with no markets", () => {
    const ev: KalshiEvent = { event_ticker: "EMPTY", title: "Empty" };
    expect(() => parseKalshiEvent(ev, [])).toThrow();
  });

  it("marks stuck 1.00/no-bid legs as unpriced so de-vig ignores them", () => {
    const ev = { event_ticker: "KXMENWORLDCUP-26", title: "2026 World Cup Winner", mutually_exclusive: true };
    const markets = [
      { ticker: "FR", event_ticker: "KXMENWORLDCUP-26", title: "France", yes_sub_title: "France", yes_ask_dollars: "0.199", yes_bid_dollars: "0.197" },
      { ticker: "ES", event_ticker: "KXMENWORLDCUP-26", title: "Spain",  yes_sub_title: "Spain",  yes_ask_dollars: "0.134", yes_bid_dollars: "0.130" },
      { ticker: "TR", event_ticker: "KXMENWORLDCUP-26", title: "Turkey", yes_sub_title: "Turkey", yes_ask_dollars: "1.00",  yes_bid_dollars: "0" },
      { ticker: "QA", event_ticker: "KXMENWORLDCUP-26", title: "Qatar",  yes_sub_title: "Qatar",  yes_ask_dollars: "1.00",  yes_bid_dollars: "0" },
    ];
    const spec = parseKalshiEvent(ev as any, markets as any);
    const fr = spec.outcomes.find((o) => o.label === "France")!;
    const tr = spec.outcomes.find((o) => o.label === "Turkey")!;
    expect(fr.unpriced ?? false).toBe(false);
    expect(tr.unpriced).toBe(true);
  });
});
