import { describe, it, expect } from "vitest";
import { makeKalshiClient } from "../src/markets/kalshi-client.js";

/** A fetch that never settles on its own: it resolves ONLY when the caller's own abort signal
 *  fires. That is the shape of a hung socket, and it is the only way to prove the bound belongs
 *  to the client — a client that passes no signal makes this promise hang until vitest kills the
 *  test, which is exactly the production failure being guarded against. */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
}

describe("kalshi client", () => {
  it("listEvents GETs /events with the query and returns the events array", async () => {
    let calledUrl = "";
    const fetchSpy = (async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ events: [{ event_ticker: "E1", title: "E1" }], cursor: "" }) };
    }) as unknown as typeof fetch;
    const kalshi = makeKalshiClient({ baseUrl: "https://k.test", fetch: fetchSpy });
    const events = await kalshi.listEvents("status=open&limit=2");
    expect(calledUrl).toBe("https://k.test/events?status=open&limit=2");
    expect(events[0].event_ticker).toBe("E1");
  });

  it("listMarketsForEvent GETs /markets?event_ticker= and returns the markets array", async () => {
    let calledUrl = "";
    const fetchSpy = (async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ markets: [{ ticker: "E1-A", event_ticker: "E1", title: "A", yes_ask_dollars: "0.5" }], cursor: "" }) };
    }) as unknown as typeof fetch;
    const kalshi = makeKalshiClient({ baseUrl: "https://k.test", fetch: fetchSpy });
    const markets = await kalshi.listMarketsForEvent("KX SOME-1");
    expect(calledUrl).toBe("https://k.test/markets?event_ticker=KX%20SOME-1");
    expect(markets[0].ticker).toBe("E1-A");
  });

  it("throws on a non-ok response", async () => {
    const down = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const kalshi = makeKalshiClient({ baseUrl: "https://k.test", fetch: down });
    await expect(kalshi.listEvents()).rejects.toThrow(/503/);
  });

  it("aborts a hung request at timeoutMs — a stalled venue is a rejection, never a hang", async () => {
    const kalshi = makeKalshiClient({ baseUrl: "https://k.test", fetch: hangingFetch(), timeoutMs: 20 });
    const err = await kalshi.getEvent("KXWC").then(() => null, (e) => e);
    expect((err as Error | null)?.name).toBe("TimeoutError");
  });

  it("getEvent GETs /events/{ticker} and returns the event object", async () => {
    let calledUrl = "";
    const fetchSpy = (async (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ event: { event_ticker: "KXMENWORLDCUP-26", title: "2026 World Soccer Cup Winner", series_ticker: "KXMENWORLDCUP", mutually_exclusive: true } }),
      };
    }) as unknown as typeof fetch;
    const kalshi = makeKalshiClient({ baseUrl: "https://k.test", fetch: fetchSpy });
    const ev = await kalshi.getEvent("KXMENWORLDCUP-26");
    expect(calledUrl).toBe("https://k.test/events/KXMENWORLDCUP-26");
    expect(ev.event_ticker).toBe("KXMENWORLDCUP-26");
    expect(ev.mutually_exclusive).toBe(true);
  });
});
