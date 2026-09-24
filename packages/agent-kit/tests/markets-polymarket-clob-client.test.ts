import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeClobClient } from "../src/markets/polymarket-clob-client.js";

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

const here = dirname(fileURLToPath(import.meta.url));
const pricesFixture = JSON.parse(readFileSync(join(here, "fixtures", "polymarket", "clob-prices-sell.json"), "utf8"));

describe("clob client fetchAsks", () => {
  // ORB-214 (5) — a present-but-garbage SELL must stop being a price HERE, not two modules later.
  it("drops a SELL that does not parse to a finite number instead of admitting NaN into the book", async () => {
    const garbage = { "tok-spain-yes": { SELL: "abc" }, "tok-brazil-yes": { SELL: "" }, "tok-nz-yes": { SELL: "0.31" } };
    const fetchSpy = (async () => ({ ok: true, status: 200, json: async () => garbage })) as unknown as typeof fetch;
    const clob = makeClobClient({ baseUrl: "https://c.test", fetch: fetchSpy });
    const asks = await clob.fetchAsks(["tok-spain-yes", "tok-brazil-yes", "tok-nz-yes"]);
    expect([...asks.entries()]).toEqual([["tok-nz-yes", 0.31]]);
  });

  it("POSTs side=sell and parses SELL strings to numbers", async () => {
    let sentBody: any = null;
    const fetchSpy = (async (_url: string, init: any) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200, json: async () => pricesFixture }; }) as unknown as typeof fetch;
    const clob = makeClobClient({ baseUrl: "https://c.test", fetch: fetchSpy });
    const asks = await clob.fetchAsks(["tok-spain-yes", "tok-brazil-yes", "tok-nz-yes"]);
    expect(sentBody).toEqual([
      { token_id: "tok-spain-yes", side: "sell" },
      { token_id: "tok-brazil-yes", side: "sell" },
      { token_id: "tok-nz-yes", side: "sell" },
    ]);
    expect(asks.get("tok-spain-yes")).toBeCloseTo(0.14, 6);
    expect(asks.get("tok-nz-yes")).toBeCloseTo(0.0006, 6);
  });

  it("chunks token ids beyond chunkSize into multiple POSTs", async () => {
    let calls = 0;
    const fetchSpy = (async (_url: string, init: any) => {
      calls++;
      const body = JSON.parse(init.body) as { token_id: string }[];
      const out: Record<string, { SELL: string }> = {};
      for (const b of body) out[b.token_id] = { SELL: "0.5" };
      return { ok: true, status: 200, json: async () => out };
    }) as unknown as typeof fetch;
    const clob = makeClobClient({ baseUrl: "https://c.test", fetch: fetchSpy, chunkSize: 2 });
    const asks = await clob.fetchAsks(["a", "b", "c"]); // 2 + 1 → 2 calls
    expect(calls).toBe(2);
    expect(asks.size).toBe(3);
    expect(asks.get("c")).toBeCloseTo(0.5, 6);
  });

  it("skips tokens with no SELL; a non-ok chunk is skipped, not thrown", async () => {
    const partial = (async () => ({ ok: true, status: 200, json: async () => ({ a: { BUY: "0.4" }, b: { SELL: "0.6" } }) })) as unknown as typeof fetch;
    const clob = makeClobClient({ baseUrl: "https://c.test", fetch: partial });
    const asks = await clob.fetchAsks(["a", "b"]);
    expect(asks.has("a")).toBe(false); // only BUY returned → skipped
    expect(asks.get("b")).toBeCloseTo(0.6, 6);

    // Best-effort: a downed venue no longer rejects — it returns the (empty) partial result.
    const down = makeClobClient({ baseUrl: "https://c.test", fetch: (async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch });
    const downAsks = await down.fetchAsks(["a"]);
    expect(downAsks.size).toBe(0);
  });

  it("aborts a hung chunk at timeoutMs and returns what the other chunks answered", async () => {
    // The CLOB client is best-effort per chunk, so a stall must not become a hang OR a total
    // loss: the timed-out chunk is skipped like any other failure and the rest still price.
    let call = 0;
    const stallFirst = ((_url: string, init?: { signal?: AbortSignal; body?: string }) => {
      call++;
      if (call === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ t3: { SELL: "0.20" } }) });
    }) as unknown as typeof fetch;
    const clob = makeClobClient({ baseUrl: "https://c.test", fetch: stallFirst, chunkSize: 2, timeoutMs: 20 });
    const asks = await clob.fetchAsks(["t1", "t2", "t3"]);
    expect(asks.has("t1")).toBe(false);          // the hung chunk, dropped rather than waited on
    expect(asks.get("t3")).toBeCloseTo(0.2, 6);  // the chunk that answered still prices
  });

  it("skips a failing chunk and returns the asks from the chunks that succeeded", async () => {
    let call = 0;
    const fakeFetch = (async (_url: string, _opts: any) => {
      call++;
      if (call === 1) return { ok: false, status: 400, async json() { return {}; } } as any; // bad chunk
      return { ok: true, status: 200, async json() { return { "t3": { SELL: "0.20" } }; } } as any;
    }) as unknown as typeof fetch;
    const clob = makeClobClient({ fetch: fakeFetch, chunkSize: 2 });
    const asks = await clob.fetchAsks(["t1", "t2", "t3"]); // chunk1 [t1,t2] fails, chunk2 [t3] ok
    expect(asks.get("t3")).toBeCloseTo(0.20, 6);
    expect(asks.has("t1")).toBe(false); // failed chunk skipped, not thrown
  });
});
