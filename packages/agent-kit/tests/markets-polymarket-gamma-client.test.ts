import { describe, it, expect } from "vitest";
import { makeGammaClient } from "../src/markets/polymarket-gamma-client.js";

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

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async (url: string) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    _url: url,
  })) as unknown as typeof fetch;
}

describe("gamma client", () => {
  it("listEvents GETs /events with the query and returns the parsed array", async () => {
    let calledUrl = "";
    const fetchSpy = (async (url: string) => { calledUrl = url; return { ok: true, status: 200, json: async () => [{ slug: "e1", title: "E1", markets: [] }] }; }) as unknown as typeof fetch;
    const gamma = makeGammaClient({ baseUrl: "https://g.test", fetch: fetchSpy });
    const events = await gamma.listEvents("closed=false&limit=2");
    expect(calledUrl).toBe("https://g.test/events?closed=false&limit=2");
    expect(events[0].slug).toBe("e1");
  });

  it("throws on a non-ok response", async () => {
    const gamma = makeGammaClient({ baseUrl: "https://g.test", fetch: fakeFetch(503, "down") });
    await expect(gamma.listMarkets()).rejects.toThrow(/503/);
  });

  it("aborts a hung request at timeoutMs — a stalled venue is a rejection, never a hang", async () => {
    const gamma = makeGammaClient({ baseUrl: "https://g.test", fetch: hangingFetch(), timeoutMs: 20 });
    const err = await gamma.getEvent("wc-pm").then(() => null, (e) => e);
    expect((err as Error | null)?.name).toBe("TimeoutError");
  });
});
